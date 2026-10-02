// 第二轮 G 验收：执行中修订计划。主 agent 转达用户要求 → architect 起草 → 用户批准后程序增删任务；进行中的任务不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, ALL_FAKE } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { flowReplan } from '../../src/tools/orchestrator-tools.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';
import { nextStep } from '../../src/core/context-injector.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
const until = async (cond: () => boolean, ms = 60_000, tick?: () => Promise<unknown>) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时');
    await tick?.().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
  }
};
const env = (p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv => ({
  root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
  engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
  roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: false,
});
async function implement(a: FakeAgent, file: string) {
  assert.ok((await a.call('flow_claim')).ok);
  assert.ok((await a.call('write', { path: file, content: 'x\n' })).ok, file);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: file });
  assert.ok(r.ok, r.text);
}

test('执行中修订计划：经主 agent 发起，architect 起草，校验拒绝改动已开始的任务；用户批准后新增、调整依赖、取消；进行中的任务不受影响；打回后重做', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [
    mkTask('T-001', { verify: [] }),
    mkTask('T-002', { verify: [], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] }),
    mkTask('T-003', { verify: [], deps: [{ task: 'T-001', type: 'hard', reason: '需要 T-001' }] }),
  ] });
  try {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const architectSaw: string[] = [];
    const { engine, launcher, errors } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') { assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok); return; }
      if (role === 'architect') {
        const t = p.store.readTask(p.flowId, a.env.task);
        architectSaw.push(t.replan!);
        assert.ok((await a.call('flow_claim')).ok);
        // 不能写文件
        assert.ok(!(await a.call('write', { path: 'docs/x.md', content: 'x' })).ok);
        if (t.id !== 'T-004') {
          const excel = [{ id: 'N-001', stage: 'S3', kind: 'impl', title: t.replan!.includes('意见') ? '导出 Excel' : '导出 PDF', role: 'backend-engineer', scopes: ['backend'], depends_on: [],
            inputs: [], writes: [t.replan!.includes('意见') ? 'src/server/excel/**' : 'src/server/pdf/**'], acceptance: ['可导出'], verify: [] }];
          assert.ok((await a.call('flow_revise_plan', { summary: '再加导出格式', add: excel })).ok);
          await a.call('flow_note', { text: '按用户要求' });
          assert.ok((await a.call('flow_submit', { summary: '修订完成' })).ok);
          return;
        }
        // 已开始的任务不能取消
        const bad = await a.call('flow_revise_plan', { summary: '错误示例', cancel: [{ task: 'T-001', reason: '不要了' }] });
        assert.ok(!bad.ok && /T-001 当前是 in_progress/.test(bad.text), bad.text);
        // 取消的任务还被依赖
        const dangling = await a.call('flow_revise_plan', { summary: '错误示例', cancel: [{ task: 'T-003', reason: '合并进新任务' }],
          add: [{ id: 'N-001', stage: 'S3', kind: 'impl', title: '导出 CSV', role: 'backend-engineer', scopes: ['backend'], depends_on: [{ task: 'T-003', type: 'hard', reason: 'x' }],
            inputs: [], writes: ['src/server/export/**'], acceptance: ['可导出'], verify: [] }] });
        assert.ok(!dangling.ok && /依赖被取消的 T-003/.test(dangling.text), dangling.text);
        const add = [{ id: 'N-001', stage: 'S3', kind: 'impl', title: '导出 CSV', role: 'backend-engineer', scopes: ['backend'], depends_on: [{ task: 'T-001', type: 'hard', reason: '需要模型' }],
            inputs: [], writes: ['src/server/export/**'], acceptance: ['可导出'], verify: [] }];
        const ok = await a.call('flow_revise_plan', { summary: '补上导出', add, cancel: [{ task: 'T-003', reason: '与导出重复' }], rewire: [{ task: 'T-002', depends_on: [] }] });
        assert.ok(ok.ok, ok.text);
        await a.call('flow_note', { text: '导出是遗漏的需求；T-003 与之重复' });
        const s = await a.call('flow_submit', { summary: '修订完成' });
        assert.ok(s.ok, s.text);
        return;
      }
      if (a.env.task === 'T-001') await hold;
      const w = p.store.readTask(p.flowId, a.env.task).writes[0]!;
      return implement(a, w.endsWith('/**') ? `${w.slice(0, -3)}/a.ts` : w);
    }, ALL_FAKE);
    await engine.next(p.flowId);
    await until(() => p.store.readTask(p.flowId, 'T-001').status === 'in_progress');
    const lease = p.store.readTask(p.flowId, 'T-001').lease!.run_id;

    // 1. 主 agent 转达用户的要求
    const r = await flowReplan(p.dir, p.store, p.config, engine, { reason: '漏了导出 CSV 的功能' });
    assert.match(r.text, /已生成修订任务 T-004 并派给 architect/);
    await until(() => p.store.readRevision(p.flowId)?.status === 'proposed');
    const replanTask = p.store.readTask(p.flowId, 'T-004');
    assert.equal(replanTask.kind, 'analysis');
    const spec = launcher.launched.find((s) => s.env['PI_FLOW_TASK'] === 'T-004')!;
    assert.match(spec.prompt, /用户提出的修订：\n漏了导出 CSV 的功能[\s\S]*T-001 \[S3\/impl\/in_progress\]/);
    await until(() => p.store.readTask(p.flowId, 'T-004').status === 'done');

    // 2. 待批准：提示用户，主 agent 只能等待
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /计划修订等待你批准/.test(x.text)));
    assert.match(nextStep(p.store, 2).next, /计划修订等待用户批准/);
    // agent 不能取消任务
    await assert.rejects(p.store.transitionTask(p.flowId, 'T-003', { to: 'cancelled', trigger: 'cancel', actor: 'run:r-x', facts: { reason: 'x' } }), /只有用户/);

    // 3. 用户批准
    const out = await runFlowCommand('approve', env(p, engine));
    assert.match(out, /已批准计划修订[\s\S]*新增任务编号：N-001→T-005/);
    const tasks = () => Object.fromEntries(p.store.listTasks(p.flowId).map((t) => [t.id, t]));
    assert.equal(tasks()['T-003']!.status, 'cancelled');
    assert.deepEqual(tasks()['T-002']!.depends_on, []);
    assert.equal(tasks()['T-005']!.title, '导出 CSV');
    assert.deepEqual(tasks()['T-005']!.depends_on.map((d) => d.task), ['T-001']);
    assert.equal(tasks()['T-001']!.lease?.run_id, lease, '进行中的任务不受影响');

    // 4. 再提一次修订，用户打回后重做
    assert.match(await runFlowCommand('replan 再加一个导出格式', env(p, engine)), /已生成修订任务 T-006/);
    await until(() => p.store.readRevision(p.flowId)?.status === 'proposed' && p.store.readRevision(p.flowId)?.task === 'T-006', 60_000, () => engine.next(p.flowId));
    await until(() => p.store.readTask(p.flowId, 'T-006').status === 'done');
    assert.match(await runFlowCommand('replan 第三个', env(p, engine)), /已有一份计划修订等待批准/);
    assert.match(await runFlowCommand('reject 不要 CSV 了，改成 Excel', env(p, engine)), /生成新的修订任务 T-007/);
    await until(() => p.store.readRevision(p.flowId)?.task === 'T-007' && p.store.readTask(p.flowId, 'T-007').status === 'done', 60_000, () => engine.next(p.flowId));
    assert.match(architectSaw.at(-1)!, /被用户打回，意见：不要 CSV 了，改成 Excel/);

    assert.match(await runFlowCommand('approve', env(p, engine)), /新增任务编号：N-001→T-008/);
    assert.equal(tasks()['T-008']!.title, '导出 Excel');

    // 5. 放行 T-001，流程跑完（被取消的任务视为已结束，闸门照常）
    release();
    for (let i = 0; i < 10 && p.store.readFlow(p.flowId).stage_status === 'active'; i++) {
      await engine.pump(p.flowId);
      await engine.next(p.flowId);
      await engine.idle();
    }
    assert.deepEqual(errors, []);
    const final = tasks();
    assert.deepEqual(Object.values(final).map((t) => `${t.id}:${t.status}`),
      ['T-001:done', 'T-002:done', 'T-003:cancelled', 'T-004:done', 'T-005:done', 'T-006:done', 'T-007:done', 'T-008:done']);
    assert.equal(p.store.readRevision(p.flowId)?.status, 'approved');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('修订待批准期间，被点名调整或取消的任务暂停派发；打回后恢复', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [mkTask('T-001', { verify: [] }), mkTask('T-002', { verify: [], writes: ['src/server/t-002/**'] })] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') { assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok); return; }
      return implement(a, `src/server/${a.env.task.toLowerCase()}/a.ts`);
    }, ALL_FAKE);
    await engine.promote(p.flowId);
    await p.store.saveRevision(p.flowId, { task: 'T-001', reason: '测试', run: 'r-x', created_at: new Date().toISOString(), status: 'proposed',
      add: [], rewire: [{ task: 'T-002', depends_on: [] }], cancel: [{ task: 'T-001', reason: '不要了' }], summary: '取消 T-001' }, 'test');
    assert.deepEqual(await engine.next(p.flowId), []);
    await assert.rejects(engine.dispatch(p.flowId, 'T-001'), /待批准的计划修订中/);
    assert.notEqual(nextStep(p.store, 2).tool, 'flow_dispatch');
    await p.store.rejectRevision(p.flowId, '不改了');
    assert.deepEqual((await engine.next(p.flowId)).map((d) => d.task).sort(), ['T-001', 'T-002']);
    await engine.idle();
  } finally { p.cleanup(); }
});
