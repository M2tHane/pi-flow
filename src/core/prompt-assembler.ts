// 组装子进程提示：稳定内容（角色提示、规则）进系统提示，动态内容（任务、handoff、打回意见）进用户消息。
// 顺序固定：角色提示 → global 规则 → scope 规则 → 任务说明与输入 → handoff → 打回意见，以便命中提供商的提示缓存。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { AgentDef } from './agents.ts';
import type { TaskFile } from './schemas.ts';

export interface RuleFile { path: string; content: string }

export const GLOBAL_RULES = 'rules/global.md';
const HANDOFF_TAIL = 6000;

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
  task: TaskFile;
  flowId: string;
  handoff: string;
  mode: 'impl' | 'review';
  commands: Record<string, string>;
  /** 审查模式：base_sha..HEAD 的 diff --stat */
  diffStat?: string;
}

export interface AssembledPrompt { system: string; user: string }

const list = (xs: readonly string[], empty = '（无）') => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);

export function assemblePrompt(i: AssembleInput): AssembledPrompt {
  const system = [
    i.agent.prompt,
    i.rules.length
      ? `# 本次生效的规则\n\n${i.rules.map((r) => `## ${r.path}\n\n${r.content}`).join('\n\n')}`
      : '# 本次生效的规则\n\n（无规则文件）',
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
  if (i.mode === 'review') {
    parts.push(`## 待审查的改动\n基线提交 base_sha：${t.base_sha ?? '（未知）'}\n用 \`git diff ${t.base_sha ?? '<base_sha>'} HEAD\` 查看完整改动。\n\n\`\`\`\n${(i.diffStat ?? '').trim() || '（无）'}\n\`\`\``);
  }
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
