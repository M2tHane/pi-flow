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
import { continueFix } from '../modes/fix.ts';
import { readFileSync } from 'node:fs';
import type { BriefFile } from '../core/schemas.ts';
import { CHECKLISTS, CONFIRM_COMMAND, MODE_LABEL, activeBrief, cancelBrief, confirmBrief, markConfirmed, renderBrief, startBrief, type InterviewMode } from '../modes/interview.ts';
import { costReport, formatCost } from '../core/cost.ts';
import { renderStatus, visibleFlows } from '../core/status-view.ts';
import { applyDrafts, formatDrafts, listDrafts, type Draft } from '../core/rules-draft.ts';
import { findSessionFile, formatRunDetail, summarizeSession } from '../core/session-log.ts';
import { budgetState, formatBudget } from '../core/cost-control.ts';
import { RevisionError, approveRevision, rejectRevision, startReplan } from '../core/revision.ts';
import { KnowledgeError, acceptCandidate, formatKnowledgeList, markPromoted, promoteToDraft, retireEntries, searchKnowledge } from '../core/knowledge.ts';
import { loadConfig } from '../core/config.ts';
import { checkDependencies } from '../core/dependencies.ts';
import { activePauses, describePause, matchPausedModel } from '../core/model-pause.ts';
import { git } from '../core/git.ts';
import type { StateStore as Store } from '../core/state-store.ts';
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
  /** 进入调度模式（orchestrator）：收窄工具、切换到 orchestrator 的模型；返回提示信息 */
  activateOrchestrator(): Promise<string | void> | string | void;
  /** 进入需求访谈模式（主会话只能读文档与记录需求） */
  activateInterview?(mode: InterviewMode): Promise<void> | void;
  /** 退出调度模式：恢复进入前的模型、思考级别与工具 */
  deactivateOrchestrator?(): Promise<string> | string;
  /** 非交互模式：命令结束后进程退出，需要等待引擎跑完 */
  waitForIdle: boolean;
  /** 当前 Pi 版本与 Pi 包的安装位置（用于依赖检查）；测试环境可不提供 */
  dependencies?(): { piVersion: string; packageRoots: string[] };
}

export const FLOW_USAGE = [
  '用法：',
  '  /flow status            当前处于哪个阶段、进度、正在做什么、需要你处理什么',
  '  /flow status --detail   完整的任务列表与内部状态',
  '  /flow next              由程序选择 ready 任务并派发',
  '  /flow resume            会话丢失后恢复，并进入调度模式',
  '  /flow off               退出调度模式，恢复原来的模型与工具（流程状态不变）',
  '  /flow doctor [--fix]    状态完整性与前置条件检查；--fix 清理残留 worktree 与提示文件',
  '  /flow init              初始化项目骨架（可重复执行，不覆盖）',
  '  /flow approve [--yes]   批准当前阶段闸门（仅用户）；最后一个阶段会把集成分支合入主分支',
  '  /flow reject "<意见>"   打回设计阶段（S0/S1/F0/F1），生成修订任务',
  '  /flow answer [<任务>]   回答阻塞任务提出的问题（弹出输入框），回答后任务继续',
  '  /flow unblock <任务> ["<回答>"] [--attempts N]   解除阻塞（无界面时用它回答）',
  '  /flow gate              闸门失败并修复后，重跑当前阶段闸门',
  '  /flow rules [apply [all|<草案文件>...]]   查看或应用规则与命令草案（docs/rules-draft/，来自架构师或知识提升）',
  '  /flow models [resume <模型>|all]   查看因额度用完、限流而暂停的模型；resume 立即恢复派发',
  '  /flow budget [tokens|cost <数值>]   查看或设置本流程的预算；超出后暂停派发新任务',
  '  /flow replan "<要改什么>"   执行中修订计划：architect 起草（新增任务、调整或取消未开始的任务），你批准后生效',
  '  /flow sync              把主分支同步进集成分支（每个阶段开始时自动执行）',
  '  /flow run [<run_id>]    某次子进程运行的工具调用摘要与最后的回复（会话留档）；不给 id 时列出最近的运行',
  '  /flow knowledge [...]   项目知识库：列出、搜索、确认候选、废弃、提升为规则草案（/flow knowledge help）',
  '  /flow status --cost     成本统计：按流程、阶段、角色、模型、任务汇总 token 与耗时，返工最多的任务',
  '  /flow abort [--yes]     中止当前修复或流程（集成分支保留，主分支不受影响）',
].join('\n');

/** 命令作用的流程：等待用户处理的修复 > 活动的 build/feature 流程 > 进行中的修复 */
export function currentFlowId(store: Store): string {
  const fix = store.openFixFlow();
  if (fix?.stage_status === 'awaiting_human') return fix.id;
  const active = store.readState().active_flow;
  if (active) return active;
  if (fix) return fix.id;
  return activeFlowId(store);
}

function fullStatus(store: Store, engine: Engine | null): string {
  const parts: string[] = [];
  const active = store.readState().active_flow;
  if (active) parts.push(statusText(store, engine, active));
  const fix = store.openFixFlow();
  if (fix) {
    parts.push(statusText(store, engine, fix.id));
    if (fix.stage_status === 'awaiting_human') {
      const why = [...store.readEvents()].reverse().find((e) => e.flow === fix.id && e.type === 'gate_result')?.reason ?? '';
      parts.push(`修复 ${fix.id} 等待你决定：${why}\n继续按修复处理 → /flow approve；改用功能流程 → /flow abort 后 /flow-build --feature "<描述>"`);
    }
  }
  if (!parts.length) parts.push('当前没有进行中的流程。开始：/flow-build "<描述>"、/flow-build --feature "<描述>" 或 /flow-fix "<描述>"。');
  const recent = store.readKnowledge().entries.filter((e) => e.status === 'active' || e.status === 'candidate').slice(-5);
  if (recent.length) parts.push(`最近的项目知识（全部：/flow knowledge）：\n${formatKnowledgeList(recent)}`);
  return parts.join('\n\n');
}

function formatPauses(store: Store): string {
  const now = new Date();
  const pauses = activePauses(store, now);
  if (!pauses.length) return '没有被暂停的模型。';
  return `被暂停的模型：\n${pauses.map((p) => `- ${describePause(p, now)}`).join('\n')}\n恢复：/flow models resume <模型>；或用 /flow-config 给受影响的角色换模型（换后立即继续）。`;
}

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
      const r = await initProject(env.root, env.packageRoot, env.dependencies?.());
      return `${formatInit(r)}\n\n前置条件：\n${formatPreflight(r.preflight)}\n\n下一步：执行 /flow-config 为各角色选择模型，然后 /flow-build 开始。`;
    }
    case 'doctor': {
      let days: number | undefined;
      try { days = loadConfig(path.join(env.root, 'workflow.yaml')).limits.session_retention_days; } catch { /* 配置错误由前置条件检查报告 */ }
      const r = await doctor(env.root, env.store(), { fix: argv.includes('--fix'), preflight: { roleSettings: env.roleSettings(), availableModels: env.availableModels(), ...env.dependencies?.() },
        ...(days ? { sessionRetentionDays: days } : {}) });
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
      await env.activateOrchestrator();
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
      if (argv.includes('--cost')) {
        const config = loadConfig(path.join(env.root, 'workflow.yaml'));
        const budgets = visibleFlows(store).flatMap((f) => { const b = budgetState(store, config, f); return b ? [`${f.id} ${formatBudget(b)}`] : []; });
        return [formatCost(costReport(store), store.listFixLogs()), ...budgets].join('\n\n');
      }
      if (argv.includes('--detail')) return fullStatus(store, null);
      return renderStatus(store, loadConfig(path.join(env.root, 'workflow.yaml')));
    }
    case 'abort': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const flow = h.store.readFlow(flowId);
      if (!argv.includes('--yes')) {
        const msg = `中止 ${flow.id}「${flow.title}」：运行中的子进程会被终止，集成分支与 worktree 保留，主分支不受影响。`;
        if (!env.ui) return `${msg}\n确认请执行 /flow abort --yes`;
        if ((await env.ui.select(`${msg}确认？`, ['确认中止', '取消'])) !== '确认中止') return '已取消。';
      }
      for (const r of h.engine.activeRuns().filter((x) => x.flow === flowId)) h.engine.kill(r.run_id);
      await h.store.transitionStage(flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
      return `已中止 ${flowId}。${flow.mode === 'fix' ? '如需改用功能流程：/flow-build --feature "<描述>"' : ''}`;
    }
    case 'next': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      // 先推进程序步骤：引擎重启后，已提交、排队合并的任务（第四轮起提交直接进合并队列）只有 pump 会处理
      const before = new Set(h.engine.activeRuns().map((r) => r.run_id));
      await h.engine.pump(flowId);
      await h.engine.next(flowId);
      const d = h.engine.activeRuns().filter((r) => !before.has(r.run_id));
      const head = d.length ? `已派发：${d.map((x) => `${x.task} → ${x.role}（run ${x.run_id}）`).join('；')}` : '没有可派发的任务。';
      if (env.waitForIdle) await h.engine.idle();
      return `${head}\n\n${renderStatus(h.store, h.config)}`;
    }
    case 'approve': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      if (h.store.readFlow(flowId).mode === 'fix') {
        const text = await continueFix(h.store, flowId);
        await h.engine.pump(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `${text}\n\n${renderStatus(h.store, h.config)}`;
      }
      if (h.store.readRevision(flowId)?.status === 'proposed') {
        const text = await approveRevision({ root: env.root, store: h.store, config: h.config }, flowId);
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `${text}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}\n\n${renderStatus(h.store, h.config)}`;
      }
      const flow = h.store.readFlow(flowId);
      if (flow.stage === flow.stages.at(-1) && flow.stage_status === 'awaiting_human' && !argv.includes('--yes')) {
        const msg = `批准阶段 ${flow.stage} 将把 ${flow.integration_branch} 合入 ${h.config.raw.main_branch}，流程随之结束。`;
        if (!env.ui) return `${msg}\n确认请执行 /flow approve --yes`;
        const ok = await env.ui.select(`${msg}确认？`, ['确认合入并结束流程', '取消']);
        if (ok !== '确认合入并结束流程') return '已取消。';
      }
      const stageBefore = h.store.readFlow(flowId).stage;
      let text = await approveStage({ root: env.root, store: h.store, config: h.config }, flowId, option(argv, '--note'));
      if (stageBefore === 'S1' || stageBefore === 'F1') text += `\n${await offerDrafts(env, h, flowId, option(argv, '--rules'))}`;
      if (h.store.readState().active_flow) {
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `${text}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}\n\n${renderStatus(h.store, h.config)}`;
      }
      return text;
    }
    case 'reject': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      if (h.store.readRevision(flowId)?.status === 'proposed') {
        const text = await rejectRevision({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '));
        await h.engine.pump(flowId);
        await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return text;
      }
      const text = await rejectStage({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '));
      await h.engine.pump(flowId);
      return text;
    }
    case 'unblock': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const [, taskId, answer] = positional(argv);
      if (!taskId) throw new Error('用法：/flow unblock <任务> ["<回答>"] [--attempts N]');
      const owner = [h.store.readState().active_flow, h.store.openFixFlow()?.id].filter((x): x is string => !!x)
        .find((f) => h.store.listTasks(f).some((t) => t.id === taskId && t.status === 'blocked'));
      if (owner && owner !== flowId) {
        const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, owner, taskId, answer, option(argv, '--attempts') !== undefined ? Number(option(argv, '--attempts')) : undefined);
        await h.engine.pump(owner);
        return text;
      }
      const att = option(argv, '--attempts');
      const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, flowId, taskId, answer, att !== undefined ? Number(att) : undefined);
      await h.engine.pump(flowId);
      if (h.store.readFlow(flowId).mode !== 'fix') await h.engine.next(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return text;
    }
    case 'gate': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      await h.engine.rerunGate(flowId);
      return renderStatus(h.store, h.config);
    }
    case 'rules': {
      const h = env.engine();
      const flowId = currentFlowIdOrNull(h.store);
      const drafts = allDrafts(env.root, h, flowId);
      if (argv[1] !== 'apply') {
        return drafts.length
          ? `待应用的规则与命令草案${flowId ? `（${flowId} 与主分支）` : '（主分支）'}：\n${formatDrafts(drafts)}\n应用：/flow rules apply all，或 /flow rules apply <草案文件>...`
          : '没有待应用的规则或命令草案。';
      }
      const picks = argv.slice(2);
      const chosen = !picks.length || picks.includes('all') ? drafts : drafts.filter((d) => picks.includes(d.file) || picks.includes(path.basename(d.file)));
      if (!chosen.length) throw new Error(`没有匹配的草案。可用：${drafts.map((d) => d.file).join('、') || '无'}`);
      return applyAndReport(env, h, flowId, chosen);
    }
    case 'budget': {
      const h = env.engine();
      const flowId = currentFlowId(h.store);
      const kind = argv[1];
      if (kind === 'tokens' || kind === 'cost') {
        const v = Number(argv[2]);
        if (!Number.isFinite(v) || v <= 0 || (kind === 'tokens' && !Number.isInteger(v))) return `用法：/flow budget tokens <正整数> 或 /flow budget cost <正数>`;
        const cur = h.store.readFlow(flowId).budget ?? {};
        await h.store.setFlowBudget(flowId, { ...cur, [kind]: v });
        await h.engine.pump(flowId);
        const d = await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        const b = budgetState(h.store, h.config, h.store.readFlow(flowId));
        return `已设置 ${flowId} 的预算。${b ? formatBudget(b) : ''}${d.length ? `\n已派发：${d.map((x) => `${x.task} → ${x.role}`).join('；')}` : ''}`;
      }
      if (kind) return '用法：/flow budget（查看）、/flow budget tokens <数值>、/flow budget cost <金额>';
      const b = budgetState(h.store, h.config, h.store.readFlow(flowId));
      return b ? `${flowId} ${formatBudget(b)}` : `${flowId} 没有设置预算（workflow.yaml 的 budget 或 /flow budget tokens|cost <数值>）。`;
    }
    case 'models': {
      if (argv[1] === 'resume') {
        const name = argv[2];
        if (!name) return '用法：/flow models resume <模型>（provider/id 或只写 id）或 /flow models resume all';
        const h = env.engine();
        const hits = matchPausedModel(h.store.readModelPauses().pauses, name);
        if (!hits.length) return `没有被暂停的模型 ${name}。${formatPauses(h.store)}`;
        for (const p of hits) await h.engine.resumeModel(p.model);
        if (env.waitForIdle) await h.engine.idle();
        return `已恢复 ${hits.map((p) => p.model).join('、')}，受影响的任务会重新派发。如果额度仍未恢复，会再次暂停。`;
      }
      if (argv[1]) return '用法：/flow models（查看）、/flow models resume <模型>|all';
      return formatPauses(env.store());
    }
    case 'replan': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      try {
        const id = await startReplan({ root: env.root, store: h.store, config: h.config }, flowId, argv.slice(1).join(' '), 'human');
        await h.engine.pump(flowId);
        await h.engine.next(flowId);
        if (env.waitForIdle) await h.engine.idle();
        return `已生成修订任务 ${id}，交给 architect 起草计划修订。提交后用 /flow approve 批准，或 /flow reject "<意见>" 打回。`;
      } catch (e) {
        if (e instanceof RevisionError) return `未发起：${e.message}`;
        throw e;
      }
    }
    case 'sync': {
      const h = env.engine();
      const flowId = activeFlowId(h.store);
      const r = await h.engine.sync(flowId);
      const main = h.config.raw.main_branch;
      const text = !r ? '合并正在进行，稍后再试。'
        : r.kind === 'up_to_date' ? `集成分支已包含 ${main} 的全部提交。`
          : r.kind === 'synced' ? `已把 ${main} 同步进集成分支（${r.files} 个文件，${r.sha.slice(0, 8)}）。`
            : r.kind === 'merge_fix' ? `同步冲突：${r.conflicts.join('、')}。已生成 ${r.task} 解决冲突，完成后集成分支即与 ${main} 同步。`
              : r.kind === 'fixing' ? `冲突修复任务 ${r.task} 尚未完成，完成后再同步。`
                : `同步冲突，需要你处理：${r.reason}。在 ${h.store.readFlow(flowId).integration_branch} 上合并 ${main} 并解决冲突后再执行 /flow sync；在此之前不会派发新任务。`;
      await h.engine.pump(flowId);
      if (r?.kind !== 'conflict') await h.engine.next(flowId);
      if (env.waitForIdle) await h.engine.idle();
      return text;
    }
    case 'run':
      return runDetail(argv[1], env.store());
    case 'knowledge':
      try {
        return await runKnowledge(argv.slice(1), env);
      } catch (e) {
        if (e instanceof KnowledgeError) return `未完成：${e.message}`;
        throw e;
      }
    case 'answer':
      return runFlowAnswer(argv, env);
    case 'off':
      if (!env.deactivateOrchestrator) return '当前环境不支持调度模式。';
      return env.deactivateOrchestrator();
    case 'help': case '-h': case '--help':
      return FLOW_USAGE;
    default:
      throw new Error(`未知子命令 ${sub}。\n${FLOW_USAGE}`);
  }
}

export const BUILD_USAGE = [
  '用法：',
  '  /flow-build ["<项目描述>"]              先与你访谈需求，确认后从零建新项目',
  '  /flow-build --feature ["<功能描述>"]    先访谈功能需求，确认后在已有项目上加功能',
  '  /flow-build --confirm                   需求访谈完成后确认，开始流程',
  '  /flow-build --cancel                    放弃当前的需求访谈',
  '  /flow-build --direct "<描述>"           跳过访谈直接开始（加 --feature 为功能）',
  '  /flow-build --from <文件>               用写好的需求文档直接开始（加 --feature 为功能）',
  '小改动（单文件、几十行以内）直接用 pi 更划算；缺陷修复用 /flow-fix。',
].join('\n');

export const FIX_USAGE = [
  '用法：',
  '  /flow-fix ["<问题描述>"]          先问清现象与复现步骤，确认后开始修复',
  '  /flow-fix --confirm [--yes]       访谈完成后确认，开始修复',
  '  /flow-fix --cancel                放弃当前的访谈',
  '  /flow-fix --direct "<问题描述>"   跳过访谈直接修复',
  '  /flow-fix --from <文件>           用写好的问题描述直接修复',
  '流程：scout 定位 → （超出规模时请你决定）→ 复现测试（必须先失败）→ 修复 → 审查 → verify → 直接合入主分支。',
].join('\n');

async function ensureInitialized(env: CommandEnv, lines: string[]): Promise<void> {
  if (!existsSync(path.join(env.root, '.flow', 'state.json')) || !existsSync(path.join(env.root, 'workflow.yaml'))) {
    lines.push(formatInit(await initProject(env.root, env.packageRoot, env.dependencies?.())));
  }
}

function readFromFile(env: CommandEnv, argv: string[]): string | null {
  const file = option(argv, '--from');
  if (file === undefined) return null;
  const abs = path.resolve(env.root, file);
  if (!existsSync(abs)) throw new Error(`找不到文件 ${file}`);
  const text = readFileSync(abs, 'utf8').trim();
  if (!text) throw new Error(`${file} 是空文件`);
  return text;
}

/** build/feature 流程不能与进行中的流程并存 */
function assertNoActiveFlow(h: EngineHandle): void {
  const active = h.store.readState().active_flow;
  if (active) {
    const f = h.store.readFlow(active);
    throw new Error(`已有进行中的流程 ${f.id}「${f.title}」。同一时间只允许一个 build 或 feature 流程；请执行 /flow resume 继续。`);
  }
}

/** 开始一次需求访谈（主会话进入访谈模式） */
async function beginInterview(env: CommandEnv, mode: InterviewMode, description: string, lines: string[]): Promise<string> {
  const h = env.engine();
  if (activeBrief(h.store)) await cancelBrief(h.store);
  const brief = await startBrief(h.store, mode, description);
  await env.activateInterview?.(mode);
  lines.push(`开始需求访谈（${MODE_LABEL[mode]}）。我会一次问一个问题，问清 ${CHECKLISTS[mode].map((x) => x.label).join('、')}。`);
  lines.push(`问完后执行 ${CONFIRM_COMMAND[mode]} 开始；不想访谈可以用 --direct "<描述>" 或 --from <文件>。`);
  if (!env.ui) lines.push('（当前没有交互界面：请直接发送你的回答，访谈者会记录。）');
  void brief;
  return lines.join('\n');
}

/** /flow-build 与 /flow-build --feature */
export async function runFlowBuild(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  if (argv[0] === 'help' || argv[0] === '--help') return BUILD_USAGE;
  const lines: string[] = [];
  await ensureInitialized(env, lines);
  const h = env.engine();
  if (argv.includes('--cancel')) { await cancelBrief(h.store); await env.deactivateOrchestrator?.(); return '已放弃需求访谈。'; }

  if (argv.includes('--confirm')) {
    const b = await confirmBrief(h.store, 'build');
    assertNoActiveFlow(h);
    return startBuildFlow(env, b.mode as 'build' | 'feature', b.description || b.sections['goal'] || '新项目', renderBrief(b), lines, b);
  }

  const feature = argv.includes('--feature');
  const fromFile = readFromFile(env, argv);
  const description = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--from').join(' ').trim();
  assertNoActiveFlow(h);
  const mode = feature ? 'feature' : 'build';
  if (fromFile) return startBuildFlow(env, mode, fromFile.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 120) || '新项目', fromFile, lines);
  if (argv.includes('--direct')) {
    if (!description) throw new Error(`--direct 需要描述。\n${BUILD_USAGE}`);
    return startBuildFlow(env, mode, description, '', lines);
  }
  return beginInterview(env, mode, description, lines);
}

/** 开流程前检查依赖：Pi 版本过低直接拒绝；插件缺失或版本未经验证只提醒 */
function dependencyGate(env: CommandEnv, config: FlowConfig, lines: string[]): void {
  const deps = env.dependencies?.();
  if (!deps) return;
  const items = checkDependencies({ config, ...deps });
  const errors = items.filter((i) => i.level === 'error');
  if (errors.length) throw new Error(`依赖检查未通过：\n${errors.map((i) => `✗ ${i.item}：${i.detail}`).join('\n')}`);
  const warns = items.filter((i) => i.level === 'warn');
  if (warns.length) lines.push(`依赖提醒（不影响开始，相关工具可能不可用；/flow doctor 查看）：\n${warns.map((i) => `! ${i.item}：${i.detail}`).join('\n')}`, '');
}

async function startBuildFlow(env: CommandEnv, mode: 'build' | 'feature', title: string, brief: string, lines: string[], confirmed?: BriefFile): Promise<string> {
  const h = env.engine();
  dependencyGate(env, h.config, lines);
  const flow = await startFlow({ root: env.root, store: h.store, config: h.config }, mode, title);
  if (brief) await h.store.saveFlowBrief(flow.id, brief);
  if (confirmed) await markConfirmed(h.store, flow.id);
  await env.activateOrchestrator();
  await h.engine.pump(flow.id);
  const d = await h.engine.next(flow.id);
  lines.push(`已创建流程 ${flow.id}（${flow.mode}），阶段：${flow.stages.join(' → ')}；集成分支 ${flow.integration_branch}。`);
  if (d.length) lines.push(`已派发 ${d.map((x) => `${x.task} → ${x.role}（${x.model}）`).join('；')}。`);
  if (env.waitForIdle) await h.engine.idle();
  lines.push('', renderStatus(h.store, h.config));
  return lines.join('\n');
}

/** /flow-fix */
export async function runFlowFix(args: string, env: CommandEnv): Promise<string> {
  const argv = splitArgs(args);
  if (argv[0] === 'help' || argv[0] === '--help') return FIX_USAGE;
  const lines: string[] = [];
  await ensureInitialized(env, lines);
  const h = env.engine();
  if (argv.includes('--cancel')) { await cancelBrief(h.store); await env.deactivateOrchestrator?.(); return '已放弃访谈。'; }

  let description: string;
  let brief = '';
  let confirmed: BriefFile | undefined;
  if (argv.includes('--confirm')) {
    confirmed = await confirmBrief(h.store, 'fix');
    description = confirmed.description || confirmed.sections['symptom'] || '修复';
    brief = renderBrief(confirmed);
  } else {
    const fromFile = readFromFile(env, argv);
    const desc = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--from').join(' ').trim();
    if (fromFile) { description = fromFile.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 120); brief = fromFile; }
    else if (argv.includes('--direct')) {
      if (!desc) throw new Error(`--direct 需要问题描述。\n${FIX_USAGE}`);
      description = desc;
    } else {
      return beginInterview(env, 'fix', desc, lines);
    }
  }

  const active = h.store.readState().active_flow;
  if (active) {
    const f = h.store.readFlow(active);
    if (f.stage_status !== 'awaiting_human') {
      throw new Error(`进行中的流程 ${f.id} 正在阶段 ${f.stage} 运行（${f.stage_status}），不能同时修复。等它进入等待审批时再修复，或把问题作为该流程的一部分处理。`);
    }
    if (!argv.includes('--yes')) {
      const msg = `流程 ${f.id} 正在等待审批（阶段 ${f.stage}）。修复会直接合入 ${h.config.raw.main_branch}，与该流程并行。`;
      if (!env.ui) return `${msg}\n确认请在原命令后加 --yes`;
      if ((await env.ui.select(`${msg}继续？`, ['继续修复', '取消'])) !== '继续修复') return '已取消。';
    }
  }
  const main = h.config.raw.main_branch;
  dependencyGate(env, h.config, lines);
  const fix = await h.store.createFixFlow(description, main, git(env.root, ['rev-parse', main]).trim());
  if (brief) await h.store.saveFlowBrief(fix.id, brief);
  if (confirmed) await markConfirmed(h.store, fix.id);
  await env.activateOrchestrator();
  await h.engine.pump(fix.id);
  lines.push(`已创建修复 ${fix.id}，scout 开始定位问题。`);
  if (env.waitForIdle) await h.engine.idle();
  lines.push('', renderStatus(h.store, h.config));
  return lines.join('\n');
}

/** /flow answer：回答阻塞任务提出的问题（答案来自用户输入，不经模型转述） */
export async function runFlowAnswer(argv: string[], env: CommandEnv): Promise<string> {
  const h = env.engine();
  const flows = [h.store.readState().active_flow, h.store.openFixFlow()?.id].filter((x): x is string => !!x);
  const blocked = flows.flatMap((f) => h.store.listTasks(f).filter((t) => t.status === 'blocked').map((t) => ({ flow: f, t })));
  if (!blocked.length) return '没有等待你回答的问题。';
  const wanted = argv[1];
  let pick = wanted ? blocked.find((x) => x.t.id === wanted) : blocked.length === 1 ? blocked[0] : undefined;
  if (wanted && !pick) throw new Error(`任务 ${wanted} 不在阻塞状态。等待回答的：${blocked.map((x) => x.t.id).join('、')}`);
  if (!env.ui?.input) {
    return `等待你回答的问题：\n${blocked.map((x) => `- ${x.t.id}「${x.t.title}」：${x.t.blocked_reason}\n  → /flow unblock ${x.t.id} "<你的回答>"`).join('\n')}`;
  }
  if (!pick) {
    const labels = blocked.map((x) => `${x.t.id}：${(x.t.blocked_reason ?? '').slice(0, 80)}`);
    const sel = await env.ui.select('选择要回答的问题', labels);
    if (!sel) return '已取消。';
    pick = blocked[labels.indexOf(sel)];
  }
  const answer = (await env.ui.input(`${pick!.t.id}「${pick!.t.title}」的问题：\n${pick!.t.blocked_reason}`, '你的回答（可留空，只解除阻塞）')) ?? undefined;
  if (answer === undefined) return '已取消。';
  const text = await unblockTask({ root: env.root, store: h.store, config: h.config }, pick!.flow, pick!.t.id, answer);
  await h.engine.pump(pick!.flow);
  if (h.store.readFlow(pick!.flow).mode !== 'fix') await h.engine.next(pick!.flow);
  return `${text}${answer.trim() ? '回答已交给该任务。' : ''}`;
}

/** 不要求有进行中的流程（知识提升的规则草案在主分支上） */
function currentFlowIdOrNull(store: Store): string | null {
  try { return currentFlowId(store); } catch { return null; }
}

/** 主分支上的草案（知识提升）+ 当前流程集成分支上的草案（架构师）；同名时以集成分支为准 */
function allDrafts(root: string, h: EngineHandle, flowId: string | null): Draft[] {
  const byFile = new Map(listDrafts(root, h.config.raw.main_branch).map((d) => [d.file, d]));
  if (flowId) for (const d of listDrafts(root, h.store.readFlow(flowId).integration_branch)) byFile.set(d.file, d);
  return [...byFile.values()];
}

async function applyAndReport(env: CommandEnv, h: EngineHandle, flowId: string | null, drafts: Draft[]): Promise<string> {
  const r = applyDrafts(env.root, drafts, flowId ?? '知识库');
  if (r.commands) Object.assign(h.config.raw.commands, r.commands);
  const promoted = await markPromoted(h.store, drafts.map((d) => d.file));
  return `已应用：${r.applied.join('、')}，并已提交。之后派发的任务使用新的规则${r.commands ? '与命令' : ''}（子进程提示的稳定前缀变化，模型服务的提示缓存会失效一次）。${promoted.length ? `\n知识 ${promoted.join('、')} 已成为规则，不再作为知识注入。` : ''}`;
}

/** /flow run [<run_id>]：某次运行的工具调用摘要与最后的回复；不给 id 时列出最近的运行 */
function runDetail(id: string | undefined, store: Store): string {
  const runs = store.listRuns().sort((a, b) => a.started_at.localeCompare(b.started_at));
  if (!id) {
    if (!runs.length) return '还没有任何运行记录。';
    return `最近的运行（详情：/flow run <run_id>）：\n${runs.slice(-15).map((r) => `- ${r.run_id}　${r.flow ?? '-'}/${r.task ?? '-'}　${r.role}　${r.outcome ?? (r.ended_at ? '无结果' : '运行中')}　${r.started_at.slice(0, 16).replace('T', ' ')}`).join('\n')}`;
  }
  const r = runs.find((x) => x.run_id === id || x.run_id.startsWith(id));
  if (!r) return `没有找到 run ${id}。最近的运行：/flow run`;
  const file = r.session_file && existsSync(r.session_file) ? r.session_file : r.session_dir ? findSessionFile(r.session_dir) : null;
  let summary = null;
  try { summary = file ? summarizeSession(file) : null; } catch { /* 无法解析时只给路径 */ }
  return formatRunDetail(r, summary, file);
}

const KNOWLEDGE_USAGE = [
  '/flow knowledge [<搜索词>] [--all]          列出或搜索项目知识（--all 含已废弃与已成为规则的）',
  '/flow knowledge accept <K-编号> ["<改写>"]   确认程序提炼的候选，可同时改写内容',
  '/flow knowledge retire <K-编号>... ["<原因>"] 废弃条目',
  '/flow knowledge promote <K-编号>... [--rule <规则名>]   提升为规则草案（docs/rules-draft/），再用 /flow rules apply 应用',
].join('\n');

async function runKnowledge(argv: string[], env: CommandEnv): Promise<string> {
  const store = env.store();
  const ids = argv.slice(1).filter((a) => /^K-\d{3,}$/.test(a));
  const rest = argv.slice(1).filter((a) => !/^K-\d{3,}$/.test(a) && !a.startsWith('--') && a !== option(argv, '--rule'));
  switch (argv[0]) {
    case 'accept': {
      if (ids.length !== 1) return `用法：${KNOWLEDGE_USAGE.split('\n')[1]}`;
      const e = await acceptCandidate(store, ids[0]!, rest.join(' ') || undefined);
      return `已确认 ${e.id}，之后相关任务的提示中会看到它：\n${formatKnowledgeList([e])}`;
    }
    case 'retire': {
      if (!ids.length) return `用法：${KNOWLEDGE_USAGE.split('\n')[2]}`;
      const es = await retireEntries(store, ids, rest.join(' '));
      return `已废弃 ${es.map((e) => e.id).join('、')}。`;
    }
    case 'promote': {
      if (!ids.length) return `用法：${KNOWLEDGE_USAGE.split('\n')[3]}`;
      const config = loadConfig(path.join(env.root, 'workflow.yaml'));
      const r = await promoteToDraft(env.root, store, config, ids, option(argv, '--rule'));
      return `已写入规则草案 ${r.file} 并提交（${ids.join('、')}）。规则只有你能改：确认内容后执行 /flow rules apply ${path.basename(r.file)} 应用；应用前这些条目仍作为知识注入。`;
    }
    case 'help':
      return KNOWLEDGE_USAGE;
    default: {
      const all = argv.includes('--all');
      const query = argv.filter((a) => a !== '--all').join(' ');
      const k = store.readKnowledge();
      const hits = searchKnowledge(k, query, all);
      if (!k.entries.length) return `项目知识库还是空的。任务执行中 agent 会用 flow_learn 记录经验；审查打回与合并后验证失败会生成候选。\n\n${KNOWLEDGE_USAGE}`;
      if (!hits.length) return `没有匹配的知识条目${query ? `（${query}）` : ''}。\n\n${KNOWLEDGE_USAGE}`;
      const cand = hits.filter((e) => e.status === 'candidate').length;
      return `项目知识（${hits.length} 条${cand ? `，其中 ${cand} 条候选待确认` : ''}）：\n${formatKnowledgeList(hits)}\n\n${KNOWLEDGE_USAGE}`;
    }
  }
}

/** S1/F1 批准后：有草案时请用户选择是否应用（无界面时给出命令提示，或按 --rules all|none） */
async function offerDrafts(env: CommandEnv, h: EngineHandle, flowId: string, flag: string | undefined): Promise<string> {
  const drafts = listDrafts(env.root, h.store.readFlow(flowId).integration_branch);
  if (!drafts.length) return '';
  const list = `架构师提出了规则与命令草案：\n${formatDrafts(drafts)}`;
  if (flag === 'all') return `${list}\n${await applyAndReport(env, h, flowId, drafts)}`;
  if (flag === 'none') return `${list}\n未应用（之后可用 /flow rules apply）。`;
  if (!env.ui) return `${list}\n建议应用：/flow rules apply all（或逐个指定文件）；不应用时实施与审查按通用规则，可能与架构设计冲突。`;
  const pick = await env.ui.select(`${list}\n\n是否应用？草案是架构师按本项目技术栈写的，通常建议全部应用；不应用时实施与审查按通用规则，可能与架构设计冲突。`, ['全部应用（推荐）', '逐个选择', '暂不应用']);
  if (pick === '全部应用（推荐）') return applyAndReport(env, h, flowId, drafts);
  if (pick !== '逐个选择') return '规则草案暂未应用（之后可用 /flow rules apply）。';
  const chosen: Draft[] = [];
  for (const d of drafts) {
    if ((await env.ui.select(`${d.file} → ${d.target}\n${d.summary}\n\n${d.content.slice(0, 1500)}`, ['应用', '跳过'])) === '应用') chosen.push(d);
  }
  return chosen.length ? applyAndReport(env, h, flowId, chosen) : '没有选择任何草案。';
}
