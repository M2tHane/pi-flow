// 用 pi 命令行实现 SubagentLauncher（第五轮起用 RPC 模式）：pi --mode rpc --session-dir <留档目录> ...，
// 经 stdin 发送 prompt；运行中可以用 steer 插话（/flow-add）；收到 agent_settled 后关闭 stdin，pi 有序退出。
// 已核实（Pi 1.0.0 docs/rpc.md、rpc-commands.md、json.md）：prompt / steer 命令；事件流与 json 模式相同；关闭 stdin 即请求退出。
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SubagentHandle, SubagentLauncher, SubagentSpec, RunOutcome } from '../core/launcher.ts';
import { UsageAccumulator } from '../core/metrics.ts';

const STDERR_TAIL = 4000;

/** pi 可执行文件：PI_FLOW_PI_BIN 优先；在 pi 进程内时复用当前 node + cli；否则用 PATH 中的 pi */
export function piInvocation(): { command: string; prefix: string[] } {
  const bin = process.env['PI_FLOW_PI_BIN'];
  if (bin) return { command: bin, prefix: [] };
  const script = process.argv[1] ?? '';
  if (/pi-coding-agent[\\/]dist[\\/]cli\.js$/.test(script) || path.basename(script) === 'pi') {
    return { command: process.execPath, prefix: [script] };
  }
  return { command: 'pi', prefix: [] };
}

/** 启动参数（提示不在参数里，经 stdin 的 prompt 命令发送） */
export function buildPiArgs(spec: SubagentSpec): string[] {
  const args = ['--mode', 'rpc', ...(spec.sessionDir ? ['--session-dir', spec.sessionDir, ...(spec.forkFrom ? ['--fork', spec.forkFrom] : [])] : ['--no-session']), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
  for (const e of spec.extensions) args.push('-e', e);
  if (spec.model) args.push('--model', spec.model);
  if (spec.thinking) args.push('--thinking', spec.thinking);
  if (spec.tools.length) args.push('--tools', spec.tools.join(','));
  for (const f of spec.appendSystemPromptFiles) args.push('--append-system-prompt', f);
  return args;
}

export class PiLauncher implements SubagentLauncher {
  launch(spec: SubagentSpec): SubagentHandle {
    const inv = piInvocation();
    const child = spawn(inv.command, [...inv.prefix, ...buildPiArgs(spec)], {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const acc = new UsageAccumulator();
    let stderr = '';
    let open = true;
    let buf = '';
    const send = (cmd: Record<string, unknown>): boolean => {
      if (!open || !child.stdin.writable) return false;
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      return true;
    };
    const close = () => { if (open) { open = false; child.stdin.end(); } };
    child.stdin.on('error', () => { open = false; });
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      acc.pushChunk(c);
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        let ev: { type?: string; command?: string; success?: boolean; error?: string };
        try { ev = JSON.parse(line); } catch { continue; }
        // 运行结束（不会再有自动重试、压缩或排队的消息）：关闭 stdin，pi 有序退出
        if (ev.type === 'agent_settled') close();
        if (ev.type === 'response' && ev.command === 'prompt' && ev.success === false) {
          stderr = `${stderr}\nprompt 被拒绝：${ev.error ?? ''}`.slice(-STDERR_TAIL);
          close();
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr = (stderr + c).slice(-STDERR_TAIL); });
    const done = new Promise<RunOutcome>((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null, extra?: string) => {
        if (settled) return;
        settled = true;
        open = false;
        resolve({ ...acc.result(), exitCode, stderrTail: extra ? `${stderr}\n${extra}` : stderr });
      };
      child.on('close', (code) => finish(code));
      child.on('error', (e) => finish(null, String(e)));
    });
    send({ id: 'prompt-1', type: 'prompt', message: spec.prompt });
    const kill = () => {
      open = false;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    };
    return { pid: child.pid, done, kill, steer: (message) => send({ type: 'steer', message }) };
  }
}
