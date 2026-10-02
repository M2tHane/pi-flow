// 第二轮 H、I 验收：按风险审查、审查并发上限；失败后升级模型；流程预算。
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
  .replace(/  test:      ".*"/, '  test:      "true"')
  .replace(/models:[\s\S]*?\nreview:/, 'models:\n  strong: "f/strong"\n  medium: "f/medium"\n  cheap:  "f/cheap"\nreview:');
const SETTINGS = { version: 1 as const, roles: {} };
const env = (p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv => ({
  root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
  engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
  roleSettings: () => SETTINGS, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
});
async function implement(a: FakeAgent, file: string) {
  assert.ok((await a.call('flow_claim')).ok);
  assert.ok((await a.call('write', { path: file, content: 'x\n' })).ok, file);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: file });
  assert.ok(r.ok, r.text);
}

test('按风险审查：文档任务用便宜模型审查，代码任务用强模型；skip 模式下低风险免审查；审查并发受限', async () => {
  const p = await setupProject({ yaml: MODELS(PROJECT_YAML).replace('  max_parallel: 2               # 同时进行的审查数', '  max_parallel: 1               # 同时进行的审查数'), tasks: [
    mkTask('T-001', { kind: 'doc', role: 'architect', scopes: ['docs'], writes: ['docs/guide/**'], verify: [] }),
    mkTask('T-002', { verify: [] }),
    mkTask('T-003', { verify: [], writes: ['src/server/t-003/**'] }),
  ] });
  try {
    let reviewing = 0;
    let maxReviewing = 0;
    const { engine, launcher, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') {
        reviewing++; maxReviewing = Math.max(maxReviewing, reviewing);
        await new Promise((r) => setTimeout(r, 50));
        reviewing--;
        assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok);
        return;
      }
      const t = p.store.readTask(p.flowId, a.env.task);
      return implement(a, t.id === 'T-001' ? 'docs/guide/intro.md' : `src/server/${t.id.toLowerCase()}/a.ts`);
    }, SETTINGS);
    await engine.next(p.flowId);
    await engine.idle();
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);
    const reviews = p.store.listRuns().filter((r) => r.role === 'reviewer');
    const byTask = Object.fromEntries(reviews.map((r) => [r.task, r]));
    assert.equal(byTask['T-001']!.model, 'f/cheap');
    assert.equal(byTask['T-001']!.review_mode, 'light');
    assert.equal(byTask['T-002']!.model, 'f/strong');
    assert.equal(byTask['T-002']!.review_mode, 'full');
    assert.equal(maxReviewing, 1, '审查并发不超过 review.max_parallel');
    assert.equal(launcher.launched.filter((s) => s.env['PI_FLOW_ROLE'] === 'reviewer' && s.env['PI_FLOW_TASK'] === 'T-001')[0]!.model, 'f/cheap');
  } finally { p.cleanup(); }

  const q = await setupProject({ yaml: MODELS(PROJECT_YAML).replace('    mode: cheap ', '    mode: skip  '), tasks: [
    mkTask('T-001', { kind: 'doc', role: 'architect', scopes: ['docs'], writes: ['docs/guide/**'], verify: [] }),
  ] });
  try {
    const { engine } = makeEngine(q, async (role, _n, a) => {
      assert.notEqual(role, 'reviewer', '低风险任务不应派审查');
      return implement(a, 'docs/guide/intro.md');
    }, SETTINGS);
    await engine.next(q.flowId);
    await engine.idle();
    assert.equal(q.store.readTask(q.flowId, 'T-001').status, 'done');
    const skip = q.store.readEvents().find((e) => e.trigger === 'review_skip');
    assert.equal(skip?.actor, 'engine');
    assert.match(skip?.reason ?? '', /免审查/);
    // 只有引擎能免审查
    await assert.rejects(q.store.transitionTask(q.flowId, 'T-001', { to: 'verifying', trigger: 'review_skip', actor: 'run:r-x', facts: { low_risk: true, reason: 'x' } }), /非法转移|只有引擎/);
  } finally { q.cleanup(); }
});

test('失败后升级模型：第 2 次失败后的派发使用升级模型并记录；超预算暂停派发新任务、提示用户，提高预算后继续', async () => {
  const p = await setupProject({ yaml: MODELS(PROJECT_YAML), tasks: [mkTask('T-001', { verify: [] }),
    mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] })] });
  try {
    const { engine, errors } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') {
        if (a.env.task === 'T-001' && nth <= 2) {
          assert.ok((await a.call('flow_approve', { decision: 'reject', issues: [{ location: 'a.ts:1', problem: '不对', expected: '改对' }] })).ok);
        } else assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok);
        return;
      }
      return implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`);
    }, SETTINGS);
    // 预算：只够 T-001 的几次运行
    await p.store.setFlowBudget(p.flowId, { tokens: 1500 });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const impl = p.store.listRuns().filter((r) => r.task === 'T-001' && r.role === 'backend-engineer');
    assert.deepEqual(impl.map((r) => [r.model, !!r.escalated]), [['f/medium', false], ['f/medium', false], ['f/strong', true]]);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');

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
