// pi-adapter 接口草案（M0 产出）：core 与 commands 只依赖这些接口，由 src/pi-adapter/ 用 Pi API 实现。
// 每个接口后注明对应的、已在 Pi 0.99.2 上实测或读源码核实的能力，详见 NOTES.md 的 API 矩阵。

import type { ThinkingLevel } from '../core/schemas.ts';
import type { ToolCall } from '../core/guard.ts';

/** 交互 UI（ctx.ui.select/confirm/input/notify；RPC 模式经 extension_ui_request 转发；print/json 模式无 UI） */
export interface UiPort {
  readonly available: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

/** 模型目录（ctx.modelRegistry.getAvailable() + pi-ai getSupportedThinkingLevels） */
export interface ModelCatalog {
  list(): { ref: string; name: string; levels: ThinkingLevel[] }[];
}

/** 工具拦截（pi.on('tool_call') 返回 {block, reason}；handler 抛错也会阻断）。guard 扩展必须最后加载。 */
export type ToolGate = (call: ToolCall) => Promise<{ block: false } | { block: true; reason: string; terminate: boolean }>;

/** 会话注入（before_agent_start 修改 systemPromptOptions.appendSystemPrompt；session_start 中 setActiveTools） */
export interface SessionHooks {
  setActiveTools(names: string[]): void;
  /** 每轮开始前追加到系统提示的内容（context-injector 的"状态摘要与唯一允许的下一步"） */
  onBeforeTurn(provider: () => string): void;
}

export type { SubagentSpec, SubagentHandle, SubagentLauncher, RunOutcome } from '../core/launcher.ts';

/** 用户级配置目录（getAgentDir()，默认 ~/.pi/agent，可由 PI_CODING_AGENT_DIR 覆盖） */
export interface PiPaths {
  agentDir(): string;
}
