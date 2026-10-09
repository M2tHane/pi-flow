// 规则与命令草案：architect 写在 docs/rules-draft/（随文档合入集成分支），用户确认后程序写入 rules/ 与 workflow.yaml。
import { test } from 'node:test';
import { parseConfig } from '../../src/core/config.ts';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';
import { listDrafts } from '../../src/core/rules-draft.ts';
import { startFlow } from '../../src/core/stages.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine, commitToBranch } from '../helpers/engine.ts';
import { TEMPLATE_YAML } from '../helpers/config.ts';
import { FLOW5_YAML } from '../helpers/flow5.ts';

function env(p: Project, engine: ReturnType<typeof makeEngine>['engine'], ui: CommandEnv['ui'] = null): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

const DRAFTS = {
  'docs/rules-draft/backend.md': '# 后端规则\n\n1. 数据库访问统一用 Prisma Client，不写原生 SQL。\n',
  'docs/rules-draft/prisma.md': '# Prisma 规则\n\n1. schema.prisma 只由 db-engineer 修改。\n',
  'docs/rules-draft/commands.yaml': 'commands:\n  test: "npm test"\n  typecheck: "npx tsc --noEmit"\ngui_commands: ["npm run dev:desktop"]\n',
};

test('列出并应用草案：规则替换与新增、命令修改保留注释、提交、运行中的配置同步更新', async () => {
  const p = await setupProject({ yaml: TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    commitToBranch(p.dir, `flow/${p.flowId}/integration`, DRAFTS, '架构师的草案');
    const drafts = listDrafts(p.dir, `flow/${p.flowId}/integration`);
    assert.deepEqual(drafts.map((d) => [d.file, d.target]), [
      ['docs/rules-draft/backend.md', 'rules/backend.md'], ['docs/rules-draft/commands.yaml', 'workflow.yaml'], ['docs/rules-draft/prisma.md', 'rules/prisma.md']]);
    assert.match(drafts[1]!.summary, /test："pnpm test" → "npm test"/);
    assert.match(drafts[1]!.summary, /agent 不能运行（会打开界面）："npm run dev:desktop"/);
    assert.match(drafts[2]!.summary, /新文件/);
    const e = env(p, engine);
    assert.match(await runFlowCommand('rules', e), /规则与命令草案[\s\S]*\/flow rules apply all/);

    const out = await runFlowCommand('rules apply all', e);
    assert.match(out, /已应用：workflow\.yaml、rules\/backend\.md、rules\/prisma\.md，并已提交[\s\S]*缓存会失效一次/);
    assert.match(readFileSync(path.join(p.dir, 'rules/backend.md'), 'utf8'), /Prisma Client/);
    assert.ok(existsSync(path.join(p.dir, 'rules/prisma.md')));
    const wf = readFileSync(path.join(p.dir, 'workflow.yaml'), 'utf8');
    assert.match(wf, /test: "?npm test"?/);
    assert.match(wf, /verify 与闸门只能引用这里定义的命令名/, '保留注释');
    assert.match(wf, /lint: +"pnpm lint"/, '未改的命令不动');
    assert.deepEqual(parseConfig(wf).raw.gui_commands, ['npm run dev:desktop'], '会打开界面的命令写进 gui_commands');
    assert.equal(p.config.commands['test'], 'npm test', '运行中的引擎配置同步更新');
    assert.match(p.git('log', '-1', '--format=%s'), /pi-flow: 应用 B-001 的规则与命令草案/);
    assert.equal(await runFlowCommand('rules', e), '没有待应用的规则或命令草案。');
  } finally { p.cleanup(); }
});

test('不合法的草案被拒绝且不写入任何文件', async () => {
  const p = await setupProject({ yaml: TEMPLATE_YAML });
  try {
    const { engine } = makeEngine(p, async () => {});
    commitToBranch(p.dir, `flow/${p.flowId}/integration`, { 'docs/rules-draft/commands.yaml': 'commands:\n  test: 123\n', 'docs/rules-draft/x.md': 'x' }, '坏草案');
    await assert.rejects(runFlowCommand('rules', env(p, engine)), /test 的命令必须是非空字符串/);
    assert.ok(!existsSync(path.join(p.dir, 'rules/x.md')));
  } finally { p.cleanup(); }
});

test('批准规划阶段（D2）时：架构师写的项目专属规则草案在无界面时自动应用', async () => {
  const p = await setupProject({ yaml: FLOW5_YAML });
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const flow = await startFlow({ root: p.dir, store: p.store, config: p.config }, 'build', '待办');
    const { engine } = makeEngine({ ...p, flowId: flow.id }, async () => {});
    const e = env(p, engine);
    const toGate = async () => {
      await p.store.transitionStage(flow.id, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await p.store.transitionStage(flow.id, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    };
    // 需求、原型两个阶段直接放行，停在规划阶段
    for (const stage of ['D0', 'D1']) {
      assert.equal(p.store.readFlow(flow.id).stage, stage);
      await toGate();
      await p.store.transitionStage(flow.id, { to: 'done', trigger: 'approve', actor: 'human' });
      await p.store.advanceStage(flow.id, 'human');
    }
    assert.equal(p.store.readFlow(flow.id).stage, 'D2');
    await p.store.saveProposal(flow.id, { stage: 'D2', run: 'r', created_at: 'x', tasks: [{ id: 'T-001', stage: 'E', kind: 'impl', title: '待办模块', role: 'implementer', scopes: ['code'], depends_on: [], inputs: [], writes: ['src/todo/**'], acceptance: ['能新建待办'], verify: ['test'], needs_acceptance: true }],
      report: { task_count: 1, critical_path: ['T-001'], critical_path_length: 1, max_width: 1, hard_ratio: 0, warnings: [] } }, 'architect');
    commitToBranch(p.dir, flow.integration_branch, { 'docs/rules-draft/project.md': '# 项目规则\n1. 用 Fastify。\n' }, '草案');
    await toGate();
    const out = await runFlowCommand('approve', e);
    assert.match(out, /已批准阶段 D2[\s\S]*已按模块清单创建 1 个模块任务[\s\S]*架构师提出了规则与命令草案[\s\S]*已应用：rules\/project\.md/);
    assert.match(readFileSync(path.join(p.dir, 'rules/project.md'), 'utf8'), /Fastify/);
    assert.equal(await runFlowCommand('rules', e), '没有待应用的规则或命令草案。');
    await engine.idle();
  } finally { p.cleanup(); }
});
