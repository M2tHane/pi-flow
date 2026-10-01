// fake-subagent：实现 SubagentLauncher，用脚本代替模型调用工具。
// 每次调用都经过真实的 SubagentRuntime（guard + flow_* 工具）；内置工具在 worktree 中真实执行。
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SubagentHandle, SubagentLauncher, SubagentSpec, RunOutcome } from '../../../src/core/launcher.ts';
import type { StateStore } from '../../../src/core/state-store.ts';
import type { FlowConfig } from '../../../src/core/config.ts';
import { SubagentRuntime } from '../../../src/core/subagent-runtime.ts';
import { runEnvFrom, type RunEnv } from '../../../src/tools/subagent-tools.ts';

export class Terminated extends Error {}

export interface CallResult { ok: boolean; text: string }

export interface FakeAgent {
  spec: SubagentSpec;
  env: RunEnv;
  call(tool: string, input?: Record<string, unknown>): Promise<CallResult>;
  /** 用篡改过的环境（例如伪造 token）调用 flow_* 工具 */
  callAs(env: Partial<RunEnv>, tool: string, input?: Record<string, unknown>): Promise<CallResult>;
}

export type Script = (a: FakeAgent) => Promise<void>;

export class FakeLauncher implements SubagentLauncher {
  readonly launched: SubagentSpec[] = [];
  readonly transcripts: { role: string; calls: { tool: string; ok: boolean; text: string }[] }[] = [];
  private readonly store: StateStore;
  private readonly config: FlowConfig;
  private readonly pick: (spec: SubagentSpec, nth: number) => Script;

  constructor(store: StateStore, config: FlowConfig, pick: (spec: SubagentSpec, nth: number) => Script) {
    this.store = store;
    this.config = config;
    this.pick = pick;
  }

  launch(spec: SubagentSpec): SubagentHandle {
    this.launched.push(spec);
    const env = runEnvFrom(spec.env);
    if (!env) throw new Error('缺少 PI_FLOW_* 环境变量');
    const nth = this.launched.filter((s) => s.env['PI_FLOW_TASK'] === env.task && s.env['PI_FLOW_ROLE'] === env.role).length;
    const transcript = { role: env.role, calls: [] as { tool: string; ok: boolean; text: string }[] };
    this.transcripts.push(transcript);
    let terminated = false;
    let calls = 0;

    const exec = async (rt: SubagentRuntime, tool: string, input: Record<string, unknown>): Promise<CallResult> => {
      if (terminated) throw new Terminated();
      if (!spec.tools.includes(tool)) return { ok: false, text: `工具 ${tool} 未启用` };
      const g = await rt.gate({ toolName: tool, input }, spec.cwd);
      if (g.block) {
        if (g.terminate) { terminated = true; throw new Terminated(g.reason); }
        return { ok: false, text: g.reason };
      }
      calls++;
      try {
        if (rt.isFlowTool(tool)) return { ok: true, text: (await rt.callFlowTool(tool, input)).text };
        const p = typeof input['path'] === 'string' ? path.resolve(spec.cwd, input['path']) : '';
        switch (tool) {
          case 'write':
            mkdirSync(path.dirname(p), { recursive: true });
            writeFileSync(p, String(input['content'] ?? ''));
            return { ok: true, text: `Successfully wrote to ${input['path']}` };
          case 'read':
            return { ok: true, text: readFileSync(p, 'utf8') };
          case 'edit': {
            let s = readFileSync(p, 'utf8');
            for (const e of input['edits'] as { oldText: string; newText: string }[]) s = s.replace(e.oldText, e.newText);
            writeFileSync(p, s);
            return { ok: true, text: 'edited' };
          }
          case 'bash':
            return { ok: true, text: execSync(String(input['command']), { cwd: spec.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
          default:
            return { ok: true, text: `（fake）${tool}` };
        }
      } catch (e) {
        return { ok: false, text: (e as Error).message };
      }
    };

    const rt = new SubagentRuntime(env, this.store, this.config);
    const agent: FakeAgent = {
      spec, env,
      call: async (tool, input = {}) => {
        const r = await exec(rt, tool, input);
        transcript.calls.push({ tool, ...r });
        return r;
      },
      callAs: async (override, tool, input = {}) => {
        const r = await exec(new SubagentRuntime({ ...env, ...override }, this.store, this.config), tool, input);
        transcript.calls.push({ tool: `${tool}(伪造)`, ...r });
        return r;
      },
    };
    const script = this.pick(spec, nth);
    const outcome = (exitCode: number, error: string | null): RunOutcome => ({
      exitCode, stderrTail: '', error, model: spec.model, turns: calls,
      tokens: { input: 100 * (calls + 1), output: 10 * (calls + 1), cache_read: 50 * calls, cache_write: 0 },
      stopReason: error ? 'error' : 'stop', lastText: '',
    });
    // 异步执行：dispatch 立即返回，与真实子进程一致
    const done = new Promise<void>((r) => setImmediate(r)).then(() => script(agent)).then(
      () => outcome(0, null),
      (e) => outcome(1, e instanceof Terminated ? '被 guard 终止' : String(e)),
    );
    return { pid: undefined, done, kill: () => { terminated = true; } };
  }
}
