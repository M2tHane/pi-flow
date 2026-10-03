// M4 验收：合并队列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setupProject, PROJECT_YAML, DIRECT_YAML } from '../helpers/project.ts';
import { makeEngine, commitToBranch } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { mkTask } from '../helpers/tasks.ts';

const withTest = (cmd: string) => PROJECT_YAML.replace(/  test:      ".*"/, `  test:      "${cmd}"`);
const approve = async (a: FakeAgent) => { assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok); };
async function implement(a: FakeAgent, files: Record<string, string>) {
  await a.call('flow_claim');
  for (const [p, c] of Object.entries(files)) assert.ok((await a.call('write', { path: p, content: c })).ok, p);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: Object.keys(files).join(',') });
  assert.ok(r.ok, r.text);
}
const until = async (cond: () => boolean, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
};

/** 回放事件：任何时刻最多一个任务处于（未挂起的）merging */
function assertSingleMerging(events: { type: string; task?: string; from?: string; to?: string }[]) {
  const merging = new Set<string>();
  for (const e of events) {
    if (e.type === 'merge_conflict' && e.task && merging.has(e.task)) { merging.delete(e.task); continue; }
    if (e.type !== 'transition' || !e.task) continue;
    if (e.to === 'merging') { assert.equal(merging.size, 0, `${e.task} 开始合并时 ${[...merging]} 仍在合并`); merging.add(e.task); }
    if (e.from === 'merging') merging.delete(e.task);
  }
}

test('正常合并：squash 成单个提交快进到集成分支，清理 worktree 与分支，同一时间只有一个 merging', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] }), mkTask('T-002', { verify: ['typecheck'] }), mkTask('T-003', { verify: [] })] });
  try {
    const { engine, merges, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      const id = a.env.task.toLowerCase();
      await a.call('flow_claim');
      await a.call('write', { path: `src/server/${id}/a.ts`, content: id });
      await a.call('write', { path: `src/server/${id}/b.ts`, content: id });
      await a.call('flow_note', { text: 'n' });
      await a.call('flow_submit', { summary: `实现 ${id}` });
    }, { version: 1, roles: { 'backend-engineer': { model: 'f/m' }, reviewer: { model: 'f/r' } } });
    // 并发 2：T-001、T-002 先跑；T-003 在名额空出后由 next 派发
    await engine.next(p.flowId);
    await until(() => ['T-001', 'T-002'].every((id) => p.store.readTask(p.flowId, id).status === 'done'));
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) {
      const t = p.store.readTask(p.flowId, id);
      assert.equal(t.status, 'done', `${id} ${t.last_failure ?? ''}`);
      assert.ok(!existsSync(t.worktree ?? '/nonexistent'), 'worktree 已清理');
      assert.equal(p.git('branch', '--list', `flow/${p.flowId}/${id}`), '', '任务分支已删除');
    }
    const log = p.git('log', '--format=%s', `flow/${p.flowId}/integration`).split('\n');
    assert.deepEqual(log.slice(0, 3).sort(), ['[B-001/T-001] 任务 T-001', '[B-001/T-002] 任务 T-002', '[B-001/T-003] 任务 T-003']);
    assert.equal(merges.filter((m) => m.kind === 'merged').length, 3);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-002/b.ts`), 't-002');
    assert.ok(!existsSync(path.join(p.dir, 'src/server/t-001')), '主工作区（main）不受影响');
    assert.ok(p.store.readEvents().filter((e) => e.type === 'merge').length === 3);
    assertSingleMerging(p.store.readEvents());
    assert.deepEqual(p.store.readMergeQueue().queue, []);
    assert.equal(p.store.readMergeQueue().merging, null);
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('语义冲突：writes 不重叠、各自 verify 通过，后合并者在合并后验证中被拦下并重新派发', async () => {
  const p = await setupProject({
    yaml: withTest('[ ! -f src/server/t-002/b.ts ] || cmp -s src/server/t-001/a.ts src/server/t-002/b.ts'),
    files: { 'src/server/t-001/a.ts': 'v1\n' },
    tasks: [mkTask('T-001', { verify: ['test'] }), mkTask('T-002', { verify: ['test'] })],
  });
  try {
    const { engine, merges } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') return approve(a);
      if (a.env.task === 'T-001') return implement(a, { 'src/server/t-001/a.ts': 'v2\n' });
      if (nth === 1) {
        // 依据自己基线上的 a.ts（v1）实现；等 T-001 合入后再提交，制造语义冲突
        await until(() => p.store.readTask(p.flowId, 'T-001').status === 'done');
        return implement(a, { 'src/server/t-002/b.ts': 'v1\n' });
      }
      // 第二次派发：worktree 已 rebase 到集成分支，读到新的 a.ts
      const cur = await a.call('read', { path: 'src/server/t-001/a.ts' });
      return implement(a, { 'src/server/t-002/b.ts': cur.text });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const vf = merges.find((m) => m.kind === 'verify_failed');
    assert.ok(vf && vf.task === 'T-002', JSON.stringify(merges));
    if (vf?.kind === 'verify_failed') assert.match(vf.reason, /合并后验证失败.*test 退出码 1/s);
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.equal(t2.status, 'done');
    assert.equal(t2.attempts, 1);
    assert.ok(readdirEvidence(p.dir, p.flowId, 'T-002').some((f) => f.startsWith('merge-a0-test')));
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-002/b.ts`), 'v2');
    assertSingleMerging(p.store.readEvents());
  } finally { p.cleanup(); }
});

test('先行验收测试：确认失败后不单独合入；承载者从测试分支开工，合并后验证失败重新提交时测试不计入其 diff，最终两者一并快进', async () => {
  const accept = mkTask('T-001', { kind: 'test', role: 'test-engineer', scopes: ['acceptance'], writes: ['tests/acceptance/a/**'], verify: ['test'] });
  const p = await setupProject({
    // 验收测试存在而实现（ok.ts）缺失时失败；集成分支上出现 break.ts 后还需要 fix.ts
    yaml: withTest('[ ! -f tests/acceptance/a/a.test.ts ] || [ -f src/server/t-002/ok.ts ] && { [ ! -f src/server/x/break.ts ] || [ -f src/server/t-002/fix.ts ]; }'),
    tasks: [accept, mkTask('T-002', { deps: [{ task: 'T-001', type: 'hard', reason: '先有验收测试' }], verify: ['test'] })],
  });
  try {
    const settings = { version: 1 as const, roles: { 'backend-engineer': { model: 'f/m' }, 'test-engineer': { model: 'f/t' }, reviewer: { model: 'f/r' } } };
    const { engine, merges, errors } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') return approve(a);
      if (a.env.task === 'T-001') return implement(a, { 'tests/acceptance/a/a.test.ts': 'expect(ok)\n' });
      if (nth === 1) {
        // 基线就是验收测试分支末端：测试文件已在 worktree 中
        assert.ok((await a.call('read', { path: 'tests/acceptance/a/a.test.ts' })).ok);
        // 同时集成分支被别处推进：合并后验证会失败
        commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'src/server/x/break.ts': 'x\n' }, 'other');
        return implement(a, { 'src/server/t-002/ok.ts': 'ok\n' });
      }
      return implement(a, { 'src/server/t-002/fix.ts': 'fix\n' });
    }, settings);
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'ready');
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t1 = p.store.readTask(p.flowId, 'T-001');
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.equal(t2.status, 'done', `${t2.status} ${t2.last_failure ?? ''}`);
    assert.ok(p.store.readEvents().some((e) => e.task === 'T-001' && e.trigger === 'repro_confirmed'));
    assert.ok(!merges.some((m) => m.task === 'T-001'), '验收测试不单独合入');
    const vf = merges.find((m) => m.kind === 'verify_failed' && m.task === 'T-002');
    assert.ok(vf, JSON.stringify(merges));
    assert.ok(!p.store.readEvents().some((e) => e.task === 'T-002' && e.trigger === 'review_reject'), '重新提交没有因测试文件越界被拒');
    const log = p.git('log', '--format=%s', `flow/${p.flowId}/integration`).split('\n');
    assert.match(log[0]!, /\/T-002\]/, log.join('\n'));
    assert.match(log[1]!, /\/T-001\]/, log.join('\n'));
    assert.equal(log[2], 'other');
    assert.ok(!existsSync(t1.worktree ?? '/nonexistent'), '验收测试的 worktree 随承载者合入后清理');
    assert.equal(p.git('branch', '--list', `flow/${p.flowId}/T-001`), '');
  } finally { p.cleanup(); }
});

function readdirEvidence(dir: string, flow: string, task: string): string[] {
  return readdirSync(path.join(dir, '.flow/flows', flow, 'evidence', task));
}

test('文本冲突在 writes 内：生成 merge-fix，原任务挂起让出名额；merge-fix 合入后原任务一并完成', async () => {
  const p = await setupProject({
    yaml: withTest("! grep -rq '<<<<<<<' src"),
    files: { 'src/server/t-001/a.ts': 'line1\nbase\nline3\n' },
    tasks: [mkTask('T-001', { verify: ['test'] })],
  });
  try {
    let fixPrompt = '';
    const { engine, merges, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      if (a.env.task === 'T-001') {
        // 在本任务提交前，别人改了集成分支上的同一行
        commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'src/server/t-001/a.ts': 'line1\nhuman\nline3\n' }, '他人修改');
        return implement(a, { 'src/server/t-001/a.ts': 'line1\ntask\nline3\n' });
      }
      fixPrompt = a.spec.prompt;
      const cur = await a.call('read', { path: 'src/server/t-001/a.ts' });
      assert.match(cur.text, /<<<<<<< /);
      // 写 writes 之外的文件会被拦下（merge-fix 的可写范围只有冲突文件）
      assert.equal((await a.call('write', { path: 'src/server/t-001/other.ts', content: 'x' })).ok, false);
      return implement(a, { 'src/server/t-001/a.ts': 'line1\nhuman+task\nline3\n' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const mf = merges.find((m) => m.kind === 'merge_fix');
    assert.ok(mf, JSON.stringify(merges));
    if (mf?.kind !== 'merge_fix') return;
    assert.deepEqual(mf.conflicts, ['src/server/t-001/a.ts']);
    const fix = p.store.readTask(p.flowId, mf.mergeFix);
    assert.equal(fix.kind, 'merge-fix');
    assert.equal(fix.merge_fix_for, 'T-001');
    assert.deepEqual(fix.writes, ['src/server/t-001/a.ts']);
    assert.equal(fix.status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(fixPrompt, /合并冲突（程序生成）/);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'line1\nhuman+task\nline3');
    assert.match(p.git('log', '-1', '--format=%s', `flow/${p.flowId}/integration`), /^\[B-001\/T-001\] 任务 T-001（经 T-002 解决合并冲突）$/);
    assert.ok(p.store.readEvents().some((e) => e.type === 'merge_conflict' && e.task === 'T-001'));
    assert.deepEqual(p.store.readMergeQueue().suspended ?? [], []);
    assertSingleMerging(p.store.readEvents());
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('冲突涉及契约：转 blocked，不生成 merge-fix', async () => {
  const p = await setupProject({
    files: { 'docs/contracts/api.ts': 'export type A = 1;\n' },
    tasks: [mkTask('T-001', { role: 'architect', scopes: ['docs'], writes: ['docs/**'], verify: ['typecheck'] })],
  });
  try {
    const { engine, merges } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'docs/contracts/api.ts': 'export type A = 2;\n' }, '他人改契约');
      return implement(a, { 'docs/contracts/api.ts': 'export type A = 3;\n' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /冲突涉及契约或受保护文件：docs\/contracts\/api\.ts/);
    assert.ok(!merges.some((m) => m.kind === 'merge_fix'));
    assert.equal(p.store.listTasks(p.flowId).length, 1);
    assert.equal(p.store.readMergeQueue().merging, null);
  } finally { p.cleanup(); }
});

test('merge-fix 残留冲突标记：合并后检查拦下，回到 in_progress；最终失败时原任务也转 blocked', async () => {
  const p = await setupProject({
    files: { 'src/server/t-001/a.ts': 'base\n' },
    tasks: [mkTask('T-001', { verify: ['typecheck'] })],
  });
  try {
    const { engine, merges } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      if (a.env.task === 'T-001') {
        commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'src/server/t-001/a.ts': 'human\n' }, '他人修改');
        return implement(a, { 'src/server/t-001/a.ts': 'task\n' });
      }
      // merge-fix 实施者偷懒：不解决冲突，只加一行
      const cur = await a.call('read', { path: 'src/server/t-001/a.ts' });
      return implement(a, { 'src/server/t-001/a.ts': `${cur.text}// todo\n` });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const fails = merges.filter((m) => m.kind === 'verify_failed');
    assert.ok(fails.length >= 1 && fails.every((f) => f.kind === 'verify_failed' && /残留冲突标记/.test(f.reason)));
    const fix = p.store.listTasks(p.flowId).find((t) => t.kind === 'merge-fix')!;
    assert.equal(fix.status, 'blocked');
    const orig = p.store.readTask(p.flowId, 'T-001');
    assert.equal(orig.status, 'blocked');
    assert.match(orig.blocked_reason ?? '', new RegExp(`merge-fix ${fix.id} 失败`));
    assert.doesNotMatch(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), /<<<<<<</);
  } finally { p.cleanup(); }
});

test('合并后验证使用 codegraph 给出的受影响测试；拿不到时退回全量 test', async () => {
  const p = await setupProject({
    yaml: withTest('true').replace('test_affected: "true {files}"', 'test_affected: "for f in {files}; do test -f $f; done"'),
    files: { 'tests/a.test.ts': 'ok' },
    tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] }), mkTask('T-002', { verify: ['typecheck', 'test'] })],
  });
  try {
    const seen: string[][] = [];
    const { engine, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      return implement(a, { [`src/server/${a.env.task.toLowerCase()}/a.ts`]: 'ok' });
    }, undefined, {
      affectedFiles: async (_wt, changed) => { seen.push(changed); return changed.some((c) => c.includes('t-001')) ? ['tests/a.test.ts'] : null; },
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors.map(String), []);
    const ev = (id: string) => readdirEvidence(p.dir, p.flowId, id).filter((f) => f.startsWith('merge-'));
    assert.deepEqual(ev('T-001').sort(), ['merge-a0-test_affected.log', 'merge-a0-typecheck.log']);
    assert.deepEqual(ev('T-002').sort(), ['merge-a0-test.log', 'merge-a0-typecheck.log']);
    assert.equal(seen.length, 2);
  } finally { p.cleanup(); }
});

test('关闭逐任务审查（默认）：提交后不派审查直接进入合并队列；合并时跑全量 typecheck、lint、test，失败退回实施并重新派发，修好后合入；文档类任务不跑命令', async () => {
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001', { verify: ['test'] }), mkTask('T-002', { verify: [] })] });
  try {
    const { engine, merges, errors } = makeEngine(p, async (role, nth, a) => {
      assert.notEqual(role, 'reviewer', '不应派审查');
      if (a.env.task === 'T-002') return implement(a, { 'src/server/t-002/readme.md': 'doc' });
      // 第一次带着 FAIL 提交（全量 test 会失败），第二次修好
      return implement(a, { 'src/server/t-001/a.ts': nth === 1 ? 'FAIL' : 'ok' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (const id of ['T-001', 'T-002']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);
    const t1 = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t1.attempts, 1);
    const vf = merges.find((m) => m.kind === 'verify_failed');
    assert.ok(vf?.kind === 'verify_failed' && vf.task === 'T-001', JSON.stringify(merges));
    if (vf?.kind === 'verify_failed') assert.match(vf.reason, /全量 typecheck、lint、test 中 test 退出码 1/);
    assert.deepEqual(readdirEvidence(p.dir, p.flowId, 'T-001').sort(),
      ['merge-a0-lint.log', 'merge-a0-test.log', 'merge-a0-typecheck.log', 'merge-a1-lint.log', 'merge-a1-test.log', 'merge-a1-typecheck.log']);
    assert.ok(!existsSync(path.join(p.dir, '.flow/flows', p.flowId, 'evidence', 'T-002')), '文档类任务不跑命令');
    const evs = p.store.readEvents().filter((e) => e.type === 'transition');
    assert.ok(!evs.some((e) => e.to === 'review' || e.to === 'verifying'), '不经过审查与 verify');
    assert.equal(evs.filter((e) => e.trigger === 'submit_direct').length, 3);
    assert.deepEqual(p.store.listRuns().map((r) => r.role).sort(), ['backend-engineer', 'backend-engineer', 'backend-engineer']);
    assertSingleMerging(p.store.readEvents());
  } finally { p.cleanup(); }
});
