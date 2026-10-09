// 模块独立验收（第五轮）：模块任务合并后，没参与实现的验收者在集成分支上实际构建、运行，对照验收标准逐条确认。
//   1. 程序为合并了的模块派验收任务（acceptor，只读仓库，可在临时目录运行程序）：flow_accept 逐条给出 passed 与证据；
//   2. 全部通过 → 模块已验收，依赖它的模块开工；有没通过的 → 交回实现者的会话修复（review-fix，fork 原会话）；
//   3. 修复合并后派复查（flow_accept_confirm，只能回答没通过的条目）；两轮仍不过 → 需要你处理（/flow accept 人工放行）。
// 实施阶段的闸门（全量测试）失败时，按失败日志找到负责的模块生成修复任务，最多两轮。
// 记录在 flows/<id>/acceptance/<任务>.json，引擎每次 pump 按它推进，崩溃后从中途继续。
import type { FlowConfig } from './config.ts';
import type { StateStore, TaskInput } from './state-store.ts';
import type { AcceptanceFile, AcceptanceResult, FlowFile, TaskFile } from './schemas.ts';
import { isSettled } from './state-machine.ts';
import { git } from './git.ts';
import { removeWorktree, taskBranch, worktreePath } from './worktree.ts';
import { matchesAny } from './paths.ts';

export const ACCEPTOR_ROLE = 'acceptor';
/** 验收不通过后自动修复的轮次上限 */
export const MAX_ACCEPT_ROUNDS = 2;
/** 实施阶段闸门的全量测试失败后自动修复的轮次上限 */
export const MAX_GATE_ROUNDS = 2;

export interface AcceptanceDeps { root: string; store: StateStore; config: FlowConfig }

const nextIds = (tasks: readonly TaskFile[], n: number): string[] => {
  const first = Math.max(0, ...tasks.map((t) => Number(t.id.slice(2)))) + 1;
  return Array.from({ length: n }, (_, i) => `T-${String(first + i).padStart(3, '0')}`);
};

export const criteriaOf = (t: Pick<TaskFile, 'acceptance'>) => t.acceptance.map((text, i) => ({ id: `A-${i + 1}`, text }));

const line = (c: { id: string; text: string }, r?: AcceptanceResult) => `${c.id} ${c.text}${r ? `（${r.passed ? '通过' : '未通过'}${r.manual ? '，需要用户打开查看' : ''}${r.evidence ? `：${r.evidence}` : ''}）` : ''}`;
export const failedOf = (a: AcceptanceFile) => a.criteria.filter((c) => a.results.find((r) => r.id === c.id)?.passed === false);

function acceptorTask(id: string, mod: TaskFile, kind: 'check' | 'confirm', ids: readonly string[]): TaskInput {
  return {
    id, stage: mod.stage, kind: 'analysis', role: ACCEPTOR_ROLE, scopes: ['acceptance'], depends_on: [], inputs: [...mod.inputs], writes: [], verify: [],
    accept_of: mod.id, accept_kind: kind, ...(mod.size ? { size: mod.size } : {}),
    title: `${kind === 'check' ? '验收' : '复查'}：${mod.title}`.slice(0, 200),
    acceptance: kind === 'check'
      ? ['在集成分支最新代码上构建并运行（启动服务、调用接口、跑相关测试；不打开桌面应用或浏览器窗口），对照下面的每条验收标准确认', ...criteriaOf(mod).map((c) => `${c.id} ${c.text}`),
        '用 flow_accept 逐条提交 passed 与证据（运行的命令、请求与响应、看到的结果）；只看验收标准，不提风格与重构建议']
      : [`只复查这些条目：${ids.join('、')}；用 flow_accept_confirm 逐条提交 passed 与证据，不能提出新问题`],
  };
}

function fixTask(id: string, mod: TaskFile, failed: readonly { id: string; text: string }[], results: readonly AcceptanceResult[], round: number): TaskInput {
  return {
    id, stage: mod.stage, kind: 'review-fix', role: mod.role, scopes: [...mod.scopes], depends_on: [], inputs: [...mod.inputs],
    writes: [...mod.writes], ...(mod.shared?.length ? { shared: [...mod.shared] } : {}), verify: [...mod.verify],
    title: `${round === 1 ? '' : '再修一轮：'}验收未通过「${mod.title}」（${failed.map((c) => c.id).join('、')}）`.slice(0, 200),
    acceptance: [...failed.map((c) => line(c, results.find((r) => r.id === c.id))), '只修这些条目，不顺手改别处；修好后全量测试仍然通过'],
    fork_from_task: mod.id,
  };
}

const cleanup = (root: string, flowId: string, taskId: string | null) => { if (taskId) removeWorktree(root, worktreePath(root, flowId, taskId), taskBranch(flowId, taskId)); };

/** 推进全部模块的验收（每次 pump 调用）；返回是否写入了新状态 */
export async function acceptanceStep(d: AcceptanceDeps, flowId: string): Promise<boolean> {
  let changed = false;
  // 每写一步就按最新状态再看一次：验收通过时不会有子进程结束来触发下一次 pump
  for (let i = 0; i < 50; i++) {
    if (!(await stepOnce(d, flowId))) return changed;
    changed = true;
  }
  return changed;
}

async function stepOnce(d: AcceptanceDeps, flowId: string): Promise<boolean> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'active' && flow.stage_status !== 'awaiting_gate') return false;
  const tasks = store.listTasks(flowId);
  for (const mod of tasks.filter((t) => t.needs_acceptance && t.status === 'done')) {
    const a = store.readAcceptance(flowId, mod.id);
    if (!a) {
      const [id] = nextIds(tasks, 1);
      await store.updateAcceptance(flowId, { task: mod.id, status: 'checking', round: 0, criteria: criteriaOf(mod), results: [], check_task: id!, fix_tasks: [], confirm_tasks: [], version: 1 }, {
        tasks: [acceptorTask(id!, mod, 'check', [])],
        handoffs: { [id!]: `验收的模块：${mod.id}「${mod.title}」（已合并到集成分支）。可写范围：${mod.writes.join('、')}。\n验收标准：\n${criteriaOf(mod).map((c) => line(c)).join('\n')}` },
        actor: 'engine', reason: `模块 ${mod.id} 已合并，派验收（${id}）`,
      });
      return true;
    }
    if (await advance(d, flow, mod, a, tasks)) return true;
  }
  return false;
}

async function advance(d: AcceptanceDeps, flow: FlowFile, mod: TaskFile, a: AcceptanceFile, tasks: readonly TaskFile[]): Promise<boolean> {
  const { store } = d;
  const settled = (ids: readonly (string | null)[]) => ids.every((id) => { const t = id ? tasks.find((x) => x.id === id) : undefined; return !t || isSettled(t); });
  const save = (next: AcceptanceFile, reason: string, opts: { tasks?: TaskInput[]; handoffs?: Record<string, string> } = {}) =>
    store.updateAcceptance(flow.id, next, { ...opts, actor: 'engine', reason: `模块 ${mod.id}：${reason}` }).then(() => true);
  const lastConfirm = a.confirm_tasks.at(-1) ?? null;
  switch (a.status) {
    case 'checking':
    case 'confirming': {
      const watching = a.status === 'checking' ? a.check_task : lastConfirm;
      if (!settled([watching])) return false;
      cleanup(d.root, flow.id, watching);
      const failed = failedOf(a);
      const answered = a.criteria.every((c) => a.results.some((r) => r.id === c.id));
      if (!answered) return save({ ...a, status: 'needs_human', reason: '验收者没有给出全部条目的结论' }, '验收没有完成，需要你处理');
      if (!failed.length) return save({ ...a, status: 'accepted' }, '验收通过');
      if (a.round >= MAX_ACCEPT_ROUNDS) return save({ ...a, status: 'needs_human', reason: `修复 ${MAX_ACCEPT_ROUNDS} 轮后仍有 ${failed.length} 条没通过：${failed.map((c) => c.id).join('、')}` }, '两轮修复后仍未通过，需要你处理');
      const [id] = nextIds(tasks, 1);
      const round = a.round + 1;
      return save({ ...a, status: 'fixing', round, fix_tasks: [...a.fix_tasks, id!] }, `${failed.length} 条没通过，交回实现者修复（第 ${round} 轮，${id}）`, {
        tasks: [fixTask(id!, mod, failed, a.results, round)],
        handoffs: { [id!]: `独立验收没通过的条目（程序生成，第 ${round}/${MAX_ACCEPT_ROUNDS} 轮）：\n${failed.map((c) => line(c, a.results.find((r) => r.id === c.id))).join('\n')}\n\n只修这些条目；验收者的结论有误或无法在可写范围内修好时，用 flow_block 说明。` },
      });
    }
    case 'fixing': {
      const fix = a.fix_tasks.at(-1) ?? null;
      if (!settled([fix])) return false;
      const failed = failedOf(a);
      const [id] = nextIds(tasks, 1);
      return save({ ...a, status: 'confirming', confirm_tasks: [...a.confirm_tasks, id!] }, `修复已合并，派复查（${id}）`, {
        tasks: [acceptorTask(id!, mod, 'confirm', failed.map((c) => c.id))],
        handoffs: { [id!]: `复查的模块：${mod.id}「${mod.title}」。只复查这些条目：\n${failed.map((c) => line(c, a.results.find((r) => r.id === c.id))).join('\n')}` },
      });
    }
    default:
      return false;
  }
}

/**
 * 要用户自己打开应用查看的检查项（agent 不启动桌面应用与浏览器）：规划时写的 manual_checks，加上验收者标为 manual 的条目。
 * 只列已验收通过的模块（代码层面已经确认过）。
 */
export function manualChecksOf(store: StateStore, flowId: string): { task: string; title: string; items: string[] }[] {
  const out: { task: string; title: string; items: string[] }[] = [];
  for (const t of store.listTasks(flowId).filter((x) => x.needs_acceptance && x.accepted)) {
    const a = store.readAcceptance(flowId, t.id);
    const flagged = a ? a.criteria.filter((c) => a.results.find((r) => r.id === c.id)?.manual).map((c) => c.text) : [];
    const items = [...new Set([...(t.manual_checks ?? []), ...flagged])];
    if (items.length) out.push({ task: t.id, title: t.title, items });
  }
  return out;
}

/** 本阶段需要验收的模块是否都已通过（实施阶段闸门的前提） */
export function allAccepted(tasks: readonly TaskFile[], stage: string): boolean {
  return tasks.filter((t) => t.stage === stage && t.needs_acceptance && t.status === 'done').every((t) => t.accepted);
}

/** 验收者提交逐条结论（flow_accept / flow_accept_confirm 的业务部分）；返回错误（空数组表示已保存） */
export async function recordAcceptance(store: StateStore, flowId: string, acceptTask: TaskFile, results: readonly AcceptanceResult[], summary: string, actor: string): Promise<string[]> {
  const a = acceptTask.accept_of ? store.readAcceptance(flowId, acceptTask.accept_of) : null;
  if (!a) return ['找不到这个模块的验收记录'];
  const expectStatus = acceptTask.accept_kind === 'check' ? 'checking' : 'confirming';
  const expectTask = acceptTask.accept_kind === 'check' ? a.check_task : a.confirm_tasks.at(-1);
  if (a.status !== expectStatus || expectTask !== acceptTask.id) return ['验收记录不在等待这个任务结论的状态，本次运行无效'];
  const allowed = acceptTask.accept_kind === 'check' ? a.criteria.map((c) => c.id) : failedOf(a).map((c) => c.id);
  const ids = results.map((r) => r.id);
  const errs: string[] = [];
  const extra = ids.filter((x) => !allowed.includes(x));
  if (extra.length) errs.push(`不在${acceptTask.accept_kind === 'check' ? '验收标准' : '待复查条目'}中的编号：${extra.join('、')}`);
  const missing = allowed.filter((x) => !ids.includes(x));
  if (missing.length) errs.push(`没有回答：${missing.join('、')}`);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errs.push(`重复回答：${[...new Set(dup)].join('、')}`);
  if (errs.length) return errs;
  const merged = [...a.results.filter((r) => !ids.includes(r.id)), ...results.map((r) => ({ ...r }))].sort((x, y) => Number(x.id.slice(2)) - Number(y.id.slice(2)));
  await store.updateAcceptance(flowId, { ...a, results: merged, summary: summary.slice(0, 2000) }, {
    actor, reason: `${acceptTask.accept_kind === 'check' ? '验收' : '复查'}结论：${results.filter((r) => r.passed).length}/${results.length} 通过`,
  });
  return [];
}

/** 用户人工放行（/flow accept <任务>）：需要你处理的验收标记为通过 */
export async function acceptManually(store: StateStore, flowId: string, taskId: string, note: string): Promise<string> {
  const a = store.readAcceptance(flowId, taskId);
  if (!a) throw new Error(`任务 ${taskId} 没有验收记录`);
  if (a.status === 'accepted') return `${taskId} 已经验收通过。`;
  if (a.status !== 'needs_human') throw new Error(`${taskId} 的验收还在进行（${describeAcceptance(a)}），只有"需要你处理"时才能人工放行。`);
  await store.updateAcceptance(flowId, { ...a, status: 'accepted', reason: `用户人工放行${note ? `：${note}` : ''}` }, { actor: 'human', reason: '用户人工放行' });
  return `已人工放行 ${taskId}，依赖它的模块可以开工。`;
}

export function describeAcceptance(a: AcceptanceFile): string {
  const failed = failedOf(a).length;
  switch (a.status) {
    case 'checking': return '验收中';
    case 'fixing': return `${failed} 条没通过，第 ${a.round} 轮修复中`;
    case 'confirming': return `修复已合并，复查中（第 ${a.round} 轮）`;
    case 'accepted': return a.reason?.startsWith('用户人工放行') ? '已人工放行' : `验收通过（${a.criteria.length} 条）`;
    case 'needs_human': return `需要你处理：${a.reason ?? '验收未通过'}`;
  }
}

// —— 实施阶段闸门（全量测试）失败：按日志找到负责的模块，交回它的会话修复，最多两轮 ——

/** 从失败输出中找出仓库里的文件（测试文件、报错位置） */
export function failingFiles(output: string, tracked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[\w@.\-/]+\.[A-Za-z0-9]+/g)) {
    let p = m[0].replace(/^\.\//, '');
    if (!tracked.has(p)) {
      const parts = p.split('/');
      p = parts.map((_, i) => parts.slice(i).join('/')).find((x) => tracked.has(x)) ?? '';
    }
    if (p) out.add(p);
  }
  return [...out].slice(0, 20);
}

function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/**
 * 闸门的全量测试失败：日志涉及的文件交给写过它的模块修复（每个模块一个任务，fork 原会话）。
 * 返回生成的任务 id；已修两轮或定位不到模块时返回空数组并给出原因（由调用方提示用户）。
 */
export async function gateFailed(d: AcceptanceDeps, flowId: string, failed: { command: string; output: string }): Promise<{ tasks: string[]; reason?: string }> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  const rounds = (flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage);
  if (rounds.length >= MAX_GATE_ROUNDS) return { tasks: [], reason: `全量 ${failed.command} 自动修复 ${MAX_GATE_ROUNDS} 轮后仍失败` };
  const tracked = new Set(safeGit(d.root, ['ls-tree', '-r', '--name-only', flow.integration_branch]).split('\n').filter(Boolean));
  const files = failingFiles(failed.output, tracked);
  const tasks = store.listTasks(flowId);
  const mods = tasks.filter((t) => t.stage === flow.stage && t.needs_acceptance && t.status === 'done');
  const groups = new Map<string, Set<string>>();
  for (const f of files) {
    const owner = mods.find((t) => matchesAny(f, t.writes)) ?? mods.find((t) => matchesAny(f, t.shared ?? []));
    if (owner) groups.set(owner.id, (groups.get(owner.id) ?? new Set()).add(f));
  }
  if (!groups.size) return { tasks: [], reason: `全量 ${failed.command} 失败，但无法从日志定位负责的模块` };
  const round = rounds.length + 1;
  const ids = nextIds(tasks, groups.size);
  const tail = failed.output.trim().split('\n').slice(-60).join('\n').slice(-4000);
  const inputs: TaskInput[] = [];
  const handoffs: Record<string, string> = {};
  [...groups].forEach(([modId, fs], n) => {
    const mod = mods.find((t) => t.id === modId)!;
    const id = ids[n]!;
    inputs.push({
      id, stage: flow.stage, kind: 'review-fix', role: mod.role, scopes: [...mod.scopes], depends_on: [], inputs: [...fs],
      writes: [...mod.writes], ...(mod.shared?.length ? { shared: [...mod.shared] } : {}), verify: [...mod.verify],
      title: `修复全量 ${failed.command} 失败（第 ${round} 轮）：${[...fs].slice(0, 3).join('、')}`.slice(0, 200),
      acceptance: [`实施阶段闸门的全量 ${failed.command} 失败，日志涉及 ${[...fs].join('、')}：找到原因并修复，修好后全量 ${failed.command} 通过`,
        '原因不在你的可写范围内时，用 flow_block 写明是哪个模块、什么输入、期望与实际'],
      fork_from_task: mod.id,
    });
    handoffs[id] = `实施阶段的全量测试失败（程序生成，第 ${round}/${MAX_GATE_ROUNDS} 轮）。\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail}\n\`\`\``;
  });
  await store.addGateRound(flowId, { stage: flow.stage, command: failed.command, tasks: ids, at: new Date().toISOString() }, inputs, handoffs);
  return { tasks: ids };
}
