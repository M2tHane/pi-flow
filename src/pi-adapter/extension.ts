// pi-flow 的 Pi 扩展入口。所有 Pi API 调用集中在 src/pi-adapter/，业务逻辑在 src/core 与 src/commands。
import { existsSync } from 'node:fs';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { loadConfig, type FlowConfig } from '../core/config.ts';
import { ROLE_SETTINGS_FILENAME } from '../core/role-settings.ts';
import { THINKING_LEVELS, type ThinkingLevel } from '../core/schemas.ts';
import { runFlowConfig, type ModelOption } from '../commands/flow-config.ts';
import { loadRoleSettings } from '../core/role-settings.ts';
import { StateStore } from '../core/state-store.ts';
import { Engine } from '../core/dispatcher.ts';
import { splitArgs } from '../commands/args.ts';
import { PiLauncher } from './launcher.ts';
import { affectedTests, codegraphSync } from '../core/codegraph.ts';
import { DispatchParams, WaitParams, activeFlowId, flowDispatch, flowWait, statusText } from '../tools/orchestrator-tools.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_WORKFLOW = path.join(PACKAGE_ROOT, 'templates', 'workflow.yaml');
const SUBAGENT_EXTENSION = path.join(PACKAGE_ROOT, 'src', 'pi-adapter', 'subagent.ts');

/** 每个项目根一个引擎（在 orchestrator 所在的 pi 进程内） */
const engines = new Map<string, { store: StateStore; engine: Engine }>();

export function engineFor(root: string, onError?: (e: unknown) => void): { store: StateStore; engine: Engine } {
  const hit = engines.get(root);
  if (hit) return hit;
  if (!existsSync(path.join(root, '.flow', 'state.json'))) throw new Error('当前项目尚未初始化 pi-flow（缺少 .flow/），请先执行 /flow init（M5 实现）。');
  const config = loadConfig(path.join(root, 'workflow.yaml'));
  const store = new StateStore(root, { limits: config.limits });
  const extra = (process.env['PI_FLOW_EXTRA_EXTENSIONS'] ?? '').split(',').filter(Boolean);
  const engine = new Engine({
    root, store, config, launcher: new PiLauncher(),
    roleSettings: () => loadRoleSettings(roleSettingsPath()),
    packageAgentsDir: path.join(PACKAGE_ROOT, 'agents'),
    subagentExtension: SUBAGENT_EXTENSION,
    extraExtensions: () => extra,
    mergeHooks: { affectedFiles: (_wt, changed) => affectedTests(root, changed), afterMerge: codegraphSync },
    ...(onError ? { onError } : {}),
  });
  const entry = { store, engine };
  engines.set(root, entry);
  return entry;
}

/** 用户级设置文件：~/.pi/agent/pi-flow.json（与 Pi 官方 preset 示例的全局配置位置一致） */
export function roleSettingsPath(): string {
  return path.join(getAgentDir(), ROLE_SETTINGS_FILENAME);
}

/** 项目有 workflow.yaml 时用项目配置，否则用模板（用于在初始化前也能设置角色）。 */
export function loadProjectConfig(cwd: string): { config: FlowConfig; source: string } {
  const project = path.join(cwd, 'workflow.yaml');
  const file = existsSync(project) ? project : TEMPLATE_WORKFLOW;
  return { config: loadConfig(file), source: file };
}

export function availableModels(ctx: ExtensionContext): ModelOption[] {
  return ctx.modelRegistry.getAvailable().map((m) => {
    let levels: ThinkingLevel[];
    try {
      levels = getSupportedThinkingLevels(m).filter((l): l is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(l));
    } catch {
      levels = m.reasoning ? [...THINKING_LEVELS] : ['off'];
    }
    return { ref: `${m.provider}/${m.id}`, name: m.name, levels: levels.length ? levels : ['off'] };
  });
}

function report(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  // json/rpc 模式的 stdout 保留给事件流
  else if (ctx.mode === 'json' || ctx.mode === 'rpc') process.stderr.write(`${message}\n`);
  else process.stdout.write(`${message}\n`);
}

const toolResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text }], details });

function checked<T>(schema: unknown, params: unknown, name: string): T {
  if (!Value.Check(schema as never, params)) throw new Error(`${name} 参数不合法：${[...Value.Errors(schema as never, params)].map((e) => `${e.instancePath || '/'} ${e.message}`).join('；')}`);
  return params as T;
}

export default function piFlow(pi: ExtensionAPI): void {
  // orchestrator 工具只在已初始化 pi-flow 的项目中注册，避免影响普通 pi 会话
  if (existsSync(path.join(process.cwd(), '.flow', 'state.json'))) {
    pi.registerTool({
      name: 'flow_status', label: 'flow_status', description: '只读：当前流程、阶段、任务计数、可派发与失败任务摘要、等待用户处理的事项。',
      parameters: Type.Object({}),
      async execute(_id, _p, _s, _u, ctx) {
        const { store, engine } = engineFor(ctx.cwd);
        return toolResult(statusText(store, engine, activeFlowId(store)));
      },
    });
    pi.registerTool({
      name: 'flow_dispatch', label: 'flow_dispatch', description: '把一个 ready 任务交给对应角色的 subagent（角色、模型、规则由程序决定）。立即返回 run_id，不等待完成。',
      parameters: DispatchParams,
      async execute(_id, p, _s, _u, ctx) {
        const { store, engine } = engineFor(ctx.cwd);
        const r = await flowDispatch(store, engine, checked(DispatchParams, p, 'flow_dispatch'));
        return toolResult(r.text, r.details);
      },
    });
    pi.registerTool({
      name: 'flow_wait', label: 'flow_wait', description: '等待任务状态变化或超时，返回精简摘要（不含 subagent 的对话）。',
      parameters: WaitParams,
      async execute(_id, p, _s, _u, ctx) {
        const { store, engine } = engineFor(ctx.cwd);
        const r = await flowWait(store, engine, checked(WaitParams, p, 'flow_wait'));
        return toolResult(r.text, r.details);
      },
    });
  }

  pi.registerCommand('flow', {
    description: 'pi-flow 管理：status、next（其余子命令在后续里程碑实现）',
    getArgumentCompletions: (prefix) => ['status', 'next'].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      try {
        const [sub] = splitArgs(args);
        const { store, engine } = engineFor(ctx.cwd, (e) => report(ctx, `pi-flow 程序步骤出错：${(e as Error).message}`, 'warning'));
        const flowId = activeFlowId(store);
        if (!sub || sub === 'status') return report(ctx, statusText(store, engine, flowId));
        if (sub === 'next') {
          const d = await engine.next(flowId);
          if (!d.length) return report(ctx, `没有可派发的任务。\n${statusText(store, engine, flowId)}`);
          report(ctx, `已派发：${d.map((x) => `${x.task} → ${x.role}（${x.model}，run ${x.run_id}）`).join('；')}`);
          // 非交互模式下进程会在命令结束后退出，因此等待所有运行与程序步骤完成
          if (!ctx.hasUI) {
            await engine.idle();
            report(ctx, statusText(store, engine, flowId));
          }
          return;
        }
        report(ctx, `子命令 ${sub} 尚未实现（approve、unblock、resume、doctor、init 在 M5/M6 实现）。`, 'warning');
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('flow-config', {
    description: 'pi-flow 配置：为各角色设置模型与思考级别（effort）',
    getArgumentCompletions: (prefix) => {
      const subs = ['show', 'models', 'set', 'unset', 'help'];
      return subs.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      try {
        const { config } = loadProjectConfig(ctx.cwd);
        const ui = ctx.hasUI ? { select: (t: string, o: string[]) => ctx.ui.select(t, o), notify: (m: string, l?: 'info' | 'warning' | 'error') => ctx.ui.notify(m, l) } : null;
        const msg = await runFlowConfig(args, { ui, models: availableModels(ctx), config, settingsPath: roleSettingsPath() });
        report(ctx, msg);
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });
}
