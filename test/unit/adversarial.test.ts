import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { hashToken } from '../../src/core/state-machine.ts';
import { enforceToolCall, type GuardContext } from '../../src/core/guard.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEST_YAML.replace(/max_violations_per_run: \d+/, 'max_violations_per_run: 100'));
const strict = parseConfig(TEST_YAML.replace(/max_violations_per_run: \d+/, 'max_violations_per_run: 3'));
const now = () => new Date('2026-01-01T00:00:00Z');

async function setup() {
  const repo = tmpRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const store = await StateStore.init(repo.dir, { now });
  const flow = await store.createFlow({ mode: 'build', title: 'adv', stages: ['S3'], base_sha: 'abc' });
  await store.addTasks(flow.id, [mkTask('T-001', { writes: ['src/server/**'] })], 'architect');
  const wt = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  mkdirSync(path.join(wt, '.flow'), { recursive: true });
  mkdirSync(path.join(wt, 'src/server'), { recursive: true });
  await store.transitionTask(flow.id, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
  await store.transitionTask(flow.id, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
    lease: { run_id: 'r-1', role: 'backend-engineer', token_hash: hashToken('t'), acquired_at: now().toISOString(), expires_at: '2026-01-01T01:00:00Z' },
    worktree: wt, branch: 'flow/B-001/T-001', base_sha: 'abc' } });
  await store.createRun({ run_id: 'r-1', flow: flow.id, task: 'T-001', role: 'backend-engineer', model: null,
    started_at: now().toISOString(), ended_at: null, tokens: { input: null, output: null, cache_read: null, cache_write: null },
    outcome: null, token_hash: hashToken('t'), violations: 0 });
  const cleanup = () => { repo.cleanup(); rmSync(wt, { recursive: true, force: true }); };
  return { ...repo, cleanup, store, flow, wt: realpathSync(wt) };
}

test('对抗：实施 agent 修改 .flow/、改写历史、审批闸门全部失败且留下 violation 事件', async () => {
  const { store, flow, wt, dir, cleanup } = await setup();
  try {
    const ctx: GuardContext = { config, role: 'backend-engineer', cwd: wt, workspaceRoot: wt, mainRoot: dir, writes: ['src/server/**'] };
    const run = { flow: flow.id, task: 'T-001', run: 'r-1' };
    const attempts = [
      { toolName: 'write', input: { path: '.flow/state.json', content: '{}' } },
      { toolName: 'edit', input: { path: '.flow/flows/B-001/tasks/T-001.json', edits: [] } },
      { toolName: 'write', input: { path: path.join(dir, '.flow/state.json'), content: '{}' } },
      { toolName: 'bash', input: { command: `echo '{}' > ${dir}/.flow/state.json` } },
      { toolName: 'bash', input: { command: 'echo x >> .flow/events.jsonl' } },
      { toolName: 'bash', input: { command: "sed -i 's/in_progress/done/' .flow/flows/B-001/tasks/T-001.json" } },
      { toolName: 'bash', input: { command: 'git reset --hard HEAD~1' } },
      { toolName: 'bash', input: { command: 'git rebase -i main' } },
      { toolName: 'serena_replace_symbol_body', input: { relative_path: '.flow/state.json', body: 'x' } },
      { toolName: 'flow_approve', input: { decision: 'pass', notes: '自批准' } },
    ];
    for (const a of attempts) {
      const r = await enforceToolCall(a, ctx, store, run);
      assert.equal(r.allow, false, JSON.stringify(a));
    }
    const violations = store.readEvents().filter((e) => e.type === 'violation');
    assert.equal(violations.length, attempts.length);
    assert.deepEqual(violations.map((e) => e.data?.['count']), attempts.map((_, i) => i + 1));
    assert.equal(store.readRun('r-1').violations, attempts.length);
    assert.equal(store.readTask(flow.id, 'T-001').violations, attempts.length);
    // 阶段闸门无工具可批准；即使绕到存储层，非 human 也被拒
    await store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await store.transitionStage(flow.id, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    await assert.rejects(store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'run:r-1' }), /用户/);
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { cleanup(); }
});

test('对抗：orchestrator 自己写代码被阻断并记录', async () => {
  const { store, flow, dir, cleanup } = await setup();
  try {
    const ctx: GuardContext = { config, role: 'orchestrator', cwd: dir, workspaceRoot: dir, mainRoot: dir, readyTaskId: 'T-002' };
    const r = await enforceToolCall({ toolName: 'write', input: { path: 'src/server/a.ts', content: 'x' } }, ctx, store,
      { flow: flow.id, task: null, run: 'orchestrator' });
    assert.equal(r.allow, false);
    if (!r.allow) assert.match(r.reason, /flow_dispatch\(T-002\)/);
    const ev = store.readEvents().filter((e) => e.type === 'violation');
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.data?.['role'], 'orchestrator');
  } finally { cleanup(); }
});

test('违规达到上限：终止 run，任务转 blocked', async () => {
  const { store, flow, wt, dir, cleanup } = await setup();
  try {
    const ctx: GuardContext = { config: strict, role: 'backend-engineer', cwd: wt, workspaceRoot: wt, mainRoot: dir };
    const run = { flow: flow.id, task: 'T-001', run: 'r-1' };
    const bad = { toolName: 'bash', input: { command: 'rm -rf src' } };
    const r1 = await enforceToolCall(bad, ctx, store, run);
    const r2 = await enforceToolCall(bad, ctx, store, run);
    assert.ok(!r1.allow && !r1.terminate && !r2.allow && !r2.terminate);
    if (!r2.allow) assert.match(r2.reason, /2\/3/);
    const r3 = await enforceToolCall(bad, ctx, store, run);
    assert.ok(!r3.allow && r3.terminate);
    if (!r3.allow) assert.match(r3.reason, /终止/);
    const t = store.readTask(flow.id, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /违规次数达到上限 3/);
    assert.equal(t.lease, null);
    assert.equal(store.readRun('r-1').outcome, 'killed');
    // 放行的调用不产生违规
    const okr = await enforceToolCall({ toolName: 'write', input: { path: 'src/server/a.ts', content: '' } }, ctx, store, run);
    assert.equal(okr.allow, true);
    assert.equal(store.readEvents().filter((e) => e.type === 'violation').length, 3);
  } finally { cleanup(); }
});
