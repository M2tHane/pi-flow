// 运行 workflow.yaml 中的命令（合并后验证与阶段闸门共用）：清理过的环境、超时、输出截断与 evidence 文本。
import { spawn } from 'node:child_process';

export interface VerifyResult { command: string; exit_code: number }

const OUTPUT_LIMIT = 64 * 1024;
export const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;

export interface CommandRun extends VerifyResult { output: string; duration_ms: number; timed_out: boolean }

/** 子进程环境：去掉 run token 等 pi-flow 内部变量 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('PI_FLOW_')) delete env[k];
  return env;
}

export function runShell(command: string, cwd: string, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS): Promise<Omit<CommandRun, 'command'>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: scrubbedEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const take = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit_code: timedOut ? 124 : (code ?? 1), output: out, duration_ms: Date.now() - started, timed_out: timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exit_code: 127, output: String(e), duration_ms: Date.now() - started, timed_out: false });
    });
  });
}

export function evidenceText(r: CommandRun, shell: string): string {
  return [`命令：${r.command}`, `实际执行：${shell}`, `退出码：${r.exit_code}${r.timed_out ? '（超时）' : ''}`, `耗时：${r.duration_ms} ms`, '', r.output].join('\n');
}
