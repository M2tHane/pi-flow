// 引擎：派发（建 worktree、颁发 token、取得租约、组装提示、拉起子进程）与程序步骤（审查派发、verify、重新派发）。
// 调度与推进全部由代码决定；LLM 只通过 flow_* 工具提交申请。
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { RoleSettingsFile, RunFile, TaskFile, ThinkingLevel } from './schemas.ts';
import type { RunOutcome, SubagentHandle, SubagentLauncher, SubagentSpec } from './launcher.ts';
import { hashToken, isSettled } from './state-machine.ts';
import { resolveRoleModel } from './role-settings.ts';
import { loadAgent } from './agents.ts';
import { assemblePrompt, ruleFilesFor, type PreviousReview } from './prompt-assembler.ts';
import { formatEntry, selectKnowledge } from './knowledge.ts';
import { findSessionFile, sessionDirOf } from './session-log.ts';
import { heldByRevision } from './revision.ts';
import { assessRisk, budgetState, diffNumstat, escalationModel, escalationPolicy, resolveModelRef, reviewPolicy, strongReviewModel } from './cost-control.ts';
import { carriedTestOf, computeReady, isLeadingTest } from './dag.ts';
import { selectDispatchable } from './scheduler.ts';
import { createTaskWorktree, ensureLocalExcludes, scratchDir, worktreesRoot } from './worktree.ts';
import { precheckOf, runPrecheck, runVerify } from './verify-runner.ts';
import { git } from './git.ts';
import { RUN_ENV_KEYS } from '../tools/subagent-tools.ts';
import { MergeQueue, type MergeHooks, type MergeResult, type SyncResult } from './merge-queue.ts';
import { runStageGate, gateFailedWithoutChange, type GateOutcome } from './gates.ts';
import { ensureStageTasks } from './stages.ts';
import { STAGE_SKILLS } from '../modes/plan.ts';
import { fixStep } from '../modes/fix.ts';
import { existsSync, readFileSync } from 'node:fs';
import { activePause, classifyUnavailable, clearPause, describePause, pauseActive, recordPause } from './model-pause.ts';
import type { ModelPause } from './schemas.ts';

export const REVIEWER_ROLE = 'reviewer';
/**
 * 会话文件超过这个大小就不再接着（上下文太长，每轮重发的成本超过重新读代码）。
 * 真实冒烟：一次 175 轮的实施会话约 0.5 MB，接着它返工的两次运行缓存读合计上千万 token；1.5 MB → 400 KB。
 */
export const MAX_FORK_BYTES = 400_000;
/** diff 不超过这么多字符时直接放进审查提示 */
export const INLINE_DIFF_MAX = 20_000;

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface EngineDeps {
  root: string;
  store: StateStore;
  config: FlowConfig;
  roleSettings: () => RoleSettingsFile;
  launcher: SubagentLauncher;
  packageAgentsDir: string;
  /** 子进程中 pi-flow 的 subagent 扩展；总是最后加载（guard 必须最后执行） */
  subagentExtension: string;
  /** 额外扩展（第三方插件、测试用假模型 provider），在 subagentExtension 之前加载 */
  extraExtensions?: (role: string) => string[];
  now?: () => Date;
  verifyTimeoutMs?: number;
  /** 程序步骤出错时的回调（例如通知用户）；默认忽略 */
  onError?: (e: unknown) => void;
  mergeHooks?: MergeHooks;
  /** 每次合并处理完成的回调 */
  onMerge?: (r: MergeResult) => void;
  /** 技能目录（skills/<name>/SKILL.md）；子进程以 --no-skills 运行，技能由提示注入 */
  packageSkillsDir?: string;
  onGate?: (r: GateOutcome) => void;
  /** 主分支同步完成的回调 */
  onSync?: (flowId: string, r: SyncResult) => void;
}

export interface Dispatched { run_id: string; task: string; role: string; model: string }

interface ActiveRun { flow: string; task: string; role: string; handle: SubagentHandle }

/** 一次派发会用的角色与模型（审查分级、失败升级之后） */
type ReviewMode = NonNullable<RunFile['review_mode']>;
interface ModelPlan { role: string; model: string; thinking: ThinkingLevel | null; reviewMode?: ReviewMode; escalated: boolean }

/**
 * 上一次审查打回的问题（第三轮 B）：最近一次审查结论是打回时返回，供下一轮审查先逐条核对。
 * round 是本轮的轮次（连续打回次数 + 1）；sinceDiff 是上次被审查的提交到 HEAD 的 diff --stat。
 */
export function previousReviewOf(store: StateStore, flowId: string, task: TaskFile, maxRounds?: number): PreviousReview | null {
  const evs = store.readEvents().filter((e) => e.flow === flowId && e.task === task.id && e.type === 'transition'
    && (e.trigger === 'review_reject' || e.trigger === 'review_pass' || e.trigger === 'review_skip'));
  const last = evs.at(-1);
  if (last?.trigger !== 'review_reject') return null;
  let rejects = 0;
  for (let i = evs.length - 1; i >= 0 && evs[i]!.trigger === 'review_reject'; i--) rejects++;
  const head = typeof last.data?.['reviewed_head'] === 'string' ? last.data['reviewed_head'] : null;
  let sinceDiff: string | undefined;
  if (head && task.worktree) {
    try { sinceDiff = git(task.worktree, ['diff', '--stat', head, 'HEAD']).trim() || '（上次审查之后没有新的改动）'; } catch { /* 提交已不存在（worktree 重建） */ }
  }
  return { round: rejects + 1, issues: last.reason ?? '', ...(head ? { head } : {}), ...(sinceDiff ? { sinceDiff } : {}), ...(maxRounds ? { maxRounds } : {}) };
}

export class Engine {
  private readonly d: EngineDeps;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly verifying = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();

  private readonly mergeQueue: MergeQueue;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.mergeQueue = new MergeQueue(deps.root, deps.store, deps.config, { ...deps.mergeHooks, ...(deps.verifyTimeoutMs ? { verifyTimeoutMs: deps.verifyTimeoutMs } : {}) });
  }

  private now(): Date { return this.d.now?.() ?? new Date(); }

  /** ready 任务是否由引擎自动派发（workflow.yaml 的 limits.auto_dispatch，默认 true） */
  get autoDispatch(): boolean { return this.d.config.limits.auto_dispatch !== false; }

  /** 没有运行中的子进程、验证、合并等程序步骤 */
  isIdle(): boolean { return this.runs.size === 0 && this.pending.size === 0 && this.pumping === 0; }

  activeRuns(): { run_id: string; flow: string; task: string; role: string; pid: number | undefined }[] {
    return [...this.runs].map(([run_id, r]) => ({ run_id, flow: r.flow, task: r.task, role: r.role, pid: r.handle.pid }));
  }

  /** pending → ready（硬依赖已完成且属于当前活动阶段） */
  async promote(flowId: string): Promise<string[]> {
    const flow = this.d.store.readFlow(flowId);
    if (flow.stage_status !== 'active') return [];
    const ids = computeReady(this.d.store.listTasks(flowId), flow.stage);
    for (const id of ids) await this.d.store.transitionTask(flowId, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    return ids;
  }

  /** /flow next：由程序选择 ready 任务并派发，不经 LLM 决策 */
  async next(flowId: string): Promise<Dispatched[]> {
    await this.promote(flowId);
    const flow = this.d.store.readFlow(flowId);
    if (flow.sync?.status === 'conflict') return [];
    if (budgetState(this.d.store, this.d.config, flow)?.exceeded) return [];
    const held = heldByRevision(this.d.store, flowId);
    const ids = selectDispatchable(this.d.store.listTasks(flowId).filter((t) => !held.has(t.id) && !this.pausedFor(flowId, t)), flow.stage, this.d.config.limits.max_parallel);
    const out: Dispatched[] = [];
    for (const id of ids) out.push(await this.dispatch(flowId, id));
    return out;
  }

  /** 派发一个任务：ready → 实施；in_progress 无租约 → 重新派发实施；review 无租约 → 派发审查。立即返回 run_id。 */
  async dispatch(flowId: string, taskId: string): Promise<Dispatched> {
    const { store, root } = this.d;
    ensureLocalExcludes(root);
    const flow = store.readFlow(flowId);
    let task = store.readTask(flowId, taskId);
    const { role, model, thinking, reviewMode, escalated } = this.planModel(flowId, task);
    const paused = activePause(store, model, this.now());
    if (paused) throw new DispatchError(`${describePause(paused, this.now())}。恢复：/flow models resume ${paused.model}，或用 /flow-config 给 ${role} 换模型`);
    const runId = `r-${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    const lease = {
      run_id: runId, role, token_hash: hashToken(token), acquired_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + this.d.config.limits.lease_minutes * 60_000).toISOString(),
    };

    let fork: { run_id: string; session_file: string } | null = null;
    if (task.status === 'ready' && task.kind !== 'merge-fix' && flow.sync?.status === 'conflict') {
      throw new DispatchError(`同步 ${this.d.config.raw.main_branch} 到集成分支时冲突，需要你先处理（${flow.sync.reason ?? ''}），处理后执行 /flow sync`);
    }
    if (task.status === 'ready' && task.kind !== 'merge-fix' && budgetState(store, this.d.config, flow)?.exceeded) {
      throw new DispatchError('本流程的预算已用完，暂停派发新任务：用 /flow budget 提高预算后继续');
    }
    if (task.status === 'ready' && heldByRevision(store, flowId).has(taskId)) {
      throw new DispatchError(`任务 ${taskId} 在待批准的计划修订中（将被调整或取消），用户批准或打回修订前暂停派发`);
    }
    if (task.status === 'ready') {
      // merge-fix 任务的 worktree 由合并队列预先准备（含冲突标记），直接复用；
      // 承载先行验收测试的任务从测试分支末端开工，合并时把测试一并带入集成分支
      const carried = carriedTestOf(task, store.listTasks(flowId));
      if (carried && (carried.status !== 'done' || !carried.branch)) throw new DispatchError(`任务 ${taskId} 承载的验收测试 ${carried.id} 尚未确认（${carried.status}），不能开工`);
      const wt = task.worktree && task.branch && task.base_sha
        ? { path: task.worktree, branch: task.branch, base_sha: task.base_sha }
        : createTaskWorktree(root, flowId, taskId, flow.integration_branch, carried?.branch ?? flow.integration_branch);
      task = await store.transitionTask(flowId, taskId, {
        to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
        patch: { lease, worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha },
      });
    } else if ((task.status === 'in_progress' || task.status === 'review') && !task.lease) {
      if (!task.worktree) throw new DispatchError(`任务 ${taskId} 没有 worktree，无法继续`);
      // 返工：接着同一角色上一次提交时的对话继续（第三轮后续 2）
      if (task.status === 'in_progress') fork = this.forkSource(flowId, task, role, model);
      task = await store.acquireLease(flowId, taskId, lease, 'dispatcher');
    } else {
      throw new DispatchError(`任务 ${taskId} 当前是 ${task.status}${task.lease ? `（run ${task.lease.run_id} 运行中）` : ''}，不能派发`);
    }

    const sessionDir = sessionDirOf(root, runId);
    mkdirSync(sessionDir, { recursive: true });
    await store.createRun({
      ...(fork ? { forked_from: fork.run_id } : {}),
      run_id: runId, flow: flowId, task: taskId, role, model, started_at: this.now().toISOString(), ended_at: null,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: null, token_hash: lease.token_hash, violations: 0,
      session_dir: sessionDir, ...(escalated ? { escalated: true } : {}), ...(reviewMode ? { review_mode: reviewMode } : {}),
    });

    let handle: SubagentHandle;
    try {
      handle = this.d.launcher.launch({ ...this.buildSpec(flowId, task, role, runId, token, model, thinking, fork), sessionDir, ...(fork ? { forkFrom: fork.session_file } : {}) });
    } catch (e) {
      await this.failRun(flowId, taskId, runId, `子进程启动失败：${(e as Error).message}`);
      throw new DispatchError(`子进程启动失败：${(e as Error).message}`);
    }
    this.runs.set(runId, { flow: flowId, task: taskId, role, handle });
    if (handle.pid) await store.updateRun(runId, { pid: handle.pid }, 'dispatcher', '记录子进程');
    this.track(handle.done.then((r) => this.onExit(runId, r), (e) => this.onExit(runId, {
      exitCode: null, stderrTail: String(e), tokens: { input: null, output: null, cache_read: null, cache_write: null },
      model: null, turns: 0, stopReason: null, error: String(e), lastText: '',
    })));
    this.notify();
    return { run_id: runId, task: taskId, role, model };
  }

  /** 待审查任务：低风险且配置为 skip 时只做程序检查直接进入 verify；否则在审查并发上限内派发审查 */
  private async reviewStep(flowId: string, t: TaskFile): Promise<void> {
    const policy = reviewPolicy(this.d.config);
    const risk = assessRisk(this.d.config, t, this.d.store.listTasks(flowId), diffNumstat(t));
    if (risk.low && policy.lowRisk.mode === 'skip') {
      await this.d.store.transitionTask(flowId, t.id, { to: 'verifying', trigger: 'review_skip', actor: 'engine',
        facts: { low_risk: true, reason: '低风险（只改文档或测试、改动小），按配置只做程序检查，免审查' } });
      this.track(this.pump(flowId)); // 下一轮 pump 执行 verify（不能在本轮内等待，pump 是串行的）
      return;
    }
    // 派审查前先跑 verify（第三轮 1）：失败直接退回实施；通过后再派审查
    if (policy.verifyFirst && t.verify.length && !precheckOf(this.d.store, flowId, t)) {
      if (this.verifying.has(t.id)) return;
      this.verifying.add(t.id);
      this.track(runPrecheck(this.d.store, this.d.config, flowId, t, this.d.verifyTimeoutMs, { expectFail: this.expectFail(flowId, t) })
        .finally(() => this.verifying.delete(t.id))
        .then(() => { this.notify(); return this.pump(flowId); }));
      return;
    }
    const reviewing = [...this.runs.values()].filter((r) => r.role === REVIEWER_ROLE).length;
    if (reviewing >= policy.maxParallel) return; // 审查并发已满：有审查结束时 pump 会再来
    if (this.pausedFor(flowId, t)) return; // 审查模型暂停中：恢复后 pump 会再来
    await this.dispatch(flowId, t.id);
  }

  /** 派发这个任务会用的角色与模型：审查按风险分级（H），实施失败后升级（I） */
  private planModel(flowId: string, task: TaskFile): ModelPlan {
    const role = task.status === 'review' ? REVIEWER_ROLE : task.role;
    const base = this.modelFor(role);
    let model = base.model;
    // 按风险审查（H、第三轮 C）：低风险用便宜模型，高风险用强模型，其余用审查者自己的模型（取不到时都退回审查者的模型）
    let reviewMode: ReviewMode | undefined;
    if (role === REVIEWER_ROLE) {
      const risk = assessRisk(this.d.config, task, this.d.store.listTasks(flowId), diffNumstat(task));
      const policy = reviewPolicy(this.d.config).lowRisk;
      reviewMode = risk.low && policy.mode === 'cheap' ? 'light' : risk.high ? 'strong' : 'full';
      if (reviewMode === 'light') model = resolveModelRef(this.d.config, policy.model) ?? model;
      if (reviewMode === 'strong') model = strongReviewModel(this.d.config, this.d.roleSettings(), role, model) ?? model;
    }
    // 失败后升级模型（I）：同一任务失败达到次数后，实施换成升级模型
    let escalated = false;
    const esc = escalationPolicy(this.d.config);
    if (role !== REVIEWER_ROLE && esc.enabled && task.attempts >= esc.afterFailures) {
      const up = escalationModel(this.d.config, this.d.roleSettings(), role, model);
      if (up) { model = up; escalated = true; }
    }
    return { role, model, thinking: base.thinking, ...(reviewMode ? { reviewMode } : {}), escalated };
  }

  /** 任务下一次派发要用的模型正被暂停时返回暂停记录（没设置模型等其他问题交给 dispatch 报错） */
  pausedFor(flowId: string, task: TaskFile): ModelPause | null {
    if (task.lease || !['ready', 'in_progress', 'review'].includes(task.status)) return null;
    if (!this.d.store.readModelPauses().pauses.some((p) => pauseActive(p, this.now()))) return null;
    try {
      return activePause(this.d.store, this.planModel(flowId, task).model, this.now());
    } catch {
      return null;
    }
  }

  /** 测试必须先失败：fix 的复现测试，build/feature 的先行验收测试 */
  private expectFail(flowId: string, t: TaskFile): boolean {
    return t.kind === 'test' && (this.d.store.readFlow(flowId).mode === 'fix' || isLeadingTest(t, this.d.store.listTasks(flowId)));
  }

  private modelFor(role: string): { model: string; thinking: ThinkingLevel | null } {
    const r = resolveRoleModel(this.d.config, this.d.roleSettings(), role);
    if (!r.model) throw new DispatchError(`角色 ${role} 没有设置模型：请执行 /flow-config 为它选择模型，或在 workflow.yaml 的 models 中填写档位`);
    return { model: r.model, thinking: r.thinking };
  }

  /**
   * 返工时可以接着的上一次对话：同一任务、同一角色、同一模型最近一次正常提交的 run，会话文件还在且不太大。
   * 换了模型（例如失败升级）、关闭 limits.continue_session、或任务重新开工（ready）时从头开始。
   */
  private forkSource(flowId: string, task: TaskFile, role: string, model: string): { run_id: string; session_file: string } | null {
    if (role === REVIEWER_ROLE || this.d.config.limits.continue_session === false) return null;
    const prev = this.d.store.listRuns().filter((r) => r.flow === flowId && r.task === task.id && r.role === role && r.ended_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
    if (!prev || prev.outcome !== 'submitted' || prev.model !== model || !prev.session_file) return null;
    try {
      if (statSync(prev.session_file).size > MAX_FORK_BYTES) return null;
    } catch { return null; }
    return { run_id: prev.run_id, session_file: prev.session_file };
  }

  private buildSpec(flowId: string, task: TaskFile, role: string, runId: string, token: string, model: string, thinking: ThinkingLevel | null, fork: { run_id: string } | null = null): SubagentSpec {
    const { root, config, store } = this.d;
    const agent = loadAgent(role, root, this.d.packageAgentsDir);
    // 审查者使用被审任务的 scope 规则
    const { rules } = ruleFilesFor(config, root, task.scopes);
    const mode = role === REVIEWER_ROLE ? 'review' : 'impl';
    const diffStat = mode === 'review' && task.worktree && task.base_sha
      ? git(task.worktree, ['diff', '--stat', task.base_sha, 'HEAD']) : undefined;
    const previousReview = mode === 'review' ? previousReviewOf(store, flowId, task, reviewPolicy(config).maxRounds) : null;
    // 改动不大时把 diff 直接放进审查提示，省掉审查者自己 git diff 的一轮（第二轮起只附上次审查之后的改动）
    let inlineDiff: string | undefined;
    if (mode === 'review' && task.worktree && task.base_sha) {
      const from = previousReview?.head ?? task.base_sha;
      try {
        const d = git(task.worktree, ['diff', from, 'HEAD']);
        if (d.length <= INLINE_DIFF_MAX) inlineDiff = d;
      } catch { /* 上次审查的提交已不存在 */ }
    }
    // 重新派发时告诉实施者 worktree 里已有的改动（含未提交的），避免重做或覆盖
    let existingWork: string | undefined;
    if (mode === 'impl' && task.worktree && task.base_sha) {
      const status = git(task.worktree, ['status', '--porcelain', '-uall']).trim();
      const stat = git(task.worktree, ['diff', '--stat', task.base_sha]).trim();
      if (status || stat) existingWork = [stat, status && `未提交：\n${status}`].filter(Boolean).join('\n\n');
    }
    const skillNames = task.replan ? ['revise-plan', 'decompose-dag'] : [...(STAGE_SKILLS[task.stage] ?? []), ...(mode === 'impl' ? ['write-handoff'] : [])];
    const skills = skillNames.map((n) => {
      const f = this.d.packageSkillsDir ? path.join(this.d.packageSkillsDir, n, 'SKILL.md') : '';
      return f && existsSync(f) ? { path: `skills/${n}`, content: readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
    }).filter((x): x is { path: string; content: string } => !!x);
    const tasks = store.listTasks(flowId);
    const carried = carriedTestOf(task, tasks);
    // 实施类角色的临时目录（项目与 worktree 之外）：做实验、建临时文件，run 结束后删除
    const scratch = mode === 'impl' && config.role(role).writes.length ? scratchDir(root, runId) : undefined;
    if (scratch) mkdirSync(scratch, { recursive: true });
    const prompt = assemblePrompt({
      agent, rules, skills, task, flowId, handoff: store.readHandoff(flowId, task.id), mode, commands: config.commands,
      ...(carried ? { carriedTest: { id: carried.id, title: carried.title, writes: carried.writes } } : {}),
      ...(isLeadingTest(task, tasks) ? { leadingTest: true } : {}),
      knowledge: selectKnowledge(store.readKnowledge(), task).map(formatEntry),
      ...(scratch ? { scratchDir: scratch } : {}),
      ...(mode === 'review' ? { evidenceDir: path.join(root, '.flow', 'flows', flowId, 'evidence', task.id) } : {}),
      upstream: task.depends_on.flatMap((d) => {
        const u = tasks.find((x) => x.id === d.task);
        return u ? [{ id: u.id, title: u.title, type: d.type, status: u.status === 'done' ? '已完成' : `未完成：${u.status}`, handoff: store.readHandoff(flowId, u.id) }] : [];
      }),
      ...(diffStat !== undefined ? { diffStat } : {}),
      ...(previousReview ? { previousReview } : {}),
      ...(inlineDiff !== undefined ? { inlineDiff } : {}),
      ...(fork && mode === 'impl' ? { continuation: { run: fork.run_id } } : {}),
      ...(existingWork ? { existingWork } : {}),
    });
    const runDir = path.join(worktreesRoot(root), '.runs', runId);
    mkdirSync(runDir, { recursive: true });
    const systemFile = path.join(runDir, 'system.md');
    writeFileSync(systemFile, prompt.system);
    const r = config.role(role);
    return {
      cwd: task.worktree!,
      model,
      thinking: thinking ?? agent.thinking,
      tools: config.activeTools(role),
      extensions: [...(this.d.extraExtensions?.(role) ?? []), this.d.subagentExtension],
      appendSystemPromptFiles: [systemFile],
      prompt: prompt.user,
      env: {
        ...r.env,
        [RUN_ENV_KEYS.root]: root, [RUN_ENV_KEYS.flow]: flowId, [RUN_ENV_KEYS.task]: task.id,
        [RUN_ENV_KEYS.run]: runId, [RUN_ENV_KEYS.token]: token, [RUN_ENV_KEYS.role]: role,
      },
    };
  }

  private async failRun(flowId: string, taskId: string, runId: string, reason: string): Promise<void> {
    const t = this.d.store.readTask(flowId, taskId);
    if (t.lease?.run_id === runId && (t.status === 'in_progress' || t.status === 'review')) {
      await this.d.store.transitionTask(flowId, taskId, { to: t.status, trigger: 'run_failed', actor: 'dispatcher', facts: { reason } });
    }
  }

  private async onExit(runId: string, r: RunOutcome): Promise<void> {
    const active = this.runs.get(runId);
    this.runs.delete(runId);
    rmSync(scratchDir(this.d.root, runId), { recursive: true, force: true });
    if (!active) return;
    const { store } = this.d;
    const prev = store.readRun(runId);
    const leaseHeld = store.readTask(active.flow, active.task).lease?.run_id === runId;
    // 模型额度用完、限流、服务不可用：不是任务的问题，暂停这个模型而不是计失败
    const unavailable = leaseHeld ? classifyUnavailable(r.error, r.stderrTail, r.exitCode) : null;
    const outcome = prev.outcome ?? (leaseHeld ? (unavailable ? 'unavailable' : 'failed') : null);
    await store.updateRun(runId, {
      ended_at: this.now().toISOString(), tokens: r.tokens, model: r.model ?? prev.model, ...(outcome ? { outcome } : {}),
      ...(r.cost !== undefined ? { cost: r.cost } : {}), turns: r.turns,
      ...(prev.session_dir ? { session_file: findSessionFile(prev.session_dir) } : {}),
    }, 'dispatcher', 'run 结束');
    if (unavailable && prev.model) {
      const pause = await recordPause(store, { model: prev.model, role: active.role, flow: active.flow, task: active.task, u: unavailable, now: this.now() });
      const t = store.readTask(active.flow, active.task);
      if (t.lease?.run_id === runId && (t.status === 'in_progress' || t.status === 'review')) {
        await store.transitionTask(active.flow, active.task, { to: t.status, trigger: 'run_paused', actor: 'dispatcher', facts: { reason: describePause(pause, this.now()) } });
      }
    } else if (prev.model && r.turns > 0 && !r.error) {
      // 模型正常响应过：清除它残留的暂停记录（自动恢复后的第一次成功，连续暂停次数归零）
      const p = store.readModelPauses().pauses.find((x) => x.model === prev.model);
      if (p && !pauseActive(p, this.now())) await clearPause(store, prev.model, 'dispatcher', '恢复后已正常响应');
    }
    if (leaseHeld && !unavailable) {
      const why = r.error ?? (r.exitCode ? `退出码 ${r.exitCode}${r.stderrTail ? `：${r.stderrTail.slice(-300)}` : ''}` : '未提交就结束');
      await this.failRun(active.flow, active.task, runId, `子进程结束但没有${active.role === REVIEWER_ROLE ? '给出审查结论' : '提交'}（${why}）`);
    }
    this.notify();
    await this.pump(active.flow);
  }

  /** 程序步骤：promote、给待审查任务派审查、执行 verify、重新派发被打回或失败的任务。 */
  private pumpChain: Promise<void> = Promise.resolve();

  /** 程序步骤按流程串行执行：多个 run 同时结束时，避免并发地重复执行同一步骤 */
  pump(flowId: string): Promise<void> {
    this.pumping++;
    const next = this.pumpChain.then(() => this.pumpOnce(flowId), () => this.pumpOnce(flowId)).finally(() => { this.pumping--; });
    this.pumpChain = next.catch(() => {});
    return next;
  }

  /** 排队或执行中的程序步骤数（pump） */
  private pumping = 0;

  private async pumpOnce(flowId: string): Promise<void> {
    const report = this.d.onError ?? (() => {});
    // 阶段边界：本阶段还没同步过主分支时先同步（与合并互斥；合并进行中则下次再试）
    try {
      const flow = this.d.store.readFlow(flowId);
      if (flow.mode !== 'fix' && flow.stage_status === 'active' && flow.sync?.stage !== flow.stage) await this.sync(flowId);
    } catch (e) { report(e); }
    try {
      await this.promote(flowId);
    } catch (e) { report(e); }
    for (const listed of this.d.store.listTasks(flowId)) {
      try {
        // 循环中有 await，列表可能已过时（例如 verify 已结束并清除了 verifying 标记）：以最新状态为准
        const t = this.d.store.readTask(flowId, listed.id);
        if (t.lease) continue;
        if (t.status === 'review') {
          await this.reviewStep(flowId, t);
        } else if (t.status === 'in_progress') {
          if (!this.pausedFor(flowId, t)) await this.dispatch(flowId, t.id);
        } else if (t.status === 'verifying' && !this.verifying.has(t.id)) {
          this.verifying.add(t.id);
          this.track(runVerify(this.d.store, this.d.config, flowId, t, this.d.verifyTimeoutMs, { expectFail: this.expectFail(flowId, t) })
            .finally(() => this.verifying.delete(t.id))
            .then(() => { this.notify(); return this.pump(flowId); }));
        }
      } catch (e) { report(e); }
    }
    // merge-fix 是合并流程的一部分（原任务挂起等待它），由程序直接派发；仍受并发与互斥约束
    try {
      const flow = this.d.store.readFlow(flowId);
      const tasks = this.d.store.listTasks(flowId);
      const fixes = selectDispatchable(tasks, flow.stage, this.d.config.limits.max_parallel)
        .filter((id) => { const t = tasks.find((x) => x.id === id); return t?.kind === 'merge-fix' && !this.pausedFor(flowId, t); });
      for (const id of fixes) await this.dispatch(flowId, id);
    } catch (e) { report(e); }
    // merge-fix 最终失败：挂起的原任务一并转 blocked（第 10 节 merging → blocked）
    try {
      for (const s of this.d.store.readMergeQueue().suspended ?? []) {
        if (s.flow !== flowId) continue;
        const fix = this.d.store.readTask(flowId, s.merge_fix);
        if (fix.status === 'blocked') {
          await this.d.store.transitionTask(flowId, s.task, { to: 'blocked', trigger: 'merge_blocked', actor: 'merge-queue',
            facts: { reason: `merge-fix ${fix.id} 失败：${fix.blocked_reason ?? ''}` } });
        }
      }
    } catch (e) { report(e); }
    await this.advanceStage(flowId, report);
    // 自动派发（第三轮后续 5）：ready 任务由程序直接派发，不等 orchestrator 调用 flow_dispatch；修复流程由 fixStep 推进
    if (this.autoDispatch) {
      try {
        const flow = this.d.store.readFlow(flowId);
        if (flow.mode !== 'fix' && flow.stage_status === 'active') await this.next(flowId);
      } catch (e) { report(e); }
    }
    // 串行合并：合并名额空闲且队首就绪时处理
    const mq = this.d.store.readMergeQueue();
    if (!mq.merging && mq.queue[0]?.flow === flowId) {
      this.track(this.mergeQueue.processNext(flowId).then((r) => {
        if (r) this.d.onMerge?.(r);
        this.notify();
        return r ? this.pump(flowId) : undefined;
      }));
    }
    this.notify();
  }

  private readonly gating = new Set<string>();

  /** 阶段推进：设计阶段生成任务；本阶段任务全部完成时执行闸门；无需人工的闸门通过后进入下一阶段 */
  private async advanceStage(flowId: string, report: (e: unknown) => void, force = false): Promise<void> {
    const deps = { root: this.d.root, store: this.d.store, config: this.d.config };
    try {
      const flow = this.d.store.readFlow(flowId);
      if (flow.mode === 'fix') {
        await fixStep({ root: this.d.root, store: this.d.store, config: this.d.config,
          dispatch: (f, t) => (this.pausedFor(f, this.d.store.readTask(f, t)) ? Promise.resolve(null) : this.dispatch(f, t)),
          promote: (f) => this.promote(f), ...(this.d.now ? { now: this.d.now } : {}) }, flowId);
        return;
      }
      if (flow.stage_status !== 'active' || this.gating.has(flowId)) return;
      const created = await ensureStageTasks(deps, flowId);
      if (created.length) { await this.promote(flowId); this.notify(); return; }
      const stageTasks = this.d.store.listTasks(flowId).filter((t) => t.stage === flow.stage);
      if (!stageTasks.every(isSettled)) return;
      // 计划修订待用户批准时不提交闸门（批准后可能新增本阶段的任务）
      if (this.d.store.readRevision(flowId)?.status === 'proposed') return;
      if (!force && gateFailedWithoutChange(this.d.store, flowId, flow.stage)) return;
      await this.d.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      this.gating.add(flowId);
      this.notify();
      this.track(runStageGate(this.d.root, this.d.store, this.d.config, flowId, this.d.verifyTimeoutMs)
        .then(async (g) => {
          this.d.onGate?.(g);
          if (g.passed && !g.needsHuman) await this.d.store.advanceStage(flowId, 'gate');
        })
        .finally(() => this.gating.delete(flowId))
        .then(() => { this.notify(); return this.pump(flowId); }));
    } catch (e) { report(e); }
  }

  /** 把主分支同步进集成分支（阶段边界自动执行；/flow sync 手动执行）。合并进行中返回 null。 */
  async sync(flowId: string): Promise<SyncResult | null> {
    const r = await this.mergeQueue.syncMain(flowId);
    if (r) {
      this.d.onSync?.(flowId, r);
      if (r.kind === 'merge_fix') await this.promote(flowId);
      this.notify();
    }
    return r;
  }

  /** /flow gate：闸门失败后由用户手动重跑 */
  async rerunGate(flowId: string): Promise<void> {
    await this.advanceStage(flowId, this.d.onError ?? (() => {}), true);
    await this.idle();
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => (this.d.onError ?? (() => {}))(e)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** 租约到期仍在运行的 run：终止子进程，退出处理会按 run_failed 计一次失败。返回被终止的 run。 */
  checkLeases(): string[] {
    const killed: string[] = [];
    for (const [runId, r] of this.runs) {
      let t: TaskFile;
      try { t = this.d.store.readTask(r.flow, r.task); } catch { continue; }
      if (t.lease?.run_id === runId && this.now().getTime() >= Date.parse(t.lease.expires_at)) {
        r.handle.kill();
        killed.push(runId);
      }
    }
    return killed;
  }

  private watchTimer: NodeJS.Timeout | null = null;
  /** 已处理过的自动恢复（模型@恢复时间），避免同一次到期重复推进 */
  private readonly resumed = new Set<string>();

  /** 暂停到期的模型：推进受影响的流程（派发等它恢复的任务）。返回到期的模型。 */
  checkPauses(): string[] {
    const due = this.d.store.readModelPauses().pauses.filter((p) => p.retry_after && !pauseActive(p, this.now()) && !this.resumed.has(`${p.model}@${p.retry_after}`));
    for (const p of due) {
      this.resumed.add(`${p.model}@${p.retry_after}`);
      this.pumpFlowsOf(p);
    }
    return due.map((p) => p.model);
  }

  /** 用户恢复模型（/flow models resume）：删除暂停记录并推进受影响的流程 */
  async resumeModel(model: string): Promise<ModelPause | null> {
    const p = await clearPause(this.d.store, model, 'human', '用户恢复');
    if (p) this.pumpFlowsOf(p);
    this.notify();
    return p;
  }

  /** 角色模型改动后（/flow-config）：推进等待暂停模型的流程，换了模型的任务立即继续 */
  retryPaused(): void {
    for (const p of this.d.store.readModelPauses().pauses) this.pumpFlowsOf(p);
  }

  private pumpFlowsOf(p: ModelPause): void {
    const flows = new Set(p.tasks.map((k) => k.split('/')[0]!));
    for (const f of flows) {
      let flow;
      try { flow = this.d.store.readFlow(f); } catch { continue; }
      // 修复流程由 pump 推进；其他流程的 ready 任务由程序直接派发（与 /flow budget 提高预算后相同）
      const mode = flow.mode;
      this.track(this.pump(f).then(() => (mode !== 'fix' && this.d.store.readFlow(f).stage_status === 'active' ? this.next(f) : undefined)));
    }
  }

  /** 周期性检查租约（不阻止进程退出） */
  startLeaseWatch(intervalMs = 30_000): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      this.checkLeases();
      try { this.checkPauses(); } catch (e) { (this.d.onError ?? (() => {}))(e); }
    }, intervalMs);
    this.watchTimer.unref();
  }

  /** 订阅状态变化（用于主动通知）；返回取消订阅函数 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 等待任何状态变化（或超时）；用于 flow_wait */
  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (changed: boolean) => { clearTimeout(timer); this.listeners.delete(onChange); resolve(changed); };
      const onChange = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.listeners.add(onChange);
    });
  }

  /** 等到没有运行中的子进程与程序步骤（测试与关闭时使用） */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  kill(runId: string): void {
    this.runs.get(runId)?.handle.kill();
  }

  killAll(): void {
    for (const r of this.runs.values()) r.handle.kill();
  }
}
