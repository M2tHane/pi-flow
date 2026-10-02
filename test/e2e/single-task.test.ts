// M3 验收：单任务闭环（fake-subagent 驱动真实的引擎、guard、工具、verify、状态存储）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Engine, DispatchError } from '../../src/core/dispatcher.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';
import { FakeLauncher, type FakeAgent, type Script } from '../fixtures/fake-subagent/launcher.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const AGENTS = path.join(import.meta.dirname, '../../agents');
const allFake: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['backend-engineer', 'reviewer', 'frontend-engineer'].map((r) => [r, { model: 'fake/model', thinking: 'low' as const }])) };

const task1 = () => mkTask('T-001', { verify: ['typecheck', 'test'] });

async function implGood(a: FakeAgent, content = 'export const a = 1;') {
  assert.ok((await a.call('flow_claim')).ok);
  assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content })).ok);
  assert.ok((await a.call('flow_note', { text: '完成 a.ts；下一步无' })).ok);
  const r = await a.call('flow_submit', { summary: '实现 a' });
  assert.ok(r.ok, r.text);
}
const approve: Script = async (a) => { assert.ok((await a.call('flow_approve', { decision: 'pass', notes: '满足验收' })).ok); };

function makeEngine(p: Project, scripts: (role: string, nth: number, a: FakeAgent) => Promise<void>, settings = allFake) {
  const launcher = new FakeLauncher(p.store, p.config, (spec, nth) => (a) => scripts(spec.env['PI_FLOW_ROLE']!, nth, a));
  const errors: unknown[] = [];
  const engine = new Engine({
    root: p.dir, store: p.store, config: p.config, roleSettings: () => settings, launcher,
    packageAgentsDir: AGENTS, subagentExtension: '/dev/null/subagent.ts', onError: (e) => errors.push(e),
  });
  return { engine, launcher, errors };
}

test('一个任务从 ready 走到 queued_merge 并自动合入；run 记录写入指标', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (role, _n, a) => (role === 'reviewer' ? approve(a) : implGood(a)));
    const d = await engine.next(p.flowId);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.model, 'fake/model');
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', t.last_failure ?? '');
    assert.ok(p.store.readEvents().some((e) => e.task === 'T-001' && e.from === 'verifying' && e.to === 'queued_merge'));
    assert.deepEqual(p.store.readMergeQueue().queue, []);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;');

    // 子进程规格：模型、思考级别、工具白名单、guard 扩展最后、token 只在环境变量中
    const [impl, rev] = launcher.launched;
    assert.equal(impl!.thinking, 'low');
    assert.ok(impl!.tools.includes('flow_submit') && !impl!.tools.includes('flow_approve'));
    assert.ok(rev!.tools.includes('flow_approve') && !rev!.tools.includes('write'));
    assert.equal(impl!.extensions.at(-1), '/dev/null/subagent.ts');
    assert.ok(!impl!.prompt.includes(impl!.env['PI_FLOW_RUN_TOKEN']!));
    assert.match(impl!.cwd, /\.worktrees\/B-001-T-001$/);
    assert.equal(rev!.cwd, impl!.cwd);

    const runs = p.store.listRuns();
    assert.deepEqual(runs.map((r) => [r.role, r.outcome]).sort(), [['backend-engineer', 'submitted'], ['reviewer', 'approved']]);
    for (const r of runs) {
      assert.ok(r.ended_at && r.tokens.input! > 0 && r.tokens.output! > 0 && r.model === 'fake/model');
      assert.equal(r.token_hash.length, 64);
    }
    const ev = readdirSync(path.join(p.dir, '.flow/flows', p.flowId, 'evidence/T-001'));
    assert.deepEqual(ev.sort(), ['merge-a0-test.log', 'merge-a0-typecheck.log', 'verify-a0-test.log', 'verify-a0-typecheck.log']);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /提交说明：实现 a[\s\S]*审查通过/);
    // 主工作区没有被实施角色改动
    assert.ok(!existsSync(path.join(p.dir, 'src/server/t-001/a.ts')));
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('无 token 或错 token 的提交被拒；审查者不能用实施者的身份通过', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      await a.call('flow_note', { text: 'n' });
      const forged = await a.callAs({ token: 'forged' }, 'flow_submit', { summary: 'x' });
      assert.equal(forged.ok, false);
      assert.match(forged.text, /token 无效/);
      const none = await a.callAs({ token: '' }, 'flow_submit', { summary: 'x' });
      assert.equal(none.ok, false);
      const otherRun = await a.callAs({ run: 'r-fake' }, 'flow_submit', { summary: 'x' });
      assert.equal(otherRun.ok, false);
      // 实施角色没有 flow_approve
      assert.match((await a.call('flow_approve', { decision: 'pass' })).text, /无权使用|未启用/);
      assert.ok((await a.call('flow_submit', { summary: 'x' })).ok);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('diff 越界被拒；还原后再提交通过', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    let rejected = '';
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      // write 工具越界会被 guard 拦下；bash 可以绕过工具层，靠提交时的 diff 检查兜底
      assert.equal((await a.call('write', { path: 'src/web/x.ts', content: 'x' })).ok, false);
      assert.ok((await a.call('bash', { command: 'mkdir -p src/web && echo x > src/web/x.ts' })).ok);
      await a.call('flow_note', { text: 'n' });
      const r = await a.call('flow_submit', { summary: 'x' });
      assert.equal(r.ok, false);
      rejected = r.text;
      assert.ok((await a.call('bash', { command: 'git rm -q src/web/x.ts' })).ok);
      const r2 = await a.call('flow_submit', { summary: 'x' });
      assert.ok(r2.ok, r2.text);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.match(rejected, /越出任务 writes：src\/web\/x\.ts/);
    assert.match(rejected, /git rm/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('verify 失败回到 in_progress，程序自动重新派发，带上失败原因', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const prompts: string[] = [];
    const { engine } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') return approve(a);
      prompts.push(a.spec.prompt);
      await implGood(a, nth === 1 ? 'FAIL' : 'ok');
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.equal(t.attempts, 1);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /上次未通过的原因[\s\S]*test 退出码 1/);
    const transitions = p.store.readEvents().filter((e) => e.type === 'transition' && e.task === 'T-001').map((e) => `${e.from}->${e.to}`);
    assert.ok(transitions.includes('verifying->in_progress'));
  } finally { p.cleanup(); }
});

test('失败达上限转 blocked，不再派发', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine, launcher } = makeEngine(p, async (role, _n, a) => (role === 'reviewer' ? approve(a) : implGood(a, 'FAIL')));
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.equal(t.attempts, 3);
    assert.match(t.blocked_reason ?? '', /失败次数达到上限 3/);
    assert.equal(launcher.launched.filter((s) => s.env['PI_FLOW_ROLE'] === 'backend-engineer').length, 3);
  } finally { p.cleanup(); }
});

test('审查打回：带位置、问题、期望修改；实施者收到意见后修复', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const prompts: string[] = [];
    const { engine } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') {
        if (nth === 1) {
          const bad = await a.call('flow_approve', { decision: 'reject', issues: [{ location: 'a.ts', problem: '', expected: 'x' }] });
          assert.equal(bad.ok, false);
          assert.ok((await a.call('flow_approve', { decision: 'reject', issues: [{ location: 'src/server/t-001/a.ts:1', problem: '缺少校验', expected: '参数非法时返回 422' }] })).ok);
          return;
        }
        return approve(a);
      }
      prompts.push(a.spec.prompt);
      await implGood(a);
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(prompts[1]!, /src\/server\/t-001\/a\.ts:1：缺少校验；期望：参数非法时返回 422/);
  } finally { p.cleanup(); }
});

test('子进程未提交就退出：计一次失败并重新派发', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') return approve(a);
      if (nth === 1) { await a.call('flow_claim'); throw new Error('模型连接失败'); }
      await implGood(a);
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.equal(t.attempts, 1);
    const failed = p.store.listRuns().find((r) => r.outcome === 'failed');
    assert.ok(failed);
    assert.ok(p.store.readEvents().some((e) => e.trigger === 'run_failed' && /模型连接失败/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});

test('违规达到上限：run 被终止，任务转 blocked', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      for (let i = 0; i < 7; i++) await a.call('bash', { command: 'echo x > .flow/state.json' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'blocked');
    assert.match(t.blocked_reason ?? '', /违规/);
    assert.equal(p.store.listRuns()[0]!.outcome, 'killed');
    assert.equal(p.store.readEvents().filter((e) => e.type === 'violation').length, 5, '默认上限 5');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('角色未设置模型时拒绝派发并提示 /flow-config', async () => {
  const p = await setupProject({ tasks: [task1()] });
  try {
    const { engine } = makeEngine(p, async () => {}, { version: 1, roles: {} });
    await engine.promote(p.flowId);
    await assert.rejects(engine.dispatch(p.flowId, 'T-001'), (e: unknown) => e instanceof DispatchError && /flow-config/.test((e as Error).message));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'ready');
  } finally { p.cleanup(); }
});
