// 恢复（第 18 节）：只依赖 .flow/ 与 git，不依赖对话历史。
// 1 重放事务日志并校验完整性（不一致则记 integrity_error 并停止）→ 2 活动流程 → 3 清理残留子进程 → 4 处理租约
// → 5 恢复中断的合并 → 6 生成 resume brief。
import { existsSync } from 'node:fs';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import type { TaskFile } from './schemas.ts';
import { git } from './git.ts';
import { removeWorktree } from './worktree.ts';
import { MergeQueue } from './merge-queue.ts';
import { statusText } from '../tools/orchestrator-tools.ts';

export interface ResumeDecision {
  flow: string;
  task: string;
  worktree: string;
  /** worktree 中未提交的改动 */
  changes: string[];
}

export type DecisionAnswer = 'continue' | 'discard';

export interface ResumeDeps {
  root: string;
  store: StateStore;
  config: FlowConfig;
  now?: () => Date;
  /** 本会话引擎中仍在运行的 run（不当作残留处理） */
  activeRunIds?: Set<string>;
  isAlive?: (pid: number) => boolean;
  killGroup?: (pid: number) => void;
}

export interface ResumeReport {
  ok: boolean;
  integrityErrors: string[];
  replayedJournal: boolean;
  actions: string[];
  pending: ResumeDecision[];
  brief: string;
}

export const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
export const killProcessGroup = (pid: number) => {
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch { /* 已退出 */ }
  }
};

export async function resume(d: ResumeDeps, decide?: (q: ResumeDecision) => Promise<DecisionAnswer | undefined>): Promise<ResumeReport> {
  const { store } = d;
  const now = d.now ?? (() => new Date());
  const isAlive = d.isAlive ?? processAlive;
  const kill = d.killGroup ?? killProcessGroup;
  const active = d.activeRunIds ?? new Set<string>();
  const actions: string[] = [];
  const pending: ResumeDecision[] = [];

  // 1. 事务日志与完整性
  const replayedJournal = await store.recover();
  if (replayedJournal) actions.push('重放了未完成的事务日志');
  const integrity = await store.verifyIntegrity();
  if (!integrity.ok) {
    await store.appendIntegrityError(integrity.errors);
    return {
      ok: false, integrityErrors: integrity.errors, replayedJournal, actions, pending,
      brief: `pi-flow 状态完整性校验失败，已停止，未做任何恢复操作：\n${integrity.errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}\n请用户检查后执行 /flow doctor。`,
    };
  }

  // 2. 活动流程
  const flowId = store.readState().active_flow;

  // 3. 残留子进程（无论属于哪个流程）
  for (const r of store.listRuns()) {
    if (r.ended_at || active.has(r.run_id)) continue;
    if (r.pid && isAlive(r.pid)) {
      kill(r.pid);
      actions.push(`终止残留子进程 ${r.run_id}（pid ${r.pid}）`);
    }
    await store.updateRun(r.run_id, { ended_at: now().toISOString(), ...(r.outcome ? {} : { outcome: 'killed' }) }, 'resume', '恢复：run 已中断');
  }
  if (!flowId) return { ok: true, integrityErrors: [], replayedJournal, actions, pending, brief: '当前没有进行中的流程。' };

  // 4. 租约
  for (const t of store.listTasks(flowId)) {
    if (!t.lease || active.has(t.lease.run_id)) continue;
    const expired = now().getTime() >= Date.parse(t.lease.expires_at);
    if (!expired) {
      // 会话中断不是 subagent 的错：只记中断次数，不消耗失败预算
      const next = await store.transitionTask(flowId, t.id, { to: t.status, trigger: 'run_interrupted', actor: 'resume',
        facts: { reason: `会话中断，run ${t.lease.run_id} 已终止${expired ? '且租约过期' : ''}` } });
      actions.push(next.status === 'blocked'
        ? `${t.id}：会话已连续中断 ${next.interruptions} 次，转为阻塞`
        : `${t.id}：run 已中断，保留 worktree，稍后重新派发（不计入失败次数）`);
      continue;
    }
    // in_progress 且租约过期
    const wt = t.worktree;
    const changes = wt && existsSync(wt) ? git(wt, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean) : [];
    if (!changes.length) {
      await expireToReady(d, flowId, t);
      actions.push(`${t.id}：租约过期且 worktree 干净，回到 ready`);
      continue;
    }
    const q: ResumeDecision = { flow: flowId, task: t.id, worktree: wt!, changes };
    const answer = decide ? await decide(q) : undefined;
    if (answer === 'continue') {
      await store.transitionTask(flowId, t.id, { to: 'in_progress', trigger: 'run_failed', actor: 'human',
        facts: { reason: '租约过期；用户选择保留未提交的改动继续' } });
      actions.push(`${t.id}：用户选择继续，保留未提交改动，稍后重新派发`);
    } else if (answer === 'discard') {
      git(wt!, ['reset', '-q', '--hard']);
      git(wt!, ['clean', '-q', '-fd']);
      await expireToReady(d, flowId, t);
      actions.push(`${t.id}：用户选择丢弃未提交改动，回到 ready`);
    } else {
      pending.push(q);
    }
  }

  // 5. 中断的合并
  const mq = new MergeQueue(d.root, store, d.config);
  const merged = await mq.recoverInterrupted(flowId);
  if (merged) actions.push(`合并中断的任务：${merged === 'done' ? '集成分支已包含其提交，补完为 done' : merged === 'requeued' ? '放回合并队首' : '无法恢复，转 blocked'}`);

  return { ok: true, integrityErrors: [], replayedJournal, actions, pending, brief: resumeBrief(store, flowId, actions, pending) };
}

async function expireToReady(d: ResumeDeps, flowId: string, t: TaskFile): Promise<void> {
  await d.store.transitionTask(flowId, t.id, { to: 'ready', trigger: 'lease_expired', actor: 'resume', facts: { worktree_clean: true } });
  if (t.worktree) removeWorktree(d.root, t.worktree, t.branch ?? undefined);
  await d.store.recordEvent({ flow: flowId, task: t.id, actor: 'resume', type: 'lease_expired', reason: '租约过期，任务回到 ready' });
}

/** resume brief：当前流程与阶段、ready 与进行中的任务、相关 handoff 的最近内容、最近 10 条事件、等待用户处理的事项 */
export function resumeBrief(store: StateStore, flowId: string, actions: string[], pending: ResumeDecision[]): string {
  const tasks = store.listTasks(flowId);
  const inflight = tasks.filter((t) => ['in_progress', 'queued_merge', 'merging'].includes(t.status));
  const handoffs = inflight.map((t) => {
    const h = store.readHandoff(flowId, t.id).trim();
    return h ? `### ${t.id}（${t.status}）\n${h.slice(-800)}` : '';
  }).filter(Boolean);
  const events = store.readEvents().slice(-10).map((e) =>
    `- #${e.seq} ${e.ts.slice(5, 19).replace('T', ' ')} ${e.type}${e.task ? ` ${e.task}` : ''}${e.from ? ` ${e.from}→${e.to}` : ''}${e.reason ? `：${e.reason.slice(0, 80)}` : ''}`);
  return [
    '# pi-flow 恢复摘要',
    statusText(store, null, flowId),
    actions.length ? `## 本次恢复操作\n${actions.map((a) => `- ${a}`).join('\n')}` : '## 本次恢复操作\n- 无需处理',
    pending.length ? `## 需要用户决定\n${pending.map((q) => `- ${q.task}：租约已过期，worktree 有 ${q.changes.length} 处未提交改动。继续（保留改动重新派发）或丢弃？执行 /flow-resume 并选择。`).join('\n')}` : '',
    handoffs.length ? `## 进行中任务的 handoff（最近部分）\n${handoffs.join('\n\n')}` : '',
    `## 最近事件\n${events.join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

