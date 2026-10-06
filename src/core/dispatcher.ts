// 引擎：派发（建 worktree、颁发 token、取得租约、组装提示、拉起子进程）与程序步骤（推进阶段、验收、合并、重新派发）。
// 调度与推进全部由代码决定；LLM 只通过 flow_* 工具提交申请。
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { RoleSettingsFile, TaskFile, ThinkingLevel } from './schemas.ts';
import type { RunOutcome, SubagentHandle, SubagentLauncher, SubagentSpec } from './launcher.ts';
import { hashToken, isSettled } from './state-machine.ts';
import { resolveRoleModel } from './role-settings.ts';
import { loadAgent } from './agents.ts';
import { assemblePrompt, ruleFilesFor } from './prompt-assembler.ts';
import { formatEntry, selectKnowledge } from './knowledge.ts';
import { findSessionFile, sessionDirOf } from './session-log.ts';
import { seedTaskNotes } from './notes.ts';
import { taskNotesRel } from './state-store.ts';
import { heldByRevision } from './revision.ts';
import { budgetState, escalationModel, escalationPolicy, hardFanout, resolveModelRef } from './cost-control.ts';
import { computeReady } from './dag.ts';
import { selectDispatchable } from './scheduler.ts';
import { createTaskWorktree, ensureLocalExcludes, scratchDir, worktreePath as worktreePathOf, worktreesRoot } from './worktree.ts';
import { git } from './git.ts';
import { RUN_ENV_KEYS } from '../tools/subagent-tools.ts';
import { MergeQueue, type MergeHooks, type MergeResult, type SyncResult } from './merge-queue.ts';
import { runStageGate, gateFailedWithoutChange, type GateOutcome } from './gates.ts';
import { ensureStageTasks } from './stages.ts';
import { REQUIREMENTS_STAGE, reopenRequirements } from './requirements.ts';
import { finalReviewStep } from './final-review.ts';
import { acceptanceStep, allAccepted, failedOf, gateFailed } from './acceptance.ts';
import { DESIGN_STAGES } from '../modes/plan.ts';
import { PROPOSAL_STAGES, skillsFor } from '../modes/plan.ts';
import { fixStep } from '../modes/fix.ts';
import { existsSync, readFileSync } from 'node:fs';
import { killStrays } from './strays.ts';
import { activePause, classifyUnavailable, clearPause, describePause, pauseActive, recordPause } from './model-pause.ts';
import type { ModelPause } from './schemas.ts';

const tasksHas = (store: StateStore, flowId: string, id: string) => { try { store.readTask(flowId, id); return true; } catch { return false; } };
/**
 * 会话文件超过这个大小就不再接着（上下文太长，每轮重发的成本超过重新读代码）。
 * 真实冒烟：一次 175 轮的实施会话约 0.5 MB，接着它返工的两次运行缓存读合计上千万 token；1.5 MB → 400 KB。
 */
export const MAX_FORK_BYTES = 400_000;

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
  /** 子进程结束后结束它留在 worktree 里的进程（默认开；测试可关） */
  killStrayProcesses?: boolean;
  /** 主分支同步完成的回调 */
  onSync?: (flowId: string, r: SyncResult) => void;
}

export interface Dispatched { run_id: string; task: string; role: string; model: string }

interface ActiveRun { flow: string; task: string; role: string; handle: SubagentHandle }

/** 一次派发会用的角色与模型（失败升级之后） */
interface ModelPlan { role: string; model: string; thinking: ThinkingLevel | null; escalated: boolean }

export class Engine {
  private readonly d: EngineDeps;
  private readonly runs = new Map<string, ActiveRun>();
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

  /** 派发一个任务：ready → 开工；in_progress 无租约 → 重新派发（接着原会话）。立即返回 run_id。 */
  async dispatch(flowId: string, taskId: string): Promise<Dispatched> {
    const { store, root } = this.d;
    ensureLocalExcludes(root);
    const flow = store.readFlow(flowId);
    let task = store.readTask(flowId, taskId);
    const { role, model, thinking, escalated } = this.planModel(flowId, task);
    const paused = activePause(store, model, this.now());
    if (paused) throw new DispatchError(`${describePause(paused, this.now())}。恢复：/flow models resume ${paused.model}，或用 /flow-config 给 ${role} 换模型`);
    const runId = `r-${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    const lease = {
      run_id: runId, role, token_hash: hashToken(token), acquired_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + this.d.config.limits.lease_minutes * 60_000).toISOString(),
    };

    let fork: { run_id: string; session_file: string; task: string } | null = null;
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
      // merge-fix 任务的 worktree 由合并队列预先准备（含冲突标记），直接复用
      const wt = task.worktree && task.branch && task.base_sha
        ? { path: task.worktree, branch: task.branch, base_sha: task.base_sha }
        : createTaskWorktree(root, flowId, taskId, flow.integration_branch, flow.integration_branch);
      // 修复任务接着写过这些代码的任务的对话继续（第四轮后续）
      if (task.fork_from_task && tasksHas(store, flowId, task.fork_from_task)) fork = this.forkSource(flowId, store.readTask(flowId, task.fork_from_task), role, model);
      task = await store.transitionTask(flowId, taskId, {
        to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
        patch: { lease, worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha },
      });
    } else if (task.status === 'in_progress' && !task.lease) {
      if (!task.worktree) throw new DispatchError(`任务 ${taskId} 没有 worktree，无法继续`);
      // 返工：接着同一角色上一次提交时的对话继续（第三轮后续 2）
      fork = this.forkSource(flowId, task, role, model);
      task = await store.acquireLease(flowId, taskId, lease, 'dispatcher');
    } else {
      throw new DispatchError(`任务 ${taskId} 当前是 ${task.status}${task.lease ? `（run ${task.lease.run_id} 运行中）` : ''}，不能派发`);
    }

    // 任务第一次运行前填入初始笔记（第五轮）：目标是任务说明与验收标准，待完成是验收标准逐条
    if (!store.readNotes(taskNotesRel(flowId, taskId))) {
      const seed = seedTaskNotes(task);
      await store.writeNotes(taskNotesRel(flowId, taskId), (n) => { n.goal = seed.goal; n.todo = seed.todo; }, { actor: 'dispatcher', flow: flowId, task: taskId, reason: '初始笔记' });
    }

    const sessionDir = sessionDirOf(root, runId);
    mkdirSync(sessionDir, { recursive: true });
    await store.createRun({
      ...(fork ? { forked_from: fork.run_id } : {}),
      run_id: runId, flow: flowId, task: taskId, role, model, started_at: this.now().toISOString(), ended_at: null,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: null, token_hash: lease.token_hash, violations: 0,
      session_dir: sessionDir, ...(escalated ? { escalated: true } : {}),
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

  /** 派发这个任务会用的角色与模型：同一任务失败达到次数后（或被很多任务依赖的底座），实施换成升级模型 */
  private planModel(flowId: string, task: TaskFile): ModelPlan {
    const role = task.role;
    const base = this.modelFor(role);
    let model = base.model;
    let escalated = false;
    const esc = escalationPolicy(this.d.config);
    const critical = esc.criticalFanout > 0 && hardFanout(task, this.d.store.listTasks(flowId)) >= esc.criticalFanout;
    if (esc.enabled && (task.attempts >= esc.afterFailures || critical)) {
      const up = escalationModel(this.d.config, this.d.roleSettings(), role, model);
      if (up) { model = up; escalated = true; }
    }
    return { role, model, thinking: base.thinking, escalated };
  }

  /** 任务下一次派发要用的模型正被暂停时返回暂停记录（没设置模型等其他问题交给 dispatch 报错） */
  pausedFor(flowId: string, task: TaskFile): ModelPause | null {
    if (task.lease || !['ready', 'in_progress'].includes(task.status)) return null;
    if (!this.d.store.readModelPauses().pauses.some((p) => pauseActive(p, this.now()))) return null;
    try {
      return activePause(this.d.store, this.planModel(flowId, task).model, this.now());
    } catch {
      return null;
    }
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
  private forkSource(flowId: string, task: TaskFile, role: string, model: string): { run_id: string; session_file: string; task: string } | null {
    if (this.d.config.limits.continue_session === false) return null;
    const prev = this.d.store.listRuns().filter((r) => r.flow === flowId && r.task === task.id && r.role === role && r.ended_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
    if (!prev || prev.outcome !== 'submitted' || prev.model !== model || !prev.session_file) return null;
    try {
      if (statSync(prev.session_file).size > MAX_FORK_BYTES) return null;
    } catch { return null; }
    return { run_id: prev.run_id, session_file: prev.session_file, task: task.id };
  }

  private buildSpec(flowId: string, task: TaskFile, role: string, runId: string, token: string, model: string, thinking: ThinkingLevel | null, fork: { run_id: string; task: string } | null = null): SubagentSpec {
    const { root, config, store } = this.d;
    const agent = loadAgent(role, root, this.d.packageAgentsDir);
    const { rules } = ruleFilesFor(config, root, task.scopes);
    const mode = task.accept_of ? 'accept' : task.final_review ? 'review' : 'impl';
    // 独立验收：逐条验收全部标准，或只复查上次没通过的条目
    let accept: { kind: 'check' | 'confirm'; items: { id: string; text: string; last?: string }[] } | undefined;
    if (task.accept_of) {
      const a = store.readAcceptance(flowId, task.accept_of);
      if (a) {
        const lastOf = (id: string) => { const r = a.results.find((x) => x.id === id); return r ? `${r.passed ? '通过' : '未通过'}：${r.evidence}` : undefined; };
        const items = (task.accept_kind === 'confirm' ? failedOf(a) : a.criteria).map((c) => ({ ...c, ...(task.accept_kind === 'confirm' && lastOf(c.id) ? { last: lastOf(c.id)! } : {}) }));
        accept = { kind: task.accept_kind ?? 'check', items };
      }
    }
    // 重新派发时告诉实施者 worktree 里已有的改动（含未提交的），避免重做或覆盖
    let existingWork: string | undefined;
    if (mode === 'impl' && task.worktree && task.base_sha) {
      const status = git(task.worktree, ['status', '--porcelain', '-uall']).trim();
      const stat = git(task.worktree, ['diff', '--stat', task.base_sha]).trim();
      if (status || stat) existingWork = [stat, status && `未提交：\n${status}`].filter(Boolean).join('\n\n');
    }
    const skillNames = task.replan ? ['revise-plan', 'plan-modules'] : [...new Set([...skillsFor(task.stage, role), ...(mode === 'impl' && config.role(role).writes.length ? ['write-handoff'] : [])])];
    const skills = skillNames.map((n) => {
      const f = this.d.packageSkillsDir ? path.join(this.d.packageSkillsDir, n, 'SKILL.md') : '';
      return f && existsSync(f) ? { path: `skills/${n}`, content: readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
    }).filter((x): x is { path: string; content: string } => !!x);
    const tasks = store.listTasks(flowId);
    // 实施类角色的临时目录（项目与 worktree 之外）：做实验、建临时文件，run 结束后删除
    const scratch = (mode === 'impl' || mode === 'accept') && (config.role(role).writes.length || config.role(role).bash === 'full') ? scratchDir(root, runId) : undefined;
    if (scratch) mkdirSync(scratch, { recursive: true });
    const prompt = assemblePrompt({
      agent, rules, skills, task, flowId, handoff: store.readHandoff(flowId, task.id), mode, commands: config.commands,
      knowledge: selectKnowledge(store.readKnowledge(), task).map(formatEntry),
      ...(scratch ? { scratchDir: scratch } : {}),
      upstream: task.depends_on.flatMap((d) => {
        const u = tasks.find((x) => x.id === d.task);
        return u ? [{ id: u.id, title: u.title, type: d.type, status: u.status === 'done' ? '已完成' : `未完成：${u.status}`, handoff: store.readHandoff(flowId, u.id) }] : [];
      }),
      ...(fork && mode === 'impl' && fork.task === task.id ? { continuation: { run: fork.run_id } } : {}),
      ...(fork && mode === 'impl' && fork.task !== task.id ? { priorTask: { id: fork.task, title: store.readTask(flowId, fork.task).title, run: fork.run_id } } : {}),
      ...(existingWork ? { existingWork } : {}),
      ...(accept ? { accept } : {}),
      ...(mode === 'impl' && (PROPOSAL_STAGES.has(task.stage) || task.replan) ? { implModels: this.implModels(role) } : {}),
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

  /** 各实施角色（有 flow_submit 与可写范围，不含 architect）实际会用的模型；与 architect 同模型或是 strong 档视为强模型 */
  private implModels(architectRole: string): { role: string; model: string; strong: boolean }[] {
    const { config } = this.d;
    const arch = resolveRoleModel(config, this.d.roleSettings(), architectRole).model;
    const strongTier = resolveModelRef(config, 'strong');
    const out: { role: string; model: string; strong: boolean }[] = [];
    for (const r of Object.values(config.roles)) {
      if (r.name === architectRole || r.name === 'orchestrator' || !r.tools.has('flow_submit') || !r.writes.length) continue;
      const m = resolveRoleModel(config, this.d.roleSettings(), r.name).model;
      if (m) out.push({ role: r.name, model: m, strong: m === arch || m === strongTier });
    }
    return out;
  }

  private async failRun(flowId: string, taskId: string, runId: string, reason: string): Promise<void> {
    const t = this.d.store.readTask(flowId, taskId);
    if (t.lease?.run_id === runId && t.status === 'in_progress') {
      await this.d.store.transitionTask(flowId, taskId, { to: t.status, trigger: 'run_failed', actor: 'dispatcher', facts: { reason } });
    }
  }

  private async onExit(runId: string, r: RunOutcome): Promise<void> {
    const active = this.runs.get(runId);
    this.runs.delete(runId);
    // 子进程结束后，结束它在 worktree 或临时目录里留下的进程（例如被放到后台、没人等的测试）
    if (active && this.d.killStrayProcesses !== false) {
      const wt = this.d.store.readTask(active.flow, active.task).worktree ?? worktreePathOf(this.d.root, active.flow, active.task);
      const killed = killStrays([wt, scratchDir(this.d.root, runId)]);
      if (killed.length) await this.d.store.recordEvent({ flow: active.flow, task: active.task, actor: 'dispatcher', type: 'note', reason: `结束 ${runId} 留下的 ${killed.length} 个残留进程`, data: { run: runId, pids: killed } }).catch(() => {});
    }
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
      if (t.lease?.run_id === runId && t.status === 'in_progress') {
        await store.transitionTask(active.flow, active.task, { to: t.status, trigger: 'run_paused', actor: 'dispatcher', facts: { reason: describePause(pause, this.now()) } });
      }
    } else if (prev.model && r.turns > 0 && !r.error) {
      // 模型正常响应过：清除它残留的暂停记录（自动恢复后的第一次成功，连续暂停次数归零）
      const p = store.readModelPauses().pauses.find((x) => x.model === prev.model);
      if (p && !pauseActive(p, this.now())) await clearPause(store, prev.model, 'dispatcher', '恢复后已正常响应');
    }
    if (leaseHeld && !unavailable) {
      const why = r.error ?? (r.exitCode ? `退出码 ${r.exitCode}${r.stderrTail ? `：${r.stderrTail.slice(-300)}` : ''}` : '未提交就结束');
      await this.failRun(active.flow, active.task, runId, `子进程结束但没有提交（${why}）`);
    }
    this.notify();
    await this.pump(active.flow);
  }

  /** 程序步骤：promote、推进阶段与验收、合并、重新派发失败或被退回的任务。 */
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
        // 循环中有 await，列表可能已过时：以最新状态为准。失败或被打回、没有租约的任务重新派发（接着原会话）
        const t = this.d.store.readTask(flowId, listed.id);
        if (t.lease) continue;
        if (t.status === 'in_progress' && !this.pausedFor(flowId, t)) await this.dispatch(flowId, t.id);
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
      // 需求讨论（D0）由主会话和用户进行，提交需求说明后才执行闸门
      if (flow.stage === REQUIREMENTS_STAGE && !flow.requirements?.submitted) return;
      const created = await ensureStageTasks(deps, flowId);
      if (created.length) { await this.promote(flowId); this.notify(); return; }
      // 模块独立验收（第五轮）：模块合并后派验收；没通过的交回实现者修复、再复查。验收推进后可能有模块可以开工
      if (await acceptanceStep(deps, flowId)) { await this.promote(flowId); this.notify(); }
      const all = this.d.store.listTasks(flowId);
      const stageTasks = all.filter((t) => t.stage === flow.stage);
      if (!stageTasks.every(isSettled) || !allAccepted(all, flow.stage)) return;
      // 计划修订待用户批准时不提交闸门（批准后可能新增本阶段的任务）
      if (this.d.store.readRevision(flowId)?.status === 'proposed') return;
      // 最终代码审查（可选，review.final）：所有模块验收通过后、阶段闸门前；必须改的自动修，建议等用户挑选
      const review = await finalReviewStep(deps, flowId);
      if (review.changed) { await this.promote(flowId); this.notify(); }
      if (review.wait) return;
      if (!force && flow.stage !== REQUIREMENTS_STAGE && gateFailedWithoutChange(this.d.store, flowId, flow.stage)) return;
      await this.d.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      this.gating.add(flowId);
      this.notify();
      this.track(runStageGate(this.d.root, this.d.store, this.d.config, flowId, this.d.verifyTimeoutMs)
        .then(async (g) => {
          this.d.onGate?.(g);
          if (!g.passed) {
            // 实施阶段的全量测试失败：按日志交给负责的模块修复（最多两轮，之后需要你处理）
            if (g.failed && !DESIGN_STAGES.has(g.stage)) {
              const r = await gateFailed(deps, flowId, g.failed);
              if (r.reason) await this.d.store.recordEvent({ flow: flowId, actor: 'engine', type: 'note', reason: `需要你处理：${r.reason}`, data: { needs_human: true, stage: g.stage } });
            }
            // 设计阶段缺产出（例如没有提交模块清单、没有项目规则）：让写作者接着原会话补上，最多 3 次
            if (g.stage === REQUIREMENTS_STAGE) await reopenRequirements(this.d.store, flowId, `阶段检查未通过：${g.reasons.join('；')}`, 'gate');
            else if (DESIGN_STAGES.has(g.stage) && this.d.store.listTasks(flowId).filter((t) => t.stage === g.stage && t.title.startsWith('修订：')).length < 3) {
              await ensureStageTasks(deps, flowId, `阶段检查未通过：${g.reasons.join('；')}`);
            }
          }
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

  /** 运行中插话（/flow-add）：送到这个任务正在运行的子进程；没有运行中的子进程或不支持时返回 false */
  steer(flowId: string, taskId: string, message: string): boolean {
    for (const r of this.runs.values()) if (r.flow === flowId && r.task === taskId) return r.handle.steer?.(message) ?? false;
    return false;
  }

  kill(runId: string): void {
    this.runs.get(runId)?.handle.kill();
  }

  killAll(): void {
    for (const r of this.runs.values()) r.handle.kill();
  }
}
