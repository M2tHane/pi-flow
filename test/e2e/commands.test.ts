// 命令层：/flow approve、unblock、gate、/flow-build 的参数与交互（无 UI 环境）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runFlowCommand, runFlowBuild, type CommandEnv } from '../../src/commands/flow.ts';
import { renumber } from '../../src/core/stages.ts';
import { setupProject, DIRECT_YAML, type Project } from '../helpers/project.ts';
import { StateStore } from '../../src/core/state-store.ts';
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
    { id: 'T-001', stage: 'S3', kind: 'impl', title: 'a', role: 'test-engineer', scopes: [], depends_on: [], inputs: [], writes: ['x'], acceptance: ['a'], verify: [] },
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
    assert.match(await runFlowCommand('approve', e), /确认请执行 \/flow-approve --yes/);
    await assert.rejects(runFlowCommand('bogus', e), /未知子命令/);
    await engine.idle();
  } finally { p.cleanup(); }
});

test('/flow-build：--direct 缺少描述报错；已有进行中的流程时拒绝并提示 /flow resume', async () => {
  const p = await setupProject();
  try {
    const { engine } = makeEngine(p, async () => {});
    await assert.rejects(runFlowBuild('--feature "导出"', env(p, engine)), /已有进行中的流程 B-001.*\/flow-resume/);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    await assert.rejects(runFlowBuild('--direct', env(p, engine)), /请写下你的想法/);
  } finally { p.cleanup(); }
});

test('/flow knowledge：列出、确认改写、废弃、提升；/flow rules 在没有流程时也读取主分支上的草案并应用', async () => {
  const p = await setupProject();
  try {
    const { engine } = makeEngine(p, async () => {});
    const e = env(p, engine);
    assert.match(await runFlowCommand('knowledge', e), /知识库还是空的/);
    const { learn } = await import('../../src/core/knowledge.ts');
    const src = { kind: 'review' as const, flow: p.flowId, task: 'T-001', run: null, role: null };
    await learn(p.store, p.config, { category: 'convention', content: '审查打回：缺少参数校验', scopes: ['backend'], source: src, status: 'candidate' }, 'engine');
    await learn(p.store, p.config, { category: 'pitfall', content: '本地测试需要先启动 redis', source: { ...src, kind: 'agent' }, status: 'active' }, 'engine');
    assert.match(await runFlowCommand('knowledge', e), /2 条，其中 1 条候选待确认[\s\S]*K-001 \[约定\]（backend） 审查打回：缺少参数校验　候选/);
    assert.match(await runFlowCommand('knowledge redis', e), /K-002[\s\S]*/);
    assert.match(await runFlowCommand('knowledge accept K-001 "handler 入参一律用 zod 校验"', e), /已确认 K-001[\s\S]*handler 入参一律用 zod 校验/);
    assert.match(await runFlowCommand('knowledge accept K-001', e), /不是候选/);
    assert.match(await runFlowCommand('knowledge promote K-001', e), /docs\/rules-draft\/backend\.md[\s\S]*\/flow rules apply backend\.md/);
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    assert.match(await runFlowCommand('rules', e), /（主分支）[\s\S]*docs\/rules-draft\/backend\.md → rules\/backend\.md/);
    assert.match(await runFlowCommand('rules apply backend.md', e), /已应用：rules\/backend\.md[\s\S]*知识 K-001 已成为规则/);
    assert.match(await runFlowCommand('knowledge retire K-002 "已改用内存实现"', e), /已废弃 K-002/);
    assert.doesNotMatch(await runFlowCommand('knowledge', e), /K-00/);
    assert.match(await runFlowCommand('knowledge --all', e), /K-001[\s\S]*已成为规则[\s\S]*K-002[\s\S]*已废弃/);
  } finally { p.cleanup(); }
});

test('/flow next 先推进程序步骤：引擎重启前已提交、排队合并的任务（不逐任务审查）由新引擎合入', async () => {
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001')] });
  try {
    // 旧引擎：提交后子进程挂住不退出（随后引擎被杀），任务停在合并队列里
    const old = makeEngine(p, async (_r, _n, a) => {
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('flow_note', { text: '完成' });
      await a.call('flow_submit', { summary: 's' });
      await new Promise(() => {});
    });
    await old.engine.next(p.flowId);
    const end = Date.now() + 30_000;
    while (p.store.readTask(p.flowId, 'T-001').status !== 'queued_merge') { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
    const store = new StateStore(p.dir, { limits: p.config.limits });
    const fresh = makeEngine({ ...p, store }, async () => { throw new Error('不应再派发'); });
    await runFlowCommand('next', env({ ...p, store }, fresh.engine));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual(fresh.errors, []);
  } finally { p.cleanup(); }
});
