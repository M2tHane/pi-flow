// 组装子进程提示：稳定内容（角色提示、规则）进系统提示，动态内容（任务、handoff、打回意见）进用户消息。
// 顺序固定：角色提示 → global 规则 → scope 规则 → 技能 → 项目知识 → 任务说明与输入 → 上游 handoff → handoff → 打回意见，
// 以便命中提供商的提示缓存（项目知识按编号只追加，放在系统提示末尾，新增条目只影响其后的部分）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { AgentDef } from './agents.ts';
import type { TaskFile } from './schemas.ts';

export interface RuleFile { path: string; content: string }

export const GLOBAL_RULES = 'rules/global.md';
const HANDOFF_TAIL = 6000;
/** 每个上游任务的 handoff 取最近部分的字数，以及所有上游合计的上限 */
export const UPSTREAM_TAIL = 800;
export const UPSTREAM_TOTAL = 4000;

/** global.md 加上任务 scopes 对应的规则文件（按 scope 顺序去重）；路径相对项目根。 */
export function ruleFilesFor(config: FlowConfig, projectRoot: string, scopes: readonly string[]): { rules: RuleFile[]; missing: string[] } {
  const wanted = [GLOBAL_RULES, ...scopes.flatMap((s) => config.raw.scopes[s]?.rules ?? [])];
  const rules: RuleFile[] = [];
  const missing: string[] = [];
  for (const rel of [...new Set(wanted)]) {
    const abs = path.join(projectRoot, rel);
    if (existsSync(abs)) rules.push({ path: rel, content: readFileSync(abs, 'utf8').trim() });
    else missing.push(rel);
  }
  return { rules, missing };
}

export interface AssembleInput {
  agent: AgentDef;
  rules: RuleFile[];
  /** 本任务注入的技能（稳定内容，排在规则之后） */
  skills?: RuleFile[];
  task: TaskFile;
  flowId: string;
  handoff: string;
  mode: 'impl' | 'review';
  commands: Record<string, string>;
  /** 审查模式：base_sha..HEAD 的 diff --stat */
  diffStat?: string;
  /** 实施模式：worktree 中本任务之前的运行留下的改动（git status 与相对 base_sha 的 diff --stat） */
  existingWork?: string;
  /** 本任务承载的先行验收测试（已在分支中，不属于本任务的 diff） */
  carriedTest?: { id: string; title: string; writes: readonly string[] };
  /** 本任务是先行验收测试：实现尚不存在，verify 应当失败 */
  leadingTest?: boolean;
  /** 适用于本任务的项目知识（已格式化，按编号排序） */
  knowledge?: string[];
  /** 本任务验证输出（evidence）所在目录（审查时可读） */
  evidenceDir?: string;
  /** 本 run 的临时目录（实施类角色） */
  scratchDir?: string;
  /** 本任务依赖的上游任务（硬依赖与软依赖）及其 handoff */
  upstream?: { id: string; title: string; type: 'hard' | 'soft'; status: string; handoff: string }[];
}

/** 取 handoff 的最近部分，从完整的行开始 */
function tail(text: string, n: number): string {
  const t = text.trim();
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  const nl = cut.indexOf('\n');
  return `…${nl >= 0 && nl < n / 2 ? cut.slice(nl + 1) : cut}`;
}

/** 上游任务的 handoff 摘要；没有上游或上游都没有 handoff 时返回空 */
export function upstreamSection(ups: NonNullable<AssembleInput['upstream']>): string {
  const blocks: string[] = [];
  let used = 0;
  for (const u of ups) {
    if (!u.handoff.trim() || used >= UPSTREAM_TOTAL) continue;
    const body = tail(u.handoff, Math.min(UPSTREAM_TAIL, UPSTREAM_TOTAL - used));
    used += body.length;
    blocks.push(`### ${u.id}「${u.title}」（${u.type === 'hard' ? '硬依赖' : '软依赖'}，${u.status}）\n${body}`);
  }
  return blocks.length ? `## 上游任务的 handoff（摘要，仅保留最近部分）\n上游任务留下的进展、约定与踩过的坑；需要细节时读取对应文件。\n\n${blocks.join('\n\n')}` : '';
}

export interface AssembledPrompt { system: string; user: string }

const list = (xs: readonly string[], empty = '（无）') => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);

export function assemblePrompt(i: AssembleInput): AssembledPrompt {
  const system = [
    i.agent.prompt,
    i.rules.length
      ? `# 本次生效的规则\n\n${i.rules.map((r) => `## ${r.path}\n\n${r.content}`).join('\n\n')}`
      : '# 本次生效的规则\n\n（无规则文件）',
    ...(i.skills?.length ? [`# 本任务使用的技能\n\n${i.skills.map((r) => `## ${r.path}\n\n${r.content}`).join('\n\n')}`] : []),
    ...(i.knowledge?.length ? [`# 项目知识\n\n此前的任务积累的经验，供参考；不是规则，与上面的规则冲突时以规则为准。发现新的约定或坑时用 flow_learn 补充。\n\n${i.knowledge.map((k) => `- ${k}`).join('\n')}`] : []),
  ].join('\n\n');

  const t = i.task;
  const verify = t.verify.map((c) => `${c}：\`${i.commands[c] ?? '（未定义）'}\``);
  const parts = [
    `# 任务 ${i.flowId}/${t.id}：${t.title}`,
    `类型：${t.kind}　阶段：${t.stage}　角色：${t.role}`,
    `## 验收标准\n${list(t.acceptance)}`,
    `## 输入文件\n${list(t.inputs)}`,
    `## 可写范围（writes）\n${list(t.conflict_files ?? t.writes)}`,
    `## verify 命令\n${list(verify)}`,
  ];
  if (i.leadingTest) {
    parts.push(i.mode === 'review'
      ? '## 先行验收测试\n这是先于实现写好的验收测试。审查通过后程序会运行 verify 并要求它失败；请重点检查断言是否真正覆盖验收标准，有没有用跳过、条件判断或捕获异常让测试在没有实现时通过。'
      : '## 先行验收测试\n实现还不存在，本任务的测试此时应当失败。审查通过后程序会运行 verify 并**要求失败**，通过的测试会被打回。不要用跳过、条件判断或捕获异常让测试在没有实现时通过；自检时确认测试因"实现缺失"而失败，而不是因为测试本身写错。');
  }
  if (i.carriedTest) {
    const ct = i.carriedTest;
    parts.push(`## 已在分支中的验收测试\n${ct.id}「${ct.title}」写的验收测试已在本任务的基线中（${ct.writes.join('、')}），实现前它们失败。${i.mode === 'review' ? '它们不在待审查的 diff 中，但会随本任务一并合入；请确认实现确实让这些测试通过。' : '本任务完成后它们必须通过；不得修改这些测试，它们会随本任务一并合入。'}`);
  }
  if (i.mode === 'review') {
    parts.push(`## 待审查的改动\n基线提交 base_sha：${t.base_sha ?? '（未知）'}\n用 \`git diff ${t.base_sha ?? '<base_sha>'} HEAD\` 查看完整改动。${i.evidenceDir ? `之前的验证输出（如有）在 \`${i.evidenceDir}\`。` : ''}\n\n\`\`\`\n${(i.diffStat ?? '').trim() || '（无）'}\n\`\`\``);
  }
  if (i.mode === 'impl' && i.scratchDir) {
    parts.push(`## 临时目录\n需要做临时实验（建临时文件、跑一次性脚本）时放在 \`${i.scratchDir}\`：可以 cd 进去，可以建、删、移动文件，本次运行结束后自动删除。不要在 worktree 里建临时文件：worktree 中只能写、删除、移动本任务 writes 内的文件，writes 之外的改动会让提交被拒。`);
  }
  if (i.mode === 'impl' && i.existingWork?.trim()) {
    parts.push(`## 工作区已有的改动\n这些改动是本任务之前的运行留下的（会话中断或被打回前的工作），还没有通过审查。先用 \`git status\` 与 \`git diff ${t.base_sha ?? '<base_sha>'}\` 检查，再决定继续完善还是重写；不要无故丢弃仍然有用的部分。\n\n\`\`\`\n${i.existingWork.trim()}\n\`\`\``);
  }
  const up = i.mode === 'impl' && i.upstream?.length ? upstreamSection(i.upstream) : '';
  if (up) parts.push(up);
  if (i.handoff.trim()) {
    const h = i.handoff.trim();
    parts.push(`## handoff 笔记${h.length > HANDOFF_TAIL ? '（仅保留最近部分）' : ''}\n${h.slice(-HANDOFF_TAIL)}`);
  }
  if (t.last_failure) parts.push(`## 上次未通过的原因（请先处理）\n${t.last_failure}`);
  parts.push(i.mode === 'review'
    ? '开始：审查上述改动，最后调用 flow_approve 给出结论。'
    : '开始：先调用 flow_claim，然后按工作流程完成任务，最后 flow_note 写 handoff 并 flow_submit。');
  return { system, user: parts.join('\n\n') };
}
