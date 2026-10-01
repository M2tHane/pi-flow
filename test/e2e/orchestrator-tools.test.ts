// orchestrator 工具：flow_dispatch 只收 ready 任务、非阻塞；flow_wait 返回精简摘要；flow_status 列出待处理事项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Engine } from '../../src/core/dispatcher.ts';
import { flowDispatch, flowWait, statusText } from '../../src/tools/orchestrator-tools.ts';
import { FakeLauncher } from '../fixtures/fake-subagent/launcher.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

test('flow_dispatch / flow_wait / flow_status', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] }), mkTask('T-002', { deps: [hard('T-001')] })] });
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const launcher = new FakeLauncher(p.store, p.config, (spec) => async (a) => {
      if (spec.env['PI_FLOW_ROLE'] === 'reviewer') { await a.call('flow_approve', { decision: 'pass' }); return; }
      await gate; // 让实施 run 挂起，验证 dispatch 非阻塞
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('flow_note', { text: 'n' });
      await a.call('flow_submit', { summary: 's' });
    });
    const engine = new Engine({ root: p.dir, store: p.store, config: p.config, launcher,
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fake/m' }, reviewer: { model: 'fake/r' } } }),
      packageAgentsDir: path.join(import.meta.dirname, '../../agents'), subagentExtension: 'sub.ts' });

    await assert.rejects(flowDispatch(p.store, engine, { task_id: 'T-002' }), /只接受 ready.*T-001/);
    await assert.rejects(flowDispatch(p.store, engine, { task_id: 'T-099' }), /不存在/);
    const d = await flowDispatch(p.store, engine, { task_id: 'T-001' });
    assert.match(d.text, /已派发 T-001 给 backend-engineer（模型 fake\/m/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'in_progress', 'dispatch 应立即返回');
    assert.match(statusText(p.store, engine, p.flowId), /运行中：T-001（backend-engineer/);

    const timeout = await flowWait(p.store, engine, { task_id: 'T-001', timeout_s: 1 });
    assert.match(timeout.text, /等待超时/);

    release();
    let last = '';
    for (let i = 0; i < 20 && p.store.readTask(p.flowId, 'T-001').status !== 'done'; i++) {
      last = (await flowWait(p.store, engine, { task_id: 'T-001', timeout_s: 10 })).text;
    }
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(last, /T-001：.* → /);
    assert.ok(!last.includes('PI_FLOW'), '摘要不应包含 run 环境');
    await engine.idle();
  } finally { p.cleanup(); }
});
