// 每轮向 orchestrator 注入"当前状态与唯一允许的下一步"（第 18 节第 7 条、第 20 节第 3 条），并检测主工作区越权改动（第 20 节第 6 条）。
import type { StateStore } from './state-store.ts';
import type { FlowConfig } from './config.ts';
import { budgetState } from './cost-control.ts';
import { computeReady } from './dag.ts';
import { isSettled } from './state-machine.ts';
import { heldByRevision } from './revision.ts';
import { selectDispatchable } from './scheduler.ts';
import { git } from './git.ts';
import type { FlowFile, ModelPause, TaskFile } from './schemas.ts';
import { REQUIREMENTS_STAGE } from './requirements.ts';
import { FINAL_REVIEW_DOC, LEVEL_LABEL } from './final-review.ts';

export interface NextStep { summary: string; next: string; tool: 'flow_dispatch' | 'flow_wait' | 'flow_requirements' | 'none'; task?: string }

/** paused：任务下一次派发要用的模型正被暂停时返回暂停记录（来自 Engine.pausedFor） */
export type PausedOf = (flowId: string, t: TaskFile) => ModelPause | null;

export function nextStep(store: StateStore, maxParallel: number, activeRunCount = 0, config?: FlowConfig, paused?: PausedOf): NextStep {
  const flowId = store.readState().active_flow;
  if (!flowId) return { summary: '没有进行中的流程。', next: '如需开始，请用户执行 /flow-build（新项目）、/flow-build --feature "<描述>" 或 /flow-fix "<描述>"。不要自己修改代码。', tool: 'none' };
  const flow = store.readFlow(flowId);
  const tasks = store.listTasks(flowId);
  const stageTasks = tasks.filter((t) => t.stage === flow.stage);
  const count = (pred: (t: TaskFile) => boolean) => stageTasks.filter(pred).length;
  const summary = `流程 ${flow.id}「${flow.title}」阶段 ${flow.stage}（${flow.stage_status}）；本阶段任务 ${stageTasks.length} 个：完成 ${count((t) => t.status === 'done')}，进行中 ${count((t) => ['in_progress', 'queued_merge', 'merging'].includes(t.status))}，可派发 ${count((t) => t.status === 'ready' || t.status === 'pending')}，阻塞 ${count((t) => t.status === 'blocked')}。`;

  if (store.readRevision(flowId)?.status === 'proposed') return { summary, next: '计划修订等待用户批准。请向用户概述修订内容（flow_status 中可见），请其执行 /flow-approve 或 /flow-reject "<意见>"；你只能等待。', tool: 'none' };
  if (flow.stage_status === 'awaiting_human') return { summary, next: `阶段 ${flow.stage} 的闸门等待用户批准。请向用户说明结果，请其执行 /flow-approve；你只能等待。`, tool: 'none' };
  if (flow.stage_status === 'awaiting_gate') return { summary, next: '程序正在执行阶段闸门检查，调用 flow_wait 等待结果。', tool: 'flow_wait' };
  if (flow.stage_status !== 'active') return { summary, next: '流程已结束或中止。向用户汇报即可。', tool: 'none' };
  if (flow.stage === REQUIREMENTS_STAGE && flow.mode !== 'fix' && !flow.requirements?.submitted) return { summary, next: requirementsNext(flow), tool: 'flow_requirements' };
  const review = store.readFinalReview(flowId);
  if (review?.status === 'awaiting_user' && review.stage === flow.stage) {
    const left = review.findings.filter((f) => !review.fixed.includes(f.id));
    return { summary, next: `最终代码审查已完成（${FINAL_REVIEW_DOC}），还有 ${left.length} 条没修：${left.map((f) => `${f.id}【${LEVEL_LABEL[f.level]}】${f.problem.slice(0, 60)}`).join('；')}。向用户概述这些条目，请用户挑选：/flow review fix <R-编号>... 交给负责的模块修复，或 /flow review done 都不修；你只能等待。`, tool: 'none' };
  }

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
  const busy = view.some((t) => t.lease || ['queued_merge', 'merging'].includes(t.status)) || activeRunCount > 0;
  // 自动派发（limits.auto_dispatch，默认开）时 ready 任务由程序派发；只有程序空闲却还有可派发的任务（自动派发出错）时才让 orchestrator 手动派发以看到原因
  const auto = config?.limits.auto_dispatch !== false;
  if (pick && !overBudget && !(auto && busy)) return { summary, next: `调用 flow_dispatch(${pick})。不要自己实现任务。`, tool: 'flow_dispatch', task: pick };
  if (busy) return { summary, next: auto
    ? '任务由程序自动派发、合并，合并后由独立的验收者确认。调用 flow_wait 等待：它只在任务完成或阻塞、需要用户处理、阶段变化时返回；返回后用一两句话向用户汇报进展，再继续 flow_wait。'
    : '有任务在运行或合并中，调用 flow_wait 等待结果。', tool: 'flow_wait' };
  if (overBudget) return { summary, next: overBudget, tool: 'none' };
  if (waiting.size) {
    const models = [...new Set([...waiting.values()].map((p) => p.model))];
    return { summary, next: `模型 ${models.join('、')} 暂停中（额度用完或服务不可用），任务 ${[...waiting.keys()].join('、')} 在等它恢复，程序会在恢复后自动继续。向用户说明，请其等待自动恢复、执行 /flow models resume <模型> 立即恢复，或用 /flow-config 给受影响的角色换模型；你只能等待，不要调用 flow_dispatch。`, tool: 'none' };
  }
  const blocked = stageTasks.filter((t) => t.status === 'blocked');
  if (blocked.length) return { summary, next: `没有可推进的任务。向用户报告阻塞：${blocked.map((t) => `${t.id}（${(t.blocked_reason ?? '').slice(0, 60)}）`).join('；')}，请其回答问题（/flow answer <任务>）；如果用户认为需要改计划（例如任务拆得不对、验收标准不合理），调用 flow_replan 交给 architect 修订。`, tool: 'none' };
  const human = store.listAcceptances(flowId).filter((a) => a.status === 'needs_human');
  if (human.length) return { summary, next: `模块 ${human.map((a) => a.task).join('、')} 的验收两轮修复后仍未通过（${(human[0]!.reason ?? '').slice(0, 120)}），依赖它们的模块在等待。向用户说明，请其决定：/flow accept <任务> 人工放行，或用 flow_replan 转达修改要求；你只能等待。`, tool: 'none' };
  if (stageTasks.length && stageTasks.every(isSettled)) return { summary, next: '本阶段任务全部完成，等待程序进行验收与阶段检查；调用 flow_wait。', tool: 'flow_wait' };
  return { summary, next: '当前阶段没有任务。向用户说明并等待指示。', tool: 'none' };
}

/** 需求讨论（D0）：主会话直接和用户逐轮讨论（见技能 grilling、write-requirements） */
function requirementsNext(flow: FlowFile): string {
  const r = flow.requirements;
  const what = flow.mode === 'build' ? '这个新项目' : '这次要加的功能';
  const head = r?.feedback
    ? `需求说明被打回（第 ${r.rounds} 次），意见：${r.feedback}\n带着这些意见继续和用户讨论，改好后重新提交。`
    : `现在是需求讨论：和用户逐轮讨论${what}（用户的描述：${flow.title}）。`;
  return `${head}\n每轮把能问的问题一次问完（有 ask_user 时用它），编号并给出你推荐的答案，然后等用户回答；需要的事实自己查（read、grep、find、ls${flow.mode === 'feature' ? '，先了解相关的现有代码' : ''}），决定交给用户。要问到：谁用、核心场景、MVP 范围与验收标准、术语、界面风格、是否需要先看原型。用户确认共识后，按技能 write-requirements 写成需求说明，调用 flow_requirements(content, prototype) 提交${r?.path ? `（写到 ${r.path}）` : ''}；提交后等用户 /flow-approve。不要自己修改代码，也不要调用 flow_dispatch。`;
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
