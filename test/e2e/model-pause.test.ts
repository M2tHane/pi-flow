// 第三轮 A 验收：模型额度用完、限流时暂停这个模型，而不是判任务失败；只影响这个模型；恢复后继续。
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
import { DispatchError, type Engine } from '../../src/core/dispatcher.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
const SETTINGS: RoleSettingsFile = { version: 1, roles: {
  'backend-engineer': { model: 'f/glm' }, architect: { model: 'f/arch' } } };
const QUOTA = 'Codex error: You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.';

const env = (p: Project, engine: Engine): CommandEnv => ({
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

test('额度用完：任务不计失败、不转阻塞；这个模型不再派发，其他模型照常；/flow models resume 后继续并完成', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [
    mkTask('T-001', { verify: [] }),
    mkTask('T-002', { kind: 'doc', role: 'architect', scopes: ['docs'], writes: ['docs/guide/**'], verify: [] }),
  ] });
  try {
    let quotaLeft = true;
    const { engine, launcher, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'architect') return implement(a, 'docs/guide/intro.md');
      if (quotaLeft) throw new Error(QUOTA);
      return implement(a, 'src/server/t-001/a.ts');
    }, SETTINGS);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);

    const t1 = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t1.status, 'in_progress');
    assert.equal(t1.attempts, 0, '额度问题不计失败');
    assert.equal(t1.interruptions ?? 0, 0, '也不计中断');
    assert.equal(t1.lease, null);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done', '其他模型的角色照常工作');
    assert.equal(launcher.launched.filter((s) => s.model === 'f/glm').length, 1, '暂停的模型不再被派发');
    assert.equal(p.store.listRuns().find((r) => r.model === 'f/glm')!.outcome, 'unavailable');

    const pause = p.store.readModelPauses().pauses[0]!;
    assert.equal(pause.model, 'f/glm');
    assert.equal(pause.kind, 'quota');
    assert.ok(pause.retry_after && Date.parse(pause.retry_after) - Date.now() > 110 * 60_000, '从错误信息读出约 120 分钟后恢复');
    assert.deepEqual(pause.roles, ['backend-engineer']);
    assert.deepEqual(pause.tasks, [`${p.flowId}/T-001`]);

    const action = actionsNeeded(p.store, p.config).find((x) => x.key.startsWith('model-pause:'));
    assert.match(action?.text ?? '', /f\/glm 额度用完.*T-001/);
    assert.match(action?.command ?? '', /\/flow models resume f\/glm/);
    const step = nextStep(p.store, 2, 0, p.config, (f, t) => engine.pausedFor(f, t));
    assert.equal(step.tool, 'none');
    assert.match(step.next, /f\/glm 暂停中.*T-001/);
    await assert.rejects(engine.dispatch(p.flowId, 'T-001'), (e) => e instanceof DispatchError && /暂停派发/.test(e.message));
    await engine.pump(p.flowId);
    await engine.idle();
    assert.equal(launcher.launched.filter((s) => s.model === 'f/glm').length, 1, 'pump 也不派发');
    assert.match(await runFlowCommand('models', env(p, engine)), /f\/glm 额度用完/);

    quotaLeft = false;
    assert.match(await runFlowCommand('models resume glm', env(p, engine)), /已恢复 f\/glm/);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').attempts, 0);
    assert.deepEqual(p.store.readModelPauses().pauses, []);
    assert.equal(await runFlowCommand('models', env(p, engine)), '没有被暂停的模型。');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('限流：模型暂停 5 分钟后自动恢复；恢复后又限流则退避加倍；成功后清除记录', async () => {
  // 子进程工具层用真实时钟校验租约：起点取当前时间，之后只往后拨
  const t0 = Date.now();
  const at = (min: number) => new Date(t0 + min * 60_000);
  let clock = at(0);
  const now = () => clock;
  const p = await setupProject({ yaml: YAML, now, tasks: [mkTask('T-001', { verify: [] })] });
  try {
    let limited = 2;
    const { engine, errors } = makeEngine(p, async (_role, _n, a) => {
      if (limited-- > 0) throw new Error('429 Too Many Requests: Rate limit reached for requests');
      return implement(a, 'src/server/t-001/a.ts');
    }, SETTINGS, undefined, { now });
    await engine.next(p.flowId);
    await engine.idle();
    let t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress', `${t.blocked_reason} ${JSON.stringify(errors)}`);
    assert.equal(t.lease, null);
    assert.equal(t.attempts, 0);
    let pause = p.store.readModelPauses().pauses[0]!;
    assert.equal(pause.kind, 'unavailable');
    assert.equal(pause.strikes, 1);
    assert.equal(pause.retry_after, at(5).toISOString());

    assert.deepEqual(engine.checkPauses(), [], '未到恢复时间');
    clock = at(6);
    assert.deepEqual(engine.checkPauses(), ['f/glm']);
    await engine.idle();
    pause = p.store.readModelPauses().pauses[0]!;
    assert.equal(pause.strikes, 2, '恢复后又限流');
    assert.equal(pause.retry_after, at(16).toISOString(), '退避加倍到 10 分钟');
    assert.equal(p.store.readTask(p.flowId, 'T-001').attempts, 0);

    clock = at(17);
    assert.deepEqual(engine.checkPauses(), ['f/glm']);
    await engine.idle();
    assert.deepEqual(errors, []);
    t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.deepEqual(p.store.readModelPauses().pauses, [], '成功响应后清除记录');
  } finally { p.cleanup(); }
});
