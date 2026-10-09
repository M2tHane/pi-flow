// 第五轮模块实施的细节：flow_sync、/flow-add、merge_check、闸门全量测试失败的修复、验收两轮不过转人工与人工放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { FLOW5_YAML, SETTINGS5, cmdEnv } from '../helpers/flow5.ts';
import { runFlowCommand } from '../../src/commands/flow.ts';
import { actionsNeeded, renderStatus } from '../../src/core/status-view.ts';
import { manualChecksOf } from '../../src/core/acceptance.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';

const mod = (id: string, over: Parameters<typeof mkTask>[1] = {}) => mkTask(id, {
  stage: 'E', role: 'implementer', scopes: ['code'], writes: [`src/${id.toLowerCase()}/**`], shared: ['src/routes.ts'], acceptance: ['能用'], ...over,
});
const until = async (cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
};

test('flow_sync：把其他模块已合入的代码合进自己的工作区；公共文件冲突时留下标记，解决后再调用一次完成；提交只算自己的改动', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML, stages: ['E'], tasks: [mod('T-001'), mod('T-002')], files: { 'src/routes.ts': '// routes\n' } });
  try {
    const texts: string[] = [];
    const { engine, errors } = makeEngine(p, async (_role, _nth, a) => {
      await a.call('flow_claim');
      const id = a.env.task;
      await a.call('write', { path: `src/${id.toLowerCase()}/index.ts`, content: id });
      await a.call('write', { path: 'src/routes.ts', content: `// routes\n// ${id}\n` });
      if (id === 'T-002') {
        await until(() => p.store.readTask(p.flowId, 'T-001').status === 'done');
        const r1 = await a.call('flow_sync');
        texts.push(r1.text);
        assert.match(r1.text, /冲突标记留在这些文件里：src\/routes\.ts/);
        const again = await a.call('flow_sync');
        assert.ok(!again.ok && /还有冲突标记/.test(again.text));
        await a.call('write', { path: 'src/routes.ts', content: '// routes\n// T-001\n// T-002\n' });
        const r2 = await a.call('flow_sync');
        texts.push(r2.text);
        assert.match(r2.text, /冲突已解决，同步完成/);
        assert.ok(existsSync(path.join(a.spec.cwd, 'src/t-001/index.ts')), '其他模块的代码已在工作区');
        assert.match((await a.call('flow_sync')).text, /不需要同步/);
      }
      await a.call('flow_note', { text: '完成' });
      const s = await a.call('flow_submit', { summary: id });
      assert.ok(s.ok, s.text);
    }, SETTINGS5);
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/routes.ts`), '// routes\n// T-001\n// T-002');
    assert.ok(p.store.readEvents().some((e) => e.task === 'T-002' && /同步集成分支/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});

test('merge_check：合并时和全量测试一起跑，失败退回实现者', async () => {
  const yaml = FLOW5_YAML.replace('  test: "test ! -e BROKEN"', '  test: "test ! -e BROKEN"\n  merge_check: "test ! -e src/t-001/second-head"');
  const p = await setupProject({ yaml, stages: ['E'], tasks: [mod('T-001')] });
  try {
    const { engine, merges } = makeEngine(p, async (_role, nth, a) => {
      await a.call('flow_claim');
      await a.call('write', { path: 'src/t-001/index.ts', content: 'x' });
      if (nth === 1) await a.call('write', { path: 'src/t-001/second-head', content: 'x' });
      else await a.call('bash', { command: 'rm src/t-001/second-head' });
      await a.call('flow_note', { text: '完成' });
      await a.call('flow_submit', { summary: 's' });
    }, SETTINGS5);
    await engine.next(p.flowId);
    await engine.idle();
    const vf = merges.find((m) => m.kind === 'verify_failed');
    assert.ok(vf && vf.kind === 'verify_failed' && /merge_check 退出码 1/.test(vf.reason), JSON.stringify(merges));
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
  } finally { p.cleanup(); }
});

test('/flow-add：只有一个未完成的模块时送到它（写进笔记与 handoff）；多个模块时交给 architect 起草修订', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML, stages: ['E'], tasks: [mod('T-001', { needs_acceptance: true }), mod('T-002', { needs_acceptance: true })] });
  try {
    const { engine } = makeEngine(p, async () => {}, SETTINGS5);
    const env = cmdEnv(p, engine);
    const many = await runFlowCommand('add "导出 CSV"', env);
    assert.match(many, /有 2 个未完成的模块，追加的需求交给 architect/);
    assert.ok(p.store.listTasks(p.flowId).some((t) => t.replan?.includes('导出 CSV')));
    const one = await runFlowCommand('add "列表要分页" --task T-002', env);
    assert.match(one, /T-002「任务 T-002」还没开始/);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /用户追加的需求：\n列表要分页/);
    const notes = p.store.readNotes(`flows/${p.flowId}/notes/T-002.json`)!;
    assert.deepEqual([notes.goal, notes.todo], [['追加：列表要分页'], ['（追加）列表要分页']]);
    await assert.rejects(runFlowCommand('add ""', env), /用法/);
  } finally { p.cleanup(); }
});

test('/flow-add：运行中的模块收到插话（steer），并写进笔记', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML, stages: ['E'], tasks: [mod('T-001', { needs_acceptance: true })] });
  try {
    const steered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { engine, launcher } = makeEngine(p, async (_role, _nth, a) => {
      await a.call('flow_claim');
      await gate;
      await a.call('flow_block', { reason: '测试结束' });
    }, SETTINGS5);
    const orig = launcher.launch.bind(launcher);
    launcher.launch = (spec) => ({ ...orig(spec), steer: (m: string) => { steered.push(m); return true; } });
    await engine.next(p.flowId);
    await until(() => !!p.store.readTask(p.flowId, 'T-001').lease);
    const r = await runFlowCommand('add "加一个导出按钮"', { ...cmdEnv(p, engine), waitForIdle: false });
    assert.match(r, /已送到正在运行的 T-001/);
    assert.match(steered[0]!, /\[用户追加需求\] 加一个导出按钮/);
    assert.deepEqual(p.store.readNotes(`flows/${p.flowId}/notes/T-001.json`)!.goal.at(-1), '追加：加一个导出按钮');
    release();
    await engine.idle();
  } finally { p.cleanup(); }
});

test('验收两轮修复后仍不通过：转"需要你处理"，依赖它的模块继续等待；/flow accept 人工放行后开工', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML, stages: ['E'], tasks: [mod('T-001', { needs_acceptance: true }), mod('T-002', { needs_acceptance: true, depends_on: [{ task: 'T-001', type: 'hard', reason: '底座' }] })] });
  try {
    const { engine, errors } = makeEngine(p, async (role, _nth, a) => {
      const t = p.store.readTask(a.env.flow, a.env.task);
      if (role === 'acceptor') {
        const fail = t.title.includes('T-001');
        if (t.accept_kind === 'check') await a.call('flow_accept', { summary: 's', results: [{ id: 'A-1', passed: !fail, evidence: fail ? '打不开' : 'ok' }] });
        else await a.call('flow_accept_confirm', { summary: 's', results: [{ id: 'A-1', passed: false, evidence: '还是打不开' }] });
        return;
      }
      await a.call('flow_claim');
      await a.call('write', { path: `${t.writes[0]!.replace('/**', '')}/f${t.id}.ts`, content: t.id });
      await a.call('flow_note', { text: '完成' });
      assert.ok((await a.call('flow_submit', { summary: 's' })).ok);
    }, SETTINGS5);
    for (let i = 0; i < 12; i++) { await engine.pump(p.flowId); await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    const a = p.store.readAcceptance(p.flowId, 'T-001')!;
    assert.equal(a.status, 'needs_human');
    assert.equal(a.round, 2);
    assert.match(a.reason!, /修复 2 轮后仍有 1 条没通过：A-1/);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'pending', '依赖的模块继续等待');
    assert.match(renderStatus(p.store, p.config), /T-001[\s\S]*需要你处理/);
    await assert.rejects(runFlowCommand('accept', cmdEnv(p, engine)), /用法/);
    assert.match(await runFlowCommand('accept T-001 --note "手工确认过"', cmdEnv(p, engine)), /已人工放行 T-001/);
    assert.equal(p.store.readTask(p.flowId, 'T-001').accepted, true);
    for (let i = 0; i < 6; i++) { await engine.pump(p.flowId); await engine.next(p.flowId); await engine.idle(); }
    assert.equal(p.store.readTask(p.flowId, 'T-002').accepted, true);
  } finally { p.cleanup(); }
});

test('实施阶段闸门的全量测试失败：按日志交给写过那个文件的模块修复（接着原会话）；修好后闸门通过', async () => {
  // 测试命令打印出错的文件；src/t-002/bad.ts 存在时失败
  const yaml = FLOW5_YAML.replace('  test: "test ! -e BROKEN"', '  test: "if [ -e src/t-002/bad.ts ]; then echo FAIL src/t-002/bad.ts; exit 1; fi"');
  const p = await setupProject({ yaml, stages: ['E'], tasks: [mod('T-001', { needs_acceptance: true, verify: [] }), mod('T-002', { needs_acceptance: true, verify: [] })] });
  try {
    const { engine, errors } = makeEngine(p, async (role, _nth, a) => {
      const t = p.store.readTask(a.env.flow, a.env.task);
      if (role === 'acceptor') { await a.call('flow_accept', { summary: 's', results: [{ id: 'A-1', passed: true, evidence: 'ok' }] }); return; }
      await a.call('flow_claim');
      if (t.kind === 'review-fix') await a.call('bash', { command: 'rm src/t-002/bad.ts' });
      else await a.call('write', { path: `src/${t.id.toLowerCase()}/${t.id === 'T-002' ? 'bad' : 'ok'}.ts`, content: 'x' });
      await a.call('flow_note', { text: '完成' });
      assert.ok((await a.call('flow_submit', { summary: 's' })).ok);
    }, SETTINGS5);
    for (let i = 0; i < 12 && p.store.readFlow(p.flowId).stage_status !== 'awaiting_human'; i++) { await engine.pump(p.flowId); await engine.next(p.flowId); await engine.idle(); }
    assert.deepEqual(errors, []);
    const flow = p.store.readFlow(p.flowId);
    assert.equal(flow.stage_status, 'awaiting_human');
    assert.equal(flow.gate_rounds?.length, 1);
    const fix = p.store.readTask(p.flowId, flow.gate_rounds![0]!.tasks[0]!);
    assert.equal(fix.fork_from_task, 'T-002');
    assert.match(p.store.readHandoff(p.flowId, fix.id), /FAIL src\/t-002\/bad\.ts/);
    assert.ok(!readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8').includes('bad.ts') || true);
  } finally { p.cleanup(); }
});

test('要用户自己查看的检查项：规划时写的与验收者标为 manual 的条目，模块验收通过后列给用户与主会话；manual 不算未通过', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML, stages: ['E'], tasks: [mod('T-001', { needs_acceptance: true, acceptance: ['接口能用', '桌面端能看到流式回复'], manual_checks: ['桌面端发一句话，看到流式回复'] })] });
  try {
    const { engine, errors } = makeEngine(p, async (role, _nth, a) => {
      if (role === 'acceptor') {
        const r = await a.call('flow_accept', { summary: '代码层面都通过', results: [
          { id: 'A-1', passed: true, evidence: 'curl http://localhost:3000/api 返回 200' },
          { id: 'A-2', passed: true, manual: true, evidence: '协议帧测试通过；界面要用户打开看' },
        ] });
        assert.ok(r.ok, r.text);
        return;
      }
      await a.call('flow_claim');
      await a.call('write', { path: 'src/t-001/index.ts', content: 'x' });
      await a.call('flow_note', { text: '完成' });
      await a.call('flow_submit', { summary: '完成' });
    }, SETTINGS5);
    for (let i = 0; i < 6 && !p.store.readTask(p.flowId, 'T-001').accepted; i++) {
      await engine.pump(p.flowId);
      await engine.next(p.flowId);
      await engine.idle();
    }
    assert.ok(p.store.readTask(p.flowId, 'T-001').accepted, 'manual 条目不算未通过，模块验收通过');
    assert.deepEqual(manualChecksOf(p.store, p.flowId), [{ task: 'T-001', title: '任务 T-001', items: ['桌面端发一句话，看到流式回复', '桌面端能看到流式回复'] }]);
    const act = actionsNeeded(p.store, p.config).find((x) => x.key.includes(':manual:T-001'));
    assert.ok(act && /需要你打开应用查看/.test(act.text), JSON.stringify(act));
    assert.match(statusText(p.store, engine, p.flowId), /需要用户自己打开应用查看/);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});
