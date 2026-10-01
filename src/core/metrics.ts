// 从 pi --mode json 的事件流汇总一次 run 的指标。字段拿不到时记 null，不估算。
import type { RunFile } from './schemas.ts';

type Tokens = RunFile['tokens'];

export interface RunMetrics {
  tokens: Tokens;
  model: string | null;
  turns: number;
  stopReason: string | null;
  error: string | null;
  lastText: string;
}

const KEYS: [keyof Tokens, string][] = [['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite']];

export class UsageAccumulator {
  private tokens: Tokens = { input: null, output: null, cache_read: null, cache_write: null };
  private model: string | null = null;
  private turns = 0;
  private stopReason: string | null = null;
  private error: string | null = null;
  private lastText = '';
  private buf = '';

  /** 喂入原始 stdout 字节（JSONL，按 LF 分帧；不能用 readline，见 Pi docs/json.md） */
  pushChunk(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        this.pushEvent(JSON.parse(line));
      } catch {
        // 非 JSON 行忽略（stdout 保留给 JSONL，理论上不会出现）
      }
    }
  }

  pushEvent(ev: { type?: string; message?: Record<string, unknown> }): void {
    if (ev.type !== 'message_end' || ev.message?.['role'] !== 'assistant') return;
    const m = ev.message as {
      usage?: Record<string, unknown>; provider?: string; model?: string; stopReason?: string; errorMessage?: string;
      content?: { type: string; text?: string }[];
    };
    this.turns++;
    for (const [k, src] of KEYS) {
      const v = m.usage?.[src];
      if (typeof v === 'number' && Number.isFinite(v)) this.tokens[k] = (this.tokens[k] ?? 0) + v;
    }
    if (m.provider && m.model) this.model = `${m.provider}/${m.model}`;
    this.stopReason = m.stopReason ?? null;
    this.error = m.stopReason === 'error' || m.stopReason === 'aborted' ? (m.errorMessage ?? m.stopReason) : null;
    const text = (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
    if (text) this.lastText = text;
  }

  result(): RunMetrics {
    return { tokens: { ...this.tokens }, model: this.model, turns: this.turns, stopReason: this.stopReason, error: this.error, lastText: this.lastText };
  }
}
