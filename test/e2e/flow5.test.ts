// 第五轮新流程（fake-subagent 驱动）：需求讨论 → 原型 → 模块规划（含项目专属规则）→ 按模块实施、合并、独立验收 → 合入主分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { startFlow } from '../../src/core/stages.ts';
import { runFlowBuild, runFlowCommand } from '../../src/commands/flow.ts';
import { FLOW5_YAML, SETTINGS5, cmdEnv } from '../helpers/flow5.ts';
import { renderStatus } from '../../src/core/status-view.ts';
import { flowRequirements, statusText } from '../../src/tools/orchestrator-tools.ts';
import { nextStep } from '../../src/core/context-injector.ts';

const MODULES = [
  { id: 'M-1', title: '底座：项目骨架与公共组件', writes: ['src/base/**'], shared: ['src/routes.ts'], acceptance: ['服务能启动', '首页能打开'] },
  { id: 'M-2', title: '待办：增删改查', writes: ['src/todo/**'], shared: ['src/routes.ts'], acceptance: ['可以新增待办'], ui_pages: ['prototype/index.html'], depends_on: [{ module: 'M-1', reason: '需要底座' }] },
  { id: 'M-3', title: '标签：给待办打标签', writes: ['src/tag/**'], shared: ['src/routes.ts'], acceptance: ['可以新增标签'], depends_on: [{ module: 'M-1', reason: '需要底座' }], size: 'S', manual_checks: ['标签颜色看起来清楚'] },
];

/** onRequirements：需求讨论中（主会话和用户讨论）时调用，模拟主会话提交需求说明 */
async function drive(p: Project, engine: ReturnType<typeof makeEngine>['engine'], flowId: string, onHuman: (stage: string) => Promise<void>, onRequirements: () => Promise<void>) {
  for (let i = 0; i < 80; i++) {
    if (!p.store.readState().active_flow) return;
    const f = p.store.readFlow(flowId);
    if (f.stage_status === 'awaiting_human') { await onHuman(f.stage); continue; }
    if (f.stage === 'D0' && f.stage_status === 'active' && !f.requirements?.submitted) { await onRequirements(); continue; }
    const sig = () => `${p.store.readFlow(flowId).version}|${p.store.listTasks(flowId).map((t) => `${t.id}:${t.status}:${t.accepted ?? ''}`).join(',')}`;
    const before = sig();
    await engine.pump(flowId);
    await engine.next(flowId);
    await engine.idle();
    if (sig() === before) throw new Error(`流程停在 ${f.stage}/${f.stage_status}：\n${statusText(p.store, null, flowId)}`);
  }
  throw new Error('流程未在预期步数内结束');
}

test('第五轮全流程：主会话提交需求说明（打回后带着意见再讨论、重新提交）→ 原型 → 模块规划与项目规则 → 底座先行、两个模块并行 → 验收不通过交回修复再复查 → 合入主分支', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个待办应用');
    assert.deepEqual(flow.stages, ['D0', 'D1', 'D2', 'E']);
    const prompts: Record<string, string[]> = {};
    let acceptRound = 0;
    let designerRuns = 0;
    const script = async (role: string, _nth: number, a: FakeAgent) => {
      const t = p.store.readTask(a.env.flow, a.env.task);
      (prompts[role] ??= []).push(a.spec.prompt);
      if (role === 'acceptor') {
        const ids = t.accept_kind === 'check' ? t.acceptance.filter((x) => /^A-\d+ /.test(x)).map((x) => x.split(' ')[0]!) : null;
        if (t.accept_kind === 'check') {
          // 底座第一次验收：A-2（首页）不通过；其他模块全部通过
          const fail = t.title.includes('底座') && acceptRound++ === 0;
          const r = await a.call('flow_accept', { summary: '验收完成', results: ids!.map((id) => ({ id, passed: !(fail && id === 'A-2'), evidence: fail && id === 'A-2' ? 'GET / 返回 404' : 'curl 通过' })) });
          assert.ok(r.ok, r.text);
        } else {
          const extra = await a.call('flow_accept_confirm', { summary: 'x', results: [{ id: 'A-1', passed: true, evidence: 'x' }] });
          assert.ok(!extra.ok && /不在待复查条目中/.test(extra.text), extra.text);
          const r = await a.call('flow_accept_confirm', { summary: '已修好', results: [{ id: 'A-2', passed: true, evidence: 'GET / 返回 200' }] });
          assert.ok(r.ok, r.text);
        }
        return;
      }
      assert.ok((await a.call('flow_claim')).ok);
      if (role === 'designer') {
        await a.call('write', { path: 'prototype/index.html', content: '<html><link href="../docs/design/theme.css">原型</html>' });
        await a.call('write', { path: 'docs/design/theme.css', content: ':root { --color-primary: #1d4ed8; }\n' });
        // 第一次漏写设计规范：原型阶段的检查不通过，designer 接着原会话补上
        if (designerRuns++ > 0) await a.call('write', { path: 'DESIGN.md', content: '# 设计规范\n主色 --color-primary\n' });
      } else if (role === 'architect') {
        await a.call('write', { path: 'docs/modules.md', content: '# 模块\n' });
        await a.call('write', { path: 'docs/rules-draft/project.md', content: '# 项目规则\n- 用 SQLite\n' });
        const bad = await a.call('flow_propose_modules', { modules: [{ id: 'M-1', title: 'x', writes: ['**'], acceptance: ['a'], ui_pages: ['prototype/nope.html'] }] });
        assert.ok(!bad.ok && /不合法/.test(bad.text) && /原型里没有 prototype\/nope\.html/.test(bad.text), bad.text);
        const r = await a.call('flow_propose_modules', { modules: MODULES, assumptions: ['标签不区分大小写'] });
        assert.ok(r.ok, r.text);
      } else if (role === 'implementer' && t.kind === 'merge-fix') {
        // 公共文件的冲突：保留双方的追加
        for (const f of t.conflict_files ?? []) {
          const text = readFileSync(path.join(a.spec.cwd, f), 'utf8').split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n');
          await a.call('write', { path: f, content: text });
        }
      } else if (role === 'implementer') {
        const dir = t.writes[0]!.replace('/**', '');
        await a.call('write', { path: `${dir}/index.ts`, content: `// ${t.title}\n` });
        // 登记的公共文件：并行模块都可以追加
        const routes = path.join(a.spec.cwd, 'src/routes.ts');
        await a.call('write', { path: 'src/routes.ts', content: `${existsSync(routes) ? readFileSync(routes, 'utf8') : ''}// ${t.id}\n` });
        const outside = await a.call('write', { path: 'src/other/x.ts', content: 'x' });
        assert.ok(!outside.ok, '可写范围之外被拦下');
        await a.call('bash', { command: `git add -A && git -c user.name=t -c user.email=t@x commit -q -m "${t.id} 第一步"` });
        await a.call('notes', { action: 'update', ops: [{ section: 'done', op: 'add', text: '第一步' }] });
        if (t.kind === 'review-fix') await a.call('write', { path: `${dir}/home.ts`, content: '// 首页\n' });
      }
      await a.call('flow_note', { text: '完成' });
      const s = await a.call('flow_submit', { summary: t.title });
      assert.ok(s.ok, s.text);
    };
    const { engine, errors } = makeEngine({ ...p, flowId: flow.id }, script, SETTINGS5);
    const seen: string[] = [];
    let rejected = false;
    await drive(p, engine, flow.id, async (stage) => {
      seen.push(stage);
      const env = cmdEnv(p, engine);
      if (stage === 'D0' && !rejected) {
        rejected = true;
        // 需求讨论没有子任务：需求说明由主会话提交到集成分支；打回后带着意见回到讨论
        assert.deepEqual(p.store.listTasks(flow.id).filter((x) => x.stage === 'D0'), []);
        assert.match(p.git('show', `${flow.integration_branch}:docs/requirements.md`), /第 1 版/);
        assert.match(await runFlowCommand('reject "补充：标签要有颜色"', env), /继续和你讨论/);
        const f = p.store.readFlow(flow.id);
        assert.equal(f.stage_status, 'active');
        assert.deepEqual([f.requirements?.submitted, f.requirements?.rounds, f.requirements?.feedback], [false, 1, '补充：标签要有颜色']);
        const step = nextStep(p.store, 3, 0, p.config);
        assert.equal(step.tool, 'flow_requirements');
        assert.match(step.next, /标签要有颜色/);
        assert.deepEqual(p.store.listTasks(flow.id), []);
        return;
      }
      if (stage === 'D2') {
        assert.match(statusText(p.store, null, flow.id), /T-001[\s\S]*底座/);
        const out = await runFlowCommand('approve', env);
        assert.match(out, /已按模块清单创建 3 个模块任务/);
        assert.match(out, /rules\/project\.md/);
        assert.match(readFileSync(path.join(p.dir, 'rules/project.md'), 'utf8'), /用 SQLite/);
        return;
      }
      if (stage === 'D1') {
        await assert.rejects(flowRequirements(p.dir, p.store, engine, { content: '# 改需求', prototype: true }), /需求讨论（D0）已结束/);
        assert.match(p.git('show', `${flow.integration_branch}:docs/requirements.md`), /第 2 版[\s\S]*标签有颜色/);
        const d1 = p.store.listTasks(flow.id).filter((x) => x.stage === 'D1');
        assert.equal(d1.length, 2);
        assert.equal(d1[1]!.fork_from_task, d1[0]!.id);
        assert.match(p.store.readHandoff(flow.id, d1[1]!.id), /原型阶段必须写出 DESIGN\.md/);
        assert.match(p.git('show', `${flow.integration_branch}:DESIGN.md`), /主色/);
      }
      await runFlowCommand(stage === 'E' ? 'approve --yes' : 'approve', env);
    }, async () => {
      // 主会话和用户讨论后提交需求说明：第一次讨论前没有任何任务，主 agent 收到的指引是讨论需求
      const step = nextStep(p.store, 3, 0, p.config);
      assert.equal(step.tool, 'flow_requirements');
      const v = (p.store.readFlow(flow.id).requirements?.rounds ?? 0) + 1;
      const r = await flowRequirements(p.dir, p.store, engine, { content: `# 需求说明（第 ${v} 版）\n风格：蓝白简约\n${v > 1 ? '- 标签有颜色\n' : ''}`, prototype: true });
      assert.match(r.text, /请用户查看后执行 \/flow-approve/);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen, ['D0', 'D0', 'D1', 'D2', 'E']);
    const tasks = p.store.listTasks(flow.id);
    const mods = tasks.filter((t) => t.needs_acceptance);
    assert.equal(mods.length, 3);
    assert.ok(mods.every((t) => t.status === 'done' && t.accepted));
    // 底座验收不通过 → 交回实现者（接着原会话）修复 → 复查通过
    const base = mods.find((t) => t.title.includes('底座'))!;
    const a = p.store.readAcceptance(flow.id, base.id)!;
    assert.equal(a.status, 'accepted');
    assert.equal(a.round, 1);
    // 界面模块：原型页面与设计规范自动加进输入；界面的验收交给用户（不派验收者）
    const todo = mods.find((t) => t.title.startsWith('待办'))!;
    assert.ok(['prototype/index.html', 'DESIGN.md', 'docs/design/theme.css'].every((f) => todo.inputs.includes(f)), todo.inputs.join());
    assert.deepEqual(todo.acceptance, ['可以新增待办']);
    assert.ok(!base.inputs.includes('DESIGN.md'), '没有界面的模块不加设计规范');
    // 界面效果由用户打开查看：界面模块自动加上"按原型实现""遵循设计规范"，规划时写的照常保留；大小随模块记下
    assert.equal(todo.manual_checks?.length, 2);
    assert.match(todo.manual_checks!.join('\n'), /^界面按原型 prototype\/index\.html 实现[\s\S]*\n界面遵循 DESIGN\.md/);
    const tag = mods.find((t) => t.title.startsWith('标签'))!;
    assert.deepEqual(tag.manual_checks, ['标签颜色看起来清楚']);
    assert.equal(tag.size, 'S');
    assert.equal(base.manual_checks, undefined);
    const fix = tasks.find((t) => t.id === a.fix_tasks[0])!;
    assert.equal(fix.kind, 'review-fix');
    assert.equal(fix.fork_from_task, base.id);
    assert.match(fix.acceptance[0]!, /A-2 首页能打开（未通过：GET \/ 返回 404）/);
    // 两个依赖底座的模块在底座验收通过后才开工，并且并行
    const ev = p.store.readEvents().filter((e) => e.type === 'transition' && e.flow === flow.id);
    const acceptedAt = p.store.readEvents().find((e) => e.task === base.id && e.data?.['acceptance'] === 'accepted')!.seq;
    const starts = mods.filter((t) => t.id !== base.id).map((t) => ev.find((e) => e.task === t.id && e.to === 'in_progress')!.seq);
    assert.ok(starts.every((s) => s > acceptedAt), '依赖的模块等底座验收通过才开工');
    const doneAt = mods.filter((t) => t.id !== base.id).map((t) => ev.find((e) => e.task === t.id && e.to === 'queued_merge')!.seq);
    assert.ok(Math.max(...starts) < Math.min(...doneAt), '两个模块同时在做');
    // 笔记：程序预填目标与待完成，实现者更新了已完成
    const notes = p.store.readNotes(`flows/${flow.id}/notes/${base.id}.json`)!;
    assert.deepEqual(notes.todo, ['服务能启动', '首页能打开']);
    assert.ok(notes.done.includes('第一步'));
    // 合入主分支：三个模块与公共文件
    const main = p.git('show', 'main:src/routes.ts');
    for (const m of mods) assert.match(main, new RegExp(`// ${m.id}`));
    assert.match(p.git('show', 'main:src/base/home.ts'), /首页/);
    assert.match(renderStatus(p.store, p.config), /没有进行中的流程|已完成|完成/);
  } finally { p.cleanup(); }
});

test('需求阶段：主会话提交时说明不需要原型就跳过原型阶段；/flow-build --from 直接把需求文档交给用户审批', async () => {
  for (const prototype of [false, true]) {
    const p = await setupProject({ yaml: FLOW5_YAML });
    try {
      await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
      const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个命令行工具');
      const { engine } = makeEngine({ ...p, flowId: flow.id }, async () => {}, SETTINGS5);
      await engine.pump(flow.id);
      await engine.idle();
      assert.equal(p.store.readFlow(flow.id).stage_status, 'active', '没提交需求说明前不执行闸门');
      await assert.rejects(flowRequirements(p.dir, p.store, engine, { content: '   ', prototype }), /不能为空/);
      await flowRequirements(p.dir, p.store, engine, { content: '# 需求\n风格：无界面\n', prototype });
      assert.equal(p.store.readFlow(flow.id).stage_status, 'awaiting_human');
      assert.deepEqual(p.store.readFlow(flow.id).skip_stages ?? [], prototype ? [] : ['D1']);
      if (!prototype) assert.match(renderStatus(p.store, p.config), /\[需求\] → 原型（跳过） → 规划/);
      await runFlowCommand('approve', cmdEnv(p, engine));
      assert.equal(p.store.readFlow(flow.id).stage, prototype ? 'D1' : 'D2');
    } finally { p.cleanup(); }
  }
  const p = await setupProject({ yaml: FLOW5_YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const { engine } = makeEngine(p, async () => {}, SETTINGS5);
    writeFileSync(`${p.dir}.req.md`, '# 记账工具\n- R1 记一笔账\n');
    const out = await runFlowBuild(`--from ${p.dir}.req.md --no-prototype`, cmdEnv(p, engine));
    assert.match(out, /已把需求文档写入 docs\/requirements\.md（不做原型）/);
    const f = p.store.readFlow(p.store.readState().active_flow!);
    assert.equal(f.title, '记账工具');
    assert.equal(f.stage_status, 'awaiting_human');
    assert.deepEqual(f.skip_stages, ['D1']);
    assert.match(p.git('show', `${f.integration_branch}:docs/requirements.md`), /R1 记一笔账/);
  } finally { rmSync(`${p.dir}.req.md`, { force: true }); p.cleanup(); }
});
