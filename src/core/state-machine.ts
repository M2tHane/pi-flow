// 任务与阶段的转移表、前置条件与副作用。纯函数：只根据 facts 判断，不做 IO。
// 能由程序推导的 facts（依赖状态、并发、互斥、handoff 等）由 StateStore 计算后传入，不采信调用方。
// 第五轮起没有逐任务审查与单独的 verify：提交后直接进入合并队列，合并时跑全量测试，质量由模块的独立验收把关。
import { createHash } from 'node:crypto';
import type { Lease, StageStatus, TaskFile, TaskStatus } from './schemas.ts';
import { hardDepsDone } from './dag.ts';
import { INTERFACES_PATH, isProtected, matchesAny } from './paths.ts';

export type Trigger =
  | 'schedule' | 'dispatch' | 'submit' | 'merge_start' | 'merge_done' | 'merge_verify_fail' | 'merge_blocked' | 'merge_requeue'
  | 'block' | 'unblock' | 'lease_expired' | 'run_failed' | 'run_interrupted' | 'run_paused' | 'run_timeout' | 'report' | 'cancel';

/** 同一任务连续会话中断达到此次数转 blocked，防止无限重来 */
export const MAX_INTERRUPTIONS = 5;
/** 同一任务超时后可以接着做的次数（limits.max_continuations 的默认值） */
export const DEFAULT_MAX_CONTINUATIONS = 2;

export interface Facts {
  now: Date;
  limits: { max_attempts: number; max_parallel: number; max_continuations?: number };
  /** 发起者：human、engine、run:<id> 等 */
  actor: string;
  // —— 由 StateStore 推导 ——
  stage_active?: boolean;
  /** 依赖判断用的状态（dag.depStatus：验收中的模块为 accepting） */
  status_of?: ReadonlyMap<string, string>;
  running_count?: number;
  conflicting_running?: string[];
  merging_other?: string | null;
  queue_head?: boolean;
  handoff_written?: boolean;
  // —— 由调用方（程序内模块或工具层）提供 ——
  token?: string;
  diff_files?: string[];
  rebase_ok?: boolean;
  post_verify_ok?: boolean;
  fast_forwarded?: boolean;
  worktree_clean?: boolean;
  reason?: string;
  /** 改动了模块之间接口文档（docs/interfaces/）里已有的行：实现者只能追加，文件列表由 flow_submit 计算 */
  interface_rewrites?: string[];
  /** 修改过的、writes 之外的已有测试文件（testing.adjust_tests），由 flow_submit 计算；允许越出 writes */
  test_adjustments?: string[];
  /** unblock 时由用户指定的 attempts，缺省清零 */
  attempts?: number;
}

export type TaskPatch = Partial<Pick<TaskFile, 'lease' | 'worktree' | 'branch' | 'base_sha' | 'timeout_review'>>;

interface Rule {
  from: readonly TaskStatus[];
  to: TaskStatus;
  trigger: Trigger;
  /** 返回中文错误；t 是已应用 patch 的任务 */
  check: (t: TaskFile, f: Facts) => string[];
  effect?: (t: TaskFile, f: Facts) => void;
  /** 失败类转移：attempts 加 1，达上限转 blocked */
  failure?: boolean;
}

export const IN_FLIGHT: readonly TaskStatus[] = ['in_progress', 'queued_merge', 'merging'];
/** 已结束：完成或被计划修订取消（阶段完成的判断以此为准） */
export const isSettled = (t: { status: TaskStatus }) => t.status === 'done' || t.status === 'cancelled';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const need = (cond: boolean | undefined, msg: string) => (cond ? [] : [msg]);
const reasonRequired = (f: { reason?: string }) => need(!!f.reason?.trim(), '必须写明原因');

function leaseValid(lease: Lease | null, f: Facts, what: string): string[] {
  if (!lease) return [`${what}：任务没有有效租约`];
  if (!f.token) return [`${what}：缺少 run token，请确认在 pi-flow 派发的子进程中调用`];
  if (hashToken(f.token) !== lease.token_hash) return [`${what}：run token 无效`];
  if (f.now.getTime() >= Date.parse(lease.expires_at)) return [`${what}：租约已过期，请联系用户执行 /flow-resume`];
  return [];
}

/** 实现类任务可以在模块之间的接口文档里追加（第五轮）：缺了需要的调用时补上，不能改已有内容 */
export const canAppendInterfaces = (t: Pick<TaskFile, 'kind'>) => t.kind === 'impl' || t.kind === 'review-fix';

/** 提交的检查：租约、diff 非空且不越界（含登记的公共文件、可追加的接口文档、适配过的已有测试）、已写 handoff */
function submitErrors(t: TaskFile, f: Facts): string[] {
  const errs = leaseValid(t.lease, f, '提交被拒');
  const diff = f.diff_files;
  if (!diff) errs.push('缺少 worktree diff');
  else if (diff.length === 0) errs.push('worktree 没有改动，无可提交内容');
  else {
    const prot = diff.filter((p) => isProtected(p));
    if (prot.length) errs.push(`diff 含受保护路径：${prot.join('、')}`);
    const adjusted = new Set(f.test_adjustments ?? []);
    const owned = [...t.writes, ...(t.shared ?? [])];
    const outside = diff.filter((p) => !matchesAny(p, owned) && !adjusted.has(p) && !(canAppendInterfaces(t) && matchesAny(p, [INTERFACES_PATH])));
    if (outside.length) errs.push(`diff 越出任务 writes：${outside.join('、')}`);
    if (f.interface_rewrites?.length) errs.push(`只能在接口文档中追加内容，不能修改或删除已有内容：${f.interface_rewrites.join('、')}`);
  }
  errs.push(...need(f.handoff_written, '尚未写 handoff，请先调用 flow_note'));
  return errs;
}

export const TRANSITIONS: readonly Rule[] = [
  {
    from: ['pending'], to: 'ready', trigger: 'schedule',
    check: (t, f) => {
      const errs = need(f.stage_active, `任务所属 stage ${t.stage} 不是 active`);
      const status = f.status_of ?? new Map();
      if (!hardDepsDone(t, status)) {
        const waiting = t.depends_on.filter((d) => d.type === 'hard' && status.get(d.task) !== 'done').map((d) => d.task);
        errs.push(`硬依赖未完成：${waiting.join('、')}`);
      }
      return errs;
    },
  },
  {
    from: ['ready'], to: 'in_progress', trigger: 'dispatch',
    check: (t, f) => [
      ...need((f.running_count ?? Infinity) < f.limits.max_parallel, `并发已达上限 ${f.limits.max_parallel}`),
      ...need((f.conflicting_running ?? []).length === 0, `与运行中任务互斥：${(f.conflicting_running ?? []).join('、')}`),
      ...need(!!t.worktree && !!t.branch, '尚未建立 worktree 与任务分支'),
      ...need(!!t.base_sha, '尚未记录 base_sha'),
      ...need(!!t.lease, '尚未颁发 token 与租约'),
    ],
  },
  {
    // 提交后直接进入合并队列，合并时跑全量测试
    from: ['in_progress'], to: 'queued_merge', trigger: 'submit',
    check: submitErrors,
    effect: (t, f) => {
      t.impl_run = t.lease!.run_id;
      t.lease = null;
      if (f.test_adjustments?.length) t.test_adjustments = [...f.test_adjustments];
      else delete t.test_adjustments;
    },
  },
  {
    from: ['queued_merge'], to: 'merging', trigger: 'merge_start',
    check: (_t, f) => [
      ...need(!f.merging_other, `已有任务在合并中：${f.merging_other}`),
      ...need(f.queue_head === true, '尚未轮到该任务合并（不在合并队列队首）'),
    ],
  },
  {
    from: ['merging'], to: 'done', trigger: 'merge_done',
    check: (_t, f) => [
      ...need(f.rebase_ok, 'rebase 未成功'),
      ...need(f.post_verify_ok, '合并后验证未通过'),
      ...need(f.fast_forwarded, '尚未快进到集成分支'),
    ],
    effect: (t) => { t.worktree = null; t.lease = null; },
  },
  {
    from: ['merging'], to: 'in_progress', trigger: 'merge_verify_fail', failure: true,
    check: (_t, f) => [...need(f.post_verify_ok === false, '合并后验证并未失败'), ...reasonRequired(f)],
  },
  {
    from: ['merging'], to: 'blocked', trigger: 'merge_blocked',
    check: (_t, f) => reasonRequired(f),
    effect: (t, f) => { t.blocked_reason = f.reason!; },
  },
  {
    // 偏离：第 18 节恢复流程需要，第 10 节转移表未列出
    from: ['merging'], to: 'queued_merge', trigger: 'merge_requeue',
    check: () => [],
  },
  {
    from: IN_FLIGHT, to: 'blocked', trigger: 'block',
    check: (_t, f) => reasonRequired(f),
    effect: (t, f) => { t.blocked_reason = f.reason!; t.lease = null; delete t.timeout_review; },
  },
  {
    // 只读任务（需求讨论、验收、计划修订）提交结论后直接完成，没有 diff 与合并
    from: ['in_progress'], to: 'done', trigger: 'report',
    check: (t, f) => [
      ...leaseValid(t.lease, f, '提交被拒'),
      ...need(t.kind === 'analysis', '只有 analysis 任务可以直接提交结论'),
      ...need((f.diff_files ?? []).length === 0, `只读任务不得有改动：${(f.diff_files ?? []).join('、')}`),
      ...need(f.handoff_written, '尚未写 handoff，请先调用 flow_note'),
      ...need(!!t.replan || !!t.accept_of || !!t.final_review, '缺少结构化结论'),
    ],
    effect: (t) => { t.impl_run = t.lease!.run_id; t.lease = null; t.worktree = null; },
  },
  {
    // 偏离（第二轮 G）：用户批准的计划修订取消未开始或已阻塞（已停止）的任务；进行中或已完成的任务不能取消
    from: ['pending', 'ready', 'blocked'], to: 'cancelled', trigger: 'cancel',
    check: (_t, f) => [...need(f.actor === 'human', '只有用户批准的计划修订可以取消任务'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; },
  },
  {
    // 偏离：子进程未提交就退出（崩溃、放弃）。保留 worktree，清空租约，计一次失败；由引擎重新派发
    from: ['in_progress'], to: 'in_progress', trigger: 'run_failed', failure: true,
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)],
  },
  {
    // 偏离：会话中断（不是 subagent 的错）只记录次数，不消耗失败预算；保留 worktree，由引擎重新派发
    from: ['in_progress'], to: 'in_progress', trigger: 'run_interrupted',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; t.interruptions = (t.interruptions ?? 0) + 1; },
  },
  {
    // 偏离（第三轮 A）：模型服务不可用（额度用完、限流等）不是任务的问题，不计失败也不计中断；
    // 清空租约等模型恢复后由引擎重新派发（暂停记录见 core/model-pause.ts）
    from: ['in_progress'], to: 'in_progress', trigger: 'run_paused',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; },
  },
  {
    // 超过时间预算被结束：不计失败，记一次超时，等主会话复核（复核内容由调用方经 patch.timeout_review 给出）
    from: ['in_progress'], to: 'in_progress', trigger: 'run_timeout',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的 run'), ...need(!!t.timeout_review, '缺少超时复核信息'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; t.timeouts = (t.timeouts ?? 0) + 1; },
  },
  {
    from: ['blocked'], to: 'ready', trigger: 'unblock',
    check: (_t, f) => need(f.actor === 'human', '只有用户可以通过 /flow unblock 解除阻塞'),
    effect: (t, f) => {
      t.attempts = f.attempts ?? 0;
      t.lease_expirations = 0;
      delete t.timeouts;
      delete t.timeout_review;
      t.blocked_reason = null;
      t.lease = null;
      t.worktree = null;
      t.branch = null;
      t.base_sha = null;
    },
  },
  {
    from: ['in_progress'], to: 'ready', trigger: 'lease_expired', failure: true,
    check: (t, f) => {
      if (!t.lease) return ['任务没有租约'];
      if (f.now.getTime() < Date.parse(t.lease.expires_at)) return ['租约未过期'];
      return need(f.worktree_clean, 'worktree 有未提交改动，需要用户决定继续或丢弃');
    },
    effect: (t) => {
      t.lease_expirations += 1;
      t.worktree = null;
      t.branch = null;
      t.base_sha = null;
    },
  },
];

export type PlanResult =
  | { ok: true; task: TaskFile; to: TaskStatus; rule: Rule }
  | { ok: false; errors: string[] };

/** 计算一次转移的结果；不修改入参。to 可能因失败预算耗尽而被改写为 blocked。 */
export function planTransition(task: TaskFile, to: TaskStatus, trigger: Trigger, facts: Facts, patch: TaskPatch = {}): PlanResult {
  const rule = TRANSITIONS.find((r) => r.trigger === trigger && r.to === to && r.from.includes(task.status));
  if (!rule) return { ok: false, errors: [`非法转移：${task.status} -> ${to}（触发 ${trigger}）`] };

  const next: TaskFile = structuredClone(task);
  Object.assign(next, structuredClone(patch));
  const errors = rule.check(next, facts);
  if (errors.length) return { ok: false, errors };

  rule.effect?.(next, facts);
  let effective = to;
  if (rule.failure) {
    next.attempts += 1;
    next.lease = null;
    if (facts.reason) next.last_failure = facts.reason;
    if (next.attempts >= facts.limits.max_attempts) {
      effective = 'blocked';
      next.blocked_reason = `失败次数达到上限 ${facts.limits.max_attempts}：${next.last_failure ?? trigger}`;
    } else if (trigger === 'lease_expired' && next.lease_expirations >= 2) {
      effective = 'blocked';
      next.blocked_reason = '租约过期两次';
    }
  }
  if (trigger === 'run_interrupted' && (next.interruptions ?? 0) >= MAX_INTERRUPTIONS) {
    effective = 'blocked';
    next.blocked_reason = `会话已连续中断 ${next.interruptions} 次：${facts.reason ?? ''}。请检查环境后 /flow unblock`;
  }
  const maxCont = facts.limits.max_continuations ?? DEFAULT_MAX_CONTINUATIONS;
  if (trigger === 'run_timeout' && (next.timeouts ?? 0) > maxCont) {
    effective = 'blocked';
    delete next.timeout_review;
    next.blocked_reason = `运行已超时 ${next.timeouts} 次（每次的时间预算用完仍没完成）：${facts.reason ?? ''}。请看 handoff 判断卡在哪，必要时改计划（拆小任务）或换模型后 /flow unblock`;
  }
  next.status = effective;
  return { ok: true, task: next, to: effective, rule };
}

// —— 阶段状态机 ——

export type StageTrigger = 'submit_gate' | 'gate_failed' | 'gate_passed' | 'approve' | 'reject' | 'abort';

interface StageRule {
  from: readonly StageStatus[];
  to: StageStatus;
  trigger: StageTrigger;
  humanOnly?: boolean;
  check?: (f: StageFacts) => string[];
}

export interface StageFacts {
  actor: string;
  /** gate_passed 时：该阶段是否还需要人工批准 */
  needs_human?: boolean;
  reason?: string;
}

export const STAGE_TRANSITIONS: readonly StageRule[] = [
  { from: ['active'], to: 'awaiting_gate', trigger: 'submit_gate' },
  { from: ['awaiting_gate'], to: 'active', trigger: 'gate_failed', check: reasonRequired },
  { from: ['awaiting_gate'], to: 'awaiting_human', trigger: 'gate_passed', check: (f) => need(f.needs_human === true, '该阶段不需要人工批准') },
  { from: ['awaiting_gate'], to: 'done', trigger: 'gate_passed', check: (f) => need(f.needs_human === false, '该阶段需要人工批准') },
  { from: ['awaiting_human'], to: 'done', trigger: 'approve', humanOnly: true },
  { from: ['awaiting_human'], to: 'active', trigger: 'reject', humanOnly: true, check: reasonRequired },
  { from: ['active', 'awaiting_gate', 'awaiting_human'], to: 'aborted', trigger: 'abort', humanOnly: true },
];

export function planStageTransition(from: StageStatus, to: StageStatus, trigger: StageTrigger, facts: StageFacts): string[] {
  const rule = STAGE_TRANSITIONS.find((r) => r.trigger === trigger && r.to === to && r.from.includes(from));
  if (!rule) return [`非法的阶段转移：${from} -> ${to}（触发 ${trigger}）`];
  if (rule.humanOnly && facts.actor !== 'human') return ['阶段闸门只能由用户执行 /flow-approve，agent 无权审批'];
  return rule.check?.(facts) ?? [];
}
