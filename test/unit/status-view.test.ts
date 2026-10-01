import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../../src/core/config.ts';
import { phaseOfStage, renderStatus, taskActivity, notices, snapshotOf, actionsNeeded } from '../../src/core/status-view.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { setupProject } from '../helpers/project.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

test('phase：模板显式配置；缺省按阶段 id 推断；顺序倒退报错', () => {
  const c = parseConfig(TEST_YAML);
  assert.equal(phaseOfStage(c, 'build', 'S0'), 'discovery');
  assert.equal(phaseOfStage(c, 'build', 'S2'), 'execution');
  assert.equal(phaseOfStage(c, 'build', 'S5'), 'acceptance');
  assert.equal(phaseOfStage(c, 'feature', 'F1'), 'planning');
  const noPhase = parseConfig(TEST_YAML.replace(/phase: \w+,\s*/g, ''));
  assert.equal(phaseOfStage(noPhase, 'build', 'S3'), 'execution');
  assert.equal(phaseOfStage(noPhase, 'feature', 'S4'), 'acceptance');
  assert.throws(() => parseConfig(TEST_YAML.replace('id: S2, name: infrastructure, phase: execution', 'id: S2, name: infrastructure, phase: discovery')),
    (e: unknown) => e instanceof ConfigError && /phase discovery 不能排在 planning 之后/.test(e.message));
});

test('任务活动用人话表示，重试带上次失败原因', () => {
  const lease = { run_id: 'r', role: 'backend-engineer', token_hash: 'a'.repeat(64), acquired_at: 'x', expires_at: 'y' };
  assert.equal(taskActivity(mkTask('T-1', { status: 'in_progress', lease }), null), '实现中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'in_progress', attempts: 1 }), '审查打回'), '等待重新派发（第 2 次，上次：审查打回）');
  assert.equal(taskActivity(mkTask('T-1', { status: 'review' }), null), '审查中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'queued_merge' }), null), '合入中');
  assert.equal(taskActivity(mkTask('T-1', { status: 'merging' }), null), '合入中');
});

test('/flow status 精简视图：阶段条、进度、正在进行、需要你处理放在最上面', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { title: '用户服务' }), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003')] });
  try {
    let out = renderStatus(p.store, p.config);
    assert.match(out, /^需要你处理：无/);
    assert.match(out, /\[实施\] → 完成/);
    assert.match(out, /实施阶段：按任务拆解实现/);
    assert.match(out, /进度：0 \/ 3 个任务完成/);
    assert.doesNotMatch(out, /pending|in_progress|queued_merge|S3/, '不暴露内部状态名');

    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r-1', role: 'backend-engineer', token_hash: hashToken('t'), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    out = renderStatus(p.store, p.config);
    assert.match(out, /正在进行：\n- T-001 用户服务（backend-engineer）实现中/);

    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'run:r-1', facts: { reason: '用 PostgreSQL 还是 SQLite？' } });
    out = renderStatus(p.store, p.config);
    assert.match(out, /^需要你处理：\n- T-001「用户服务」阻塞：用 PostgreSQL 还是 SQLite？\n  → \/flow answer T-001/);
    assert.match(out, /阻塞：T-001/);

    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.ok(actionsNeeded(p.store, p.config).some((a) => /等待你审批（批准后合入主分支）/.test(a.text) && a.command === '/flow approve'));
  } finally { p.cleanup(); }
});

test('主动通知：只在进入新阶段、出现需要处理的事、首次失败重试时出现', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002')] });
  try {
    const s0 = snapshotOf(p.store, p.config);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    assert.deepEqual(notices(s0, snapshotOf(p.store, p.config)), [], '普通的任务推进不通知');
    const s1 = snapshotOf(p.store, p.config);
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r-1', role: 'backend-engineer', token_hash: hashToken('t'), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'run_failed', actor: 'd', facts: { reason: '崩溃' } });
    const s2 = snapshotOf(p.store, p.config);
    assert.deepEqual(notices(s1, s2, () => '运行中断'), ['pi-flow：T-001 第一次未通过（运行中断），程序已自动重试。']);
    await p.store.transitionTask(p.flowId, 'T-002', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    const n = notices(s2, snapshotOf(p.store, p.config));
    assert.equal(n.length, 1);
    assert.match(n[0]!, /需要你处理：实施阶段的产出等待你审批/);
    await p.store.transitionStage(p.flowId, { to: 'done', trigger: 'approve', actor: 'human' });
    const s3 = snapshotOf(p.store, p.config);
    await p.store.advanceStage(p.flowId, 'human');
    assert.deepEqual(notices(s3, snapshotOf(p.store, p.config)), ['pi-flow：B-001 已结束。'], '流程结束时提醒一次');
  } finally { p.cleanup(); }
});
