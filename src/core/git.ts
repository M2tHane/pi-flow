// git 子进程封装：统一身份、遇到 index.lock 等锁冲突时短暂重试。
import { execFileSync } from 'node:child_process';

export const ENGINE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'pi-flow', GIT_AUTHOR_EMAIL: 'pi-flow@localhost',
  GIT_COMMITTER_NAME: 'pi-flow', GIT_COMMITTER_EMAIL: 'pi-flow@localhost',
};

export class GitError extends Error {
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} 失败：${stderr.trim().split('\n').slice(-3).join(' ')}`);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function git(cwd: string, args: string[], opts: { engineIdentity?: boolean; allowFail?: boolean } = {}): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...(opts.engineIdentity ? ENGINE_GIT_ENV : {}), GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { stderr?: string; status?: number };
      const stderr = String(err.stderr ?? '');
      if (/index\.lock|\.lock': File exists|Unable to create .*\.lock/.test(stderr) && attempt < 20) {
        sleep(50 + attempt * 25);
        continue;
      }
      if (opts.allowFail) throw Object.assign(new GitError(args, stderr), { status: err.status });
      throw new GitError(args, stderr);
    }
  }
}

/** 命令以非零退出码表示"否"时使用（如 diff --quiet）。 */
export function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args, { allowFail: true });
    return true;
  } catch {
    return false;
  }
}
