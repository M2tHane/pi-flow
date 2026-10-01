import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createTaskWorktree, ensureIntegrationBranch, snapshot, changedFiles, isClean, removeWorktree, worktreesRoot } from '../../src/core/worktree.ts';
import { tmpRepo } from '../helpers/repo.ts';

function setup() {
  const repo = tmpRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const cleanup = () => { rmSync(worktreesRoot(repo.dir), { recursive: true, force: true }); repo.cleanup(); };
  return { ...repo, cleanup };
}

test('从集成分支建 worktree，快照与 diff，复用与清理', () => {
  const { dir, git, cleanup } = setup();
  try {
    const intSha = ensureIntegrationBranch(dir, 'flow/B-001/integration', 'main');
    assert.equal(ensureIntegrationBranch(dir, 'flow/B-001/integration', 'main'), intSha);
    const wt = createTaskWorktree(dir, 'B-001', 'T-001', 'flow/B-001/integration');
    assert.equal(wt.base_sha, intSha);
    assert.equal(wt.branch, 'flow/B-001/T-001');
    assert.ok(wt.path.startsWith(worktreesRoot(dir)));
    assert.ok(!wt.path.startsWith(dir + path.sep), 'worktree 必须在项目目录之外');
    assert.ok(isClean(wt.path));

    mkdirSync(path.join(wt.path, 'src/server'), { recursive: true });
    writeFileSync(path.join(wt.path, 'src/server/a.ts'), 'a');
    writeFileSync(path.join(wt.path, 'README.md'), 'changed');
    assert.ok(!isClean(wt.path));
    assert.ok(snapshot(wt.path, 'wip'));
    assert.equal(snapshot(wt.path, 'wip'), null);
    assert.deepEqual(changedFiles(wt.path, wt.base_sha), ['README.md', 'src/server/a.ts']);
    // 主工作区不受影响
    assert.ok(!existsSync(path.join(dir, 'src/server/a.ts')));

    const again = createTaskWorktree(dir, 'B-001', 'T-001', 'flow/B-001/integration');
    assert.equal(again.path, wt.path);
    assert.equal(again.base_sha, wt.base_sha);

    removeWorktree(dir, wt.path, wt.branch);
    assert.ok(!existsSync(wt.path));
    assert.equal(git('branch', '--list', 'flow/B-001/T-001'), '');
  } finally { cleanup(); }
});
