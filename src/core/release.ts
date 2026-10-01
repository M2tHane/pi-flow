// 流程最后一个闸门通过并经用户确认后，把集成分支合入主分支（第 12 节第 5 条）。中止的流程不合入，集成分支保留。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { worktreesRoot, removeWorktree } from './worktree.ts';
import { dirtyFiles } from './context-injector.ts';

export async function mergeToMain(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string> {
  const flow = store.readFlow(flowId);
  const main = config.raw.main_branch;
  const integ = flow.integration_branch;
  const msg = `pi-flow: 合入 ${flow.id} ${flow.title}`.slice(0, 200);
  if (gitOk(root, ['merge-base', '--is-ancestor', integ, main])) throw new Error(`${integ} 已经包含在 ${main} 中，无需合入`);
  const current = gitOk(root, ['symbolic-ref', '-q', 'HEAD']) ? git(root, ['symbolic-ref', '--short', 'HEAD']).trim() : null;

  let dir = root;
  let temp: string | null = null;
  if (current === main) {
    const dirty = [...dirtyFiles(root)];
    if (dirty.length) throw new Error(`主工作区有未提交的改动，无法合入 ${main}：${dirty.slice(0, 10).join('、')}。请先提交或暂存后再执行 /flow approve。`);
  } else {
    temp = path.join(worktreesRoot(root), `${flowId}-release`);
    mkdirSync(path.dirname(temp), { recursive: true });
    removeWorktree(root, temp);
    try {
      git(root, ['worktree', 'add', '-q', temp, main]);
    } catch (e) {
      throw new Error(`无法检出 ${main} 进行合入（可能已在其他 worktree 中检出）：${(e as Error).message}`);
    }
    dir = temp;
  }
  try {
    try {
      git(dir, ['merge', '--no-ff', '--no-edit', '-m', msg, integ], { engineIdentity: true, allowFail: true });
    } catch {
      const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      gitOk(dir, ['merge', '--abort']);
      throw new Error(`合入 ${main} 时冲突：${conflicts.join('、') || '（未知）'}。主分支在流程期间被修改过；请人工合并 ${integ} 后再执行 /flow approve。`);
    }
    const sha = git(dir, ['rev-parse', 'HEAD']).trim();
    await store.recordEvent({ flow: flowId, actor: 'human', type: 'merge', evidence: sha, data: { from: integ, to: main } });
    return sha;
  } finally {
    if (temp) removeWorktree(root, temp);
  }
}
