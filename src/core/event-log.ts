// 事件日志：events.jsonl 追加、哈希链、状态提交。
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { git, gitOk } from './git.ts';
import { validate, type FlowEvent } from './schemas.ts';

export const GENESIS_HASH = '0'.repeat(64);
export const STATE_COMMIT_PREFIX = 'flow-state:';

/** 键排序后的 JSON，保证哈希与键顺序无关。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function hashEvent(ev: Omit<FlowEvent, 'hash'>): string {
  const { hash: _ignored, ...rest } = ev as FlowEvent;
  return sha256(canonicalJson(rest));
}

export type EventInput = Omit<FlowEvent, 'seq' | 'prev_hash' | 'hash'>;

export function buildEvent(prev: Pick<FlowEvent, 'seq' | 'hash'> | null, input: EventInput): FlowEvent {
  const body = { ...input, seq: (prev?.seq ?? 0) + 1, prev_hash: prev?.hash ?? GENESIS_HASH };
  return { ...body, hash: hashEvent(body) };
}

export interface ChainCheck {
  errors: string[];
  head: string;
  lastSeq: number;
}

export function verifyChain(events: readonly FlowEvent[]): ChainCheck {
  const errors: string[] = [];
  let prevHash = GENESIS_HASH;
  let expectSeq = 1;
  for (const ev of events) {
    if (ev.seq !== expectSeq) errors.push(`事件 seq ${ev.seq}：序号不连续，期望 ${expectSeq}`);
    if (ev.prev_hash !== prevHash) errors.push(`事件 seq ${ev.seq}：prev_hash 与上一条不符`);
    if (hashEvent(ev) !== ev.hash) errors.push(`事件 seq ${ev.seq}：内容哈希不符，可能被篡改`);
    prevHash = ev.hash;
    expectSeq = ev.seq + 1;
  }
  return { errors, head: events.at(-1)?.hash ?? GENESIS_HASH, lastSeq: events.at(-1)?.seq ?? 0 };
}

export function readEvents(file: string): { events: FlowEvent[]; errors: string[] } {
  if (!existsSync(file)) return { events: [], errors: [] };
  const events: FlowEvent[] = [];
  const errors: string[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`events.jsonl 第 ${i + 1} 行不是合法 JSON`);
      return;
    }
    const errs = validate('event', parsed);
    if (errs.length) errors.push(`events.jsonl 第 ${i + 1} 行：${errs.join('；')}`);
    else events.push(parsed as FlowEvent);
  });
  return { events, errors };
}

export function appendEvents(file: string, events: readonly FlowEvent[]): void {
  if (!events.length) return;
  appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** 只提交给定路径的改动（不影响用户已暂存的其他文件）；无改动返回 null，否则返回提交 sha。 */
export function gitCommitPaths(root: string, paths: readonly string[], message: string): string | null {
  git(root, ['add', '-A', '--', ...paths]);
  if (gitOk(root, ['diff', '--cached', '--quiet', '--', ...paths])) return null;
  git(root, ['commit', '-q', '--no-verify', '-m', `${STATE_COMMIT_PREFIX} ${message}`, '--', ...paths], { engineIdentity: true });
  return git(root, ['rev-parse', 'HEAD']).trim();
}
