// subagent 进程内的运行时：根据 run 环境构造 guard 上下文、拦截工具调用、执行 flow_* 工具。
// pi-adapter 的子进程扩展与测试用 fake-subagent 共用这一实现。
import { Value } from 'typebox/value';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { enforceToolCall, type GuardContext, type ToolCall } from './guard.ts';
import { FlowToolError, SUBAGENT_TOOLS, type RunEnv, type SubagentToolName, type ToolResult } from '../tools/subagent-tools.ts';

export type GateResult = { block: false } | { block: true; reason: string; terminate: boolean };

export class SubagentRuntime {
  readonly env: RunEnv;
  readonly store: StateStore;
  readonly config: FlowConfig;
  private readonly now?: () => Date;

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
      contractsLocked: 'S1' in flow.approvals || 'F1' in flow.approvals,
      ...(role.writes.length ? { writes: t.conflict_files ?? t.writes } : {}),
    };
  }

  async gate(call: ToolCall, cwd: string): Promise<GateResult> {
    const r = await enforceToolCall(call, this.guardContext(cwd), this.store, { flow: this.env.flow, task: this.env.task, run: this.env.run });
    return r.allow ? { block: false } : { block: true, reason: r.reason, terminate: r.terminate };
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
