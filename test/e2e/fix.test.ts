// M7 验收：/flow-fix 全流程、与 build 流程并存的规则、成本统计与 runs 记录一致。
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
  ['implementer', 'acceptor', 'backend-engineer'].map((r) => [r, { model: 'fake/m' }])) };

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => SETTINGS, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

/** 实现者：第一次只加了回归测试、没修好（合并时全量测试失败），第二次修好；验收者逐条确认 */
function scripts(opts: { acceptPass?: boolean } = {}): RoleScript {
  return async (role, nth, a: FakeAgent) => {
    if (role === 'acceptor') {
      const ids = ['A-1', 'A-2', 'A-3'];
      const r = await a.call('flow_accept', { summary: '复现确认', results: ids.map((id) => ({ id, passed: opts.acceptPass ?? true, evidence: 'add(1,2) 返回 3' })) });
      assert.ok(r.ok, r.text);
      return;
    }
    assert.ok((await a.call('flow_claim')).ok);
    assert.ok((await a.call('read', { path: 'src/server/calc/add.ts' })).ok);
    const dir = `tests/acceptance/fixes/${a.env.flow.toLowerCase()}`;
    await a.call('write', { path: `${dir}/add.test.ts`, content: '// EXPECT_BUG_GONE add(1,2)===3\n' });
    if (nth > 1) await a.call('write', { path: 'src/server/calc/add.ts', content: 'export const add = (a: number, b: number) => a + b;\n' });
    await a.call('flow_note', { text: '根因：加法实现成了减法' });
    const s = await a.call('flow_submit', { summary: '修正加法并加回归测试' });
    assert.ok(s.ok, s.text);
  };
}

async function project() {
  const p = await setupProject({ yaml: YAML, files: { 'src/server/calc/add.ts': 'export const add = (a: number, b: number) => a - b; // BUG\n' } });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
}

test('/flow-fix：一个实现者定位并修复（回归测试）→ 合并时全量测试 → 直接合入主分支 → 独立验收 → 日志含成本', async () => {
  const p = await project();
  try {
    const { engine, errors, launcher } = makeEngine(p, scripts(), SETTINGS);
    const out = await runFlowFix('--direct "加法结果不对：add(1,2) 返回 -1"', env(p, engine));
    assert.deepEqual(errors, []);
    assert.match(out, /已创建修复 X-002/);
    const fixId = 'X-002';
    const flow = p.store.readFlow(fixId);
    assert.equal(flow.stage_status, 'done', out);
    const tasks = p.store.listTasks(fixId);
    const fix = tasks.find((t) => t.id === 'T-001')!;
    assert.deepEqual([fix.kind, fix.role, fix.status, fix.accepted], ['impl', 'implementer', 'done', true]);
    // 第一次没修好：合并时全量测试失败退回
    assert.equal(fix.attempts, 1);
    assert.match(fix.last_failure ?? '', /合并后验证失败/);
    assert.ok(tasks.some((t) => t.role === 'acceptor' && t.accept_of === 'T-001' && t.status === 'done'));
    assert.match(launcher.launched[0]!.prompt, /用户报告的问题：\n加法结果不对/);
    // 主分支（主工作区检出）得到修复与回归测试
    assert.match(readFileSync(path.join(p.dir, 'src/server/calc/add.ts'), 'utf8'), /a \+ b/);
    assert.match(readFileSync(path.join(p.dir, 'tests/acceptance/fixes/x-002/add.test.ts'), 'utf8'), /EXPECT_BUG_GONE/);
    assert.match(p.git('log', '--format=%s', 'main'), /^\[X-002\/T-001\] /m);
    assert.equal(p.git('status', '--porcelain', '--', '.', ':(exclude).flow'), '');
    // fix 日志
    const logs = p.store.listFixLogs();
    assert.equal(logs.length, 1);
    const log = readFileSync(path.join(p.dir, '.flow/fixes', logs[0]!), 'utf8');
    for (const sec of ['## 问题', '## 改动', '## 验收', '## 成本']) assert.ok(log.includes(sec), sec);
    assert.match(log, /src\/server\/calc\/add\.ts/);
    assert.match(log, /A-1 [^\n]*：通过（add\(1,2\) 返回 3）/);
    const cost = costReport(p.store, { flow: fixId });
    assert.ok(log.includes(`合计：${cost.total.runs} 次运行`));
    assert.match(await runFlowCommand('status --cost', env(p, engine)), new RegExp(`\\.flow/fixes/${logs[0]}`));
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('fix 与 build 流程：流程运行中拒绝；等待审批时需确认；同时只允许一个修复', async () => {
  const p = await setupProject({ yaml: YAML, files: { 'src/server/calc/add.ts': 'BUG\n' } });
  try {
    const { engine } = makeEngine(p, scripts(), SETTINGS);
    await assert.rejects(runFlowFix('--direct "x"', env(p, engine)), /进行中的流程 B-001 正在阶段 S3 运行/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(await runFlowFix('--direct "x"', env(p, engine)), /确认请在原命令后加 --yes/);
    await assert.rejects(p.store.createFixFlow('a', 'main', p.git('rev-parse', 'main')).then(() => p.store.createFixFlow('b', 'main', p.git('rev-parse', 'main'))), /已有进行中的修复/);
    assert.equal(p.store.readState().active_flow, 'B-001', 'fix 不占用活动流程指针');
  } finally { p.cleanup(); }
});

test('成本汇总与 runs 记录一致；返工统计来自事件日志', async () => {
  const p = await project();
  try {
    const { engine } = makeEngine(p, scripts(), SETTINGS);
    await runFlowFix('--direct "加法结果不对"', env(p, engine));
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
    const repro = c.rework.find((w) => w.task === 'T-001')!;
    assert.equal(repro.merge_fail, 1);
    const text = await runFlowCommand('status --cost', env(p, engine));
    assert.match(text, /# 成本统计[\s\S]*## 按角色[\s\S]*返工最多的任务[\s\S]*T-001/);
  } finally { p.cleanup(); }
});
