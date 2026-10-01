// 子进程中的 pi-flow 扩展：由 dispatcher 用 -e 最后加载（guard 必须最后执行）。
// 只在 PI_FLOW_* 环境变量齐全时生效：注册本角色可用的 flow_* 工具、收窄启用的工具、拦截所有工具调用。
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../core/config.ts';
import { StateStore } from '../core/state-store.ts';
import { SubagentRuntime } from '../core/subagent-runtime.ts';
import { SUBAGENT_TOOLS, runEnvFrom, type SubagentToolName } from '../tools/subagent-tools.ts';

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

  pi.on('session_start', () => {
    const registered = new Set(pi.getAllTools().map((t) => t.name));
    pi.setActiveTools([...allowed].filter((t) => registered.has(t)));
  });

  pi.on('tool_call', async (event, ctx) => {
    const g = await rt.gate({ toolName: event.toolName, input: event.input }, ctx.cwd);
    if (!g.block) return;
    if (g.terminate) setTimeout(() => ctx.shutdown(), 0);
    return { block: true, reason: g.reason, ...(g.terminate ? { terminate: true } : {}) };
  });
}
