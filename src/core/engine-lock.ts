// 引擎锁：同一项目同一时间只允许一个 pi 会话运行引擎（派发、恢复会终止残留进程，不能误杀其他会话的子进程）。
// 锁文件放在 <项目>.worktrees/.engine.lock（不在 .flow/ 内，避免成为未登记文件），内容为 pid 与时间。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { worktreesRoot } from './worktree.ts';
import { processAlive } from './resume.ts';

export const engineLockPath = (root: string) => path.join(worktreesRoot(root), '.engine.lock');

export interface LockHolder { pid: number; since: string }

export function readEngineLock(root: string): LockHolder | null {
  const p = engineLockPath(root);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as LockHolder;
    return typeof j.pid === 'number' ? j : null;
  } catch {
    return null;
  }
}

/** 取得引擎锁；被另一个存活进程持有时返回持有者，否则写入本进程并返回 null。 */
export function acquireEngineLock(root: string, pid = process.pid): LockHolder | null {
  const holder = readEngineLock(root);
  if (holder && holder.pid !== pid && processAlive(holder.pid)) return holder;
  mkdirSync(path.dirname(engineLockPath(root)), { recursive: true });
  writeFileSync(engineLockPath(root), JSON.stringify({ pid, since: new Date().toISOString() }));
  return null;
}

export function releaseEngineLock(root: string, pid = process.pid): void {
  const holder = readEngineLock(root);
  if (holder?.pid === pid) rmSync(engineLockPath(root), { force: true });
}
