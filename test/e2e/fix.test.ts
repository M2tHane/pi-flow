// M7 验收：/flow-fix 全流程、升级提示、与 build 流程并存的规则、成本统计与 runs 记录一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runFlowCommand, runFlowFix, type CommandEnv } from '../../src/commands/flow.ts';
import { costReport } from '../../src/core/cost.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, type RoleScript } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

// 测试套件：带 EXPECT_BUG_GONE 标记的复现测试在 BUG 仍存在时失败
const TEST_CMD = "for f in $(find tests/acceptance/fixes -name '*.ts' 2>/dev/null); do grep -q EXPECT_BUG_GONE $f && grep -rq BUG src/server/calc && exit 1; done; exit 0";
const YAML = PROJECT_YAML.replace(/  test:      ".*"/, `  test:      "${TEST_CMD.replace(/"/g, '\\"')}"`);
const SETTINGS: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['scout', 'test-engineer', 'backend-engineer', 'reviewer'].map((r) => [r, { model: 'fake/m' }])) };

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => SETTINGS, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

const findings = (over: Record<string, unknown> = {}) => ({
  location: 'src/server/calc/add.ts:1', root_cause: '加法实现成了减法', impact_files: ['src/server/calc/add.ts'],
  suggested_role: 'backend-engineer', contract_change: false, estimated_files: 1, ...over,
});

function scripts(scoutFindings = findings()): RoleScript {
  return async (role, nth, a: FakeAgent) => {
    if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass', notes: 'ok' }); return; }
    await a.call('flow_claim');
    if (role === 'scout') {
      assert.ok((await a.call('read', { path: 'src/server/calc/add.ts' })).ok);
      // 只读角色不能写
      assert.equal((await a.call('write', { path: 'x.ts', content: '' })).ok, false);
      await a.call('flow_note', { text: '定位到 add.ts' });
      const r = await a.call('flow_submit', { summary: '加法写错', findings: scoutFindings });
      assert.ok(r.ok, r.text);
      return;
    }
    if (role === 'test-engineer') {
      const dir = `tests/acceptance/fixes/${a.env.flow.toLowerCase()}`;
      // 第一次写的测试没有复现问题（不含标记），应被打回
      await a.call('write', { path: `${dir}/add.test.ts`, content: nth === 1 ? '// 没有断言\n' : '// EXPECT_BUG_GONE add(1,2)===3\n' });
    } else {
      await a.call('write', { path: 'src/server/calc/add.ts', content: 'export const add = (a: number, b: number) => a + b;\n' });
    }
    await a.call('flow_note', { text: '完成' });
    const s = await a.call('flow_submit', { summary: role === 'test-engineer' ? '复现测试' : '修正加法' });
    assert.ok(s.ok, s.text);
  };
}

async function project() {
  const p = await setupProject({ yaml: YAML, files: { 'src/server/calc/add.ts': 'export const add = (a: number, b: number) => a - b; // BUG\n' } });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
}

test('/flow-fix：scout → 复现测试先失败 → 修复 → 审查 → 直接合入主分支 → 日志含成本', async () => {
  const p = await project();
  try {
    const { engine, errors } = makeEngine(p, scripts(), SETTINGS);
    const out = await runFlowFix('"加法结果不对：add(1,2) 返回 -1"', env(p, engine));
    assert.deepEqual(errors, []);
    assert.match(out, /已创建修复 X-002/);
    const fixId = 'X-002';
    const flow = p.store.readFlow(fixId);
    assert.equal(flow.stage_status, 'done', out);
    const tasks = p.store.listTasks(fixId);
    assert.deepEqual(tasks.map((t) => [t.kind, t.role, t.status]), [
      ['analysis', 'scout', 'done'], ['test', 'test-engineer', 'done'], ['impl', 'backend-engineer', 'done']]);
    const fix = tasks[2]!;
    assert.deepEqual(fix.writes, ['src/server/calc/add.ts']);
    // 复现测试第一次没有失败 → 被打回
    assert.equal(tasks[1]!.attempts, 1);
    assert.match(tasks[1]!.last_failure ?? '', /复现测试没有失败/);
    // 主分支（主工作区检出）得到修复与复现测试
    assert.match(readFileSync(path.join(p.dir, 'src/server/calc/add.ts'), 'utf8'), /a \+ b/);
    assert.match(readFileSync(path.join(p.dir, `tests/acceptance/fixes/x-002/add.test.ts`), 'utf8'), /EXPECT_BUG_GONE/);
    assert.match(p.git('log', '--format=%s', 'main'), /^\[X-002\/T-003\] fix: 加法结果不对/m);
    assert.equal(p.git('status', '--porcelain', '--', '.', ':(exclude).flow'), '');
    // fix 日志
    const logs = p.store.listFixLogs();
    assert.equal(logs.length, 1);
    const log = readFileSync(path.join(p.dir, '.flow/fixes', logs[0]!), 'utf8');
    for (const sec of ['## 问题', '## 根因', '## 改动', '## 验证', '## 成本']) assert.ok(log.includes(sec), sec);
    assert.match(log, /加法实现成了减法/);
    assert.match(log, /src\/server\/calc\/add\.ts/);
    const cost = costReport(p.store, { flow: fixId });
    assert.ok(log.includes(`合计：${cost.total.runs} 次运行`));
    assert.match(await runFlowCommand('status --cost', env(p, engine)), new RegExp(`\\.flow/fixes/${logs[0]}`));
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('超出 fix 规模时给出升级提示；用户可继续或中止', async () => {
  const p = await project();
  try {
    const { engine } = makeEngine(p, scripts(findings({ estimated_files: 9, contract_change: true })), SETTINGS);
    await runFlowFix('"导出功能有问题"', env(p, engine));
    const fix = p.store.openFixFlow()!;
    assert.equal(fix.stage_status, 'awaiting_human');
    const status = await runFlowCommand('status', env(p, engine));
    assert.match(status, /^需要你处理：\n- 修复 X-002 超出修复规模：需要修改契约/);
    assert.match(status, /仍按修复处理 \/flow approve；改用功能流程 \/flow abort/);
    assert.match(status, /\[需求 ✓ → 规划\]|需求 ✓ → \[规划\]/);
    assert.match(await runFlowCommand('status --detail', env(p, engine)), /建议改用 \/flow-build --feature：需要修改契约/);
    assert.match(await runFlowCommand('abort', env(p, engine)), /确认请执行 \/flow abort --yes/);
    assert.match(await runFlowCommand('abort --yes', env(p, engine)), /已中止 X-002.*--feature/);
    assert.equal(p.store.openFixFlow(), null);

    // 再来一次，这次选择继续
    await runFlowFix('"导出功能有问题（第二次）"', env(p, engine));
    assert.equal(p.store.openFixFlow()!.stage_status, 'awaiting_human');
    const r = await runFlowCommand('approve', env(p, engine));
    assert.match(r, /继续按修复处理/);
    assert.equal(p.store.readFlow('X-003').stage_status, 'done');
  } finally { p.cleanup(); }
});

test('fix 与 build 流程：流程运行中拒绝；等待审批时需确认；同时只允许一个修复', async () => {
  const p = await setupProject({ yaml: YAML, files: { 'src/server/calc/add.ts': 'BUG\n' } });
  try {
    const { engine } = makeEngine(p, scripts(), SETTINGS);
    await assert.rejects(runFlowFix('"x"', env(p, engine)), /进行中的流程 B-001 正在阶段 S3 运行/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(await runFlowFix('"x"', env(p, engine)), /确认请执行 \/flow-fix "<描述>" --yes/);
    await assert.rejects(p.store.createFixFlow('a', 'main', p.git('rev-parse', 'main')).then(() => p.store.createFixFlow('b', 'main', p.git('rev-parse', 'main'))), /已有进行中的修复/);
    assert.equal(p.store.readState().active_flow, 'B-001', 'fix 不占用活动流程指针');
  } finally { p.cleanup(); }
});

test('成本汇总与 runs 记录一致；返工统计来自事件日志', async () => {
  const p = await project();
  try {
    const { engine } = makeEngine(p, scripts(), SETTINGS);
    await runFlowFix('"加法结果不对"', env(p, engine));
    const runs = p.store.listRuns();
    const c = costReport(p.store);
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const sum = runs.reduce((a, r) => a + (r.tokens[k] ?? 0), 0);
      assert.equal(c.total.tokens[k], sum, k);
      assert.equal(c.byRole.reduce((a, r) => a + (r.tokens[k] ?? 0), 0), sum, `byRole ${k}`);
      assert.equal(c.byTask.reduce((a, r) => a + (r.tokens[k] ?? 0), 0), sum, `byTask ${k}`);
    }
    assert.equal(c.total.runs, runs.length);
    assert.equal(c.byFlow.reduce((a, r) => a + r.runs, 0), runs.length);
    const repro = c.rework.find((w) => w.task === 'T-002')!;
    assert.equal(repro.verify_fail, 1);
    const text = await runFlowCommand('status --cost', env(p, engine));
    assert.match(text, /# 成本统计[\s\S]*## 按角色[\s\S]*返工最多的任务[\s\S]*T-002/);
  } finally { p.cleanup(); }
});
