// 需求访谈：开流程之前，主会话与用户一问一答，按清单整理需求；程序保存摘要，用户确认后才开流程。
import type { StateStore } from '../core/state-store.ts';
import type { BriefFile } from '../core/schemas.ts';

export type InterviewMode = 'build' | 'feature' | 'fix';

export interface Section { key: string; label: string; hint: string }

export const CHECKLISTS: Record<InterviewMode, Section[]> = {
  build: [
    { key: 'goal', label: '目标', hint: '为什么做、要达成什么（尽量可衡量）' },
    { key: 'users', label: '用户与场景', hint: '谁在什么场景下使用' },
    { key: 'scope', label: '功能范围', hint: '要做哪些功能，每个功能的输入、输出、主要流程' },
    { key: 'non_goals', label: '非目标', hint: '明确不做的事' },
    { key: 'acceptance', label: '验收标准', hint: '每条都能被测试验证，写清输入与期望输出' },
    { key: 'constraints', label: '约束与假设', hint: '技术、平台、性能、时间等约束；没有就写"无"' },
  ],
  feature: [
    { key: 'goal', label: '目标', hint: '这个功能解决什么问题' },
    { key: 'non_goals', label: '非目标', hint: '这次不做什么' },
    { key: 'acceptance', label: '验收标准', hint: '每条都能被测试验证' },
    { key: 'impact', label: '可能影响的模块', hint: '依据现有文档的初步判断' },
    { key: 'contract', label: '是否需要改契约', hint: '是/否/不确定，以及原因' },
  ],
  fix: [
    { key: 'symptom', label: '现象', hint: '看到了什么问题' },
    { key: 'repro', label: '复现步骤', hint: '一步步怎么触发' },
    { key: 'expected', label: '期望行为', hint: '' },
    { key: 'actual', label: '实际行为', hint: '错误信息、返回值等' },
    { key: 'scope', label: '出现范围', hint: '哪个页面、接口或命令；是否稳定复现' },
  ],
};

export const MODE_LABEL: Record<InterviewMode, string> = { build: '新项目', feature: '新功能', fix: '修复' };
export const CONFIRM_COMMAND: Record<InterviewMode, string> = { build: '/flow-build --confirm', feature: '/flow-build --confirm', fix: '/flow-fix --confirm' };

export function missingSections(b: BriefFile): Section[] {
  return CHECKLISTS[b.mode].filter((s) => !(b.sections[s.key] ?? '').trim());
}

export function renderBrief(b: BriefFile): string {
  return [
    `# 需求摘要（${MODE_LABEL[b.mode]}）`,
    '',
    `用户的初始描述：${b.description || '（无）'}`,
    '',
    ...CHECKLISTS[b.mode].flatMap((s) => [`## ${s.label}`, (b.sections[s.key] ?? '').trim() || '（未填写）', '']),
  ].join('\n');
}

export async function startBrief(store: StateStore, mode: InterviewMode, description: string): Promise<BriefFile> {
  return store.writeBrief((_cur, ts) => ({
    mode, description, sections: {}, status: 'collecting', flow: null, created_at: ts, updated_at: ts,
  }), 'human', `开始需求访谈（${MODE_LABEL[mode]}）`);
}

export function activeBrief(store: StateStore): BriefFile | null {
  const b = store.readBrief();
  return b?.status === 'collecting' ? b : null;
}

/** flow_brief 工具：更新一个或多个小节；返回仍缺的小节 */
export async function updateBrief(store: StateStore, updates: Record<string, string>): Promise<{ brief: BriefFile; missing: Section[] }> {
  const cur = activeBrief(store);
  if (!cur) throw new Error('当前没有进行中的需求访谈。');
  const keys = new Set(CHECKLISTS[cur.mode].map((s) => s.key));
  const bad = Object.keys(updates).filter((k) => !keys.has(k));
  if (bad.length) throw new Error(`未知的小节：${bad.join('、')}。可用：${[...keys].join('、')}`);
  const brief = await store.writeBrief((c, ts) => ({ ...c!, sections: { ...c!.sections, ...updates }, updated_at: ts }), 'interviewer', `更新需求摘要：${Object.keys(updates).join('、')}`);
  return { brief, missing: missingSections(brief) };
}

export async function cancelBrief(store: StateStore): Promise<void> {
  const cur = activeBrief(store);
  if (!cur) throw new Error('当前没有进行中的需求访谈。');
  await store.writeBrief((c, ts) => ({ ...c!, status: 'cancelled', updated_at: ts }), 'human', '取消需求访谈');
}

/** 用户确认：清单必须全部填写；标记为 confirmed 并返回摘要正文 */
export async function confirmBrief(store: StateStore, mode: InterviewMode): Promise<BriefFile> {
  const cur = activeBrief(store);
  if (!cur) throw new Error('当前没有进行中的需求访谈。先执行 /flow-build "<描述>"、/flow-build --feature "<描述>" 或 /flow-fix "<描述>"。');
  if ((cur.mode === 'fix') !== (mode === 'fix')) throw new Error(`进行中的访谈是${MODE_LABEL[cur.mode]}，请用 ${CONFIRM_COMMAND[cur.mode]} 确认。`);
  const missing = missingSections(cur);
  if (missing.length) throw new Error(`需求还不完整，缺少：${missing.map((s) => s.label).join('、')}。请继续回答访谈中的问题。`);
  return cur;
}

export async function markConfirmed(store: StateStore, flow: string): Promise<void> {
  await store.writeBrief((c, ts) => ({ ...c!, status: 'confirmed', flow, updated_at: ts }), 'human', '确认需求摘要');
}

/** 每轮注入给访谈者的上下文 */
export function interviewContext(b: BriefFile): string {
  const missing = missingSections(b);
  const filled = CHECKLISTS[b.mode].filter((s) => (b.sections[s.key] ?? '').trim());
  return [
    `[需求访谈：${MODE_LABEL[b.mode]}] 用户的初始描述：${b.description || '（无）'}`,
    `已记录：${filled.map((s) => s.label).join('、') || '无'}`,
    missing.length
      ? `待补充：${missing.map((s) => `${s.label}（key=${s.key}${s.hint ? `，${s.hint}` : ''}）`).join('；')}`
      : `清单已填完：向用户展示完整摘要，请其执行 ${CONFIRM_COMMAND[b.mode]} 开始；或按其修改意见更新。`,
  ].join('\n');
}
