// 历史检索（第五轮）：在完整会话历史里检索，包括已被压缩、不在上下文里的部分。
// 数据来自 Pi 的会话文件（JSONL，见 Pi docs/session-format.md）：压缩只追加 compaction 条目，不删除旧条目。
// 本地文本检索，不需要嵌入模型和额外的模型调用；结果确定。纯函数加文件读取，不依赖 Pi。
import { existsSync, readFileSync } from 'node:fs';
import { Type, type Static } from 'typebox';

export const HistoryParams = Type.Object({
  action: Type.Union([Type.Literal('search'), Type.Literal('read')], { description: 'search 用关键词检索；read 按条目编号取回完整内容' }),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'search 的关键词（空格分隔多个词时要求全部出现；中文可以直接写短语）' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: 'search 返回的条数，默认 10' })),
  id: Type.Optional(Type.String({ minLength: 1, description: 'read 的条目编号（search 结果中 # 后面的部分）' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'read 时从第几个字开始（内容很长时分段读取）' })),
}, { additionalProperties: false });
export type HistoryParams = Static<typeof HistoryParams>;

export const HISTORY_DESCRIPTION = '检索本次工作的完整历史会话（包括已被压缩、不在上下文里的部分）：search 用关键词查，返回条目编号与片段；read 按编号取回完整的消息或工具输出。需要找回之前读过的代码、命令输出、做过的决定时使用，不必重新执行。';

export interface HistoryEntry {
  id: string;
  ts: string;
  /** user、assistant、tool:<名称>、summary（压缩摘要）等 */
  kind: string;
  text: string;
}

export const READ_CHUNK = 8000;
const SNIPPET = 120;

/** 读取会话文件为可检索条目；同一条目（fork 复制的会话中 id 相同）只保留一次。缺失或无法解析的行跳过 */
export function loadHistory(files: readonly string[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      const entry = toEntry(e);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

type Block = { type?: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'toolCall') return `[调用 ${c.name ?? '?'}] ${JSON.stringify(c.arguments ?? {})}`;
    return '';
  }).filter(Boolean).join('\n');
}

function toEntry(e: Record<string, unknown>): HistoryEntry | null {
  const id = typeof e['id'] === 'string' ? e['id'] : null;
  if (!id) return null;
  const ts = typeof e['timestamp'] === 'string' ? e['timestamp'] : '';
  if (e['type'] === 'compaction') return { id, ts, kind: 'summary', text: String(e['summary'] ?? '') };
  if (e['type'] === 'custom_message') return { id, ts, kind: `custom:${String(e['customType'] ?? '')}`, text: blocksText(e['content']) };
  if (e['type'] !== 'message') return null;
  const m = e['message'] as { role?: string; content?: unknown; toolName?: string } | undefined;
  if (!m?.role) return null;
  const text = blocksText(m.content);
  if (!text.trim()) return null;
  const kind = m.role === 'toolResult' ? `tool:${m.toolName ?? '?'}` : m.role;
  return { id, ts, kind, text };
}

/** 关键词检索：空格分隔的词全部出现（不区分大小写）；没有全部命中的结果时退回任一命中。按命中次数、再按时间新近排序 */
export function searchHistory(entries: readonly HistoryEntry[], query: string, limit = 10): { entry: HistoryEntry; snippet: string; score: number }[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const score = (text: string, all: boolean) => {
    const low = text.toLowerCase();
    let n = 0;
    for (const t of terms) {
      const c = low.split(t).length - 1;
      if (!c && all) return 0;
      n += c;
    }
    return n;
  };
  const rank = (all: boolean) => entries.map((entry, i) => ({ entry, i, score: score(entry.text, all) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i);
  let hits = rank(true);
  if (!hits.length) hits = rank(false);
  return hits.slice(0, limit).map(({ entry, score: s }) => ({ entry, score: s, snippet: snippet(entry.text, terms) }));
}

function snippet(text: string, terms: readonly string[]): string {
  const low = text.toLowerCase();
  const pos = Math.min(...terms.map((t) => low.indexOf(t)).filter((p) => p >= 0));
  const start = Math.max(0, (Number.isFinite(pos) ? pos : 0) - SNIPPET / 2);
  const s = text.slice(start, start + SNIPPET * 2).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${s}${start + SNIPPET * 2 < text.length ? '…' : ''}`;
}

export function formatSearch(hits: ReturnType<typeof searchHistory>, total: number): string {
  if (!hits.length) return `没有找到（共 ${total} 条历史）。换个关键词，或减少关键词个数。`;
  return [`找到 ${hits.length} 条（共 ${total} 条历史），用 history read 按编号取回完整内容：`,
    ...hits.map(({ entry, snippet: sn }) => `#${entry.id} [${entry.ts.slice(0, 19)} ${entry.kind}] ${sn}`)].join('\n');
}

export function readHistoryEntry(entries: readonly HistoryEntry[], id: string, offset = 0): string {
  const e = entries.find((x) => x.id === id || x.id === id.replace(/^#/, ''));
  if (!e) return `没有编号为 ${id} 的条目。先用 history search 查找。`;
  const end = Math.min(e.text.length, offset + READ_CHUNK);
  const head = `#${e.id} [${e.ts.slice(0, 19)} ${e.kind}]`;
  const range = e.text.length > READ_CHUNK ? `（第 ${offset + 1}–${end} 字，共 ${e.text.length} 字${end < e.text.length ? `；用 offset ${end} 继续` : ''}）` : '';
  return `${head}${range}\n${e.text.slice(offset, end)}`;
}
