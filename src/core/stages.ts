// 流程与阶段控制：开始流程、批准闸门（仅用户）、打回、解除阻塞、落地任务提案。
import type { FlowConfig } from './config.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { FlowFile, ProposedTask } from './schemas.ts';
import { git, gitOk } from './git.ts';
import { ensureIntegrationBranch } from './worktree.ts';
import { mergeToMain } from './release.ts';
import { DESIGN_STAGES, PROPOSAL_STAGES, STAGE_WRITER, designTasks, revisionTask, type FlowMode, type PlannedTask } from '../modes/plan.ts';
import { formatDagReport } from './dag.ts';
import { REQUIREMENTS_STAGE, reopenRequirements } from './requirements.ts';

export interface StageDeps { root: string; store: StateStore; config: FlowConfig }

export function nextTaskId(store: StateStore, flowId: string, offset = 0): string {
  const nums = store.listTasks(flowId).map((t) => Number(t.id.slice(2)));
  return `T-${String(Math.max(0, ...nums) + 1 + offset).padStart(3, '0')}`;
}

/** 开始 build 或 feature 流程：建流程与集成分支；设计阶段的任务由引擎在 pump 中生成 */
export async function startFlow(d: StageDeps, mode: FlowMode, description: string): Promise<FlowFile> {
  const def = d.config.raw.modes[mode];
  if (!def) throw new Error(`workflow.yaml 没有定义 modes.${mode}`);
  const main = d.config.raw.main_branch;
  if (!gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${main}`])) throw new Error(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  const base = git(d.root, ['rev-parse', main]).trim();
  const flow = await d.store.createFlow({ mode, title: description, stages: def.stages.map((s) => s.id), base_sha: base, actor: 'human' });
  ensureIntegrationBranch(d.root, flow.integration_branch, base);
  return flow;
}

/** 若当前是设计阶段且还没有任务，生成该阶段的任务；revision 为用户打回的意见时，只生成写作者的修订任务（接着原会话）。返回新任务 id */
export async function ensureStageTasks(d: StageDeps, flowId: string, revision?: string): Promise<string[]> {
  const flow = d.store.readFlow(flowId);
  if (flow.mode === 'fix' || !DESIGN_STAGES.has(flow.stage)) return [];
  // 同步主分支产生的 merge-fix 不算本阶段的设计任务
  const existing = d.store.listTasks(flowId).filter((t) => t.stage === flow.stage && t.kind !== 'merge-fix');
  if (existing.length && !revision) return [];
  let planned: PlannedTask[];
  if (revision) {
    const writer = STAGE_WRITER[flow.stage];
    const prev = existing.filter((t) => t.role === writer).at(-1);
    planned = prev ? [revisionTask(flow.stage, prev)] : designTasks(flow.mode, flow.stage, flow.title).filter((t) => t.role === writer);
  } else {
    planned = designTasks(flow.mode, flow.stage, flow.title);
  }
  const ids = planned.map((_, i) => nextTaskId(d.store, flowId, i));
  const tasks: TaskInput[] = planned.map(({ after, ...t }, i) => ({
    ...t, id: ids[i]!,
    depends_on: (after ?? []).map((k) => ({ task: ids[k]!, type: 'hard' as const, reason: '等前置任务完成' })),
  }));
  if (!tasks.length) return [];
  await d.store.addTasks(flowId, tasks, 'engine');
  const brief = d.store.readFlowBrief(flowId).trim();
  for (const t of tasks) {
    await d.store.appendHandoff(flowId, t.id, revision
      ? `用户在闸门审批时打回，意见：\n${revision}\n\n请据此修改已有的产出。`
      : `用户的描述：\n${flow.title}${brief ? `\n\n补充说明：\n${brief}` : ''}`, revision ? 'human' : 'engine');
  }
  return tasks.map((t) => t.id);
}

/** 把提案中的临时编号换成流程内的新编号（依赖一起改写） */
export function renumber(tasks: ProposedTask[], firstId: number): { tasks: TaskInput[]; map: Map<string, string> } {
  const map = new Map(tasks.map((t, i) => [t.id, `T-${String(firstId + i).padStart(3, '0')}`]));
  return {
    map,
    tasks: tasks.map((t) => ({ ...t, id: map.get(t.id)!, depends_on: t.depends_on.map((x) => ({ ...x, task: map.get(x.task) ?? x.task })) })),
  };
}

/** /flow-approve：只能由用户执行。最后一个阶段先合入主分支，成功后才批准。 */
export async function approveStage(d: StageDeps, flowId: string, note?: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_human') {
    throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  }
  const lines: string[] = [];
  const isLast = flow.stage === flow.stages.at(-1);
  if (isLast) {
    const sha = await mergeToMain(d.root, d.store, d.config, flowId);
    lines.push(`已把 ${flow.integration_branch} 合入 ${d.config.raw.main_branch}（${sha.slice(0, 8)}）。`);
  }
  await d.store.transitionStage(flowId, { to: 'done', trigger: 'approve', actor: 'human', ...(note ? { note } : {}) });
  lines.push(`已批准阶段 ${flow.stage}。`);
  if (PROPOSAL_STAGES.has(flow.stage)) {
    const proposal = d.store.readProposal(flowId);
    if (!proposal) throw new Error('没有任务提案（闸门检查应已拦下）');
    const first = Math.max(0, ...d.store.listTasks(flowId).map((t) => Number(t.id.slice(2)))) + 1;
    const { tasks, map } = renumber(proposal.tasks, first);
    await d.store.addTasks(flowId, tasks, 'architect');
    lines.push(`已按模块清单创建 ${tasks.length} 个模块任务（${[...map].map(([a, b]) => `${a}→${b}`).join('，')}）。`);
  }
  const next = await d.store.advanceStage(flowId, 'human');
  lines.push(next.stage !== flow.stage ? `进入阶段 ${next.stage}。` : `流程 ${flow.id} 已完成。`);
  return lines.join('\n');
}

/** /flow-reject：设计阶段打回并生成修订任务 */
export async function rejectStage(d: StageDeps, flowId: string, feedback: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_human') throw new Error(`阶段 ${flow.stage} 当前是 ${flow.stage_status}，没有等待批准的闸门。`);
  if (!DESIGN_STAGES.has(flow.stage)) throw new Error(`阶段 ${flow.stage} 没有可修订的设计产物；如需补充工作，请完成本流程后用 /flow-build --feature 发起新功能。`);
  if (!feedback.trim()) throw new Error('打回必须写明意见：/flow-reject "<意见>"');
  await d.store.transitionStage(flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: feedback });
  if (flow.stage === REQUIREMENTS_STAGE && flow.mode !== 'fix') {
    await reopenRequirements(d.store, flowId, feedback, 'human');
    return `已打回需求说明，主会话会带着你的意见继续和你讨论。`;
  }
  const ids = await ensureStageTasks(d, flowId, feedback);
  return `已打回阶段 ${flow.stage}，生成修订任务 ${ids.join('、')}。`;
}

/** /flow unblock：只能由用户执行；可附回答（写入 handoff）与 attempts */
export async function unblockTask(d: StageDeps, flowId: string, taskId: string, answer?: string, attempts?: number): Promise<string> {
  const t = d.store.readTask(flowId, taskId);
  if (t.status !== 'blocked') throw new Error(`任务 ${taskId} 当前是 ${t.status}，不是 blocked。`);
  if (answer?.trim()) await d.store.appendHandoff(flowId, taskId, `用户回答：\n${answer.trim()}`, 'human');
  await d.store.transitionTask(flowId, taskId, { to: 'ready', trigger: 'unblock', actor: 'human', facts: { ...(attempts !== undefined ? { attempts } : {}) } });
  return `已解除 ${taskId} 的阻塞，任务回到 ready${attempts !== undefined ? `（attempts=${attempts}）` : '（attempts 清零）'}。`;
}

export function proposalSummary(store: StateStore, flowId: string): string {
  const p = store.readProposal(flowId);
  if (!p) return '';
  const extras = p.extras?.length
    ? `\n超出需求的设计（${p.extras.length} 项，需要你确认；不同意就 /flow-reject "删掉第 N 项……"）：\n${p.extras.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`
    : '';
  const assumed = p.assumptions?.length
    ? `\n按默认方案处理的地方（${p.assumptions.length} 项，architect 没有停下来问你；不同意就 /flow-reject "第 N 项改成……"）：\n${p.assumptions.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`
    : '';
  return `模块清单（${p.stage}，批准后创建）：\n${p.tasks.map((t) => `- ${t.id} ${t.title}${t.depends_on.length ? `（等 ${t.depends_on.map((x) => x.task).join('、')} 验收通过）` : ''}\n  可写：${t.writes.join('、')}${t.shared?.length ? `；公共文件：${t.shared.join('、')}` : ''}${t.size ? `；大小 ${t.size}` : ''}\n  验收：${t.acceptance.join('；')}${t.manual_checks?.length ? `\n  你自己打开查看：${t.manual_checks.join('；')}` : ''}`).join('\n')}\n${formatDagReport(p.report)}${extras}${assumed}`;
}
