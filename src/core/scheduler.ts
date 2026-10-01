// 调度：选哪个任务、并行几个由程序决定（第 11 节第 8 条）。纯函数。
import type { TaskFile } from './schemas.ts';
import { conflictsWith, remainingPath } from './dag.ts';
import { IN_FLIGHT } from './state-machine.ts';

/** 从 ready 中按关键路径优先挑选可派发的任务：不与在途任务互斥、彼此不互斥、总运行数不超过 maxParallel。 */
export function selectDispatchable(tasks: readonly TaskFile[], stage: string, maxParallel: number): string[] {
  const priority = remainingPath(tasks);
  const inflight = tasks.filter((t) => IN_FLIGHT.includes(t.status));
  let capacity = maxParallel - tasks.filter((t) => t.status === 'in_progress').length;
  const ready = tasks.filter((t) => t.status === 'ready' && t.stage === stage)
    .sort((a, b) => (priority.get(b.id)! - priority.get(a.id)!) || a.id.localeCompare(b.id));
  const picked: TaskFile[] = [];
  for (const t of ready) {
    if (capacity <= 0) break;
    // merge-fix 任务不与它所修复的（挂起中的）原任务互斥
    if (inflight.some((x) => x.id !== t.merge_fix_for && conflictsWith(x, t)) || picked.some((x) => conflictsWith(x, t))) continue;
    picked.push(t);
    capacity--;
  }
  return picked.map((t) => t.id);
}
