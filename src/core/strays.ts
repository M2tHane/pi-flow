// 残留进程清理（第四轮后续）：子进程结束后，结束工作目录仍在任务 worktree 或临时目录里的进程。
// 真实冒烟：模型把死循环的测试放到后台跑，外层结束后 node 进程留下来，一个个占满 CPU。
// 用 lsof 查每个进程的工作目录（macOS 与 Linux 都有）；没有 lsof 时什么也不做。
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** 工作目录在这些目录（含子目录）中的进程 pid；不含本进程 */
export function processesIn(dirs: readonly string[]): number[] {
  const roots = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  if (!roots.length) return [];
  let out: string;
  try {
    out = execFileSync('lsof', ['-n', '-w', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  } catch (e) {
    // lsof 有进程无权查看时也会以非零退出，但标准输出仍然可用
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const pids: number[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && pid !== process.pid) {
      const cwd = line.slice(1);
      if (roots.some((r) => cwd === r || cwd.startsWith(r + path.sep))) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** 结束这些目录里的残留进程，返回被结束的 pid */
export function killStrays(dirs: readonly string[]): number[] {
  const pids = processesIn(dirs);
  for (const p of pids) {
    try { process.kill(p, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  return pids;
}
