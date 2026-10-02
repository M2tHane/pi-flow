import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore, StateError } from '../../src/core/state-store.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { appendEvents, buildEvent, readEvents } from '../../src/core/event-log.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask, hard, soft } from '../helpers/tasks.ts';

let clock = new Date('2026-01-01T00:00:00Z');
const now = () => clock;
const later = (min: number) => new Date(clock.getTime() + min * 60_000).toISOString();

async function setup() {
  const repo = tmpRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const store = await StateStore.init(repo.dir, { now });
  return { ...repo, store };
}

async function flowWithTasks(store: StateStore) {
  const flow = await store.createFlow({ mode: 'build', title: '测试', stages: ['S3', 'S4'], base_sha: 'abc' });
  await store.addTasks(flow.id, [
    mkTask('T-001'),
    mkTask('T-002', { deps: [hard('T-001')] }),
    mkTask('T-003', { writes: ['src/server/t-001/shared/**'], deps: [soft('T-001')] }),
  ], 'architect');
  return flow;
}

const lease = (run: string, token: string) => ({
  run_id: run, role: 'backend-engineer', token_hash: hashToken(token), acquired_at: clock.toISOString(), expires_at: later(30),
});

async function toInProgress(store: StateStore, flow: string, id: string, run = 'r-1', token = 'tok') {
  await store.transitionTask(flow, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  return store.transitionTask(flow, id, {
    to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher',
    patch: { lease: lease(run, token), worktree: `/wt/${id}`, branch: `flow/${flow}/${id}`, base_sha: 'abc' },
  });
}

async function toQueued(store: StateStore, flow: string, id: string, run: string, token: string) {
  await toInProgress(store, flow, id, run, token);
  await store.appendHandoff(flow, id, '完成', `run:${run}`);
  await store.transitionTask(flow, id, { to: 'review', trigger: 'submit', actor: `run:${run}`,
    facts: { token, diff_files: [`src/server/${id.toLowerCase()}/a.ts`] } });
  await store.updateTask(flow, id, { lease: lease(`${run}-rev`, `${token}-rev`) }, { actor: 'dispatcher', type: 'dispatch' });
  await store.transitionTask(flow, id, { to: 'verifying', trigger: 'review_pass', actor: `run:${run}-rev`, facts: { token: `${token}-rev` } });
  await store.saveEvidence(flow, id, 'test.log', 'ok', 'verify-runner');
  await store.transitionTask(flow, id, { to: 'queued_merge', trigger: 'verify_pass', actor: 'verify-runner',
    facts: { verify_results: [{ command: 'test', exit_code: 0 }] } });
}

test('init 生成骨架且可重复执行', async () => {
  const { dir, git, store, cleanup } = await setup();
  try {
    for (const f of ['state.json', 'events.jsonl', 'merge-queue.json', '.gitignore', 'flows', 'runs', 'fixes']) {
      assert.ok(existsSync(path.join(dir, '.flow', f)), f);
    }
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
    const before = readFileSync(path.join(dir, '.flow/events.jsonl'), 'utf8');
    await StateStore.init(dir, { now });
    assert.equal(readFileSync(path.join(dir, '.flow/events.jsonl'), 'utf8'), before);
    // 状态提交在专用引用上，不进入分支历史
    assert.match(git('log', '-1', '--format=%s', 'refs/pi-flow/state'), /^flow-state:/);
    assert.doesNotMatch(git('log', '--format=%s', 'HEAD'), /flow-state:/);
    assert.equal(git('ls-files', '--', '.flow'), '');
  } finally { cleanup(); }
});

test('迁移：早期版本提交在分支上的 .flow/ 移出分支历史，之后状态只提交到专用引用', async () => {
  const { dir, git, cleanup } = tmpRepo();
  try {
    await StateStore.init(dir, { now, git: false });
    git('add', '-f', '.flow');
    git('commit', '-q', '-m', '旧版本：状态提交在分支上');
    const store = new StateStore(dir, { now });
    await store.recordEvent({ flow: null, actor: 'engine', type: 'note', reason: '迁移后的第一次写入' });
    assert.equal(git('ls-files', '--', '.flow'), '');
    assert.match(git('log', '-1', '--format=%s', 'HEAD'), /移出分支历史/);
    assert.match(git('log', '-1', '--format=%s', 'refs/pi-flow/state'), /迁移后的第一次写入/);
    assert.equal(git('status', '--porcelain'), '', '.flow/ 已被本地排除，不显示为未跟踪');
    assert.ok(git('ls-tree', '-r', '--name-only', 'refs/pi-flow/state').includes('.flow/events.jsonl'));
    assert.ok(!git('ls-tree', '-r', '--name-only', 'refs/pi-flow/state').includes('tx.json'));
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { cleanup(); }
});

test('非 git 仓库拒绝初始化', async () => {
  const { dir, cleanup } = tmpRepo();
  try {
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    await assert.rejects(StateStore.init(dir, { now }), /git/);
  } finally { cleanup(); }
});

test('完整闭环：pending 到 done，合并队列同步，每次转移都提交', async () => {
  const { dir, git, store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const commitsBefore = Number(git('rev-list', '--count', 'refs/pi-flow/state'));
    const headBefore = git('rev-parse', 'HEAD');
    await toInProgress(store, flow.id, 'T-001');
    await store.appendHandoff(flow.id, 'T-001', '做完了 A，下一步无', 'run:r-1');
    await store.transitionTask(flow.id, 'T-001', { to: 'review', trigger: 'submit', actor: 'run:r-1',
      facts: { token: 'tok', diff_files: ['src/server/t-001/a.ts'] } });
    await store.updateTask(flow.id, 'T-001', { lease: lease('r-2', 'rtok') }, { actor: 'dispatcher', type: 'dispatch' });
    await store.transitionTask(flow.id, 'T-001', { to: 'verifying', trigger: 'review_pass', actor: 'run:r-2', facts: { token: 'rtok' } });
    await store.saveEvidence(flow.id, 'T-001', 'test.log', 'ok', 'verify-runner');
    await store.transitionTask(flow.id, 'T-001', { to: 'queued_merge', trigger: 'verify_pass', actor: 'verify-runner',
      facts: { verify_results: [{ command: 'test', exit_code: 0 }] } });
    assert.deepEqual(store.readMergeQueue().queue.map((e) => e.task), ['T-001']);
    await store.transitionTask(flow.id, 'T-001', { to: 'merging', trigger: 'merge_start', actor: 'merge-queue' });
    assert.equal(store.readMergeQueue().merging?.task, 'T-001');
    await store.transitionTask(flow.id, 'T-001', { to: 'done', trigger: 'merge_done', actor: 'merge-queue',
      facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true } });
    assert.equal(store.readMergeQueue().merging, null);
    assert.equal(store.readTask(flow.id, 'T-001').status, 'done');

    const { events } = readEvents(path.join(dir, '.flow/events.jsonl'));
    assert.equal(store.readState().version, events.at(-1)!.seq);
    assert.equal(store.readState().events_head, events.at(-1)!.hash);
    const commits = Number(git('rev-list', '--count', 'refs/pi-flow/state')) - commitsBefore;
    assert.ok(commits >= 9, `提交数 ${commits}`);
    assert.equal(git('rev-parse', 'HEAD'), headBefore, '主分支历史不变');
    assert.equal(git('status', '--porcelain', '--', '.flow'), '');
    assert.deepEqual((await store.verifyIntegrity()).errors, []);

    // T-002 硬依赖 T-001，现在可以 ready
    await store.transitionTask(flow.id, 'T-002', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  } finally { cleanup(); }
});

test('非法转移被拒且不落盘', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const v = store.readState().version;
    await assert.rejects(store.transitionTask(flow.id, 'T-001', { to: 'done', trigger: 'merge_done', actor: 'x' }), StateError);
    await assert.rejects(store.transitionTask(flow.id, 'T-002', { to: 'ready', trigger: 'schedule', actor: 'scheduler' }), /T-001/);
    assert.equal(store.readState().version, v);
    assert.equal(store.readTask(flow.id, 'T-002').status, 'pending');
  } finally { cleanup(); }
});

test('程序可推导的 facts 不采信调用方', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    await assert.rejects(store.transitionTask(flow.id, 'T-002', { to: 'ready', trigger: 'schedule', actor: 'scheduler',
      facts: { status_of: new Map([['T-001', 'done']]), stage_active: true } }), /T-001/);
    await toInProgress(store, flow.id, 'T-001');
    await assert.rejects(store.transitionTask(flow.id, 'T-001', { to: 'review', trigger: 'submit', actor: 'run:r-1',
      facts: { token: 'tok', diff_files: ['src/server/t-001/a.ts'], handoff_written: true } }), /handoff/);
  } finally { cleanup(); }
});

test('互斥任务不能同时进行；并发上限生效', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    await toInProgress(store, flow.id, 'T-001');
    // T-003 的 writes 落在 T-001 的 writes 内
    await assert.rejects(toInProgress(store, flow.id, 'T-003', 'r-3', 't3'), /互斥.*T-001/);
  } finally { cleanup(); }
});

test('同一时间只有一个 merging，且按队列顺序', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await store.createFlow({ mode: 'build', title: 'm', stages: ['S3'], base_sha: 'abc' });
    await store.addTasks(flow.id, [mkTask('T-001'), mkTask('T-002')], 'architect');
    await toQueued(store, flow.id, 'T-001', 'r-1', 't1');
    await toQueued(store, flow.id, 'T-002', 'r-3', 't2');
    await assert.rejects(store.transitionTask(flow.id, 'T-002', { to: 'merging', trigger: 'merge_start', actor: 'mq' }), /轮到/);
    await store.transitionTask(flow.id, 'T-001', { to: 'merging', trigger: 'merge_start', actor: 'mq' });
    await assert.rejects(store.transitionTask(flow.id, 'T-002', { to: 'merging', trigger: 'merge_start', actor: 'mq' }), /T-001/);
    await store.transitionTask(flow.id, 'T-001', { to: 'queued_merge', trigger: 'merge_requeue', actor: 'resume' });
    assert.deepEqual(store.readMergeQueue().queue.map((e) => e.task), ['T-001', 'T-002']);
    assert.equal(store.readMergeQueue().merging, null);
  } finally { cleanup(); }
});

test('篡改任务文件、事件、state、新增或删除文件后完整性校验失败', async () => {
  const cases: [string, (dir: string, flow: string) => void, RegExp][] = [
    ['改任务文件', (d, f) => {
      const p = path.join(d, `.flow/flows/${f}/tasks/T-001.json`);
      writeFileSync(p, readFileSync(p, 'utf8').replace('"pending"', '"done"'));
    }, /T-001\.json/],
    ['改事件', (d) => {
      const p = path.join(d, '.flow/events.jsonl');
      writeFileSync(p, readFileSync(p, 'utf8').replace('"actor":"architect"', '"actor":"human"'));
    }, /哈希/],
    ['删事件末尾', (d) => {
      const p = path.join(d, '.flow/events.jsonl');
      const lines = readFileSync(p, 'utf8').trimEnd().split('\n');
      writeFileSync(p, lines.slice(0, -1).join('\n') + '\n');
    }, /events_head|version/],
    ['改 state', (d) => {
      const p = path.join(d, '.flow/state.json');
      writeFileSync(p, readFileSync(p, 'utf8').replace(/"active_flow": "B-001"/, '"active_flow": null'));
    }, /state/],
    ['新增未登记文件', (d, f) => writeFileSync(path.join(d, `.flow/flows/${f}/tasks/T-099.json`), '{}'), /未登记/],
    ['删除任务文件', (d, f) => rmSync(path.join(d, `.flow/flows/${f}/tasks/T-002.json`)), /T-002\.json/],
    ['追加伪造事件行', (d) => appendFileSync(path.join(d, '.flow/events.jsonl'), '{"seq":999}\n'), /第 \d+ 行/],
  ];
  for (const [name, tamper, re] of cases) {
    const { dir, store, cleanup } = await setup();
    try {
      const flow = await flowWithTasks(store);
      assert.deepEqual((await store.verifyIntegrity()).errors, [], name);
      tamper(dir, flow.id);
      const r = await store.verifyIntegrity();
      assert.equal(r.ok, false, name);
      assert.match(r.errors.join('\n'), re, `${name}: ${r.errors.join('\n')}`);
    } finally { cleanup(); }
  }
});

test('完整性不一致时拒绝继续写入', async () => {
  const { dir, store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const p = path.join(dir, '.flow/events.jsonl');
    const lines = readFileSync(p, 'utf8').trimEnd().split('\n');
    writeFileSync(p, lines.slice(0, -1).join('\n') + '\n');
    await assert.rejects(store.transitionTask(flow.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' }), /完整性/);
  } finally { cleanup(); }
});

test('乐观版本：基于旧版本的写入被拒', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const stale = store.readTask(flow.id, 'T-001');
    await store.transitionTask(flow.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await assert.rejects(store.transaction((tx) => {
      tx.putTask(flow.id, stale);
      tx.event({ flow: flow.id, actor: 'x', type: 'note' });
    }), /版本/);
  } finally { cleanup(); }
});

test('schema 不合法的写入被拒', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const t = store.readTask(flow.id, 'T-001');
    await assert.rejects(store.transaction((tx) => {
      tx.putTask(flow.id, { ...t, status: 'flying' as never });
      tx.event({ flow: flow.id, actor: 'x', type: 'note' });
    }), /schema|status/);
    await assert.rejects(store.transaction((tx) => { tx.putTask(flow.id, t); }), /事件/);
  } finally { cleanup(); }
});

test('事务日志：写入中途崩溃后可重放', async () => {
  const { dir, store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const crashing = new StateStore(dir, { now, faultInjection: 'after-journal' });
    await assert.rejects(crashing.transitionTask(flow.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' }), /fault/);
    assert.ok(existsSync(path.join(dir, '.flow/tx.json')));
    assert.equal(store.readTask(flow.id, 'T-001').status, 'pending');
    await store.recover();
    assert.equal(store.readTask(flow.id, 'T-001').status, 'ready');
    assert.ok(!existsSync(path.join(dir, '.flow/tx.json')));
    assert.deepEqual((await store.verifyIntegrity()).errors, []);

    const crashing2 = new StateStore(dir, { now, faultInjection: 'mid-apply' });
    await assert.rejects(crashing2.transitionTask(flow.id, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd',
      patch: { lease: lease('r-1', 'tok'), worktree: '/wt', branch: 'b', base_sha: 'abc' } }), /fault/);
    // 下一次写入会先自动重放
    await store.appendHandoff(flow.id, 'T-001', 'x', 'run:r-1');
    assert.equal(store.readTask(flow.id, 'T-001').status, 'in_progress');
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { cleanup(); }
});

test('并发写入被文件锁串行化，哈希链保持完整', async () => {
  const { dir, store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    const other = new StateStore(dir, { now });
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? store : other).recordEvent({ flow: flow.id, actor: 'engine', type: 'note', reason: `n${i}` })));
    const { events } = readEvents(path.join(dir, '.flow/events.jsonl'));
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { cleanup(); }
});

test('同一时间只允许一个进行中的流程', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.createFlow({ mode: 'build', title: 'a', stages: ['S0'], base_sha: null });
    await assert.rejects(store.createFlow({ mode: 'feature', title: 'b', stages: ['F0'], base_sha: null }), /进行中.*\/flow resume/);
  } finally { cleanup(); }
});

test('阶段：agent 不能批准闸门；用户批准后推进到下一阶段', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await store.createFlow({ mode: 'build', title: 'a', stages: ['S0', 'S1'], base_sha: null });
    await store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await store.transitionStage(flow.id, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    await assert.rejects(store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'run:r-1' }), /用户/);
    await store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'human' });
    assert.equal(store.readFlow(flow.id).approvals.S0?.by, 'human');
    const f = await store.advanceStage(flow.id, 'engine');
    assert.equal(f.stage, 'S1');
    assert.equal(f.stage_status, 'active');
    await assert.rejects(store.advanceStage(flow.id, 'engine'), /done/);
  } finally { cleanup(); }
});

test('契约在 S1 批准后变为受保护路径', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await store.createFlow({ mode: 'build', title: 'a', stages: ['S1', 'S3'], base_sha: null });
    await store.addTasks(flow.id, [mkTask('T-001', { stage: 'S3', writes: ['docs/**'] })], 'architect');
    for (const [to, trigger, extra] of [['awaiting_gate', 'submit_gate', {}], ['awaiting_human', 'gate_passed', { needs_human: true }], ['done', 'approve', {}]] as const) {
      await store.transitionStage(flow.id, { to, trigger, actor: trigger === 'approve' ? 'human' : 'engine', ...extra });
    }
    await store.advanceStage(flow.id, 'engine');
    await toInProgress(store, flow.id, 'T-001');
    await store.appendHandoff(flow.id, 'T-001', 'x', 'run:r-1');
    await assert.rejects(store.transitionTask(flow.id, 'T-001', { to: 'review', trigger: 'submit', actor: 'run:r-1',
      facts: { token: 'tok', diff_files: ['docs/contracts/api.ts'], contracts_locked: false } }), /受保护/);
  } finally { cleanup(); }
});

test('并发上限：max_parallel=2 时第三个任务不能进入 in_progress', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await store.createFlow({ mode: 'build', title: 'p', stages: ['S3'], base_sha: 'abc' });
    await store.addTasks(flow.id, [mkTask('T-001'), mkTask('T-002'), mkTask('T-003')], 'architect');
    await toInProgress(store, flow.id, 'T-001', 'r-1', 'a');
    await toInProgress(store, flow.id, 'T-002', 'r-2', 'b');
    await assert.rejects(toInProgress(store, flow.id, 'T-003', 'r-3', 'c'), /并发已达上限 2/);
  } finally { cleanup(); }
});

test('updateTask 不能修改状态等受控字段', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    for (const patch of [{ status: 'done' }, { attempts: 0 }, { writes: ['**'] }]) {
      await assert.rejects(store.updateTask(flow.id, 'T-001', patch as never, { actor: 'x', type: 'note' }), /不能修改/);
    }
    assert.equal(store.readTask(flow.id, 'T-001').status, 'pending');
  } finally { cleanup(); }
});

test('并发取得租约：只有一个成功（防止重复派发审查或重新派发）', async () => {
  const { store, cleanup } = await setup();
  try {
    const flow = await flowWithTasks(store);
    await toInProgress(store, flow.id, 'T-001');
    await store.transitionTask(flow.id, 'T-001', { to: 'in_progress', trigger: 'run_failed', actor: 'x', facts: { reason: '崩溃' } });
    const results = await Promise.allSettled([
      store.acquireLease(flow.id, 'T-001', lease('r-a', 'a'), 'd'),
      store.acquireLease(flow.id, 'T-001', lease('r-b', 'b'), 'd'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), /已有运行中的 run/);
  } finally { cleanup(); }
});

test('性能：事件数上万时，单次转移的耗时不随事件数线性增长（只读日志末尾，读缓存）', async () => {
  const { dir, cleanup } = tmpRepo();
  try {
    const store = await StateStore.init(dir, { now, git: false });
    const avg = async (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await store.recordEvent({ flow: null, actor: 'engine', type: 'note', reason: `测量 ${i}` });
      return (performance.now() - t0) / n;
    };
    await avg(20);
    const small = await avg(30);
    // 直接按哈希链追加 2 万条事件（绕过事务以节省时间），并同步 state.json
    const file = path.join(dir, '.flow/events.jsonl');
    let last = readEvents(file).events.at(-1)!;
    const batch = [];
    for (let i = 0; i < 20_000; i++) {
      last = buildEvent(last, { ts: '2026-10-01T00:00:00Z', flow: null, actor: 'engine', type: 'note', reason: `填充 ${i}` });
      batch.push(last);
    }
    appendEvents(file, batch);
    const state = JSON.parse(readFileSync(path.join(dir, '.flow/state.json'), 'utf8'));
    writeFileSync(path.join(dir, '.flow/state.json'), JSON.stringify({ ...state, version: last.seq, events_head: last.hash }, null, 2));
    const large = await avg(30);
    assert.ok(large < small * 1.5 + 2, `约 50 条时 ${small.toFixed(2)} ms/次，2 万条时 ${large.toFixed(2)} ms/次`);
    // 增量读取与完整读取一致
    assert.deepEqual(store.readEvents(), readEvents(file).events);
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { cleanup(); }
});
