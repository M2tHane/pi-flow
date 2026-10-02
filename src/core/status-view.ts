// 给人看的状态视图：只呈现高层阶段（需求 → 规划 → 实施 → 验收 → 完成）、进度、正在做的事和需要用户处理的事。
// 底层阶段（S0…S5、F0、F1）、任务 DAG 与状态机细节留给程序与 /flow status --detail。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { isFinished } from './state-store.ts';
import { isLeadingTest } from './dag.ts';
import { PHASES, type FlowFile, type Phase, type TaskFile } from './schemas.ts';

export type PhaseOrDone = Phase | 'done';

export const PHASE_LABEL: Record<PhaseOrDone, string> = {
  discovery: '需求', planning: '规划', execution: '实施', acceptance: '验收', done: '完成',
};

/** 未在 workflow.yaml 中写 phase 时的默认对应 */
const DEFAULT_PHASE: Record<string, Phase> = {
  S0: 'discovery', F0: 'discovery', S1: 'planning', F1: 'planning', S2: 'execution', S3: 'execution', S4: 'acceptance', S5: 'acceptance',
};

const GOALS: Record<'build' | 'feature' | 'fix', Record<PhaseOrDone, string>> = {
  build: {
    discovery: '整理需求，写出 PRD（含非目标与可验证的验收标准）',
    planning: '架构、契约与任务拆解',
    execution: '按任务拆解实现，逐个审查、验证并合入集成分支',
    acceptance: '集成与端到端测试，发布审批后合入主分支',
    done: '已合入主分支',
  },
  feature: {
    discovery: '写出功能说明（目标、非目标、验收标准）',
    planning: '影响面分析与本功能的任务拆解',
    execution: '实现本功能的任务，逐个审查、验证并合入集成分支',
    acceptance: '新功能验收与全量回归，审批后合入主分支',
    done: '已合入主分支',
  },
  fix: {
    discovery: '定位问题与根因',
    planning: '写出复现测试（必须先失败）',
    execution: '修复问题',
    acceptance: '审查、验证并合入主分支',
    done: '已合入主分支',
  },
};

const INFLIGHT = new Set(['in_progress', 'review', 'verifying', 'queued_merge', 'merging']);

export function phaseOfStage(config: FlowConfig, mode: 'build' | 'feature', stage: string): Phase {
  const def = config.raw.modes[mode]?.stages.find((s) => s.id === stage);
  return def?.phase ?? DEFAULT_PHASE[stage] ?? 'execution';
}

/** fix 流程的高层阶段由任务推进情况决定 */
function fixPhase(flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  const scout = tasks.find((t) => t.kind === 'analysis');
  const repro = tasks.find((t) => t.kind === 'test');
  const fix = tasks.find((t) => t.kind === 'impl');
  if (!scout || scout.status !== 'done') return 'discovery';
  if (!repro || repro.status !== 'done') return 'planning';
  if (fix && ['verifying', 'queued_merge', 'merging', 'done'].includes(fix.status)) return 'acceptance';
  return 'execution';
}

export function currentPhase(config: FlowConfig, flow: FlowFile, tasks: TaskFile[]): PhaseOrDone {
  if (flow.mode === 'fix') return fixPhase(flow, tasks);
  if (isFinished(flow) && flow.stage_status === 'done') return 'done';
  return phaseOfStage(config, flow.mode, flow.stage);
}

/** 本流程会经过的高层阶段（按配置的阶段顺序去重） */
export function phasesOf(config: FlowConfig, flow: FlowFile): Phase[] {
  if (flow.mode === 'fix') return [...PHASES];
  const out: Phase[] = [];
  for (const s of flow.stages) {
    const p = phaseOfStage(config, flow.mode, s);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const FAILURE_KIND: Record<string, string> = {
  review_reject: '审查打回', verify_fail: '验证失败', merge_verify_fail: '合并后验证失败', run_failed: '运行中断', lease_expired: '租约过期',
};

/** 任务最近一次失败的类型（来自事件日志） */
export function lastFailureKind(store: StateStore, flowId: string, taskId: string): string | null {
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.task === taskId && e.type === 'transition' && e.trigger && e.trigger in FAILURE_KIND);
  return ev ? FAILURE_KIND[ev.trigger!]! : null;
}

/** expectFail：测试必须先失败（fix 的复现测试、先行验收测试） */
export function taskActivity(t: TaskFile, failureKind: string | null, expectFail: 'repro' | 'leading' | null = null): string {
  const base = t.status === 'in_progress' ? (t.kind === 'analysis' ? (t.lease ? '定位中' : '等待重新派发') : t.lease ? '实现中' : '等待重新派发')
    : t.status === 'review' ? '审查中'
      : t.status === 'verifying' ? (expectFail === 'repro' ? '确认复现中' : expectFail === 'leading' ? '确认测试先失败' : '验证中')
        : t.status === 'queued_merge' || t.status === 'merging' ? '合入中'
          : t.status === 'ready' ? '待派发'
            : t.status === 'pending' ? '等待前置任务'
              : t.status === 'blocked' ? '阻塞' : '已完成';
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
        out.push({ key: `${flow.id}:escalation`, text: `修复 ${flow.id} 超出修复规模：${short(why.replace(/^建议改用 \/flow-build --feature：/, ''))}`, command: '仍按修复处理 /flow approve；改用功能流程 /flow abort 后 /flow-build --feature "<描述>"' });
      } else {
        const phase = PHASE_LABEL[currentPhase(config, flow, tasks)];
        const last = flow.stage === flow.stages.at(-1);
        out.push({ key: `${flow.id}:gate:${flow.stage}`, text: `${phase}阶段的产出等待你审批${last ? '（批准后合入主分支）' : ''}`, command: last ? '/flow approve' : '/flow approve 或 /flow reject "<意见>"' });
      }
    }
    if (flow.mode !== 'fix' && flow.stage_status === 'active') {
      const gate = [...store.readEvents()].reverse().find((e) => e.flow === flow.id && e.type === 'gate_result');
      if (gate?.to === 'active' && gate.data?.['stage'] === flow.stage) {
        out.push({ key: `${flow.id}:gatefail:${gate.seq}`, text: `阶段检查未通过：${short(gate.reason ?? '')}`, command: '修复后执行 /flow gate' });
      }
    }
    for (const t of tasks.filter((x) => x.status === 'blocked')) {
      out.push({ key: `${flow.id}:blocked:${t.id}:${t.version}`, text: `${t.id}「${short(t.title, 40)}」阻塞：${short(t.blocked_reason ?? '')}`, command: `/flow answer ${t.id}` });
    }
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
  lines.push(inPhase.length ? `进度：${inPhase.filter((t) => t.status === 'done').length} / ${inPhase.length} 个任务完成` : '进度：本阶段的任务尚未生成');
  const active = tasks.filter((t) => INFLIGHT.has(t.status));
  lines.push('');
  lines.push(active.length
    ? `正在进行：\n${active.map((t) => `- ${t.id} ${short(t.title, 40)}（${t.lease?.role ?? t.role}）${taskActivity(t, t.attempts ? lastFailureKind(store, flow.id, t.id) : null,
      t.kind !== 'test' ? null : flow.mode === 'fix' ? 'repro' : isLeadingTest(t, tasks) ? 'leading' : null)}`).join('\n')}`
    : `正在进行：${flow.stage_status === 'awaiting_human' ? '无（等待你审批）' : flow.stage_status === 'awaiting_gate' ? '阶段检查中' : '无'}`);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  lines.push(blocked.length ? `阻塞：${blocked.map((t) => t.id).join('、')}（见上方"需要你处理"）` : '阻塞：无');
  return lines.join('\n');
}

/** /flow status 的默认视图 */
export function renderStatus(store: StateStore, config: FlowConfig): string {
  const flows = visibleFlows(store);
  if (!flows.length) return '当前没有进行中的流程。开始：/flow-build "<项目描述>"、/flow-build --feature "<功能描述>" 或 /flow-fix "<问题描述>"。';
  const actions = actionsNeeded(store, config);
  const head = actions.length
    ? `需要你处理：\n${actions.map((a) => `- ${a.text}\n  → ${a.command}`).join('\n')}`
    : '需要你处理：无';
  return [head, ...flows.map((f) => renderFlow(store, config, f)), '（完整任务列表：/flow status --detail；成本：/flow status --cost）'].join('\n\n');
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
    if (!(flow in next.phases)) out.push(`pi-flow：${flow} 已结束${flow.startsWith('X-') ? '，修复已合入主分支或已中止，详见 /flow status --cost 中的修复日志' : ''}。`);
  }
  for (const [key, text] of Object.entries(next.actions)) {
    if (!(key in prev.actions)) out.push(`pi-flow 需要你处理：${text}`);
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
