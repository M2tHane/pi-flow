// 成本控制（第二轮 H、I；第三轮 C）：按风险选择审查方式与审查模型；失败后升级模型；流程预算。全部由程序按 workflow.yaml 判定。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { FlowFile, RoleSettingsFile, TaskFile } from './schemas.ts';
import { matchesAny, CONTRACTS_PATH } from './paths.ts';
import { isLeadingTest } from './dag.ts';
import { git } from './git.ts';

const isPlaceholder = (m: string) => /^<.*>$/.test(m.trim());

/** 档位名或 provider/model → provider/model；档位未填写（占位符）时返回 null */
export function resolveModelRef(config: FlowConfig, ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.includes('/')) return isPlaceholder(ref) ? null : ref;
  const m = config.raw.models[ref];
  return m && !isPlaceholder(m) ? m : null;
}

// —— H：按风险审查 ——

export const DEFAULT_LOW_RISK_PATHS = ['docs/**', '**/*.md', 'tests/**', '**/*.test.*', '**/*.spec.*'];

export interface ReviewPolicy {
  maxParallel: number;
  lowRisk: { enabled: boolean; mode: 'cheap' | 'skip'; model: string | undefined; maxFiles: number; maxLines: number; paths: string[]; exclude: string[] };
  /** 高风险任务用强模型审查（第三轮 C）；model 未填时：/flow-config escalate reviewer > roles.reviewer.escalate_model > reviewer 档位的上一档 */
  highRisk: { enabled: boolean; model: string | undefined; maxLines: number; paths: string[] };
  /** 审查轮次上限（可选）：到达时提示审查者只剩建议类问题就通过 */
  maxRounds: number | undefined;
  /** 派审查前先跑 verify */
  verifyFirst: boolean;
}

export const DEFAULT_HIGH_RISK_MAX_LINES = 400;

/** 默认值偏保守：只有文档、测试类文件，3 个文件、100 行以内才算低风险 */
export function reviewPolicy(config: FlowConfig): ReviewPolicy {
  const r = config.raw.review ?? {};
  const l = r.low_risk ?? {};
  const h = r.high_risk ?? {};
  return {
    maxParallel: r.max_parallel ?? config.limits.max_parallel,
    highRisk: { enabled: h.enabled ?? true, model: h.model, maxLines: h.max_lines ?? DEFAULT_HIGH_RISK_MAX_LINES, paths: h.paths ?? [] },
    maxRounds: r.max_rounds,
    verifyFirst: r.verify_first ?? true,
    lowRisk: {
      enabled: l.enabled ?? true, mode: l.mode ?? 'cheap', model: l.model ?? 'cheap',
      maxFiles: l.max_files ?? 3, maxLines: l.max_lines ?? 100,
      paths: l.paths ?? DEFAULT_LOW_RISK_PATHS, exclude: l.exclude ?? [],
    },
  };
}

export interface FileChange { path: string; lines: number }

/** 任务 worktree 中 base_sha..HEAD 的改动（文件与增删行数；二进制文件按 0 行） */
export function diffNumstat(t: TaskFile): FileChange[] {
  if (!t.worktree || !t.base_sha) return [];
  return git(t.worktree, ['diff', '--numstat', '--no-renames', t.base_sha, 'HEAD']).split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), lines: (Number(a) || 0) + (Number(d) || 0) };
  });
}

export interface RiskAssessment {
  /** 满足全部低风险条件；reasons 是不算低风险的原因 */
  low: boolean; reasons: string[];
  /** 高风险（用强模型审查）；highReasons 是判为高风险的原因 */
  high: boolean; highReasons: string[];
}

/** 风险分三档：低风险（便宜模型或免审查）、普通（审查者自己的模型）、高风险（强模型） */
export function assessRisk(config: FlowConfig, t: TaskFile, tasks: readonly TaskFile[], changes: readonly FileChange[]): RiskAssessment {
  const policy = reviewPolicy(config);
  const p = policy.lowRisk;
  const reasons: string[] = [];
  if (!p.enabled) reasons.push('未启用低风险审查');
  if (t.kind === 'merge-fix') reasons.push('解决合并冲突');
  if (isLeadingTest(t, tasks)) reasons.push('先行验收测试（要防"必然通过"）');
  if (t.attempts > 0) reasons.push(`之前失败过 ${t.attempts} 次`);
  if (!changes.length) reasons.push('拿不到改动');
  if (changes.length > p.maxFiles) reasons.push(`改动 ${changes.length} 个文件，超过 ${p.maxFiles}`);
  const lines = changes.reduce((n, c) => n + c.lines, 0);
  if (lines > p.maxLines) reasons.push(`改动 ${lines} 行，超过 ${p.maxLines}`);
  const shared = config.raw.scopes['shared']?.writes ?? [];
  const risky = changes.filter((c) => matchesAny(c.path, [CONTRACTS_PATH, ...shared, ...p.exclude]));
  if (risky.length) reasons.push(`涉及契约、shared 或排除路径：${risky.map((c) => c.path).join('、')}`);
  const outside = changes.filter((c) => !matchesAny(c.path, p.paths));
  if (outside.length) reasons.push(`改动不只是文档或测试：${outside.slice(0, 3).map((c) => c.path).join('、')}${outside.length > 3 ? ' 等' : ''}`);
  // 高风险：合并冲突、契约与 shared（及配置的路径）、大改动。
  // 先行验收测试不算：它"必须先失败"已由程序在审查前验证（真实冒烟中 16 次审查有 10 次是它，几乎全用了强模型）
  const h = policy.highRisk;
  const highReasons: string[] = [];
  if (h.enabled) {
    if (t.kind === 'merge-fix') highReasons.push('解决合并冲突');
    const core = changes.filter((c) => matchesAny(c.path, [CONTRACTS_PATH, ...shared, ...h.paths]));
    if (core.length) highReasons.push(`涉及契约、shared 或高风险路径：${core.slice(0, 3).map((c) => c.path).join('、')}${core.length > 3 ? ' 等' : ''}`);
    if (lines > h.maxLines) highReasons.push(`改动 ${lines} 行，超过 ${h.maxLines}`);
  }
  return { low: reasons.length === 0, reasons, high: highReasons.length > 0, highReasons };
}

/**
 * 高风险审查用的模型：/flow-config escalate reviewer > review.high_risk.model > roles.reviewer.escalate_model > reviewer 档位的上一档。
 * 取不到时返回 null（用审查者原来的模型）。
 */
export function strongReviewModel(config: FlowConfig, settings: RoleSettingsFile, role: string, current: string): string | null {
  const m = settings.roles[role]?.escalate_model ?? resolveModelRef(config, reviewPolicy(config).highRisk.model);
  if (m) return m;
  return escalationModel(config, settings, role, current) ?? null;
}

// —— I：失败后升级模型 ——

const TIER_ORDER = ['cheap', 'medium', 'strong'];

export function escalationPolicy(config: FlowConfig): { enabled: boolean; afterFailures: number } {
  const e = config.raw.escalation ?? {};
  return { enabled: e.enabled ?? true, afterFailures: e.after_failures ?? 2 };
}

/**
 * 角色的升级模型：/flow-config 的 escalate_model > workflow.yaml 的 roles.<role>.escalate_model > 角色档位的上一档。
 * 取不到（或与原模型相同）时返回 null，不升级。
 */
export function escalationModel(config: FlowConfig, settings: RoleSettingsFile, role: string, current: string): string | null {
  const s = settings.roles[role]?.escalate_model;
  const tier = config.role(role).modelTier;
  const next = TIER_ORDER.indexOf(tier) >= 0 ? TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] : undefined;
  const m = s ?? resolveModelRef(config, config.raw.roles[role]?.escalate_model) ?? resolveModelRef(config, next);
  return m && m !== current ? m : null;
}

// —— I：预算 ——

export interface BudgetState {
  tokens: { limit: number; used: number } | null;
  cost: { limit: number; used: number; missing: number } | null;
  ratio: number;
  warn: boolean;
  exceeded: boolean;
  warnRatio: number;
}

/** 流程预算：/flow budget 设置的值覆盖 workflow.yaml；用量来自 .flow/runs（tokens 计输入 + 输出，不含缓存） */
export function budgetState(store: StateStore, config: FlowConfig, flow: FlowFile): BudgetState | null {
  const b = { ...config.raw.budget, ...flow.budget };
  if (!b.tokens && !b.cost) return null;
  const runs = store.listRuns().filter((r) => r.flow === flow.id);
  const usedTokens = runs.reduce((n, r) => n + (r.tokens.input ?? 0) + (r.tokens.output ?? 0), 0);
  const usedCost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const missing = runs.filter((r) => r.ended_at && (r.cost === undefined || r.cost === null)).length;
  const tokens = b.tokens ? { limit: b.tokens, used: usedTokens } : null;
  const cost = b.cost ? { limit: b.cost, used: usedCost, missing } : null;
  const ratio = Math.max(tokens ? tokens.used / tokens.limit : 0, cost ? cost.used / cost.limit : 0);
  const warnRatio = config.raw.budget?.warn_ratio ?? 0.8;
  return { tokens, cost, ratio, warn: ratio >= warnRatio, exceeded: ratio >= 1, warnRatio };
}

export function formatBudget(b: BudgetState): string {
  const parts = [
    ...(b.tokens ? [`token ${b.tokens.used.toLocaleString('en-US')} / ${b.tokens.limit.toLocaleString('en-US')}`] : []),
    ...(b.cost ? [`金额 ${b.cost.used.toFixed(4)} / ${b.cost.limit}${b.cost.missing ? `（${b.cost.missing} 次运行没有报告金额，未计入）` : ''}`] : []),
  ];
  return `预算：${parts.join('；')}，已用 ${Math.round(b.ratio * 100)}%${b.exceeded ? '，已超出：暂停派发新任务' : b.warn ? '，接近上限' : ''}`;
}
