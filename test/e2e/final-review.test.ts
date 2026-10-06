// 最终代码审查（第五轮，可选 review.final）：所有模块验收通过后一个审查者审查整个流程的改动；必须改自动交给模块修复（一轮），
// 建议由用户 /flow review fix 挑选，之后执行阶段闸门。
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { startFlow } from '../../src/core/stages.ts';
import { runFlowCommand } from '../../src/commands/flow.ts';
import { FLOW5_YAML, SETTINGS5, cmdEnv } from '../helpers/flow5.ts';
import { flowRequirements } from '../../src/tools/orchestrator-tools.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';

const MODULES = [
  { id: 'M-1', title: '待办', writes: ['src/todo/**'], acceptance: ['可以新增待办'] },
  { id: 'M-2', title: '标签', writes: ['src/tag/**'], acceptance: ['可以新增标签'] },
];

test('最终代码审查：模块都验收后审查整个流程的改动；必须改交给负责的模块（接着原会话）修一轮，建议由用户挑选，之后执行闸门', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML.replace('final: false', 'final: true') });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '做一个待办应用');
    const reviewerPrompts: string[] = [];
    const { engine, errors } = makeEngine({ ...p, flowId: flow.id }, async (role, _n, a) => {
      const t = p.store.readTask(a.env.flow, a.env.task);
      if (role === 'acceptor') {
        assert.ok((await a.call('flow_accept', { summary: 'ok', results: [{ id: 'A-1', passed: true, evidence: '跑过' }] })).ok);
        return;
      }
      if (role === 'reviewer') {
        reviewerPrompts.push(a.spec.prompt, a.spec.appendSystemPromptFiles.map((f) => readFileSync(f, 'utf8')).join('\n'));
        assert.match((await a.call('flow_submit', { summary: 'x' })).text, /未启用/, '审查者只能用 flow_review_report 提交');
        const f = (id: string, level: string, file: string) => ({ id, level, basis: 'rules/project.md 第 1 条', files: [file], location: 'index.ts', problem: `问题 ${id}`, expected: `改法 ${id}` });
        const outside = await a.call('flow_review_report', { summary: 's', findings: [f('R-1', 'must', 'README.md')] });
        assert.ok(!outside.ok && /不在审查范围的改动里：README\.md/.test(outside.text), outside.text);
        const r = await a.call('flow_review_report', { summary: '整体不错', findings: [f('R-1', 'must', 'src/todo/index.ts'), f('R-2', 'suggest', 'src/tag/index.ts'), f('R-3', 'suggest', 'src/todo/index.ts')] });
        assert.ok(r.ok, r.text);
        return;
      }
      assert.ok((await a.call('flow_claim')).ok);
      if (role === 'architect') {
        await a.call('write', { path: 'docs/modules.md', content: '# 模块\n' });
        await a.call('write', { path: 'docs/rules-draft/project.md', content: '# 项目规则\n' });
        assert.ok((await a.call('flow_propose_modules', { modules: MODULES })).ok);
      } else if (role === 'implementer') {
        const dir = t.writes[0]!.replace('/**', '');
        await a.call('write', { path: `${dir}/index.ts`, content: `// ${t.title}\n` });
      }
      await a.call('flow_note', { text: '完成' });
      assert.ok((await a.call('flow_submit', { summary: t.title })).ok);
    }, SETTINGS5, undefined, { packageSkillsDir: path.join(import.meta.dirname, '../../skills') });
    const env = cmdEnv(p, engine);
    const run = async () => { for (let i = 0; i < 10; i++) { await engine.pump(flow.id); await engine.next(flow.id); await engine.idle(); } };

    await flowRequirements(p.dir, p.store, engine, { content: '# 需求\n无界面\n', prototype: false });
    await runFlowCommand('approve', env);
    await run();
    await runFlowCommand('approve', env);
    await run();
    // 审查完成：必须改的 R-1 交给待办模块（接着原会话）修一轮；建议等用户挑选，闸门还没执行
    const r1 = p.store.readFinalReview(flow.id)!;
    assert.equal(r1.status, 'awaiting_user');
    assert.deepEqual(r1.fixed, ['R-1']);
    const todo = p.store.listTasks(flow.id).find((t) => t.title === '待办')!;
    const fix1 = p.store.readTask(flow.id, r1.fix_tasks[0]!);
    assert.equal(fix1.fork_from_task, todo.id);
    assert.equal(fix1.status, 'done');
    assert.match(fix1.acceptance[0]!, /^R-1【必须改】src\/todo\/index\.ts/);
    assert.match(reviewerPrompts[0]!, /git diff [0-9a-f]{12} [0-9a-f]{12}/);
    assert.match(reviewerPrompts[1]!, /rules\/global\.md[\s\S]*坏味道基线/, '注入技能 code-review 与项目规则');
    assert.equal(p.store.readFlow(flow.id).stage_status, 'active');
    assert.match(p.git('show', `${flow.integration_branch}:docs/review/final.md`), /## 必须改（1）[\s\S]*R-1[\s\S]*## 建议（2）/);
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'none');
    assert.match(step.next, /还有 2 条没修[\s\S]*\/flow review fix/);
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /最终代码审查还有 2 条没修（R-2、R-3）/.test(x.text)));
    assert.match(await runFlowCommand('review', env), /等你挑选[\s\S]*R-1.*（已修复）/);

    await assert.rejects(runFlowCommand('review fix R-1', env), /已经修过/);
    await assert.rejects(runFlowCommand('review fix R-9', env), /没有这些条目：R-9/);
    assert.match(await runFlowCommand('review fix r-2', env), /已把 R-2 交给负责的模块修复/);
    await run();
    // 用户挑过之后修完直接结束（R-3 不修），执行闸门，等用户批准合入
    const r2 = p.store.readFinalReview(flow.id)!;
    assert.equal(r2.status, 'done');
    assert.deepEqual(r2.fixed, ['R-1', 'R-2']);
    const fix2 = p.store.readTask(flow.id, r2.fix_tasks[1]!);
    assert.equal(fix2.fork_from_task, p.store.listTasks(flow.id).find((t) => t.title === '标签')!.id);
    assert.equal(p.store.readFlow(flow.id).stage_status, 'awaiting_human');
    await runFlowCommand('approve --yes', env);
    assert.equal(p.store.readState().active_flow, null);
    assert.deepEqual(errors, []);
  } finally { p.cleanup(); }
});

test('最终代码审查默认关闭：模块验收通过后直接执行闸门；/flow review 提示怎么开启', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  try {
    assert.equal(p.config.raw.review?.final, false);
    const { engine } = makeEngine(p, async () => {}, SETTINGS5);
    assert.match(await runFlowCommand('review', cmdEnv(p, engine)), /没有开启.*review\.final: true/);
  } finally { p.cleanup(); }
});
