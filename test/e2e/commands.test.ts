// 命令层：/flow approve、unblock、gate、/flow-build 的参数与交互（无 UI 环境）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runFlowCommand, runFlowBuild, type CommandEnv } from '../../src/commands/flow.ts';
import { renumber } from '../../src/core/stages.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

test('renumber：临时编号映射到流程内新编号，依赖一起改写', () => {
  const r = renumber([
    { id: 'T-001', stage: 'S3', kind: 'test', title: 'a', role: 'test-engineer', scopes: [], depends_on: [], inputs: [], writes: ['x'], acceptance: ['a'], verify: [] },
    { id: 'T-002', stage: 'S3', kind: 'impl', title: 'b', role: 'backend-engineer', scopes: [], depends_on: [{ task: 'T-001', type: 'hard', reason: 'r' }], inputs: [], writes: ['y'], acceptance: ['b'], verify: [] },
  ], 5);
  assert.deepEqual(r.tasks.map((t) => t.id), ['T-005', 'T-006']);
  assert.equal(r.tasks[1]!.depends_on[0]!.task, 'T-005');
});

test('/flow unblock 附回答写入 handoff 并回到 ready；approve 在没有等待批准的闸门时报错；最后阶段无 UI 需 --yes', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const { engine } = makeEngine(p, async (_r, _n, a) => { await a.call('flow_claim'); await a.call('flow_block', { reason: '用 PostgreSQL 还是 SQLite？' }); });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'blocked');
    const e = env(p, engine);
    // 解除阻塞后会被重新派发（脚本仍会 block），这里只验证回答写入与状态转移
    const out = await runFlowCommand('unblock T-001 "用 SQLite" --attempts 1', e);
    assert.match(out, /已解除 T-001 的阻塞.*attempts=1/);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /用户回答：\n用 SQLite/);
    await assert.rejects(runFlowCommand('unblock', e), /用法/);
    await assert.rejects(runFlowCommand('approve', e), /没有等待批准的闸门/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(await runFlowCommand('approve', e), /确认请执行 \/flow approve --yes/);
    await assert.rejects(runFlowCommand('bogus', e), /未知子命令/);
    await engine.idle();
  } finally { p.cleanup(); }
});

test('/flow-build：缺少描述报错；已有进行中的流程时拒绝并提示 /flow resume', async () => {
  const p = await setupProject();
  try {
    const { engine } = makeEngine(p, async () => {});
    await assert.rejects(runFlowBuild('', env(p, engine)), /需要描述/);
    await assert.rejects(runFlowBuild('--feature "导出"', env(p, engine)), /已有进行中的流程 B-001.*\/flow resume/);
  } finally { p.cleanup(); }
});
