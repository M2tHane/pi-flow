// 组装子进程提示：稳定内容（角色提示、规则、技能、项目知识）进系统提示，动态内容（任务、上游与本任务的 handoff、上次没通过的原因）进用户消息。
// 顺序固定，以便命中提供商的提示缓存（项目知识按编号只追加，放在系统提示末尾）。结构化笔记不在这里：由子进程扩展在每次请求时放在消息末尾。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { AgentDef } from './agents.ts';
import type { TaskFile } from './schemas.ts';

export interface RuleFile { path: string; content: string }

export const GLOBAL_RULES = 'rules/global.md';
const HANDOFF_TAIL = 6000;
/** 每个上游任务的 handoff 取最近部分的字数，以及所有上游合计的上限（需求汇总者要读两份完整意见，取得较大） */
export const UPSTREAM_TAIL = 8000;
export const UPSTREAM_TOTAL = 16000;

/** global.md 加上任务 scopes 对应的规则文件（按 scope 顺序去重）；路径相对项目根。缺失的文件跳过（例如规划阶段之前还没有 rules/project.md） */
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
  /** impl：需要提交改动或结论的任务；accept：独立验收（逐条验收或只复查没通过的条目） */
  mode: 'impl' | 'accept';
  /** 独立验收：check 逐条验收全部条目；confirm 只复查上次没通过的条目 */
  accept?: { kind: 'check' | 'confirm'; items: { id: string; text: string; last?: string }[] };
  commands: Record<string, string>;
  /** worktree 中本任务之前的运行留下的改动（git status 与相对 base_sha 的 diff --stat） */
  existingWork?: string;
  /** 适用于本任务的项目知识（已格式化，按编号排序） */
  knowledge?: string[];
  /** 本 run 的临时目录 */
  scratchDir?: string;
  /** 规划模块时（D2、计划修订）：实现者用的模型，决定模块大小；strong 表示与 architect 同档（强模型） */
  implModels?: { role: string; model: string; strong: boolean }[];
  /** 对话接在另一个任务（写过这些代码的任务，例如验收修复接着模块的实现者）的最后一次运行之后 */
  priorTask?: { id: string; title: string; run: string };
  /** 接着本任务上一次运行（run）的对话继续，只给简短的续做说明 */
  continuation?: { run: string };
  /** 本任务依赖的上游任务及其 handoff（需求汇总者从这里读两方意见） */
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
  return blocks.length ? `## 上游任务的 handoff\n上游任务留下的意见、进展与约定；内容太长时只保留最近部分，需要细节时读取对应文件。\n\n${blocks.join('\n\n')}` : '';
}

export interface AssembledPrompt { system: string; user: string }

const list = (xs: readonly string[], empty = '（无）') => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);

/** 返工时接着上一次的对话：任务说明、上游与 handoff 都已在对话里，只说明这次为什么回来、新的临时目录与开始方式 */
export function continuationPrompt(i: AssembleInput): string {
  const t = i.task;
  return [
    `# 继续任务 ${i.flowId}/${t.id}：${t.title}`,
    `这是同一任务的新一次运行，接着上面的对话继续（上次运行 ${i.continuation!.run}）。工作区保留着你上次的代码与本地提交。`,
    `## 上次提交后没有通过的原因（请先处理）\n${t.last_failure ?? '（无记录）'}`,
    ...(i.scratchDir ? [`## 临时目录\n本次运行的临时目录换成了 \`${i.scratchDir}\`（上次的已删除）。`] : []),
    '开始：本次运行的身份已更换，先调用 flow_claim；按上面的原因修改，然后 flow_note 写 handoff 并 flow_submit。',
  ].join('\n\n');
}

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
  const writes = [...(t.conflict_files ?? t.writes), ...(t.conflict_files ? [] : (t.shared ?? []).map((x) => `${x}（登记的公共文件：可以改，其他模块也可能改，只做必要的追加）`))];
  const parts = [
    `# 任务 ${i.flowId}/${t.id}：${t.title}`,
    `类型：${t.kind}　阶段：${t.stage}　角色：${t.role}`,
    `## 验收标准\n${list(t.acceptance)}`,
    `## 输入文件\n${list(t.inputs)}`,
    `## 可写范围（writes）\n${list(writes, '（只读）')}`,
    ...(verify.length ? [`## 全量测试命令\n${list(verify)}\n合并时程序会在集成分支最新代码上跑全量 typecheck、lint、test。`] : []),
  ];
  if (i.implModels?.length) {
    const strong = i.implModels.filter((m) => m.strong).length;
    parts.push(`## 实现者的模型（决定模块大小，见技能 plan-modules）\n${i.implModels.map((m) => `- ${m.role}：${m.model}${m.strong ? '（强模型）' : ''}`).join('\n')}\n${strong === i.implModels.length ? '实现者是强模型：模块可以大一些（一块完整的业务功能，含前后端与测试）。' : '实现者不是强模型：模块要小一些（一次会话能完成）。'}`);
  }
  if (i.priorTask) {
    parts.push(`## 接着你之前的对话\n上面的对话是你完成 ${i.priorTask.id}「${i.priorTask.title}」时的过程（run ${i.priorTask.run}），你熟悉这些代码，不必从头重读。那个任务已经合入；现在是一个新任务、新的 worktree（集成分支最新代码，可能包含别人之后的改动），文件路径与可写范围以本次说明为准。`);
  }
  if (i.scratchDir) {
    parts.push(`## 临时目录\n需要做临时实验、放运行产生的文件（数据库、日志、构建产物）时用 \`${i.scratchDir}\`：可以 cd 进去，可以建、删、移动文件，本次运行结束后自动删除。不要在 worktree 里留下临时文件。`);
  }
  if (i.existingWork?.trim()) {
    parts.push(`## 工作区已有的改动\n这些改动是本任务之前的运行留下的（会话中断或被退回前的工作），还没有合入集成分支。先用 \`git status\`、\`git log\` 与 \`git diff ${t.base_sha ?? '<base_sha>'}\` 检查，再决定继续完善还是重写；不要无故丢弃仍然有用的部分。\n\n\`\`\`\n${i.existingWork.trim()}\n\`\`\``);
  }
  const up = i.upstream?.length ? upstreamSection(i.upstream) : '';
  if (up) parts.push(up);
  if (i.handoff.trim()) {
    const h = i.handoff.trim();
    parts.push(`## handoff 笔记${h.length > HANDOFF_TAIL ? '（仅保留最近部分）' : ''}\n${h.slice(-HANDOFF_TAIL)}`);
  }
  if (t.last_failure) parts.push(`## 上次未通过的原因（请先处理）\n${t.last_failure}`);
  if (i.mode === 'accept' && i.accept) {
    parts.push(`## ${i.accept.kind === 'check' ? '逐条验收' : '只复查这些条目'}\n${i.accept.items.map((x) => `- ${x.id} ${x.text}${x.last ? `\n  上次结论：${x.last}` : ''}`).join('\n')}`);
    parts.push(`## 验收的要求\n1. 在当前工作区（集成分支最新代码）上构建并实际运行：启动服务、调用接口、打开页面、跑相关测试。临时文件、数据库、日志放在临时目录${i.scratchDir ? ` \`${i.scratchDir}\`` : ''}，不要改仓库里的文件。\n2. 每个条目给出 passed（true/false）与证据：运行的命令、请求与响应、看到的结果。没法验证的条目判为未通过并写明原因。\n3. 只看这些条目是否做到，不提风格偏好和重构建议。`);
    parts.push(i.accept.kind === 'check'
      ? '开始：构建并运行，逐条验收，最后调用 flow_accept 一次提交全部条目的结论。'
      : '开始：只复查上面的条目，最后调用 flow_accept_confirm 提交结论；只能回答这些编号，不能提出新问题。');
    return { system, user: parts.join('\n\n') };
  }
  parts.push('开始：先调用 flow_claim，然后按工作流程完成任务，最后 flow_note 写 handoff 并 flow_submit。');
  if (i.continuation) return { system, user: continuationPrompt(i) };
  return { system, user: parts.join('\n\n') };
}
