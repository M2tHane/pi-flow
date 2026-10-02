// M6 验收：build 与 feature 模式（fake-subagent 驱动全流程）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, ALL_FAKE } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { startFlow, approveStage, rejectStage } from '../../src/core/stages.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';
import { mutexPairs } from '../../src/core/dag.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

const ALL_TRUE = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
/** 验收测试含 FAIL 标记且实现（src/server/todo）不存在时失败：模拟"实现之前必然失败"的真实测试 */
const ACCEPT_TEST = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "! grep -rqs FAIL tests/acceptance || test -d src/server/todo"');
const SETTINGS: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['architect', 'reviewer', 'backend-engineer', 'frontend-engineer', 'test-engineer', 'infra-engineer', 'db-engineer', 'ui-designer'].map((r) => [r, { model: 'fake/m' }])) };
void ALL_FAKE;

const fileFor = (glob: string, id: string) => (glob.endsWith('/**') ? `${glob.slice(0, -3)}/${id.toLowerCase()}.ts` : glob.replace(/\*/g, 'x'));

/** 通用脚本：架构阶段提交 DAG；其他任务按 writes 写一个文件后提交；审查一律通过 */
function scripts(p: Project, proposal: (stage: string) => unknown[]) {
  return async (role: string, _nth: number, a: FakeAgent) => {
    if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass', notes: 'ok' }); return; }
    const t = p.store.readTask(p.flowId === '' ? a.env.flow : a.env.flow, a.env.task);
    assert.ok((await a.call('flow_claim')).ok);
    if (t.stage === 'S0') await a.call('write', { path: 'docs/PRD.md', content: `# PRD（${t.id}）\n## 非目标\n- 无\n## 验收标准\n- 可创建待办\n` });
    else if (t.stage === 'F0') await a.call('write', { path: 'docs/features/export.md', content: '# 功能说明\n' });
    else if (t.stage === 'S1' || t.stage === 'F1') {
      await a.call('write', { path: 'docs/ARCHITECTURE.md', content: '# 架构\n' });
      if (t.stage === 'S1') await a.call('write', { path: 'docs/contracts/api.ts', content: 'export type Todo = { id: string };\n' });
      const r = await a.call('flow_propose_tasks', { tasks: proposal(t.stage) });
      assert.ok(r.ok, r.text);
    } else {
      // 验收测试第一次写成"必然通过"（被程序打回），第二次才是实现前会失败的测试
      const content = t.title === '待办验收测试' && t.attempts > 0 ? `// ${t.title}\n// FAIL until implemented\n` : `// ${t.title}\n`;
      assert.ok((await a.call('write', { path: fileFor(t.writes[0]!, t.id), content })).ok, t.writes[0]);
    }
    await a.call('flow_note', { text: '完成' });
    const s = await a.call('flow_submit', { summary: t.title });
    assert.ok(s.ok, s.text);
  };
}

const BUILD_DAG = [
  { id: 'T-001', stage: 'S2', kind: 'infra', title: '脚手架', role: 'infra-engineer', scopes: ['infra'], depends_on: [], inputs: [], writes: ['package.json'], acceptance: ['可安装'], verify: ['typecheck'] },
  { id: 'T-002', stage: 'S3', kind: 'test', title: '待办验收测试', role: 'test-engineer', scopes: ['acceptance'], depends_on: [], inputs: [], writes: ['tests/acceptance/todo/**'], acceptance: ['覆盖创建待办'], verify: ['test'] },
  { id: 'T-003', stage: 'S3', kind: 'impl', title: '待办 API', role: 'backend-engineer', scopes: ['backend'], depends_on: [{ task: 'T-002', type: 'hard', reason: '先有验收测试' }], inputs: ['docs/contracts/api.ts'], writes: ['src/server/todo/**'], acceptance: ['POST /todos 返回 201'], verify: ['test'] },
  { id: 'T-004', stage: 'S3', kind: 'impl', title: '待办 API 日志', role: 'backend-engineer', scopes: ['backend'], depends_on: [], inputs: [], writes: ['src/server/todo/log.ts'], acceptance: ['记录请求'], verify: ['test'] },
  { id: 'T-005', stage: 'S3', kind: 'impl', title: '待办页面', role: 'frontend-engineer', scopes: ['frontend'], depends_on: [{ task: 'T-003', type: 'soft' }], inputs: ['docs/contracts/api.ts'], writes: ['src/web/todo/**'], acceptance: ['列表展示'], verify: ['test'] },
  { id: 'T-006', stage: 'S3', kind: 'integration', title: '前后端联调', role: 'test-engineer', scopes: ['acceptance'], depends_on: [{ task: 'T-003', type: 'hard', reason: '需要后端实现' }, { task: 'T-005', type: 'hard', reason: '需要页面' }], inputs: [], writes: ['tests/e2e/todo/**'], acceptance: ['端到端创建待办'], verify: ['test'] },
];

/** 回放事件：互斥对从未同时在途 */
function assertMutexNeverParallel(p: Project, flowId: string, pairs: [string, string][]) {
  const inflight = new Set<string>();
  const IN = ['in_progress', 'review', 'verifying', 'queued_merge', 'merging'];
  for (const e of p.store.readEvents()) {
    if (e.flow !== flowId || e.type !== 'transition' || !e.task) continue;
    if (IN.includes(e.to!)) inflight.add(e.task); else inflight.delete(e.task);
    for (const [a, b] of pairs) assert.ok(!(inflight.has(a) && inflight.has(b)), `${a} 与 ${b} 互斥却同时在途（事件 #${e.seq}）`);
  }
}

async function drive(p: Project, engine: ReturnType<typeof makeEngine>['engine'], flowId: string, onHuman: (stage: string) => Promise<void>) {
  for (let i = 0; i < 80; i++) {
    const s = p.store.readState().active_flow;
    if (!s) return;
    const f = p.store.readFlow(flowId);
    if (f.stage_status === 'awaiting_human') { await onHuman(f.stage); continue; }
    const sig = () => `${p.store.readFlow(flowId).version}|${p.store.listTasks(flowId).map((t) => `${t.id}:${t.status}`).join(',')}`;
    const before = sig();
    await engine.pump(flowId);
    await engine.next(flowId);
    await engine.idle();
    const g = p.store.readFlow(flowId);
    if (sig() === before) {
      throw new Error(`流程停在 ${g.stage}/${g.stage_status}：\n${statusText(p.store, null, flowId)}`);
    }
  }
  throw new Error('流程未在预期步数内结束');
}

test('build 模式全流程：闸门逐个人工批准，agent 不能批准；提案批准后才落为任务；互斥任务不并行；验收测试先失败并随实现合入；最终合入主分支', async () => {
  const p = await setupProject({ yaml: ACCEPT_TEST });
  try {
    // 夹具已建了一个 S3 流程，先中止它，换成完整的 build 流程
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个待办应用');
    assert.deepEqual(flow.stages, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    const { engine, errors } = makeEngine({ ...p, flowId: flow.id }, scripts(p, () => BUILD_DAG), SETTINGS);
    const seen: string[] = [];
    await drive(p, engine, flow.id, async (stage) => {
      seen.push(stage);
      if (stage === 'S1') {
        assert.equal(p.store.listTasks(flow.id).length, 3, '批准前提案不落为任务（S0、S0 修订、S1 各一个）');
        assert.match(statusText(p.store, null, flow.id), /任务提案（S1）[\s\S]*关键路径长度/);
        // agent 无法批准阶段闸门
        await assert.rejects(p.store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'run:r-x' }), /用户/);
        // 闸门未批准，next 不会派发后续任务
        assert.deepEqual(await engine.next(flow.id), []);
      }
      if (stage === 'S0') {
        // 打回一次：生成修订任务
        if (!seen.includes('S0-rejected')) {
          seen.push('S0-rejected');
          const r = await rejectStage({ root: p.dir, store: p.store, config: p.config }, flow.id, '补充非目标');
          assert.match(r, /修订任务 T-002/);
          return;
        }
      }
      await approveStage({ root: p.dir, store: p.store, config: p.config }, flow.id);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen, ['S0', 'S0-rejected', 'S0', 'S1', 'S5'], 'S2、S3、S4 的闸门不需要人工，自动推进');
    assert.equal(p.store.readState().active_flow, null);
    const tasks = p.store.listTasks(flow.id);
    assert.ok(tasks.every((t) => t.status === 'done'), tasks.map((t) => `${t.id}:${t.status}`).join(' '));
    assert.equal(tasks.length, 3 + BUILD_DAG.length);
    // 提案重新编号：T-001..T-006 → T-004..T-009，依赖一起改写
    const impl = tasks.find((t) => t.title === '待办 API')!;
    assert.deepEqual(impl.depends_on.map((d) => d.task), [tasks.find((t) => t.title === '待办验收测试')!.id]);
    const f = p.store.readFlow(flow.id);
    assert.deepEqual(Object.keys(f.approvals).sort(), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].filter((s) => s !== 'S2' && s !== 'S3' && s !== 'S4'));
    // 主分支包含集成分支的全部提交
    assert.match(p.git('log', '--format=%s', 'main'), /^pi-flow: 合入 B-002 做一个待办应用$/m);
    assert.ok(existsSync(path.join(p.dir, 'src/server/todo/log.ts')) || p.git('show', 'main:src/server/todo/log.ts') !== undefined);
    assertMutexNeverParallel(p, flow.id, mutexPairs(tasks));
    // 先行验收测试：第一次"必然通过"被打回，第二次确认失败后不单独合入，由实现任务一并带入
    const accept = tasks.find((t) => t.title === '待办验收测试')!;
    const acceptEv = p.store.readEvents().filter((e) => e.task === accept.id && e.type === 'transition');
    const bounced = acceptEv.find((e) => e.trigger === 'precheck_fail'); // 审查前验证就发现测试没有失败（第三轮 1）
    assert.match(bounced?.reason ?? '', /验收测试没有失败/);
    assert.ok(acceptEv.some((e) => e.trigger === 'repro_confirmed'));
    assert.ok(!acceptEv.some((e) => e.trigger === 'merge_done'), '验收测试不单独合入');
    // 集成分支每次前进后的 HEAD 都不是红的：有验收测试就有实现；测试提交紧接着实现提交，一次快进
    const integ = p.store.readFlow(flow.id).integration_branch;
    const heads = p.store.readEvents().filter((e) => e.flow === flow.id && e.type === 'merge').map((e) => e.evidence!);
    assert.ok(heads.length >= 6);
    for (const sha of heads) {
      const files = p.git('ls-tree', '-r', '--name-only', sha);
      assert.ok(!/tests\/acceptance\/todo\//.test(files) || /src\/server\/todo\//.test(files), `集成分支在 ${sha} 有验收测试但没有实现`);
    }
    const log = p.git('log', '--format=%H %s', integ).trim().split('\n');
    const iTest = log.findIndex((l) => l.includes(`/${accept.id}] 待办验收测试`));
    assert.ok(iTest > 0 && log[iTest - 1]!.includes(`/${impl.id}] 待办 API`), log.join('\n'));
    assert.ok(mutexPairs(tasks).some(([a, b]) => [a, b].includes(tasks.find((t) => t.title === '待办 API 日志')!.id)), '测试数据中应有互斥对');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('feature 模式：跳过 S2；S4 跑全量回归；闸门未过不能进入下一阶段，修复后 /flow gate 重跑', async () => {
  const p = await setupProject({ yaml: ALL_TRUE.replace('e2e:       "true"', 'e2e:       "false"') });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'feature', '订单导出');
    assert.deepEqual(flow.stages, ['F0', 'F1', 'S3', 'S4']);
    const dag = [
      { id: 'T-001', stage: 'S3', kind: 'impl', title: '导出 API', role: 'backend-engineer', scopes: ['backend'], depends_on: [], inputs: [], writes: ['src/server/export/**'], acceptance: ['导出 CSV'], verify: ['test'] },
      { id: 'T-002', stage: 'S4', kind: 'test', title: '导出验收测试', role: 'test-engineer', scopes: ['acceptance'], depends_on: [{ task: 'T-001', type: 'hard', reason: '需要实现' }], inputs: [], writes: ['tests/acceptance/export/**'], acceptance: ['验收'], verify: ['test'] },
    ];
    const { engine } = makeEngine({ ...p, flowId: flow.id }, scripts(p, () => dag), SETTINGS);
    let gateFailedSeen = false;
    await assert.rejects(drive(p, engine, flow.id, async () => {
      await approveStage({ root: p.dir, store: p.store, config: p.config }, flow.id);
    }), (e: Error) => { gateFailedSeen = /S4\/active/.test(e.message) && /闸门命令 e2e 失败/.test(e.message); return true; });
    assert.ok(gateFailedSeen, '回归闸门 e2e 失败，流程停在 S4');
    await assert.rejects(approveStage({ root: p.dir, store: p.store, config: p.config }, flow.id), /没有等待批准的闸门/);
    const ev = p.store.readEvents().filter((e) => e.type === 'note' && e.reason === 'stage evidence' && e.data?.['stage'] === 'S4').map((e) => path.basename(e.evidence!));
    assert.deepEqual(ev.sort(), ['gate-e2e.log', 'gate-test.log']);
    // 修复命令后重跑闸门
    (p.config.raw.commands as Record<string, string>)['e2e'] = 'true';
    await engine.rerunGate(flow.id);
    assert.equal(p.store.readFlow(flow.id).stage_status, 'awaiting_human');
    await approveStage({ root: p.dir, store: p.store, config: p.config }, flow.id);
    assert.equal(p.store.readState().active_flow, null);
    assert.ok(!p.store.listTasks(flow.id).some((t) => t.stage === 'S2'));
    assert.match(p.git('log', '--format=%s', 'main'), /^pi-flow: 合入 F-002 订单导出$/m);
  } finally { p.cleanup(); }
});

test('同一时间只允许一个进行中的 build 或 feature 流程', async () => {
  const p = await setupProject({ yaml: ALL_TRUE });
  try {
    await assert.rejects(startFlow({ root: p.dir, store: p.store, config: p.config }, 'feature', 'x'), /进行中.*\/flow resume/);
  } finally { p.cleanup(); }
});
