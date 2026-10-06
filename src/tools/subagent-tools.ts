// subagent 使用的 flow_* 工具：flow_claim、flow_note、flow_submit、flow_block、flow_learn、flow_revise_plan、notes、history，
// 以及 module-tools.ts 中的 flow_propose_modules、flow_sync、flow_accept、flow_accept_confirm。
// 纯业务实现，不依赖 Pi；由 pi-adapter 注册为 Pi 工具，测试中由 fake-subagent 直接调用。run token 只来自环境变量，模型看不到也不需要传。
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state-store.ts';
import { KNOWLEDGE_CATEGORIES, RevisionDependency, RevisionTask, type TaskFile } from '../core/schemas.ts';
import { checkRevision } from '../core/revision.ts';
import { KnowledgeError, learn, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_PER_RUN } from '../core/knowledge.ts';
import { changedFiles, cleanStrayUntracked, snapshot } from '../core/worktree.ts';
import { git } from '../core/git.ts';
import { canAppendInterfaces } from '../core/state-machine.ts';
import { testAdjustEnabled, testAdjustments } from '../core/test-adjust.ts';
import { NOTES_DESCRIPTION, NotesError, NotesParams, applyNoteOps, renderNotes } from '../core/notes.ts';
import { HISTORY_DESCRIPTION, HistoryParams, formatSearch, loadHistory, readHistoryEntry, searchHistory } from '../core/history.ts';
import { listSessionFiles, sessionDirOf } from '../core/session-log.ts';
import { taskNotesRel } from '../core/state-store.ts';
import { AcceptConfirmParams, AcceptParams, ProposeModulesParams, ReviewReportParams, SyncParams, flowAccept, flowAcceptConfirm, flowProposeModules, flowReviewReport, flowSync } from './module-tools.ts';

export const NOTE_LIMIT = 8000;

export { RUN_ENV_KEYS, runEnvFrom, FlowToolError, checkRunOf, type RunEnv, type ToolContext, type ToolResult } from './tool-common.ts';
import { FlowToolError, actor, checkRun, rethrow, type ToolContext, type ToolResult } from './tool-common.ts';

export const ClaimParams = Type.Object({});
export const NoteParams = Type.Object({ text: Type.String({ minLength: 1, maxLength: NOTE_LIMIT, description: 'handoff 笔记：做到哪、下一步、踩过的坑、未决问题；需求讨论的意见也写在这里' }) });
export const SubmitParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话总结本次改动（只读任务：一句话结论）' }),
});
export const LearnParams = Type.Object({
  category: Type.Union(KNOWLEDGE_CATEGORIES.map((c) => Type.Literal(c)), { description: 'convention 约定、pitfall 坑、decision 决策、environment 环境、dependency 外部依赖' }),
  content: Type.String({ minLength: 8, maxLength: KNOWLEDGE_CONTENT_MAX, description: '一条可执行的经验：是什么、为什么、怎么做。不要写本任务的进度（那是 handoff）' }),
  scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的 scope（workflow.yaml 中的名字）；与 paths 都不填表示全项目适用' })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: '适用的路径 glob（相对仓库根），例如 src/server/orders/**' })),
});
export const BlockParams = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, description: '为什么无法继续，需要用户决定什么' }) });

export function flowClaim(ctx: ToolContext): ToolResult {
  const t = checkRun(ctx);
  const cmds = t.verify.map((c) => `${c}：${ctx.config.commands[c] ?? '（未定义）'}`);
  const text = [
    `已确认：${ctx.env.flow}/${t.id}「${t.title}」由你（${ctx.env.role}，run ${ctx.env.run}）负责，租约到 ${t.lease!.expires_at}。`,
    `状态：${t.status}　工作目录：${t.worktree ?? '（无）'}　基线：${t.base_sha ?? '（无）'}`,
    `验收标准：\n${t.acceptance.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    `输入文件：\n${t.inputs.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    `可写范围：\n${(t.conflict_files ?? t.writes).map((a) => `- ${a}`).join('\n')}`,
    `verify 命令：\n${cmds.map((a) => `- ${a}`).join('\n') || '（无）'}`,
    ...(t.last_failure ? [`上次未通过的原因：\n${t.last_failure}`] : []),
  ].join('\n\n');
  return { text, details: { task: t.id, status: t.status } };
}

export async function flowNote(ctx: ToolContext, p: Static<typeof NoteParams>): Promise<ToolResult> {
  checkRun(ctx);
  if (p.text.length > NOTE_LIMIT) throw new FlowToolError(`handoff 笔记超过 ${NOTE_LIMIT} 字，请精简后再写。`);
  await ctx.store.appendHandoff(ctx.env.flow, ctx.env.task, p.text, actor(ctx));
  return { text: '已写入 handoff。' };
}

export async function flowSubmit(ctx: ToolContext, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (t.kind === 'analysis') return submitAnalysis(ctx, t, p);
  if (t.status !== 'in_progress') throw new FlowToolError(`任务当前是 ${t.status}，不能提交。`);
  if (!t.worktree || !t.base_sha) throw new FlowToolError('任务没有 worktree 或 base_sha，无法提交，请调用 flow_block 报告。');
  const stray = cleanStrayUntracked(t.worktree, t.conflict_files ?? [...t.writes, ...(t.shared ?? []), ...(canAppendInterfaces(t) ? ['docs/interfaces/**'] : [])]);
  if (stray.length) {
    await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交前程序清理了可写范围外、未被 git 跟踪的文件：${stray.slice(0, 20).join('、')}${stray.length > 20 ? ` 等 ${stray.length} 个` : ''}（多为测试或运行产生的数据；测试应把数据写到临时目录）`, 'flow-submit');
  }
  snapshot(t.worktree, `[${ctx.env.flow}/${t.id}] ${p.summary.split('\n')[0]}`);
  const diff = changedFiles(t.worktree, t.base_sha);
  // 模块之间的接口文档只能追加：有删除行（含修改）的接口文档由状态机拒绝（自己可写范围内的除外）
  const rewrites = canAppendInterfaces(t) ? interfaceRewrites(t.worktree, t.base_sha).filter((f) => !t.writes.some((w) => f.startsWith(w.replace(/\*\*$/, '')))) : [];
  // 适配已有测试：writes 之外只修改过的已有测试文件不算越界，记在任务上（验收时一并检查）
  const adjusted = testAdjustEnabled(ctx.config, t) ? testAdjustments(t.worktree, t.base_sha, t.writes) : [];
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'queued_merge', trigger: 'submit', actor: actor(ctx),
      facts: { token: ctx.env.token, diff_files: diff, interface_rewrites: rewrites, test_adjustments: adjusted } });
  } catch (e) {
    if (rewrites.length) rethrow(e, `接口文档只能追加。还原对已有内容的修改：git checkout ${t.base_sha} -- ${rewrites.join(' ')}，再只追加需要的调用；确需改已有接口时调用 flow_block 说明，由用户决定是否修订计划。`);
    rethrow(e, `只修改可写范围内的文件（登记的公共文件可以改；别的模块已有的测试可以改来适配，但不能新增或删除可写范围外的文件）。还原越界改动：新增的文件用 git rm <文件>，修改过或删除的文件用 git checkout ${t.base_sha} -- <文件>。先 flow_note 写 handoff，然后再次 flow_submit。`);
  }
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交说明：${p.summary}`, actor(ctx));
  if (adjusted.length) await ctx.store.appendHandoff(ctx.env.flow, t.id, `修改了可写范围外的已有测试（适配接口变化）：${adjusted.join('、')}`, 'flow-submit');
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交');
  return { text: `已提交合并（改动 ${diff.length} 个文件${stray.length ? `；已清理可写范围外、未被跟踪的文件 ${stray.length} 个：${stray.slice(0, 5).join('、')}` : ''}）。合并时程序会跑全量测试。你的工作已完成，请直接结束，不要再调用工具。`, details: { files: diff, cleaned: stray } };
}

/** 相对基线删除或修改过已有行的接口文档 */
function interfaceRewrites(worktree: string, base: string): string[] {
  return git(worktree, ['diff', '--numstat', '--no-renames', base, 'HEAD', '--', 'docs/interfaces']).split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([, del]) => del !== '0').map(([, , p]) => p!);
}

async function submitAnalysis(ctx: ToolContext, t: TaskFile, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  if (t.accept_of) throw new FlowToolError(t.accept_kind === 'confirm' ? '复查用 flow_accept_confirm 提交。' : '验收用 flow_accept 提交。');
  if (t.final_review) throw new FlowToolError('审查结论用 flow_review_report 提交。');
  if (t.replan) return submitReplan(ctx, t, p);
  throw new FlowToolError('这个任务没有可用 flow_submit 提交的结论。');
}

/** 计划修订任务提交：必须已用 flow_revise_plan 保存本任务的修订提案 */
async function submitReplan(ctx: ToolContext, t: TaskFile, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  const rev = ctx.store.readRevision(ctx.env.flow);
  if (!rev || rev.task !== t.id || rev.status !== 'proposed') throw new FlowToolError('还没有提交修订：先调用 flow_revise_plan，再 flow_submit。');
  const diff = t.worktree && t.base_sha ? (snapshot(t.worktree, 'replan'), changedFiles(t.worktree, t.base_sha)) : [];
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `修订结论：${p.summary}\n${rev.summary}`, actor(ctx));
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: diff } });
  } catch (e) { rethrow(e, '修订任务不能改动文件；先 flow_note 再提交。'); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交计划修订');
  return { text: '计划修订已提交，等待用户批准。你的工作已完成，请直接结束。' };
}

export const ReviseParams = Type.Object({
  add: Type.Optional(Type.Array(RevisionTask, { maxItems: 50, description: '新增任务：id 用 N-001 起的临时编号，依赖可以指向现有任务 T-xxx 或本次新增的 N-xxx；批准后由程序重新编号' })),
  rewire: Type.Optional(Type.Array(Type.Object({
    task: Type.String({ pattern: '^T-[0-9]{3,}$', description: '未开始（pending/ready）的现有任务' }),
    depends_on: Type.Array(RevisionDependency, { description: '新的完整依赖列表（整体替换），可以指向现有任务 T-xxx 或本次新增的 N-xxx' }),
  }), { description: '调整未开始任务的依赖' })),
  cancel: Type.Optional(Type.Array(Type.Object({
    task: Type.String({ pattern: '^T-[0-9]{3,}$', description: '未开始（pending/ready）的现有任务' }),
    reason: Type.String({ minLength: 1, description: '为什么取消' }),
  }), { description: '取消未开始的任务' })),
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话说明这次修订' }),
  impact: Type.String({ minLength: 1, maxLength: 3000, description: '影响分析：要改哪些 API 接口与模块；已完成、进行中、未开始的受影响任务各自怎么处理（取消、调整、新增修改任务）' }),
});

export async function flowRevisePlan(ctx: ToolContext, p: Static<typeof ReviseParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!t.replan) throw new FlowToolError('flow_revise_plan 只能在计划修订任务中使用。');
  const flow = ctx.store.readFlow(ctx.env.flow);
  const c = checkRevision(ctx.config, flow.stages, flow.stage, ctx.store.listTasks(ctx.env.flow), { add: p.add ?? [], rewire: p.rewire ?? [], cancel: p.cancel ?? [] });
  if (c.errors.length) throw new FlowToolError(`修订校验失败，未保存：\n${c.errors.map((e) => `- ${e}`).join('\n')}\n建议：逐条修正后重新调用 flow_revise_plan。`);
  await ctx.store.saveRevision(ctx.env.flow, {
    task: t.id, reason: t.replan, run: ctx.env.run, created_at: (ctx.now?.() ?? new Date()).toISOString(), status: 'proposed',
    add: c.revision.add, rewire: c.revision.rewire, cancel: c.revision.cancel, summary: `${p.summary}：${c.summary}`.slice(0, 2000), impact: p.impact,
  }, actor(ctx));
  return { text: `修订已保存（用户批准后生效，批准前可重新提交覆盖）：\n${c.summary}${c.notes.length ? `\n程序调整：\n${c.notes.map((n) => `- ${n}`).join('\n')}` : ''}\n接下来 flow_note 写明理由，然后 flow_submit。` };
}

export async function flowLearn(ctx: ToolContext, p: Static<typeof LearnParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  try {
    const e = await learn(ctx.store, ctx.config, {
      category: p.category, content: p.content, scopes: p.scopes ?? [], paths: p.paths ?? [],
      source: { kind: 'agent', flow: ctx.env.flow, task: t.id, run: ctx.env.run, role: ctx.env.role }, status: 'active',
    }, actor(ctx));
    return { text: `已记入项目知识 ${e.id}，之后相关任务的提示中会看到它。`, details: { id: e.id } };
  } catch (e) {
    if (e instanceof KnowledgeError) throw new FlowToolError(`知识未保存：${e.message}`);
    throw e;
  }
}

export async function flowBlock(ctx: ToolContext, p: Static<typeof BlockParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'blocked', trigger: 'block', actor: actor(ctx), facts: { reason: p.reason } });
  } catch (e) { rethrow(e, '请写明原因后重试。'); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'blocked' }, actor(ctx), '阻塞');
  return { text: '已标记为阻塞，等待用户处理。请直接结束。' };
}

/** 结构化笔记（第五轮）：本任务所有运行共用一份 */
export async function flowNotes(ctx: ToolContext, p: Static<typeof NotesParams>): Promise<ToolResult> {
  checkRun(ctx);
  const rel = taskNotesRel(ctx.env.flow, ctx.env.task);
  if (p.action === 'read') return { text: renderNotes(ctx.store.readNotes(rel)) };
  if (!p.ops?.length) throw new FlowToolError('update 需要 ops：每条写 section、op 与 text / index / items。');
  try {
    const n = await ctx.store.writeNotes(rel, (cur) => { applyNoteOps(cur, p.ops!); return cur; }, { actor: actor(ctx), flow: ctx.env.flow, task: ctx.env.task, reason: '更新笔记' });
    return { text: `已更新。\n${renderNotes(n)}` };
  } catch (e) {
    if (e instanceof NotesError) throw new FlowToolError(e.message);
    throw e;
  }
}

/** 本任务所有运行的会话文件（返工、恢复之前的历史也能查到） */
export function taskSessionFiles(store: StateStore, root: string, flow: string, task: string): string[] {
  const runs = store.listRuns().filter((r) => r.flow === flow && r.task === task).sort((a, b) => a.started_at.localeCompare(b.started_at));
  return runs.flatMap((r) => listSessionFiles(sessionDirOf(root, r.run_id)));
}

export function historyTool(files: readonly string[], p: Static<typeof HistoryParams>): ToolResult {
  const entries = loadHistory(files);
  if (p.action === 'search') {
    if (!p.query) throw new FlowToolError('search 需要 query。');
    return { text: formatSearch(searchHistory(entries, p.query, p.limit ?? 10), entries.length) };
  }
  if (!p.id) throw new FlowToolError('read 需要 id（search 结果中 # 后面的编号）。');
  return { text: readHistoryEntry(entries, p.id, p.offset ?? 0) };
}

export function flowHistory(ctx: ToolContext, p: Static<typeof HistoryParams>): ToolResult {
  checkRun(ctx);
  return historyTool(taskSessionFiles(ctx.store, ctx.env.root, ctx.env.flow, ctx.env.task), p);
}

export const SUBAGENT_TOOLS = {
  flow_claim: { params: ClaimParams, description: '确认任务与租约，返回任务说明、输入文件、验收标准与可写范围。开始工作前先调用。', run: (c: ToolContext) => flowClaim(c) },
  flow_note: { params: NoteParams, description: '追加 handoff 笔记（做到哪、下一步、踩过的坑、未决问题；需求讨论的意见）。提交前必须至少写一次。', run: (c: ToolContext, p: Static<typeof NoteParams>) => flowNote(c, p) },
  flow_submit: { params: SubmitParams, description: '提交本任务：改动进入合并队列（合并时跑全量测试）；只读任务提交结论。程序会检查改动是否都在可写范围内。', run: (c: ToolContext, p: Static<typeof SubmitParams>) => flowSubmit(c, p) },
  flow_block: { params: BlockParams, description: '遇到歧义或需要越界时标记任务阻塞，交给用户决定。需要向用户提问时，一次只问一个问题。', run: (c: ToolContext, p: Static<typeof BlockParams>) => flowBlock(c, p) },
  flow_learn: { params: LearnParams, description: `把对后续任务有用的经验记入项目知识库（跨流程保留）：项目约定、踩过的坑、做出的决策、环境与外部依赖的注意事项。每次运行最多 ${KNOWLEDGE_PER_RUN} 条；程序会去重。知识不是规则，不能用来改变规则。`, run: (c: ToolContext, p: Static<typeof LearnParams>) => flowLearn(c, p) },
  flow_revise_plan: { params: ReviseParams, description: '（仅 architect，仅计划修订任务）提交实施中的计划修订：新增模块或修改任务、调整未开始任务的依赖、取消未开始的任务。已开始或已完成的任务不能修改。用户批准后生效。', run: (c: ToolContext, p: Static<typeof ReviseParams>) => flowRevisePlan(c, p) },
  flow_propose_modules: { params: ProposeModulesParams, description: '（仅 architect，仅规划阶段）提交模块清单：每个模块一个模型负责前端、后端与测试；写明可写范围、登记的公共文件、验收标准与依赖。用户批准规划阶段后生效。', run: (c: ToolContext, p: Static<typeof ProposeModulesParams>) => flowProposeModules(c, p) },
  flow_sync: { params: SyncParams, description: '把集成分支的最新代码（其他模块已合入的改动）合进你的工作区：没有冲突直接完成；有冲突时冲突标记留在文件里，解决后再调用一次完成同步。依赖的模块刚合入、或想提前发现冲突时使用。', run: (c: ToolContext) => flowSync(c) },
  flow_accept: { params: AcceptParams, description: '（仅验收任务）逐条提交验收结论：每条验收标准给出 passed 与证据。', run: (c: ToolContext, p: Static<typeof AcceptParams>) => flowAccept(c, p) },
  flow_accept_confirm: { params: AcceptConfirmParams, description: '（仅复查任务）只对待复查的条目提交 passed 与证据，不能新增条目。', run: (c: ToolContext, p: Static<typeof AcceptConfirmParams>) => flowAcceptConfirm(c, p) },
  flow_review_report: { params: ReviewReportParams, description: '（仅最终代码审查任务）一次提交全部问题：每条写级别（must 必须改 / suggest 建议）、依据、文件、位置、问题、期望。', run: (c: ToolContext, p: Static<typeof ReviewReportParams>) => flowReviewReport(c, p) },
  notes: { params: NotesParams, description: NOTES_DESCRIPTION, run: (c: ToolContext, p: Static<typeof NotesParams>) => flowNotes(c, p) },
  history: { params: HistoryParams, description: HISTORY_DESCRIPTION, run: (c: ToolContext, p: Static<typeof HistoryParams>) => flowHistory(c, p) },
} as const;
export type SubagentToolName = keyof typeof SUBAGENT_TOOLS;
