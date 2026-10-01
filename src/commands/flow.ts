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

export interface FlowUi {
  select(title: string, options: string[]): Promise<string | undefined>;
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
].join('\n');

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
    case 'help': case '-h': case '--help':
      return FLOW_USAGE;
    default:
      throw new Error(`未知子命令 ${sub}。\n${FLOW_USAGE}`);
  }
}
