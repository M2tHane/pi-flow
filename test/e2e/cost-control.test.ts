// 第二轮 H、I 验收：失败后升级模型；关键底座；流程预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';
import { nextStep } from '../../src/core/context-injector.ts';

const MODELS = (yaml: string) => yaml
  .replace(/  test:      ".*"/, '  test:      "! grep -rqs FAIL src/server"')
  .replace(/models:[\s\S]*?\ntesting:/, 'models:\n  strong: "f/strong"\n  medium: "f/medium"\n  cheap:  "f/cheap"\ntesting:');
const SETTINGS = { version: 1 as const, roles: {} };
const env = (p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv => ({
  root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
  engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
  roleSettings: () => SETTINGS, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
});
async function implement(a: FakeAgent, file: string, content = 'x\n') {
  assert.ok((await a.call('flow_claim')).ok);
  assert.ok((await a.call('write', { path: file, content })).ok, file);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: file });
  assert.ok(r.ok, r.text);
}

test('失败后升级模型：第 2 次失败后的派发使用升级模型并记录；超预算暂停派发新任务、提示用户，提高预算后继续', async () => {
  const p = await setupProject({ yaml: MODELS(PROJECT_YAML), tasks: [mkTask('T-001', { verify: ['test'] }),
    mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] })] });
  try {
    const { engine, errors } = makeEngine(p, async (_role, nth, a) =>
      // T-001 前两次提交的代码让合并时的全量测试失败
      implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`, a.env.task === 'T-001' && nth <= 2 ? 'FAIL\n' : 'x\n'), SETTINGS);
    // 预算：只够 T-001 的几次运行
    await p.store.setFlowBudget(p.flowId, { tokens: 1500 });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const impl = p.store.listRuns().filter((r) => r.task === 'T-001' && r.role === 'backend-engineer');
    assert.deepEqual(impl.map((r) => [r.model, !!r.escalated]), [['f/medium', false], ['f/medium', false], ['f/strong', true]]);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(await runFlowCommand('status --cost', env(p, engine)), /## 按角色[\s\S]*backend-engineer：\d+ 次运行[^\n]*平均 [\d.]+ 轮/);

    // 超预算：不再派发新任务；提示用户；orchestrator 只能报告
    assert.deepEqual(await engine.next(p.flowId), []);
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /已超出：暂停派发新任务/.test(x.text)));
    assert.match(nextStep(p.store, 2, 0, p.config).next, /预算已用完/);
    await assert.rejects(engine.dispatch(p.flowId, 'T-002'), /预算已用完/);
    assert.match(await runFlowCommand('status --cost', env(p, engine)), /预算：token [\d,]+ \/ 1,500，已用 \d+%，已超出/);
    // 提高预算后继续
    assert.match(await runFlowCommand('budget tokens 1000000', env(p, engine)), /已派发：T-002/);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
  } finally { p.cleanup(); }
});

test('关键底座：被至少 3 个任务硬依赖的实施任务第一次就用升级模型；普通任务照常；可关闭', async () => {
  const deps = ['T-002', 'T-003', 'T-004'].map((id) => mkTask(id, { verify: [], writes: [`src/server/${id.toLowerCase()}/**`], deps: [{ task: 'T-001', type: 'hard', reason: '需要底座' }] }));
  for (const [yaml, expected] of [[MODELS(PROJECT_YAML), 'f/strong'], [MODELS(PROJECT_YAML).replace('critical_fanout: 3 ', 'critical_fanout: 0 '), 'f/medium']] as const) {
    const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: [] }), ...deps] });
    try {
      const { engine, launcher } = makeEngine(p, async (_role, _n, a) => implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`), SETTINGS);
      await engine.next(p.flowId);
      await engine.idle();
      const first = launcher.launched.find((s) => s.env['PI_FLOW_TASK'] === 'T-001' && s.env['PI_FLOW_ROLE'] === 'backend-engineer')!;
      assert.equal(first.model, expected);
      assert.equal(!!p.store.listRuns().find((r) => r.task === 'T-001' && r.role === 'backend-engineer')!.escalated, expected === 'f/strong');
      await engine.next(p.flowId);
      await engine.idle();
      assert.equal(launcher.launched.find((s) => s.env['PI_FLOW_TASK'] === 'T-002' && s.env['PI_FLOW_ROLE'] === 'backend-engineer')!.model, 'f/medium', '普通任务照常');
    } finally { p.cleanup(); }
  }
});
