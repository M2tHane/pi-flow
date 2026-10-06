// /flow-fix（第五轮）：一个实现者定位并修复（加回归测试）→ 合并（全量测试，直接合入主分支）→ 独立验收者复现确认已修好 → 修复日志。
// 每一步由程序推进，不建 DAG；验收不通过时交回实现者的会话修复，两轮仍不过转"需要你处理"。
import type { FlowConfig } from '../core/config.ts';
import type { StateStore } from '../core/state-store.ts';
import type { FlowFile, TaskFile } from '../core/schemas.ts';
import { git } from '../core/git.ts';
import { costReport, formatRow } from '../core/cost.ts';
import { acceptanceStep } from '../core/acceptance.ts';

export interface FixContext {
  root: string;
  store: StateStore;
  config: FlowConfig;
  dispatch(flowId: string, taskId: string): Promise<unknown>;
  promote(flowId: string): Promise<unknown>;
  now?: () => Date;
}

export const FIX_ROLE = 'implementer';

export async function fixStep(c: FixContext, flowId: string): Promise<void> {
  const flow = c.store.readFlow(flowId);
  if (flow.stage_status !== 'active') return;
  let fix = c.store.listTasks(flowId).find((t) => t.kind === 'impl');
  if (!fix) {
    const brief = c.store.readFlowBrief(flowId).trim();
    const r = c.config.role(FIX_ROLE);
    await c.store.addTasks(flowId, [{
      id: 'T-001', stage: flow.stage, kind: 'impl', title: `修复：${flow.title}`.slice(0, 200), role: FIX_ROLE, scopes: [...r.scopes],
      depends_on: [], inputs: [], writes: ['**'], verify: c.config.commands['test'] ? ['test'] : [], needs_acceptance: true,
      acceptance: ['所报告的问题不再出现：写明复现步骤与修复后的结果', '新增回归测试覆盖这个问题（修复前失败、修复后通过）', '只改与这个问题相关的代码，全量测试通过'],
    }], 'engine');
    await c.store.appendHandoff(flowId, 'T-001', `用户报告的问题：\n${brief || flow.title}\n\n先定位根因（读代码、复现），再修复并加回归测试。改动较大（超过 ${c.config.limits.fix_max_files} 个文件或要改模块之间的接口）时用 flow_block 说明，建议改用 /flow-build --feature。`, 'engine');
    fix = c.store.readTask(flowId, 'T-001');
  }
  // 合并后派验收者复现确认；没通过的交回实现者修复、再复查
  await acceptanceStep({ root: c.root, store: c.store, config: c.config }, flowId);
  await c.promote(flowId);
  for (const t of c.store.listTasks(flowId)) {
    if (t.status === 'ready') await c.dispatch(flowId, t.id);
  }
  fix = c.store.readTask(flowId, fix.id);
  if (!fix.accepted) return;
  await writeFixLog(c, flow, fix);
  await c.store.transitionStage(flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await c.store.transitionStage(flowId, { to: 'done', trigger: 'gate_passed', actor: 'engine', needs_human: false });
  await c.store.advanceStage(flowId, 'engine');
}

async function writeFixLog(c: FixContext, flow: FlowFile, fix: TaskFile): Promise<void> {
  const events = c.store.readEvents().filter((e) => e.flow === flow.id);
  const merges = events.filter((e) => e.type === 'merge');
  const first = merges[0];
  const last = merges.at(-1);
  const from = typeof first?.data?.['from'] === 'string' ? first.data['from'] : '';
  const to = last?.evidence ?? '';
  const files = to ? git(c.root, from ? ['diff', '--stat', from, to, '--', '.', ':(exclude).flow'] : ['show', '--stat', '--format=', to]).trim() : '（无）';
  const a = c.store.readAcceptance(flow.id, fix.id);
  const cost = costReport(c.store, { flow: flow.id });
  const date = (c.now?.() ?? new Date()).toISOString().slice(0, 10);
  const seq = c.store.listFixLogs().filter((x) => x.startsWith(date)).length + 1;
  const name = `${date}-${String(seq).padStart(3, '0')}.md`;
  const content = [
    `# 修复 ${flow.id}：${flow.title}`,
    '',
    `- 日期：${date}`,
    `- 合入：${c.config.raw.main_branch}${to ? `（${to.slice(0, 8)}）` : ''}`,
    '',
    '## 问题', flow.title, '',
    '## 改动', '```', files, '```', '',
    '## 验收',
    ...(a ? a.criteria.map((x) => { const r = a.results.find((y) => y.id === x.id); return `- ${x.id} ${x.text}：${r ? (r.passed ? '通过' : '未通过') : '未回答'}${r?.evidence ? `（${r.evidence}）` : ''}`; }) : ['- （无记录）']),
    ...(a?.round ? [`- 修复轮次：${a.round}`] : []),
    '',
    '## 成本',
    `- ${formatRow(cost.total)}`,
    ...cost.byRole.map((r) => `- ${formatRow(r)}`),
    '',
  ].join('\n');
  await c.store.writeFixLog(name, content, flow.id);
}
