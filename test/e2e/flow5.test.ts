// 第五轮新流程（fake-subagent 驱动）：需求讨论 → 原型 → 模块规划（含项目专属规则）→ 按模块实施、合并、独立验收 → 合入主分支。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { startFlow } from '../../src/core/stages.ts';
import { runFlowCommand } from '../../src/commands/flow.ts';
import { FLOW5_YAML, SETTINGS5, cmdEnv } from '../helpers/flow5.ts';
import { renderStatus } from '../../src/core/status-view.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';

const MODULES = [
  { id: 'M-1', title: '底座：项目骨架与公共组件', writes: ['src/base/**'], shared: ['src/routes.ts'], acceptance: ['服务能启动', '首页能打开'] },
  { id: 'M-2', title: '待办：增删改查', writes: ['src/todo/**'], shared: ['src/routes.ts'], acceptance: ['可以新增待办'], depends_on: [{ module: 'M-1', reason: '需要底座' }] },
  { id: 'M-3', title: '标签：给待办打标签', writes: ['src/tag/**'], shared: ['src/routes.ts'], acceptance: ['可以新增标签'], depends_on: [{ module: 'M-1', reason: '需要底座' }] },
];

async function drive(p: Project, engine: ReturnType<typeof makeEngine>['engine'], flowId: string, onHuman: (stage: string) => Promise<void>) {
  for (let i = 0; i < 80; i++) {
    if (!p.store.readState().active_flow) return;
    const f = p.store.readFlow(flowId);
    if (f.stage_status === 'awaiting_human') { await onHuman(f.stage); continue; }
    const sig = () => `${p.store.readFlow(flowId).version}|${p.store.listTasks(flowId).map((t) => `${t.id}:${t.status}:${t.accepted ?? ''}`).join(',')}`;
    const before = sig();
    await engine.pump(flowId);
    await engine.next(flowId);
    await engine.idle();
    if (sig() === before) throw new Error(`流程停在 ${f.stage}/${f.stage_status}：\n${statusText(p.store, null, flowId)}`);
  }
  throw new Error('流程未在预期步数内结束');
}

test('第五轮全流程：两方意见并行 → 汇总（打回后接着改）→ 原型 → 模块规划与项目规则 → 底座先行、两个模块并行 → 验收不通过交回修复再复查 → 合入主分支', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个待办应用');
    assert.deepEqual(flow.stages, ['D0', 'D1', 'D2', 'E']);
    const prompts: Record<string, string[]> = {};
    let acceptRound = 0;
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
      if (role === 'user-advocate' || role === 'dev-advocate') {
        const early = await a.call('flow_submit', { summary: 'x' });
        assert.ok(!early.ok && /先用 flow_note 写下/.test(early.text));
        await a.call('flow_note', { text: role === 'user-advocate' ? '用户视角：待办要能打标签' : '开发视角：建议用 SQLite' });
        assert.ok((await a.call('flow_submit', { summary: '意见' })).ok);
        return;
      }
      if (role === 'analyst') {
        await a.call('write', { path: 'docs/requirements.md', content: `# 需求说明（${t.id}）\n风格：蓝白简约\n` });
      } else if (role === 'designer') {
        await a.call('write', { path: 'prototype/index.html', content: '<html>原型</html>' });
      } else if (role === 'architect') {
        await a.call('write', { path: 'docs/modules.md', content: '# 模块\n' });
        await a.call('write', { path: 'docs/rules-draft/project.md', content: '# 项目规则\n- 用 SQLite\n' });
        const bad = await a.call('flow_propose_modules', { modules: [{ id: 'M-1', title: 'x', writes: ['**'], acceptance: ['a'] }] });
        assert.ok(!bad.ok && /不合法/.test(bad.text), bad.text);
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
      const s = await a.call('flow_submit', { summary: t.title, ...(role === 'analyst' ? { prototype: true } : {}) });
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
        // 两方意见并行，汇总者在它们之后；打回后只生成汇总者的修订任务
        const d0 = p.store.listTasks(flow.id).filter((x) => x.stage === 'D0');
        assert.deepEqual(d0.map((x) => x.role), ['user-advocate', 'dev-advocate', 'analyst']);
        assert.match(prompts['analyst']![0]!, /用户视角：待办要能打标签[\s\S]*开发视角：建议用 SQLite/);
        assert.match(await runFlowCommand('reject "补充：标签要有颜色"', env), /生成修订任务/);
        const rev = p.store.listTasks(flow.id).at(-1)!;
        assert.equal(rev.role, 'analyst');
        assert.equal(rev.fork_from_task, d0[2]!.id);
        assert.match(p.store.readHandoff(flow.id, rev.id), /标签要有颜色/);
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
      await runFlowCommand(stage === 'E' ? 'approve --yes' : 'approve', env);
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

test('需求阶段：汇总者判断没有界面时跳过原型阶段；用户批准时可以用 --prototype 改回来', async () => {
  for (const flag of ['', '--prototype']) {
    const p = await setupProject({ yaml: FLOW5_YAML });
    try {
      await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
      const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个命令行工具');
      const { engine } = makeEngine({ ...p, flowId: flow.id }, async (role, _n, a) => {
        await a.call('flow_claim');
        if (role === 'analyst') await a.call('write', { path: 'docs/requirements.md', content: '# 需求\n风格：无界面\n' });
        await a.call('flow_note', { text: '意见' });
        assert.ok((await a.call('flow_submit', { summary: 's', ...(role === 'analyst' ? { prototype: false } : {}) })).ok);
      }, SETTINGS5);
      for (let i = 0; i < 6 && p.store.readFlow(flow.id).stage_status !== 'awaiting_human'; i++) { await engine.pump(flow.id); await engine.next(flow.id); await engine.idle(); }
      assert.deepEqual(p.store.readFlow(flow.id).skip_stages, ['D1']);
      assert.match(renderStatus(p.store, p.config), /\[需求\] → 原型（跳过） → 规划/);
      await runFlowCommand(`approve ${flag}`.trim(), cmdEnv(p, engine));
      assert.equal(p.store.readFlow(flow.id).stage, flag ? 'D1' : 'D2');
      assert.match(renderStatus(p.store, p.config), flag ? /需求 ✓ → \[原型\] → 规划/ : /需求 ✓ → 原型（跳过） → \[规划\]/);
    } finally { p.cleanup(); }
  }
});
