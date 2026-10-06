// subagent 工具共用的部分：run 环境、工具上下文、错误类型、run token 与租约校验。
import type { FlowConfig } from '../core/config.ts';
import { StateError, type StateStore } from '../core/state-store.ts';
import { hashToken } from '../core/state-machine.ts';
import type { TaskFile } from '../core/schemas.ts';

export interface RunEnv {
  root: string;
  flow: string;
  task: string;
  run: string;
  token: string;
  role: string;
}

export const RUN_ENV_KEYS = {
  root: 'PI_FLOW_ROOT', flow: 'PI_FLOW_FLOW', task: 'PI_FLOW_TASK', run: 'PI_FLOW_RUN', token: 'PI_FLOW_RUN_TOKEN', role: 'PI_FLOW_ROLE',
} as const;

export function runEnvFrom(env: NodeJS.ProcessEnv | Record<string, string | undefined>): RunEnv | null {
  const out: Partial<RunEnv> = {};
  for (const [k, v] of Object.entries(RUN_ENV_KEYS)) {
    const val = env[v];
    if (!val) return null;
    out[k as keyof RunEnv] = val;
  }
  return out as RunEnv;
}

export interface ToolContext {
  store: StateStore;
  config: FlowConfig;
  env: RunEnv;
  now?: () => Date;
}

export interface ToolResult { text: string; details?: Record<string, unknown> }

export class FlowToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowToolError';
  }
}

export const actor = (ctx: ToolContext) => `run:${ctx.env.run}`;

/** 校验 run token 与租约；返回当前任务 */
export function checkRun(ctx: ToolContext): TaskFile {
  let task: TaskFile;
  try {
    task = ctx.store.readTask(ctx.env.flow, ctx.env.task);
  } catch {
    throw new FlowToolError(`任务 ${ctx.env.flow}/${ctx.env.task} 不存在。本次运行无效，请停止工作。`);
  }
  const lease = task.lease;
  if (!lease || lease.run_id !== ctx.env.run || hashToken(ctx.env.token) !== lease.token_hash) {
    throw new FlowToolError('run token 无效或租约已被收回：本次运行已失效，请停止工作，不要再调用任何工具。');
  }
  if ((ctx.now?.() ?? new Date()).getTime() >= Date.parse(lease.expires_at)) {
    throw new FlowToolError('租约已过期：请停止工作，由用户执行 /flow-resume 处理。');
  }
  return task;
}

export function rethrow(e: unknown, hint: string): never {
  if (e instanceof StateError) throw new FlowToolError(`${e.message}\n建议：${hint}`);
  throw e;
}

export const checkRunOf = checkRun;
