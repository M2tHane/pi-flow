// 角色定义：agents/<role>.md（frontmatter + 系统提示正文）。项目可在 .pi/agents/<role>.md 覆盖。
// frontmatter 与 pi-subagents 兼容的字段：name、description、thinking；档位用 tier（不用 model，避免与 provider/id 语义冲突）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { THINKING_LEVELS, type ThinkingLevel } from './schemas.ts';

export interface AgentDef {
  name: string;
  description: string;
  tier: string | null;
  thinking: ThinkingLevel | null;
  prompt: string;
}

export function parseAgentFile(text: string, file: string): AgentDef {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} 缺少 frontmatter（以 --- 开头的 YAML 头）`);
  const fm = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  const thinking = typeof fm['thinking'] === 'string' && (THINKING_LEVELS as readonly string[]).includes(fm['thinking'])
    ? (fm['thinking'] as ThinkingLevel) : null;
  return {
    name: String(fm['name'] ?? path.basename(file, '.md')),
    description: String(fm['description'] ?? ''),
    tier: typeof fm['tier'] === 'string' ? fm['tier'] : null,
    thinking,
    prompt: m[2]!.trim(),
  };
}

export function loadAgent(role: string, projectRoot: string, packageAgentsDir: string): AgentDef {
  for (const file of [path.join(projectRoot, '.pi', 'agents', `${role}.md`), path.join(packageAgentsDir, `${role}.md`)]) {
    if (existsSync(file)) return parseAgentFile(readFileSync(file, 'utf8'), file);
  }
  throw new Error(`找不到角色 ${role} 的定义（.pi/agents/${role}.md 或包内 agents/${role}.md）`);
}
