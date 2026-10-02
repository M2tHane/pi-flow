// 成本度量（第 21 节）：按流程、阶段、角色、任务汇总 token 与耗时；返工次数最多的任务。数据只来自 .flow/runs 与事件日志。
import type { StateStore } from './state-store.ts';
import type { RunFile } from './schemas.ts';

type TokenKey = 'input' | 'output' | 'cache_read' | 'cache_write';
const KEYS: TokenKey[] = ['input', 'output', 'cache_read', 'cache_write'];

export interface CostRow {
  key: string;
  runs: number;
  tokens: Record<TokenKey, number | null>;
  /** token 字段缺失（null）的 run 数，不估算 */
  missing: number;
  duration_ms: number;
  /** 有轮数记录的 run 的轮数合计与次数（旧记录没有轮数） */
  turns: number;
  turnRuns: number;
}

export interface Rework { flow: string; task: string; title: string; review_reject: number; verify_fail: number; merge_fail: number; run_failed: number; total: number }

export interface CostReport {
  total: CostRow;
  byFlow: CostRow[];
  byStage: CostRow[];
  byRole: CostRow[];
  byTask: CostRow[];
  byModel: CostRow[];
  rework: Rework[];
}

function emptyRow(key: string): CostRow {
  return { key, runs: 0, tokens: { input: null, output: null, cache_read: null, cache_write: null }, missing: 0, duration_ms: 0, turns: 0, turnRuns: 0 };
}

function add(row: CostRow, r: RunFile): void {
  row.runs++;
  let miss = false;
  for (const k of KEYS) {
    const v = r.tokens[k];
    if (v === null) { miss = true; continue; }
    row.tokens[k] = (row.tokens[k] ?? 0) + v;
  }
  if (miss) row.missing++;
  if (r.ended_at) row.duration_ms += Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at));
  if (typeof r.turns === 'number') { row.turns += r.turns; row.turnRuns++; }
}

function group(runs: RunFile[], keyOf: (r: RunFile) => string): CostRow[] {
  const m = new Map<string, CostRow>();
  for (const r of runs) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, emptyRow(k));
    add(m.get(k)!, r);
  }
  return [...m.values()].sort((a, b) => (b.tokens.input ?? 0) + (b.tokens.output ?? 0) - (a.tokens.input ?? 0) - (a.tokens.output ?? 0));
}

export function costReport(store: StateStore, opts: { flow?: string } = {}): CostReport {
  const runs = store.listRuns().filter((r) => !opts.flow || r.flow === opts.flow);
  const stageOf = new Map<string, string>();
  const titleOf = new Map<string, string>();
  for (const f of store.listFlows()) for (const t of store.listTasks(f)) { stageOf.set(`${f}/${t.id}`, t.stage); titleOf.set(`${f}/${t.id}`, t.title); }
  const total = emptyRow('合计');
  for (const r of runs) add(total, r);

  const rework = new Map<string, Rework>();
  for (const e of store.readEvents()) {
    if (e.type !== 'transition' || !e.task || !e.flow || (opts.flow && e.flow !== opts.flow)) continue;
    const field = e.trigger === 'review_reject' ? 'review_reject' : e.trigger === 'verify_fail' || e.trigger === 'precheck_fail' ? 'verify_fail'
      : e.trigger === 'merge_verify_fail' ? 'merge_fail' : e.trigger === 'run_failed' ? 'run_failed' : null;
    if (!field) continue;
    const k = `${e.flow}/${e.task}`;
    if (!rework.has(k)) rework.set(k, { flow: e.flow, task: e.task, title: titleOf.get(k) ?? '', review_reject: 0, verify_fail: 0, merge_fail: 0, run_failed: 0, total: 0 });
    const w = rework.get(k)!;
    w[field]++;
    w.total++;
  }
  return {
    total,
    byFlow: group(runs, (r) => r.flow ?? '（无流程）'),
    byStage: group(runs, (r) => `${r.flow}/${stageOf.get(`${r.flow}/${r.task}`) ?? '?'}`),
    byRole: group(runs, (r) => r.role),
    byTask: group(runs, (r) => `${r.flow}/${r.task ?? '-'}`),
    byModel: group(runs, (r) => r.model ?? '（未知）'),
    rework: [...rework.values()].sort((a, b) => b.total - a.total).slice(0, 10),
  };
}

const fmtN = (n: number | null) => (n === null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtT = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分钟` : `${Math.round(ms / 1000)} 秒`);

export function formatRow(r: CostRow): string {
  return `${r.key}：${r.runs} 次运行，输入 ${fmtN(r.tokens.input)}，输出 ${fmtN(r.tokens.output)}，缓存读 ${fmtN(r.tokens.cache_read)}，缓存写 ${fmtN(r.tokens.cache_write)}，耗时 ${fmtT(r.duration_ms)}${r.turnRuns ? `，平均 ${(r.turns / r.turnRuns).toFixed(1)} 轮` : ''}${r.missing ? `（${r.missing} 次运行缺少 token 数据）` : ''}`;
}

export function formatCost(c: CostReport, fixLogs: string[] = []): string {
  const sec = (title: string, rows: CostRow[], limit = 10) => (rows.length ? `## ${title}\n${rows.slice(0, limit).map((r) => `- ${formatRow(r)}`).join('\n')}` : '');
  return [
    `# 成本统计\n${formatRow(c.total)}`,
    sec('按流程', c.byFlow),
    sec('按阶段', c.byStage),
    sec('按角色', c.byRole),
    sec('按模型', c.byModel),
    sec('按任务（前 10）', c.byTask),
    c.rework.length ? `## 返工最多的任务\n${c.rework.map((w) => `- ${w.flow}/${w.task} ${w.title}：共 ${w.total} 次（审查打回 ${w.review_reject}，验证失败 ${w.verify_fail}，合并失败 ${w.merge_fail}，运行失败 ${w.run_failed}）`).join('\n')}` : '## 返工最多的任务\n- 无',
    fixLogs.length ? `## 修复日志\n${fixLogs.map((f) => `- .flow/fixes/${f}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
