// 规则与命令草案（S1/F1）：architect 在 docs/rules-draft/ 写草案，随文档合入集成分支；
// 用户确认后由程序写入主工作区的 rules/ 与 workflow.yaml 并提交。agent 不能直接改 rules/ 与 workflow.yaml。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, parse as parseYaml, isMap } from 'yaml';
import { parseConfig } from './config.ts';
import { git, gitOk } from './git.ts';

export const DRAFT_DIR = 'docs/rules-draft';

export interface Draft {
  kind: 'rule' | 'commands';
  /** 草案路径（相对仓库根） */
  file: string;
  /** 写入目标 */
  target: string;
  content: string;
  /** 目标当前内容（新文件为 null） */
  current: string | null;
  /** 变更摘要 */
  summary: string;
}

function lineDiff(cur: string | null, next: string): string {
  if (cur === null) return `新文件，${next.trim().split('\n').length} 行`;
  const a = new Set(cur.split('\n').map((l) => l.trim()).filter(Boolean));
  const b = new Set(next.split('\n').map((l) => l.trim()).filter(Boolean));
  const add = [...b].filter((l) => !a.has(l)).length;
  const del = [...a].filter((l) => !b.has(l)).length;
  return add || del ? `+${add} 行，-${del} 行` : '与现有内容相同';
}

function parseCommands(text: string, file: string): Record<string, string> {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { throw new Error(`${file} 不是合法 YAML：${(e as Error).message}`); }
  const cmds = (raw as { commands?: unknown } | null)?.commands ?? raw;
  if (!cmds || typeof cmds !== 'object' || Array.isArray(cmds)) throw new Error(`${file} 应为 commands: { 名称: "命令" } 的映射`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cmds)) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${file} 中 ${k} 的命令必须是非空字符串`);
    out[k] = v;
  }
  return out;
}

/** 列出某个 git 引用（通常是集成分支）上的草案，并与主工作区现状比较 */
export function listDrafts(root: string, ref: string): Draft[] {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', ref])) return [];
  const files = git(root, ['ls-tree', '-r', '--name-only', ref, '--', DRAFT_DIR]).split('\n').filter(Boolean).sort();
  const out: Draft[] = [];
  for (const file of files) {
    const content = git(root, ['show', `${ref}:${file}`]);
    const base = path.posix.basename(file);
    if (base === 'commands.yaml' || base === 'commands.yml') {
      const next = parseCommands(content, file);
      const cur = (parseYaml(readFileSync(path.join(root, 'workflow.yaml'), 'utf8')) as { commands: Record<string, string> }).commands ?? {};
      const changes = Object.entries(next).filter(([k, v]) => cur[k] !== v).map(([k, v]) => `${k}：${cur[k] ? `"${cur[k]}" → ` : '新增 '}"${v}"`);
      out.push({ kind: 'commands', file, target: 'workflow.yaml', content, current: null, summary: changes.length ? changes.join('；') : '与现有命令相同' });
    } else if (base.endsWith('.md')) {
      const target = `rules/${base}`;
      const abs = path.join(root, target);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      out.push({ kind: 'rule', file, target, content, current, summary: lineDiff(current, content) });
    }
  }
  return out.filter((d) => !/相同$/.test(d.summary));
}

/** 写入选中的草案并提交；返回新的命令表（若命令有变化），供运行中的引擎更新配置 */
export function applyDrafts(root: string, drafts: Draft[], flowId: string): { applied: string[]; commands: Record<string, string> | null } {
  if (!drafts.length) return { applied: [], commands: null };
  const touched: string[] = [];
  let commands: Record<string, string> | null = null;
  for (const d of drafts.filter((x) => x.kind === 'commands')) {
    const file = path.join(root, 'workflow.yaml');
    const doc = parseDocument(readFileSync(file, 'utf8'));
    const node = doc.get('commands', true);
    if (!isMap(node)) throw new Error('workflow.yaml 缺少 commands 映射');
    for (const [k, v] of Object.entries(parseCommands(d.content, d.file))) doc.setIn(['commands', k], v);
    const text = doc.toString();
    parseConfig(text);
    writeFileSync(file, text);
    commands = (parseYaml(text) as { commands: Record<string, string> }).commands;
    touched.push('workflow.yaml');
  }
  for (const d of drafts.filter((x) => x.kind === 'rule')) {
    if (d.content.split('\n').length > 60) throw new Error(`${d.file} 超过 60 行；规则越长遵守越差，请让架构师精简`);
    mkdirSync(path.join(root, 'rules'), { recursive: true });
    writeFileSync(path.join(root, d.target), d.content.endsWith('\n') ? d.content : `${d.content}\n`);
    touched.push(d.target);
  }
  git(root, ['add', '--', ...touched]);
  if (!gitOk(root, ['diff', '--cached', '--quiet', '--', ...touched])) {
    git(root, ['commit', '-q', '--no-verify', '-m', `pi-flow: 应用 ${flowId} 的规则与命令草案`, '--', ...touched], { engineIdentity: true });
  }
  return { applied: touched, commands };
}

export function formatDrafts(drafts: Draft[]): string {
  return drafts.map((d) => `- ${d.file} → ${d.target}：${d.summary}`).join('\n');
}
