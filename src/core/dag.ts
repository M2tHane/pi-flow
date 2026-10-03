// DAG：依赖类型校验、环检测、互斥推导、ready 计算、关键路径与宽度统计。纯函数，不做 IO。
import type { TaskFile } from './schemas.ts';
import { globWithin, globsOverlap } from './paths.ts';

type DagTask = Pick<TaskFile, 'id' | 'kind' | 'role' | 'scopes' | 'depends_on' | 'writes' | 'verify'>;

export interface DagCatalog {
  roles: Record<string, { scopes: string[] }>;
  scopes: Record<string, string[]>;
  commands: string[];
  maxTaskFiles: number;
}

export interface DagValidation {
  errors: string[];
  warnings: string[];
}

export function validateDag(tasks: readonly DagTask[], catalog: DagCatalog): DagValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, DagTask>();

  for (const t of tasks) {
    if (byId.has(t.id)) errors.push(`任务 id 重复：${t.id}`);
    byId.set(t.id, t);
  }

  for (const t of tasks) {
    const role = catalog.roles[t.role];
    if (!role) errors.push(`${t.id}：角色 ${t.role} 不存在`);
    for (const s of t.scopes) {
      if (!(s in catalog.scopes)) errors.push(`${t.id}：scope ${s} 不存在`);
      else if (role && !role.scopes.includes(s)) errors.push(`${t.id}：角色 ${t.role} 不拥有 scope ${s}`);
    }
    for (const c of t.verify) {
      if (!catalog.commands.includes(c)) errors.push(`${t.id}：verify 引用了未定义的命令 ${c}，只能使用 workflow.yaml 的 commands`);
    }
    if (role) {
      const allowed = t.scopes.filter((s) => role.scopes.includes(s)).flatMap((s) => catalog.scopes[s] ?? []);
      for (const w of t.writes) {
        if (!allowed.some((o) => globWithin(w, o))) errors.push(`${t.id}：writes ${w} 越出了任务 scopes 的可写范围`);
      }
    }
    if (t.writes.length > catalog.maxTaskFiles) {
      warnings.push(`${t.id}：writes 有 ${t.writes.length} 项，超过 max_task_files=${catalog.maxTaskFiles}，建议拆分`);
    }
    const seen = new Set<string>();
    for (const d of t.depends_on) {
      if (d.task === t.id) errors.push(`${t.id}：不能依赖自己`);
      if (!byId.has(d.task)) errors.push(`${t.id}：依赖的任务 ${d.task} 不存在`);
      if (seen.has(d.task)) errors.push(`${t.id}：对 ${d.task} 的依赖重复声明`);
      seen.add(d.task);
      if (d.type === 'hard' && !d.reason?.trim()) errors.push(`${t.id}：对 ${d.task} 的硬依赖缺少 reason`);
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);

  // 每条软依赖都必须有一个 integration 任务对两端都是硬依赖
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (d.type !== 'soft') continue;
      const covered = tasks.some((i) => i.kind === 'integration' &&
        hasHard(i, t.id) && hasHard(i, d.task));
      if (!covered) errors.push(`${t.id} 对 ${d.task} 的软依赖缺少 integration 任务（需对两端都是硬依赖）`);
    }
  }

  return { errors, warnings };
}

const hasHard = (t: Pick<TaskFile, 'depends_on'>, dep: string) => t.depends_on.some((d) => d.task === dep && d.type === 'hard');
const byIdOrder = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });

type LeadTask = Pick<TaskFile, 'id' | 'kind' | 'depends_on'>;

/**
 * 实现类任务：它们硬依赖的测试是"先行验收测试"（实现尚不存在，测试必须先失败）。
 * integration、doc 等任务依赖测试只表示先后顺序（例如对已完成功能的回归测试），不算。
 */
const IMPLEMENTING_KINDS: ReadonlySet<string> = new Set(['impl', 'infra']);

/**
 * 先行验收测试：kind=test，且有实现类任务（impl、infra）硬依赖它（测试先于实现写好）。
 * 它审查通过后必须先失败，确认后不单独合入，由"承载者"从它的分支末端开工并一并合入。
 */
/**
 * 关闭先行验收测试（默认）时的校验：测试任务不能被同阶段的实现任务硬依赖。
 * 实施者为自己的功能边写边测；跨模块的联调、端到端测试放在后面的阶段，对着已实现的功能写。
 */
export function leadingTestErrors(tasks: readonly LeadTask[]): string[] {
  return tasks.filter((t) => isLeadingTest(t, tasks)).map((t) => {
    const users = tasks.filter((x) => IMPLEMENTING_KINDS.has(x.kind) && hasHard(x, t.id)).map((x) => x.id);
    return `${t.id}：本项目不用"先行验收测试"（${users.join('、')} 硬依赖这个测试任务）。请把测试并入实现任务：由实施者为自己的功能写测试并跑通（writes 加上该模块的测试目录，验收标准写明要测什么）；跨模块的联调、端到端测试放到后面的阶段交给 test-engineer。确需先行验收测试时，用户可在 workflow.yaml 设 testing.leading_tests: true`;
  });
}

export function isLeadingTest(t: LeadTask, tasks: readonly LeadTask[]): boolean {
  return t.kind === 'test' && tasks.some((x) => IMPLEMENTING_KINDS.has(x.kind) && hasHard(x, t.id));
}

/** 先行测试的承载者：非 test 硬依赖方中，不（传递）依赖其他依赖方的、编号最小的那个 */
export function carrierOf(test: LeadTask, tasks: readonly LeadTask[]): string | null {
  const deps = tasks.filter((x) => IMPLEMENTING_KINDS.has(x.kind) && hasHard(x, test.id)).sort(byIdOrder);
  const ids = new Set(deps.map((x) => x.id));
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const reaches = (from: string, seen = new Set<string>()): boolean => {
    for (const d of byId.get(from)?.depends_on ?? []) {
      if (ids.has(d.task)) return true;
      if (!seen.has(d.task)) { seen.add(d.task); if (reaches(d.task, seen)) return true; }
    }
    return false;
  };
  return deps.find((x) => !reaches(x.id))?.id ?? deps[0]?.id ?? null;
}

/** 任务承载的先行测试（它的 worktree 从该测试的分支末端建立） */
export function carriedTestOf<T extends LeadTask>(t: LeadTask, tasks: readonly T[]): T | undefined {
  if (t.kind === 'test') return undefined;
  return tasks.find((x) => x.kind === 'test' && hasHard(t, x.id) && carrierOf(x, tasks) === t.id);
}

/**
 * 规范化先行验收测试（flow_propose_tasks 提交时执行）：
 * - 每个先行测试只由一个承载者硬依赖，其余硬依赖它的任务改为硬依赖承载者（测试随承载者合入后才可见）；
 * - 一个任务最多承载一个先行测试；先行测试必须有 verify 命令（程序要运行它确认先失败）。
 */
export function normalizeLeadingTests<T extends DagTask>(input: readonly T[]): { tasks: T[]; notes: string[]; errors: string[] } {
  const tasks = input.map((t) => ({ ...t, depends_on: t.depends_on.map((d) => ({ ...d })) }));
  const notes: string[] = [];
  const errors: string[] = [];
  const carried = new Map<string, string[]>();
  for (const test of [...tasks].sort(byIdOrder)) {
    if (!isLeadingTest(test, tasks)) continue;
    if (!test.verify.length) errors.push(`${test.id}：先行验收测试必须有 verify 命令（例如 test），程序要运行它确认测试在实现前失败`);
    const carrier = carrierOf(test, tasks)!;
    carried.set(carrier, [...(carried.get(carrier) ?? []), test.id]);
    for (const x of tasks) {
      if (x.id === carrier || !hasHard(x, test.id)) continue;
      x.depends_on = x.depends_on.filter((d) => d.task !== test.id);
      const toCarrier = x.depends_on.find((d) => d.task === carrier);
      const reason = `验收测试 ${test.id} 随 ${carrier} 一并合入`;
      if (toCarrier) Object.assign(toCarrier, { type: 'hard', reason: toCarrier.reason?.trim() ? toCarrier.reason : reason });
      else x.depends_on.push({ task: carrier, type: 'hard', reason });
      notes.push(`${x.id} 对 ${test.id} 的硬依赖改为硬依赖 ${carrier}（${reason}）`);
    }
  }
  for (const [carrier, tests] of carried) {
    if (tests.length > 1) errors.push(`${carrier} 同时承载多个先行验收测试（${tests.join('、')}）：一个验收测试任务对应一个实现任务，请合并这些测试任务或拆分实现任务`);
  }
  return { tasks, notes, errors };
}

/** 返回环上的任务 id 序列（首尾相同），无环返回 null。所有依赖类型都参与环检测。 */
export function findCycle(tasks: readonly DagTask[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on.map((d) => d.task)]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const n of deps.get(id) ?? []) {
      if (!deps.has(n)) continue;
      const c = color.get(n) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (c === 0) {
        const r = visit(n);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const r = visit(t.id);
      if (r) return r;
    }
  }
  return null;
}

type ReadyTask = Pick<TaskFile, 'id' | 'stage' | 'status' | 'depends_on'>;

/** 当前 stage 中所有硬依赖都已 done 的 pending 任务。软依赖不影响 ready。 */
export function computeReady(tasks: readonly ReadyTask[], stage: string): string[] {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks
    .filter((t) => t.stage === stage && t.status === 'pending' && hardDepsDone(t, status))
    .map((t) => t.id);
}

export function hardDepsDone(t: Pick<TaskFile, 'depends_on'>, status: ReadonlyMap<string, string>): boolean {
  return t.depends_on.every((d) => d.type !== 'hard' || status.get(d.task) === 'done');
}

type StatTask = Pick<TaskFile, 'id' | 'depends_on'>;

/** 每个任务到汇点的最长硬依赖路径（含自身），用于调度优先级。要求无环。 */
export function remainingPath(tasks: readonly StatTask[]): Map<string, number> {
  const succ = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const d of t.depends_on) if (d.type === 'hard') succ.get(d.task)?.push(t.id);
  }
  const memo = new Map<string, number>();
  const go = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const r = 1 + Math.max(0, ...(succ.get(id) ?? []).map(go));
    memo.set(id, r);
    return r;
  };
  for (const t of tasks) go(t.id);
  return memo;
}

export interface DagStats {
  taskCount: number;
  criticalPathLength: number;
  criticalPath: string[];
  maxWidth: number;
  hardRatio: number;
}

/** 关键路径只计硬依赖；宽度按硬依赖分层统计；要求无环。 */
export function dagStats(tasks: readonly StatTask[]): DagStats {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const go = (id: string): number => {
    const hit = depth.get(id);
    if (hit !== undefined) return hit;
    let best = 0;
    let from: string | null = null;
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (d.type !== 'hard' || !byId.has(d.task)) continue;
      const v = go(d.task);
      if (v > best) { best = v; from = d.task; }
    }
    depth.set(id, best + 1);
    prev.set(id, from);
    return best + 1;
  };
  for (const t of tasks) go(t.id);

  let end: string | null = null;
  for (const t of tasks) if (end === null || depth.get(t.id)! > depth.get(end)!) end = t.id;
  const path: string[] = [];
  for (let cur = end; cur; cur = prev.get(cur) ?? null) path.unshift(cur);

  const levels = new Map<number, number>();
  for (const v of depth.values()) levels.set(v, (levels.get(v) ?? 0) + 1);

  const edges = tasks.flatMap((t) => t.depends_on);
  const hardCount = edges.filter((d) => d.type === 'hard').length;
  return {
    taskCount: tasks.length,
    criticalPathLength: path.length,
    criticalPath: path,
    maxWidth: Math.max(0, ...levels.values()),
    hardRatio: edges.length === 0 ? 0 : hardCount / edges.length,
  };
}

/** 两个任务 writes 是否重叠（互斥）。 */
export function conflictsWith(a: Pick<TaskFile, 'writes'>, b: Pick<TaskFile, 'writes'>): boolean {
  return a.writes.some((x) => b.writes.some((y) => globsOverlap(x, y)));
}

export function mutexPairs(tasks: readonly Pick<TaskFile, 'id' | 'writes'>[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      if (conflictsWith(tasks[i]!, tasks[j]!)) out.push([tasks[i]!.id, tasks[j]!.id]);
    }
  }
  return out;
}

export interface DagReport {
  task_count: number;
  critical_path: string[];
  critical_path_length: number;
  max_width: number;
  hard_ratio: number;
  warnings: string[];
}

/** 第 11 节第 7 条：任务数、关键路径长度（只计硬依赖）、最大并行宽度、硬依赖占比；关键路径过长时提示 */
/** 关键路径占任务数的比例超过它时提醒（第三轮 D：0.6 → 0.5） */
export const CRITICAL_PATH_RATIO = 0.5;
/** 同一阶段开头连续这么多层都只有一个任务时提醒 */
export const SERIAL_HEAD_LAYERS = 2;

/**
 * 每个阶段开头只能串行的任务链：按本阶段内的硬依赖分层，从第一层起连续宽度为 1 的层。
 * 任务少于 4 个的阶段不检查（本来就没多少可并行的）。
 */
export function serialHeads(tasks: readonly (StatTask & { stage?: string })[]): { stage: string | undefined; chain: string[]; total: number }[] {
  const out: { stage: string | undefined; chain: string[]; total: number }[] = [];
  for (const stage of [...new Set(tasks.map((t) => t.stage))]) {
    const group = tasks.filter((t) => t.stage === stage);
    if (group.length < 4) continue;
    const ids = new Set(group.map((t) => t.id));
    const local = group.map((t) => ({ id: t.id, depends_on: t.depends_on.filter((d) => ids.has(d.task)) }));
    const byId = new Map(local.map((t) => [t.id, t]));
    const depth = new Map<string, number>();
    const go = (id: string): number => {
      const hit = depth.get(id);
      if (hit !== undefined) return hit;
      depth.set(id, 1); // 防环（调用前已校验无环）
      const v = 1 + Math.max(0, ...(byId.get(id)?.depends_on ?? []).filter((d) => d.type === 'hard').map((d) => go(d.task)));
      depth.set(id, v);
      return v;
    };
    for (const t of local) go(t.id);
    const chain: string[] = [];
    for (let level = 1; ; level++) {
      const at = local.filter((t) => depth.get(t.id) === level);
      if (at.length !== 1) break;
      chain.push(at[0]!.id);
    }
    if (chain.length >= SERIAL_HEAD_LAYERS) out.push({ stage, chain, total: group.length });
  }
  return out;
}

export function dagReport(tasks: readonly (StatTask & { stage?: string })[], warnings: string[] = []): DagReport {
  const s = dagStats(tasks);
  const w = [...warnings];
  if (s.taskCount >= 4 && s.criticalPathLength / s.taskCount > CRITICAL_PATH_RATIO) {
    w.push(`关键路径 ${s.criticalPathLength} / 任务数 ${s.taskCount}：硬依赖可能用多了。能对着契约或 mock 先做的，改为软依赖并配 integration 任务。`);
  }
  for (const h of serialHeads(tasks)) {
    w.push(`${h.stage ? `阶段 ${h.stage} ` : ''}开头 ${h.chain.length} 层只能串行（${h.chain.join(' → ')}），这段时间只有一个任务在跑：把底座任务合并成一个，或让后续切片对着契约开发（软依赖 + integration），尽早并行。`);
  }
  return {
    task_count: s.taskCount, critical_path: s.criticalPath, critical_path_length: s.criticalPathLength,
    max_width: s.maxWidth, hard_ratio: Math.round(s.hardRatio * 100) / 100, warnings: w,
  };
}

export function formatDagReport(r: DagReport): string {
  return [
    `任务数 ${r.task_count}，关键路径长度 ${r.critical_path_length}（${r.critical_path.join(' → ')}），最大并行宽度 ${r.max_width}，硬依赖占比 ${Math.round(r.hard_ratio * 100)}%`,
    ...r.warnings.map((x) => `! ${x}`),
  ].join('\n');
}
