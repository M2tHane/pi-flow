// 把一个项目的 .flow/ 状态生成一个可交互的 HTML（自包含，不联网）：任务状态机与转移次数、任务 DAG、运行时间线、成本、事件日志、原始状态。
//   node scripts/flow-view.ts <项目目录> [--out <文件>]
// 默认输出到 <项目目录>.flow-view.html（项目目录之外，不污染工作区）。只读，不修改 .flow/。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore, handoffRel } from '../src/core/state-store.ts';
import { TRANSITIONS } from '../src/core/state-machine.ts';

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out') ?? '.');
const out = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]!) : `${dir.replace(/\/$/, '')}.flow-view.html`;
if (!existsSync(path.join(dir, '.flow', 'state.json'))) { console.error(`${dir} 不是 pi-flow 项目（缺少 .flow/state.json）`); process.exit(1); }

const store = new StateStore(dir);
const state = store.readState();
const flows = store.listFlows().map((id) => {
  const flow = store.readFlow(id);
  const tasks = store.listTasks(id);
  const handoffs: Record<string, string> = {};
  for (const t of tasks) {
    const f = store.abs(handoffRel(id, t.id));
    if (existsSync(f)) handoffs[t.id] = readFileSync(f, 'utf8').slice(-3000);
  }
  return { flow, tasks, handoffs };
});
const events = store.readEvents().map(({ entities: _e, prev_hash: _p, hash: _h, ...e }) => e);
const data = {
  generatedAt: new Date().toISOString(),
  project: dir,
  activeFlow: state.active_flow,
  flows,
  runs: store.listRuns(),
  events,
  transitions: TRANSITIONS.map((r) => ({ from: [...r.from], to: r.to, trigger: r.trigger, failure: !!r.failure })),
  modelPauses: store.readModelPauses().pauses,
  mergeQueue: store.readMergeQueue(),
  knowledge: store.readKnowledge().entries.length,
};
const json = JSON.stringify(data).replace(/</g, '\\u003c');
// 页面模板在 flow-view.html：数据以 JSON 内嵌，页面不联网
const html = readFileSync(path.join(import.meta.dirname, 'flow-view.html'), 'utf8');
writeFileSync(out, html.replace('/*__DATA__*/null', () => json));
console.log(`已生成：${out}`);
