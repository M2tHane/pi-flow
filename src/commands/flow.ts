// /flow 子命令的业务实现（不依赖 Pi）：init、doctor、resume、status、next。M6、M7 在此扩展 approve、unblock、--cost。
import type { FlowConfig } from '../core/config.ts';
import type { StateStore } from '../core/state-store.ts';
import type { Engine } from '../core/dispatcher.ts';
import type { RoleSettingsFile } from '../core/schemas.ts';
import { initProject, formatInit } from '../core/init.ts';
import { doctor, formatDoctor } from '../core/doctor.ts';
import { resume, type DecisionAnswer } from '../core/resume.ts';
import { formatPreflight } from '../core/preflight.ts';
import { activeFlowId, statusText } from '../tools/orchestrator-tools.ts';
import { splitArgs } from './args.ts';
import { approveStage, rejectStage, unblockTask, startFlow } from '../core/stages.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface FlowUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

export interface EngineHandle { store: StateStore; engine: Engine; config: FlowConfig }

export interface CommandEnv {
  root: string;
  packageRoot: string;
  ui: FlowUi | null;
  /** 取得（必要时创建）本会话的引擎；会获取引擎锁，被其他会话持有时抛错 */
  engine(): EngineHandle;
  /** 只读访问状态（不获取引擎锁） */
  store(): StateStore;
  roleSettings(): RoleSettingsFile;
  availableModels(): string[];
  /** 进入调度模式（orchestrator） */
  activateOrchestrator(): void;
  /** 非交互模式：命令结束后进程退出，需要等待引擎跑完 */
  waitForIdle: boolean;
}

export const FLOW_USAGE = [
  '用法：',
  '  /flow status            当前流程、阶段、任务进度、等待你处理的事项',
  '  /flow next              由程序选择 ready 任务并派发',
  '  /flow resume            会话丢失后恢复，并进入调度模式',
  '  /flow doctor [--fix]    状态完整性与前置条件检查；--fix 清理残留 worktree 与提示文件',
  '  /flow init              初始化项目骨架（可重复执行，不覆盖）',
  '  /flow approve [--yes]   批准当前阶段闸门（仅用户）；最后一个阶段会把集成分支合入主分支',
  '  /flow reject "<意见>"   打回设计阶段（S0/S1/F0/F1），生成修订任务',
  '  /flow unblock <任务> ["<回答>"] [--attempts N]   解除阻塞，可附上对任务提问的回答',
  '  /flow gate              闸门失败并修复后，重跑当前阶段闸门',
].join('\n');

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && argv[i - 1] !== '--yes'));

const DECIDE_CONTINUE = '继续：保留未提交的改动，重新派发给原角色';
const DECIDE_DISCARD = '丢弃：清除未提交的改动，任务回到 ready';

export async function runFlowCommand(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  const sub = argv[0] ?? 'status';
  switch (sub) {
    case 'init': {
      const r = await initProject(env.root, env.packageRoot);
      return `${formatInit(r)}\n\n前置条件：\n${formatPreflight(r.preflight)}\n\n下一步：执行 /flow-config 为各角色选择模型，然后 /flow-build 开始。`;
    }
    case 'doctor': {
      const r = await doctor(env.root, env.store(), { fix: argv.includes('--fix'), preflight: { roleSettings: env.roleSettings(), availableModels: env.availableModels() } });
      return formatDoctor(r);
    }
    case 'resume': {
      const h = env.engine();
      const active = new Set(h.engine.activeRuns().map((r) => r.run_id));
      const r = await resume({ root: env.root, store: h.store, config: h.config, activeRunIds: active }, env.ui ? async (q) => {
        const pick = await env.ui!.select(`${q.task} 的租约已过期，worktree 有未提交的改动：\n${q.changes.slice(0, 10).join('\n')}`, [DECIDE_CONTINUE, DECIDE_DISCARD]);
        return pick === DECIDE_CONTINUE ? 'continue' : pick === DECIDE_DISCARD ? ('discard' as DecisionAnswer) : undefined;
      } : undefined);
      if (!r.ok) return r.brief;
      env.activateOrchestrator();
      const flowId = h.store.readState().active_flow;
      if (flowId) {
        await h.engine.pump(flowId);
        h.engine.startLeaseWatch();
        if (env.waitForIdle) await h.engine.idle();
      }
      return r.brief;
    }
    case 'status': {
      const store = env.store();
      return statusText(store, null, activeFlowId(store));
    }
    case 'next': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const d = await h.engine.next(flowId);
      const head = d.length ? `已派发：${d.map((x) => `${x.task} → ${x.role}（${x.model}，run ${x.run_id}）`).join('；')}` : '没有可派发的任务。';
      if (env.waitForIdle) await h.engine.idle();
      return `${head}\n${statusText(h.store, h.engine, flowId)}`;
    }
    case 'approve': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const flow = h.store.readFlow(flowId);
      if (flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human' && !argv.includes('--yes')) {
        const msg = `批准阶段 ${flow.stage} 将把 ${flow.integration_branch} 合入 ${h.config.raw.main_branch}，流程随之结束。`;
        if (!env.ui) return `${msg}\n确认请执行 /flow approve --yes`;
        const ok = await env.ui.select(`${msg}确认？`, ['确认合入并结束流程', '取消']);
        if (ok !== '确认合入并结束流程') return '已取消。';
      }
      const text = await approveStage({ root: env.root, store: h.store, config: h.config }, flowId, option(argv, '--note'));
      if (h.store.readState().active_flow) {
        await h.engine.pump(flowId);
        if (env.waitForIdle) await h.engine.idle();
      }
      return text;
    }
    case 'reject': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const text = await rejectStage({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '));
      await h.engine.pump(flowId);
      return text;
    }
    case 'unblock': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const [, taskId, answer] = positional(argv);
      if (!taskId) throw new Error('用法：/flow unblock <任务> ["<回答>"] [--attempts N]');
      const att = option(argv, '--attempts');
      const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, flowId, taskId, answer, att !== undefined ? Number(att) : undefined);
      await h.engine.pump(flowId);
      return text;
    }
    case 'gate': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      await h.engine.rerunGate(flowId);
      return statusText(h.store, h.engine, flowId);
    }
    case 'help': case '-h': case '--help':
      return FLOW_USAGE;
    default:
      throw new Error(`未知子命令 ${sub}。\n${FLOW_USAGE}`);
  }
}

export const BUILD_USAGE = [
  '用法：',
  '  /flow-build "<项目描述>"              从零建新项目（S0 需求 → S1 架构 → S2 基础设施 → S3 切片 → S4 集成 → S5 发布）',
  '  /flow-build --feature "<功能描述>"    在已有项目上加功能（F0 功能说明 → F1 影响面与 DAG → S3 → S4 回归）',
  '小改动（单文件、几十行以内）直接用 pi 更划算；缺陷修复用 /flow-fix。',
].join('\n');

/** /flow-build 与 /flow-build --feature */
export async function runFlowBuild(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  if (argv[0] === 'help' || argv[0] === '--help') return BUILD_USAGE;
  const feature = argv.includes('--feature');
  let description = (feature ? option(argv, '--feature') : argv.filter((a) => !a.startsWith('--')).join(' '))?.trim() ?? '';
  if (!description && env.ui?.input) description = (await env.ui.input(feature ? '描述要加的功能' : '描述要做的项目', '一两句话即可，后续会补充'))?.trim() ?? '';
  if (!description) throw new Error(`需要描述。\n${BUILD_USAGE}`);

  const lines: string[] = [];
  if (!existsSync(path.join(env.root, '.flow', 'state.json')) || !existsSync(path.join(env.root, 'workflow.yaml'))) {
    lines.push(formatInit(await initProject(env.root, env.packageRoot)));
  }
  const h = env.engine();
  const active = h.store.readState().active_flow;
  if (active) {
    const f = h.store.readFlow(active);
    throw new Error(`已有进行中的流程 ${f.id}「${f.title}」（阶段 ${f.stage}）。同一时间只允许一个 build 或 feature 流程；请执行 /flow resume 继续。`);
  }
  const flow = await startFlow({ root: env.root, store: h.store, config: h.config }, feature ? 'feature' : 'build', description);
  env.activateOrchestrator();
  await h.engine.pump(flow.id);
  const d = await h.engine.next(flow.id);
  lines.push(`已创建流程 ${flow.id}（${flow.mode}），阶段：${flow.stages.join(' → ')}；集成分支 ${flow.integration_branch}。`);
  if (d.length) lines.push(`已派发 ${d.map((x) => `${x.task} → ${x.role}（${x.model}）`).join('；')}。`);
  if (env.waitForIdle) await h.engine.idle();
  lines.push(statusText(h.store, h.engine, flow.id));
  return lines.join('\n');
}
