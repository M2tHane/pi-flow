// pi-flow 的 Pi 扩展入口。所有 Pi API 调用集中在 src/pi-adapter/，业务逻辑在 src/core、src/commands、src/tools。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { loadConfig, type FlowConfig } from '../core/config.ts';
import { ROLE_SETTINGS_FILENAME, loadRoleSettings } from '../core/role-settings.ts';
import { THINKING_LEVELS, type ThinkingLevel } from '../core/schemas.ts';
import { StateStore } from '../core/state-store.ts';
import { Engine } from '../core/dispatcher.ts';
import { affectedTests, codegraphSync } from '../core/codegraph.ts';
import { acquireEngineLock, releaseEngineLock } from '../core/engine-lock.ts';
import { enforceToolCall } from '../core/guard.ts';
import { dirtyFiles, newDrift, nextStep, turnContext } from '../core/context-injector.ts';
import { parseAgentFile } from '../core/agents.ts';
import { runFlowConfig, type ModelOption } from '../commands/flow-config.ts';
import { runFlowCommand, runFlowBuild, runFlowFix, FLOW_USAGE, type CommandEnv, type EngineHandle } from '../commands/flow.ts';
import { DispatchParams, WaitParams, activeFlowId, flowDispatch, flowWait, statusText } from '../tools/orchestrator-tools.ts';
import { PiLauncher } from './launcher.ts';
import { lastFailureKind, notices, snapshotOf } from '../core/status-view.ts';
import { packageRoots, pluginExtensionsFor } from './plugins.ts';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_WORKFLOW = path.join(PACKAGE_ROOT, 'templates', 'workflow.yaml');
const SUBAGENT_EXTENSION = path.join(PACKAGE_ROOT, 'src', 'pi-adapter', 'subagent.ts');
const ORCHESTRATOR_TOOLS = ['flow_status', 'flow_dispatch', 'flow_wait'];

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

// —— 每个项目根一份会话状态（引擎运行在本 pi 进程内） ——

interface RootSession {
  handle: EngineHandle | null;
  orchestrator: boolean;
  driftBefore: Set<string> | null;
  notify: (m: string, l?: 'info' | 'warning' | 'error') => void;
}
const sessions = new Map<string, RootSession>();

function session(root: string): RootSession {
  let s = sessions.get(root);
  if (!s) {
    s = { handle: null, orchestrator: false, driftBefore: null, notify: () => {} };
    sessions.set(root, s);
  }
  return s;
}

const initialized = (root: string) => existsSync(path.join(root, '.flow', 'state.json'));

export function engineFor(root: string): EngineHandle {
  const s = session(root);
  if (s.handle) return s.handle;
  if (!initialized(root)) throw new Error('当前项目尚未初始化 pi-flow（缺少 .flow/），请先执行 /flow init。');
  const holder = acquireEngineLock(root);
  if (holder) throw new Error(`另一个 pi 会话（pid ${holder.pid}，自 ${holder.since}）正在运行该项目的流程。请在那个会话中操作，或关闭它后再执行 /flow resume。`);
  const config = loadConfig(path.join(root, 'workflow.yaml'));
  const store = new StateStore(root, { limits: config.limits });
  const extra = (process.env['PI_FLOW_EXTRA_EXTENSIONS'] ?? '').split(',').filter(Boolean);
  const engine = new Engine({
    root, store, config, launcher: new PiLauncher(),
    roleSettings: () => loadRoleSettings(roleSettingsPath()),
    packageAgentsDir: path.join(PACKAGE_ROOT, 'agents'),
    subagentExtension: SUBAGENT_EXTENSION,
    // 测试用的额外扩展（假模型 provider）在前，随后是第三方插件；guard 所在的 subagent 扩展由引擎放在最后
    extraExtensions: (role) => [...extra, ...pluginExtensionsFor(config, role, packageRoots(root, getAgentDir())).paths],
    packageSkillsDir: path.join(PACKAGE_ROOT, 'skills'),
    mergeHooks: { affectedFiles: (_wt, changed) => affectedTests(root, changed), afterMerge: codegraphSync },
    onError: (e) => s.notify(`pi-flow 程序步骤出错：${(e as Error).message}`, 'warning'),
  });
  s.handle = { store, engine, config };
  // 主动通知只在进入新阶段、出现需要你处理的事、任务首次失败重试时出现
  let prev = snapshotOf(store, config);
  engine.onChange(() => {
    try {
      const next = snapshotOf(store, config);
      for (const n of notices(prev, next, (f, t) => lastFailureKind(store, f, t))) s.notify(n, n.includes('需要你处理') ? 'warning' : 'info');
      prev = next;
    } catch { /* 通知失败不影响流程 */ }
  });
  return s.handle;
}

function orchestratorPrompt(root: string): string {
  const project = path.join(root, '.pi', 'agents', 'orchestrator.md');
  const file = existsSync(project) ? project : path.join(PACKAGE_ROOT, 'agents', 'orchestrator.md');
  return parseAgentFile(readFileSync(file, 'utf8'), file).prompt;
}

export default function piFlow(pi: ExtensionAPI): void {
  const commandEnv = (ctx: ExtensionContext): CommandEnv => {
    const root = ctx.cwd;
    const s = session(root);
    s.notify = (m, l) => report(ctx, m, l);
    return {
      root, packageRoot: PACKAGE_ROOT,
      ui: ctx.hasUI ? { select: (t, o) => ctx.ui.select(t, o), input: (t, p) => ctx.ui.input(t, p), notify: (m, l) => ctx.ui.notify(m, l) } : null,
      engine: () => engineFor(root),
      store: () => s.handle?.store ?? new StateStore(root),
      roleSettings: () => loadRoleSettings(roleSettingsPath()),
      availableModels: () => availableModels(ctx).map((m) => m.ref),
      activateOrchestrator: () => {
        s.orchestrator = true;
        const registered = new Set(pi.getAllTools().map((t) => t.name));
        const config = engineFor(root).config;
        pi.setActiveTools(config.activeTools('orchestrator').filter((t) => registered.has(t)));
      },
      waitForIdle: !ctx.hasUI,
    };
  };

  // orchestrator 工具只在已初始化 pi-flow 的项目中注册，避免影响普通 pi 会话
  if (initialized(process.cwd())) {
    pi.registerTool({
      name: 'flow_status', label: 'flow_status', description: '只读：当前流程、阶段、任务计数、可派发与失败任务摘要、等待用户处理的事项。',
      parameters: Type.Object({}),
      async execute(_id, _p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        return toolResult(statusText(h.store, h.engine, activeFlowId(h.store)));
      },
    });
    pi.registerTool({
      name: 'flow_dispatch', label: 'flow_dispatch', description: '把一个 ready 任务交给对应角色的 subagent（角色、模型、规则由程序决定）。立即返回 run_id，不等待完成。',
      parameters: DispatchParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowDispatch(h.store, h.engine, checked(DispatchParams, p, 'flow_dispatch'));
        return toolResult(r.text, r.details);
      },
    });
    pi.registerTool({
      name: 'flow_wait', label: 'flow_wait', description: '等待任务状态变化或超时，返回精简摘要（不含 subagent 的对话）。',
      parameters: WaitParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowWait(h.store, h.engine, checked(WaitParams, p, 'flow_wait'));
        return toolResult(r.text, r.details);
      },
    });
  }

  pi.on('session_start', (_e, ctx) => {
    if (!initialized(ctx.cwd)) return;
    try {
      const flow = new StateStore(ctx.cwd).readState().active_flow;
      if (flow) report(ctx, `pi-flow：检测到进行中的流程 ${flow}。执行 /flow resume 恢复并进入调度模式；/flow status 查看进度。`);
    } catch (e) {
      report(ctx, `pi-flow：读取状态失败（${(e as Error).message}），请执行 /flow doctor。`, 'warning');
    }
  });

  // 调度模式：每轮注入状态与唯一允许的下一步，并记录轮开始时主工作区的改动
  pi.on('before_agent_start', (event, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle) return;
    const { store, engine, config } = s.handle;
    s.driftBefore = dirtyFiles(ctx.cwd);
    const injected = `${orchestratorPrompt(ctx.cwd)}\n\n${turnContext(store, config.limits.max_parallel, engine.activeRuns().length)}`;
    event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ''}\n\n${injected}`.trim();
  });

  // 主工作区在本轮期间出现 .flow/ 之外的新改动：视为越权（第 20 节第 6 条）
  pi.on('agent_end', async (_e, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle || !s.driftBefore) return;
    const drift = newDrift(s.driftBefore, dirtyFiles(ctx.cwd));
    s.driftBefore = null;
    if (!drift.length) return;
    const flow = s.handle.store.readState().active_flow;
    await s.handle.store.recordEvent({ flow, actor: 'orchestrator', type: 'violation', reason: `本轮期间主工作区出现改动：${drift.slice(0, 20).join('、')}`, data: { run: 'orchestrator', role: 'orchestrator', rule: 'main_workspace_drift', files: drift.slice(0, 50) } });
    report(ctx, `pi-flow：本轮期间主工作区出现了未经派发的改动（${drift.slice(0, 5).join('、')}${drift.length > 5 ? ' 等' : ''}），已记录为越权。如果是你本人修改的，可以忽略。`, 'warning');
  });

  // 调度模式下的 guard：orchestrator 只能读 docs/、.flow/，只能用 flow_status、flow_dispatch、flow_wait
  pi.on('tool_call', async (event, ctx) => {
    const s = sessions.get(ctx.cwd);
    if (!s?.orchestrator || !s.handle) return;
    const { store, config } = s.handle;
    const step = nextStep(store, config.limits.max_parallel);
    const r = await enforceToolCall({ toolName: event.toolName, input: event.input }, {
      config, role: 'orchestrator', cwd: ctx.cwd, workspaceRoot: ctx.cwd, mainRoot: ctx.cwd,
      contractsLocked: true, ...(step.task ? { readyTaskId: step.task } : {}),
    }, store, { flow: store.readState().active_flow, task: null, run: 'orchestrator' });
    if (r.allow) return;
    return { block: true, reason: r.reason };
  });

  pi.on('session_shutdown', (_e, ctx) => {
    if (sessions.get(ctx.cwd)?.handle) releaseEngineLock(ctx.cwd);
  });

  pi.registerCommand('flow', {
    description: 'pi-flow 管理：status、next、resume、approve、reject、unblock、gate、doctor、init',
    getArgumentCompletions: (prefix) => ['status', 'next', 'resume', 'approve', 'reject', 'unblock', 'gate', 'abort', 'doctor', 'init', 'help']
      .filter((x) => x.startsWith(prefix.trim())).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowCommand(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, `${(e as Error).message}${/未知子命令/.test((e as Error).message) ? '' : `\n${FLOW_USAGE.split('\n')[0]} /flow help`}`, 'error');
      }
    },
  });

  pi.registerCommand('flow-build', {
    description: 'pi-flow：从零建新项目，或 --feature 在已有项目上加功能',
    getArgumentCompletions: (prefix) => (prefix.trim() === '' || '--feature'.startsWith(prefix.trim()) ? [{ value: '--feature', label: '--feature' }] : null),
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowBuild(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('flow-fix', {
    description: 'pi-flow：修复缺陷或小改动（scout 定位 → 复现测试 → 修复 → 审查 → 直接合入主分支）',
    handler: async (args, ctx) => {
      try {
        report(ctx, await runFlowFix(args, commandEnv(ctx)));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });

  pi.registerCommand('flow-config', {
    description: 'pi-flow 配置：为各角色设置模型与思考级别（effort）',
    getArgumentCompletions: (prefix) => ['show', 'models', 'set', 'unset', 'help']
      .filter((x) => x.startsWith(prefix.trim())).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      try {
        const { config } = loadProjectConfig(ctx.cwd);
        const ui = ctx.hasUI ? { select: (t: string, o: string[]) => ctx.ui.select(t, o), notify: (m: string, l?: 'info' | 'warning' | 'error') => ctx.ui.notify(m, l) } : null;
        report(ctx, await runFlowConfig(args, { ui, models: availableModels(ctx), config, settingsPath: roleSettingsPath() }));
      } catch (e) {
        report(ctx, (e as Error).message, 'error');
      }
    },
  });
}

export { ORCHESTRATOR_TOOLS };
