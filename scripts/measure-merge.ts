// 第二轮 K：测量合并队列是否是瓶颈。20 个互不相关的小任务（fake-subagent，不调用模型），
// 分别用"合并后验证几乎不耗时"与"合并后验证耗时 VERIFY_S 秒"两种设置跑完，统计合并队列占用的时间与总耗时。
//   node scripts/measure-merge.ts [任务数=20] [模拟验证秒数=2] [实施耗时毫秒=3000]
import { setupProject, PROJECT_YAML } from '../test/helpers/project.ts';
import { makeEngine } from '../test/helpers/engine.ts';
import { mkTask } from '../test/helpers/tasks.ts';

const N = Number(process.argv[2] ?? 20);
const VERIFY_S = Number(process.argv[3] ?? 2);
const IMPL_MS = Number(process.argv[4] ?? 3000);

async function run(label: string, testCmd: string) {
  const yaml = PROJECT_YAML.replace(/  test:      ".*"/, `  test:      "${testCmd}"`).replace(/max_parallel: 2(\s)/, 'max_parallel: 4$1');
  const tasks = Array.from({ length: N }, (_, i) => mkTask(`T-${String(i + 1).padStart(3, '0')}`, { verify: ['test'] }));
  const p = await setupProject({ yaml, tasks });
  try {
    const { engine } = makeEngine(p, async (_role, _n, a) => {
      await a.call('flow_claim');
      await new Promise((r) => setTimeout(r, IMPL_MS)); // 模拟实施耗时
      await a.call('write', { path: `src/server/${a.env.task.toLowerCase()}/a.ts`, content: a.env.task });
      await a.call('flow_note', { text: 'n' });
      await a.call('flow_submit', { summary: a.env.task });
    });
    const t0 = Date.now();
    while (p.store.listTasks(p.flowId).some((t) => t.status !== 'done')) {
      await engine.next(p.flowId);
      await engine.waitForChange(500);
      if (p.store.listTasks(p.flowId).some((t) => t.status === 'blocked')) throw new Error('有任务阻塞');
    }
    await engine.idle();
    const total = Date.now() - t0;
    // 合并耗时：每个任务 merge_start → merge_done（事件时间戳）
    const ev = p.store.readEvents().filter((e) => e.flow === p.flowId && e.type === 'transition');
    let merging = 0;
    let queuedWait = 0;
    for (const t of tasks) {
      const start = ev.find((e) => e.task === t.id && e.trigger === 'merge_start');
      const done = ev.find((e) => e.task === t.id && e.trigger === 'merge_done');
      const queued = ev.find((e) => e.task === t.id && e.trigger === 'verify_pass');
      if (start && done) merging += Date.parse(done.ts) - Date.parse(start.ts);
      if (queued && start) queuedWait += Date.parse(start.ts) - Date.parse(queued.ts);
    }
    console.log(`${label}：${N} 个任务总耗时 ${(total / 1000).toFixed(1)} 秒；合并队列占用 ${(merging / 1000).toFixed(1)} 秒（${Math.round((merging / total) * 100)}%），平均每次合并 ${(merging / N / 1000).toFixed(2)} 秒；任务在队列中平均等待 ${(queuedWait / N / 1000).toFixed(2)} 秒`);
  } finally { p.cleanup(); }
}

await run('合并后验证几乎不耗时', 'true');
await run(`合并后验证耗时 ${VERIFY_S} 秒`, `sleep ${VERIFY_S}`);
