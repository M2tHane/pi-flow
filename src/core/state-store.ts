// .flow/ 的唯一读写入口：文件锁、schema 校验、转移校验、事务日志、事件追加、git 提交。
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  readSync, statSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import {
  validate, type FlowFile, type MergeQueueFile, type RunFile, type ProposalFile, type BriefFile, type KnowledgeFile, type ModelPausesFile, type RevisionFile, type SchemaKind, type StageStatus, type StateFile,
  type TaskFile, type TaskStatus, type FlowEvent,
} from './schemas.ts';
import {
  IN_FLIGHT, planStageTransition, planTransition, type Facts, type StageTrigger, type TaskPatch, type Trigger,
} from './state-machine.ts';
import {
  EventCache, GENESIS_HASH, appendEvents, buildEvent, commitStateRef, readEvents, readLastEvent, sha256, untrackStateDir, verifyChain, type EventInput,
} from './event-log.ts';
import { conflictsWith } from './dag.ts';

export const FLOW_DIRNAME = '.flow';
const JOURNAL = 'tx.json';
const LOCK = '.lock';
const UNTRACKED = new Set(['state.json', 'events.jsonl', JOURNAL]);
const GITIGNORE = `${LOCK}\n${JOURNAL}\n*.tmp\n`;

export class StateError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(details.length ? `${message}：${details.join('；')}` : message);
    this.name = 'StateError';
    this.details = details;
  }
}

export interface StoreLimits { max_attempts: number; max_parallel: number }

export interface StoreOptions {
  now?: () => Date;
  git?: boolean;
  limits?: Partial<StoreLimits>;
  /** 仅测试用：模拟写入中途崩溃 */
  faultInjection?: 'after-journal' | 'mid-apply';
}

interface Journal {
  files: { rel: string; content: string }[];
  events: FlowEvent[];
  state: StateFile;
  message: string;
}

type StagedEvent = Omit<EventInput, 'ts'> & { ts?: string };

const TASK_PATCH_KEYS = new Set(['lease', 'worktree', 'branch', 'base_sha']);

export const flowRel = (flow: string) => `flows/${flow}/flow.json`;
export const taskRel = (flow: string, task: string) => `flows/${flow}/tasks/${task}.json`;
export const handoffRel = (flow: string, task: string) => `flows/${flow}/handoff/${task}.md`;
export const evidenceRel = (flow: string, task: string) => `flows/${flow}/evidence/${task}`;
export const runRel = (run: string) => `runs/${run}.json`;
export const proposalRel = (flow: string) => `flows/${flow}/proposal.json`;
export const revisionRel = (flow: string) => `flows/${flow}/revision.json`;
export const stageEvidenceRel = (flow: string, stage: string) => `flows/${flow}/evidence/stage-${stage}`;
const MQ_REL = 'merge-queue.json';
export const KNOWLEDGE_REL = 'knowledge.json';
export const MODEL_PAUSES_REL = 'model-pauses.json';

export function schemaKindOf(rel: string): SchemaKind | null {
  if (rel === MQ_REL) return 'merge-queue';
  if (/^flows\/[^/]+\/flow\.json$/.test(rel)) return 'flow';
  if (/^flows\/[^/]+\/tasks\/[^/]+\.json$/.test(rel)) return 'task';
  if (/^runs\/[^/]+\.json$/.test(rel)) return 'run';
  if (/^flows\/[^/]+\/proposal\.json$/.test(rel)) return 'proposal';
  if (/^flows\/[^/]+\/revision\.json$/.test(rel)) return 'revision';
  if (rel === 'brief.json') return 'brief';
  if (rel === KNOWLEDGE_REL) return 'knowledge';
  if (rel === MODEL_PAUSES_REL) return 'model-pauses';
  return null;
}

/** 一次事务内的暂存写入。只能在 StateStore.transaction 回调中使用。 */
export class Tx {
  readonly writes = new Map<string, { kind: SchemaKind | null; content: string; value?: unknown }>();
  readonly events: StagedEvent[] = [];
  activeFlow: string | null | undefined = undefined;

  private readonly store: StateStore;
  readonly ts: string;
  constructor(store: StateStore, ts: string) {
    this.store = store;
    this.ts = ts;
  }

  readJson<T>(rel: string): T | null {
    const staged = this.writes.get(rel);
    if (staged) return structuredClone(staged.value) as T;
    return this.store.readJsonRel<T>(rel);
  }

  readText(rel: string): string | null {
    const staged = this.writes.get(rel);
    if (staged) return staged.content;
    const abs = this.store.abs(rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }

  /** 写入带 version 的 JSON。value.version 必须等于当前版本（新文件忽略），写入时自动加 1。 */
  putJson<T extends { version: number }>(rel: string, kind: SchemaKind, value: T): T {
    const current = this.readJson<{ version: number }>(rel);
    if (current && value.version !== current.version) {
      throw new StateError(`版本冲突：${rel} 当前版本 ${current.version}，写入基于版本 ${value.version}，请重新读取后再试`);
    }
    const next = { ...structuredClone(value), version: current ? current.version + 1 : 1 };
    this.writes.set(rel, { kind, content: `${JSON.stringify(next, null, 2)}\n`, value: next });
    return next;
  }

  putText(rel: string, content: string): void {
    this.writes.set(rel, { kind: null, content });
  }

  readFlow(flow: string): FlowFile {
    return this.must(this.readJson<FlowFile>(flowRel(flow)), `流程 ${flow} 不存在`);
  }
  readTask(flow: string, task: string): TaskFile {
    return this.must(this.readJson<TaskFile>(taskRel(flow, task)), `任务 ${flow}/${task} 不存在`);
  }
  readMergeQueue(): MergeQueueFile {
    return this.must(this.readJson<MergeQueueFile>(MQ_REL), '合并队列文件缺失');
  }
  putFlow(f: FlowFile) { return this.putJson(flowRel(f.id), 'flow', f); }
  putTask(flow: string, t: TaskFile) { return this.putJson(taskRel(flow, t.id), 'task', t); }
  putMergeQueue(q: MergeQueueFile) { return this.putJson(MQ_REL, 'merge-queue', q); }
  putRun(r: RunFile) { return this.putJson(runRel(r.run_id), 'run', r); }
  putProposal(flow: string, p: ProposalFile) { return this.putJson(proposalRel(flow), 'proposal', p); }

  event(e: StagedEvent): void { this.events.push(e); }
  setActiveFlow(id: string | null): void { this.activeFlow = id; }

  private must<T>(v: T | null, msg: string): T {
    if (v === null) throw new StateError(msg);
    return v;
  }
}

export interface TransitionRequest {
  to: TaskStatus;
  trigger: Trigger;
  actor: string;
  facts?: Partial<Facts>;
  patch?: TaskPatch;
  evidence?: string;
}

export interface CreateFlowInput {
  mode: FlowFile['mode'];
  title: string;
  stages: string[];
  base_sha: string | null;
  actor?: string;
}

export type TaskInput = Pick<TaskFile, 'id' | 'stage' | 'kind' | 'title' | 'role' | 'scopes' | 'depends_on' | 'inputs'
  | 'writes' | 'acceptance' | 'verify'> & Partial<Pick<TaskFile, 'merge_fix_for' | 'conflict_files' | 'worktree' | 'branch' | 'base_sha' | 'sync_main' | 'replan'>>;

export type Findings = NonNullable<TaskFile['findings']>;

export interface IntegrityReport { ok: boolean; errors: string[] }

export interface ViolationInput {
  flow: string | null;
  task: string | null;
  run: string;
  role: string;
  tool: string;
  rule: string;
  reason: string;
  /** 被阻断调用的摘要（如 bash 命令），不含文件内容 */
  detail?: string;
}
export interface ViolationResult { count: number; terminate: boolean; blocked: boolean }

export class StateStore {
  readonly flowDir: string;
  private readonly now: () => Date;
  private readonly git: boolean;
  readonly limits: StoreLimits;
  readonly root: string;
  private readonly opts: StoreOptions;
  /** 读缓存：按 inode、mtime、大小失效（写入都是临时文件 + rename，inode 必变） */
  private readonly jsonCache = new Map<string, { ino: number; mtimeMs: number; size: number; value: unknown }>();
  private readonly eventCache = new EventCache();
  private migrated = false;

  constructor(root: string, opts: StoreOptions = {}) {
    this.root = root;
    this.opts = opts;
    this.flowDir = path.join(root, FLOW_DIRNAME);
    this.now = opts.now ?? (() => new Date());
    this.git = opts.git ?? true;
    this.limits = { max_attempts: 3, max_parallel: 2, ...opts.limits };
  }

  /** 初始化 .flow/ 骨架。已存在时不覆盖。 */
  static async init(root: string, opts: StoreOptions = {}): Promise<StateStore> {
    if (opts.git ?? true) {
      try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
      } catch {
        throw new StateError(`${root} 不是 git 仓库，请先执行 git init`);
      }
    }
    const store = new StateStore(root, opts);
    if (existsSync(path.join(store.flowDir, 'state.json'))) return store;
    mkdirSync(store.flowDir, { recursive: true });
    await store.transaction((tx) => {
      tx.putText('.gitignore', GITIGNORE);
      for (const d of ['flows', 'runs', 'fixes']) tx.putText(`${d}/.gitkeep`, '');
      tx.putMergeQueue({ queue: [], merging: null, version: 1 });
      tx.setActiveFlow(null);
      tx.event({ flow: null, actor: 'engine', type: 'note', reason: '初始化 .flow/' });
    });
    return store;
  }

  abs(rel: string): string {
    return path.join(this.flowDir, ...rel.split('/'));
  }

  // —— 读取（无锁；写入用 rename 保证原子可见） ——

  readJsonRel<T>(rel: string): T | null {
    const abs = this.abs(rel);
    let st;
    try { st = statSync(abs); } catch { this.jsonCache.delete(rel); return null; }
    const hit = this.jsonCache.get(rel);
    if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return structuredClone(hit.value) as T;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      throw new StateError(`${FLOW_DIRNAME}/${rel} 不是合法 JSON，请执行 /flow doctor`);
    }
    this.jsonCache.set(rel, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, value });
    return structuredClone(value) as T;
  }

  readState(): StateFile {
    const s = this.readJsonRel<StateFile>('state.json');
    if (!s) throw new StateError('尚未初始化，请执行 /flow init');
    return s;
  }
  readFlow(id: string): FlowFile {
    const f = this.readJsonRel<FlowFile>(flowRel(id));
    if (!f) throw new StateError(`流程 ${id} 不存在`);
    return f;
  }
  listFlows(): string[] {
    const dir = this.abs('flows');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'flow.json'))).sort();
  }
  readTask(flow: string, id: string): TaskFile {
    const t = this.readJsonRel<TaskFile>(taskRel(flow, id));
    if (!t) throw new StateError(`任务 ${flow}/${id} 不存在`);
    return t;
  }
  listTasks(flow: string): TaskFile[] {
    const dir = this.abs(`flows/${flow}/tasks`);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => this.readTask(flow, f.slice(0, -5)));
  }
  readMergeQueue(): MergeQueueFile {
    const q = this.readJsonRel<MergeQueueFile>(MQ_REL);
    if (!q) throw new StateError('合并队列文件缺失，请执行 /flow doctor');
    return q;
  }
  readHandoff(flow: string, task: string): string {
    const abs = this.abs(handoffRel(flow, task));
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  }
  /** 全部事件（增量缓存：只解析新追加的部分） */
  readEvents(): FlowEvent[] {
    return this.eventCache.read(this.abs('events.jsonl')).events;
  }

  // —— 事务 ——

  async transaction<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    if (!existsSync(this.flowDir)) throw new StateError('尚未初始化，请执行 /flow init');
    const release = await lockfile.lock(this.flowDir, {
      lockfilePath: path.join(this.flowDir, LOCK),
      retries: { retries: 200, factor: 1.2, minTimeout: 5, maxTimeout: 100 },
      stale: 15_000,
    });
    try {
      this.recoverLocked();
      const { last, state } = this.assertHeadConsistent();
      const tx = new Tx(this, this.now().toISOString());
      const result = await fn(tx);
      if (!tx.events.length) throw new StateError('每次状态写入都必须附带事件');
      this.commitLocked(tx, last, state);
      return result;
    } finally {
      await release();
    }
  }

  /** 重放未完成的事务日志（若有）。 */
  async recover(): Promise<boolean> {
    const release = await lockfile.lock(this.flowDir, { lockfilePath: path.join(this.flowDir, LOCK), retries: 50 });
    try {
      return this.recoverLocked();
    } finally {
      await release();
    }
  }

  private recoverLocked(): boolean {
    const jp = this.abs(JOURNAL);
    if (!existsSync(jp)) return false;
    const journal = JSON.parse(readFileSync(jp, 'utf8')) as Journal;
    this.applyJournal(journal, false);
    unlinkSync(jp);
    this.gitCommit(`${journal.message}（重放）`);
    return true;
  }

  /** 事务前校验：只读事件日志的最后一条，与 state.json 比较（耗时与事件数无关；完整校验见 verifyIntegrity） */
  private assertHeadConsistent() {
    const { event: last, error } = readLastEvent(this.abs('events.jsonl'));
    const state = this.readJsonRel<StateFile>('state.json');
    const head = last?.hash ?? GENESIS_HASH;
    const seq = last?.seq ?? 0;
    const bad = !!error || (state ? state.events_head !== head || state.version !== seq : !!last);
    if (bad) throw new StateError('状态完整性校验失败（state.json 与 events.jsonl 不一致），请执行 /flow doctor', error ? [error] : []);
    return { last, state };
  }

  private commitLocked(tx: Tx, last: FlowEvent | null, state: StateFile | null): void {
    const schemaErrors: string[] = [];
    for (const [rel, w] of tx.writes) {
      if (w.kind) schemaErrors.push(...validate(w.kind, w.value).map((e) => `${rel} ${e}`));
    }
    if (schemaErrors.length) throw new StateError('schema 校验失败', schemaErrors);

    const entities: Record<string, string> = {};
    for (const [rel, w] of tx.writes) entities[rel] = sha256(w.content);

    const built: FlowEvent[] = [];
    tx.events.forEach((e, i) => {
      const isLast = i === tx.events.length - 1;
      const input: EventInput = { ...e, ts: e.ts ?? tx.ts };
      if (isLast && tx.writes.size) input.entities = entities;
      if (isLast && tx.activeFlow !== undefined) input.active_flow = tx.activeFlow;
      const ev = buildEvent(built.at(-1) ?? last, input);
      const errs = validate('event', ev);
      if (errs.length) throw new StateError('事件 schema 校验失败', errs);
      built.push(ev);
    });
    const tail = built.at(-1)!;
    const nextState: StateFile = {
      schema_version: 1,
      version: tail.seq,
      active_flow: tx.activeFlow !== undefined ? tx.activeFlow : (state?.active_flow ?? null),
      events_head: tail.hash,
    };
    const journal: Journal = {
      files: [...tx.writes].map(([rel, w]) => ({ rel, content: w.content })),
      events: built,
      state: nextState,
      message: describe(built),
    };
    atomicWrite(this.abs(JOURNAL), JSON.stringify(journal));
    if (this.opts.faultInjection === 'after-journal') throw new Error('fault injected: after-journal');
    this.applyJournal(journal, this.opts.faultInjection === 'mid-apply');
    unlinkSync(this.abs(JOURNAL));
    this.gitCommit(journal.message);
  }

  private applyJournal(j: Journal, fault: boolean): void {
    j.files.forEach((f, i) => {
      atomicWrite(this.abs(f.rel), f.content);
      if (fault && i === 0) throw new Error('fault injected: mid-apply');
    });
    const ep = this.abs('events.jsonl');
    if (existsSync(ep) && !endsWithNewline(ep)) {
      // 去掉崩溃留下的不完整末行（少见，才读全文）
      const raw = readFileSync(ep, 'utf8');
      truncateSync(ep, Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
    }
    const lastSeq = readLastEvent(ep).event?.seq ?? 0;
    appendEvents(ep, j.events.filter((e) => e.seq > lastSeq));
    atomicWrite(this.abs('state.json'), `${JSON.stringify(j.state, null, 2)}\n`);
  }

  /** 状态提交到 refs/pi-flow/state，不进入主分支历史；早期版本留在分支上的 .flow/ 先迁移出去 */
  private gitCommit(message: string): void {
    if (!this.git) return;
    if (!this.migrated) {
      untrackStateDir(this.root, FLOW_DIRNAME);
      this.migrated = true;
    }
    commitStateRef(this.root, FLOW_DIRNAME, message);
  }

  // —— 业务写入 ——

  async createFlow(input: CreateFlowInput): Promise<FlowFile> {
    return this.transaction((tx) => {
      const state = this.readState();
      if (state.active_flow) {
        const cur = tx.readFlow(state.active_flow);
        if (!isFinished(cur)) {
          throw new StateError(`已有进行中的流程 ${cur.id}（${cur.title}），同一时间只允许一个；请使用 /flow resume 继续`);
        }
      }
      const nums = this.listFlows().map((id) => Number(id.slice(2)));
      const id = `${input.mode === 'build' ? 'B' : 'F'}-${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`;
      const flow = tx.putFlow({
        id, mode: input.mode, title: input.title, stages: input.stages, stage: input.stages[0]!,
        stage_status: 'active', integration_branch: `flow/${id}/integration`, base_sha: input.base_sha,
        approvals: {}, created_at: tx.ts, version: 1,
      });
      tx.setActiveFlow(id);
      tx.event({ flow: id, actor: input.actor ?? 'human', type: 'transition', from: 'none', to: 'active',
        data: { entity: 'flow', mode: input.mode, stage: flow.stage } });
      return flow;
    });
  }

  /** fix 流程：不占用活动流程指针（可在 build 流程等待审批时运行）；同一时间只允许一个未结束的 fix */
  async createFixFlow(title: string, mainBranch: string, baseSha: string): Promise<FlowFile> {
    return this.transaction((tx) => {
      const open = this.listFlows().map((id) => tx.readFlow(id)).find((f) => f.mode === 'fix' && !isFinished(f));
      if (open) throw new StateError(`已有进行中的修复 ${open.id}「${open.title}」，请等它完成或执行 /flow abort`);
      const nums = this.listFlows().map((id) => Number(id.slice(2)));
      const id = `X-${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`;
      const flow = tx.putFlow({
        id, mode: 'fix', title, stages: ['X1'], stage: 'X1', stage_status: 'active', integration_branch: mainBranch,
        base_sha: baseSha, approvals: {}, created_at: tx.ts, version: 1,
      });
      tx.event({ flow: id, actor: 'human', type: 'transition', from: 'none', to: 'active', data: { entity: 'flow', mode: 'fix' } });
      return flow;
    });
  }

  /** 未结束的 fix 流程（若有） */
  openFixFlow(): FlowFile | null {
    return this.listFlows().map((id) => this.readFlow(id)).find((f) => f.mode === 'fix' && !isFinished(f)) ?? null;
  }

  async setFindings(flow: string, task: string, findings: Findings, actor: string): Promise<TaskFile> {
    return this.transaction((tx) => {
      const t = tx.readTask(flow, task);
      const saved = tx.putTask(flow, { ...t, findings });
      tx.event({ flow, task, actor, type: 'note', reason: 'scout 结论', data: { ...findings } });
      return saved;
    });
  }

  async writeFixLog(name: string, content: string, flow: string): Promise<string> {
    if (!/^[\w.-]+\.md$/.test(name)) throw new StateError(`fix 日志文件名不合法：${name}`);
    return this.transaction((tx) => {
      const rel = `fixes/${name}`;
      tx.putText(rel, content);
      tx.event({ flow, actor: 'engine', type: 'note', reason: 'fix 日志', evidence: rel });
      return rel;
    });
  }

  listFixLogs(): string[] {
    const dir = this.abs('fixes');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  }

  async addTasks(flow: string, tasks: readonly TaskInput[], actor: string): Promise<TaskFile[]> {
    return this.transaction((tx) => {
      tx.readFlow(flow);
      const out = tasks.map((t) => {
        if (tx.readJson(taskRel(flow, t.id))) throw new StateError(`任务 ${flow}/${t.id} 已存在`);
        const task: TaskFile = {
          id: t.id, stage: t.stage, kind: t.kind, title: t.title, role: t.role, scopes: [...t.scopes],
          depends_on: structuredClone(t.depends_on), inputs: [...t.inputs], writes: [...t.writes],
          acceptance: [...t.acceptance], verify: [...t.verify], status: 'pending', attempts: 0, violations: 0,
          lease_expirations: 0, lease: null, impl_run: null, branch: t.branch ?? null, worktree: t.worktree ?? null, base_sha: t.base_sha ?? null,
          blocked_reason: null, last_failure: null, created_by: actor, version: 1,
          ...(t.merge_fix_for ? { merge_fix_for: t.merge_fix_for } : {}),
          ...(t.conflict_files ? { conflict_files: [...t.conflict_files] } : {}),
          ...(t.sync_main ? { sync_main: t.sync_main } : {}),
          ...(t.replan ? { replan: t.replan } : {}),
        };
        return tx.putTask(flow, task);
      });
      tx.event({ flow, actor, type: 'note', reason: `新增任务 ${out.length} 个`, data: { tasks: out.map((t) => t.id) } });
      return out;
    });
  }

  async transitionTask(flowId: string, taskId: string, req: TransitionRequest): Promise<TaskFile> {
    return this.transaction((tx) => {
      const flow = tx.readFlow(flowId);
      const task = tx.readTask(flowId, taskId);
      const others = this.listTasks(flowId).filter((t) => t.id !== taskId);
      const mq = tx.readMergeQueue();
      const key = (e: { flow: string; task: string }) => `${e.flow}/${e.task}`;
      const me = `${flowId}/${taskId}`;
      const merging = mq.merging ? key(mq.merging) : null;

      const facts: Facts = {
        ...req.facts,
        now: this.now(),
        limits: this.limits,
        actor: req.actor,
        // 以下由程序推导，覆盖调用方传入的同名字段
        stage_active: flow.stage === task.stage && flow.stage_status === 'active',
        status_of: new Map(others.map((t) => [t.id, t.status])),
        running_count: others.filter((t) => t.status === 'in_progress').length,
        conflicting_running: others.filter((t) => IN_FLIGHT.includes(t.status) && t.id !== task.merge_fix_for && conflictsWith(t, task)).map((t) => t.id),
        merging_other: merging && merging !== me ? merging : null,
        queue_head: mq.queue[0] ? key(mq.queue[0]) === me : false,
        handoff_written: (tx.readText(handoffRel(flowId, taskId)) ?? '').trim().length > 0,
        evidence_saved: this.hasEvidence(tx, flowId, taskId),
        contracts_locked: 'S1' in flow.approvals || 'F1' in flow.approvals,
      };
      const plan = planTransition(task, req.to, req.trigger, facts, req.patch);
      if (!plan.ok) throw new StateError(`转移被拒（${me} ${task.status} -> ${req.to}）`, plan.errors);

      const saved = tx.putTask(flowId, plan.task);
      this.applyQueueEffects(tx, mq, flowId, taskId, task.status, plan.to);
      tx.event({
        flow: flowId, actor: req.actor, type: 'transition', task: taskId, from: task.status, to: plan.to,
        trigger: req.trigger,
        ...(facts.reason || plan.task.blocked_reason ? { reason: facts.reason ?? plan.task.blocked_reason! } : {}),
        ...(req.evidence ? { evidence: req.evidence } : {}),
      });
      return saved;
    });
  }

  private applyQueueEffects(tx: Tx, mq: MergeQueueFile, flow: string, task: string, from: TaskStatus, to: TaskStatus) {
    const same = (e: { flow: string; task: string }) => e.flow === flow && e.task === task;
    let changed = false;
    if (to === 'queued_merge' && from === 'verifying') {
      if (!mq.queue.some(same)) mq.queue.push({ flow, task, enqueued_at: tx.ts });
      changed = true;
    } else if (to === 'queued_merge' && from === 'merging') {
      mq.merging = null;
      mq.queue = [{ flow, task, enqueued_at: tx.ts }, ...mq.queue.filter((e) => !same(e))];
      changed = true;
    } else if (to === 'merging') {
      mq.queue = mq.queue.filter((e) => !same(e));
      mq.merging = { flow, task, started_at: tx.ts };
      changed = true;
    } else if (from === 'merging' || from === 'queued_merge') {
      if (mq.merging && same(mq.merging)) mq.merging = null;
      mq.queue = mq.queue.filter((e) => !same(e));
      if (mq.suspended?.some(same)) mq.suspended = mq.suspended.filter((e) => !same(e));
      changed = true;
    }
    if (changed) tx.putMergeQueue(mq);
  }

  /**
   * 合并时出现 writes 内的文本冲突：原任务保持 merging 但让出合并名额，同一事务内新增 merge-fix 任务并记录 merge_conflict 事件。
   */
  async suspendMerge(flow: string, task: string, fix: TaskInput, conflicts: string[]): Promise<TaskFile> {
    return this.transaction((tx) => {
      const t = tx.readTask(flow, task);
      if (t.status !== 'merging') throw new StateError(`任务 ${task} 不在 merging 状态，不能挂起合并`);
      const mq = tx.readMergeQueue();
      if (!mq.merging || mq.merging.flow !== flow || mq.merging.task !== task) throw new StateError(`${task} 不是当前正在合并的任务`);
      if (tx.readJson(taskRel(flow, fix.id))) throw new StateError(`任务 ${flow}/${fix.id} 已存在`);
      const m = tx.putTask(flow, {
        id: fix.id, stage: fix.stage, kind: 'merge-fix', title: fix.title, role: fix.role, scopes: [...fix.scopes],
        depends_on: [], inputs: [...fix.inputs], writes: [...fix.writes], acceptance: [...fix.acceptance], verify: [...fix.verify],
        status: 'pending', attempts: 0, violations: 0, lease_expirations: 0, lease: null, impl_run: null,
        branch: fix.branch ?? null, worktree: fix.worktree ?? null, base_sha: fix.base_sha ?? null, blocked_reason: null,
        last_failure: null, merge_fix_for: task, conflict_files: [...conflicts], created_by: 'merge-queue', version: 1,
      });
      mq.merging = null;
      mq.suspended = [...(mq.suspended ?? []), { flow, task, merge_fix: fix.id, since: tx.ts }];
      tx.putMergeQueue(mq);
      tx.event({ flow, task, actor: 'merge-queue', type: 'merge_conflict', reason: `文本冲突在 writes 内，生成 ${fix.id}`,
        data: { conflicts, merge_fix: fix.id } });
      return m;
    });
  }

  private hasEvidence(tx: Tx, flow: string, task: string): boolean {
    const prefix = `${evidenceRel(flow, task)}/`;
    if ([...tx.writes.keys()].some((k) => k.startsWith(prefix))) return true;
    const dir = this.abs(evidenceRel(flow, task));
    return existsSync(dir) && readdirSync(dir).length > 0;
  }

  /** 修改非状态字段（租约、worktree 等），例如为 review 派发审查 run。状态只能经 transitionTask 改变。 */
  async updateTask(flow: string, id: string, patch: TaskPatch, ev: { actor: string; type: 'dispatch' | 'note' | 'lease_expired'; reason?: string; data?: Record<string, unknown> }): Promise<TaskFile> {
    const bad = Object.keys(patch).filter((k) => !TASK_PATCH_KEYS.has(k));
    if (bad.length) throw new StateError(`updateTask 不能修改字段：${bad.join('、')}；状态变更请走转移表`);
    return this.transaction((tx) => {
      const t = tx.readTask(flow, id);
      const next = tx.putTask(flow, { ...t, ...structuredClone(patch) });
      tx.event({ flow, task: id, ...ev });
      return next;
    });
  }

  /** 为 in_progress/review 且没有租约的任务取得租约（重新派发、派审查）。在事务内检查，避免并发重复派发。 */
  async acquireLease(flow: string, id: string, lease: NonNullable<TaskFile['lease']>, actor: string, data: Record<string, unknown> = {}): Promise<TaskFile> {
    return this.transaction((tx) => {
      const t = tx.readTask(flow, id);
      if (t.lease) throw new StateError(`任务 ${id} 已有运行中的 run ${t.lease.run_id}`);
      if (t.status !== 'in_progress' && t.status !== 'review') throw new StateError(`任务 ${id} 当前是 ${t.status}，不能取得租约`);
      const next = tx.putTask(flow, { ...t, lease });
      tx.event({ flow, task: id, actor, type: 'dispatch', data: { run: lease.run_id, role: lease.role, ...data } });
      return next;
    });
  }

  /**
   * 续租（心跳）：校验 run 与 token 后把租约到期时间延长到 expiresAt。租约已被收回、已过期或 token 不符时拒绝；
   * 只延长不缩短。由子进程在工具调用时按需调用（剩余不足一半时），避免每次调用都产生状态提交。
   */
  async renewLease(flow: string, id: string, runId: string, tokenHash: string, expiresAt: string, actor: string): Promise<TaskFile> {
    return this.transaction((tx) => {
      const t = tx.readTask(flow, id);
      const l = t.lease;
      if (!l || l.run_id !== runId || l.token_hash !== tokenHash) throw new StateError(`任务 ${id} 的租约不属于 run ${runId}，不能续租`);
      if (this.now().getTime() >= Date.parse(l.expires_at)) throw new StateError(`任务 ${id} 的租约已过期，不能续租`);
      if (t.status !== 'in_progress' && t.status !== 'review') throw new StateError(`任务 ${id} 当前是 ${t.status}，不能续租`);
      if (Date.parse(expiresAt) <= Date.parse(l.expires_at)) return t;
      const next = tx.putTask(flow, { ...t, lease: { ...l, expires_at: expiresAt } });
      tx.event({ flow, task: id, actor, type: 'note', reason: '续租', data: { run: runId, from: l.expires_at, to: expiresAt } });
      return next;
    });
  }

  async appendHandoff(flow: string, task: string, text: string, actor: string): Promise<void> {
    await this.transaction((tx) => {
      tx.readTask(flow, task);
      const rel = handoffRel(flow, task);
      tx.putText(rel, `${tx.readText(rel) ?? ''}\n## ${tx.ts} ${actor}\n\n${text.trim()}\n`);
      tx.event({ flow, task, actor, type: 'note', reason: 'handoff' });
    });
  }

  async saveEvidence(flow: string, task: string, name: string, content: string, actor: string): Promise<string> {
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new StateError(`evidence 文件名不合法：${name}`);
    return this.transaction((tx) => {
      tx.readTask(flow, task);
      const rel = `${evidenceRel(flow, task)}/${name}`;
      tx.putText(rel, content);
      tx.event({ flow, task, actor, type: 'note', reason: 'evidence', evidence: rel });
      return rel;
    });
  }

  async createRun(run: Omit<RunFile, 'version'>): Promise<RunFile> {
    return this.transaction((tx) => {
      if (tx.readJson(runRel(run.run_id))) throw new StateError(`run ${run.run_id} 已存在`);
      const saved = tx.putRun({ ...run, version: 1 });
      tx.event({ flow: run.flow, ...(run.task ? { task: run.task } : {}), actor: 'dispatcher', type: 'dispatch',
        data: { run: run.run_id, role: run.role, model: run.model } });
      return saved;
    });
  }

  /** 更新 run 记录（结束时间、token、模型、结果）。 */
  async updateRun(id: string, patch: Partial<Pick<RunFile, 'ended_at' | 'tokens' | 'model' | 'outcome' | 'pid' | 'session_file' | 'cost'>>, actor: string, reason?: string): Promise<RunFile> {
    return this.transaction((tx) => {
      const run = tx.readJson<RunFile>(runRel(id));
      if (!run) throw new StateError(`run ${id} 不存在`);
      const saved = tx.putRun({ ...run, ...patch });
      tx.event({ flow: run.flow, ...(run.task ? { task: run.task } : {}), actor, type: 'note', reason: reason ?? 'run 更新',
        data: { run: id, ...(patch.outcome ? { outcome: patch.outcome } : {}) } });
      return saved;
    });
  }

  listRuns(): RunFile[] {
    const dir = this.abs('runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => this.readRun(f.slice(0, -5)));
  }

  readRun(id: string): RunFile {
    const r = this.readJsonRel<RunFile>(runRel(id));
    if (!r) throw new StateError(`run ${id} 不存在`);
    return r;
  }

  /**
   * 记录一次 guard 阻断。按 run 累计违规次数（以事件日志为准）；达到上限时任务转 blocked、run 标记为 killed，
   * 返回 terminate=true，由调用方终止子进程。
   */
  async recordViolation(v: ViolationInput, maxPerRun: number): Promise<ViolationResult> {
    return this.transaction((tx) => {
      const count = this.readEvents().filter((e) => e.type === 'violation' && e.data?.['run'] === v.run).length + 1;
      const terminate = count >= maxPerRun;
      let blocked = false;
      tx.event({
        flow: v.flow, ...(v.task ? { task: v.task } : {}), actor: `run:${v.run}`, type: 'violation', reason: v.reason,
        data: { run: v.run, role: v.role, tool: v.tool, rule: v.rule, count, ...(v.detail ? { detail: v.detail } : {}) },
      });
      const run = tx.readJson<RunFile>(runRel(v.run));
      if (run) {
        run.violations = count;
        if (terminate) { run.outcome = 'killed'; run.ended_at = tx.ts; }
        tx.putRun(run);
      }
      if (v.flow && v.task) {
        let task = tx.readTask(v.flow, v.task);
        task.violations += 1;
        if (terminate && IN_FLIGHT.includes(task.status)) {
          const reason = `run ${v.run} 违规次数达到上限 ${maxPerRun}，已终止；最后一次：${v.reason}`;
          const plan = planTransition(task, 'blocked', 'block', { now: this.now(), limits: this.limits, actor: 'guard', reason });
          if (plan.ok) {
            tx.event({ flow: v.flow, task: v.task, actor: 'guard', type: 'transition', from: task.status, to: 'blocked', trigger: 'block', reason });
            task = plan.task;
            blocked = true;
          }
        }
        tx.putTask(v.flow, task);
      }
      return { count, terminate, blocked };
    });
  }

  /** 项目级知识库（跨流程）；尚无条目时返回空库 */
  readKnowledge(): KnowledgeFile {
    return this.readJsonRel<KnowledgeFile>(KNOWLEDGE_REL) ?? { entries: [], version: 0 };
  }

  /** 修改知识库：mutate 在事务内收到当前库（可原地修改），返回值原样返回；业务校验见 core/knowledge.ts */
  async writeKnowledge<T>(mutate: (k: KnowledgeFile, ts: string) => T, event: { actor: string; flow?: string | null; task?: string; reason: string; data?: Record<string, unknown> }): Promise<T> {
    return this.transaction((tx) => {
      const cur = tx.readJson<KnowledgeFile>(KNOWLEDGE_REL);
      const k: KnowledgeFile = cur ?? { entries: [], version: 1 };
      const result = mutate(k, tx.ts);
      tx.putJson(KNOWLEDGE_REL, 'knowledge', k);
      tx.event({ flow: event.flow ?? null, ...(event.task ? { task: event.task } : {}), actor: event.actor, type: 'note', reason: event.reason, ...(event.data ? { data: event.data } : {}) });
      return result;
    });
  }

  /** 项目级模型暂停记录（跨流程）；没有时返回空表 */
  readModelPauses(): ModelPausesFile {
    return this.readJsonRel<ModelPausesFile>(MODEL_PAUSES_REL) ?? { pauses: [], version: 0 };
  }

  /** 修改模型暂停记录：mutate 在事务内收到当前记录（可原地修改）；业务规则见 core/model-pause.ts */
  async writeModelPauses<T>(mutate: (f: ModelPausesFile, ts: string) => T, event: { actor: string; flow?: string | null; task?: string; reason: string; data?: Record<string, unknown> }): Promise<T> {
    return this.transaction((tx) => {
      const cur = tx.readJson<ModelPausesFile>(MODEL_PAUSES_REL);
      const f: ModelPausesFile = cur ?? { pauses: [], version: 1 };
      const result = mutate(f, tx.ts);
      tx.putJson(MODEL_PAUSES_REL, 'model-pauses', f);
      tx.event({ flow: event.flow ?? null, ...(event.task ? { task: event.task } : {}), actor: event.actor, type: 'note', reason: event.reason, ...(event.data ? { data: event.data } : {}) });
      return result;
    });
  }

  readBrief(): BriefFile | null {
    return this.readJsonRel<BriefFile>('brief.json');
  }

  /** 写入需求访谈摘要；mutate 收到当前摘要（可能为 null），返回新摘要 */
  async writeBrief(mutate: (cur: BriefFile | null, ts: string) => Omit<BriefFile, 'version'> & { version?: number }, actor: string, reason: string): Promise<BriefFile> {
    return this.transaction((tx) => {
      const cur = tx.readJson<BriefFile>('brief.json');
      const next = mutate(cur, tx.ts);
      const saved = tx.putJson('brief.json', 'brief', { ...next, version: cur?.version ?? 1 });
      tx.event({ flow: next.flow, actor, type: 'note', reason, data: { brief: next.mode, status: next.status } });
      return saved;
    });
  }

  /** 流程的需求摘要（访谈确认后写入），供设计阶段任务与 scout 使用 */
  async saveFlowBrief(flow: string, markdown: string): Promise<void> {
    await this.transaction((tx) => {
      tx.readFlow(flow);
      tx.putText(`flows/${flow}/brief.md`, markdown);
      tx.event({ flow, actor: 'human', type: 'note', reason: '需求摘要' });
    });
  }

  readFlowBrief(flow: string): string {
    const abs = this.abs(`flows/${flow}/brief.md`);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  }

  readProposal(flow: string): ProposalFile | null {
    return this.readJsonRel<ProposalFile>(proposalRel(flow));
  }

  /** 保存（或替换）任务提案；已有提案时基于其版本覆盖 */
  async saveProposal(flow: string, proposal: Omit<ProposalFile, 'version'>, actor: string): Promise<ProposalFile> {
    return this.transaction((tx) => {
      tx.readFlow(flow);
      const cur = tx.readJson<ProposalFile>(proposalRel(flow));
      const saved = tx.putProposal(flow, { ...proposal, version: cur?.version ?? 1 });
      tx.event({ flow, actor, type: 'note', reason: `${cur ? '替换' : '提交'}任务提案：${proposal.tasks.length} 个任务`,
        data: { stage: proposal.stage, tasks: proposal.tasks.length, critical_path: proposal.report.critical_path_length } });
      return saved;
    });
  }

  async saveStageEvidence(flow: string, stage: string, name: string, content: string, actor: string): Promise<string> {
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new StateError(`evidence 文件名不合法：${name}`);
    return this.transaction((tx) => {
      tx.readFlow(flow);
      const rel = `${stageEvidenceRel(flow, stage)}/${name}`;
      tx.putText(rel, content);
      tx.event({ flow, actor, type: 'note', reason: 'stage evidence', evidence: rel, data: { stage } });
      return rel;
    });
  }

  async recordEvent(e: StagedEvent): Promise<void> {
    await this.transaction((tx) => tx.event(e));
  }

  async transitionStage(flowId: string, req: { to: StageStatus; trigger: StageTrigger; actor: string; reason?: string; needs_human?: boolean; note?: string }): Promise<FlowFile> {
    return this.transaction((tx) => {
      const flow = tx.readFlow(flowId);
      const errors = planStageTransition(flow.stage_status, req.to, req.trigger, req);
      if (errors.length) throw new StateError(`阶段转移被拒（${flowId} ${flow.stage} ${flow.stage_status} -> ${req.to}）`, errors);
      const from = flow.stage_status;
      flow.stage_status = req.to;
      if (req.trigger === 'approve') flow.approvals[flow.stage] = { by: 'human', at: tx.ts, ...(req.note ? { note: req.note } : {}) };
      const next = tx.putFlow(flow);
      if (req.to === 'aborted' && flow.mode !== 'fix') tx.setActiveFlow(null);
      const type = req.trigger === 'approve' ? 'approval' : req.trigger.startsWith('gate_') ? 'gate_result' : 'transition';
      tx.event({ flow: flowId, actor: req.actor, type, from, to: req.to, trigger: req.trigger,
        data: { entity: 'stage', stage: flow.stage }, ...(req.reason ? { reason: req.reason } : {}) });
      return next;
    });
  }

  /** 当前阶段 done 后进入下一阶段；最后一个阶段完成时流程结束，清除活动流程指针。 */
  readRevision(flow: string): RevisionFile | null {
    return this.readJsonRel<RevisionFile>(revisionRel(flow));
  }

  /** 保存（或替换）计划修订提案；已批准或已打回的会被新的提案覆盖 */
  async saveRevision(flow: string, rev: Omit<RevisionFile, 'version'>, actor: string): Promise<RevisionFile> {
    return this.transaction((tx) => {
      tx.readFlow(flow);
      const cur = tx.readJson<RevisionFile>(revisionRel(flow));
      const saved = tx.putJson(revisionRel(flow), 'revision', { ...rev, version: cur?.version ?? 1 });
      tx.event({ flow, task: rev.task, actor, type: 'note', reason: `计划修订提案：${rev.summary}`.slice(0, 500),
        data: { add: rev.add.length, rewire: rev.rewire.length, cancel: rev.cancel.length } });
      return saved;
    });
  }

  /** 打回计划修订（仅用户） */
  async rejectRevision(flow: string, note: string): Promise<RevisionFile> {
    return this.transaction((tx) => {
      const cur = tx.readJson<RevisionFile>(revisionRel(flow));
      if (!cur || cur.status !== 'proposed') throw new StateError('没有待批准的计划修订');
      const saved = tx.putJson(revisionRel(flow), 'revision', { ...cur, status: 'rejected' as const });
      tx.event({ flow, task: cur.task, actor: 'human', type: 'approval', reason: `打回计划修订：${note}`.slice(0, 500), data: { revision: 'rejected' } });
      return saved;
    });
  }

  /**
   * 批准并落地计划修订（仅用户），一个事务内完成：新增任务、整体替换未开始任务的依赖、取消未开始的任务（经转移表 cancel）。
   * 调用方（core/revision.ts）负责编号映射与 DAG 校验；这里再次确认被改动的任务都未开始。
   */
  async applyRevision(flow: string, input: { add: TaskInput[]; rewire: RevisionFile['rewire']; cancel: RevisionFile['cancel']; mapping: Record<string, string> }): Promise<RevisionFile> {
    return this.transaction((tx) => {
      const cur = tx.readJson<RevisionFile>(revisionRel(flow));
      if (!cur || cur.status !== 'proposed') throw new StateError('没有待批准的计划修订');
      for (const t of input.add) {
        if (tx.readJson(taskRel(flow, t.id))) throw new StateError(`任务 ${flow}/${t.id} 已存在`);
        tx.putTask(flow, {
          id: t.id, stage: t.stage, kind: t.kind, title: t.title, role: t.role, scopes: [...t.scopes],
          depends_on: structuredClone(t.depends_on), inputs: [...t.inputs], writes: [...t.writes],
          acceptance: [...t.acceptance], verify: [...t.verify], status: 'pending', attempts: 0, violations: 0,
          lease_expirations: 0, lease: null, impl_run: null, branch: null, worktree: null, base_sha: null,
          blocked_reason: null, last_failure: null, created_by: 'architect', version: 1,
        });
      }
      for (const r of input.rewire) {
        const t = tx.readTask(flow, r.task);
        if (t.status !== 'pending' && t.status !== 'ready') throw new StateError(`任务 ${r.task} 当前是 ${t.status}，已开始的任务不能调整依赖`);
        tx.putTask(flow, { ...t, depends_on: structuredClone(r.depends_on) });
      }
      for (const c of input.cancel) {
        const t = tx.readTask(flow, c.task);
        const plan = planTransition(t, 'cancelled', 'cancel', { now: this.now(), limits: this.limits, actor: 'human', reason: c.reason });
        if (!plan.ok) throw new StateError(`取消 ${c.task} 被拒`, plan.errors);
        tx.putTask(flow, plan.task);
        tx.event({ flow, actor: 'human', type: 'transition', task: c.task, from: t.status, to: 'cancelled', trigger: 'cancel', reason: c.reason });
      }
      const saved = tx.putJson(revisionRel(flow), 'revision', { ...cur, status: 'approved' as const, mapping: input.mapping });
      tx.event({ flow, task: cur.task, actor: 'human', type: 'approval', reason: `批准计划修订：${cur.summary}`.slice(0, 500),
        data: { revision: 'approved', added: input.add.map((t) => t.id), rewired: input.rewire.map((r) => r.task), cancelled: input.cancel.map((c) => c.task) } });
      return saved;
    });
  }

  /** 设置本流程的预算（仅用户；覆盖 workflow.yaml 的 budget） */
  async setFlowBudget(flowId: string, budget: NonNullable<FlowFile['budget']>): Promise<FlowFile> {
    return this.transaction((tx) => {
      const flow = tx.readFlow(flowId);
      const next = tx.putFlow({ ...flow, budget });
      tx.event({ flow: flowId, actor: 'human', type: 'approval', reason: '设置流程预算', data: { budget } });
      return next;
    });
  }

  /** 记录主分支同步状态（不属于阶段状态机，只是流程上的标记） */
  async setFlowSync(flowId: string, sync: NonNullable<FlowFile['sync']>, actor: string, reason: string): Promise<FlowFile> {
    return this.transaction((tx) => {
      const flow = tx.readFlow(flowId);
      const next = tx.putFlow({ ...flow, sync });
      tx.event({ flow: flowId, actor, type: sync.status === 'conflict' ? 'merge_conflict' : 'note', reason,
        data: { sync: sync.status, stage: sync.stage, main: sync.main_sha, ...(sync.files ? { files: sync.files } : {}), ...(sync.task ? { task: sync.task } : {}) } });
      return next;
    });
  }

  async advanceStage(flowId: string, actor: string): Promise<FlowFile> {
    return this.transaction((tx) => {
      const flow = tx.readFlow(flowId);
      if (flow.stage_status !== 'done') throw new StateError(`当前阶段 ${flow.stage} 尚未 done（${flow.stage_status}），不能进入下一阶段`);
      const idx = flow.stages.indexOf(flow.stage);
      if (idx === flow.stages.length - 1) {
        if (flow.mode !== 'fix') tx.setActiveFlow(null);
        tx.event({ flow: flowId, actor, type: 'transition', from: flow.stage, to: 'finished', data: { entity: 'flow' } });
        return flow;
      }
      const from = flow.stage;
      flow.stage = flow.stages[idx + 1]!;
      flow.stage_status = 'active';
      const next = tx.putFlow(flow);
      tx.event({ flow: flowId, actor, type: 'transition', from, to: flow.stage, data: { entity: 'stage' } });
      return next;
    });
  }

  /**
   * 记录完整性错误。状态不一致时普通事务会被拒绝，这里直接在事件日志末尾追加一条 integrity_error（链接到最后一条可解析的事件），
   * 不更新 state.json，因此不一致会继续被检出，直到用户处理。
   */
  async appendIntegrityError(errors: string[], actor = 'resume'): Promise<void> {
    const release = await lockfile.lock(this.flowDir, { lockfilePath: path.join(this.flowDir, LOCK), retries: 50 });
    try {
      const ep = this.abs('events.jsonl');
      const last = readEvents(ep).events.at(-1) ?? null;
      const ev = buildEvent(last, {
        ts: this.now().toISOString(), flow: null, actor, type: 'integrity_error',
        reason: errors.slice(0, 20).join('；').slice(0, 4000), data: { count: errors.length },
      });
      if (existsSync(ep)) {
        const raw = readFileSync(ep, 'utf8');
        if (raw.length && !raw.endsWith('\n')) truncateSync(ep, Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
      }
      appendEvents(ep, [ev]);
    } finally {
      await release();
    }
  }

  // —— 完整性 ——

  async verifyIntegrity(): Promise<IntegrityReport> {
    const release = await lockfile.lock(this.flowDir, { lockfilePath: path.join(this.flowDir, LOCK), retries: 50 });
    try {
      return this.verifyLocked();
    } finally {
      await release();
    }
  }

  private verifyLocked(): IntegrityReport {
    const errors: string[] = [];
    if (existsSync(this.abs(JOURNAL))) errors.push('存在未完成的事务日志 tx.json，请执行 /flow resume 重放');

    const { events, errors: readErrs } = readEvents(this.abs('events.jsonl'));
    errors.push(...readErrs);
    const chain = verifyChain(events);
    errors.push(...chain.errors);

    let state: StateFile | null = null;
    try {
      state = this.readJsonRel<StateFile>('state.json');
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (!state) errors.push('state.json 缺失');
    else {
      errors.push(...validate('state', state));
      if (state.events_head !== chain.head) errors.push('state.json 的 events_head 与事件日志末尾不符');
      if (state.version !== chain.lastSeq) errors.push(`state.json 的 version ${state.version} 与事件序号 ${chain.lastSeq} 不符`);
      let active: string | null = null;
      for (const e of events) if (e.active_flow !== undefined) active = e.active_flow;
      if (state.active_flow !== active) errors.push(`state.json 的 active_flow 与事件记录不符（应为 ${active ?? 'null'}）`);
    }

    const expected = new Map<string, string>();
    for (const e of events) for (const [rel, h] of Object.entries(e.entities ?? {})) expected.set(rel, h);
    const onDisk = new Set(walk(this.flowDir).filter((rel) => !UNTRACKED.has(rel) && !rel.endsWith('.tmp')));
    for (const [rel, h] of expected) {
      const abs = this.abs(rel);
      if (!existsSync(abs)) { errors.push(`${rel} 已被删除`); continue; }
      const buf = readFileSync(abs);
      if (sha256(buf) !== h) errors.push(`${rel} 内容与事件日志记录的哈希不符，可能被篡改`);
      const kind = schemaKindOf(rel);
      if (kind) {
        try {
          errors.push(...validate(kind, JSON.parse(buf.toString('utf8'))).map((m) => `${rel} ${m}`));
        } catch {
          errors.push(`${rel} 不是合法 JSON`);
        }
      }
    }
    for (const rel of onDisk) if (!expected.has(rel)) errors.push(`${rel} 是未登记的文件（不是由引擎写入）`);
    return { ok: errors.length === 0, errors };
  }
}

export function isFinished(f: FlowFile): boolean {
  return f.stage_status === 'aborted' || (f.stage_status === 'done' && f.stage === f.stages.at(-1));
}

function describe(events: FlowEvent[]): string {
  const e = events[0]!;
  const head = [e.flow, e.task, e.from && e.to ? `${e.from} -> ${e.to}` : e.type, e.reason].filter(Boolean).join(' ');
  return events.length > 1 ? `${head}（+${events.length - 1}）` : head;
}

/** 文件为空或以换行结尾（只读最后一个字节） */
function endsWithNewline(file: string): boolean {
  const size = statSync(file).size;
  if (!size) return true;
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally { closeSync(fd); }
}

function atomicWrite(abs: string, content: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, abs);
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!base && name === LOCK) continue;
    const rel = base ? `${base}/${name}` : name;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}
