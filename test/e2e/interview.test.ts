// 需求访谈：/flow-build、/flow-fix 默认先访谈；清单完整后用户确认才开流程；/flow answer 由用户亲手作答。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runFlowBuild, runFlowFix, runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';
import { updateBrief, activeBrief } from '../../src/modes/interview.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, type RoleScript } from '../helpers/engine.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
const SETTINGS: RoleSettingsFile = { version: 1, roles: Object.fromEntries(['architect', 'reviewer', 'scout', 'backend-engineer'].map((r) => [r, { model: 'fake/m' }])) };

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine'], ui: CommandEnv['ui'] = null, calls: string[] = []): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => SETTINGS, availableModels: () => [],
    activateOrchestrator: () => { calls.push('orchestrator'); },
    activateInterview: (m) => { calls.push(`interview:${m}`); },
    deactivateOrchestrator: () => { calls.push('off'); return 'off'; },
    waitForIdle: true,
  };
}

async function freshProject() {
  const p = await setupProject({ yaml: YAML });
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  return p;
}

const prdScript: RoleScript = async (role, _n, a) => {
  if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass' }); return; }
  await a.call('flow_claim');
  await a.call('write', { path: 'docs/PRD.md', content: `# PRD\n${a.spec.prompt.includes('用户确认的需求摘要') ? '依据访谈摘要' : '无摘要'}\n` });
  await a.call('flow_note', { text: '完成' });
  await a.call('flow_submit', { summary: 'PRD' });
};

test('/flow-build 默认先访谈：清单不完整不能确认；确认后开流程，S0 任务拿到需求摘要', async () => {
  const p = await freshProject();
  try {
    const calls: string[] = [];
    const prompts: string[] = [];
    const { engine } = makeEngine(p, async (role, n, a) => { prompts.push(a.spec.prompt); await prdScript(role, n, a); }, SETTINGS);
    const e = env(p, engine, null, calls);
    const out = await runFlowBuild('"做一个待办应用"', e);
    assert.match(out, /开始需求访谈（新项目）[\s\S]*\/flow-build --confirm/);
    assert.deepEqual(calls, ['interview:build']);
    assert.equal(activeBrief(p.store)?.description, '做一个待办应用');
    assert.equal(p.store.readState().active_flow, null, '访谈期间不开流程');

    await updateBrief(p.store, { goal: '个人管理待办', users: '我自己，网页端' });
    await assert.rejects(runFlowBuild('--confirm', e), /需求还不完整，缺少：功能范围、非目标、验收标准、约束与假设/);
    await assert.rejects(updateBrief(p.store, { bogus: 'x' }), /未知的小节：bogus/);
    await updateBrief(p.store, { scope: '新建、完成、删除待办', non_goals: '不做多人协作', acceptance: '新建后列表多一条', constraints: '无' });
    await assert.rejects(runFlowFix('--confirm', e), /进行中的访谈是新项目，请用 \/flow-build --confirm 确认/);

    const started = await runFlowBuild('--confirm', e);
    assert.match(started, /已创建流程 B-002（build）/);
    assert.deepEqual(calls, ['interview:build', 'orchestrator']);
    assert.equal(p.store.readBrief()?.status, 'confirmed');
    assert.equal(p.store.readBrief()?.flow, 'B-002');
    assert.match(p.store.readFlowBrief('B-002'), /## 非目标\n不做多人协作/);
    assert.match(prompts[0]!, /用户确认的需求摘要[\s\S]*新建、完成、删除待办/);
    assert.match(p.git('show', 'flow/B-002/integration:docs/PRD.md'), /依据访谈摘要/);
    await assert.rejects(runFlowBuild('--confirm', e), /当前没有进行中的需求访谈/);
  } finally { p.cleanup(); }
});

test('--direct 与 --from 跳过访谈；--cancel 放弃访谈', async () => {
  const p = await freshProject();
  try {
    const { engine } = makeEngine(p, prdScript, SETTINGS);
    const calls: string[] = [];
    const e = env(p, engine, null, calls);
    await runFlowBuild('--feature "订单导出"', e);
    assert.equal(activeBrief(p.store)?.mode, 'feature');
    assert.match(await runFlowBuild('--cancel', e), /已放弃需求访谈/);
    assert.equal(activeBrief(p.store), null);
    writeFileSync(path.join(p.dir, 'idea.md'), '# 记账应用\n\n要能记一笔支出。\n');
    const out = await runFlowBuild('--from idea.md', e);
    assert.match(out, /已创建流程 B-002/);
    assert.equal(p.store.readFlow('B-002').title, '记账应用');
    assert.match(p.store.readFlowBrief('B-002'), /要能记一笔支出/);
  } finally { p.cleanup(); }
});

test('/flow-fix 访谈：问清现象与复现步骤后确认', async () => {
  const p = await freshProject();
  try {
    const { engine } = makeEngine(p, async () => { await new Promise(() => {}); }, SETTINGS);
    const calls: string[] = [];
    const e = { ...env(p, engine, null, calls), waitForIdle: false };
    assert.match(await runFlowFix('"登录后白屏"', e), /开始需求访谈（修复）/);
    await updateBrief(p.store, { symptom: '登录后白屏', repro: '1. 登录 2. 跳转首页', expected: '显示首页', actual: '空白', scope: '首页，稳定复现' });
    assert.match(await runFlowFix('--confirm', e), /已创建修复 X-002/);
    assert.match(p.store.readFlowBrief('X-002'), /## 复现步骤\n1\. 登录 2\. 跳转首页/);
    assert.match(p.store.readHandoff('X-002', 'T-001'), /用户确认的问题描述/);
  } finally { p.cleanup(); }
});

test('/flow answer：弹出输入框由用户作答；无界面时提示用 /flow unblock', async () => {
  const p = await setupProject({ yaml: YAML });
  try {
    const { engine } = makeEngine(p, async (_r, nth, a) => { await a.call('flow_claim'); if (nth === 1) await a.call('flow_block', { reason: '用 PostgreSQL 还是 SQLite？' }); else await new Promise(() => {}); }, SETTINGS);
    await p.store.addTasks(p.flowId, [{ id: 'T-001', stage: 'S3', kind: 'impl', title: '存储层', role: 'backend-engineer', scopes: ['backend'], depends_on: [], inputs: [], writes: ['src/server/db/**'], acceptance: ['a'], verify: [] }], 'architect');
    await engine.next(p.flowId);
    for (let i = 0; i < 100 && p.store.readTask(p.flowId, 'T-001').status !== 'blocked'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(await runFlowCommand('answer', env(p, engine)), /T-001「存储层」：用 PostgreSQL 还是 SQLite？\n  → \/flow unblock T-001/);
    const asked: string[] = [];
    const ui = { select: async () => undefined, notify: () => {}, input: async (title: string) => { asked.push(title); return 'SQLite'; } };
    const out = await runFlowCommand('answer', env(p, engine, ui));
    assert.match(asked[0]!, /用 PostgreSQL 还是 SQLite？/);
    assert.match(out, /已解除 T-001 的阻塞.*回答已交给该任务/);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /用户回答：\nSQLite/);
    assert.equal(await runFlowCommand('answer', env(p, engine, ui)), '没有等待你回答的问题。');
  } finally { p.cleanup(); }
});
