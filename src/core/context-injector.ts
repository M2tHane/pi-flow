// 每轮向 orchestrator 注入"当前状态与唯一允许的下一步"（第 18 节第 7 条、第 20 节第 3 条），并检测主工作区越权改动（第 20 节第 6 条）。
import type { StateStore } from './state-store.ts';
import type { FlowConfig } from './config.ts';
import { budgetState } from './cost-control.ts';
import { computeReady } from './dag.ts';
import { isSettled } from './state-machine.ts';
import { heldByRevision } from './revision.ts';
import { selectDispatchable } from './scheduler.ts';
import { git } from './git.ts';
import type { ModelPause, TaskFile } from './schemas.ts';

export interface NextStep { summary: string; next: string; tool: 'flow_dispatch' | 'flow_wait' | 'none'; task?: string }

/** paused：任务下一次派发要用的模型正被暂停时返回暂停记录（来自 Engine.pausedFor） */
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;

export function nextStep(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '如需开始，请用户执行 /flow-build（新项目）、/flow-build --feature "<描述>" 或 /flow-fix "<描述>"。不要自己修改代码。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const stageTasks = tasks.filter((t) => t.stage === flow.stage);
  const count = (pred: (t: TaskFile) => boolean) => stageTasks.filter(pred).length;
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；本阶段任务 ${stageTasks.length} 个：完成 ${count((t) => t.status === 'done')}，进行中 ${count((t) => ['in_progress', 'review', 'verifying', 'queued_merge', 'merging'].includes(t.status))}，可派发 ${count((t) => t.status === 'ready' || t.status === 'pending')}，阻塞 ${count((t) => t.status === 'blocked')}。`;

  if (store.readRevision(flowId)?.status === 'proposed') return { summary, next: '计划修订等待用户批准。请向用户概述修订内容（flow_status 中可见），请其执行 /flow approve 或 /flow reject "<意见>"；你只能等待。', tool: 'none' };
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 的闸门等待用户批准。请向用户说明结果，请其执行 /flow approve；你只能等待。`, tool: 'none' };
  if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在执行阶段闸门检查，调用 flow_wait 等待结果。', tool: 'flow_wait' };
  if (flow.stage_status !== 'active') return { summary, next: '流程已结束或中止。向用户汇报即可。', tool: 'none' };

  const budget = config ? budgetState(store, config, flow) : null;
  const overBudget = budget?.exceeded ? '本流程的预算已用完，程序暂停派发新任务。向用户说明，请其用 /flow budget 提高预算后继续。' : null;
  // 预测 promote 后的 ready（只读计算，不落盘）
  const promoted = new Set(computeReady(tasks, flow.stage));
  const view = tasks.map((t) => (promoted.has(t.id) ? { ...t, status: 'ready' as const } : t));
  const held = heldByRevision(store, flowId);
  const waiting = new Map<string, ModelPause>();
  for (const t of view) {
    const p = paused?.(flowId, t);
    if (p) waiting.set(t.id, p);
  }
  const pick = selectDispatchable(view.filter((t) => !held.has(t.id) && !waiting.has(t.id)), flow.stage, maxParallel)[0];
  const busy = view.some((t) => t.lease || ['verifying', 'queued_merge', 'merging'].includes(t.status)) || activeRunCount > 0;
  // 自动派发（limits.auto_dispatch，默认开）时 ready 任务由程序派发；只有程序空闲却还有可派发的任务（自动派发出错）时才让 orchestrator 手动派发以看到原因
  const auto = config?.limits.auto_dispatch !== false;
  if (pick && !overBudget && !(auto && busy)) return { summary, next: `调用 flow_dispatch(${pick})。不要自己实现任务。`, tool: 'flow_dispatch', task: pick };
  if (busy) return { summary, next: auto
    ? '任务由程序自动派发、审查、验证与合并。调用 flow_wait 等待：它只在任务完成或阻塞、需要用户处理、阶段变化时返回；返回后用一两句话向用户汇报进展，再继续 flow_wait。'
    : '有任务在运行或合并中，调用 flow_wait 等待结果。', tool: 'flow_wait' };
  if (overBudget) return { summary, next: overBudget, tool: 'none' };
  if (waiting.size) {
    const models = [...new Set([...waiting.values()].map((p) => p.model))];
    return { summary, next: `模型 ${models.join('、')} 暂停中（额度用完或服务不可用），任务 ${[...waiting.keys()].join('、')} 在等它恢复，程序会在恢复后自动继续。向用户说明，请其等待自动恢复、执行 /flow models resume <模型> 立即恢复，或用 /flow-config 给受影响的角色换模型；你只能等待，不要调用 flow_dispatch。`, tool: 'none' };
  }
  const blocked = stageTasks.filter((t) => t.status === 'blocked');
  if (blocked.length) return { summary, next: `没有可推进的任务。向用户报告阻塞：${blocked.map((t) => `${t.id}（${(t.blocked_reason ?? '').slice(0, 60)}）`).join('；')}，请其回答问题（/flow answer <任务>）；如果用户认为需要改计划（例如任务拆得不对、验收标准不合理），调用 flow_replan 交给 architect 修订。`, tool: 'none' };
  if (stageTasks.length && stageTasks.every(isSettled)) return { summary, next: '本阶段任务全部完成，等待程序执行阶段闸门；调用 flow_wait。', tool: 'flow_wait' };
  return { summary, next: '当前阶段没有任务。向用户说明并等待指示。', tool: 'none' };
}

export function turnContext(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): string {
  const s = nextStep(store, maxParallel, activeRunCount, config, paused);
  return `[pi-flow 状态] ${s.summary}\n[唯一允许的下一步] ${s.next}`;
}

/** 主工作区中 .flow/ 之外的未提交改动（含未跟踪文件） */
export function dirtyFiles(root: string): Set<string> {
  const out = git(root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).flow']).split('\n').filter(Boolean);
  return new Set(out.map((l) => l.slice(3)));
}

/** 本轮期间新出现的改动（轮开始时已有的不算，用户在两轮之间自己的改动不计为越权） */
export function newDrift(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((f) => !before.has(f)).sort();
}
