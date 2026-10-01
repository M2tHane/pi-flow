import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { initProject, formatInit } from '../../src/core/init.ts';
import { preflight } from '../../src/core/preflight.ts';
import { doctor } from '../../src/core/doctor.ts';
import { StateStore } from '../../src/core/state-store.ts';
import { nextStep, turnContext, dirtyFiles, newDrift } from '../../src/core/context-injector.ts';
import { acquireEngineLock, releaseEngineLock, readEngineLock } from '../../src/core/engine-lock.ts';
import { worktreesRoot } from '../../src/core/worktree.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const PKG = path.join(import.meta.dirname, '../..');

test('/flow init：生成骨架、.gitignore、.flow 与初始提交；重复执行不覆盖、只补缺并报告差异', async () => {
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, '.gitignore'), 'node_modules/');
    const first = await initProject(r.dir, PKG);
    for (const f of ['workflow.yaml', 'AGENTS.md', 'rules/global.md', 'rules/backend.md', 'docs/PRD.md', 'docs/contracts/.gitkeep', '.flow/state.json']) {
      assert.ok(existsSync(path.join(r.dir, f)), f);
    }
    assert.match(readFileSync(path.join(r.dir, 'workflow.yaml'), 'utf8'), new RegExp(`^project: ${path.basename(r.dir)}$`, 'm'));
    assert.equal(readFileSync(path.join(r.dir, '.gitignore'), 'utf8'), 'node_modules/\n\n# pi-flow\n.codegraph/\n');
    assert.ok(first.commit);
    assert.equal(r.git('status', '--porcelain', '--', '.', ':(exclude).gitignore'), '', '骨架已提交');
    assert.match(r.git('log', '--format=%s'), /pi-flow: 初始化项目骨架/);
    assert.match(formatInit(first), /新建/);

    // 用户改了一条规则、删了 PRD
    writeFileSync(path.join(r.dir, 'rules/backend.md'), '# 我自己的规则\n');
    rmSync(path.join(r.dir, 'docs/PRD.md'));
    const eventsBefore = readFileSync(path.join(r.dir, '.flow/events.jsonl'), 'utf8');
    const second = await initProject(r.dir, PKG);
    assert.deepEqual(second.created, ['docs/PRD.md']);
    assert.ok(second.differs.includes('rules/backend.md'));
    assert.equal(readFileSync(path.join(r.dir, 'rules/backend.md'), 'utf8'), '# 我自己的规则\n', '不覆盖');
    assert.equal(readFileSync(path.join(r.dir, '.flow/events.jsonl'), 'utf8'), eventsBefore, '.flow 不重复初始化');
    assert.equal((readFileSync(path.join(r.dir, '.gitignore'), 'utf8').match(/\.codegraph/g) ?? []).length, 1);
    const third = await initProject(r.dir, PKG);
    assert.deepEqual(third.created, []);
    assert.equal(third.commit, null);
  } finally { r.cleanup(); }
});

test('/flow init 在非 git 目录与子目录中报错', async () => {
  const r = tmpRepo();
  try {
    mkdirSync(path.join(r.dir, 'sub'));
    await assert.rejects(initProject(path.join(r.dir, 'sub'), PKG), /仓库根目录/);
    rmSync(path.join(r.dir, '.git'), { recursive: true });
    await assert.rejects(initProject(r.dir, PKG), /git init/);
  } finally { r.cleanup(); }
});

test('preflight：报告缺失的规则、未设置模型的角色与 workflow 错误', async () => {
  const p = await setupProject();
  try {
    const items = preflight({ root: p.dir, roleSettings: { version: 1, roles: { reviewer: { model: 'x/y' } } }, availableModels: ['a/b'] });
    const get = (k: string) => items.find((i) => i.item === k)!;
    assert.equal(get('git').level, 'ok');
    assert.equal(get('workflow.yaml').level, 'ok');
    assert.equal(get('主分支').level, 'ok');
    assert.equal(get('规则文件').level, 'warn');
    assert.match(get('规则文件').detail, /database\.md/);
    assert.match(get('角色模型').detail, /reviewer 的模型 x\/y 当前不可用/);
    writeFileSync(path.join(p.dir, 'workflow.yaml'), 'version: 2\n');
    assert.equal(preflight({ root: p.dir }).find((i) => i.item === 'workflow.yaml')!.level, 'error');
  } finally { p.cleanup(); }
});

test('/flow doctor：发现队列不一致、未引用的 worktree；--fix 只做安全清理', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const clean = await doctor(p.dir, p.store);
    assert.deepEqual(clean.errors, []);
    mkdirSync(worktreesRoot(p.dir), { recursive: true });
    p.git('worktree', 'add', '-q', '-b', 'stray', path.join(worktreesRoot(p.dir), 'stray'));
    mkdirSync(path.join(worktreesRoot(p.dir), '.runs', 'r-gone'), { recursive: true });
    const r = await doctor(p.dir, p.store);
    assert.ok(r.warnings.some((w) => w.includes('未被任何任务引用的 worktree')), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => w.includes('提示文件可清理')));
    const fixed = await doctor(p.dir, p.store, { fix: true });
    assert.equal(fixed.fixed.length, 2);
    assert.ok(!existsSync(path.join(worktreesRoot(p.dir), 'stray')));
    // 篡改后报告完整性错误
    const f = path.join(p.dir, `.flow/flows/${p.flowId}/tasks/T-001.json`);
    writeFileSync(f, readFileSync(f, 'utf8').replace('"pending"', '"queued_merge"'));
    const bad = await doctor(p.dir, new StateStore(p.dir));
    assert.ok(bad.errors.some((e) => e.includes('完整性')));
    assert.ok(bad.errors.some((e) => e.includes('不在合并队列中')));
  } finally { p.cleanup(); }
});

test('唯一允许的下一步：dispatch → wait → 报告阻塞；闸门等待人工', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] })] });
  try {
    let s = nextStep(p.store, 2);
    assert.equal(s.tool, 'flow_dispatch');
    assert.equal(s.task, 'T-001');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 's' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'd', patch: {
      lease: { run_id: 'r', role: 'backend-engineer', token_hash: 'a'.repeat(64), acquired_at: 'x', expires_at: '2999-01-01T00:00:00Z' },
      worktree: '/w', branch: 'b', base_sha: 'c' } });
    s = nextStep(p.store, 2);
    assert.equal(s.tool, 'flow_wait');
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'blocked', trigger: 'block', actor: 'x', facts: { reason: '需求有歧义' } });
    s = nextStep(p.store, 2);
    assert.equal(s.tool, 'none');
    assert.match(s.next, /T-001（需求有歧义）.*\/flow unblock/);
    assert.match(turnContext(p.store, 2), /^\[pi-flow 状态\][\s\S]*\[唯一允许的下一步\]/);
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    assert.match(nextStep(p.store, 2).next, /\/flow approve/);
  } finally { p.cleanup(); }
});

test('主工作区越权检测：只报告本轮新出现的改动，忽略 .flow/', async () => {
  const p = await setupProject();
  try {
    writeFileSync(path.join(p.dir, 'user-edit.ts'), 'x');
    const before = dirtyFiles(p.dir);
    writeFileSync(path.join(p.dir, 'agent-edit.ts'), 'x');
    writeFileSync(path.join(p.dir, '.flow', 'scratch'), 'x');
    assert.deepEqual(newDrift(before, dirtyFiles(p.dir)), ['agent-edit.ts']);
  } finally { p.cleanup(); }
});

test('引擎锁：另一个存活进程持有时拒绝；持有者退出后可接管', async () => {
  const p = await setupProject();
  try {
    assert.equal(acquireEngineLock(p.dir, 999_999_1), null);
    assert.equal(acquireEngineLock(p.dir), null, '持有者进程不存在时接管');
    assert.equal(readEngineLock(p.dir)!.pid, process.pid);
    const holder = acquireEngineLock(p.dir, 1);
    assert.equal(holder?.pid, process.pid);
    releaseEngineLock(p.dir);
    assert.equal(readEngineLock(p.dir), null);
  } finally { p.cleanup(); }
});
