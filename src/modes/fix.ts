// /flow-fix（第 19 节）：scout 定位 → 升级判断 → 复现测试（必须先失败）→ 修复 → 审查 → verify → 直接合入主分支 → fix 日志（含成本）。
// 每一步的任务由程序创建并派发，不建 DAG。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../core/config.ts';
import type { StateStore, TaskInput } from '../core/state-store.ts';
import type { FlowFile, TaskFile } from '../core/schemas.ts';
import { git } from '../core/git.ts';
import { globWithin, matchesAny } from '../core/paths.ts';
import { headSha, removeWorktree, taskBranch, worktreePath } from '../core/worktree.ts';
import { costReport, formatRow } from '../core/cost.ts';

export interface FixContext {
  root: string;
  store: StateStore;
  config: FlowConfig;
  dispatch(flowId: string, taskId: string): Promise<unknown>;
  promote(flowId: string): Promise<unknown>;
  now?: () => Date;
}

const SCOUT = 'scout';
const REPRO_ROLE = 'test-engineer';

/** 用户已确认"超出 fix 规模仍按 fix 处理" */
export function escalationAcknowledged(store: StateStore, flowId: string): boolean {
  return store.readEvents().some((e) => e.flow === flowId && e.type === 'approval' && e.data?.['fix_escalation_ok'] === true);
}

/** 能承担修复的角色：建议角色若可写且覆盖全部影响文件则用它，否则找第一个覆盖全部影响文件的实施角色 */
export function chooseFixRole(config: FlowConfig, suggested: string, files: string[]): string | null {
  const covers = (role: string) => {
    const r = config.roles[role];
    return !!r && r.writes.length > 0 && r.tools.has('flow_submit') && files.every((f) => matchesAny(f, r.writes) || r.writes.some((w) => globWithin(f, w)));
  };
  if (covers(suggested)) return suggested;
  return Object.keys(config.roles).find((r) => r !== 'architect' && r !== 'orchestrator' && covers(r)) ?? null;
}

async function addOne(c: FixContext, flowId: string, t: TaskInput, handoff: string): Promise<string> {
  await c.store.addTasks(flowId, [t], 'engine');
  await c.store.appendHandoff(flowId, t.id, handoff, 'engine');
  await c.promote(flowId);
  return t.id;
}

async function dispatchReady(c: FixContext, flowId: string, t: TaskFile | undefined): Promise<void> {
  if (t?.status === 'pending') await c.promote(flowId);
  const cur = t ? c.store.readTask(flowId, t.id) : undefined;
  if (cur?.status === 'ready') await c.dispatch(flowId, cur.id);
}

const nextId = (store: StateStore, flowId: string) =>
  `T-${String(Math.max(0, ...store.listTasks(flowId).map((t) => Number(t.id.slice(2)))) + 1).padStart(3, '0')}`;

export async function fixStep(c: FixContext, flowId: string): Promise<void> {
  const flow = c.store.readFlow(flowId);
  if (flow.stage_status !== 'active') return;
  const tasks = c.store.listTasks(flowId);
  const scout = tasks.find((t) => t.kind === 'analysis');
  const repro = tasks.find((t) => t.kind === 'test');
  const fix = tasks.find((t) => t.kind === 'impl');

  // 1. scout 定位
  if (!scout) {
    const id = await addOne(c, flowId, {
      id: 'T-001', stage: 'X1', kind: 'analysis', title: `定位问题：${flow.title}`.slice(0, 200), role: SCOUT, scopes: [],
      depends_on: [], inputs: [], writes: [], verify: [],
      acceptance: ['给出问题位置与根因假设', '列出修复需要改动的具体文件（impact_files）', '判断是否需要改契约，并给出建议的实施角色'],
    }, `用户报告的问题：\n${flow.title}`);
    await c.dispatch(flowId, id);
    return;
  }
  if (scout.status !== 'done') return dispatchReady(c, flowId, scout);
  const f = scout.findings!;

  // 2. 升级判断 + 3. 复现测试
  if (!repro) {
    const role = chooseFixRole(c.config, f.suggested_role, f.impact_files);
    const tooBig = f.contract_change || f.estimated_files > c.config.limits.fix_max_files || f.impact_files.length > c.config.limits.fix_max_files;
    const reasons = [
      ...(f.contract_change ? ['需要修改契约'] : []),
      ...(tooBig && !f.contract_change ? [`预计改动 ${Math.max(f.estimated_files, f.impact_files.length)} 个文件，超过 fix_max_files=${c.config.limits.fix_max_files}`] : []),
      ...(!role ? [`没有角色的可写范围覆盖影响文件：${f.impact_files.join('、')}`] : []),
    ];
    if (reasons.length && !escalationAcknowledged(c.store, flowId)) {
      await c.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await c.store.transitionStage(flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true,
        reason: `建议改用 /flow-build --feature：${reasons.join('；')}` });
      return;
    }
    if (!role) {
      await c.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await c.store.transitionStage(flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true,
        reason: `无法自动选择修复角色：${reasons.join('；')}。请改用 /flow-build --feature 或 /flow abort` });
      return;
    }
    const id = await addOne(c, flowId, {
      id: nextId(c.store, flowId), stage: 'X1', kind: 'test', title: `复现测试：${flow.title}`.slice(0, 200), role: REPRO_ROLE,
      scopes: ['acceptance'], depends_on: [], inputs: [...f.impact_files], writes: [`tests/acceptance/fixes/${flowId.toLowerCase()}/**`],
      verify: c.config.commands['test'] ? ['test'] : [],
      acceptance: ['新增的测试在修复前失败，失败原因正是所报告的问题', '测试名描述问题现象', '不修改业务代码'],
    }, `问题：${flow.title}\n位置：${f.location}\n根因假设：${f.root_cause}\n\n请写一个复现测试：修复前必须失败。程序会运行测试确认它失败。`);
    await c.dispatch(flowId, id);
    return;
  }
  if (repro.status !== 'done') return dispatchReady(c, flowId, repro);

  // 4. 修复：从复现测试的分支末端开始，writes 限定为 scout 给出的影响文件
  if (!fix) {
    const role = chooseFixRole(c.config, f.suggested_role, f.impact_files)!;
    const id = nextId(c.store, flowId);
    const wt = worktreePath(c.root, flowId, id);
    const branch = taskBranch(flowId, id);
    mkdirSync(path.dirname(wt), { recursive: true });
    git(c.root, ['worktree', 'add', '-q', '-b', branch, wt, repro.branch!]);
    const base = headSha(wt);
    const r = c.config.roles[role]!;
    const verify = ['typecheck', 'test'].filter((x) => c.config.commands[x]);
    await addOne(c, flowId, {
      id, stage: 'X1', kind: 'impl', title: `修复：${flow.title}`.slice(0, 200), role, scopes: [...r.scopes], depends_on: [],
      inputs: [...f.impact_files], writes: [...f.impact_files], verify, worktree: wt, branch, base_sha: base,
      acceptance: ['复现测试通过', '其他测试不受影响', '只修改影响文件'],
    }, `问题：${flow.title}\n位置：${f.location}\n根因假设：${f.root_cause}\n复现测试已在分支中（${repro.writes.join('、')}），修复前失败。\n请只修改：${f.impact_files.join('、')}。`);
    await c.dispatch(flowId, id);
    return;
  }
  if (fix.status !== 'done') {
    if (fix.status === 'pending' || fix.status === 'ready') await dispatchReady(c, flowId, fix);
    return;
  }

  // 5. 完成：清理复现测试的 worktree，写 fix 日志，结束
  if (repro.worktree) removeWorktree(c.root, repro.worktree, repro.branch ?? undefined);
  await writeFixLog(c, flow, scout, repro, fix);
  await c.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await c.store.transitionStage(flowId, { to: 'done', trigger: 'gate_passed', actor: 'engine', needs_human: false });
  await c.store.advanceStage(flowId, 'engine');
}

async function writeFixLog(c: FixContext, flow: FlowFile, scout: TaskFile, repro: TaskFile, fix: TaskFile): Promise<void> {
  const events = c.store.readEvents().filter((e) => e.flow === flow.id);
  const merge = [...events].reverse().find((e) => e.type === 'merge' && e.task === fix.id);
  const sha = merge?.evidence ?? '';
  const files = sha ? git(c.root, ['show', '--stat', '--format=', sha]).trim() : '（无）';
  const cost = costReport(c.store, { flow: flow.id });
  const date = (c.now?.() ?? new Date()).toISOString().slice(0, 10);
  const seq = c.store.listFixLogs().filter((x) => x.startsWith(date)).length + 1;
  const name = `${date}-${String(seq).padStart(3, '0')}.md`;
  const f = scout.findings!;
  const content = [
    `# 修复 ${flow.id}：${flow.title}`,
    '',
    `- 日期：${date}`,
    `- 合入：${c.config.raw.main_branch}${sha ? `（${sha.slice(0, 8)}）` : ''}`,
    '',
    '## 问题', flow.title, '',
    '## 根因', `位置：${f.location}`, `根因：${f.root_cause}`, '',
    '## 改动', '```', files, '```', '',
    '## 验证',
    `- 复现测试（${repro.id}）：修复前失败，已确认（evidence/${repro.id}/repro-*）`,
    `- 修复（${fix.id}）：verify ${fix.verify.join('、') || '无'} 通过，合并后验证通过`,
    `- 返工：${cost.rework.map((w) => `${w.task} ${w.total} 次`).join('，') || '无'}`,
    '',
    '## 成本',
    `- ${formatRow(cost.total)}`,
    ...cost.byRole.map((r) => `- ${formatRow(r)}`),
    '',
  ].join('\n');
  await c.store.writeFixLog(name, content, flow.id);
}

/** /flow approve 用于 fix 的升级确认：用户决定仍按 fix 处理 */
export async function continueFix(store: StateStore, flowId: string): Promise<string> {
  const flow = store.readFlow(flowId);
  if (flow.mode !== 'fix' || flow.stage_status !== 'awaiting_human') throw new Error('没有等待确认的修复');
  await store.recordEvent({ flow: flowId, actor: 'human', type: 'approval', reason: '用户确认仍按 fix 处理', data: { fix_escalation_ok: true } });
  await store.transitionStage(flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: '用户确认仍按 fix 处理' });
  return `已确认，${flowId} 继续按修复处理。`;
}
