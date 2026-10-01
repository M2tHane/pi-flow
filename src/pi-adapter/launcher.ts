// 用 pi 命令行实现 SubagentLauncher：pi --mode json -p --no-session ...（已在 Pi 0.99.2 实测）。
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

export function buildPiArgs(spec: SubagentSpec): string[] {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
  for (const e of spec.extensions) args.push('-e', e);
  if (spec.model) args.push('--model', spec.model);
  if (spec.thinking) args.push('--thinking', spec.thinking);
  if (spec.tools.length) args.push('--tools', spec.tools.join(','));
  for (const f of spec.appendSystemPromptFiles) args.push('--append-system-prompt', f);
  args.push('--', spec.prompt);
  return args;
}

export class PiLauncher implements SubagentLauncher {
  launch(spec: SubagentSpec): SubagentHandle {
    const inv = piInvocation();
    // stdin 必须关闭：-p 模式下 pi 会读取管道中的 stdin，不关闭会一直等待
    const child = spawn(inv.command, [...inv.prefix, ...buildPiArgs(spec)], {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const acc = new UsageAccumulator();
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => acc.pushChunk(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr = (stderr + c).slice(-STDERR_TAIL); });
    const done = new Promise<RunOutcome>((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null, extra?: string) => {
        if (settled) return;
        settled = true;
        resolve({ ...acc.result(), exitCode, stderrTail: extra ? `${stderr}\n${extra}` : stderr });
      };
      child.on('close', (code) => finish(code));
      child.on('error', (e) => finish(null, String(e)));
    });
    const kill = () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    };
    return { pid: child.pid, done, kill };
  }
}
