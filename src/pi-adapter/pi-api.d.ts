// pi-flow 用到的 Pi API 的最小类型声明，摘自 @earendil-works/pi-coding-agent 0.99.2 与 pi-ai 的 .d.ts（已核实；1.0.0 中这些类型未变）。
// 运行时由 Pi（jiti）提供这些模块；只有 src/pi-adapter/ 可以引用它们。Pi 升级后需对照 NOTES.md 重新核实。
declare module '@earendil-works/pi-coding-agent' {
  export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  export interface PiModel { provider: string; id: string; name: string; reasoning: boolean }
  export interface ModelRegistry {
    getAll(): PiModel[];
    getAvailable(): PiModel[];
    find(provider: string, modelId: string): PiModel | undefined;
  }
  export interface ExtensionUIContext {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    /** 页脚状态栏文字；undefined 清除（只在终端界面显示） */
    setStatus(key: string, text: string | undefined): void;
  }
  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    mode: 'tui' | 'rpc' | 'json' | 'print';
    cwd: string;
    modelRegistry: ModelRegistry;
    /** 当前模型（可能未设置） */
    model: PiModel | undefined;
    shutdown(): void;
  }
  export interface TextContent { type: 'text'; text: string }
  export interface AgentToolResult { content: TextContent[]; details: unknown }
  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    /** false 时注册后不激活（需 setActiveTools 激活） */
    defaultActive?: boolean;
    execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult>;
  }
  export interface BeforeAgentStartEvent {
    type: 'before_agent_start';
    prompt: string;
    readonly systemPrompt: string;
    /** 可变：后续 handler 看到修改；appendSystemPrompt 会追加到系统提示 */
    systemPromptOptions: { appendSystemPrompt?: string; [k: string]: unknown };
  }
  export interface ToolCallEvent { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  export interface ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean }
  export interface AutocompleteItem { value: string; label: string; description?: string }
  export interface RegisteredCommandOptions {
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  }
  export interface ExtensionAPI {
    registerCommand(name: string, options: RegisteredCommandOptions): void;
    registerTool(tool: ToolDefinition): void;
    getAllTools(): { name: string }[];
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
    /** 设置本会话模型（不改默认配置）；该 provider 没有配置凭据时返回 false */
    setModel(model: PiModel): Promise<boolean>;
    getThinkingLevel(): ThinkingLevel;
    /** 以用户身份发送消息，总会触发一轮 */
    sendUserMessage(content: string): void;
    /** 设置本会话思考级别（按模型能力收窄） */
    setThinkingLevel(level: ThinkingLevel): void;
    on(event: 'session_start' | 'session_shutdown' | 'agent_end', handler: (event: unknown, ctx: ExtensionContext) => unknown): () => void;
    on(event: 'before_agent_start', handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown): () => void;
    on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void): () => void;
  }
  export function getAgentDir(): string;
  export const CONFIG_DIR_NAME: string;
}

declare module '@earendil-works/pi-ai' {
  import type { PiModel, ThinkingLevel } from '@earendil-works/pi-coding-agent';
  export function getSupportedThinkingLevels(model: PiModel): ThinkingLevel[];
}
