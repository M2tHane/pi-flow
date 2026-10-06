// 合并队列：串行合并（squash → rebase → 冲突分类 → 合并后验证 → 快进集成分支 → 清理）。第 12 节。
// 冲突一律交给程序分类：writes 内（含登记的公共文件）的文本冲突生成 merge-fix 任务，涉及受保护路径或 writes 之外的转 blocked。
// 引擎内的 LLM 不参与解决冲突。
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { git, gitOk } from './git.ts';
import { headSha, removeWorktree, taskBranch, worktreePath, worktreesRoot } from './worktree.ts';
import { matchesAny, isProtected } from './paths.ts';
import { proposeCandidate } from './knowledge.ts';
import { evidenceText, runShell } from './verify-runner.ts';
import { testAdjustEnabled } from './test-adjust.ts';


export interface MergeHooks {
  /** 合并后验证开始前调用（测试用：让合并停在验证前，模拟中断） */
  beforeVerify?: () => Promise<void>;
  /** 合并完成后的钩子（codegraph sync 等），失败不影响合并 */
  afterMerge?: (root: string) => Promise<void>;
  verifyTimeoutMs?: number;
}

export type SyncResult =
  | { kind: 'up_to_date' }
  | { kind: 'synced'; sha: string; files: number }
  | { kind: 'merge_fix'; task: string; conflicts: string[] }
  | { kind: 'conflict'; reason: string; conflicts: string[] }
  | { kind: 'fixing'; task: string };

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
      const batch = await this.mergeBatch(flowId);
      if (batch) return batch;
      await this.store.transitionTask(flowId, head.task, { to: 'merging', trigger: 'merge_start', actor: 'merge-queue' });
      return await this.merge(flowId, this.store.readTask(flowId, head.task));
    } finally {
      this.running = false;
    }
  }

  /**
   * 批量合并（第四轮后续）：队首连续的几个普通任务先在临时 worktree 里依次叠加到集成分支上，
   * 只跑一次全量验证；通过后逐个转 merging → done，集成分支依次快进到每个任务的提交（同一时间仍只有一个 merging）。
   * 冲突、验证失败、或有不适合批量的任务（merge-fix、承载先行测试、同步修复、fix 流程）时返回 null，退回逐个合并。
   */
  private async mergeBatch(flowId: string): Promise<MergeResult | null> {
    const limit = this.config.limits.merge_batch ?? 3;
    if (limit < 2) return null;
    const flow = this.store.readFlow(flowId);
    if (flow.mode === 'fix') return null;
    const integ = flow.integration_branch;
    const tasks = this.store.listTasks(flowId);
    const candidates: TaskFile[] = [];
    for (const e of this.store.readMergeQueue().queue) {
      if (e.flow !== flowId || candidates.length >= limit) break;
      const t = tasks.find((x) => x.id === e.task);
      if (!t || t.status !== 'queued_merge' || t.sync_main || t.kind === 'merge-fix' || !t.worktree || !existsSync(t.worktree)) break;
      candidates.push(t);
    }
    if (candidates.length < 2) return null;
    const integHead = headSha(this.root, integ);
    const temp = path.join(worktreesRoot(this.root), `${flowId}-batch`);
    removeWorktree(this.root, temp);
    mkdirSync(path.dirname(temp), { recursive: true });
    git(this.root, ['worktree', 'add', '-q', '--detach', temp, integHead]);
    try {
      // 1. 依次叠加：每个任务 squash 成一个提交，cherry-pick 到临时 worktree；冲突则到此为止
      const applied: { t: TaskFile; sha: string; msg: string }[] = [];
      for (const t of candidates) {
        const wt = t.worktree!;
        const fork = git(wt, ['merge-base', 'HEAD', integ]).trim();
        const tree = (ref: string) => git(wt, ['rev-parse', `${ref}^{tree}`]).trim();
        if (tree('HEAD') === tree(fork)) break;
        if (t.base_sha && t.base_sha !== fork && tree(t.base_sha) !== tree(fork)) break; // 基线之下还有未合入的提交，走逐个合并
        const msg = `[${flowId}/${t.id}] ${t.title}`;
        const squashed = git(wt, ['commit-tree', 'HEAD^{tree}', '-p', fork, '-m', msg], { engineIdentity: true }).trim();
        try {
          git(temp, ['cherry-pick', '--allow-empty', squashed], { engineIdentity: true, allowFail: true });
        } catch {
          gitOk(temp, ['cherry-pick', '--abort']);
          break;
        }
        applied.push({ t, sha: headSha(temp), msg });
      }
      if (applied.length < 2) return null;
      const changed = git(temp, ['diff', '--name-only', '--no-renames', integHead, 'HEAD']).split('\n').filter(Boolean);
      if (changed.some((f) => existsSync(path.join(temp, f)) && CONFLICT_MARKER.test(readFileSync(path.join(temp, f), 'utf8')))) return null;
      // 2. 只跑一次全量验证（任一任务有 verify 时）
      if (applied.some((a) => a.t.verify.length)) {
        if (this.hooks.beforeVerify) await this.hooks.beforeVerify();
        for (const c of this.mergeVerifyPlan(applied.find((a) => a.t.verify.length)!.t)) {
          const r = await runShell(c.shell, temp, this.hooks.verifyTimeoutMs);
          for (const a of applied) await this.store.saveEvidence(flowId, a.t.id, `merge-a${a.t.attempts}-batch-${c.name}.log`, evidenceText({ command: c.name, ...r }, c.shell), 'merge-queue');
          if (r.exit_code !== 0) {
            await this.store.recordEvent({ flow: flowId, actor: 'merge-queue', type: 'note', reason: `批量合并 ${applied.map((a) => a.t.id).join('、')} 的全量 ${c.name} 失败，改为逐个合并`, data: { tasks: applied.map((a) => a.t.id) } });
            return null;
          }
        }
      }
      // 3. 逐个转 merging → done，集成分支依次快进（CAS）
      let prev = integHead;
      const finished: string[] = [];
      for (const a of applied) {
        await this.store.transitionTask(flowId, a.t.id, { to: 'merging', trigger: 'merge_start', actor: 'merge-queue' });
        try {
          git(this.root, ['update-ref', `refs/heads/${integ}`, a.sha, prev]);
        } catch {
          await this.store.transitionTask(flowId, a.t.id, { to: 'queued_merge', trigger: 'merge_requeue', actor: 'merge-queue' });
          break;
        }
        await this.store.transitionTask(flowId, a.t.id, { to: 'done', trigger: 'merge_done', actor: 'merge-queue', evidence: a.sha,
          facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true, reason: `批量合并（${applied.map((x) => x.t.id).join('、')}，一次全量验证）` } });
        await this.store.recordEvent({ flow: flowId, task: a.t.id, actor: 'merge-queue', type: 'merge', evidence: a.sha,
          data: { integration_branch: integ, from: prev, to: a.sha, batch: applied.map((x) => x.t.id) } });
        removeWorktree(this.root, a.t.worktree!, a.t.branch ?? undefined);
        finished.push(a.t.id);
        prev = a.sha;
      }
      if (!finished.length) return null;
      if (this.hooks.afterMerge) await this.hooks.afterMerge(this.root).catch(() => {});
      return { kind: 'merged', task: finished[0]!, sha: prev, finished };
    } finally {
      gitOk(temp, ['cherry-pick', '--abort']);
      removeWorktree(this.root, temp);
    }
  }

  private async merge(flowId: string, t: TaskFile): Promise<MergeResult> {
    if (t.sync_main) return this.mergeSyncFix(flowId, t);
    const flow = this.store.readFlow(flowId);
    const integ = flow.integration_branch;
    const wt = t.worktree!;
    const label = flow.mode === 'fix' ? `fix: ${flow.title}`.slice(0, 200)
      : t.kind === 'merge-fix' && t.merge_fix_for ? this.store.readTask(flowId, t.merge_fix_for).title + `（经 ${t.id} 解决合并冲突）` : t.title;
    const msgFor = t.kind === 'merge-fix' && t.merge_fix_for ? t.merge_fix_for : t.id;

    // 1. squash：以与集成分支的分叉点为基准合成一个提交（任务分支里的多次本地提交、flow_sync 的合并提交都合成一个）
    const fork = git(wt, ['merge-base', 'HEAD', integ]).trim();
    const tree = (ref: string) => git(wt, ['rev-parse', `${ref}^{tree}`]).trim();
    if (tree('HEAD') === tree(fork)) return this.blocked(flowId, t, '任务分支相对集成分支没有任何改动，无法合并');
    const commitTree = (ref: string, parent: string, msg: string) =>
      git(wt, ['commit-tree', `${ref}^{tree}`, '-p', parent, '-m', msg], { engineIdentity: true }).trim();
    const msg = `[${flowId}/${msgFor}] ${label}`;
    const squashed = commitTree('HEAD', fork, msg);
    git(wt, ['reset', '-q', '--soft', squashed]);

    // 2. rebase 到集成分支最新 HEAD
    const integHead = headSha(this.root, integ);
    try {
      git(wt, ['rebase', '-q', integHead], { engineIdentity: true, allowFail: true });
    } catch {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean).sort();
      git(wt, ['rebase', '--abort']);
      return this.conflict(flowId, t, conflicts, squashed, integHead);
    }
    const newBase = integHead;
    await this.store.updateTask(flowId, t.id, { base_sha: newBase }, { actor: 'merge-queue', type: 'note', reason: 'rebase 到集成分支', data: { base: newBase } });

    // 3. 合并后验证：不得残留冲突标记；全量 typecheck、lint、test（与 merge_check）
    const changed = git(wt, ['diff', '--name-only', '--no-renames', integHead, 'HEAD']).split('\n').filter(Boolean);
    const marked = changed.filter((f) => {
      const p = path.join(wt, f);
      return existsSync(p) && CONFLICT_MARKER.test(readFileSync(p, 'utf8'));
    });
    if (marked.length) return this.verifyFailed(flowId, t, `文件中残留冲突标记：${marked.join('、')}`, []);
    const verify = await this.postMergeVerify(flowId, t, wt);
    if (!verify.ok) {
      // 合并后验证失败多半是与已合入任务的语义冲突：提炼为知识候选，用户确认后才生效
      await proposeCandidate(this.store, this.config, t, flowId, verify.reason);
      return this.verifyFailed(flowId, t, verify.reason, verify.results);
    }

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

    // 5. 清理；merge-fix 合入即代表原任务合入
    removeWorktree(this.root, wt, t.branch ?? undefined);
    const finished = [t.id, ...(await this.finishSuspended(flowId, t, sha))];
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

  /**
   * 合并后验证要跑的命令：verify 非空的任务跑全量 typecheck、lint、test 与 merge_check
   * （commands 中定义且非空的）；否则只跑任务 verify 里有的命令，test 优先用受影响的测试。
   * 文档类任务（verify 为空）都不跑，否则新项目在建好脚手架前永远无法合并。
   */
  /** 全量 typecheck、lint、test；merge_check（第五轮，可选）是一起跑的额外检查，例如迁移只能有一个 head。没有 verify 的任务（文档类）不跑 */
  private mergeVerifyPlan(t: TaskFile): { name: string; shell: string }[] {
    const cmds = this.config.commands;
    if (!t.verify.length) return [];
    return ['typecheck', 'lint', 'test', 'merge_check'].filter((name) => cmds[name]?.trim()).map((name) => ({ name, shell: cmds[name]! }));
  }

  private async postMergeVerify(flowId: string, t: TaskFile, wt: string) {
    if (this.hooks.beforeVerify) await this.hooks.beforeVerify();
    const plan = this.mergeVerifyPlan(t);
    const results: { command: string; exit_code: number }[] = [];
    for (const c of plan) {
      const r = { command: c.name, ...(await runShell(c.shell, wt, this.hooks.verifyTimeoutMs)) };
      results.push({ command: c.name, exit_code: r.exit_code });
      await this.store.saveEvidence(flowId, t.id, `merge-a${t.attempts}-${c.name}.log`, evidenceText(r, c.shell), 'merge-queue');
      if (r.exit_code !== 0) {
        // 全量验证的失败多半是任务自己的问题，日志多给一些
        const why = `已 rebase 到集成分支最新，全量 ${plan.map((x) => x.name).join('、')} 中 `;
        const adjust = testAdjustEnabled(this.config, t) ? '\n失败的如果是别的模块已有的测试、原因是本任务改了接口，可以直接修改那些测试来适配（不删用例、不放宽断言）。' : '';
        return { ok: false as const, results, reason: `合并后验证失败（${why}${c.name} 退出码 ${r.exit_code}）\n${r.output.trim().split('\n').slice(-40).join('\n')}${adjust}` };
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

  /** 冲突分类：全部在 writes 内（含登记的公共文件）且不涉及受保护路径 → merge-fix；否则 blocked */
  private async conflict(flowId: string, t: TaskFile, conflicts: string[], squashed: string, integHead: string): Promise<MergeResult> {
    const contracts = conflicts.filter((f) => isProtected(f));
    // 适配过的已有测试（testing.adjust_tests）也算任务自己的文件，冲突交给 merge-fix
    const outside = conflicts.filter((f) => !matchesAny(f, [...t.writes, ...(t.shared ?? [])]) && !(t.test_adjustments ?? []).includes(f));
    if (!conflicts.length || contracts.length || outside.length) {
      const why = contracts.length ? `冲突涉及受保护文件：${contracts.join('、')}`
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

  /**
   * 把主分支同步进集成分支（阶段边界或 /flow sync）。与合并共用互斥：合并进行中返回 null，稍后重试。
   * - 无冲突：在临时 worktree 中 merge 主分支，快进集成分支（CAS）。
   * - .flow/ 的冲突取主分支版本（状态只在主分支上有意义）。
   * - 冲突只涉及某个角色可写的文件：保留含冲突标记的合并提交，生成 merge-fix 任务解决，合入时保留合并关系。
   * - 涉及受保护路径或没有角色能写：中止，交给用户（流程暂停派发新任务）。
   */
  async syncMain(flowId: string): Promise<SyncResult | null> {
    if (this.running || this.store.readMergeQueue().merging) return null;
    this.running = true;
    try {
      return await this.doSync(flowId);
    } finally {
      this.running = false;
    }
  }

  private async doSync(flowId: string): Promise<SyncResult | null> {
    const flow = this.store.readFlow(flowId);
    if (flow.sync?.status === 'fixing' && flow.sync.task) {
      const fix = this.store.readTask(flowId, flow.sync.task);
      // 修复任务阻塞时等待用户处理（/flow answer 或 unblock），不重复生成
      if (fix.status !== 'done') return { kind: 'fixing', task: fix.id };
    }
    const main = this.config.raw.main_branch;
    const integ = flow.integration_branch;
    const mainSha = headSha(this.root, main);
    const at = new Date().toISOString();
    const ok = (reason: string) => this.store.setFlowSync(flowId, { stage: flow.stage, status: 'ok', main_sha: mainSha, at }, 'engine', reason);
    // 主分支上只有状态提交（.flow/）时不算有新改动：状态只在主分支上有意义，不必为它产生合并提交
    const mb = git(this.root, ['merge-base', mainSha, integ]).trim();
    const changedOnMain = git(this.root, ['diff', '--name-only', mb, mainSha, '--', '.', ':(exclude).flow']).trim();
    if (!changedOnMain || gitOk(this.root, ['merge-base', '--is-ancestor', mainSha, integ])) {
      if (flow.sync?.stage !== flow.stage || flow.sync.status !== 'ok' || flow.sync.main_sha !== mainSha) await ok(`集成分支已包含 ${main}`);
      return { kind: 'up_to_date' };
    }
    const integHead = headSha(this.root, integ);
    const temp = path.join(worktreesRoot(this.root), `${flowId}-sync`);
    removeWorktree(this.root, temp);
    mkdirSync(path.dirname(temp), { recursive: true });
    git(this.root, ['worktree', 'add', '-q', '--detach', temp, integHead]);
    try {
      const msg = `pi-flow: 同步 ${main} 到 ${integ}（${flow.stage}）`;
      let conflicts: string[] = [];
      try {
        git(temp, ['merge', '--no-ff', '--no-edit', '-m', msg, mainSha], { engineIdentity: true, allowFail: true });
      } catch {
        conflicts = git(temp, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean).sort();
        const state = conflicts.filter((f) => f === '.flow' || f.startsWith('.flow/'));
        for (const f of state) {
          if (!gitOk(temp, ['checkout', '--theirs', '--', f])) git(temp, ['rm', '-q', '--', f]);
          else git(temp, ['add', '--', f]);
        }
        conflicts = conflicts.filter((f) => !state.includes(f));
        if (!conflicts.length) git(temp, ['commit', '-q', '--no-verify', '--no-edit'], { engineIdentity: true });
      }
      if (!conflicts.length) {
        const sha = headSha(temp);
        try {
          git(this.root, ['update-ref', `refs/heads/${integ}`, sha, integHead]);
        } catch {
          return null; // 集成分支在同步期间被移动：下次再试
        }
        const files = git(temp, ['diff', '--name-only', integHead, sha]).split('\n').filter(Boolean).length;
        await ok(`同步 ${main}（${mainSha.slice(0, 8)}）到 ${integ}：${files} 个文件`);
        return { kind: 'synced', sha, files };
      }

      // 冲突分类：受保护路径 → 用户；否则找能写全部冲突文件的角色生成 merge-fix
      const protectedFiles = conflicts.filter((f) => isProtected(f));
      const tasks = this.store.listTasks(flowId);
      const owners = tasks.filter((t) => t.status === 'done' && t.kind !== 'merge-fix' && conflicts.some((f) => matchesAny(f, t.writes)));
      const covers = (role: string) => {
        const r = this.config.roles[role];
        return !!r && r.tools.has('flow_submit') && r.writes.length > 0 && conflicts.every((f) => matchesAny(f, r.writes));
      };
      const role = protectedFiles.length ? null
        : [...new Set(owners.map((t) => t.role)), ...Object.keys(this.config.roles)].find((r) => r !== 'architect' && r !== 'orchestrator' && covers(r)) ?? null;
      if (!role) {
        gitOk(temp, ['merge', '--abort']);
        const reason = protectedFiles.length ? `冲突涉及受保护文件：${protectedFiles.join('、')}` : `没有角色的可写范围覆盖冲突文件：${conflicts.join('、')}`;
        await this.store.setFlowSync(flowId, { stage: flow.stage, status: 'conflict', main_sha: mainSha, at, files: conflicts, reason }, 'engine', `同步 ${main} 冲突：${reason}`);
        return { kind: 'conflict', reason, conflicts };
      }
      git(temp, ['add', '-A']);
      git(temp, ['commit', '-q', '--no-verify', '-m', `${msg}（冲突文件含冲突标记，待解决）`], { engineIdentity: true });
      const merged = headSha(temp);
      const ids = tasks.map((x) => Number(x.id.slice(2)));
      const fixId = `T-${String(Math.max(0, ...ids) + 1).padStart(3, '0')}`;
      const fixWt = worktreePath(this.root, flowId, fixId);
      const fixBranch = taskBranch(flowId, fixId);
      git(this.root, ['worktree', 'add', '-q', '-b', fixBranch, fixWt, merged]);
      const verify = [...new Set(owners.filter((t) => conflicts.some((f) => matchesAny(f, t.writes))).flatMap((t) => t.verify))];
      const r = this.config.roles[role]!;
      await this.store.addTasks(flowId, [{
        id: fixId, stage: flow.stage, kind: 'merge-fix', title: `解决同步 ${main} 的冲突：${conflicts.join('、')}`.slice(0, 120),
        role, scopes: [...r.scopes], depends_on: [], inputs: [...conflicts], writes: [...conflicts],
        acceptance: [`删除 ${conflicts.join('、')} 中的全部冲突标记，同时保留 ${main} 与集成分支双方的意图`],
        verify, worktree: fixWt, branch: fixBranch, base_sha: merged, conflict_files: conflicts, sync_main: mainSha,
      }], 'merge-queue');
      const excerpt = conflicts.map((f) => `${f}：\n${existsSync(path.join(fixWt, f)) ? readFileSync(path.join(fixWt, f), 'utf8').slice(0, 1500) : '（已删除）'}`).join('\n\n');
      await this.store.appendHandoff(flowId, fixId, `同步冲突（程序生成）：把 ${main} 合并进集成分支时冲突。当前工作区是这次合并的结果，冲突文件含冲突标记。\n冲突文件当前内容：\n\n${excerpt}`, 'merge-queue');
      await this.store.setFlowSync(flowId, { stage: flow.stage, status: 'fixing', main_sha: mainSha, at, task: fixId, files: conflicts }, 'engine', `同步 ${main} 冲突，生成 ${fixId} 解决`);
      return { kind: 'merge_fix', task: fixId, conflicts };
    } finally {
      removeWorktree(this.root, temp);
    }
  }

  /** 同步冲突修复任务合入：在含冲突标记的合并提交上 squash 修复，必要时再合入集成分支的新提交，验证后快进（保留与主分支的合并关系） */
  private async mergeSyncFix(flowId: string, t: TaskFile): Promise<MergeResult> {
    const flow = this.store.readFlow(flowId);
    const integ = flow.integration_branch;
    const wt = t.worktree!;
    const merged = t.base_sha!;
    const tree = (ref: string) => git(wt, ['rev-parse', `${ref}^{tree}`]).trim();
    if (tree('HEAD') !== tree(merged)) {
      const c = git(wt, ['commit-tree', 'HEAD^{tree}', '-p', merged, '-m', `[${flowId}/${t.id}] 解决同步 ${this.config.raw.main_branch} 的冲突`], { engineIdentity: true }).trim();
      git(wt, ['reset', '-q', '--soft', c]);
    }
    const integHead = headSha(this.root, integ);
    if (!gitOk(wt, ['merge-base', '--is-ancestor', integHead, 'HEAD'])) {
      try {
        git(wt, ['merge', '--no-edit', '-m', `pi-flow: 合入 ${integ} 的新提交`, integHead], { engineIdentity: true, allowFail: true });
      } catch {
        gitOk(wt, ['merge', '--abort']);
        return this.blocked(flowId, t, `同步冲突解决后，集成分支又有新的提交与之冲突，需要用户处理`);
      }
    }
    await this.store.updateTask(flowId, t.id, { base_sha: headSha(wt) }, { actor: 'merge-queue', type: 'note', reason: '同步修复：基线前移', data: { base: headSha(wt) } });
    const changed = git(wt, ['diff', '--name-only', '--no-renames', integHead, 'HEAD']).split('\n').filter(Boolean);
    const marked = changed.filter((f) => existsSync(path.join(wt, f)) && CONFLICT_MARKER.test(readFileSync(path.join(wt, f), 'utf8')));
    if (marked.length) return this.verifyFailed(flowId, t, `文件中残留冲突标记：${marked.join('、')}`, []);
    const verify = await this.postMergeVerify(flowId, t, wt);
    if (!verify.ok) return this.verifyFailed(flowId, t, verify.reason, verify.results);
    const sha = headSha(wt);
    try {
      git(this.root, ['update-ref', `refs/heads/${integ}`, sha, integHead]);
    } catch {
      await this.store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'merge_requeue', actor: 'merge-queue' });
      return this.verifyFailed(flowId, t, '集成分支在合并过程中被移动，已放回队首', [], true);
    }
    await this.store.transitionTask(flowId, t.id, { to: 'done', trigger: 'merge_done', actor: 'merge-queue', evidence: sha,
      facts: { rebase_ok: true, post_verify_ok: true, fast_forwarded: true } });
    await this.store.recordEvent({ flow: flowId, task: t.id, actor: 'merge-queue', type: 'merge', evidence: sha,
      data: { integration_branch: integ, from: integHead, to: sha, files: changed.length, sync_main: t.sync_main } });
    removeWorktree(this.root, wt, t.branch ?? undefined);
    await this.store.setFlowSync(flowId, { stage: flow.sync?.stage ?? flow.stage, status: 'ok', main_sha: t.sync_main!, at: new Date().toISOString() }, 'merge-queue', `${t.id} 解决同步冲突后合入`);
    return { kind: 'merged', task: t.id, sha, finished: [t.id] };
  }
}
