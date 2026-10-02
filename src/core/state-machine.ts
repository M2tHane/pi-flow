// 任务与阶段的转移表、前置条件与副作用。纯函数：只根据 facts 判断，不做 IO。
// 能由程序推导的 facts（依赖状态、并发、互斥、handoff、evidence 等）由 StateStore 计算后传入，不采信调用方。
import { createHash } from 'node:crypto';
import type { Lease, StageStatus, TaskFile, TaskStatus } from './schemas.ts';
import { hardDepsDone } from './dag.ts';
import { isProtected, matchesAny } from './paths.ts';

export type Trigger =
  | 'schedule' | 'dispatch' | 'submit' | 'review_pass' | 'review_reject'
  | 'verify_pass' | 'verify_fail' | 'merge_start' | 'merge_done' | 'merge_verify_fail'
  | 'merge_blocked' | 'merge_requeue' | 'block' | 'unblock' | 'lease_expired' | 'run_failed' | 'run_interrupted' | 'report' | 'repro_confirmed' | 'cancel' | 'review_skip';

/** 同一任务连续会话中断达到此次数转 blocked，防止无限重来 */
export const MAX_INTERRUPTIONS = 5;

export interface VerifyResult { command: string; exit_code: number }

export interface Facts {
  now: Date;
  limits: { max_attempts: number; max_parallel: number };
  /** 发起者：human、engine、run:<id> 等 */
  actor: string;
  // —— 由 StateStore 推导 ——
  stage_active?: boolean;
  status_of?: ReadonlyMap<string, TaskStatus>;
  running_count?: number;
  conflicting_running?: string[];
  merging_other?: string | null;
  queue_head?: boolean;
  handoff_written?: boolean;
  evidence_saved?: boolean;
  contracts_locked?: boolean;
  // —— 由调用方（程序内模块或工具层）提供 ——
  token?: string;
  diff_files?: string[];
  verify_results?: VerifyResult[];
  rebase_ok?: boolean;
  post_verify_ok?: boolean;
  fast_forwarded?: boolean;
  worktree_clean?: boolean;
  reason?: string;
  /** 引擎按风险规则判定为低风险（review_skip） */
  low_risk?: boolean;
  /** unblock 时由用户指定的 attempts，缺省清零 */
  attempts?: number;
}

export type TaskPatch = Partial<Pick<TaskFile, 'lease' | 'worktree' | 'branch' | 'base_sha'>>;

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

export const IN_FLIGHT: readonly TaskStatus[] = ['in_progress', 'review', 'verifying', 'queued_merge', 'merging'];
/** 已结束：完成或被计划修订取消（阶段完成的判断以此为准） */
export const isSettled = (t: { status: TaskStatus }) => t.status === 'done' || t.status === 'cancelled';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const need = (cond: boolean | undefined, msg: string) => (cond ? [] : [msg]);
const reasonRequired = (f: { reason?: string }) => need(!!f.reason?.trim(), '必须写明原因');

function leaseValid(lease: Lease | null, f: Facts, what: string): string[] {
  if (!lease) return [`${what}：任务没有有效租约`];
  if (!f.token) return [`${what}：缺少 run token，请确认在 pi-flow 派发的子进程中调用`];
  if (hashToken(f.token) !== lease.token_hash) return [`${what}：run token 无效`];
  if (f.now.getTime() >= Date.parse(lease.expires_at)) return [`${what}：租约已过期，请联系用户执行 /flow resume`];
  return [];
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
    from: ['in_progress'], to: 'review', trigger: 'submit',
    check: (t, f) => {
      const errs = leaseValid(t.lease, f, '提交被拒');
      const diff = f.diff_files;
      if (!diff) errs.push('缺少 worktree diff');
      else if (diff.length === 0) errs.push('worktree 没有改动，无可提交内容');
      else {
        const prot = diff.filter((p) => isProtected(p, { contractsLocked: f.contracts_locked ?? true }));
        if (prot.length) errs.push(`diff 含受保护路径：${prot.join('、')}`);
        const outside = diff.filter((p) => !matchesAny(p, t.writes));
        if (outside.length) errs.push(`diff 越出任务 writes：${outside.join('、')}`);
      }
      errs.push(...need(f.handoff_written, '尚未写 handoff，请先调用 flow_note'));
      return errs;
    },
    effect: (t) => { t.impl_run = t.lease!.run_id; t.lease = null; },
  },
  {
    from: ['review'], to: 'verifying', trigger: 'review_pass',
    check: (t, f) => [
      ...leaseValid(t.lease, f, '审查结论被拒'),
      ...need(!t.lease || t.lease.run_id !== t.impl_run, '审查 run 与实施 run 是同一个 run'),
    ],
    effect: (t) => { t.lease = null; },
  },
  {
    // 偏离（第二轮 H）：低风险任务按 workflow.yaml 配置只做程序检查、免审查。只能由引擎在没有审查 run 时执行
    from: ['review'], to: 'verifying', trigger: 'review_skip',
    check: (t, f) => [
      ...need(f.actor === 'engine', '只有引擎可以按风险规则免审查'),
      ...need(!t.lease, '已有审查 run 在进行'),
      ...need(f.low_risk === true, '任务不是低风险'),
      ...reasonRequired(f),
    ],
  },
  {
    from: ['review'], to: 'in_progress', trigger: 'review_reject', failure: true,
    check: (t, f) => [
      ...leaseValid(t.lease, f, '审查结论被拒'),
      ...need(!t.lease || t.lease.run_id !== t.impl_run, '审查 run 与实施 run 是同一个 run'),
      ...need(!!f.reason?.trim(), '打回必须附原因'),
    ],
  },
  {
    from: ['verifying'], to: 'queued_merge', trigger: 'verify_pass',
    check: (t, f) => {
      const results = f.verify_results ?? [];
      const errs: string[] = [];
      for (const c of t.verify) {
        const r = results.find((x) => x.command === c);
        if (!r) errs.push(`verify 命令 ${c} 未执行`);
        else if (r.exit_code !== 0) errs.push(`verify 命令 ${c} 退出码 ${r.exit_code}`);
      }
      return [...errs, ...need(f.evidence_saved, 'evidence 未保存')];
    },
  },
  {
    from: ['verifying'], to: 'in_progress', trigger: 'verify_fail', failure: true,
    check: (_t, f) => need((f.verify_results ?? []).some((r) => r.exit_code !== 0), 'verify 结果中没有失败的命令'),
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
    effect: (t, f) => { t.blocked_from = t.status; t.blocked_reason = f.reason!; t.lease = null; },
  },
  {
    // 偏离（真实模型冒烟）：审查者在审查中 flow_block 提问，用户回答后回到审查（保留 worktree 与已提交的改动），不重新实施
    from: ['blocked'], to: 'review', trigger: 'unblock',
    check: (t, f) => [
      ...need(f.actor === 'human', '只有用户可以通过 /flow unblock 解除阻塞'),
      ...need(t.blocked_from === 'review', '只有在审查中阻塞的任务可以回到审查'),
      ...need(!!t.worktree && !!t.base_sha, '任务的 worktree 已不存在，只能回到 ready 重新实施'),
    ],
    effect: (t) => { delete t.blocked_from; t.blocked_reason = null; t.lease = null; t.lease_expirations = 0; },
  },
  {
    // 偏离（fix 模式）：只读探查任务（analysis）提交结论后直接完成，没有 diff、审查与合并
    from: ['in_progress'], to: 'done', trigger: 'report',
    check: (t, f) => [
      ...leaseValid(t.lease, f, '提交被拒'),
      ...need(t.kind === 'analysis', '只有 analysis 任务可以直接提交结论'),
      ...need((f.diff_files ?? []).length === 0, `只读任务不得有改动：${(f.diff_files ?? []).join('、')}`),
      ...need(f.handoff_written, '尚未写 handoff，请先调用 flow_note'),
      ...need(!!t.findings || !!t.replan, '缺少结构化结论（findings）'),
    ],
    effect: (t) => { t.impl_run = t.lease!.run_id; t.lease = null; t.worktree = null; },
  },
  {
    // 偏离：测试必须先失败（fix 的复现测试、build/feature 的先行验收测试）；确认失败即完成，随修复任务或承载者一起合入
    from: ['verifying'], to: 'done', trigger: 'repro_confirmed',
    check: (t, f) => {
      const results = f.verify_results ?? [];
      return [
        ...need(t.kind === 'test', '只有复现测试任务可以确认复现'),
        ...need(results.length > 0 && results.every((r) => r.exit_code !== 0), '复现测试没有失败，不能确认复现'),
        ...need(f.evidence_saved, 'evidence 未保存'),
      ];
    },
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
    from: ['review'], to: 'review', trigger: 'run_interrupted',
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的审查 run'), ...reasonRequired(f)],
    effect: (t) => { t.lease = null; t.interruptions = (t.interruptions ?? 0) + 1; },
  },
  {
    from: ['review'], to: 'review', trigger: 'run_failed', failure: true,
    check: (t, f) => [...need(!!t.lease, '任务没有运行中的审查 run'), ...reasonRequired(f)],
  },
  {
    from: ['blocked'], to: 'ready', trigger: 'unblock',
    check: (_t, f) => need(f.actor === 'human', '只有用户可以通过 /flow unblock 解除阻塞'),
    effect: (t, f) => {
      delete t.blocked_from;
      t.attempts = f.attempts ?? 0;
      t.lease_expirations = 0;
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
    else if (facts.verify_results) {
      next.last_failure = facts.verify_results.filter((r) => r.exit_code !== 0)
        .map((r) => `${r.command} 退出码 ${r.exit_code}`).join('；');
    }
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
  if (rule.humanOnly && facts.actor !== 'human') return ['阶段闸门只能由用户执行 /flow approve，agent 无权审批'];
  return rule.check?.(facts) ?? [];
}
