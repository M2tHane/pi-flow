// 子进程会话留档：pi 以 --session-dir 运行，会话文件（JSONL，见 Pi docs/session-format.md）保存在
// <项目>.worktrees/.sessions/<run>/，不放 .flow/（避免成为未登记文件）。这里负责定位、摘要与按保留期清理。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RunFile } from './schemas.ts';
import { worktreesRoot } from './worktree.ts';

export const DEFAULT_SESSION_RETENTION_DAYS = 14;

export const sessionsRoot = (root: string) => path.join(worktreesRoot(root), '.sessions');
export const sessionDirOf = (root: string, runId: string) => path.join(sessionsRoot(root), runId);

/** 目录中的会话文件（递归找 .jsonl，取最新的一个）；没有时返回 null */
export function findSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

export interface SessionSummary {
  toolCalls: { name: string; args: string; error: string | null }[];
  lastText: string;
  assistantTurns: number;
}

const brief = (v: unknown, n = 120) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? {});
  return (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');
};

/** 读取会话文件：工具调用（名称、参数摘要、出错时的结果）与最后一条 assistant 文本。无法解析的行跳过。 */
export function summarizeSession(file: string): SessionSummary {
  const calls = new Map<string, { name: string; args: string; error: string | null }>();
  const order: string[] = [];
  let lastText = '';
  let turns = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.type === 'message' ? e.message : undefined;
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      turns++;
      const text = m.content.filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('').trim();
      if (text) lastText = text;
      for (const c of m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (c.type !== 'toolCall') continue;
        const id = c.id ?? `#${order.length}`;
        calls.set(id, { name: c.name ?? '?', args: brief(c.arguments), error: null });
        order.push(id);
      }
    } else if (m.role === 'toolResult' && m.isError && m.toolCallId && calls.has(m.toolCallId)) {
      const text = Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? '').join('') : String(m.content ?? '');
      calls.get(m.toolCallId)!.error = brief(text, 200);
    }
  }
  return { toolCalls: order.map((id) => calls.get(id)!), lastText, assistantTurns: turns };
}

export function formatRunDetail(r: RunFile, s: SessionSummary | null, file: string | null): string {
  const head = [
    `run ${r.run_id}：${r.flow ?? '-'}/${r.task ?? '-'}（${r.role}，${r.model ?? '未知模型'}）`,
    `开始 ${r.started_at}，结束 ${r.ended_at ?? '（运行中）'}，结果 ${r.outcome ?? '（无）'}，违规 ${r.violations} 次`,
    `token：输入 ${r.tokens.input ?? '-'}，输出 ${r.tokens.output ?? '-'}，缓存读 ${r.tokens.cache_read ?? '-'}`,
  ];
  if (!file) return [...head, r.session_dir ? `会话记录：没有找到（目录 ${r.session_dir}，可能已被清理）` : '会话记录：这次运行没有留档（早于会话留档功能）'].join('\n');
  if (!s) return [...head, `会话文件：${file}`].join('\n');
  const calls = s.toolCalls.map((c, i) => `${i + 1}. ${c.name} ${c.args}${c.error ? `\n   ✗ ${c.error}` : ''}`);
  return [
    ...head,
    `会话文件：${file}（可用 pi --export <文件> 导出为 HTML）`,
    '',
    `工具调用（${s.toolCalls.length} 次，失败 ${s.toolCalls.filter((c) => c.error).length} 次）：`,
    ...(calls.length > 40 ? [...calls.slice(0, 10), `…（省略 ${calls.length - 30} 次）`, ...calls.slice(-20)] : calls),
    '',
    `最后的回复：${s.lastText ? brief(s.lastText, 1500) : '（无）'}`,
  ].join('\n');
}

/**
 * 按保留期清理会话留档：已结束且结束时间早于保留期的 run；以及没有 run 记录、修改时间早于保留期的目录。
 * 运行中的 run 不清理。返回被删除的 run 目录名。
 */
export function cleanupSessions(root: string, runs: readonly RunFile[], retentionDays: number, now: Date, dryRun: boolean): string[] {
  const dir = sessionsRoot(root);
  if (!existsSync(dir)) return [];
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const r = byId.get(name);
    const old = r ? !!r.ended_at && Date.parse(r.ended_at) < cutoff : statSync(path.join(dir, name)).mtimeMs < cutoff;
    if (!old) continue;
    if (!dryRun) rmSync(path.join(dir, name), { recursive: true, force: true });
    out.push(name);
  }
  return out;
}
