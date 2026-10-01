// worktree 与任务分支：从集成分支 HEAD 拉出，放在项目目录之外的同级目录。
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { git, gitOk } from './git.ts';

export const worktreesRoot = (mainRoot: string) =>
  path.join(path.dirname(path.resolve(mainRoot)), `${path.basename(path.resolve(mainRoot))}.worktrees`);
export const taskBranch = (flow: string, task: string) => `flow/${flow}/${task}`;
export const worktreePath = (mainRoot: string, flow: string, task: string) => path.join(worktreesRoot(mainRoot), `${flow}-${task}`);

export const headSha = (dir: string, ref = 'HEAD') => git(dir, ['rev-parse', ref]).trim();
export const branchExists = (root: string, branch: string) => gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);

/** 集成分支不存在时从 from（提交或分支）创建；返回其 HEAD。 */
export function ensureIntegrationBranch(root: string, branch: string, from: string): string {
  if (!branchExists(root, branch)) git(root, ['branch', branch, from]);
  return headSha(root, branch);
}

export interface TaskWorktree { path: string; branch: string; base_sha: string }

/** 建立任务 worktree；已存在（例如重新派发）时复用。 */
export function createTaskWorktree(root: string, flow: string, task: string, integrationBranch: string): TaskWorktree {
  const wt = worktreePath(root, flow, task);
  const branch = taskBranch(flow, task);
  if (existsSync(path.join(wt, '.git'))) {
    return { path: wt, branch, base_sha: git(wt, ['merge-base', 'HEAD', integrationBranch]).trim() };
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  const base = headSha(root, integrationBranch);
  if (branchExists(root, branch)) git(root, ['worktree', 'add', '-q', wt, branch]);
  else git(root, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  return { path: wt, branch, base_sha: base };
}

/** 把 worktree 的全部改动（含未跟踪文件）提交为快照；无改动返回 null。 */
export function snapshot(wt: string, message: string): string | null {
  git(wt, ['add', '-A']);
  if (gitOk(wt, ['diff', '--cached', '--quiet'])) return null;
  git(wt, ['commit', '-q', '--no-verify', '-m', message], { engineIdentity: true });
  return headSha(wt);
}

/** base 到 HEAD 之间改动的文件（不合并重命名，删除也算）。调用前应先 snapshot。 */
export function changedFiles(wt: string, base: string): string[] {
  return git(wt, ['diff', '--name-only', '--no-renames', `${base}`, 'HEAD']).split('\n').filter(Boolean).sort();
}

export function isClean(wt: string): boolean {
  return git(wt, ['status', '--porcelain']).trim() === '';
}

export function removeWorktree(root: string, wt: string, branch?: string): void {
  if (existsSync(wt)) git(root, ['worktree', 'remove', '--force', wt]);
  git(root, ['worktree', 'prune']);
  if (branch && branchExists(root, branch)) git(root, ['branch', '-D', branch]);
}
