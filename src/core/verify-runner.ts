// verify-runner：在 worktree 内执行任务的 verify 命令（只能引用 workflow.yaml 的 commands），保存 evidence 并推进状态。
import { spawn } from 'node:child_process';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import type { VerifyResult } from './state-machine.ts';
import { git } from './git.ts';

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
export async function runVerify(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, timeoutMs?: number, opts: { expectFail?: boolean } = {}): Promise<{ passed: boolean; results: CommandRun[]; task: TaskFile }> {
  if (task.status !== 'verifying') throw new Error(`任务 ${task.id} 不在 verifying 状态（当前 ${task.status}）`);
  if (!task.worktree) throw new Error(`任务 ${task.id} 没有 worktree`);
  // 审查前已对同一份代码验证过：直接沿用结果，不重跑
  const pre = precheckOf(store, flowId, task);
  if (pre) {
    const next = await store.transitionTask(flowId, task.id, opts.expectFail
      ? { to: 'done', trigger: 'repro_confirmed', actor: 'verify-runner', facts: { verify_results: pre.results }, evidence: `precheck-a${task.attempts}` }
      : { to: 'queued_merge', trigger: 'verify_pass', actor: 'verify-runner', facts: { verify_results: pre.results }, evidence: `precheck-a${task.attempts}` });
    return { passed: true, results: pre.results.map((r) => ({ ...r, output: '（沿用审查前的验证结果）', duration_ms: 0, timed_out: false })), task: next };
  }
  if (opts.expectFail) return runReproVerify(store, config, flowId, task, timeoutMs);
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

// —— 审查前验证（第三轮 1）——

const headOf = (worktree: string): string | null => {
  try { return `${git(worktree, ['rev-parse', 'HEAD']).trim()}${git(worktree, ['status', '--porcelain']).trim() ? '+dirty' : ''}`; } catch { return null; }
};

/** 本任务对当前代码（HEAD 且工作区干净）、当前尝试次数的审查前验证结果；没有或代码已变时返回 null */
export function precheckOf(store: StateStore, flowId: string, task: TaskFile): { head: string; results: VerifyResult[] } | null {
  if (!task.worktree) return null;
  const ev = [...store.readEvents()].reverse().find((e) => e.flow === flowId && e.task === task.id && e.data?.['precheck']);
  const p = ev?.data?.['precheck'] as { head: string; attempts: number; results: VerifyResult[] } | undefined;
  if (!p || p.attempts !== task.attempts || p.head.endsWith('+dirty') || p.head !== headOf(task.worktree)) return null;
  return { head: p.head, results: p.results };
}

/**
 * 派审查前先跑 verify（任务在 review 状态、没有审查 run）。失败（或要求先失败的测试反而通过）时按 precheck_fail 退回实施；
 * 通过时记下代码版本与结果，审查通过后的 verify 直接沿用。
 */
export async function runPrecheck(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, timeoutMs?: number, opts: { expectFail?: boolean } = {}): Promise<{ passed: boolean; task: TaskFile }> {
  if (task.status !== 'review' || task.lease) throw new Error(`任务 ${task.id} 不能执行审查前验证（${task.status}${task.lease ? '，审查进行中' : ''}）`);
  if (!task.worktree) throw new Error(`任务 ${task.id} 没有 worktree`);
  const head = headOf(task.worktree);
  const fix = store.readFlow(flowId).mode === 'fix';
  const tests = task.verify.filter((c) => TEST_COMMANDS.includes(c));
  const names = opts.expectFail ? (tests.length ? tests : task.verify) : task.verify;
  const results: CommandRun[] = [];
  for (const name of names) {
    const shell = config.commands[name];
    const r = shell === undefined
      ? { command: name, exit_code: 127, output: `命令 ${name} 未在 workflow.yaml 中定义`, duration_ms: 0, timed_out: false }
      : { command: name, ...(await runShell(shell.replace('{files}', '').trim(), task.worktree, timeoutMs)) };
    results.push(r);
    await store.saveEvidence(flowId, task.id, `precheck-a${task.attempts}-${name}.log`, `（审查前验证${opts.expectFail ? '，期望失败' : ''}）\n${evidenceText(r, shell ?? '')}`, 'verify-runner');
    if (!opts.expectFail && r.exit_code !== 0) break;
  }
  const passed = opts.expectFail
    ? results.length > 0 && results.every((r) => r.exit_code !== 0)
    : results.length === names.length && results.every((r) => r.exit_code === 0);
  const plain = results.map(({ command, exit_code }) => ({ command, exit_code }));
  if (passed && head) {
    await store.recordEvent({ flow: flowId, task: task.id, actor: 'verify-runner', type: 'note', reason: `审查前验证通过：${names.join('、') || '（无命令）'}`,
      data: { precheck: { head, attempts: task.attempts, results: plain } } });
    return { passed: true, task: store.readTask(flowId, task.id) };
  }
  if (passed) return { passed: true, task }; // 取不到代码版本：照常审查，审查后再跑 verify
  const label = fix ? '复现测试' : '验收测试';
  const reason = opts.expectFail
    ? `审查前验证：${label}没有失败（${results.filter((r) => r.exit_code === 0).map((r) => r.command).join('、') || '没有 verify 命令'}）：测试必须在${fix ? '修复' : '实现'}之前失败。不要用跳过、条件判断或捕获异常让测试通过`
    : `审查前验证失败：${results.filter((r) => r.exit_code !== 0).map((r) => `${r.command} 退出码 ${r.exit_code}`).join('；')}。输出见 evidence 目录中的 precheck-a${task.attempts}-*.log；修好后再提交`;
  const facts = opts.expectFail
    ? { verify_results: results.length ? results.map((r) => ({ command: `${r.command}（应失败）`, exit_code: r.exit_code === 0 ? 1 : 0 })) : [{ command: '（没有 verify 命令）', exit_code: 1 }], reason }
    : { verify_results: plain, reason };
  if (!results.length) await store.saveEvidence(flowId, task.id, `precheck-a${task.attempts}-none.log`, '本任务没有 verify 命令，无法确认测试先失败。', 'verify-runner');
  const next = await store.transitionTask(flowId, task.id, { to: 'in_progress', trigger: 'precheck_fail', actor: 'verify-runner', facts, evidence: `precheck-a${task.attempts}` });
  return { passed: false, task: next };
}

/** 要求先失败时只运行测试类命令：typecheck、lint 等在实现之前未必失败，不作为判断依据 */
export const TEST_COMMANDS = ['test', 'test_affected', 'e2e'];

/**
 * 测试必须先失败：fix 模式的复现测试（问题被复现），build/feature 模式的先行验收测试（实现尚不存在）。
 * 通过反而说明测试"必然通过"，按 verify_fail 打回。
 */
async function runReproVerify(store: StateStore, config: FlowConfig, flowId: string, task: TaskFile, timeoutMs?: number): Promise<{ passed: boolean; results: CommandRun[]; task: TaskFile }> {
  const fix = store.readFlow(flowId).mode === 'fix';
  const label = fix ? '复现测试' : '验收测试';
  const tests = task.verify.filter((c) => TEST_COMMANDS.includes(c));
  const results: CommandRun[] = [];
  for (const name of tests.length ? tests : task.verify) {
    const shell = config.commands[name] ?? 'false';
    const r = { command: name, ...(await runShell(shell.replace('{files}', '').trim(), task.worktree!, timeoutMs)) };
    results.push(r);
    await store.saveEvidence(flowId, task.id, `repro-a${task.attempts}-${name}.log`, `（期望失败）\n${evidenceText(r, shell)}`, 'verify-runner');
  }
  if (!results.length) await store.saveEvidence(flowId, task.id, `repro-a${task.attempts}-none.log`, '本任务没有 verify 命令，无法确认测试先失败。', 'verify-runner');
  const reproduced = results.length > 0 && results.every((r) => r.exit_code !== 0);
  const why = !results.length ? `${label}没有 verify 命令，无法确认它先失败`
    : fix ? `复现测试没有失败（${results.filter((r) => r.exit_code === 0).map((r) => r.command).join('、')} 通过）：测试必须在修复前失败，请改写测试使其复现问题`
      : `验收测试没有失败（${results.filter((r) => r.exit_code === 0).map((r) => r.command).join('、')} 通过）：实现还不存在，测试必须失败。不要用跳过、条件判断或捕获异常让测试在没有实现时通过`;
  const next = reproduced
    ? await store.transitionTask(flowId, task.id, { to: 'done', trigger: 'repro_confirmed', actor: 'verify-runner',
      facts: { verify_results: results.map(({ command, exit_code }) => ({ command, exit_code })) }, evidence: `repro-a${task.attempts}` })
    : await store.transitionTask(flowId, task.id, { to: 'in_progress', trigger: 'verify_fail', actor: 'verify-runner',
      facts: { verify_results: results.length ? results.map((r) => ({ command: `${r.command}（应失败）`, exit_code: r.exit_code === 0 ? 1 : 0 }))
        : [{ command: '（没有 verify 命令）', exit_code: 1 }], reason: why } });
  return { passed: reproduced, results, task: next };
}
