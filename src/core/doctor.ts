// /flow doctor：状态完整性与前置条件检查；--fix 只做安全的清理（不改状态）。
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import { git } from './git.ts';
import { worktreesRoot, removeWorktree } from './worktree.ts';
import { processAlive } from './resume.ts';
import { preflight, formatPreflight, type PreflightDeps } from './preflight.ts';
import { readEngineLock } from './engine-lock.ts';
import { IN_FLIGHT } from './state-machine.ts';

export interface DoctorReport { errors: string[]; warnings: string[]; fixed: string[]; preflight: string }

export async function doctor(root: string, store: StateStore, opts: { fix?: boolean; preflight?: Omit<PreflightDeps, 'root'>; now?: () => Date } = {}): Promise<DoctorReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fixed: string[] = [];
  const now = (opts.now ?? (() => new Date()))().getTime();

  if (!existsSync(path.join(root, '.flow', 'state.json'))) {
    return { errors: ['尚未初始化：执行 /flow init'], warnings, fixed, preflight: formatPreflight(preflight({ root, ...opts.preflight })) };
  }
  if (existsSync(path.join(root, '.flow', 'tx.json'))) warnings.push('存在未完成的事务日志 tx.json：执行 /flow resume 重放');
  const integrity = await store.verifyIntegrity();
  errors.push(...integrity.errors.filter((e) => !e.includes('tx.json')).map((e) => `完整性：${e}`));

  const lock = readEngineLock(root);
  if (lock && lock.pid !== process.pid) {
    if (processAlive(lock.pid)) warnings.push(`另一个 pi 会话（pid ${lock.pid}）正在运行引擎`);
    else warnings.push(`引擎锁属于已退出的进程 ${lock.pid}，下次 /flow resume 会接管`);
  }

  const flowIds = store.listFlows();
  const referenced = new Set<string>();
  for (const flowId of flowIds) {
    for (const t of store.listTasks(flowId)) {
      if (t.worktree) referenced.add(real(t.worktree));
      if (IN_FLIGHT.includes(t.status) && t.status !== 'merging' && t.worktree && !existsSync(t.worktree)) {
        errors.push(`${flowId}/${t.id}（${t.status}）的 worktree 不存在：${t.worktree}`);
      }
      if (t.lease && now >= Date.parse(t.lease.expires_at)) warnings.push(`${flowId}/${t.id} 的租约已过期（run ${t.lease.run_id}）：执行 /flow resume`);
    }
  }

  const mq = store.readMergeQueue();
  for (const e of mq.queue) {
    const t = safeTask(store, e.flow, e.task);
    if (t?.status !== 'queued_merge') errors.push(`合并队列中的 ${e.flow}/${e.task} 状态是 ${t?.status ?? '不存在'}，应为 queued_merge`);
  }
  if (mq.merging) {
    const t = safeTask(store, mq.merging.flow, mq.merging.task);
    if (t?.status !== 'merging') errors.push(`合并名额被 ${mq.merging.task} 占用，但其状态是 ${t?.status ?? '不存在'}`);
    else warnings.push(`${mq.merging.task} 正在合并；如果没有会话在运行，执行 /flow resume 回滚到队首`);
  }
  for (const s of mq.suspended ?? []) {
    if (safeTask(store, s.flow, s.task)?.status !== 'merging') errors.push(`挂起的合并 ${s.task} 状态不是 merging`);
    if (!safeTask(store, s.flow, s.merge_fix)) errors.push(`挂起的合并 ${s.task} 引用的 merge-fix ${s.merge_fix} 不存在`);
  }
  for (const flowId of flowIds) {
    for (const t of store.listTasks(flowId)) {
      if (t.status === 'queued_merge' && !mq.queue.some((e) => e.flow === flowId && e.task === t.id)) errors.push(`${flowId}/${t.id} 是 queued_merge 但不在合并队列中`);
    }
  }

  for (const r of store.listRuns()) {
    if (!r.ended_at && r.pid && processAlive(r.pid) && !(lock && processAlive(lock.pid))) {
      warnings.push(`残留子进程：run ${r.run_id}（pid ${r.pid}），执行 /flow resume 清理`);
    }
  }

  // 未被任何任务引用的 worktree
  const wtRoot = real(worktreesRoot(root));
  const listed = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)));
  for (const w of listed.filter((w) => w.startsWith(wtRoot + path.sep) && !referenced.has(w))) {
    if (opts.fix) {
      removeWorktree(root, w);
      fixed.push(`删除未被引用的 worktree ${w}`);
    } else {
      warnings.push(`未被任何任务引用的 worktree：${w}（/flow doctor --fix 清理）`);
    }
  }
  // 已结束 run 的提示文件
  const runsDir = path.join(wtRoot, '.runs');
  if (existsSync(runsDir)) {
    const ended = new Set(store.listRuns().filter((r) => r.ended_at).map((r) => r.run_id));
    const stale = readdirSync(runsDir).filter((d) => ended.has(d) || !store.listRuns().some((r) => r.run_id === d));
    if (stale.length) {
      if (opts.fix) {
        for (const d of stale) rmSync(path.join(runsDir, d), { recursive: true, force: true });
        fixed.push(`清理 ${stale.length} 个已结束 run 的提示文件`);
      } else {
        warnings.push(`${stale.length} 个已结束 run 的提示文件可清理（/flow doctor --fix）`);
      }
    }
  }
  if (opts.fix) git(root, ['worktree', 'prune']);

  return { errors, warnings, fixed, preflight: formatPreflight(preflight({ root, ...opts.preflight })) };
}

/** 解析符号链接（macOS 的 /var → /private/var）；不存在的路径解析其最近存在的祖先 */
function real(p: string): string {
  const abs = path.resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(real(parent), path.basename(abs));
}

function safeTask(store: StateStore, flow: string, task: string) {
  try { return store.readTask(flow, task); } catch { return null; }
}

export function formatDoctor(r: DoctorReport): string {
  return [
    r.errors.length ? `错误：\n${r.errors.map((e) => `  ✗ ${e}`).join('\n')}` : '状态完整性：正常',
    r.warnings.length ? `提醒：\n${r.warnings.map((e) => `  ! ${e}`).join('\n')}` : '',
    r.fixed.length ? `已修复：\n${r.fixed.map((e) => `  ✓ ${e}`).join('\n')}` : '',
    `前置条件：\n${r.preflight.split('\n').map((l) => `  ${l}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}
