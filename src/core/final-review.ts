// 最终代码审查（第五轮，可选，workflow.yaml review.final，默认关闭）：实施阶段所有模块验收通过后、阶段闸门前，
// 一个审查者（reviewer，只读）对照项目规范审查整个流程的改动（不拆分），用 flow_review_report 逐条提交问题。
//   1. 结论写到集成分支的 docs/review/final.md；"必须改"自动交给负责的模块修复（fork 实现者的会话，一轮，不再复审）；
//   2. 还有没修的条目时等用户挑选：/flow review fix R-3 R-5 交给模块修复，/flow review done 结束；
//   3. 结束后照常执行阶段闸门（全量测试）与用户审批。
// 记录在 flows/<id>/final-review.json，引擎每次 pump 按它推进。
import type { AcceptanceDeps } from './acceptance.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { FinalReviewFile, FlowFile, ReviewFinding, TaskFile } from './schemas.ts';
import { git } from './git.ts';
import { matchesAny } from './paths.ts';
import { commitFileToBranch } from './requirements.ts';
import { EXECUTION_STAGE } from '../modes/plan.ts';

export const REVIEWER_ROLE = 'reviewer';
export const FINAL_REVIEW_DOC = 'docs/review/final.md';
export const LEVEL_LABEL: Record<ReviewFinding['level'], string> = { must: '必须改', suggest: '建议' };

export class FinalReviewError extends Error {}

const nextIds = (tasks: readonly TaskFile[], n: number): string[] => {
  const first = Math.max(0, ...tasks.map((t) => Number(t.id.slice(2)))) + 1;
  return Array.from({ length: n }, (_, i) => `T-${String(first + i).padStart(3, '0')}`);
};

/** 审查范围内改动的文件（不含原型） */
export function reviewedFiles(root: string, r: Pick<FinalReviewFile, 'base' | 'head'>): string[] {
  return git(root, ['diff', '--name-only', '--no-renames', r.base, r.head, '--', '.', ':(exclude)prototype']).split('\n').filter(Boolean);
}

/** 负责某个文件的模块：可写范围优先，其次登记的公共文件 */
function ownerOf(mods: readonly TaskFile[], f: ReviewFinding): TaskFile | undefined {
  for (const file of f.files) {
    const m = mods.find((t) => matchesAny(file, t.writes)) ?? mods.find((t) => matchesAny(file, t.shared ?? []));
    if (m) return m;
  }
  return undefined;
}

const modulesOf = (tasks: readonly TaskFile[], stage: string) => tasks.filter((t) => t.stage === stage && t.needs_acceptance && t.status === 'done');

export const findingLine = (f: ReviewFinding) => `${f.id}【${LEVEL_LABEL[f.level]}】${f.files.join('、')}${f.location ? `（${f.location}）` : ''}：${f.problem} → ${f.expected}（依据：${f.basis}）`;

function renderDoc(flow: FlowFile, r: FinalReviewFile): string {
  const lines = [`# 最终代码审查：${flow.title}`, '', `范围：${r.base.slice(0, 8)}..${r.head.slice(0, 8)}（${flow.integration_branch}）`, ''];
  if (r.summary) lines.push(r.summary, '');
  if (!r.findings.length) lines.push('没有发现问题。');
  for (const level of ['must', 'suggest'] as const) {
    const fs = r.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    lines.push(`## ${LEVEL_LABEL[level]}（${fs.length}）`, '');
    for (const f of fs) {
      lines.push(`### ${f.id} ${f.problem.split('\n')[0]!.slice(0, 80)}`, '', `- 依据：${f.basis}`, `- 文件：${f.files.join('、')}${f.location ? `（${f.location}）` : ''}`, `- 问题：${f.problem}`, `- 期望：${f.expected}`, '');
    }
  }
  return lines.join('\n');
}

function fixTasks(tasks: readonly TaskFile[], flow: FlowFile, findings: readonly ReviewFinding[]): { inputs: TaskInput[]; handoffs: Record<string, string>; unowned: ReviewFinding[] } {
  const mods = modulesOf(tasks, flow.stage);
  const groups = new Map<string, ReviewFinding[]>();
  const unowned: ReviewFinding[] = [];
  for (const f of findings) {
    const m = ownerOf(mods, f);
    if (m) groups.set(m.id, [...(groups.get(m.id) ?? []), f]);
    else unowned.push(f);
  }
  const ids = nextIds(tasks, groups.size);
  const inputs: TaskInput[] = [];
  const handoffs: Record<string, string> = {};
  [...groups].forEach(([modId, fs], n) => {
    const mod = mods.find((t) => t.id === modId)!;
    const id = ids[n]!;
    inputs.push({
      id, stage: flow.stage, kind: 'review-fix', role: mod.role, scopes: [...mod.scopes], depends_on: [], inputs: [...new Set(fs.flatMap((f) => f.files))],
      writes: [...mod.writes], ...(mod.shared?.length ? { shared: [...mod.shared] } : {}), verify: [...mod.verify],
      title: `代码审查：修复 ${fs.map((f) => f.id).join('、')}（${mod.title}）`.slice(0, 200),
      acceptance: [...fs.map(findingLine), '只改这些问题，不顺手改别处；修好后全量测试仍然通过'],
      fork_from_task: mod.id,
    });
    handoffs[id] = `最终代码审查提出的问题（程序生成，只修一轮，不再复审）：\n${fs.map(findingLine).join('\n')}\n\n问题不成立或无法在可写范围内修好时，用 flow_block 说明。`;
  });
  return { inputs, handoffs, unowned };
}

const open = (r: FinalReviewFile) => r.findings.filter((f) => !r.fixed.includes(f.id));

/**
 * 推进最终审查（实施阶段、本阶段任务都已完成并验收后由引擎调用）。
 * 返回 wait=true 表示还不能执行阶段闸门；changed=true 表示写入了新状态（可能有新任务）。
 */
export async function finalReviewStep(d: AcceptanceDeps, flowId: string): Promise<{ wait: boolean; changed: boolean }> {
  const { store, root } = d;
  const flow = store.readFlow(flowId);
  if (!d.config.raw.review?.final || flow.mode === 'fix' || flow.stage !== EXECUTION_STAGE) return { wait: false, changed: false };
  const tasks = store.listTasks(flowId);
  const r = store.readFinalReview(flowId);
  if (!r) {
    const head = git(root, ['rev-parse', flow.integration_branch]).trim();
    const base = git(root, ['merge-base', d.config.raw.main_branch, flow.integration_branch]).trim();
    const [id] = nextIds(tasks, 1);
    const stat = git(root, ['diff', '--stat', base, head, '--', '.', ':(exclude)prototype']).trim();
    await store.updateFinalReview(flowId, { stage: flow.stage, status: 'reviewing', base, head, review_task: id!, findings: [], fixed: [], fix_tasks: [], version: 1 }, {
      tasks: [{
        id: id!, stage: flow.stage, kind: 'analysis', role: REVIEWER_ROLE, scopes: ['review'], depends_on: [], inputs: [], writes: [], verify: [], final_review: true,
        title: `最终代码审查：${flow.title}`.slice(0, 200),
        acceptance: [`用 git diff ${base.slice(0, 12)} ${head.slice(0, 12)} -- . ':(exclude)prototype' 查看整个流程的改动，按技能 code-review 对照项目规范逐个文件审查`,
          '每条问题写清级别（must 必须改 / suggest 建议）、依据、文件、位置、问题、期望；功能是否做到不在审查范围内（已经过独立验收）',
          '用 flow_review_report 一次提交全部问题；没有问题提交空列表'],
      }],
      handoffs: { [id!]: `审查范围：${base.slice(0, 12)}..${head.slice(0, 12)}（${flow.integration_branch}，不含原型）\n\n${stat}` },
      actor: 'engine', reason: `所有模块验收通过，派最终代码审查（${id}）`,
    });
    return { wait: true, changed: true };
  }
  const save = (next: FinalReviewFile, reason: string, opts: { tasks?: TaskInput[]; handoffs?: Record<string, string> } = {}) =>
    store.updateFinalReview(flowId, next, { ...opts, actor: 'engine', reason }).then(() => ({ wait: next.status !== 'done', changed: true }));
  switch (r.status) {
    case 'reviewing': {
      const t = tasks.find((x) => x.id === r.review_task);
      if (t && t.status !== 'done' && t.status !== 'cancelled') return { wait: true, changed: false };
      commitFileToBranch(root, flow.integration_branch, FINAL_REVIEW_DOC, `${renderDoc(flow, r)}\n`, `pi-flow: ${flowId} 最终代码审查`);
      const must = r.findings.filter((f) => f.level === 'must');
      const { inputs, handoffs, unowned } = fixTasks(tasks, flow, must);
      // 定位不到模块的必须改留给用户决定
      const fixed = must.filter((f) => !unowned.includes(f)).map((f) => f.id);
      const next = { ...r, fixed, fix_tasks: inputs.map((t) => t.id) };
      if (inputs.length) return save({ ...next, status: 'fixing' }, `审查完成：${r.findings.length} 条问题，${fixed.length} 条必须改交给模块修复（${inputs.map((t) => t.id).join('、')}）`, { tasks: inputs, handoffs });
      return save({ ...next, status: open(next).length ? 'awaiting_user' : 'done' }, `审查完成：${r.findings.length} 条问题${open(next).length ? '，等你挑选要修的' : ''}`);
    }
    case 'fixing': {
      if (r.fix_tasks.some((id) => { const t = tasks.find((x) => x.id === id); return t && t.status !== 'done' && t.status !== 'cancelled'; })) return { wait: true, changed: false };
      return save({ ...r, status: r.decided || !open(r).length ? 'done' : 'awaiting_user' }, open(r).length && !r.decided ? '必须改的已修复，其余等你挑选' : '审查提出的修复已完成');
    }
    case 'awaiting_user':
      return { wait: true, changed: false };
    case 'done':
      return { wait: false, changed: false };
  }
}

/** /flow review fix R-3 R-5：用户挑选要修的条目，交给负责的模块修复（一轮，不再复审） */
export async function fixFindings(store: StateStore, flowId: string, ids: readonly string[]): Promise<string> {
  const r = store.readFinalReview(flowId);
  if (!r) throw new FinalReviewError('还没有最终代码审查。');
  if (r.status !== 'awaiting_user') throw new FinalReviewError(`最终代码审查当前是 ${STATUS_LABEL[r.status]}，${r.status === 'done' ? '已经结束' : '等它完成后再挑选'}。`);
  const want = [...new Set(ids.map((x) => x.toUpperCase()))];
  const unknown = want.filter((id) => !r.findings.some((f) => f.id === id));
  if (unknown.length) throw new FinalReviewError(`没有这些条目：${unknown.join('、')}（/flow review 查看）`);
  const done = want.filter((id) => r.fixed.includes(id));
  if (done.length) throw new FinalReviewError(`这些条目已经修过：${done.join('、')}`);
  const flow = store.readFlow(flowId);
  const { inputs, handoffs, unowned } = fixTasks(store.listTasks(flowId), flow, r.findings.filter((f) => want.includes(f.id)));
  if (unowned.length) throw new FinalReviewError(`${unowned.map((f) => f.id).join('、')} 涉及的文件不属于任何模块，没法交给模块修复；可以用 /flow replan "<怎么改>" 交给 architect 安排`);
  await store.updateFinalReview(flowId, { ...r, status: 'fixing', decided: true, fixed: [...r.fixed, ...want], fix_tasks: [...r.fix_tasks, ...inputs.map((t) => t.id)] }, {
    tasks: inputs, handoffs, actor: 'human', reason: `用户挑选 ${want.join('、')} 交给模块修复（${inputs.map((t) => t.id).join('、')}）`,
  });
  return `已把 ${want.join('、')} 交给负责的模块修复：${inputs.map((t) => `${t.id}（${t.title}）`).join('；')}。修好后执行阶段检查。`;
}

/** /flow review done：其余建议不修，结束审查 */
export async function finishReview(store: StateStore, flowId: string): Promise<string> {
  const r = store.readFinalReview(flowId);
  if (!r) throw new FinalReviewError('还没有最终代码审查。');
  if (r.status !== 'awaiting_user') throw new FinalReviewError(`最终代码审查当前是 ${STATUS_LABEL[r.status]}，不需要你决定。`);
  await store.updateFinalReview(flowId, { ...r, status: 'done', decided: true }, { actor: 'human', reason: `其余 ${open(r).length} 条不修，结束审查` });
  return `已结束最终代码审查（其余 ${open(r).length} 条不修，记录在 ${FINAL_REVIEW_DOC}）。接着执行阶段检查。`;
}

export const STATUS_LABEL: Record<FinalReviewFile['status'], string> = { reviewing: '审查中', fixing: '修复中', awaiting_user: '等你挑选', done: '已结束' };

/** /flow review 与状态视图：审查结论与待挑选的条目 */
export function describeReview(r: FinalReviewFile): string {
  const left = open(r);
  const head = `最终代码审查：${STATUS_LABEL[r.status]}；${r.findings.length} 条问题（必须改 ${r.findings.filter((f) => f.level === 'must').length}），已交给模块修复 ${r.fixed.length} 条`;
  if (!r.findings.length) return head;
  return `${head}\n${r.findings.map((f) => `- ${findingLine(f)}${r.fixed.includes(f.id) ? '（已修复）' : ''}`).join('\n')}${r.status === 'awaiting_user' && left.length ? `\n挑选要修的：/flow review fix ${left.slice(0, 3).map((f) => f.id).join(' ')}；都不修：/flow review done` : ''}`;
}

/** 审查者提交结论（flow_review_report 的业务部分）；返回错误（空数组表示已保存） */
export async function recordReview(root: string, store: StateStore, flowId: string, task: TaskFile, findings: readonly ReviewFinding[], summary: string, actor: string): Promise<string[]> {
  const r = store.readFinalReview(flowId);
  if (!r || r.status !== 'reviewing' || r.review_task !== task.id) return ['审查记录不在等待这个任务结论的状态，本次运行无效'];
  const errs: string[] = [];
  const ids = findings.map((f) => f.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errs.push(`重复的编号：${[...new Set(dup)].join('、')}`);
  const changed = new Set(reviewedFiles(root, r));
  const outside = [...new Set(findings.flatMap((f) => f.files).filter((f) => !changed.has(f)))];
  if (outside.length) errs.push(`这些文件不在审查范围的改动里：${outside.slice(0, 10).join('、')}（只审这次改动的代码，files 写仓库内的相对路径）`);
  if (errs.length) return errs;
  await store.updateFinalReview(flowId, { ...r, findings: findings.map((f) => ({ ...f, files: [...f.files] })), summary: summary.slice(0, 2000) }, {
    actor, reason: `审查结论：${findings.length} 条问题（必须改 ${findings.filter((f) => f.level === 'must').length}）`,
  });
  return [];
}
