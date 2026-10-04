// 子进程启动接口：dispatcher 组装 SubagentSpec，pi-adapter 用 pi 命令行实现，测试用 fake-subagent 实现。
import type { ThinkingLevel } from './schemas.ts';
import type { RunMetrics } from './metrics.ts';

export interface RunOutcome extends RunMetrics {
  exitCode: number | null;
  /** stderr 末尾，用于失败诊断 */
  stderrTail: string;
}

/** 子进程规格：dispatcher 组装，launcher 转成 pi 命令行 */
export interface SubagentSpec {
  cwd: string;
  /** provider/id；null 时不传 --model（由 Pi 默认决定，dispatcher 应先报错） */
  model: string | null;
  thinking: ThinkingLevel | null;
  /** 精确启用的工具（--tools） */
  tools: string[];
  /** 要加载的扩展，按顺序；guard 扩展必须在最后（--no-extensions + -e ...） */
  extensions: string[];
  /** 追加系统提示文件（--append-system-prompt <file>，可多个；稳定内容在前） */
  appendSystemPromptFiles: string[];
  prompt: string;
  /** run token 等，只经环境变量传递 */
  env: Record<string, string>;
  /** 会话留档目录（--session-dir）；不给时以 --no-session 运行 */
  sessionDir?: string;
  /** 从这个会话文件复制出新会话继续（--fork，需同时给 sessionDir）：返工时接着上一次的对话 */
  forkFrom?: string;
}

export interface SubagentHandle {
  readonly pid: number | undefined;
  /** 结束后的汇总：按每条 assistant message_end 的 usage 累加；模型取最后一条的 provider/model */
  done: Promise<RunOutcome>;
  kill(): void;
  /** 运行中插话（第五轮 /flow-add）：在当前回合的工具调用结束后、下一次调用模型前送达；子进程已结束或不支持时返回 false */
  steer?(message: string): boolean;
}

/** 子进程启动（第五轮起：pi --mode rpc --session-dir <留档目录> ...，经 stdin 发送提示与插话） */
export interface SubagentLauncher {
  launch(spec: SubagentSpec): SubagentHandle;
}

