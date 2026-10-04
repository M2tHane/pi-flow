// 结构化笔记放回上下文与按阈值压缩（第五轮），子进程扩展与主会话扩展共用。
// 已核实（Pi 1.0.0 dist/core/extensions/types.d.ts）：context 事件可替换 messages；custom 消息转换给模型时变成 user 消息；
// ctx.getContextUsage() 给出占比；ctx.compact() 触发压缩但不等待；session_compact / session_compact_failed 报告结果。
import type { CustomAgentMessage, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const NOTES_MESSAGE_TYPE = 'pi-flow-notes';
/** 离压缩阈值还差这么多个百分点时提醒先更新笔记 */
export const REMIND_MARGIN = 10;

export interface MemoryHooks {
  /** 是否作用于这个上下文（主会话只在已初始化的项目中生效） */
  active(ctx: ExtensionContext): boolean;
  /** 放回上下文的笔记消息；null 表示不放 */
  notesMessage(ctx: ExtensionContext, nearCompaction: boolean): string | null;
  /** 触发压缩的上下文占比（0–1） */
  compactAt(ctx: ExtensionContext): number;
}

const percentOf = (ctx: ExtensionContext): number | null => {
  try { return ctx.getContextUsage()?.percent ?? null; } catch { return null; }
};

export function installMemory(pi: ExtensionAPI, hooks: MemoryHooks): void {
  let compacting = false;

  // 每次调用模型前把笔记放在消息末尾：不改动系统提示与之前的消息，提示缓存只在末尾失效
  pi.on('context', (event, ctx) => {
    if (!hooks.active(ctx)) return;
    const pct = percentOf(ctx);
    const near = pct !== null && pct >= hooks.compactAt(ctx) * 100 - REMIND_MARGIN;
    let text: string | null;
    try { text = hooks.notesMessage(ctx, near); } catch { return; }
    if (!text) return;
    const msg: CustomAgentMessage = { role: 'custom', customType: NOTES_MESSAGE_TYPE, content: text, display: false, timestamp: Date.now() };
    return { messages: [...event.messages, msg] };
  });

  // 回合结束时检查上下文占用，超过阈值就压缩（Pi 自己的阈值是窗口减去 reserveTokens，通常更晚）
  pi.on('turn_end', (_e, ctx) => {
    if (compacting || !hooks.active(ctx)) return;
    const pct = percentOf(ctx);
    if (pct === null || pct < hooks.compactAt(ctx) * 100) return;
    compacting = true;
    ctx.compact({
      customInstructions: '摘要只需保留最近的工作脉络；目标、已完成、待完成、决策与踩过的坑已在笔记中，压缩后会原样放回上下文，之前的细节可以用 history 检索。',
      onComplete: () => { compacting = false; },
      onError: () => { compacting = false; },
    });
  });
  pi.on('session_compact', () => { compacting = false; });
  pi.on('session_compact_failed', () => { compacting = false; });
}
