// subagent 使用的 flow_* 工具：flow_claim、flow_note、flow_submit、flow_approve、flow_block。
// 纯业务实现，不依赖 Pi；由 pi-adapter 注册为 Pi 工具，测试中由 fake-subagent 直接调用。
// run token 只来自环境变量，模型看不到也不需要传。
import { Type, type Static } from 'typebox';
import type { FlowConfig } from '../core/config.ts';
import { StateError, type StateStore } from '../core/state-store.ts';
import { hashToken } from '../core/state-machine.ts';
import { ProposedTask, type TaskFile } from '../core/schemas.ts';
import { validateDag, dagReport, formatDagReport } from '../core/dag.ts';
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
export const SubmitParams = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 500, description: '一句话总结本次改动' }) });
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
  const v = validateDag(p.tasks.map((x) => ({ ...x })), ctx.config.dagCatalog());
  errors.push(...v.errors);
  if (errors.length) throw new FlowToolError(`任务列表校验失败，未保存：\n${errors.map((e) => `- ${e}`).join('\n')}\n建议：逐条修正后重新调用 flow_propose_tasks。`);
  const report = dagReport(p.tasks, v.warnings);
  await ctx.store.saveProposal(ctx.env.flow, { stage: t.stage, run: ctx.env.run, created_at: (ctx.now?.() ?? new Date()).toISOString(), tasks: p.tasks, report }, actor(ctx));
  return { text: `任务列表已保存（用户批准本阶段闸门后生效，可在批准前重新提交覆盖）。\n${formatDagReport(report)}`, details: { ...report } };
}

export const SUBAGENT_TOOLS = {
  flow_claim: { params: ClaimParams, description: '确认任务与租约，返回任务说明、输入文件、验收标准、可写范围与 verify 命令。开始工作前先调用。', run: (c: ToolContext) => flowClaim(c) },
  flow_note: { params: NoteParams, description: '追加 handoff 笔记（做到哪、下一步、踩过的坑、未决问题）。提交前必须至少写一次。', run: (c: ToolContext, p: Static<typeof NoteParams>) => flowNote(c, p) },
  flow_submit: { params: SubmitParams, description: '提交本任务进入审查。程序会检查改动是否都在可写范围内。', run: (c: ToolContext, p: Static<typeof SubmitParams>) => flowSubmit(c, p) },
  flow_approve: { params: ApproveParams, description: '审查结论：pass 或 reject。reject 必须附 issues（位置、问题、期望的修改）。', run: (c: ToolContext, p: Static<typeof ApproveParams>) => flowApprove(c, p) },
  flow_block: { params: BlockParams, description: '遇到歧义或需要越界时标记任务阻塞，交给用户决定。需要向用户提问时，一次只问一个问题。', run: (c: ToolContext, p: Static<typeof BlockParams>) => flowBlock(c, p) },
  flow_propose_tasks: { params: ProposeParams, description: '（仅 architect，仅 S1/F1）提交任务 DAG：依赖分硬/软，硬依赖必须写 reason，软依赖必须配 integration 任务。返回关键路径与并行宽度报告。', run: (c: ToolContext, p: Static<typeof ProposeParams>) => flowProposeTasks(c, p) },
} as const;
export type SubagentToolName = keyof typeof SUBAGENT_TOOLS;
