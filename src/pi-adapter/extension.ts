// pi-flow 的 Pi 扩展入口。所有 Pi API 调用集中在 src/pi-adapter/，业务逻辑在 src/core、src/commands、src/tools。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext, type PiModel } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { loadConfig, type FlowConfig } from '../core/config.ts';
import { ROLE_SETTINGS_FILENAME, loadRoleSettings, resolveRoleModel } from '../core/role-settings.ts';
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
import { activeBrief, interviewContext, updateBrief, CONFIRM_COMMAND, type InterviewMode } from '../modes/interview.ts';
import { DispatchParams, ReplanParams, WaitParams, activeFlowId, flowDispatch, flowReplan, flowWait, statusText } from '../tools/orchestrator-tools.ts';
import { PiLauncher } from './launcher.ts';
import { lastFailureKind, notices, snapshotOf, statusLine, visibleFlows } from '../core/status-view.ts';
import { packageRoots, pluginExtensionsFor } from './plugins.ts';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_WORKFLOW = path.join(PACKAGE_ROOT, 'templates', 'workflow.yaml');
const SUBAGENT_EXTENSION = path.join(PACKAGE_ROOT, 'src', 'pi-adapter', 'subagent.ts');
const ORCHESTRATOR_TOOLS = ['flow_status', 'flow_dispatch', 'flow_wait', 'flow_replan'];

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

interface SavedSession { model: PiModel | undefined; thinking: ThinkingLevel; tools: string[] }

interface RootSession {
  handle: EngineHandle | null;
  orchestrator: boolean;
  driftBefore: Set<string> | null;
  notify: (m: string, l?: 'info' | 'warning' | 'error') => void;
  /** 进入调度模式前的模型、思考级别与工具，用于退出时恢复 */
  saved: SavedSession | null;
  /** 退出调度模式（由最近一次命令的上下文提供） */
  deactivate: (() => Promise<string>) | null;
  /** 需求访谈模式（开流程之前） */
  interview: InterviewMode | null;
  /** 调度模式下的状态栏（只在终端界面设置）；null 表示不显示 */
  status: ((text: string | undefined) => void) | null;
}
const sessions = new Map<string, RootSession>();

function session(root: string): RootSession {
  let s = sessions.get(root);
  if (!s) {
    s = { handle: null, orchestrator: false, driftBefore: null, notify: () => {}, saved: null, deactivate: null, interview: null, status: null };
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
  const check = () => {
    try {
      if (s.orchestrator && s.status) s.status(statusLine(store, config) ?? undefined);
      const next = snapshotOf(store, config);
      for (const n of notices(prev, next, (f, t) => lastFailureKind(store, f, t))) s.notify(n, n.includes('需要你处理') ? 'warning' : 'info');
      prev = next;
      // 没有进行中的流程与修复时自动退出调度模式
      if (s.orchestrator && s.deactivate && !visibleFlows(store).length) void s.deactivate().then((m) => s.notify(m));
    } catch { /* 通知失败不影响流程 */ }
  };
  // 通知检测节流：状态变化密集时（一次合并会有多次转移）最多每 NOTICE_THROTTLE_MS 检测一次，末尾一定再检测一次
  let timer: NodeJS.Timeout | null = null;
  engine.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(); }, NOTICE_THROTTLE_MS);
    timer.unref();
  });
  return s.handle;
}

const NOTICE_THROTTLE_MS = 300;

function agentPrompt(root: string, name: string): string {
  const project = path.join(root, '.pi', 'agents', `${name}.md`);
  const file = existsSync(project) ? project : path.join(PACKAGE_ROOT, 'agents', `${name}.md`);
  return parseAgentFile(readFileSync(file, 'utf8'), file).prompt;
}

export default function piFlow(pi: ExtensionAPI): void {
  /** 进入调度或访谈模式前记住会话状态，并提供退出时的恢复 */
  const enterManagedMode = (ctx: ExtensionContext, s: RootSession) => {
    if (!s.orchestrator && !s.interview) s.saved = { model: ctx.model, thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() };
    s.deactivate = async () => {
      if (!s.orchestrator && !s.interview) return '当前不在调度模式。';
      s.orchestrator = false;
      s.interview = null;
      s.status?.(undefined);
      s.status = null;
      const saved = s.saved;
      s.saved = null;
      if (!saved) return '已退出调度模式。';
      pi.setActiveTools(saved.tools);
      if (saved.model) await pi.setModel(saved.model);
      pi.setThinkingLevel(saved.thinking);
      return `已退出调度模式，恢复原来的模型${saved.model ? `（${saved.model.provider}/${saved.model.id}）` : ''}与工具。流程状态不变，/flow resume 可重新进入。`;
    };
  };

  /** 主会话切换到 /flow-config 中为 orchestrator（对话角色）设置的模型与思考级别 */
  const applyOrchestratorModel = async (ctx: ExtensionContext, config: FlowConfig) => {
    const r = resolveRoleModel(config, loadRoleSettings(roleSettingsPath()), 'orchestrator');
    if (r.model) {
      const [provider, ...rest] = r.model.split('/');
      const id = rest.join('/');
      const m = ctx.modelRegistry.getAvailable().find((x) => x.provider.toLowerCase() === provider!.toLowerCase() && x.id === id)
        ?? ctx.modelRegistry.find(provider!, id);
      if (!m) report(ctx, `orchestrator 的模型 ${r.model} 不可用，保留当前模型。执行 /flow-config 检查。`, 'warning');
      else if (!(await pi.setModel(m))) report(ctx, `无法切换到 ${r.model}（该 provider 没有配置凭据），保留当前模型。`, 'warning');
    }
    if (r.thinking) pi.setThinkingLevel(r.thinking);
  };

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
      activateOrchestrator: async () => {
        const config = engineFor(root).config;
        enterManagedMode(ctx, s);
        s.orchestrator = true;
        s.interview = null;
        const registered = new Set(pi.getAllTools().map((t) => t.name));
        pi.setActiveTools(config.activeTools('orchestrator').filter((t) => registered.has(t)));
        await applyOrchestratorModel(ctx, config);
        // 实时进度：只在终端界面显示状态栏，随引擎状态变化（节流）刷新，退出调度模式时清除
        if (ctx.mode === 'tui') {
          s.status = (text) => ctx.ui.setStatus('pi-flow', text);
          s.status(statusLine(engineFor(root).store, config) ?? undefined);
        }
      },
      activateInterview: async (mode) => {
        const config = engineFor(root).config;
        enterManagedMode(ctx, s);
        s.orchestrator = false;
        s.interview = mode;
        pi.setActiveTools(['read', 'flow_brief']);
        await applyOrchestratorModel(ctx, config);
        if (ctx.hasUI) pi.sendUserMessage('请开始需求访谈。');
      },
      deactivateOrchestrator: () => (s.deactivate ? s.deactivate() : '当前不在调度模式。'),
      waitForIdle: !ctx.hasUI,
      dependencies: () => ({ piVersion: VERSION, packageRoots: packageRoots(root, getAgentDir()) }),
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
      name: 'flow_replan', label: 'flow_replan', description: '用户要求修改计划（漏了功能、要改需求、某个任务拆得不对）时调用：把用户的要求交给 architect 起草计划修订（新增任务、调整或取消未开始的任务）。修订需要用户 /flow approve 才生效；你不能自己改任务。',
      parameters: ReplanParams,
      async execute(_id, p, _s, _u, ctx) {
        const h = engineFor(ctx.cwd);
        const r = await flowReplan(ctx.cwd, h.store, h.config, h.engine, checked(ReplanParams, p, 'flow_replan'));
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

  // 需求访谈工具：总是注册但默认不激活，只在访谈模式中启用
  pi.registerTool({
    name: 'flow_brief', label: 'flow_brief', defaultActive: false,
    description: '需求访谈：记录与用户谈定的需求小节（key 见系统提示中的"待补充"），可一次更新多个小节。只记录用户确认过的内容。',
    parameters: Type.Object({ sections: Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 4000 }), { description: '小节 key → 内容' }) }),
    async execute(_id, p, _s, _u, ctx) {
      const store = sessions.get(ctx.cwd)?.handle?.store ?? new StateStore(ctx.cwd);
      const { brief, missing } = await updateBrief(store, (p as { sections: Record<string, string> }).sections);
      return toolResult(missing.length
        ? `已记录。还需要：${missing.map((x) => `${x.label}（${x.key}）`).join('、')}。`
        : `已记录，清单已完整。请向用户展示摘要，并请其执行 ${CONFIRM_COMMAND[brief.mode]} 开始。`);
    },
  });

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
    if (s?.interview && s.handle) {
      const brief = activeBrief(s.handle.store);
      const ctxText = brief ? interviewContext(brief) : '[需求访谈] 访谈已结束或已取消，请用户执行 /flow-build 或 /flow-fix 重新开始。';
      event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ''}\n\n${agentPrompt(ctx.cwd, 'interviewer')}\n\n${ctxText}`.trim();
      return;
    }
    if (!s?.orchestrator || !s.handle) return;
    const { store, engine, config } = s.handle;
    s.driftBefore = dirtyFiles(ctx.cwd);
    const injected = `${agentPrompt(ctx.cwd, 'orchestrator')}\n\n${turnContext(store, config.limits.max_parallel, engine.activeRuns().length, config)}`;
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
    if (s?.interview && s.handle) {
      if (event.toolName === 'flow_brief') return;
      if (event.toolName !== 'read') return { block: true, reason: '需求访谈阶段只能阅读 docs/ 下的文档并用 flow_brief 记录需求；不能写文件或执行命令。' };
    }
    if (!s?.handle || (!s.orchestrator && !s.interview)) return;
    const { store, config } = s.handle;
    const step = nextStep(store, config.limits.max_parallel, 0, config);
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
    getArgumentCompletions: (prefix) => ['status', 'next', 'resume', 'answer', 'rules', 'knowledge', 'run', 'sync', 'replan', 'budget', 'off', 'approve', 'reject', 'unblock', 'gate', 'abort', 'doctor', 'init', 'help']
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
    getArgumentCompletions: (prefix) => ['--feature', '--confirm', '--cancel', '--direct', '--from'].filter((x) => x.startsWith(prefix.trim().split(' ').at(-1) ?? '')).map((x) => ({ value: x, label: x })),
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
