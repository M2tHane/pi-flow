// 第二轮 F 验收：阶段边界把主分支同步进集成分支；冲突按规则生成 merge-fix 或交给用户；最终合入主分支不再冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setupProject, type Project } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { mergeToMain } from '../../src/core/release.ts';
import { actionsNeeded } from '../../src/core/status-view.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';

/** 用户直接在主分支（主工作区检出）上提交 */
function commitOnMain(p: Project, files: Record<string, string>, msg: string) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(p.dir, rel)), { recursive: true });
    writeFileSync(path.join(p.dir, rel), content);
  }
  p.git('add', '--', ...Object.keys(files));
  p.git('commit', '-q', '-m', msg, '--', ...Object.keys(files));
}

async function twoStageFlow(p: Project) {
  await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
  const base = p.git('rev-parse', 'HEAD');
  const flow = await p.store.createFlow({ mode: 'build', title: '同步演示', stages: ['S3', 'S4'], base_sha: base });
  p.git('branch', flow.integration_branch, base);
  return flow.id;
}

const approve = async (a: FakeAgent) => { assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok); };
async function implement(a: FakeAgent, files: Record<string, string>) {
  assert.ok((await a.call('flow_claim')).ok);
  for (const [f, c] of Object.entries(files)) assert.ok((await a.call('write', { path: f, content: c })).ok, f);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: '完成' });
  assert.ok(r.ok, r.text);
}

const env = (p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv => ({
  root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
  engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
  roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
});

test('阶段边界同步主分支：无冲突直接合入；writes 内冲突生成 merge-fix 解决；最终合入主分支不再冲突', async () => {
  const p = await setupProject();
  try {
    const flowId = await twoStageFlow(p);
    await p.store.addTasks(flowId, [
      mkTask('T-001', { stage: 'S3', verify: ['test'] }),
      mkTask('T-002', { stage: 'S4', verify: [], writes: ['src/server/t-002/**'] }),
    ], 'architect');
    const integ = p.store.readFlow(flowId).integration_branch;
    let mergeFixSaw = '';
    const { engine, errors } = makeEngine({ ...p, flowId }, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      if (a.env.task === 'T-001') {
        // 实施期间用户在主分支上改了两处：一处与本任务无关，一处正是本任务写的文件
        commitOnMain(p, { 'docs/notes.md': '用户的笔记\n', 'src/server/t-001/a.ts': 'main 上的版本\n' }, '用户在 main 上的提交');
        return implement(a, { 'src/server/t-001/a.ts': '集成分支上的版本\n' });
      }
      if (a.env.task === 'T-002') {
        // S4 开工时，主分支的改动已经进入集成分支
        assert.equal(readFileSync(path.join(p.store.readTask(flowId, 'T-002').worktree!, 'docs/notes.md'), 'utf8'), '用户的笔记\n');
        return implement(a, { 'src/server/t-002/a.ts': 'x\n' });
      }
      // merge-fix：工作区是含冲突标记的合并结果
      const t = p.store.readTask(flowId, a.env.task);
      mergeFixSaw = readFileSync(path.join(t.worktree!, 'src/server/t-001/a.ts'), 'utf8');
      return implement(a, { 'src/server/t-001/a.ts': '合并后的版本\n' });
    }, undefined);
    for (let i = 0; i < 10 && p.store.readFlow(flowId).stage_status !== 'awaiting_human'; i++) {
      await engine.pump(flowId);
      await engine.next(flowId);
      await engine.idle();
    }
    assert.deepEqual(errors, []);
    const flow = p.store.readFlow(flowId);
    assert.equal(flow.stage, 'S4');
    assert.equal(flow.stage_status, 'awaiting_human');
    // writes 内的冲突：生成 merge-fix（角色取写过该文件的任务的角色），看到冲突标记
    const fix = p.store.listTasks(flowId).find((t) => t.kind === 'merge-fix')!;
    assert.ok(fix, '应生成同步冲突的 merge-fix');
    assert.equal(fix.role, 'backend-engineer');
    assert.deepEqual(fix.conflict_files, ['src/server/t-001/a.ts']);
    assert.match(mergeFixSaw, /<<<<<<< [\s\S]*集成分支上的版本[\s\S]*=======[\s\S]*main 上的版本/);
    assert.equal(fix.status, 'done');
    assert.equal(flow.sync?.status, 'ok');
    // 集成分支保留了与主分支的合并关系（主分支是祖先），而且没有冲突标记
    const mainSha = p.git('rev-parse', 'main');
    p.git('merge-base', '--is-ancestor', p.store.readFlow(flowId).sync!.main_sha, integ);
    assert.equal(p.git('show', `${integ}:src/server/t-001/a.ts`), '合并后的版本');
    assert.equal(p.git('show', `${integ}:docs/notes.md`), '用户的笔记');
    // 最终合入主分支：不再冲突
    const sha = await mergeToMain(p.dir, p.store, p.config, flowId);
    assert.ok(sha);
    assert.equal(readFileSync(path.join(p.dir, 'src/server/t-001/a.ts'), 'utf8'), '合并后的版本\n');
    assert.ok(mainSha);
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('同步冲突涉及契约：暂停派发新任务，提示用户处理；用户合并后 /flow sync 恢复', async () => {
  const p = await setupProject({ files: { 'docs/contracts/api.md': 'v0\n' } });
  try {
    const flowId = await twoStageFlow(p);
    const integ = p.store.readFlow(flowId).integration_branch;
    await p.store.addTasks(flowId, [mkTask('T-001', { stage: 'S3', verify: [] }), mkTask('T-002', { stage: 'S3', verify: [] })], 'architect');
    const { engine } = makeEngine({ ...p, flowId }, async (role, _n, a) => {
      if (role === 'reviewer') return approve(a);
      return implement(a, { [`src/server/${a.env.task.toLowerCase()}/a.ts`]: 'x\n' });
    });
    // 契约在集成分支与主分支上被各自修改
    const wt = path.join(p.dir, '..', `${path.basename(p.dir)}-integ`);
    p.git('worktree', 'add', '-q', wt, integ);
    writeFileSync(path.join(wt, 'docs/contracts/api.md'), 'integ\n');
    p.git('-C', wt, 'commit', '-q', '-am', '集成分支改契约');
    p.git('worktree', 'remove', '--force', wt);
    commitOnMain(p, { 'docs/contracts/api.md': 'main\n' }, '主分支改契约');

    const e = env({ ...p, flowId }, engine);
    assert.match(await runFlowCommand('sync', e), /同步冲突，需要你处理：冲突涉及契约或受保护文件：docs\/contracts\/api\.md/);
    assert.equal(p.store.readFlow(flowId).sync?.status, 'conflict');
    assert.deepEqual(await engine.next(flowId), [], '冲突未处理前不派发新任务');
    assert.ok(actionsNeeded(p.store, p.config).some((x) => /同步进集成分支时冲突/.test(x.text) && /\/flow sync/.test(x.command)));
    assert.ok(!existsSync(path.join(p.dir, '..', `${path.basename(p.dir)}.worktrees`, `${flowId}-sync`)), '临时 worktree 已清理');

    // 用户手动合并
    p.git('worktree', 'add', '-q', wt, integ);
    try { p.git('-C', wt, 'merge', '-q', 'main'); } catch { /* 预期冲突 */ }
    writeFileSync(path.join(wt, 'docs/contracts/api.md'), 'merged\n');
    p.git('-C', wt, 'add', '-A');
    p.git('-C', wt, 'commit', '-q', '--no-edit');
    p.git('worktree', 'remove', '--force', wt);
    assert.match(await runFlowCommand('sync', e), /已包含 main 的全部提交/);
    assert.equal(p.store.readFlow(flowId).sync?.status, 'ok');
    assert.equal(p.store.listTasks(flowId).filter((t) => t.status === 'done').length, 2, '恢复派发');
  } finally { p.cleanup(); }
});
