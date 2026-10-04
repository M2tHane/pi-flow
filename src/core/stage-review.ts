// 阶段末审查（第四轮）：实施阶段的任务全部合入后——
//   1. 强模型 reviewer 读本阶段全部模块的代码，用 flow_review_report 提交带编号、按模块归类的问题清单；
//   2. 程序按模块（与负责的角色）把清单拆成 review-fix 任务并行派发，每个任务只拿到自己那几条、只能写相关文件；
//   3. 修复全部合入后 reviewer 用 flow_review_confirm 逐条确认（参数只有已有编号，不能新增问题）；未解决的只再修一轮，不再确认；
//   4. 跑阶段闸门（全量测试）：失败按失败日志生成修复任务，最多两轮，仍失败转"需要你处理"。
// 记录在 flows/<id>/stage-review-<阶段>.json，引擎每次 pump 按它推进，崩溃后从中途继续。
import type { FlowConfig } from './config.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { FlowFile, ReviewBatch, StageIssue, StageReviewFile, TaskFile } from './schemas.ts';
import { isSettled } from './state-machine.ts';
import { git } from './git.ts';
import { headSha, removeWorktree, taskBranch, worktreePath } from './worktree.ts';
import { CONTRACTS_PATH, isProtected, matchesAny } from './paths.ts';
import { DESIGN_STAGES } from '../modes/plan.ts';

export const STAGE_REVIEW_ROLE = 'reviewer';
/** 全量测试失败后自动修复的轮次上限 */
export const MAX_TEST_ROUNDS = 2;
/** 一次审查最多提交的问题数 */
export const MAX_STAGE_ISSUES = 30;
/** 修复任务可以补契约（第四轮后续）：契约漏了修复需要的条目、又不改变需求时直接补上，不走计划修订 */
export const CONTRACT_ADDITION_HINT = '契约（docs/contracts/）漏了修复需要的条目（例如缺一个回调或参数说明）、补上也不改变需求时，可以直接在对应契约文件里新增，程序只允许新增、不允许修改或删除已有内容，审查者确认时会核对；需要改已有接口时才用 flow_block。';

export interface StageReviewDeps { root: string; store: StateStore; config: FlowConfig }

/** 本阶段是否做阶段末审查：build/feature 的实施阶段（非设计阶段），review.stage_end 未关闭 */
export function stageReviewEnabled(config: FlowConfig, flow: FlowFile): boolean {
  return flow.mode !== 'fix' && !DESIGN_STAGES.has(flow.stage) && config.raw.review?.stage_end !== false;
}

/** 只含测试任务（test、integration）的阶段的审查方式（review.test_stages，默认 skip）；不是测试阶段返回 null */
export function testStageMode(config: FlowConfig, tasks: readonly TaskFile[], stage: string): 'skip' | 'light' | 'strong' | null {
  const changed = changedTasks(tasks, stage).filter((t) => t.kind !== 'review-fix');
  if (!changed.length || !changed.every((t) => t.kind === 'test' || t.kind === 'integration')) return null;
  return config.raw.review?.test_stages ?? 'skip';
}

/** 本阶段合入过改动的任务（审查对象）；没有就不审查（例如只有人工闸门的发布阶段） */
function changedTasks(tasks: readonly TaskFile[], stage: string): TaskFile[] {
  return tasks.filter((t) => t.stage === stage && t.status === 'done' && t.kind !== 'analysis');
}

const nextIds = (tasks: readonly TaskFile[], n: number): string[] => {
  const first = Math.max(0, ...tasks.map((t) => Number(t.id.slice(2)))) + 1;
  return Array.from({ length: n }, (_, i) => `T-${String(first + i).padStart(3, '0')}`);
};

/** 能修这些文件的实施角色：有 flow_submit、可写范围覆盖全部文件；优先选写过这些文件的任务的角色 */
export function fixRoleFor(config: FlowConfig, tasks: readonly TaskFile[], files: readonly string[]): string | null {
  const covers = (role: string) => {
    const r = config.roles[role];
    return !!r && role !== 'architect' && role !== 'orchestrator' && r.tools.has('flow_submit') && r.writes.length > 0 && files.every((f) => matchesAny(f, r.writes));
  };
  const owners = tasks.filter((t) => t.status === 'done' && t.kind !== 'analysis' && files.some((f) => matchesAny(f, t.writes))).map((t) => t.role);
  return [...new Set(owners), ...Object.keys(config.roles)].find(covers) ?? null;
}

/** 写过这些文件最多的、同角色的已完成任务：修复任务接着它的对话继续（熟悉代码，不必重读） */
export function ownerTaskFor(tasks: readonly TaskFile[], role: string, files: readonly string[]): string | undefined {
  let best: { id: string; n: number } | undefined;
  for (const t of tasks) {
    if (t.status !== 'done' || t.role !== role || t.kind === 'analysis' || t.kind === 'review-fix') continue;
    const n = files.filter((f) => matchesAny(f, t.writes)).length;
    if (n && (!best || n > best.n)) best = { id: t.id, n };
  }
  return best?.id;
}

/** 问题涉及的文件是否可以由修复任务修改：具体路径（不是 glob）、不是契约或受保护文件、有角色能写 */
export function issueFileErrors(config: FlowConfig, tasks: readonly TaskFile[], label: string, files: readonly string[]): string[] {
  const errs: string[] = [];
  for (const f of files) {
    if (f.startsWith('/') || f.split('/').includes('..') || /[*?[\]{}]/.test(f)) errs.push(`${label}：文件 ${f} 必须是相对仓库根的具体路径（不能是绝对路径、.. 或通配符）`);
    else if (matchesAny(f, [CONTRACTS_PATH]) || isProtected(f, { contractsLocked: true })) errs.push(`${label}：${f} 是契约或受保护文件，阶段审查的修复不能改它；契约本身的问题写在 summary 里，由用户决定是否修订计划`);
  }
  if (!errs.length && !fixRoleFor(config, tasks, files)) errs.push(`${label}：没有实施角色的可写范围覆盖 ${files.join('、')}；把问题拆成每条只涉及一个模块的文件`);
  return errs;
}

const issueLine = (i: StageIssue) => `${i.id}［${i.module}］${i.location}：${i.problem}；期望：${i.expected}（文件：${i.files.join('、')}）`;
export const formatIssues = (issues: readonly StageIssue[]) => issues.map(issueLine).join('\n');

function verifyFor(config: FlowConfig): string[] {
  return ['typecheck', 'test'].filter((c) => config.commands[c]?.trim());
}

/** 按模块（与角色）把问题拆成修复任务 */
export function planFixTasks(config: FlowConfig, tasks: readonly TaskFile[], stage: string, issues: readonly StageIssue[], round: 1 | 2): { tasks: TaskInput[]; handoffs: Record<string, string> } {
  const groups = new Map<string, { module: string; role: string; issues: StageIssue[] }>();
  for (const i of issues) {
    const role = fixRoleFor(config, tasks, i.files);
    if (!role) continue; // 提交时已校验；配置被改过时跳过，由确认或闸门兜底
    const key = `${i.module}\u0000${role}`;
    const g = groups.get(key) ?? { module: i.module, role, issues: [] };
    g.issues.push(i);
    groups.set(key, g);
  }
  const ids = nextIds(tasks, groups.size);
  const out: TaskInput[] = [];
  const handoffs: Record<string, string> = {};
  [...groups.values()].forEach((g, n) => {
    const id = ids[n]!;
    const files = [...new Set(g.issues.flatMap((i) => i.files))];
    const r = config.roles[g.role]!;
    out.push({
      id, stage, kind: 'review-fix', title: `${round === 1 ? '' : '再修一轮：'}阶段审查问题「${g.module}」（${g.issues.map((i) => i.id).join('、')}）`.slice(0, 200),
      role: g.role, scopes: [...r.scopes], depends_on: [], inputs: files, writes: files, verify: verifyFor(config),
      acceptance: [...g.issues.map(issueLine), '只修上面这些问题，不顺手改别处；修好后全量测试仍然通过'],
      review_issues: g.issues.map((i) => i.id),
      ...(ownerTaskFor(tasks, g.role, files) ? { fork_from_task: ownerTaskFor(tasks, g.role, files)! } : {}),
    });
    handoffs[id] = `阶段 ${stage} 末审查发现的问题（程序生成${round === 2 ? '；上一轮修复后确认仍未解决' : ''}）：\n${formatIssues(g.issues)}\n\n只修这些问题，可写范围限定在相关文件。${CONTRACT_ADDITION_HINT}问题描述有误或无法在这些文件内修好时，用 flow_block 说明。`;
  });
  return { tasks: out, handoffs };
}

/** 本阶段第一次合并前的集成分支提交（审查看 base..HEAD） */
function stageBase(store: StateStore, flowId: string, stage: string): string | null {
  const ids = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  const first = store.readEvents().find((e) => e.flow === flowId && e.type === 'merge' && e.task && ids.has(e.task) && typeof e.data?.['from'] === 'string');
  return (first?.data?.['from'] as string | undefined) ?? null;
}

/** 实施工作（审查对象）：不含审查、确认、修复任务本身 */
const isWork = (t: TaskFile) => t.kind !== 'analysis' && t.kind !== 'review-fix';

/** 阶段审查记录里所有批次的问题 */
export const allIssues = (sr: StageReviewFile): StageIssue[] => sr.batches.flatMap((b) => b.issues);
/** 审查或确认任务所属的批次 */
export const batchOfTask = (sr: StageReviewFile, taskId: string): ReviewBatch | undefined =>
  sr.batches.find((b) => b.review_task === taskId || b.confirm_task === taskId);

function reviewerTask(id: string, stage: string, kind: 'review' | 'confirm', covered: readonly TaskFile[], roles: readonly string[]): TaskInput {
  const scopes = [...new Set(covered.flatMap((t) => t.scopes))];
  const inputs = [...new Set(['docs/ARCHITECTURE.md', 'docs/contracts/', ...covered.flatMap((t) => t.inputs)])].slice(0, 40);
  const who = roles.join('、');
  return kind === 'review'
    ? { id, stage, kind: 'analysis', title: `阶段 ${stage} 审查（${who}）：这些任务的全部代码`.slice(0, 200), role: STAGE_REVIEW_ROLE, scopes, depends_on: [], inputs, writes: [], verify: [], stage_review: 'review',
      acceptance: [
        `读 handoff 中列出的任务（${who}）改动涉及的全部代码，对照规则、契约（docs/contracts/）、ARCHITECTURE.md 与各任务的验收标准`,
        '只提违反规则、契约、验收标准的问题与明确的缺陷，不提风格偏好与可有可无的改进',
        '用 flow_review_report 一次提交问题清单：每条写模块、位置、问题、期望的修改、涉及的文件；没有问题就提交空清单',
      ] }
    : { id, stage, kind: 'analysis', title: `阶段 ${stage} 审查（${who}）：确认修复`.slice(0, 200), role: STAGE_REVIEW_ROLE, scopes, depends_on: [], inputs, writes: [], verify: [], stage_review: 'confirm',
      acceptance: [
        '逐条核对清单中的问题是否已经解决',
        '用 flow_review_confirm 提交：每个编号回答 resolved（true/false），未解决的写明原因；只能回答已有编号，不能提出新问题',
      ] };
}

function stageTaskBrief(tasks: readonly TaskFile[]): string {
  return tasks.map((t) => `- ${t.id}「${t.title}」（${t.role}，${t.kind}）writes：${t.writes.join('、')}\n  验收标准：${t.acceptance.join('；').slice(0, 400)}`).join('\n');
}

/** 只读任务提交后 worktree 字段已清空：按约定路径回收 */
function cleanupReviewerWorktree(root: string, flowId: string, taskId: string | null): void {
  if (taskId) removeWorktree(root, worktreePath(root, flowId, taskId), taskBranch(flowId, taskId));
}

/**
 * 推进阶段审查（每次 pump 调用，不必等整个阶段结束）：
 * - 某些角色在本阶段的实施任务全部合入后，就为它们开一批审查（与其他角色还在做的任务并行）；
 * - 每批各自走审查 → 按模块修复 → 确认 → 未解决的再修一轮；
 * - 本阶段任务全部结束、所有批次完成、没有未审查的合入时返回 'gate'（跑闸门）；否则 'wait'。
 */
export async function stageReviewStep(d: StageReviewDeps, flowId: string): Promise<'gate' | 'wait'> {
  // 每写一步就按最新状态再看一次：批次完成但没有生成新任务时，不会有子进程结束来触发下一次 pump
  for (let i = 0; i < 20; i++) {
    const r = await stepOnce(d, flowId);
    if (r !== 'again') return r;
  }
  return 'wait';
}

async function stepOnce(d: StageReviewDeps, flowId: string): Promise<'gate' | 'wait' | 'again'> {
  const { store, config } = d;
  const flow = store.readFlow(flowId);
  const stage = flow.stage;
  const tasks = store.listTasks(flowId);
  const stageTasks = tasks.filter((t) => t.stage === stage);
  const allSettled = stageTasks.every(isSettled);
  if (!stageReviewEnabled(config, flow)) return allSettled ? 'gate' : 'wait';
  const sr = store.readStageReview(flowId, stage);
  if (sr && sr.status !== 'reviewing') return allSettled ? 'gate' : 'wait'; // gating 之后交给闸门

  // 1. 推进进行中的批次（每次只推进一步，状态写入后由下一次 pump 继续）
  for (const b of sr?.batches ?? []) {
    if (b.status !== 'done' && await advanceBatch(d, flow, sr!, b, tasks)) return 'again';
  }

  // 2. 开新批次：本阶段合入了、还没审查过的实施任务，且同角色在本阶段没有未结束的实施任务
  const work = stageTasks.filter(isWork);
  const covered = new Set(sr?.batches.flatMap((b) => b.tasks) ?? []);
  const uncovered = work.filter((t) => t.status === 'done' && !covered.has(t.id));
  if (uncovered.length && testStageMode(config, tasks, stage) !== 'skip') {
    const busy = new Set(work.filter((t) => !isSettled(t)).map((t) => t.role));
    const ready = uncovered.filter((t) => !busy.has(t.role));
    if (ready.length) {
      const roles = [...new Set(ready.map((t) => t.role))];
      const [id] = nextIds(tasks, 1);
      const batch: ReviewBatch = { id: (sr?.batches.length ?? 0) + 1, roles, tasks: ready.map((t) => t.id), status: 'reviewing', review_task: id!,
        reported: false, issues: [], fix_tasks: [], confirm_task: null, confirm: [], refix_tasks: [] };
      const next: StageReviewFile = sr ? { ...sr, batches: [...sr.batches, batch] }
        : { stage, status: 'reviewing', base_sha: stageBase(store, flowId, stage), batches: [batch], test_rounds: [], version: 1 };
      await store.updateStageReview(flowId, next, {
        tasks: [reviewerTask(id!, stage, 'review', ready, roles)],
        handoffs: { [id!]: `本批审查的任务（阶段 ${stage}，${roles.join('、')} 的任务已全部合入${allSettled ? '' : '；其他角色的任务还在进行，不在本批'}）：\n${stageTaskBrief(ready)}` },
        actor: 'engine', reason: `阶段 ${stage}：${roles.join('、')} 的任务全部合入，开始第 ${batch.id} 批审查（${id}）`,
      });
      return 'again';
    }
  }

  // 3. 全部结束：进入闸门
  if (!allSettled || sr?.batches.some((b) => b.status !== 'done')) return 'wait';
  if (sr) await store.updateStageReview(flowId, { ...sr, status: 'gating' }, { actor: 'engine', reason: `阶段 ${stage} 的审查已全部完成（${allIssues(sr).length} 个问题），跑全量测试` });
  return 'gate';
}

/** 推进一个批次的一步；返回是否写入了新状态 */
async function advanceBatch(d: StageReviewDeps, flow: FlowFile, sr: StageReviewFile, b: ReviewBatch, tasks: readonly TaskFile[]): Promise<boolean> {
  const { store, config } = d;
  const stage = flow.stage;
  const settled = (ids: readonly (string | null)[]) => ids.every((id) => { const t = id ? tasks.find((x) => x.id === id) : undefined; return !t || isSettled(t); });
  const save = (nb: ReviewBatch, reason: string, opts: { tasks?: TaskInput[]; handoffs?: Record<string, string> } = {}) =>
    store.updateStageReview(flow.id, { ...sr, batches: sr.batches.map((x) => (x.id === b.id ? nb : x)) }, { ...opts, actor: 'engine', reason: `阶段 ${stage} 第 ${b.id} 批：${reason}` }).then(() => true);
  const covered = tasks.filter((t) => b.tasks.includes(t.id));
  switch (b.status) {
    case 'reviewing': {
      if (!settled([b.review_task])) return false;
      cleanupReviewerWorktree(d.root, flow.id, b.review_task);
      if (!b.reported || !b.issues.length) return save({ ...b, status: 'done' }, '审查没有发现问题');
      const plan = planFixTasks(config, tasks, stage, b.issues, 1);
      return save({ ...b, status: 'fixing', fix_base: headSha(d.root, flow.integration_branch), fix_tasks: plan.tasks.map((t) => t.id) },
        `审查发现 ${b.issues.length} 个问题，按模块生成 ${plan.tasks.length} 个修复任务并行修复`, { tasks: plan.tasks, handoffs: plan.handoffs });
    }
    case 'fixing': {
      if (!settled(b.fix_tasks)) return false;
      const [id] = nextIds(tasks, 1);
      const fixes = tasks.filter((t) => b.fix_tasks.includes(t.id));
      const diff = b.fix_base ? safeGit(d.root, ['diff', '--stat', b.fix_base, flow.integration_branch]) : '';
      const contractAdds = b.fix_base ? safeGit(d.root, ['diff', b.fix_base, flow.integration_branch, '--', 'docs/contracts']) : '';
      return save({ ...b, status: 'confirming', confirm_task: id! }, `修复已合入，派审查者确认（${id}）`, {
        tasks: [reviewerTask(id!, stage, 'confirm', covered, b.roles)],
        handoffs: { [id!]: `待确认的问题：\n${formatIssues(b.issues)}\n\n修复任务：\n${fixes.map((t) => `- ${t.id}（${t.role}）${t.status === 'done' ? '已合入' : t.status}：${t.review_issues?.join('、') ?? ''}`).join('\n')}${diff ? `\n\n修复开始后的改动（git diff --stat ${b.fix_base!.slice(0, 12)} HEAD）：\n${diff}` : ''}${contractAdds ? `\n\n修复时补充的契约（只允许新增；请确认没有改变需求、没有超出修复所需，否则把对应问题判为未解决并在 note 里说明）：\n${contractAdds.slice(0, 6000)}` : ''}` },
      });
    }
    case 'confirming': {
      if (!settled([b.confirm_task])) return false;
      cleanupReviewerWorktree(d.root, flow.id, b.confirm_task);
      const unresolved = b.issues.filter((i) => b.confirm.find((c) => c.id === i.id)?.resolved === false);
      if (!unresolved.length) return save({ ...b, status: 'done' }, '问题已全部确认解决');
      const withNotes = unresolved.map((i) => {
        const note = b.confirm.find((c) => c.id === i.id)?.note;
        return note ? { ...i, problem: `${i.problem}（确认时仍未解决：${note}）` } : i;
      });
      const plan = planFixTasks(config, tasks, stage, withNotes, 2);
      return save({ ...b, status: 'refixing', refix_tasks: plan.tasks.map((t) => t.id) }, `确认后仍有 ${unresolved.length} 个问题未解决，再修一轮（不再确认）`,
        { tasks: plan.tasks, handoffs: plan.handoffs });
    }
    case 'refixing':
      if (!settled(b.refix_tasks)) return false;
      return save({ ...b, status: 'done' }, '第二轮修复已合入');
    default:
      return false;
  }
}

function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/** 闸门通过：阶段审查结束 */
export async function stageGatePassed(d: StageReviewDeps, flowId: string, stage: string): Promise<void> {
  const sr = d.store.readStageReview(flowId, stage);
  if (sr && sr.status !== 'done') await d.store.updateStageReview(flowId, { ...sr, status: 'done' }, { actor: 'engine', reason: `阶段 ${stage} 全量测试通过，阶段审查结束` });
}

/** 从失败输出中找出仓库里的文件（测试文件、报错位置） */
export function failingFiles(output: string, tracked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[\w@.\-/]+\.[A-Za-z0-9]+/g)) {
    let p = m[0].replace(/^\.\//, '');
    // 绝对路径或带前缀的路径：取能在仓库里找到的最长后缀
    if (!tracked.has(p)) {
      const parts = p.split('/');
      p = parts.map((_, i) => parts.slice(i).join('/')).find((s) => tracked.has(s)) ?? '';
    }
    if (p) out.add(p);
  }
  return [...out].slice(0, 20);
}

/**
 * 闸门的全量测试失败（第四轮）：按失败日志找到负责的模块生成修复任务，最多两轮；
 * 第三次失败、或从日志里定位不到负责的模块时转"需要你处理"。
 * 返回生成的任务 id（空数组表示已转为需要用户处理或本阶段不适用）。
 */
export async function stageGateFailed(d: StageReviewDeps, flowId: string, stage: string, failed: { command: string; output: string }): Promise<string[]> {
  const { store, config } = d;
  const sr = store.readStageReview(flowId, stage);
  if (!sr || sr.status === 'done' || sr.status === 'needs_human') return [];
  const flow = store.readFlow(flowId);
  const tail = failed.output.trim().split('\n').slice(-60).join('\n');
  const human = (reason: string) => store.updateStageReview(flowId, { ...sr, status: 'needs_human', reason }, { actor: 'engine', reason: `阶段 ${stage}：${reason}` }).then(() => []);
  if (sr.test_rounds.length >= MAX_TEST_ROUNDS) return human(`全量测试（${failed.command}）自动修复 ${MAX_TEST_ROUNDS} 轮后仍失败`);

  const tracked = new Set(safeGit(d.root, ['ls-tree', '-r', '--name-only', flow.integration_branch]).split('\n').filter(Boolean));
  const files = failingFiles(failed.output, tracked);
  const tasks = store.listTasks(flowId);
  // 按负责的角色分组：写过该文件的任务的角色（可写范围取这些任务的 writes），否则可写范围覆盖它的角色
  const groups = new Map<string, { files: Set<string>; writes: Set<string>; owners: Set<string> }>();
  for (const f of files) {
    const owners = tasks.filter((t) => t.status === 'done' && t.kind !== 'analysis' && t.kind !== 'review-fix' && matchesAny(f, t.writes));
    const role = fixRoleFor(config, owners, [f]) ?? fixRoleFor(config, [], [f]);
    if (!role) continue;
    const g = groups.get(role) ?? { files: new Set(), writes: new Set(), owners: new Set() };
    g.files.add(f);
    const own = owners.filter((t) => t.role === role);
    for (const w of own.length ? own.flatMap((t) => t.writes) : [f]) g.writes.add(w);
    for (const t of own) g.owners.add(t.id);
    groups.set(role, g);
  }
  if (!groups.size) return human(`全量测试（${failed.command}）失败，但无法从日志定位负责的模块`);

  const round = sr.test_rounds.length + 1;
  const ids = nextIds(tasks, groups.size);
  const inputs: TaskInput[] = [];
  const handoffs: Record<string, string> = {};
  [...groups].forEach(([role, g], n) => {
    const id = ids[n]!;
    const r = config.roles[role]!;
    inputs.push({
      id, stage, kind: 'review-fix', title: `修复全量 ${failed.command} 失败（第 ${round} 轮）：${[...g.files].slice(0, 3).join('、')}`.slice(0, 200),
      role, scopes: [...r.scopes], depends_on: [], inputs: [...g.files], writes: [...g.writes], verify: verifyFor(config),
      acceptance: [`阶段闸门的全量 ${failed.command} 失败，日志中涉及 ${[...g.files].join('、')}：找到原因并修复，修好后全量 ${failed.command} 通过`,
        '只修导致失败的问题；原因不在你的可写范围内时，用 flow_block 写明是哪个模块、什么输入、期望与实际'],
      ...(ownerTaskFor(tasks, role, [...g.files]) ? { fork_from_task: ownerTaskFor(tasks, role, [...g.files])! } : {}),
    });
    handoffs[id] = `阶段 ${stage} 的全量测试失败（程序生成，第 ${round}/${MAX_TEST_ROUNDS} 轮）。${g.owners.size ? `相关任务：${[...g.owners].join('、')}。` : ''}${CONTRACT_ADDITION_HINT}\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail.slice(-4000)}\n\`\`\``;
  });
  await store.updateStageReview(flowId, { ...sr, status: 'test_fixing', test_rounds: [...sr.test_rounds, { command: failed.command, tasks: ids, at: new Date().toISOString() }] }, {
    tasks: inputs, handoffs, actor: 'engine', reason: `阶段 ${stage} 全量 ${failed.command} 失败，生成第 ${round} 轮修复任务 ${ids.join('、')}`,
  });
  return ids;
}

/** 给人看的阶段审查进展（状态视图、orchestrator 的下一步） */
export function describeStageReview(sr: StageReviewFile): string {
  const batch = (b: ReviewBatch) => {
    const who = `第 ${b.id} 批（${b.roles.join('、')}）`;
    switch (b.status) {
      case 'reviewing': return `${who}审查中`;
      case 'fixing': return `${who}发现 ${b.issues.length} 个问题，${b.fix_tasks.length} 个修复任务并行修复中`;
      case 'confirming': return `${who}修复已合入，确认中`;
      case 'refixing': return `${who}${b.confirm.filter((c) => !c.resolved).length} 个问题未解决，再修一轮`;
      case 'done': return `${who}已完成（${b.issues.length} 个问题）`;
    }
  };
  switch (sr.status) {
    case 'reviewing': return sr.batches.filter((b) => b.status !== 'done').map(batch).join('；') || `${sr.batches.map(batch).join('；')}；等其他任务合入`;
    case 'gating': return allIssues(sr).length ? `审查的 ${allIssues(sr).length} 个问题已处理，跑全量测试中` : '审查没有发现问题，跑全量测试中';
    case 'test_fixing': return `全量测试失败，第 ${sr.test_rounds.length}/${MAX_TEST_ROUNDS} 轮修复中`;
    case 'needs_human': return `需要你处理：${sr.reason ?? '全量测试仍失败'}`;
    case 'done': return '阶段审查已完成';
  }
}
