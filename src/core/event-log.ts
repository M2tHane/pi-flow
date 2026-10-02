// 事件日志：events.jsonl 追加、哈希链、状态提交。
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * 只读事件日志的最后一条（从文件尾部反向读取），用于每次事务前校验 state.json 与日志末尾一致。
 * 读取量与事件总数无关；完整的哈希链校验只在 resume 与 doctor（verifyIntegrity）中做。
 */
export function readLastEvent(file: string): { event: FlowEvent | null; error: string | null } {
  if (!existsSync(file)) return { event: null, error: null };
  const size = statSync(file).size;
  if (!size) return { event: null, error: null };
  const fd = openSync(file, 'r');
  try {
    let chunk = 4096;
    for (;;) {
      const len = Math.min(chunk, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString('utf8').replace(/\n+$/, '');
      const nl = text.lastIndexOf('\n');
      if (nl < 0 && len < size) { chunk *= 4; continue; }
      const line = nl < 0 ? text : text.slice(nl + 1);
      if (!line.trim()) return { event: null, error: null };
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return { event: null, error: 'events.jsonl 最后一行不是合法 JSON' }; }
      const errs = validate('event', parsed);
      if (errs.length) return { event: null, error: `events.jsonl 最后一行：${errs.join('；')}` };
      const ev = parsed as FlowEvent;
      if (hashEvent(ev) !== ev.hash) return { event: ev, error: `事件 seq ${ev.seq}：内容哈希不符，可能被篡改` };
      return { event: ev, error: null };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 增量读取事件日志：事件日志只追加，缓存已解析的事件与字节偏移，之后只解析新增部分；文件变短（被截断或替换）时整体重读。
 */
export class EventCache {
  private size = 0;
  private events: FlowEvent[] = [];
  private errors: string[] = [];
  private ino = -1;

  read(file: string): { events: FlowEvent[]; errors: string[] } {
    if (!existsSync(file)) { this.reset(); return { events: [], errors: [] }; }
    const st = statSync(file);
    if (st.ino !== this.ino || st.size < this.size) this.reset();
    this.ino = st.ino;
    if (st.size > this.size) {
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - this.size);
        readSync(fd, buf, 0, buf.length, this.size);
        const text = buf.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end >= 0) {
          const base = this.events.length + this.errors.length;
          text.slice(0, end).split('\n').forEach((line, i) => {
            if (!line.trim()) return;
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { this.errors.push(`events.jsonl 第 ${base + i + 1} 行不是合法 JSON`); return; }
            const errs = validate('event', parsed);
            if (errs.length) this.errors.push(`events.jsonl 第 ${base + i + 1} 行：${errs.join('；')}`);
            else this.events.push(parsed as FlowEvent);
          });
          this.size += Buffer.byteLength(text.slice(0, end + 1));
        }
      } finally {
        closeSync(fd);
      }
    }
    return { events: this.events.slice(), errors: this.errors.slice() };
  }

  private reset(): void {
    this.size = 0; this.events = []; this.errors = []; this.ino = -1;
  }
}

export function appendEvents(file: string, events: readonly FlowEvent[]): void {
  if (!events.length) return;
  appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export const STATE_REF = 'refs/pi-flow/state';

/**
 * 把 .flow/ 的当前内容提交到专用引用 refs/pi-flow/state（不进入任何分支的历史）：用独立的索引文件，
 * read-tree 上一次的状态提交 → add .flow → write-tree → commit-tree → update-ref（带旧值，CAS）。
 * 调用方必须持有 .flow/ 的文件锁（事务内），否则并发提交可能失败。无改动返回 null。
 */
const commonDirs = new Map<string, string>();
/** 仓库的公共 git 目录（所有 worktree 共享），按根目录缓存 */
function commonDir(root: string): string {
  let d = commonDirs.get(root);
  if (!d) {
    const c = git(root, ['rev-parse', '--git-common-dir']).trim();
    d = path.isAbsolute(c) ? c : path.resolve(root, c);
    commonDirs.set(root, d);
  }
  return d;
}

export function commitStateRef(root: string, dir: string, message: string): string | null {
  const common = commonDir(root);
  const index = path.join(common, 'pi-flow-state.index');
  const marker = `${index}.head`;
  const env = { GIT_INDEX_FILE: index };
  // 这个索引与引用只有 pi-flow 在持有 .flow/ 文件锁时使用：残留的 .lock 一定来自被强杀的进程，直接清除
  rmSync(`${index}.lock`, { force: true });
  rmSync(path.join(common, `${STATE_REF}.lock`), { force: true });
  // 读引用：通常是松散引用文件；被 gc 打包后退回 rev-parse
  const loose = path.join(common, STATE_REF);
  const parent = existsSync(loose) ? readFileSync(loose, 'utf8').trim()
    : gitOk(root, ['rev-parse', '--verify', '-q', `${STATE_REF}^{commit}`]) ? git(root, ['rev-parse', STATE_REF]).trim() : null;
  // 索引已对应上一次的状态提交时不必 read-tree（每个事务少起一个 git 进程）
  const indexHead = existsSync(marker) && existsSync(index) ? readFileSync(marker, 'utf8').trim() : '';
  if (indexHead !== (parent ?? '')) git(root, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
  // .flow/ 在主工作区被排除（info/exclude），需要 -f；锁、事务日志、临时文件不提交
  git(root, ['add', '-A', '-f', '--', dir, `:(exclude)${dir}/.lock`, `:(exclude)${dir}/.lock/**`, `:(exclude)${dir}/tx.json`, `:(exclude,glob)${dir}/**/*.tmp`], { env });
  const tree = git(root, ['write-tree'], { env }).trim();
  const sha = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `${STATE_COMMIT_PREFIX} ${message}`], { engineIdentity: true }).trim();
  git(root, ['update-ref', STATE_REF, sha, ...(parent ? [parent] : ['0'.repeat(40)])]);
  writeFileSync(marker, `${sha}\n`);
  return sha;
}

/**
 * 迁移：早期版本把 .flow/ 提交在当前分支上。一次性把它移出分支（git rm --cached，单独提交），
 * 并写入仓库本地的 info/exclude，之后状态只提交到 refs/pi-flow/state。返回是否做了迁移。
 */
export function untrackStateDir(root: string, dir: string): boolean {
  const exclude = path.join(commonDir(root), 'info', 'exclude');
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes(`/${dir}/`)) {
    appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# pi-flow：状态目录只提交到 ${STATE_REF}\n/${dir}/\n`);
  }
  if (!git(root, ['ls-files', '--', dir]).trim()) return false;
  // 用临时索引从 HEAD 构造"删除 .flow/"的提交，不带上用户已暂存的其他改动（git commit -- <路径> 会重新读取工作区，不能用）
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'pi-flow-migrate.index']).trim());
  const env = { GIT_INDEX_FILE: index };
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['read-tree', head], { env });
  git(root, ['rm', '-r', '-q', '-f', '--cached', '--', dir], { env });
  const tree = git(root, ['write-tree'], { env }).trim();
  const sha = git(root, ['commit-tree', tree, '-p', head, '-m', `pi-flow: 状态目录 ${dir}/ 移出分支历史（之后提交到 ${STATE_REF}）`], { engineIdentity: true }).trim();
  git(root, ['update-ref', '-m', 'pi-flow: 状态目录移出分支历史', 'HEAD', sha, head]);
  git(root, ['rm', '-r', '-q', '-f', '--cached', '--', dir]);
  return true;
}

/** 只提交给定路径的改动（不影响用户已暂存的其他文件）；无改动返回 null，否则返回提交 sha。 */
export function gitCommitPaths(root: string, paths: readonly string[], message: string): string | null {
  git(root, ['add', '-A', '--', ...paths]);
  if (gitOk(root, ['diff', '--cached', '--quiet', '--', ...paths])) return null;
  git(root, ['commit', '-q', '--no-verify', '-m', `${STATE_COMMIT_PREFIX} ${message}`, '--', ...paths], { engineIdentity: true });
  return git(root, ['rev-parse', 'HEAD']).trim();
}
