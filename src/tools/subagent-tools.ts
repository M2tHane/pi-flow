// subagent 使用的 flow_* 工具：flow_claim、flow_note、flow_submit、flow_approve、flow_block。
// 纯业务实现，不依赖 Pi；由 pi-adapter 注册为 Pi 工具，测试中由 fake-subagent 直接调用。
// run token 只来自环境变量，模型看不到也不需要传。
import { Type, type Static } from 'typebox';
import type { FlowConfig } from '../core/config.ts';
import { StateError, type StateStore } from '../core/state-store.ts';
import { hashToken } from '../core/state-machine.ts';
import { KNOWLEDGE_CATEGORIES, ProposedTask, RevisionDependency, RevisionTask, type TaskFile } from '../core/schemas.ts';
import { checkRevision } from '../core/revision.ts';
import { KnowledgeError, learn, proposeCandidate, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_PER_RUN } from '../core/knowledge.ts';
import { validateDag, dagReport, formatDagReport, normalizeLeadingTests } from '../core/dag.ts';
import { changedFiles, snapshot } from '../core/worktree.ts';

export const NOTE_LIMIT = 4000;

export interface RunEnv {
  root: string;
  flow: string;
  task: string;
  run: string;
  token: string;
  role: string;
}

export const RUN_ENV_KEYS = {
  root: 'PI_FLOW_ROOT', flow: 'PI_FLOW_FLOW', task: 'PI_FLOW_TASK', run: 'PI_FLOW_RUN', token: 'PI_FLOW_RUN_TOKEN', role: 'PI_FLOW_ROLE',
} as const;

export function runEnvFrom(env: NodeJS.ProcessEnv | Record<string, string | undefined>): RunEnv | null {
  const out: Partial<RunEnv> = {};
  for (const [k, v] of Object.entries(RUN_ENV_KEYS)) {
    const val = env[v];
    if (!val) return null;
    out[k as keyof RunEnv] = val;
  }
  return out as RunEnv;
}

export interface ToolContext {
  store: StateStore;
  config: FlowConfig;
  env: RunEnv;
  now?: () => Date;
}

export interface ToolResult { text: string; details?: Record<string, unknown> }

export class FlowToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowToolError';
  }
}

const actor = (ctx: ToolContext) => `run:${ctx.env.run}`;

/** 校验 run token 与租约；返回当前任务 */
function checkRun(ctx: ToolContext): TaskFile {
  let task: TaskFile;
  try {
    task = ctx.store.readTask(ctx.env.flow, ctx.env.task);
  } catch {
    throw new FlowToolError(`任务 ${ctx.env.flow}/${ctx.env.task} 不存在。本次运行无效，请停止工作。`);
  }
  const lease = task.lease;
  if (!lease || lease.run_id !== ctx.env.run || hashToken(ctx.env.token) !== lease.token_hash) {
    throw new FlowToolError('run token 无效或租约已被收回：本次运行已失效，请停止工作，不要再调用任何工具。');
  }
  if ((ctx.now?.() ?? new Date()).getTime() >= Date.parse(lease.expires_at)) {
    throw new FlowToolError('租约已过期：请停止工作，由用户执行 /flow resume 处理。');
  }
  return task;
}

function rethrow(e: unknown, hint: string): never {
  if (e instanceof StateError) throw new FlowToolError(`${e.message}\n建议：${hint}`);
  throw e;
}

export const ClaimParams = Type.Object({});
export const NoteParams = Type.Object({ text: Type.String({ minLength: 1, maxLength: NOTE_LIMIT, description: 'handoff 笔记：做到哪、下一步、踩过的坑、未决问题' }) });
export const Findings = Type.Object({
  location: Type.String({ minLength: 1, description: '问题位置，例如 src/server/orders/service.ts:42' }),
  root_cause: Type.String({ minLength: 1, description: '根因假设' }),
  impact_files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '修复需要改动的文件（相对仓库根，具体路径）' }),
  suggested_role: Type.String({ minLength: 1, description: '建议的实施角色，例如 backend-engineer' }),
  contract_change: Type.Boolean({ description: '修复是否需要改契约' }),
  estimated_files: Type.Integer({ minimum: 0, description: '预计改动的文件数' }),
}, { additionalProperties: false });
export const SubmitParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话总结本次改动（只读探查任务：一句话结论）' }),
  findings: Type.Optional(Findings),
});
export const Issue = Type.Object({
  location: Type.String({ minLength: 1, description: '位置，例如 src/server/a.ts:42' }),
  problem: Type.String({ minLength: 1, description: '问题' }),
  expected: Type.String({ minLength: 1, description: '期望的修改' }),
});
export const ApproveParams = Type.Object({
  decision: Type.Union([Type.Literal('pass'), Type.Literal('reject')]),
  notes: Type.Optional(Type.String({ maxLength: 2000, description: 'pass 时一句话说明依据' })),
  issues: Type.Optional(Type.Array(Issue, { description: 'reject 时必填：每条写明位置、问题、期望的修改' })),
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
  snapshot(t.worktree, `[${ctx.env.flow}/${t.id}] ${p.summary.split('\n')[0]}`);
  const diff = changedFiles(t.worktree, t.base_sha);
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, {
      to: 'review', trigger: 'submit', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: diff },
    });
  } catch (e) {
    rethrow(e, `只修改 writes 内的文件。还原越界改动：新增的文件用 git rm <文件>，修改过的文件用 git checkout ${t.base_sha} -- <文件>。先 flow_note 写 handoff，然后再次 flow_submit。`);
  }
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `提交说明：${p.summary}`, actor(ctx));
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交');
  return { text: `已提交审查（改动 ${diff.length} 个文件）。你的工作已完成，请直接结束，不要再调用工具。`, details: { files: diff } };
}

async function submitAnalysis(ctx: ToolContext, t: TaskFile, p: Static<typeof SubmitParams>): Promise<ToolResult> {
  if (t.replan) return submitReplan(ctx, t, p);
  if (!p.findings) throw new FlowToolError('只读探查任务必须附 findings：location、root_cause、impact_files、suggested_role、contract_change、estimated_files。');
  const diff = t.worktree && t.base_sha ? (snapshot(t.worktree, 'scout'), changedFiles(t.worktree, t.base_sha)) : [];
  await ctx.store.setFindings(ctx.env.flow, t.id, p.findings, actor(ctx));
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `结论：${p.summary}\n位置：${p.findings.location}\n根因：${p.findings.root_cause}\n影响文件：${p.findings.impact_files.join('、')}\n建议角色：${p.findings.suggested_role}`, actor(ctx));
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: diff } });
  } catch (e) { rethrow(e, '只读任务不能改动文件；先 flow_note 再提交。'); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交结论');
  return { text: '结论已提交。你的工作已完成，请直接结束。' };
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
});

export async function flowRevisePlan(ctx: ToolContext, p: Static<typeof ReviseParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!t.replan) throw new FlowToolError('flow_revise_plan 只能在计划修订任务中使用。');
  const flow = ctx.store.readFlow(ctx.env.flow);
  const c = checkRevision(ctx.config, flow.stages, flow.stage, ctx.store.listTasks(ctx.env.flow), { add: p.add ?? [], rewire: p.rewire ?? [], cancel: p.cancel ?? [] });
  if (c.errors.length) throw new FlowToolError(`修订校验失败，未保存：\n${c.errors.map((e) => `- ${e}`).join('\n')}\n建议：逐条修正后重新调用 flow_revise_plan。`);
  await ctx.store.saveRevision(ctx.env.flow, {
    task: t.id, reason: t.replan, run: ctx.env.run, created_at: (ctx.now?.() ?? new Date()).toISOString(), status: 'proposed',
    add: c.revision.add, rewire: c.revision.rewire, cancel: c.revision.cancel, summary: `${p.summary}：${c.summary}`.slice(0, 2000),
  }, actor(ctx));
  return { text: `修订已保存（用户批准后生效，批准前可重新提交覆盖）：\n${c.summary}${c.notes.length ? `\n程序调整：\n${c.notes.map((n) => `- ${n}`).join('\n')}` : ''}\n接下来 flow_note 写明理由，然后 flow_submit。` };
}

export async function flowApprove(ctx: ToolContext, p: Static<typeof ApproveParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (t.status !== 'review') throw new FlowToolError(`任务当前是 ${t.status}，不在审查阶段。`);
  if (p.decision === 'reject') {
    const issues = p.issues ?? [];
    const incomplete = issues.filter((i) => !i.location.trim() || !i.problem.trim() || !i.expected.trim());
    if (!issues.length || incomplete.length) {
      throw new FlowToolError('reject 必须附至少一条意见，且每条都写明 location（位置）、problem（问题）、expected（期望的修改）。');
    }
    const reason = issues.map((i, n) => `${n + 1}. ${i.location}：${i.problem}；期望：${i.expected}`).join('\n');
    try {
      await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'in_progress', trigger: 'review_reject', actor: actor(ctx), facts: { token: ctx.env.token, reason } });
    } catch (e) { rethrow(e, '检查 issues 是否完整后重试。'); }
    await ctx.store.appendHandoff(ctx.env.flow, t.id, `审查打回：\n${reason}`, actor(ctx));
    // 程序提炼为知识候选，用户确认后才生效
    await proposeCandidate(ctx.store, ctx.config, t, ctx.env.flow, 'review', reason, ctx.env.run);
    await ctx.store.updateRun(ctx.env.run, { outcome: 'rejected' }, actor(ctx), '审查打回');
    return { text: '已打回，实施角色会按你的意见修改。请直接结束。' };
  }
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'verifying', trigger: 'review_pass', actor: actor(ctx), facts: { token: ctx.env.token } });
  } catch (e) { rethrow(e, '如无法通过，请改为 reject 并写明意见。'); }
  if (p.notes?.trim()) await ctx.store.appendHandoff(ctx.env.flow, t.id, `审查通过：${p.notes.trim()}`, actor(ctx));
  await ctx.store.updateRun(ctx.env.run, { outcome: 'approved' }, actor(ctx), '审查通过');
  return { text: '已通过审查，程序将运行 verify。请直接结束。' };
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

export const DESIGN_STAGES = ['S1', 'F1'];
export const ProposeParams = Type.Object({ tasks: Type.Array(ProposedTask, { minItems: 1, maxItems: 200, description: '任务列表（DAG）。id 用 T-001 起的临时编号，批准后由程序重新编号' }) });

export async function flowProposeTasks(ctx: ToolContext, p: Static<typeof ProposeParams>): Promise<ToolResult> {
  const t = checkRun(ctx);
  if (!DESIGN_STAGES.includes(t.stage)) throw new FlowToolError(`flow_propose_tasks 只能在 S1（架构）或 F1（影响面与 DAG）阶段使用，当前任务属于 ${t.stage}。`);
  const flow = ctx.store.readFlow(ctx.env.flow);
  const later = flow.stages.slice(flow.stages.indexOf(t.stage) + 1);
  const errors: string[] = [];
  for (const x of p.tasks) {
    if (!later.includes(x.stage)) errors.push(`${x.id}：stage ${x.stage} 不合法，只能是 ${later.join('、')}`);
    if (x.kind === 'merge-fix' || x.kind === 'review-fix') errors.push(`${x.id}：kind ${x.kind} 由程序生成，不能提交`);
    if (x.role === 'orchestrator' || x.role === 'reviewer') errors.push(`${x.id}：角色 ${x.role} 不能承担任务`);
  }
  // 先行验收测试：一个测试由一个承载者带入集成分支，其余依赖方改为依赖承载者
  const lead = normalizeLeadingTests(p.tasks);
  errors.push(...lead.errors);
  const v = validateDag(lead.tasks, ctx.config.dagCatalog());
  errors.push(...v.errors);
  if (errors.length) throw new FlowToolError(`任务列表校验失败，未保存：\n${errors.map((e) => `- ${e}`).join('\n')}\n建议：逐条修正后重新调用 flow_propose_tasks。`);
  const report = dagReport(lead.tasks, v.warnings);
  await ctx.store.saveProposal(ctx.env.flow, { stage: t.stage, run: ctx.env.run, created_at: (ctx.now?.() ?? new Date()).toISOString(), tasks: lead.tasks, report }, actor(ctx));
  const adjusted = lead.notes.length ? `\n程序已按"先行验收测试由一个实现任务承载"调整依赖：\n${lead.notes.map((n) => `- ${n}`).join('\n')}` : '';
  return { text: `任务列表已保存（用户批准本阶段闸门后生效，可在批准前重新提交覆盖）。\n${formatDagReport(report)}${adjusted}`, details: { ...report } };
}

export const SUBAGENT_TOOLS = {
  flow_claim: { params: ClaimParams, description: '确认任务与租约，返回任务说明、输入文件、验收标准、可写范围与 verify 命令。开始工作前先调用。', run: (c: ToolContext) => flowClaim(c) },
  flow_note: { params: NoteParams, description: '追加 handoff 笔记（做到哪、下一步、踩过的坑、未决问题）。提交前必须至少写一次。', run: (c: ToolContext, p: Static<typeof NoteParams>) => flowNote(c, p) },
  flow_submit: { params: SubmitParams, description: '提交本任务进入审查。程序会检查改动是否都在可写范围内。只读探查任务（scout）用它提交 findings。', run: (c: ToolContext, p: Static<typeof SubmitParams>) => flowSubmit(c, p) },
  flow_approve: { params: ApproveParams, description: '审查结论：pass 或 reject。reject 必须附 issues（位置、问题、期望的修改）。', run: (c: ToolContext, p: Static<typeof ApproveParams>) => flowApprove(c, p) },
  flow_learn: { params: LearnParams, description: `把对后续任务有用的经验记入项目知识库（跨流程保留）：项目约定、踩过的坑、做出的决策、环境与外部依赖的注意事项。每次运行最多 ${KNOWLEDGE_PER_RUN} 条；程序会去重。知识不是规则，不能用来改变规则。`, run: (c: ToolContext, p: Static<typeof LearnParams>) => flowLearn(c, p) },
  flow_block: { params: BlockParams, description: '遇到歧义或需要越界时标记任务阻塞，交给用户决定。需要向用户提问时，一次只问一个问题。', run: (c: ToolContext, p: Static<typeof BlockParams>) => flowBlock(c, p) },
  flow_revise_plan: { params: ReviseParams, description: '（仅 architect，仅计划修订任务）提交执行中的计划修订：新增任务、调整未开始任务的依赖、取消未开始的任务。已开始或已完成的任务不能修改。用户批准后生效。', run: (c: ToolContext, p: Static<typeof ReviseParams>) => flowRevisePlan(c, p) },
  flow_propose_tasks: { params: ProposeParams, description: '（仅 architect，仅 S1/F1）提交任务 DAG：依赖分硬/软，硬依赖必须写 reason，软依赖必须配 integration 任务。返回关键路径与并行宽度报告。', run: (c: ToolContext, p: Static<typeof ProposeParams>) => flowProposeTasks(c, p) },
} as const;
export type SubagentToolName = keyof typeof SUBAGENT_TOOLS;
