// 给人看的状态视图：只呈现高层阶段（需求 → 原型 → 规划 → 实施 → 完成）、进度、正在做的事和需要用户处理的事。
// 底层阶段（S0…S5、F0、F1）、任务 DAG 与状态机细节留给程序与 /flow-status --detail。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { isFinished } from './state-store.ts';
import { isLeadingTest } from './dag.ts';
import { budgetState, formatBudget } from './cost-control.ts';
import { activePauses, describePause } from './model-pause.ts';
import { describeStageReview } from './stage-review.ts';
import { type FlowFile, type Phase, type TaskFile } from './schemas.ts';
import { PROPOSAL_STAGES } from '../modes/plan.ts';

export type PhaseOrDone = Phase | 'done';

export const PHASE_LABEL: Record<PhaseOrDone, string> = {
  requirements: '需求', prototype: '原型', planning: '规划', execution: '实施', done: '完成',
};

/** 未在 workflow.yaml 中写 phase 时的默认对应 */
const DEFAULT_PHASE: Record<string, Phase> = {
  D0: 'requirements', D1: 'prototype', D2: 'planning', E: 'execution',
  S0: 'requirements', F0: 'requirements', S1: 'planning', F1: 'planning', S2: 'execution', S3: 'execution', S4: 'execution', S5: 'execution',
};

const GOALS: Record<'build' | 'feature' | 'fix', Record<PhaseOrDone, string>> = {
  build: {
    requirements: '用户视角、开发视角各写一版意见，汇总成需求说明（含验收标准与界面风格），你确认',
    prototype: '按定下的风格生成可点击的原型，你点一遍确认',
    planning: '划分模块、排好顺序、写模块之间的接口与项目规则，你确认',
    execution: '一个模块交给一个模型实现（前后端与测试），合并时跑全量测试，再由独立的验收者对照验收标准确认',
    done: '已合入主分支',
  },
  feature: {
    requirements: '讨论这次要加的功能，汇总成需求说明，你确认',
    prototype: '按定下的风格生成新界面的原型，你确认',
    planning: '确定涉及哪些模块、各改什么、验收标准，你确认',
    execution: '按模块实现，合并时跑全量测试，再由独立的验收者确认',
    done: '已合入主分支',
  },
  fix: {
    requirements: '记录问题',
    prototype: '（不适用）',
    planning: '（不适用）',
    execution: '实现者定位并修复，合并后由验收者复现确认已修好',
    done: '已合入主分支',
  },
};

const INFLIGHT = new Set(['in_progress', 'review', 'verifying', 'queued_merge', 'merging']);

export function phaseOfStage(config: FlowConfig, mode: 'build' | 'feature', stage: string): Phase {
  const def = config.raw.modes[mode]?.stages.find((s) => s.id === stage);
  return def?.phase ?? DEFAULT_PHASE[stage] ?? 'execution';
}

/** fix 流程的高层阶段：记录问题 → 实施（定位、修复、验收）→ 完成 */
function fixPhase(flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  return tasks.length ? 'execution' : 'requirements';
}

export function currentPhase(config: FlowConfig, flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (flow.mode === 'fix') return fixPhase(flow, tasks);
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  return phaseOfStage(config, flow.mode, flow.stage);
}

/** 本流程会经过的高层阶段（按配置的阶段顺序去重） */
export function phasesOf(config: FlowConfig, flow: FlowFile): Phase[] {
  if (flow.mode === 'fix') return ['requirements', 'execution'];
  const out: Phase[] = [];
  for (const s of flow.stages) {
    const p = phaseOfStage(config, flow.mode, s);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const FAILURE_KIND: Record<string, string> = {
  review_reject: '审查打回', verify_fail: '验证失败', precheck_fail: '审查前验证失败', merge_verify_fail: '合并后验证失败', run_failed: '运行中断', lease_expired: '租约过期',
};

/** 任务最近一次失败的类型（来自事件日志） */
export function lastFailureKind(store: StateStore, flowId: string, taskId: string): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.task === taskId && e.type === 'transition' && e.trigger && e.trigger in FAILURE_KIND);
  return ev ? FAILURE_KIND[ev.trigger!]! : null;
}

/** expectFail：测试必须先失败（fix 的复现测试、先行验收测试） */
export function taskActivity(t: TaskFile, failureKind: string | null, expectFail: 'repro' | 'leading' | null = null): string {
  const working = t.stage_review === 'review' ? '阶段审查中' : t.stage_review === 'confirm' ? '确认修复中' : t.kind === 'analysis' ? '定位中' : t.kind === 'review-fix' ? '修复中' : '实现中';
  const base = t.status === 'in_progress' ? (t.lease ? working : '等待重新派发')
    : t.status === 'review' ? '审查中'
      : t.status === 'verifying' ? (expectFail === 'repro' ? '确认复现中' : expectFail === 'leading' ? '确认测试先失败' : '验证中')
        : t.status === 'queued_merge' || t.status === 'merging' ? '合入中'
          : t.status === 'ready' ? '待派发'
            : t.status === 'pending' ? '等待前置任务'
              : t.status === 'blocked' ? '阻塞' : t.status === 'cancelled' ? '已取消' : '已完成';
  const retry = t.attempts > 0 && t.status !== 'done' && t.status !== 'blocked'
    ? `（第 ${t.attempts + 1} 次${failureKind ? `，上次：${failureKind}` : ''}）` : '';
  return base + retry;
}

export interface Action { key: string; text: string; command: string }

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/** 需要用户处理的事项（按流程汇总） */
export function actionsNeeded(store: StateStore, config: FlowConfig): Action[] {
  const out: Action[] = [];
  for (const flow of visibleFlows(store)) {
    const tasks = store.listTasks(flow.id);
    if (flow.stage_status === 'awaiting_human') {
      if (flow.mode === 'fix') {
        const why = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result')?.reason ?? '';
        out.push({ key: `${flow.id}:escalation`, text: `修复 ${flow.id} 超出修复规模：${short(why.replace(/^建议改用 \/flow-build --feature：/, ''))}`, command: '仍按修复处理 /flow-approve；改用功能流程 /flow abort 后 /flow-build --feature "<描述>"' });
      } else {
        const phase = PHASE_LABEL[currentPhase(config, flow, tasks)];
        const last = flow.stage === flow.stages.at(-1);
        const extras = PROPOSAL_STAGES.has(flow.stage) ? store.readProposal(flow.id)?.extras?.length ?? 0 : 0;
        const assumed = PROPOSAL_STAGES.has(flow.stage) ? store.readProposal(flow.id)?.assumptions?.length ?? 0 : 0;
        out.push({ key: `${flow.id}:gate:${flow.stage}`, text: `${phase}阶段的产出等待你审批${last ? '（批准后合入主分支）' : ''}${extras ? `；其中 ${extras} 项设计超出了需求，需要你确认（/flow-status --detail 查看）` : ''}${assumed ? `；${assumed} 处需求没说清，architect 按默认方案处理了，需要你确认（/flow-status --detail 查看）` : ''}`, command: last ? '/flow-approve' : '/flow-approve 或 /flow-reject "<意见>"' });
      }
    }
    if (flow.mode !== 'fix' && flow.stage_status === 'active') {
      const gate = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result');
      const sr = store.readStageReview(flow.id, flow.stage);
      if (sr?.status === 'needs_human') {
        out.push({ key: `${flow.id}:stage-review:${flow.stage}:${sr.version}`, text: `实施阶段的${short(sr.reason ?? '全量测试仍失败', 200)}（失败日志：/flow-status --detail）`,
          command: '用 /flow replan "<怎么修>" 交给 architect 安排修复任务；处理后执行 /flow gate 重跑' });
      } else if (gate?.to === 'active' && gate.data?.['stage'] === flow.stage) {
        out.push({ key: `${flow.id}:gatefail:${gate.seq}`, text: `阶段检查未通过：${short(gate.reason ?? '')}`, command: '修复后执行 /flow gate' });
      }
    }
    const budget = budgetState(store, config, flow);
    if (budget?.warn) {
      out.push({ key: `${flow.id}:budget:${budget.exceeded ? 'over' : 'warn'}`, text: formatBudget(budget),
        command: budget.exceeded ? '/flow budget tokens <数值> 或 /flow budget cost <金额> 提高预算后继续' : '/flow-status --cost 查看用量；需要时 /flow budget 提高预算' });
    }
    const rev = store.readRevision(flow.id);
    if (rev?.status === 'proposed') {
      out.push({ key: `${flow.id}:revision:${rev.version}`, text: `计划修订等待你批准：${short(rev.summary, 200)}`, command: '/flow-approve 批准，或 /flow-reject "<意见>" 打回重做（详情：/flow-status --detail）' });
    }
    if (flow.sync?.status === 'conflict') {
      out.push({ key: `${flow.id}:sync:${flow.sync.main_sha}`, text: `把 ${config.raw.main_branch} 同步进集成分支时冲突，已暂停派发新任务：${short(flow.sync.reason ?? '')}`,
        command: `在 ${flow.integration_branch} 上合并 ${config.raw.main_branch} 并解决冲突后执行 /flow sync` });
    }
    for (const t of tasks.filter((x) => x.status === 'blocked')) {
      out.push({ key: `${flow.id}:blocked:${t.id}:${t.version}`, text: `${t.id}「${short(t.title, 40)}」阻塞：${short(t.blocked_reason ?? '')}`, command: `/flow answer ${t.id}` });
    }
  }
  const now = new Date();
  for (const p of activePauses(store, now)) {
    out.push({ key: `model-pause:${p.model}@${p.since}`, text: short(describePause(p, now), 400),
      command: `等待自动恢复，或 /flow models resume ${p.model} 立即恢复；也可以用 /flow-config 给 ${p.roles.join('、')} 换模型（换后立即继续）` });
  }
  const cand = store.readKnowledge().entries.filter((e) => e.status === 'candidate');
  if (cand.length) {
    out.push({ key: `knowledge:candidates:${cand.at(-1)!.id}`, text: `${cand.length} 条知识候选待确认（来自审查打回、合并后验证失败）：${cand.slice(-3).map((e) => e.id).join('、')}${cand.length > 3 ? ' 等' : ''}`,
      command: '/flow knowledge 查看；确认 /flow knowledge accept <K-编号>，不要 /flow knowledge retire <K-编号>' });
  }
  return out;
}

/** 用户关心的流程：活动的 build/feature 流程，以及未结束的修复 */
export function visibleFlows(store: StateStore): FlowFile[] {
  const out: FlowFile[] = [];
  const active = store.readState().active_flow;
  if (active) out.push(store.readFlow(active));
  const fix = store.openFixFlow();
  if (fix) out.push(fix);
  return out;
}

function phaseBar(config: FlowConfig, flow: FlowFile, cur: PhaseOrDone): string {
  const all: PhaseOrDone[] = [...phasesOf(config, flow), 'done'];
  const idx = all.indexOf(cur);
  return all.map((p, i) => (i < idx ? `${PHASE_LABEL[p]} ✓` : i === idx ? `[${PHASE_LABEL[p]}]` : PHASE_LABEL[p])).join(' → ');
}

export function renderFlow(store: StateStore, config: FlowConfig, flow: FlowFile): string {
  const tasks = store.listTasks(flow.id);
  const cur = currentPhase(config, flow, tasks);
  const lines = [`${flow.id}「${short(flow.title, 60)}」${flow.mode === 'fix' ? '（修复）' : flow.mode === 'feature' ? '（功能）' : ''}`, phaseBar(config, flow, cur), ''];
  lines.push(`${PHASE_LABEL[cur]}阶段：${GOALS[flow.mode][cur]}`);
  const inPhase = flow.mode === 'fix' || cur === 'done' ? tasks
    : tasks.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur);
  const counted = inPhase.filter((t) => t.status !== 'cancelled');
  lines.push(counted.length ? `进度：${counted.filter((t) => t.status === 'done').length} / ${counted.length} 个任务完成` : '进度：本阶段的任务尚未生成');
  const active = tasks.filter((t) => INFLIGHT.has(t.status));
  lines.push('');
  lines.push(active.length
    ? `正在进行：\n${active.map((t) => `- ${t.id} ${short(t.title, 40)}（${t.lease?.role ?? t.role}）${taskActivity(t, t.attempts ? lastFailureKind(store, flow.id, t.id) : null,
      t.kind !== 'test' ? null : flow.mode === 'fix' ? 'repro' : isLeadingTest(t, tasks) ? 'leading' : null)}`).join('\n')}`
    : `正在进行：${flow.stage_status === 'awaiting_human' ? '无（等待你审批）' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '无'}`);
  const sr = flow.mode !== 'fix' ? store.readStageReview(flow.id, flow.stage) : null;
  if (sr && sr.status !== 'done') lines.push(`阶段审查：${describeStageReview(sr)}`);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  lines.push(blocked.length ? `阻塞：${blocked.map((t) => t.id).join('、')}（见上方"需要你处理"）` : '阻塞：无');
  return lines.join('\n');
}

/** /flow-status 的默认视图 */
export function renderStatus(store: StateStore, config: FlowConfig): string {
  const flows = visibleFlows(store);
  if (!flows.length) return '当前没有进行中的流程。开始：/flow-build "<项目描述>"、/flow-build --feature "<功能描述>" 或 /flow-fix "<问题描述>"。';
  const actions = actionsNeeded(store, config);
  const head = actions.length
    ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}`
    : '需要你处理：无';
  return [head, ...flows.map((f) => renderFlow(store, config, f)), '（完整任务列表：/flow-status --detail；成本：/flow-status --cost）'].join('\n\n');
}

// —— 主动通知：只在进入新阶段、出现需要用户处理的事、任务首次失败重试时提醒 ——

export interface StatusSnapshot {
  phases: Record<string, PhaseOrDone>;
  actions: Record<string, string>;
  attempts: Record<string, number>;
}

export function snapshotOf(store: StateStore, config: FlowConfig): StatusSnapshot {
  const snap: StatusSnapshot = { phases: {}, actions: {}, attempts: {} };
  const flows = visibleFlows(store);
  for (const f of flows) {
    const tasks = store.listTasks(f.id);
    snap.phases[f.id] = currentPhase(config, f, tasks);
    for (const t of tasks) snap.attempts[`${f.id}/${t.id}`] = t.attempts;
  }
  for (const a of actionsNeeded(store, config)) snap.actions[a.key] = `${a.text} → ${a.command}`;
  return snap;
}

export function notices(prev: StatusSnapshot, next: StatusSnapshot, failureKind?: (flow: string, task: string) => string | null): string[] {
  const out: string[] = [];
  for (const [flow, phase] of Object.entries(next.phases)) {
    const before = prev.phases[flow];
    if (before && before !== phase) out.push(phase === 'done' ? `pi-flow：${flow} 已完成。` : `pi-flow：${flow} 进入${PHASE_LABEL[phase]}阶段。`);
  }
  for (const flow of Object.keys(prev.phases)) {
    if (!(flow in next.phases)) out.push(`pi-flow：${flow} 已结束${flow.startsWith('X-') ? '，修复已合入主分支或已中止，详见 /flow-status --cost 中的修复日志' : ''}。`);
  }
  for (const [key, text] of Object.entries(next.actions)) {
    if (!(key in prev.actions)) out.push(`pi-flow 需要你处理：${text}`);
  }
  for (const key of Object.keys(prev.actions)) {
    if (key.startsWith('model-pause:') && !(key in next.actions)) out.push(`pi-flow：模型 ${key.slice('model-pause:'.length, key.lastIndexOf('@'))} 已恢复派发。`);
  }
  for (const [key, n] of Object.entries(next.attempts)) {
    if (n === 1 && (prev.attempts[key] ?? 0) === 0) {
      const [flow, task] = key.split('/') as [string, string];
      const kind = failureKind?.(flow, task);
      out.push(`pi-flow：${task} 第一次未通过${kind ? `（${kind}）` : ''}，程序已自动重试。`);
    }
  }
  return out;
}

/**
 * 状态栏一行（调度模式、终端界面）：流程、高层阶段、本阶段进度、正在进行的任务、需要用户处理的事项数。
 * 没有可见流程时返回 null（清除状态栏）。
 */
export function statusLine(store: StateStore, config: FlowConfig): string | null {
  const flows = visibleFlows(store);
  if (!flows.length) return null;
  const actions = actionsNeeded(store, config).length;
  const parts = flows.map((flow) => {
    const tasks = store.listTasks(flow.id);
    const cur = currentPhase(config, flow, tasks);
    const inPhase = (flow.mode === 'fix' || cur === 'done' ? tasks : tasks.filter((t) => phaseOfStage(config, flow.mode as 'build' | 'feature', t.stage) === cur))
      .filter((t) => t.status !== 'cancelled');
    const active = tasks.filter((t) => INFLIGHT.has(t.status));
    const running = active.slice(0, 3).map((t) => `${t.id} ${taskActivity(t, null)}`).join('，');
    const state = flow.stage_status === 'awaiting_human' ? '等待你审批' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '';
    return [`${flow.id} ${PHASE_LABEL[cur]}`, inPhase.length ? `${inPhase.filter((t) => t.status === 'done').length}/${inPhase.length}` : '',
      running ? `进行中：${running}${active.length > 3 ? ` 等 ${active.length} 个` : ''}` : state].filter(Boolean).join(' · ');
  });
  return `pi-flow ${parts.join(' ｜ ')}${actions ? ` · 需要你处理 ${actions} 项` : ''}`;
}
