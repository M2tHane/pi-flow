// verify-runner：在 worktree 内执行任务的 verify 命令（只能引用 workflow.yaml 的 commands），保存 evidence 并推进状态。
import { spawn } from 'node:child_process';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import type { VerifyResult } from './state-machine.ts';

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

/**
 * 对 verifying 状态的任务执行 verify，保存 evidence，转到 queued_merge 或 in_progress（失败达上限则 blocked）。
 * 遇到第一个失败的命令即停止。
 */
export async function runVerify(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, timeoutMs?: number): Promise<{ passed: boolean; results: CommandRun[]; task: TaskFile }> {
  if (task.status !== 'verifying') throw new Error(`任务 ${task.id} 不在 verifying 状态（当前 ${task.status}）`);
  if (!task.worktree) throw new Error(`任务 ${task.id} 没有 worktree`);
  const results: CommandRun[] = [];
  if (!task.verify.length) {
    await store.saveEvidence(flowId, task.id, `verify-a${task.attempts}-none.log`, '本任务没有 verify 命令。', 'verify-runner');
  }
  for (const name of task.verify) {
    const shell = config.commands[name];
    if (shell === undefined) {
      results.push({ command: name, exit_code: 127, output: `命令 ${name} 未在 workflow.yaml 中定义`, duration_ms: 0, timed_out: false });
      break;
    }
    const r = { command: name, ...(await runShell(shell.replace('{files}', '').trim(), task.worktree, timeoutMs)) };
    results.push(r);
    await store.saveEvidence(flowId, task.id, `verify-a${task.attempts}-${name}.log`, evidenceText(r, shell), 'verify-runner');
    if (r.exit_code !== 0) break;
  }
  const passed = results.length === task.verify.length && results.every((r) => r.exit_code === 0);
  const verify_results = results.map(({ command, exit_code }) => ({ command, exit_code }));
  const next = await store.transitionTask(flowId, task.id, passed
    ? { to: 'queued_merge', trigger: 'verify_pass', actor: 'verify-runner', facts: { verify_results }, evidence: `verify-a${task.attempts}` }
    : { to: 'in_progress', trigger: 'verify_fail', actor: 'verify-runner', facts: { verify_results }, evidence: `verify-a${task.attempts}` });
  return { passed, results, task: next };
}
