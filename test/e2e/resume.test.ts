// M5：恢复（进程内模拟崩溃：丢弃旧引擎，用新的 StateStore 与引擎恢复）。真实强杀见 crash-recovery.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { resume, processAlive } from '../../src/core/resume.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { mkTask } from '../helpers/tasks.ts';

const forever = () => new Promise<void>(() => {});
const until = async (cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
};
const approve = async (a: FakeAgent) => { await a.call('flow_approve', { decision: 'pass' }); };
async function good(a: FakeAgent) {
  await a.call('flow_claim');
  await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
  await a.call('flow_note', { text: '完成' });
  await a.call('flow_submit', { summary: 's' });
}
/** 第一次派发写了文件后挂起（模拟会话被杀），之后的派发正常完成 */
const hangFirst = async (role: string, nth: number, a: FakeAgent) => {
  if (role === 'reviewer') return approve(a);
  if (nth === 1) {
    await a.call('flow_claim');
    await a.call('write', { path: 'src/server/t-001/a.ts', content: 'half' });
    return forever();
  }
  return good(a);
};
const fresh = (p: Project, now?: () => Date) => new StateStore(p.dir, { limits: p.config.limits, ...(now ? { now } : {}) });
const later = (min: number) => () => new Date(Date.now() + min * 60_000);

test('任务进行中会话中断：残留 run 被终止，保留 worktree，计一次失败后重新派发完成', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const old = makeEngine(p, hangFirst);
    await old.engine.next(p.flowId);
    await until(() => existsSync(path.join(p.store.readTask(p.flowId, 'T-001').worktree ?? '/x', 'src/server/t-001/a.ts')));
    // 崩溃：丢弃旧引擎。用一个真实的 sleep 进程代表残留的子进程
    const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const runId = p.store.readTask(p.flowId, 'T-001').lease!.run_id;
    await p.store.updateRun(runId, { pid: orphan.pid! }, 'test');

    const store = fresh(p);
    const r = await resume({ root: p.dir, store, config: p.config });
    assert.ok(r.ok, r.brief);
    assert.ok(!processAlive(orphan.pid!) || (await new Promise((res) => orphan.on('exit', () => res(true)))), '残留进程已被终止');
    assert.ok(r.actions.some((a) => a.includes('终止残留子进程')), r.actions.join('\n'));
    const t = store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.lease, null);
    assert.equal(t.attempts, 1);
    assert.ok(existsSync(t.worktree!), 'worktree 保留');
    assert.equal(store.readRun(runId).outcome, 'killed');
    assert.match(r.brief, /恢复摘要[\s\S]*T-001[\s\S]*最近事件/);

    // 新引擎（新会话）中 nth 从 1 重新计数：用一个总是成功的脚本
    const ok = makeEngine({ ...p, store }, async (role, _n, a) => (role === 'reviewer' ? approve(a) : good(a)));
    await ok.engine.pump(p.flowId);
    await ok.engine.idle();
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('租约过期：worktree 干净回到 ready；有改动时由用户选择继续或丢弃，未选择则挂起', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002'), mkTask('T-003')] });
  try {
    const old = makeEngine(p, async (_role, _n, a) => {
      await a.call('flow_claim');
      if (a.env.task !== 'T-001') await a.call('write', { path: `src/server/${a.env.task.toLowerCase()}/x.ts`, content: 'wip' });
      return forever();
    });
    await old.engine.dispatch(p.flowId, (await old.engine.promote(p.flowId), 'T-001'));
    await old.engine.dispatch(p.flowId, 'T-002');
    await until(() => existsSync(path.join(p.store.readTask(p.flowId, 'T-002').worktree!, 'src/server/t-002/x.ts')));
    const wt1 = p.store.readTask(p.flowId, 'T-001').worktree!;
    const wt2 = p.store.readTask(p.flowId, 'T-002').worktree!;

    // 第一次恢复：不回答 → T-002 挂起等待用户；T-001 干净 → ready
    const store = fresh(p, later(60 * 24));
    const r1 = await resume({ root: p.dir, store, config: p.config, now: later(60 * 24) });
    assert.deepEqual(r1.pending.map((q) => q.task), ['T-002']);
    assert.match(r1.brief, /需要用户决定[\s\S]*T-002/);
    const t1 = store.readTask(p.flowId, 'T-001');
    assert.equal(t1.status, 'ready');
    assert.equal(t1.attempts, 1);
    assert.equal(t1.lease_expirations, 1);
    assert.ok(!existsSync(wt1), '干净的 worktree 已回收');
    assert.equal(store.readTask(p.flowId, 'T-002').status, 'in_progress');

    // 第二次恢复：选择丢弃
    const r2 = await resume({ root: p.dir, store, config: p.config, now: later(60 * 24) }, async () => 'discard');
    assert.deepEqual(r2.pending, []);
    assert.equal(store.readTask(p.flowId, 'T-002').status, 'ready');
    assert.ok(!existsSync(wt2));
    assert.ok(store.readEvents().some((e) => e.type === 'lease_expired' && e.task === 'T-002'));
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('租约过期且有改动：用户选择继续，保留改动并重新派发', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const old = makeEngine(p, async (_r, _n, a) => {
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'keep-me' });
      return forever();
    });
    await old.engine.next(p.flowId);
    const wt = () => p.store.readTask(p.flowId, 'T-001').worktree!;
    await until(() => existsSync(path.join(wt(), 'src/server/t-001/a.ts')));
    const store = fresh(p, later(60 * 24));
    const r = await resume({ root: p.dir, store, config: p.config, now: later(60 * 24) }, async (q) => {
      assert.ok(q.changes.some((c) => c.includes('src/server/')));
      return 'continue';
    });
    assert.deepEqual(r.pending, []);
    const t = store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.lease, null);
    assert.ok(existsSync(path.join(t.worktree!, 'src/server/t-001/a.ts')), '改动保留');
  } finally { p.cleanup(); }
});

test('合并中断（快进前）：放回队首，重新合并完成', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const old = makeEngine(p, async (role, _n, a) => (role === 'reviewer' ? approve(a) : good(a)), undefined, { affectedFiles: forever as never });
    await old.engine.next(p.flowId);
    await until(() => p.store.readTask(p.flowId, 'T-001').status === 'merging' && p.store.readTask(p.flowId, 'T-001').base_sha !== null
      && p.store.readEvents().some((e) => e.reason === 'rebase 到集成分支'));
    const store = fresh(p);
    const r = await resume({ root: p.dir, store, config: p.config });
    assert.ok(r.actions.some((a) => a.includes('放回合并队首')), r.actions.join('\n'));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'queued_merge');
    assert.equal(store.readMergeQueue().merging, null);
    assert.equal(store.readMergeQueue().queue[0]?.task, 'T-001');
    const ok = makeEngine({ ...p, store }, async () => {});
    await ok.engine.pump(p.flowId);
    await ok.engine.idle();
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(p.git('log', '-1', '--format=%s', `flow/${p.flowId}/integration`), /\[B-001\/T-001\]/);
  } finally { p.cleanup(); }
});

test('合并中断（已快进、状态未更新）：识别集成分支已包含提交，补完为 done 并清理', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const old = makeEngine(p, async (role, _n, a) => (role === 'reviewer' ? approve(a) : good(a)), undefined, { affectedFiles: forever as never });
    await old.engine.next(p.flowId);
    await until(() => p.store.readEvents().some((e) => e.reason === 'rebase 到集成分支'));
    const t = p.store.readTask(p.flowId, 'T-001');
    // 模拟：快进已经发生，随后进程被杀
    p.git('update-ref', `refs/heads/flow/${p.flowId}/integration`, p.git('-C', t.worktree!, 'rev-parse', 'HEAD'));
    const store = fresh(p);
    const r = await resume({ root: p.dir, store, config: p.config });
    assert.ok(r.actions.some((a) => a.includes('补完为 done')), r.actions.join('\n'));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.ok(!existsSync(t.worktree!));
    assert.equal(store.readMergeQueue().merging, null);
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('完整性校验失败：记录 integrity_error 并停止，不做任何恢复', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const f = path.join(p.dir, `.flow/flows/${p.flowId}/tasks/T-001.json`);
    writeFileSync(f, (await import('node:fs')).readFileSync(f, 'utf8').replace('"pending"', '"done"'));
    const before = p.store.readEvents().length;
    const r = await resume({ root: p.dir, store: fresh(p), config: p.config });
    assert.equal(r.ok, false);
    assert.match(r.brief, /完整性校验失败[\s\S]*T-001\.json/);
    const ev = p.store.readEvents();
    assert.equal(ev.length, before + 1);
    assert.equal(ev.at(-1)!.type, 'integrity_error');
    // 仍然不一致，后续写入继续被拒绝
    await assert.rejects(fresh(p).recordEvent({ flow: null, actor: 'x', type: 'note' }), /完整性/);
  } finally { p.cleanup(); }
});

test('引擎租约看守：运行中的 run 租约到期被终止并计一次失败', async () => {
  let clock = Date.now();
  const p = await setupProject({ tasks: [mkTask('T-001')], now: () => new Date(clock) });
  try {
    const { engine } = makeEngine(p, async (_r, nth, a) => { await a.call('flow_claim'); if (nth === 1) await new Promise<void>((res) => { setTimeout(res, 50_000).unref(); }); });
    (engine as unknown as { d: { now: () => Date } }).d.now = () => new Date(clock);
    await engine.next(p.flowId);
    assert.deepEqual(engine.checkLeases(), []);
    clock += 3 * 60 * 60_000;
    assert.equal(engine.checkLeases().length, 1);
  } finally { p.cleanup(); }
});
