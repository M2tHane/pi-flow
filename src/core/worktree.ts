// worktree 与任务分支：从集成分支 HEAD 拉出，放在项目目录之外的同级目录。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/**
 * 建立任务 worktree；已存在（例如重新派发）时复用。
 * from 默认是集成分支；承载先行验收测试的任务从测试分支末端开工（base_sha 即测试分支末端，测试不计入本任务的 diff）。
 */
export function createTaskWorktree(root: string, flow: string, task: string, integrationBranch: string, from = integrationBranch): TaskWorktree {
  const wt = worktreePath(root, flow, task);
  const branch = taskBranch(flow, task);
  if (existsSync(path.join(wt, '.git'))) {
    return { path: wt, branch, base_sha: git(wt, ['merge-base', 'HEAD', from]).trim() };
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  const base = headSha(root, from);
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

/** 插件在工作目录中生成的产物（serena 的项目配置、codegraph 索引），不应进入任务快照 */
export const TOOL_ARTIFACTS = ['.serena/', '.codegraph/'];

/**
 * 写入仓库本地的 info/exclude（不被跟踪，所有 worktree 共享），避免插件产物出现在任务 diff 中被判越界。
 * 已核实：pi-serena 在项目根生成 .serena/.gitignore 与 .serena/project.yml。
 */
export function ensureLocalExcludes(root: string, patterns: readonly string[] = TOOL_ARTIFACTS): void {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const file = path.join(path.isAbsolute(common) ? common : path.join(root, common), 'info', 'exclude');
  mkdirSync(path.dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = patterns.filter((p) => !cur.split('\n').includes(p));
  if (missing.length) appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# pi-flow：插件产物不进入任务快照\n${missing.join('\n')}\n`);
}
