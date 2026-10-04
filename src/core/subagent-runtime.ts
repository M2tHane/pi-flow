// subagent 进程内的运行时：根据 run 环境构造 guard 上下文、拦截工具调用、执行 flow_* 工具。
// pi-adapter 的子进程扩展与测试用 fake-subagent 共用这一实现。
import { Value } from 'typebox/value';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { hashToken } from './state-machine.ts';
import { scratchDir } from './worktree.ts';
import { TEST_GLOBS, adjustableTests, testAdjustEnabled } from './test-adjust.ts';
import { matchesAny } from './paths.ts';
import { enforceToolCall, type GuardContext, type ToolCall } from './guard.ts';
import { FlowToolError, SUBAGENT_TOOLS, type RunEnv, type SubagentToolName, type ToolResult } from '../tools/subagent-tools.ts';

export type GateResult = { block: false } | { block: true; reason: string; terminate: boolean };

/**
 * 原地打转（第四轮复跑看板发现：glm 连续 281 次执行同一条调试命令，心跳续租让租约永不过期）：
 * 连续这么多次完全相同的工具调用时拦下并提示换思路；到上限结束本次运行（计一次失败，重新派发，失败多次后升级模型）。
 */
export const REPEAT_WARN = 5;
export const REPEAT_LIMIT = 10;

export class SubagentRuntime {
  readonly env: RunEnv;
  readonly store: StateStore;
  readonly config: FlowConfig;
  private readonly now?: () => Date;
  private lastCall = '';
  private repeats = 0;

  constructor(env: RunEnv, store: StateStore, config: FlowConfig, now?: () => Date) {
    this.env = env;
    this.store = store;
    this.config = config;
    if (now) this.now = now;
  }

  task(): TaskFile {
    return this.store.readTask(this.env.flow, this.env.task);
  }

  /** 子进程应启用的工具（第 14 节第 7 条）；只包含当前已注册的工具由调用方过滤 */
  activeTools(): string[] {
    return this.config.activeTools(this.env.role);
  }

  guardContext(cwd: string): GuardContext {
    const t = this.task();
    const flow = this.store.readFlow(this.env.flow);
    const role = this.config.role(this.env.role);
    return {
      config: this.config,
      role: this.env.role,
      cwd,
      workspaceRoot: t.worktree ?? this.env.root,
      mainRoot: this.env.root,
      // 批准的计划修订创建的"改 API 文档"任务可以写契约，其余任务在契约锁定后只读
      // 阶段审查的修复任务可以补充契约（只能新增，flow_submit 检查）
      contractsLocked: ('S1' in flow.approvals || 'F1' in flow.approvals) && !t.contract_change && t.kind !== 'review-fix',
      ...(t.kind === 'review-fix' ? { contractAdditions: true } : {}),
      ...(role.writes.length ? { writes: t.conflict_files ?? t.writes, scratchDir: scratchDir(this.env.root, this.env.run) } : {}),
      ...(testAdjustEnabled(this.config, t) && t.worktree && t.base_sha ? { adjustableTests: this.adjustable(t.worktree, t.base_sha, t.writes) } : {}),
      // merge-fix：冲突文件里原任务适配过的已有测试不在角色可写范围内，也要能改
      ...(t.kind === 'merge-fix' && t.conflict_files ? { adjustableTests: t.conflict_files.filter((f) => matchesAny(f, TEST_GLOBS)) } : {}),
    };
  }

  private adjustableCache: { key: string; files: string[] } | null = null;

  /** 基线上已有、writes 之外的测试文件；每次工具调用都会用到，按 base_sha 缓存 */
  private adjustable(worktree: string, base: string, writes: readonly string[]): string[] {
    const key = `${base}\0${writes.join('\0')}`;
    if (this.adjustableCache?.key !== key) {
      let files: string[] = [];
      try { files = adjustableTests(worktree, base, writes); } catch { /* 取不到时不放行任何额外文件 */ }
      this.adjustableCache = { key, files };
    }
    return this.adjustableCache.files;
  }

  /**
   * 心跳续租：租约剩余不足一半时延长到"现在 + lease_minutes"。持续调用工具的长任务不会被租约看守误杀；
   * 长时间没有任何工具调用的 run 仍按时过期。续租失败（租约已收回或过期）不影响本次判定，由 flow_* 工具报错。
   */
  async heartbeat(): Promise<boolean> {
    let t: TaskFile;
    try { t = this.task(); } catch { return false; }
    const l = t.lease;
    if (!l || l.run_id !== this.env.run) return false;
    const now = (this.now?.() ?? new Date()).getTime();
    const span = this.config.limits.lease_minutes * 60_000;
    const left = Date.parse(l.expires_at) - now;
    if (left <= 0 || left >= span / 2) return false;
    try {
      await this.store.renewLease(this.env.flow, this.env.task, this.env.run, hashToken(this.env.token), new Date(now + span).toISOString(), `run:${this.env.run}`);
      return true;
    } catch {
      return false;
    }
  }

  async gate(call: ToolCall, cwd: string): Promise<GateResult> {
    await this.heartbeat();
    const r = await enforceToolCall(call, this.guardContext(cwd), this.store, { flow: this.env.flow, task: this.env.task, run: this.env.run });
    if (!r.allow) return { block: true, reason: r.reason, terminate: r.terminate };
    // 只统计被放行的调用：被 guard 拦下的照常计违规
    const sig = `${call.toolName}\u0000${JSON.stringify(call.input ?? null)}`;
    this.repeats = sig === this.lastCall ? this.repeats + 1 : 1;
    this.lastCall = sig;
    if (this.repeats >= REPEAT_LIMIT) {
      const reason = `连续 ${this.repeats} 次执行完全相同的 ${call.toolName} 调用，判定为原地打转，本次运行结束；任务会重新派发。`;
      await this.store.recordEvent({ flow: this.env.flow, task: this.env.task, actor: `run:${this.env.run}`, type: 'note', reason, data: { run: this.env.run, tool: call.toolName } }).catch(() => {});
      return { block: true, reason, terminate: true };
    }
    if (this.repeats >= REPEAT_WARN) {
      return { block: true, terminate: false, reason: `你已连续 ${this.repeats} 次执行完全相同的 ${call.toolName} 调用，结果不会变化。换一个思路（读相关代码、改变输入、缩小问题），或者用 flow_block 说明卡在哪里；再重复 ${REPEAT_LIMIT - this.repeats} 次本次运行会被结束。` };
    }
    return { block: false };
  }

  isFlowTool(name: string): name is SubagentToolName {
    return name in SUBAGENT_TOOLS;
  }

  async callFlowTool(name: SubagentToolName, params: unknown): Promise<ToolResult> {
    const def = SUBAGENT_TOOLS[name];
    if (!Value.Check(def.params, params)) {
      const errs = [...Value.Errors(def.params, params)].map((e) => `${e.instancePath || '/'} ${e.message}`);
      throw new FlowToolError(`${name} 参数不合法：${errs.join('；')}`);
    }
    const ctx = { store: this.store, config: this.config, env: this.env, ...(this.now ? { now: this.now } : {}) };
    return (def.run as (c: typeof ctx, p: unknown) => ToolResult | Promise<ToolResult>)(ctx, params);
  }
}
