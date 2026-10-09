// 每次运行的时间预算：worker 与验收者会卡住（原地打转、反复尝试做不到的事），心跳续租让租约管不住"忙着做无用功"的运行。
// 派发时按任务大小与类型给预算；到期先插话提醒收尾（写 handoff、能提交就提交），宽限期后结束运行；
// 超时不计失败，任务等主会话复核：接着原会话做、换个思路从头做，或交给用户。超时次数有上限，超过转 blocked。
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { git } from './git.ts';

export const DEFAULT_RUN_MINUTES = 30;
export const DEFAULT_GRACE_MINUTES = 5;
const SIZE_FACTOR = { S: 0.5, M: 1, L: 2 } as const;

/** 这个任务每次运行的时间预算（分钟）：M 号实现任务为 limits.run_minutes；只读任务（验收、修订）减半；S 减半、L 加倍 */
export function runBudgetMinutes(config: Pick<FlowConfig, 'limits'>, task: Pick<TaskFile, 'kind' | 'size'>): number {
  const base = config.limits.run_minutes ?? DEFAULT_RUN_MINUTES;
  const kind = task.kind === 'analysis' ? 0.5 : 1;
  return Math.max(5, Math.round(base * kind * SIZE_FACTOR[task.size ?? 'M']));
}

export const graceMinutes = (config: Pick<FlowConfig, 'limits'>) => config.limits.run_grace_minutes ?? DEFAULT_GRACE_MINUTES;

/** 预算到期时插给子进程的话 */
export function wrapUpMessage(minutes: number, grace: number): string {
  return [
    `⏰ 本次运行的时间预算（${minutes} 分钟）已用完。请在 ${grace} 分钟内收尾，不要再开始新的尝试：`,
    '1. 用 flow_note 写 handoff：做到哪、下一步打算怎么做、卡在哪（试过什么、结果如何）。',
    '2. 已经做完就照常提交（flow_submit、flow_accept 等）；没做完就停下，本地改动先 git commit 作为检查点。',
    `${grace} 分钟后本次运行会被结束；主会话会查看进度，决定接着做、换个思路重来，还是交给用户。`,
  ].join('\n');
}

/** 等主会话复核的超时任务（还没有决定） */
export const awaitingReview = (t: Pick<TaskFile, 'status' | 'timeout_review'>) => t.status === 'in_progress' && !!t.timeout_review && !t.timeout_review.decision;

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/** 给主会话复核用的材料：做了多久、改了什么、handoff 与最后的回复 */
export function timeoutReviewText(store: StateStore, flowId: string, t: TaskFile): string {
  const r = t.timeout_review;
  if (!r) return '';
  const lines = [`### ${t.id}「${t.title}」（${t.role}，第 ${t.timeouts ?? 1} 次超时，预算 ${r.minutes} 分钟，run ${r.run}）`];
  try {
    const run = store.readRun(r.run);
    if (run.violations) lines.push(`- 本次运行被拦下的操作：${run.violations} 次`);
    if (run.turns) lines.push(`- 模型回复轮数：${run.turns}`);
  } catch { /* run 记录缺失时只给其余材料 */ }
  if (t.worktree && t.base_sha) {
    const stat = safeGit(t.worktree, ['diff', '--stat', t.base_sha]).split('\n').at(-1)?.trim();
    const dirty = safeGit(t.worktree, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    const commits = safeGit(t.worktree, ['log', '--oneline', `${t.base_sha}..HEAD`]).split('\n').filter(Boolean).length;
    lines.push(`- 工作区相对基线：${stat || '没有改动'}；本地提交 ${commits} 个；未提交文件 ${dirty} 个`);
  }
  const h = store.readHandoff(flowId, t.id).trim();
  if (h) lines.push(`- handoff（最近部分）：\n${tail(h, 1200).split('\n').map((x) => `  ${x}`).join('\n')}`);
  if (r.last_text?.trim()) lines.push(`- 最后的回复：${tail(r.last_text.trim(), 600)}`);
  return lines.join('\n');
}

/** 复核的做法（写给主会话） */
export const REVIEW_GUIDE = '判断：有进展、方向对 → continue（接着原会话再给一份预算）；原地打转、方向错了 → restart（不带旧对话，只带 handoff 和工作区，从头换个思路），可以在 note 里写清要换的思路；做不到、需要用户决定（越界、需求矛盾、要看界面效果）→ block 并写明原因。';
