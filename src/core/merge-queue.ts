// 合并队列：串行合并（squash → rebase → 冲突分类 → 合并后验证 → 快进集成分支 → 清理）。第 12 节。
// 冲突一律交给程序分类：writes 内的文本冲突生成 merge-fix 任务，涉及契约、受保护路径或 writes 之外的转 blocked。
// 引擎内的 LLM 不参与解决冲突。
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { git, gitOk } from './git.ts';
import { headSha, removeWorktree, taskBranch, worktreePath } from './worktree.ts';
import { matchesAny, isProtected, CONTRACTS_PATH } from './paths.ts';
import { carriedTestOf } from './dag.ts';
import { evidenceText, runShell } from './verify-runner.ts';

export interface MergeHooks {
  /** 受影响的测试文件（codegraph 影响面分析）；拿不到返回 null，退回全量 test */
  affectedFiles?: (worktree: string, changed: string[]) => Promise<string[] | null>;
  /** 合并完成后的钩子（codegraph sync 等），失败不影响合并 */
  afterMerge?: (root: string) => Promise<void>;
  verifyTimeoutMs?: number;
}

export type MergeResult =
  | { kind: 'merged'; task: string; sha: string; finished: string[] }
  | { kind: 'verify_failed'; task: string; reason: string }
  | { kind: 'merge_fix'; task: string; mergeFix: string; conflicts: string[] }
  | { kind: 'blocked'; task: string; reason: string };

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

export class MergeQueue {
  private readonly root: string;
  private readonly store: StateStore;
  private readonly config: FlowConfig;
  private readonly hooks: MergeHooks;
  private running = false;

  constructor(root: string, store: StateStore, config: FlowConfig, hooks: MergeHooks = {}) {
    this.root = root;
    this.store = store;
    this.config = config;
    this.hooks = hooks;
  }

  /** 队首任务可以开始合并时处理它；同一时间只处理一个（进程内互斥 + 合并队列的 merging 名额）。 */
  async processNext(flowId: string): Promise<MergeResult | null> {
    if (this.running) return null;
    const mq = this.store.readMergeQueue();
    const head = mq.queue[0];
    if (mq.merging || !head || head.flow !== flowId) return null;
    this.running = true;
    try {
      await this.store.transitionTask(flowId, head.task, { to: 'merging', trigger: 'merge_start', actor: 'merge-queue' });
      return await this.merge(flowId, this.store.readTask(flowId, head.task));
    } finally {
      this.running = false;
    }
  }

  private async merge(flowId: string, t: TaskFile): Promise<MergeResult> {
    const flow = this.store.readFlow(flowId);
    const integ = flow.integration_branch;
    const wt = t.worktree!;
    const label = flow.mode === 'fix' ? `fix: ${flow.title}`.slice(0, 200)
      : t.kind === 'merge-fix' && t.merge_fix_for ? this.store.readTask(flowId, t.merge_fix_for).title + `（经 ${t.id} 解决合并冲突）` : t.title;
    const msgFor = t.kind === 'merge-fix' && t.merge_fix_for ? t.merge_fix_for : t.id;

    // 1. squash：以与集成分支的分叉点为基准合成一个提交。
    //    任务基线之下还有未合入的提交（承载的先行验收测试、fix 的复现测试）时合成两个提交：先测试、后实现，
    //    rebase 后 base_sha 指向测试提交，测试文件不计入本任务的 diff（合并后验证失败重新提交时不会被判越界）。
    //    merge-fix 的基线是程序准备的含冲突标记的提交，不单独成提交。
    const fork = git(wt, ['merge-base', 'HEAD', integ]).trim();
    const tree = (ref: string) => git(wt, ['rev-parse', `${ref}^{tree}`]).trim();
    if (tree('HEAD') === tree(fork)) return this.blocked(flowId, t, '任务分支相对集成分支没有任何改动，无法合并');
    const commitTree = (ref: string, parent: string, msg: string) =>
      git(wt, ['commit-tree', `${ref}^{tree}`, '-p', parent, '-m', msg], { engineIdentity: true }).trim();
    const msg = `[${flowId}/${msgFor}] ${label}`;
    const squashed = commitTree('HEAD', fork, msg);
    const base = t.base_sha;
    const carries = t.kind !== 'merge-fix' && !!base && base !== fork && tree(base) !== tree(fork)
      && gitOk(wt, ['merge-base', '--is-ancestor', fork, base]) && gitOk(wt, ['merge-base', '--is-ancestor', base, 'HEAD']);
    if (carries) {
      const test = carriedTestOf(t, this.store.listTasks(flowId));
      const carried = commitTree(base, fork, test ? `[${flowId}/${test.id}] ${test.title}` : `[${flowId}/${msgFor}] 前置提交`);
      git(wt, ['reset', '-q', '--soft', commitTree('HEAD', carried, msg)]);
    } else {
      git(wt, ['reset', '-q', '--soft', squashed]);
    }

    // 2. rebase 到集成分支最新 HEAD
    const integHead = headSha(this.root, integ);
    try {
      git(wt, ['rebase', '-q', integHead], { engineIdentity: true, allowFail: true });
    } catch {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean).sort();
      git(wt, ['rebase', '--abort']);
      return this.conflict(flowId, t, conflicts, squashed, integHead);
    }
    const newBase = carries ? headSha(wt, 'HEAD~1') : integHead;
    await this.store.updateTask(flowId, t.id, { base_sha: newBase }, { actor: 'merge-queue', type: 'note', reason: 'rebase 到集成分支', data: { base: newBase } });

    // 3. 合并后验证：不得残留冲突标记；typecheck + 受影响测试（拿不到时全量 test）
    const changed = git(wt, ['diff', '--name-only', '--no-renames', integHead, 'HEAD']).split('\n').filter(Boolean);
    const marked = changed.filter((f) => {
      const p = path.join(wt, f);
      return existsSync(p) && CONFLICT_MARKER.test(readFileSync(p, 'utf8'));
    });
    if (marked.length) return this.verifyFailed(flowId, t, `文件中残留冲突标记：${marked.join('、')}`, []);
    const verify = await this.postMergeVerify(flowId, t, wt, changed);
    if (!verify.ok) return this.verifyFailed(flowId, t, verify.reason, verify.results);

    // 4. 快进集成分支（CAS：期间集成分支被移动则失败，回到队首重试）。
    //    fix 流程直接合入主分支；主分支在主工作区检出时（状态提交也在推进它），在主工作区 cherry-pick 应用。
    let sha = headSha(wt);
    const checkedOut = gitOk(this.root, ['symbolic-ref', '-q', 'HEAD']) && git(this.root, ['symbolic-ref', '--short', 'HEAD']).trim() === integ;
    if (checkedOut) {
      const dirty = git(this.root, ['status', '--porcelain', '-uall', '--', '.', ':(exclude).flow']).split('\n').filter(Boolean).map((l) => l.slice(3));
      const overlap = dirty.filter((f) => changed.includes(f));
      if (overlap.length) return this.blocked(flowId, t, `主工作区中这些文件有未提交的改动，无法合入：${overlap.join('、')}`);
      try {
        git(this.root, ['cherry-pick', `${integHead}..${sha}`], { engineIdentity: true, allowFail: true });
      } catch {
        gitOk(this.root, ['cherry-pick', '--abort']);
        return this.blocked(flowId, t, `在主工作区应用改动时冲突，需要人工处理`);
      }
      sha = headSha(this.root);
    } else {
      try {
        git(this.root, ['update-ref', `refs/heads/${integ}`, sha, integHead]);
      } catch {
        await this.store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'merge_requeue', actor: 'merge-queue' });
        return this.verifyFailed(flowId, t, '集成分支在合并过程中被移动，已放回队首', [], true);
      }
    }
    await this.store.transitionTask(flowId, t.id, {
      to: 'done', trigger: 'merge_done', actor: 'merge-queue', evidence: sha,
      facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true },
    });
    await this.store.recordEvent({ flow: flowId, task: t.id, actor: 'merge-queue', type: 'merge', evidence: sha,
      data: { integration_branch: integ, from: integHead, to: sha, files: changed.length } });

    // 5. 清理；merge-fix 合入即代表原任务合入；承载的先行验收测试已随之合入，回收它的 worktree
    removeWorktree(this.root, wt, t.branch ?? undefined);
    const finished = [t.id, ...(await this.finishSuspended(flowId, t, sha))];
    const tasks = this.store.listTasks(flowId);
    for (const id of finished) {
      const test = carriedTestOf(tasks.find((x) => x.id === id)!, tasks);
      if (test?.worktree) removeWorktree(this.root, test.worktree, test.branch ?? undefined);
    }
    if (this.hooks.afterMerge) await this.hooks.afterMerge(this.root).catch(() => {});
    return { kind: 'merged', task: t.id, sha, finished };
  }

  /**
   * 恢复被中断的合并（第 18 节第 4 步）：集成分支已包含其提交则补完状态，否则放回队首。
   * 返回 'done'、'requeued'、'blocked' 或 null（没有中断的合并）。
   */
  async recoverInterrupted(flowId: string): Promise<'done' | 'requeued' | 'blocked' | null> {
    const mq = this.store.readMergeQueue();
    if (!mq.merging || mq.merging.flow !== flowId) return null;
    const t = this.store.readTask(flowId, mq.merging.task);
    const integ = this.store.readFlow(flowId).integration_branch;
    const wt = t.worktree;
    if (wt && existsSync(wt)) {
      const rebaseDir = git(wt, ['rev-parse', '--git-path', 'rebase-merge']).trim();
      if (existsSync(path.isAbsolute(rebaseDir) ? rebaseDir : path.join(wt, rebaseDir))) gitOk(wt, ['rebase', '--abort']);
      const head = headSha(wt);
      if (gitOk(this.root, ['merge-base', '--is-ancestor', head, integ])) {
        await this.store.transitionTask(flowId, t.id, {
          to: 'done', trigger: 'merge_done', actor: 'resume', evidence: head,
          facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true, reason: '恢复：集成分支已包含该任务的提交' },
        });
        await this.store.recordEvent({ flow: flowId, task: t.id, actor: 'resume', type: 'merge', evidence: head, data: { recovered: true } });
        removeWorktree(this.root, wt, t.branch ?? undefined);
        await this.finishSuspended(flowId, this.store.readTask(flowId, t.id), head);
        return 'done';
      }
      await this.store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'merge_requeue', actor: 'resume' });
      return 'requeued';
    }
    await this.store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'merge_blocked', actor: 'resume',
      facts: { reason: `合并中断且 worktree 丢失（${wt ?? '无'}），无法自动恢复` } });
    return 'blocked';
  }

  /** merge-fix 合入后，沿 merge_fix_for 链把挂起的原任务标记为 done */
  private async finishSuspended(flowId: string, fix: TaskFile, sha: string): Promise<string[]> {
    const out: string[] = [];
    let cur = fix;
    while (cur.kind === 'merge-fix' && cur.merge_fix_for) {
      const orig = this.store.readTask(flowId, cur.merge_fix_for);
      if (orig.status !== 'merging') break;
      await this.store.transitionTask(flowId, orig.id, {
        to: 'done', trigger: 'merge_done', actor: 'merge-queue', evidence: sha,
        facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true, reason: `经 ${cur.id} 解决冲突后合入` },
      });
      if (orig.worktree) removeWorktree(this.root, orig.worktree, orig.branch ?? undefined);
      out.push(orig.id);
      cur = orig;
    }
    return out;
  }

  private async postMergeVerify(flowId: string, t: TaskFile, wt: string, changed: string[]) {
    const cmds = this.config.commands;
    // 只在任务的 verify 包含时运行（文档类任务不跑 typecheck/test，否则新项目在建好脚手架前永远无法合并）
    const plan: { name: string; shell: string }[] = [];
    if (cmds['typecheck'] && t.verify.includes('typecheck')) plan.push({ name: 'typecheck', shell: cmds['typecheck'] });
    if (t.verify.some((v) => v === 'test' || v === 'test_affected')) {
      const affected = cmds['test_affected'] && this.hooks.affectedFiles ? await this.hooks.affectedFiles(wt, changed) : null;
      if (affected?.length && cmds['test_affected']) {
        plan.push({ name: 'test_affected', shell: cmds['test_affected'].replace('{files}', affected.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')) });
      } else if (cmds['test']) {
        plan.push({ name: 'test', shell: cmds['test'] });
      }
    }
    const results: { command: string; exit_code: number }[] = [];
    for (const c of plan) {
      const r = { command: c.name, ...(await runShell(c.shell, wt, this.hooks.verifyTimeoutMs)) };
      results.push({ command: c.name, exit_code: r.exit_code });
      await this.store.saveEvidence(flowId, t.id, `merge-a${t.attempts}-${c.name}.log`, evidenceText(r, c.shell), 'merge-queue');
      if (r.exit_code !== 0) {
        return { ok: false as const, results, reason: `合并后验证失败（可能与已合入的其他任务存在语义冲突）：${c.name} 退出码 ${r.exit_code}\n${r.output.trim().split('\n').slice(-15).join('\n')}` };
      }
    }
    return { ok: true as const, results, reason: '' };
  }

  private async verifyFailed(flowId: string, t: TaskFile, reason: string, _results: unknown[], alreadyRequeued = false): Promise<MergeResult> {
    if (!alreadyRequeued) {
      await this.store.transitionTask(flowId, t.id, { to: 'in_progress', trigger: 'merge_verify_fail', actor: 'merge-queue', facts: { post_verify_ok: false, reason } });
    }
    return { kind: 'verify_failed', task: t.id, reason };
  }

  private async blocked(flowId: string, t: TaskFile, reason: string): Promise<MergeResult> {
    await this.store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'merge_blocked', actor: 'merge-queue', facts: { reason } });
    return { kind: 'blocked', task: t.id, reason };
  }

  /** 冲突分类：全部在 writes 内且不涉及契约/受保护路径 → merge-fix；否则 blocked */
  private async conflict(flowId: string, t: TaskFile, conflicts: string[], squashed: string, integHead: string): Promise<MergeResult> {
    const contracts = conflicts.filter((f) => matchesAny(f, [CONTRACTS_PATH]) || isProtected(f, { contractsLocked: true }));
    const outside = conflicts.filter((f) => !matchesAny(f, t.writes));
    if (!conflicts.length || contracts.length || outside.length) {
      const why = contracts.length ? `冲突涉及契约或受保护文件：${contracts.join('、')}`
        : outside.length ? `冲突文件不在任务 writes 内：${outside.join('、')}` : 'rebase 失败但没有冲突文件';
      await this.store.recordEvent({ flow: flowId, task: t.id, actor: 'merge-queue', type: 'merge_conflict', reason: why, data: { conflicts } });
      return this.blocked(flowId, t, `${why}。需要用户处理（例如人工合并后 /flow unblock ${t.id}）`);
    }

    // 准备 merge-fix 的 worktree：集成分支 HEAD + 原任务的改动（冲突文件保留冲突标记），作为它的基线提交
    const ids = this.store.listTasks(flowId).map((x) => Number(x.id.slice(2)));
    const fixId = `T-${String(Math.max(0, ...ids) + 1).padStart(3, '0')}`;
    const fixWt = worktreePath(this.root, flowId, fixId);
    const fixBranch = taskBranch(flowId, fixId);
    mkdirSync(path.dirname(fixWt), { recursive: true });
    git(this.root, ['worktree', 'add', '-q', '-b', fixBranch, fixWt, integHead]);
    try {
      git(fixWt, ['cherry-pick', '--no-commit', squashed], { engineIdentity: true, allowFail: true });
    } catch {
      // 预期会冲突：冲突文件留在工作区，带冲突标记
    }
    git(fixWt, ['add', '-A']);
    git(fixWt, ['commit', '-q', '--no-verify', '-m', `[${flowId}/${fixId}] 准备：应用 ${t.id} 的改动（冲突文件含冲突标记）`], { engineIdentity: true });
    const base = headSha(fixWt);

    const excerpt = conflicts.map((f) => {
      const text = existsSync(path.join(fixWt, f)) ? readFileSync(path.join(fixWt, f), 'utf8') : '';
      return `${f}：\n${text.slice(0, 1500)}`;
    }).join('\n\n');
    await this.store.suspendMerge(flowId, t.id, {
      id: fixId, stage: t.stage, kind: 'merge-fix', title: `解决 ${t.id} 合并冲突：${conflicts.join('、')}`.slice(0, 120),
      role: t.role, scopes: [...t.scopes], depends_on: [], inputs: [...conflicts], writes: [...conflicts],
      acceptance: [
        `删除 ${conflicts.join('、')} 中的全部冲突标记，同时保留集成分支与 ${t.id} 双方的意图`,
        ...t.acceptance.map((a) => `（${t.id}）${a}`),
      ],
      verify: [...t.verify], worktree: fixWt, branch: fixBranch, base_sha: base, merge_fix_for: t.id, conflict_files: conflicts,
    }, conflicts);
    await this.store.appendHandoff(flowId, fixId, `合并冲突（程序生成）：${t.id} rebase 到集成分支时冲突。\n冲突文件当前内容：\n\n${excerpt}`, 'merge-queue');
    return { kind: 'merge_fix', task: t.id, mergeFix: fixId, conflicts };
  }
}
