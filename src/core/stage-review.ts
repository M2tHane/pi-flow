// 阶段末审查（第四轮）：实施阶段的任务全部合入后——
//   1. 强模型 reviewer 读本阶段全部模块的代码，用 flow_review_report 提交带编号、按模块归类的问题清单；
//   2. 程序按模块（与负责的角色）把清单拆成 review-fix 任务并行派发，每个任务只拿到自己那几条、只能写相关文件；
//   3. 修复全部合入后 reviewer 用 flow_review_confirm 逐条确认（参数只有已有编号，不能新增问题）；未解决的只再修一轮，不再确认；
//   4. 跑阶段闸门（全量测试）：失败按失败日志生成修复任务，最多两轮，仍失败转"需要你处理"。
// 记录在 flows/<id>/stage-review-<阶段>.json，引擎每次 pump 按它推进，崩溃后从中途继续。
import type { FlowConfig } from './config.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { FlowFile, StageIssue, StageReviewFile, TaskFile } from './schemas.ts';
import { git } from './git.ts';
import { headSha, removeWorktree, taskBranch, worktreePath } from './worktree.ts';
import { CONTRACTS_PATH, isProtected, matchesAny } from './paths.ts';
import { DESIGN_STAGES } from '../modes/plan.ts';

export const STAGE_REVIEW_ROLE = 'reviewer';
/** 全量测试失败后自动修复的轮次上限 */
export const MAX_TEST_ROUNDS = 2;
/** 一次审查最多提交的问题数 */
export const MAX_STAGE_ISSUES = 30;

export interface StageReviewDeps { root: string; store: StateStore; config: FlowConfig }

/** 本阶段是否做阶段末审查：build/feature 的实施阶段（非设计阶段），review.stage_end 未关闭 */
export function stageReviewEnabled(config: FlowConfig, flow: FlowFile): boolean {
  return flow.mode !== 'fix' && !DESIGN_STAGES.has(flow.stage) && config.raw.review?.stage_end !== false;
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
    });
    handoffs[id] = `阶段 ${stage} 末审查发现的问题（程序生成${round === 2 ? '；上一轮修复后确认仍未解决' : ''}）：\n${formatIssues(g.issues)}\n\n只修这些问题，可写范围限定在相关文件。问题描述有误或无法在这些文件内修好时，用 flow_block 说明。`;
  });
  return { tasks: out, handoffs };
}

/** 本阶段第一次合并前的集成分支提交（审查看 base..HEAD） */
function stageBase(store: StateStore, flowId: string, stage: string): string | null {
  const ids = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  const first = store.readEvents().find((e) => e.flow === flowId && e.type === 'merge' && e.task && ids.has(e.task) && typeof e.data?.['from'] === 'string');
  return (first?.data?.['from'] as string | undefined) ?? null;
}

function emptyRecord(stage: string): StageReviewFile {
  return { stage, status: 'reviewing', base_sha: null, review_task: null, reported: false, issues: [], fix_tasks: [], confirm_task: null, confirm: [], refix_tasks: [], test_rounds: [], version: 1 };
}

function reviewerTask(id: string, stage: string, kind: 'review' | 'confirm', stageTasks: readonly TaskFile[]): TaskInput {
  const scopes = [...new Set(stageTasks.flatMap((t) => t.scopes))];
  const inputs = [...new Set(['docs/ARCHITECTURE.md', 'docs/contracts/', ...stageTasks.flatMap((t) => t.inputs)])].slice(0, 40);
  return kind === 'review'
    ? { id, stage, kind: 'analysis', title: `阶段 ${stage} 末审查：本阶段全部模块的代码`, role: STAGE_REVIEW_ROLE, scopes, depends_on: [], inputs, writes: [], verify: [], stage_review: 'review',
      acceptance: [
        '读本阶段改动涉及的全部模块的代码，对照规则、契约（docs/contracts/）、ARCHITECTURE.md 与各任务的验收标准',
        '只提违反规则、契约、验收标准的问题与明确的缺陷，不提风格偏好与可有可无的改进',
        '用 flow_review_report 一次提交问题清单：每条写模块、位置、问题、期望的修改、涉及的文件；没有问题就提交空清单',
      ] }
    : { id, stage, kind: 'analysis', title: `阶段 ${stage} 末审查：确认修复`, role: STAGE_REVIEW_ROLE, scopes, depends_on: [], inputs, writes: [], verify: [], stage_review: 'confirm',
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
 * 推进阶段审查。调用前提：本阶段任务全部已结束（done/cancelled）。
 * 返回 'gate' 表示审查与修复已完成（或本阶段不审查），可以跑闸门；'wait' 表示生成了新任务或在等待。
 */
export async function stageReviewStep(d: StageReviewDeps, flowId: string): Promise<'gate' | 'wait'> {
  const { store, config } = d;
  const flow = store.readFlow(flowId);
  if (!stageReviewEnabled(config, flow)) return 'gate';
  const stage = flow.stage;
  const tasks = store.listTasks(flowId);
  const stageTasks = tasks.filter((t) => t.stage === stage);
  const sr = store.readStageReview(flowId, stage);

  if (!sr) {
    const changed = changedTasks(tasks, stage);
    if (!changed.length) return 'gate';
    const [id] = nextIds(tasks, 1);
    const base = stageBase(store, flowId, stage);
    const next = { ...emptyRecord(stage), base_sha: base, review_task: id! };
    await store.updateStageReview(flowId, next, {
      tasks: [reviewerTask(id!, stage, 'review', changed)],
      handoffs: { [id!]: `本阶段（${stage}）已合入的任务：\n${stageTaskBrief(changed)}` },
      actor: 'engine', reason: `阶段 ${stage} 的任务全部合入，开始阶段末审查（${id}）`,
    });
    return 'wait';
  }

  switch (sr.status) {
    case 'reviewing': {
      cleanupReviewerWorktree(d.root, flowId, sr.review_task);
      if (!sr.reported || !sr.issues.length) {
        await store.updateStageReview(flowId, { ...sr, status: 'gating' }, { actor: 'engine', reason: `阶段 ${stage} 末审查没有发现问题，跑全量测试` });
        return 'gate';
      }
      const plan = planFixTasks(config, tasks, stage, sr.issues, 1);
      await store.updateStageReview(flowId, { ...sr, status: 'fixing', fix_base: headSha(d.root, flow.integration_branch), fix_tasks: plan.tasks.map((t) => t.id) }, {
        tasks: plan.tasks, handoffs: plan.handoffs, actor: 'engine',
        reason: `阶段 ${stage} 末审查发现 ${sr.issues.length} 个问题，按模块生成 ${plan.tasks.length} 个修复任务并行修复`,
      });
      return 'wait';
    }
    case 'fixing': {
      const [id] = nextIds(tasks, 1);
      const fixes = stageTasks.filter((t) => sr.fix_tasks.includes(t.id));
      const diff = sr.fix_base ? safeGit(d.root, ['diff', '--stat', sr.fix_base, flow.integration_branch]) : '';
      await store.updateStageReview(flowId, { ...sr, status: 'confirming', confirm_task: id! }, {
        tasks: [reviewerTask(id!, stage, 'confirm', changedTasks(tasks, stage))],
        handoffs: { [id!]: `待确认的问题：\n${formatIssues(sr.issues)}\n\n修复任务：\n${fixes.map((t) => `- ${t.id}（${t.role}）${t.status === 'done' ? '已合入' : t.status}：${t.review_issues?.join('、') ?? ''}`).join('\n')}${diff ? `\n\n修复开始后的改动（git diff --stat ${sr.fix_base!.slice(0, 12)} HEAD）：\n${diff}` : ''}` },
        actor: 'engine', reason: `阶段 ${stage} 的审查修复已合入，派审查者确认（${id}）`,
      });
      return 'wait';
    }
    case 'confirming': {
      cleanupReviewerWorktree(d.root, flowId, sr.confirm_task);
      const unresolved = sr.issues.filter((i) => sr.confirm.find((c) => c.id === i.id)?.resolved === false);
      if (!unresolved.length) {
        await store.updateStageReview(flowId, { ...sr, status: 'gating' }, { actor: 'engine', reason: `阶段 ${stage} 的审查问题已全部确认解决，跑全量测试` });
        return 'gate';
      }
      const withNotes = unresolved.map((i) => {
        const note = sr.confirm.find((c) => c.id === i.id)?.note;
        return note ? { ...i, problem: `${i.problem}（确认时仍未解决：${note}）` } : i;
      });
      const plan = planFixTasks(config, tasks, stage, withNotes, 2);
      await store.updateStageReview(flowId, { ...sr, status: 'refixing', refix_tasks: plan.tasks.map((t) => t.id) }, {
        tasks: plan.tasks, handoffs: plan.handoffs, actor: 'engine',
        reason: `阶段 ${stage} 确认后仍有 ${unresolved.length} 个问题未解决，再修一轮（不再确认）`,
      });
      return 'wait';
    }
    case 'refixing':
      await store.updateStageReview(flowId, { ...sr, status: 'gating' }, { actor: 'engine', reason: `阶段 ${stage} 的第二轮修复已合入，跑全量测试` });
      return 'gate';
    default:
      return 'gate'; // gating、test_fixing、needs_human、done：交给闸门
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
    });
    handoffs[id] = `阶段 ${stage} 的全量测试失败（程序生成，第 ${round}/${MAX_TEST_ROUNDS} 轮）。${g.owners.size ? `相关任务：${[...g.owners].join('、')}。` : ''}\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail.slice(-4000)}\n\`\`\``;
  });
  await store.updateStageReview(flowId, { ...sr, status: 'test_fixing', test_rounds: [...sr.test_rounds, { command: failed.command, tasks: ids, at: new Date().toISOString() }] }, {
    tasks: inputs, handoffs, actor: 'engine', reason: `阶段 ${stage} 全量 ${failed.command} 失败，生成第 ${round} 轮修复任务 ${ids.join('、')}`,
  });
  return ids;
}

/** 给人看的阶段审查进展（状态视图、orchestrator 的下一步） */
export function describeStageReview(sr: StageReviewFile): string {
  switch (sr.status) {
    case 'reviewing': return '审查者正在通读本阶段全部代码';
    case 'fixing': return `审查发现 ${sr.issues.length} 个问题，按模块分成 ${sr.fix_tasks.length} 个修复任务并行修复中`;
    case 'confirming': return '修复已合入，审查者逐条确认中（只能确认已有问题，不提新问题）';
    case 'refixing': return `${sr.issues.length - sr.confirm.filter((c) => c.resolved).length} 个问题确认未解决，再修一轮（之后不再确认）`;
    case 'gating': return sr.issues.length ? `审查的 ${sr.issues.length} 个问题已处理，跑全量测试中` : '审查没有发现问题，跑全量测试中';
    case 'test_fixing': return `全量测试失败，第 ${sr.test_rounds.length}/${MAX_TEST_ROUNDS} 轮修复中`;
    case 'needs_human': return `需要你处理：${sr.reason ?? '全量测试仍失败'}`;
    case 'done': return '阶段审查已完成';
  }
}
