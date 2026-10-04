// 子进程中的 pi-flow 扩展：由 dispatcher 用 -e 最后加载（guard 必须最后执行）。
// 只在 PI_FLOW_* 环境变量齐全时生效：注册本角色可用的 flow_* 工具、收窄启用的工具、拦截所有工具调用。
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../core/config.ts';
import { StateStore } from '../core/state-store.ts';
import { SubagentRuntime } from '../core/subagent-runtime.ts';
import { SUBAGENT_TOOLS, runEnvFrom, type SubagentToolName } from '../tools/subagent-tools.ts';
import { MISSING_TOOLS_REASON } from '../core/dependencies.ts';
import { notesContextMessage } from '../core/notes.ts';
import { taskNotesRel } from '../core/state-store.ts';
import { installMemory } from './memory.ts';

/** 子进程 bash 命令的超时上限（秒），workflow.yaml 的 limits.bash_timeout_s，默认 300 */
export const DEFAULT_BASH_TIMEOUT_S = 300;
export const bashTimeoutS = (config: { limits: { bash_timeout_s?: number } }) => config.limits.bash_timeout_s ?? DEFAULT_BASH_TIMEOUT_S;

/** 没给超时或超过上限时改成上限 */
export function applyBashTimeout(input: Record<string, unknown>, maxS: number): void {
  const t = input['timeout'];
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > maxS) input['timeout'] = maxS;
}

export default function piFlowSubagent(pi: ExtensionAPI): void {
  const env = runEnvFrom(process.env);
  if (!env) return;
  const config = loadConfig(path.join(env.root, 'workflow.yaml'));
  const store = new StateStore(env.root, { limits: config.limits });
  const rt = new SubagentRuntime(env, store, config);
  const allowed = new Set(rt.activeTools());

  for (const [name, def] of Object.entries(SUBAGENT_TOOLS) as [SubagentToolName, (typeof SUBAGENT_TOOLS)[SubagentToolName]][]) {
    if (!allowed.has(name)) continue;
    pi.registerTool({
      name, label: name, description: def.description, parameters: def.params,
      async execute(_id, params) {
        const r = await rt.callFlowTool(name, params);
        return { content: [{ type: 'text', text: r.text }], details: r.details ?? {} };
      },
    });
  }

  // 结构化笔记放回上下文、按阈值压缩（第五轮）
  installMemory(pi, {
    active: () => true,
    notesMessage: (_ctx, near) => notesContextMessage(store.readNotes(taskNotesRel(env.flow, env.task)), { title: `任务 ${env.task} 的笔记`, nearCompaction: near }),
    compactAt: () => config.compactAt,
  });

  pi.on('session_start', async () => {
    const registered = new Set(pi.getAllTools().map((t) => t.name));
    pi.setActiveTools([...allowed].filter((t) => registered.has(t)));
    // 角色配置了但没有注册的工具：插件未安装、版本不符或改了工具名。记一条事件，/flow doctor 会提示
    const missing = [...allowed].filter((t) => !registered.has(t));
    if (missing.length) {
      await store.recordEvent({ flow: env.flow, task: env.task, actor: `run:${env.run}`, type: 'note', reason: MISSING_TOOLS_REASON,
        data: { run: env.run, role: env.role, tools: missing } }).catch(() => {});
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    const g = await rt.gate({ toolName: event.toolName, input: event.input }, ctx.cwd);
    if (!g.block) {
      // bash 命令一律有超时（秒）：挂起的测试、没关的服务器不会把整个任务卡住（Pi 1.0.0：event.input 可原地修改）
      if (event.toolName === 'bash') applyBashTimeout(event.input as Record<string, unknown>, bashTimeoutS(config));
      return;
    }
    if (g.terminate) setTimeout(() => ctx.shutdown(), 0);
    return { block: true, reason: g.reason, ...(g.terminate ? { terminate: true } : {}) };
  });
}
