import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransition, TRANSITIONS, hashToken, type Facts, type Trigger } from '../../src/core/state-machine.ts';
import { TASK_STATUSES, type TaskFile, type TaskStatus } from '../../src/core/schemas.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const TOKEN = 'tok-impl';
const lease = (run: string, token: string, min = 30) => ({
  run_id: run, role: 'backend-engineer', token_hash: hashToken(token), acquired_at: NOW.toISOString(), expires_at: later(min),
});
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: NOW, limits: { max_attempts: 3, max_parallel: 2 }, actor: 'engine', stage_active: true,
  status_of: new Map(), running_count: 0, conflicting_running: [], merging_other: null, queue_head: true,
  handoff_written: true, ...over,
});
const inProgress = (over: Partial<TaskFile> = {}) => mkTask('T-001', {
  status: 'in_progress', lease: lease('r-1', TOKEN), worktree: '/wt/T-001', branch: 'flow/B-001/T-001', base_sha: 'abc', ...over,
});
const ok = (r: ReturnType<typeof planTransition>) => { assert.ok(r.ok, r.ok ? '' : r.errors.join('\n')); return r; };
const bad = (r: ReturnType<typeof planTransition>, re: RegExp) => {
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join('\n'), re);
};

test('不在转移表中的转移全部被拒', () => {
  const triggers = [...new Set(TRANSITIONS.map((t) => t.trigger))] as Trigger[];
  let rejected = 0;
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      for (const trig of triggers) {
        if (TRANSITIONS.some((t) => t.from.includes(from) && t.to === to && t.trigger === trig)) continue;
        const r = planTransition(mkTask('T-001', { status: from }), to as TaskStatus, trig, facts());
        assert.equal(r.ok, false, `${from} -> ${to} via ${trig} 应被拒`);
        rejected++;
      }
    }
  }
  assert.ok(rejected > 300);
});

test('pending -> ready：硬依赖 done 且 stage active', () => {
  const t = mkTask('T-002', { deps: [hard('T-001')] });
  bad(planTransition(t, 'ready', 'schedule', facts({ status_of: new Map([['T-001', 'accepting']]) })), /T-001/);
  bad(planTransition(t, 'ready', 'schedule', facts({ status_of: new Map([['T-001', 'done']]), stage_active: false })), /stage/);
  ok(planTransition(t, 'ready', 'schedule', facts({ status_of: new Map([['T-001', 'done']]) })));
});

test('ready -> in_progress：并发、互斥、worktree、租约', () => {
  const t = mkTask('T-001', { status: 'ready' });
  const patch = { lease: lease('r-1', TOKEN), worktree: '/wt', branch: 'b', base_sha: 'abc' };
  bad(planTransition(t, 'in_progress', 'dispatch', facts({ running_count: 2 }), patch), /并发/);
  bad(planTransition(t, 'in_progress', 'dispatch', facts({ conflicting_running: ['T-009'] }), patch), /T-009/);
  bad(planTransition(t, 'in_progress', 'dispatch', facts(), { ...patch, base_sha: null }), /base_sha/);
  bad(planTransition(t, 'in_progress', 'dispatch', facts(), { ...patch, lease: null }), /租约/);
  const r = ok(planTransition(t, 'in_progress', 'dispatch', facts(), patch));
  assert.equal(r.task.status, 'in_progress');
  assert.equal(r.task.worktree, '/wt');
});

test('in_progress -> queued_merge（submit）：token、租约、diff、受保护路径、handoff；提交后直接进入合并队列', () => {
  const t = inProgress();
  const good = facts({ token: TOKEN, diff_files: ['src/server/t-001/a.ts'] });
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, token: undefined }), /token/);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, token: 'forged' }), /token/);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, now: new Date(later(31)) }), /租约/);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, diff_files: ['src/web/x.ts'] }), /src\/web\/x\.ts/);
  bad(planTransition(inProgress({ writes: ['**'] }), 'queued_merge', 'submit', { ...good, diff_files: ['.flow/state.json'] }), /受保护/);
  bad(planTransition(inProgress({ writes: ['**'] }), 'queued_merge', 'submit', { ...good, diff_files: ['rules/project.md'] }), /受保护/);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, handoff_written: false }), /handoff/);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, diff_files: [] }), /没有改动/);
  const r = ok(planTransition(t, 'queued_merge', 'submit', good));
  assert.equal(r.task.status, 'queued_merge');
  assert.equal(r.task.lease, null);
  assert.equal(r.task.impl_run, 'r-1');
});

test('登记的公共文件算在可写范围内；实现类任务可以在接口文档里追加，改动已有内容被拒', () => {
  const t = inProgress({ shared: ['src/routes.ts'] });
  const good = facts({ token: TOKEN, diff_files: ['src/server/t-001/a.ts', 'src/routes.ts', 'docs/interfaces/kb.md'] });
  ok(planTransition(t, 'queued_merge', 'submit', good));
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, interface_rewrites: ['docs/interfaces/kb.md'] }), /只能在接口文档中追加/);
  bad(planTransition(inProgress({ kind: 'doc' }), 'queued_merge', 'submit', good), /越出/);
});

test('适配已有测试：flow_submit 算出的 test_adjustments 不算越出 writes，记在任务上；不在其中的仍被拒', () => {
  const t = inProgress();
  const good = facts({ token: TOKEN, diff_files: ['src/server/t-001/a.ts', 'tests/acceptance/api.test.js'] });
  bad(planTransition(t, 'queued_merge', 'submit', good), /越出任务 writes：tests\/acceptance\/api\.test\.js/);
  const r = ok(planTransition(t, 'queued_merge', 'submit', { ...good, test_adjustments: ['tests/acceptance/api.test.js'] }));
  assert.deepEqual(r.task.test_adjustments, ['tests/acceptance/api.test.js']);
  bad(planTransition(t, 'queued_merge', 'submit', { ...good, diff_files: [...good.diff_files!, 'tests/acceptance/b.test.js'], test_adjustments: ['tests/acceptance/api.test.js'] }), /tests\/acceptance\/b\.test\.js/);
  const again = ok(planTransition({ ...inProgress(), test_adjustments: ['old.test.js'] }, 'queued_merge', 'submit', facts({ token: TOKEN, diff_files: ['src/server/t-001/a.ts'] })));
  assert.equal(again.task.test_adjustments, undefined, '重新提交时按本次的改动重算');
});

test('只读任务（需求讨论、验收、计划修订）提交结论：不能有改动，要有 handoff', () => {
  const a = inProgress({ kind: 'analysis', advocate: 'user', writes: [] });
  ok(planTransition(a, 'done', 'report', facts({ token: TOKEN, diff_files: [] })));
  bad(planTransition(a, 'done', 'report', facts({ token: TOKEN, diff_files: ['x.ts'] })), /只读任务不得有改动/);
  bad(planTransition(a, 'done', 'report', facts({ token: TOKEN, handoff_written: false })), /handoff/);
  bad(planTransition(inProgress({ kind: 'analysis', writes: [] }), 'done', 'report', facts({ token: TOKEN })), /缺少结构化结论/);
  bad(planTransition(inProgress(), 'done', 'report', facts({ token: TOKEN })), /analysis/);
});

test('失败达上限自动转 blocked', () => {
  const t = mkTask('T-001', { status: 'merging', attempts: 2 });
  const r = ok(planTransition(t, 'in_progress', 'merge_verify_fail', facts({ post_verify_ok: false, reason: 'test 退出码 1' })));
  assert.equal(r.to, 'blocked');
  assert.equal(r.task.status, 'blocked');
  assert.match(r.task.blocked_reason ?? '', /上限/);
});

test('合并：同一时间只有一个 merging；done 需要 rebase、验证、快进', () => {
  const q = mkTask('T-001', { status: 'queued_merge' });
  bad(planTransition(q, 'merging', 'merge_start', facts({ merging_other: 'T-002' })), /T-002/);
  ok(planTransition(q, 'merging', 'merge_start', facts()));
  const m = mkTask('T-001', { status: 'merging', worktree: '/wt' });
  bad(planTransition(m, 'done', 'merge_done', facts({ rebase_ok: true, post_verify_ok: true })), /快进/);
  const d = ok(planTransition(m, 'done', 'merge_done', facts({ rebase_ok: true, post_verify_ok: true, fast_forwarded: true })));
  assert.equal(d.task.worktree, null);
  const back = ok(planTransition(m, 'in_progress', 'merge_verify_fail', facts({ post_verify_ok: false, reason: '语义冲突' })));
  assert.equal(back.task.attempts, 1);
  bad(planTransition(m, 'blocked', 'merge_blocked', facts()), /原因/);
  ok(planTransition(m, 'blocked', 'merge_blocked', facts({ reason: '冲突涉及契约' })));
  ok(planTransition(m, 'queued_merge', 'merge_requeue', facts()));
});

test('任一进行中状态可转 blocked，需写明原因', () => {
  for (const s of ['in_progress', 'queued_merge', 'merging'] as const) {
    bad(planTransition(mkTask('T-001', { status: s }), 'blocked', 'block', facts()), /原因/);
    const r = ok(planTransition(mkTask('T-001', { status: s, lease: lease('r-1', TOKEN) }), 'blocked', 'block', facts({ reason: '需求歧义' })));
    assert.equal(r.task.blocked_reason, '需求歧义');
    assert.equal(r.task.lease, null);
  }
  bad(planTransition(mkTask('T-001', { status: 'done' }), 'blocked', 'block', facts({ reason: 'x' })), /非法/);
});

test('blocked -> ready 只能由用户执行', () => {
  const t = mkTask('T-001', { status: 'blocked', attempts: 3, blocked_reason: 'x' });
  bad(planTransition(t, 'ready', 'unblock', facts({ actor: 'run:r-1' })), /用户/);
  const r = ok(planTransition(t, 'ready', 'unblock', facts({ actor: 'human' })));
  assert.equal(r.task.attempts, 0);
  assert.equal(r.task.blocked_reason, null);
  const r2 = ok(planTransition(t, 'ready', 'unblock', facts({ actor: 'human', attempts: 1 })));
  assert.equal(r2.task.attempts, 1);
});

test('in_progress -> ready：租约过期且 worktree 干净；第二次过期转 blocked', () => {
  const expired = { now: new Date(later(31)) };
  const t = inProgress();
  bad(planTransition(t, 'ready', 'lease_expired', facts({ worktree_clean: true })), /未过期/);
  bad(planTransition(t, 'ready', 'lease_expired', facts({ ...expired, worktree_clean: false })), /未提交/);
  const r = ok(planTransition(t, 'ready', 'lease_expired', facts({ ...expired, worktree_clean: true })));
  assert.equal(r.task.attempts, 1);
  assert.equal(r.task.lease_expirations, 1);
  assert.equal(r.task.worktree, null);
  const r2 = ok(planTransition(inProgress({ lease_expirations: 1 }), 'ready', 'lease_expired', facts({ ...expired, worktree_clean: true })));
  assert.equal(r2.to, 'blocked');
});

test('planTransition 不修改入参', () => {
  const t = mkTask('T-001', { status: 'merging' });
  const snapshot = JSON.stringify(t);
  planTransition(t, 'in_progress', 'merge_verify_fail', facts({ post_verify_ok: false, reason: 'x' }));
  assert.equal(JSON.stringify(t), snapshot);
});

import { planStageTransition } from '../../src/core/state-machine.ts';

test('阶段闸门：agent 无法批准，用户可以', () => {
  assert.match(planStageTransition('awaiting_human', 'done', 'approve', { actor: 'run:r-1' }).join(), /用户/);
  assert.match(planStageTransition('awaiting_human', 'done', 'approve', { actor: 'engine' }).join(), /用户/);
  assert.deepEqual(planStageTransition('awaiting_human', 'done', 'approve', { actor: 'human' }), []);
  assert.match(planStageTransition('active', 'done', 'approve', { actor: 'human' }).join(), /非法/);
  assert.match(planStageTransition('awaiting_gate', 'done', 'gate_passed', { actor: 'engine', needs_human: true }).join(), /人工/);
  assert.deepEqual(planStageTransition('awaiting_gate', 'awaiting_human', 'gate_passed', { actor: 'engine', needs_human: true }), []);
  assert.match(planStageTransition('awaiting_gate', 'active', 'gate_failed', { actor: 'engine' }).join(), /原因/);
});

test('run_failed：子进程未提交就退出，计一次失败并清空租约；达上限转 blocked', () => {
  const t = inProgress();
  bad(planTransition(t, 'in_progress', 'run_failed', facts()), /原因/);
  const r = ok(planTransition(t, 'in_progress', 'run_failed', facts({ reason: '子进程退出码 1' })));
  assert.equal(r.task.attempts, 1);
  assert.equal(r.task.lease, null);
  assert.equal(r.task.worktree, '/wt/T-001');
  bad(planTransition(r.task, 'in_progress', 'run_failed', facts({ reason: 'x' })), /没有运行中/);
  const r2 = ok(planTransition(inProgress({ attempts: 2 }), 'in_progress', 'run_failed', facts({ reason: '又崩溃' })));
  assert.equal(r2.to, 'blocked');
});

test('run_interrupted：会话中断不消耗失败预算，保留 worktree；连续中断达上限转 blocked', async () => {
  const { MAX_INTERRUPTIONS } = await import('../../src/core/state-machine.ts');
  const r = ok(planTransition(inProgress({ attempts: 2 }), 'in_progress', 'run_interrupted', facts({ reason: '会话中断' })));
  assert.equal(r.task.attempts, 2, '不计入失败次数');
  assert.equal(r.task.interruptions, 1);
  assert.equal(r.task.lease, null);
  assert.equal(r.task.worktree, '/wt/T-001');
  bad(planTransition(r.task, 'in_progress', 'run_interrupted', facts({ reason: 'x' })), /没有运行中/);
  const many = ok(planTransition(inProgress({ interruptions: MAX_INTERRUPTIONS - 1 }), 'in_progress', 'run_interrupted', facts({ reason: '又中断' })));
  assert.equal(many.to, 'blocked');
  assert.match(many.task.blocked_reason ?? '', /连续中断 5 次/);
});

test('run_paused：模型服务不可用不计失败、不计中断，保留 worktree；不会因次数转 blocked', () => {
  const r = ok(planTransition(inProgress({ attempts: 2, interruptions: 4 }), 'in_progress', 'run_paused', facts({ reason: '额度用完' })));
  assert.equal(r.to, 'in_progress');
  assert.equal(r.task.attempts, 2);
  assert.equal(r.task.interruptions, 4);
  assert.equal(r.task.lease, null);
  assert.equal(r.task.worktree, '/wt/T-001');
  assert.equal(r.task.last_failure, null, '不覆盖上次失败原因');
  bad(planTransition(r.task, 'in_progress', 'run_paused', facts({ reason: 'x' })), /没有运行中/);
  bad(planTransition(inProgress(), 'in_progress', 'run_paused', facts()), /原因/);
});
