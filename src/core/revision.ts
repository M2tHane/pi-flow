// 执行中修订计划（第二轮 G）：用户经主 agent（flow_replan）或 /flow replan 提出 → 程序生成只读的修订任务派给 architect
// → architect 经 flow_revise_plan 提交修订（新增任务、调整未开始任务的依赖、取消未开始的任务）→ 用户 /flow-approve 批准后程序落地。
// 已开始或已完成的任务不能被修改或取消。
import type { FlowConfig } from './config.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { Dependency, RevisionFile, RevisionTask, TaskFile } from './schemas.ts';
import { validateDag } from './dag.ts';
import { isSettled } from './state-machine.ts';
import { DESIGN_STAGES, EXECUTION_STAGE } from '../modes/plan.ts';
import { removeWorktree } from './worktree.ts';

export interface RevisionDeps { root: string; store: StateStore; config: FlowConfig }

export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

const NOT_STARTED = new Set(['pending', 'ready']);
/** 可以取消：未开始，或已阻塞（已停止，不会再运行） */
const CANCELLABLE = new Set(['pending', 'ready', 'blocked']);
const REPLAN_ROLE = 'architect';

/** 当前未结束的修订：修订任务还没结束，或修订提案待批准 */
export function openReplan(store: StateStore, flowId: string): { task?: TaskFile; revision?: RevisionFile } | null {
  const task = store.listTasks(flowId).find((t) => t.replan && !isSettled(t));
  const rev = store.readRevision(flowId);
  const revision = rev?.status === 'proposed' ? rev : undefined;
  return task || revision ? { ...(task ? { task } : {}), ...(revision ? { revision } : {}) } : null;
}

/** 待批准的修订中点名（调整依赖或取消）的任务：批准或打回前暂停派发，避免批准时它们已经开始 */
export function heldByRevision(store: StateStore, flowId: string): Set<string> {
  const rev = store.readRevision(flowId);
  if (rev?.status !== 'proposed') return new Set();
  return new Set([...rev.rewire.map((r) => r.task), ...rev.cancel.map((c) => c.task)]);
}

/** 修订任务的输入：现有任务一览（状态、角色、依赖、writes）与阻塞原因 */
export function planSnapshot(tasks: readonly TaskFile[]): string {
  const rows = tasks.filter((t) => !t.replan).map((t) => {
    const deps = t.depends_on.map((d) => `${d.task}${d.type === 'soft' ? '~' : ''}`).join(',');
    return `- ${t.id} [${t.stage}/${t.kind}/${t.status}] ${t.title}（${t.role}）writes: ${t.writes.join(', ') || '无'}${deps ? `；依赖 ${deps}` : ''}`;
  });
  const blocked = tasks.filter((t) => t.status === 'blocked').map((t) => `- ${t.id}：${t.blocked_reason ?? ''}`);
  return [`现有任务（~ 表示软依赖；只有 pending、ready 的任务可以调整依赖；pending、ready、blocked 的任务可以取消）：`, ...rows, ...(blocked.length ? ['', '阻塞的任务：', ...blocked] : [])].join('\n');
}

/**
 * 发起计划修订：在当前阶段生成只读修订任务（architect，kind=analysis），返回任务 id；由调用方派发。
 * 只在 build/feature 的执行阶段（非设计阶段）可用；同一时间只允许一个未结束的修订。
 */
export async function startReplan(d: RevisionDeps, flowId: string, reason: string, actor: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (!reason.trim()) throw new RevisionError('请写明要修订什么，例如：/flow replan "漏了导出 CSV 的功能"');
  if (flow.mode === 'fix') throw new RevisionError('修复流程不支持修订计划');
  if (DESIGN_STAGES.has(flow.stage)) throw new RevisionError(`当前是设计阶段 ${flow.stage}：请在闸门审批时用 /flow-reject "<意见>" 修订`);
  if (flow.stage_status === 'awaiting_gate') throw new RevisionError('阶段闸门检查中，请稍后再试');
  if (flow.stage_status === 'awaiting_human') {
    // 只有用户能把等待审批的阶段重新打开
    if (actor !== 'human') throw new RevisionError(`阶段 ${flow.stage} 正在等待用户审批：请用户执行 /flow replan "<原因>"`);
    await d.store.transitionStage(flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: `修订计划：${reason}` });
  } else if (flow.stage_status !== 'active') {
    throw new RevisionError(`流程 ${flowId} 已结束或中止`);
  }
  const open = openReplan(d.store, flowId);
  if (open) throw new RevisionError(open.revision ? '已有一份计划修订等待批准：先 /flow-approve 或 /flow-reject "<意见>"' : `修订任务 ${open.task!.id} 尚未完成`);
  const tasks = d.store.listTasks(flowId);
  const id = `T-${String(Math.max(0, ...tasks.map((t) => Number(t.id.slice(2)))) + 1).padStart(3, '0')}`;
  await d.store.addTasks(flowId, [{
    id, stage: flow.stage, kind: 'analysis', title: `修订计划：${reason}`.slice(0, 200), role: REPLAN_ROLE, scopes: [],
    depends_on: [], inputs: ['docs/modules.md', 'docs/interfaces/'], writes: [], verify: [], replan: reason.trim(),
    acceptance: ['用 flow_revise_plan 提交修订：需要新增的任务、需要调整依赖的未开始任务、需要取消的未开始任务', '不修改已开始或已完成的任务'],
  }], actor);
  await d.store.appendHandoff(flowId, id, `用户提出的修订：\n${reason.trim()}\n\n${planSnapshot(tasks)}`, actor);
  return id;
}

export interface RevisionInput {
  add: RevisionTask[];
  rewire: { task: string; depends_on: RevisionTask['depends_on'] }[];
  cancel: { task: string; reason: string }[];
}

export interface CheckedRevision { revision: RevisionInput; errors: string[]; notes: string[]; summary: string }

/** 把 N-xxx 映射为流程内的新编号（接在现有任务之后） */
export function revisionMapping(tasks: readonly TaskFile[], add: readonly RevisionTask[]): Record<string, string> {
  const first = Math.max(0, ...tasks.map((t) => Number(t.id.slice(2)))) + 1;
  return Object.fromEntries(add.map((t, i) => [t.id, `T-${String(first + i).padStart(3, '0')}`]));
}

const mapDeps = (deps: readonly { task: string; type: 'hard' | 'soft'; reason?: string }[], m: Record<string, string>): Dependency[] =>
  deps.map((x) => ({ ...x, task: m[x.task] ?? x.task }));

/**
 * 校验修订：被调整或取消的任务必须未开始；新增任务的阶段不能早于当前阶段、不能是设计阶段；
 * 合并后的 DAG 合法（只报告修订引入的新错误）；剩余任务不得依赖被取消的任务；先行验收测试按规则规范化。
 */
export function checkRevision(config: FlowConfig, flowStages: readonly string[], currentStage: string, tasks: readonly TaskFile[], input: RevisionInput): CheckedRevision {
  const errors: string[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cur = flowStages.indexOf(currentStage);
  const newIds = new Set<string>();
  for (const t of input.add) {
    if (newIds.has(t.id)) errors.push(`新增任务编号重复：${t.id}`);
    newIds.add(t.id);
    const at = flowStages.indexOf(t.stage);
    if (at < 0 || at < cur || DESIGN_STAGES.has(t.stage)) errors.push(`${t.id}：stage ${t.stage} 不合法，只能是 ${flowStages.slice(cur).filter((s) => !DESIGN_STAGES.has(s)).join('、')}`);
    if (['merge-fix', 'review-fix', 'analysis'].includes(t.kind)) errors.push(`${t.id}：kind ${t.kind} 不能用于新增任务`);
    if (t.role === 'orchestrator' || t.role === 'acceptor') errors.push(`${t.id}：角色 ${t.role} 不能承担任务`);
    for (const d of t.depends_on) if (!byId.has(d.task) && !input.add.some((x) => x.id === d.task)) errors.push(`${t.id}：依赖的任务 ${d.task} 不存在`);
  }
  const touched = new Map<string, string>();
  for (const [kind, ids] of [['调整依赖', input.rewire.map((r) => r.task)], ['取消', input.cancel.map((c) => c.task)]] as const) {
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) { errors.push(`${kind}的任务 ${id} 不存在`); continue; }
      if (touched.has(id)) errors.push(`${id} 不能同时${touched.get(id)}和${kind}`);
      touched.set(id, kind);
      if (!(kind === '取消' ? CANCELLABLE : NOT_STARTED).has(t.status)) errors.push(`${id} 当前是 ${t.status}：${kind === '取消' ? '进行中或已完成的任务不能取消' : '已开始或已完成的任务不能调整依赖'}`);
      if (t.kind === 'merge-fix' || t.replan) errors.push(`${id} 由程序生成，不能${kind}`);
    }
  }
  for (const r of input.rewire) for (const d of r.depends_on) if (!byId.has(d.task) && !newIds.has(d.task)) errors.push(`${r.task}：依赖的任务 ${d.task} 不存在`);

  // 合并后的 DAG：用临时编号映射新增任务
  const mapping = revisionMapping(tasks, input.add);
  const cancelled = new Set(input.cancel.map((c) => c.task));
  const rewired = new Map(input.rewire.map((r) => [r.task, mapDeps(r.depends_on, mapping)]));
  const existing = tasks.filter((t) => t.status !== 'cancelled' && !cancelled.has(t.id) && !t.replan)
    .map((t) => (rewired.has(t.id) ? { ...t, depends_on: structuredClone(rewired.get(t.id)!) } : t));
  const added = input.add.map((t) => ({ ...t, id: mapping[t.id]!, depends_on: mapDeps(t.depends_on, mapping) }));
  const merged = [...existing, ...added];
  for (const t of merged) {
    for (const d of t.depends_on) if (cancelled.has(d.task)) errors.push(`${t.id} 依赖被取消的 ${d.task}：请一并调整它的依赖或取消它`);
  }
  const notes: string[] = [];
  const back = Object.fromEntries(Object.entries(mapping).map(([n, t]) => [t, n]));
  const baseline = validateDag(tasks.filter((t) => t.status !== 'cancelled' && !t.replan), config.dagCatalog()).errors;
  const v = validateDag(merged, config.dagCatalog());
  errors.push(...v.errors.filter((e) => !baseline.includes(e)).map((e) => e.replace(/T-\d{3,}/g, (id) => back[id] ? `${back[id]}` : id)));

  // 保存时依赖仍用临时编号（N-xxx），批准时按当时的任务重新编号
  const revision: RevisionInput = {
    add: input.add.map((t) => ({ ...t })),
    rewire: [...rewired].map(([task, depends_on]) => ({ task, depends_on: depends_on.map((d) => ({ ...d, task: back[d.task] ?? d.task })) })),
    cancel: input.cancel,
  };
  const summary = [
    ...revision.add.map((t) => `新增 ${t.id}「${t.title}」（${t.stage}/${t.kind}，${t.role}）`),
    ...revision.rewire.map((r) => `调整 ${r.task} 的依赖为 ${r.depends_on.map((d) => `${d.task}${d.type === 'soft' ? '~' : ''}`).join(',') || '无'}`),
    ...revision.cancel.map((c) => `取消 ${c.task}（${c.reason}）`),
  ].join('；') || '（无改动）';
  if (!revision.add.length && !revision.rewire.length && !revision.cancel.length) errors.push('修订没有任何改动');
  return { revision, errors, notes, summary };
}

export function formatRevision(rev: RevisionFile): string {
  return [
    `计划修订（由 ${rev.task} 提出，原因：${rev.reason}）：`,
    ...(rev.impact ? [`影响分析：${rev.impact}`] : []),
    ...rev.add.map((t) => `+ ${t.id} [${t.stage}/${t.kind}] ${t.title}（${t.role}）writes: ${t.writes.join(', ')}${t.depends_on.length ? `；依赖 ${t.depends_on.map((d) => `${d.task}${d.type === 'soft' ? '~' : ''}`).join(',')}` : ''}`),
    ...rev.rewire.map((r) => `~ ${r.task} 依赖改为 ${r.depends_on.map((d) => `${d.task}${d.type === 'soft' ? '~' : ''}`).join(',') || '无'}`),
    ...rev.cancel.map((c) => `- 取消 ${c.task}：${c.reason}`),
  ].join('\n');
}

/** 用户批准修订：按当前任务重新校验与编号，一个事务内落地 */
export async function approveRevision(d: RevisionDeps, flowId: string): Promise<string> {
  const rev = d.store.readRevision(flowId);
  if (!rev || rev.status !== 'proposed') throw new RevisionError('没有待批准的计划修订');
  const flow = d.store.readFlow(flowId);
  const tasks = d.store.listTasks(flowId);
  const c = checkRevision(d.config, flow.stages, flow.stage, tasks, { add: rev.add, rewire: rev.rewire, cancel: rev.cancel });
  if (c.errors.length) throw new RevisionError(`修订已不再适用（批准前任务状态有变化）：\n${c.errors.map((e) => `- ${e}`).join('\n')}\n请 /flow-reject "<意见>" 后让架构师重新提交。`);
  const mapping = revisionMapping(tasks, c.revision.add);
  // 实施阶段新增的实现任务是模块：合并后要经独立验收（第五轮）
  const add: TaskInput[] = c.revision.add.map((t) => ({ ...t, id: mapping[t.id]!, depends_on: mapDeps(t.depends_on, mapping), ...(t.kind === 'impl' && t.stage === EXECUTION_STAGE ? { needs_acceptance: true } : {}) }));
  const rewire = c.revision.rewire.map((r) => ({ task: r.task, depends_on: mapDeps(r.depends_on, mapping) }));
  await d.store.applyRevision(flowId, { add, rewire, cancel: c.revision.cancel, mapping });
  // 被取消的阻塞任务留下的 worktree 与分支一并回收
  for (const x of c.revision.cancel) {
    const t = d.store.readTask(flowId, x.task);
    if (t.worktree) removeWorktree(d.root, t.worktree, t.branch ?? undefined);
  }
  return [
    `已批准计划修订：${c.summary}`,
    ...(add.length ? [`新增任务编号：${Object.entries(mapping).map(([a, b]) => `${a}→${b}`).join('，')}`] : []),
  ].join('\n');
}

/** 用户打回修订：记录意见并生成新的修订任务，由架构师据此重做 */
export async function rejectRevision(d: RevisionDeps, flowId: string, feedback: string): Promise<string> {
  if (!feedback.trim()) throw new RevisionError('打回必须写明意见：/flow-reject "<意见>"');
  const rev = await d.store.rejectRevision(flowId, feedback);
  const id = await startReplan(d, flowId, `${rev.reason}\n\n上一版修订被用户打回，意见：${feedback.trim()}\n上一版：${rev.summary}`, 'human');
  return `已打回计划修订，生成新的修订任务 ${id}。`;
}
