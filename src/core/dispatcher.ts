// 引擎：派发（建 worktree、颁发 token、取得租约、组装提示、拉起子进程）与程序步骤（审查派发、verify、重新派发）。
// 调度与推进全部由代码决定；LLM 只通过 flow_* 工具提交申请。
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { RoleSettingsFile, TaskFile, ThinkingLevel } from './schemas.ts';
import type { RunOutcome, SubagentHandle, SubagentLauncher, SubagentSpec } from './launcher.ts';
import { hashToken } from './state-machine.ts';
import { resolveRoleModel } from './role-settings.ts';
import { loadAgent } from './agents.ts';
import { assemblePrompt, ruleFilesFor } from './prompt-assembler.ts';
import { computeReady } from './dag.ts';
import { selectDispatchable } from './scheduler.ts';
import { createTaskWorktree, ensureLocalExcludes, worktreesRoot } from './worktree.ts';
import { runVerify } from './verify-runner.ts';
import { git } from './git.ts';
import { RUN_ENV_KEYS } from '../tools/subagent-tools.ts';
import { MergeQueue, type MergeHooks, type MergeResult } from './merge-queue.ts';
import { runStageGate, gateFailedWithoutChange, type GateOutcome } from './gates.ts';
import { ensureStageTasks } from './stages.ts';
import { STAGE_SKILLS } from '../modes/plan.ts';
import { fixStep } from '../modes/fix.ts';
import { existsSync, readFileSync } from 'node:fs';

export const REVIEWER_ROLE = 'reviewer';

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
}

export interface Dispatched { run_id: string; task: string; role: string; model: string }

interface ActiveRun { flow: string; task: string; role: string; handle: SubagentHandle }

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
    const ids = selectDispatchable(this.d.store.listTasks(flowId), flow.stage, this.d.config.limits.max_parallel);
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
    const role = task.status === 'review' ? REVIEWER_ROLE : task.role;
    const { model, thinking } = this.modelFor(role);
    const runId = `r-${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    const lease = {
      run_id: runId, role, token_hash: hashToken(token), acquired_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + this.d.config.limits.lease_minutes * 60_000).toISOString(),
    };

    if (task.status === 'ready') {
      // merge-fix 任务的 worktree 由合并队列预先准备（含冲突标记），直接复用
      const wt = task.worktree && task.branch && task.base_sha
        ? { path: task.worktree, branch: task.branch, base_sha: task.base_sha }
        : createTaskWorktree(root, flowId, taskId, flow.integration_branch);
      task = await store.transitionTask(flowId, taskId, {
        to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
        patch: { lease, worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha },
      });
    } else if ((task.status === 'in_progress' || task.status === 'review') && !task.lease) {
      if (!task.worktree) throw new DispatchError(`任务 ${taskId} 没有 worktree，无法继续`);
      task = await store.acquireLease(flowId, taskId, lease, 'dispatcher');
    } else {
      throw new DispatchError(`任务 ${taskId} 当前是 ${task.status}${task.lease ? `（run ${task.lease.run_id} 运行中）` : ''}，不能派发`);
    }

    await store.createRun({
      run_id: runId, flow: flowId, task: taskId, role, model, started_at: this.now().toISOString(), ended_at: null,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: null, token_hash: lease.token_hash, violations: 0,
    });

    let handle: SubagentHandle;
    try {
      handle = this.d.launcher.launch(this.buildSpec(flowId, task, role, runId, token, model, thinking));
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

  private modelFor(role: string): { model: string; thinking: ThinkingLevel | null } {
    const r = resolveRoleModel(this.d.config, this.d.roleSettings(), role);
    if (!r.model) throw new DispatchError(`角色 ${role} 没有设置模型：请执行 /flow-config 为它选择模型，或在 workflow.yaml 的 models 中填写档位`);
    return { model: r.model, thinking: r.thinking };
  }

  private buildSpec(flowId: string, task: TaskFile, role: string, runId: string, token: string, model: string, thinking: ThinkingLevel | null): SubagentSpec {
    const { root, config, store } = this.d;
    const agent = loadAgent(role, root, this.d.packageAgentsDir);
    // 审查者使用被审任务的 scope 规则
    const { rules } = ruleFilesFor(config, root, task.scopes);
    const mode = role === REVIEWER_ROLE ? 'review' : 'impl';
    const diffStat = mode === 'review' && task.worktree && task.base_sha
      ? git(task.worktree, ['diff', '--stat', task.base_sha, 'HEAD']) : undefined;
    const skillNames = [...(STAGE_SKILLS[task.stage] ?? []), ...(mode === 'impl' ? ['write-handoff'] : [])];
    const skills = skillNames.map((n) => {
      const f = this.d.packageSkillsDir ? path.join(this.d.packageSkillsDir, n, 'SKILL.md') : '';
      return f && existsSync(f) ? { path: `skills/${n}`, content: readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
    }).filter((x): x is { path: string; content: string } => !!x);
    const prompt = assemblePrompt({
      agent, rules, skills, task, flowId, handoff: store.readHandoff(flowId, task.id), mode, commands: config.commands,
      ...(diffStat !== undefined ? { diffStat } : {}),
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
    if (!active) return;
    const { store } = this.d;
    const prev = store.readRun(runId);
    const leaseHeld = store.readTask(active.flow, active.task).lease?.run_id === runId;
    const outcome = prev.outcome ?? (leaseHeld ? 'failed' : null);
    await store.updateRun(runId, {
      ended_at: this.now().toISOString(), tokens: r.tokens, model: r.model ?? prev.model, ...(outcome ? { outcome } : {}),
    }, 'dispatcher', 'run 结束');
    if (leaseHeld) {
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
    const next = this.pumpChain.then(() => this.pumpOnce(flowId), () => this.pumpOnce(flowId));
    this.pumpChain = next.catch(() => {});
    return next;
  }

  private async pumpOnce(flowId: string): Promise<void> {
    const report = this.d.onError ?? (() => {});
    try {
      await this.promote(flowId);
    } catch (e) { report(e); }
    for (const t of this.d.store.listTasks(flowId)) {
      if (t.lease) continue;
      try {
        if (t.status === 'review' || t.status === 'in_progress') {
          await this.dispatch(flowId, t.id);
        } else if (t.status === 'verifying' && !this.verifying.has(t.id)) {
          this.verifying.add(t.id);
          const expectFail = t.kind === 'test' && this.d.store.readFlow(flowId).mode === 'fix';
          this.track(runVerify(this.d.store, this.d.config, flowId, t, this.d.verifyTimeoutMs, { expectFail })
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
        .filter((id) => tasks.find((t) => t.id === id)?.kind === 'merge-fix');
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
        await fixStep({ root: this.d.root, store: this.d.store, config: this.d.config, dispatch: (f, t) => this.dispatch(f, t),
          promote: (f) => this.promote(f), ...(this.d.now ? { now: this.d.now } : {}) }, flowId);
        return;
      }
      if (flow.stage_status !== 'active' || this.gating.has(flowId)) return;
      const created = await ensureStageTasks(deps, flowId);
      if (created.length) { await this.promote(flowId); this.notify(); return; }
      const stageTasks = this.d.store.listTasks(flowId).filter((t) => t.stage === flow.stage);
      if (!stageTasks.every((t) => t.status === 'done')) return;
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

  /** 周期性检查租约（不阻止进程退出） */
  startLeaseWatch(intervalMs = 30_000): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.checkLeases(), intervalMs);
    this.watchTimer.unref();
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
