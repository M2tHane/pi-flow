// orchestrator 的工具：flow_status（只读）、flow_dispatch（只收 ready 任务，非阻塞）、flow_wait（等待变化，返回精简摘要）。
import { Type, type Static } from 'typebox';
import type { StateStore } from '../core/state-store.ts';
import type { Engine } from '../core/dispatcher.ts';
import { TASK_STATUSES, type TaskFile } from '../core/schemas.ts';
import { FlowToolError, type ToolResult } from './subagent-tools.ts';

export const DispatchParams = Type.Object({ task_id: Type.String({ pattern: '^T-[0-9]{3,}$' }) });
export const WaitParams = Type.Object({
  task_id: Type.Optional(Type.String({ pattern: '^T-[0-9]{3,}$' })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, default: 300 })),
});

export function activeFlowId(store: StateStore): string {
  const id = store.readState().active_flow;
  if (!id) throw new FlowToolError('当前没有进行中的流程。请用户执行 /flow-build 或 /flow-build --feature 开始。');
  return id;
}

const one = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

export function statusText(store: StateStore, engine: Engine | null, flowId: string): string {
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const lines = [
    `流程 ${flow.id}「${flow.title}」（${flow.mode}）阶段 ${flow.stage}：${flow.stage_status}`,
    `任务 ${tasks.length} 个：${TASK_STATUSES.filter((s) => count(s)).map((s) => `${s} ${count(s)}`).join('，') || '无'}`,
  ];
  const running = engine?.activeRuns().filter((r) => r.flow === flowId) ?? [];
  const leased = tasks.filter((t) => t.lease);
  if (leased.length) lines.push(`运行中：${leased.map((t) => `${t.id}（${t.lease!.role}，run ${t.lease!.run_id}${running.some((r) => r.run_id === t.lease!.run_id) ? '' : '，不在本会话'}）`).join('；')}`);
  const ready = tasks.filter((t) => t.status === 'ready');
  if (ready.length) lines.push(`可派发：${ready.map((t) => `${t.id} ${t.title}（${t.role}）`).join('；')}`);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) lines.push(`阻塞，需要用户处理：\n${blocked.map((t) => `- ${t.id}：${one(t.blocked_reason ?? '')} → /flow unblock ${t.id}`).join('\n')}`);
  const failing = tasks.filter((t) => t.last_failure && t.status !== 'blocked' && t.status !== 'done');
  if (failing.length) lines.push(`最近失败：\n${failing.map((t) => `- ${t.id}（第 ${t.attempts} 次）：${one(t.last_failure!)}`).join('\n')}`);
  if (flow.stage_status === 'awaiting_human') lines.push(`等待用户：阶段 ${flow.stage} 的闸门待批准 → /flow approve`);
  return lines.join('\n');
}

export async function flowDispatch(store: StateStore, engine: Engine, p: Static<typeof DispatchParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  await engine.promote(flowId);
  let t: TaskFile;
  try {
    t = store.readTask(flowId, p.task_id);
  } catch {
    throw new FlowToolError(`任务 ${p.task_id} 不存在。先调用 flow_status 查看可派发的任务。`);
  }
  if (t.status !== 'ready') {
    const ready = store.listTasks(flowId).filter((x) => x.status === 'ready').map((x) => x.id);
    throw new FlowToolError(`任务 ${t.id} 当前是 ${t.status}，flow_dispatch 只接受 ready 任务。${ready.length ? `当前可派发：${ready.join('、')}` : '当前没有可派发的任务，调用 flow_wait 等待。'}`);
  }
  const d = await engine.dispatch(flowId, t.id);
  return { text: `已派发 ${d.task} 给 ${d.role}（模型 ${d.model}，run ${d.run_id}）。用 flow_wait 等待结果。`, details: { ...d } };
}

export async function flowWait(store: StateStore, engine: Engine, p: Static<typeof WaitParams>): Promise<ToolResult> {
  const flowId = activeFlowId(store);
  const snapshot = () => new Map(store.listTasks(flowId).map((t) => [t.id, `${t.status}|${t.lease?.run_id ?? ''}`]));
  const before = snapshot();
  const deadline = Date.now() + (p.timeout_s ?? 300) * 1000;
  let changed: string[] = [];
  const settled = (id: string) => ['done', 'blocked'].includes(store.readTask(flowId, id).status);
  if (p.task_id && settled(p.task_id)) return { text: `${p.task_id} 已是 ${store.readTask(flowId, p.task_id).status}。\n\n${statusText(store, engine, flowId)}`, details: { changed: [] } };
  while (Date.now() < deadline) {
    await engine.waitForChange(Math.min(5000, deadline - Date.now()));
    const now = snapshot();
    changed = [...now].filter(([id, v]) => before.get(id) !== v).map(([id]) => id);
    if (p.task_id ? changed.includes(p.task_id) || settled(p.task_id) : changed.length) break;
    if (!engine.activeRuns().length && !p.task_id) break;
  }
  const tasks = store.listTasks(flowId);
  const desc = (id: string) => {
    const t = tasks.find((x) => x.id === id)!;
    return `${id}：${before.get(id)?.split('|')[0]} → ${t.status}${t.status === 'blocked' ? `（${one(t.blocked_reason ?? '')}）` : t.last_failure && t.status === 'in_progress' ? `（${one(t.last_failure)}）` : ''}`;
  };
  const head = changed.length ? `变化：\n${changed.map((id) => `- ${desc(id)}`).join('\n')}` : '等待超时，没有状态变化。';
  return { text: `${head}\n\n${statusText(store, engine, flowId)}`, details: { changed } };
}
