// 项目级知识库：跨流程积累的约定、坑、决策。agent 经 flow_learn 提交，程序校验后写入 .flow/knowledge.json。
// 知识不是规则：注入提示时标明"与规则冲突时以规则为准"；要成为规则必须经"规则草案 → 用户应用"。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory, type KnowledgeEntry, type KnowledgeFile, type TaskFile } from './schemas.ts';
import { globsOverlap } from './paths.ts';
import { DRAFT_DIR } from './rules-draft.ts';
import { git, gitOk } from './git.ts';
import { GLOBAL_RULES } from './prompt-assembler.ts';

export const KNOWLEDGE_CONTENT_MAX = 500;
export const KNOWLEDGE_PER_RUN = 3;
/** 注入提示的上限：条数与总字数（超出时保留编号最大的，即最近的） */
export const KNOWLEDGE_PROMPT_MAX = 40;
export const KNOWLEDGE_PROMPT_CHARS = 6000;

export const CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  convention: '约定', pitfall: '坑', decision: '决策', environment: '环境', dependency: '外部依赖',
};
const STATUS_LABEL: Record<KnowledgeEntry['status'], string> = { candidate: '候选', active: '生效', retired: '已废弃', promoted: '已成为规则' };

export interface KnowledgeInput {
  category: KnowledgeCategory;
  content: string;
  scopes?: string[];
  paths?: string[];
  source: KnowledgeEntry['source'];
  status: 'active' | 'candidate';
}

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

/** 去重用的归一化：去掉空白与标点，小写 */
export const normalizeContent = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

export const nextKnowledgeId = (k: KnowledgeFile) =>
  `K-${String(Math.max(0, ...k.entries.map((e) => Number(e.id.slice(2)))) + 1).padStart(3, '0')}`;

/** 校验条目（不含去重）：类别、长度、scope 存在、路径为仓库内相对 glob */
export function checkInput(config: FlowConfig, i: Pick<KnowledgeInput, 'category' | 'content' | 'scopes' | 'paths'>): string[] {
  const errors: string[] = [];
  if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(i.category)) errors.push(`类别只能是 ${KNOWLEDGE_CATEGORIES.join('、')}`);
  const content = i.content.trim();
  if (content.length < 8) errors.push('内容太短：写清楚是什么、为什么、怎么做');
  if (content.length > KNOWLEDGE_CONTENT_MAX) errors.push(`内容超过 ${KNOWLEDGE_CONTENT_MAX} 字，请精简为一条可执行的经验`);
  for (const s of i.scopes ?? []) if (!(s in config.raw.scopes)) errors.push(`scope ${s} 不存在，可用：${Object.keys(config.raw.scopes).join('、')}`);
  for (const p of i.paths ?? []) {
    if (path.isAbsolute(p) || p.split('/').includes('..') || p.startsWith('~')) errors.push(`路径 ${p} 必须是仓库内的相对路径或 glob`);
    if (p.startsWith('.flow') || p.startsWith('.git/') || p === '.git') errors.push(`路径 ${p} 不能指向 .flow/ 或 .git/`);
  }
  return errors;
}

/** 在库中新增一条（在 StateStore.writeKnowledge 的回调中调用）；与未废弃的条目内容相同则拒绝 */
export function addEntry(k: KnowledgeFile, i: KnowledgeInput, ts: string): KnowledgeEntry {
  const norm = normalizeContent(i.content);
  const dup = k.entries.find((e) => e.status !== 'retired' && normalizeContent(e.content) === norm);
  if (dup) throw new KnowledgeError(`已有相同的知识条目 ${dup.id}（${STATUS_LABEL[dup.status]}），无需重复提交`);
  const entry: KnowledgeEntry = {
    id: nextKnowledgeId(k), category: i.category, content: i.content.trim(),
    scopes: [...new Set(i.scopes ?? [])], paths: [...new Set(i.paths ?? [])],
    source: i.source, status: i.status, created_at: ts, updated_at: ts,
  };
  k.entries.push(entry);
  return entry;
}

/** 新增一条：校验、去重、写入；返回条目 */
export async function learn(store: StateStore, config: FlowConfig, i: KnowledgeInput, actor: string): Promise<KnowledgeEntry> {
  const errors = checkInput(config, i);
  if (errors.length) throw new KnowledgeError(errors.join('；'));
  if (i.source.run && store.readKnowledge().entries.filter((e) => e.source.run === i.source.run).length >= KNOWLEDGE_PER_RUN) {
    throw new KnowledgeError(`每次运行最多提交 ${KNOWLEDGE_PER_RUN} 条知识，只留最重要的`);
  }
  return store.writeKnowledge((k, ts) => addEntry(k, i, ts), {
    actor, flow: i.source.flow, ...(i.source.task ? { task: i.source.task } : {}),
    reason: `${i.status === 'candidate' ? '知识候选' : '新增知识'}`, data: { category: i.category },
  });
}

/** 程序提炼的候选（审查打回、合并后验证失败）：截取原文，失败不影响主流程 */
export async function proposeCandidate(store: StateStore, config: FlowConfig, t: TaskFile, flow: string, kind: 'review' | 'merge', text: string, run: string | null): Promise<KnowledgeEntry | null> {
  const head = kind === 'review' ? `${t.id}「${t.title}」审查打回：` : `${t.id}「${t.title}」合并后验证失败：`;
  const content = `${head}${text.trim()}`.slice(0, KNOWLEDGE_CONTENT_MAX);
  try {
    return await learn(store, config, {
      category: kind === 'review' ? 'convention' : 'pitfall', content, scopes: t.scopes.filter((s) => s in config.raw.scopes), paths: [],
      source: { kind, flow, task: t.id, run: null, role: null }, status: 'candidate',
    }, kind === 'review' && run ? `run:${run}` : 'engine');
  } catch {
    return null;
  }
}

/** 条目是否适用于任务：全局条目，或 scope 相交，或路径与任务 writes/inputs 重叠 */
export function appliesTo(e: KnowledgeEntry, t: Pick<TaskFile, 'scopes' | 'writes' | 'inputs'>): boolean {
  if (!e.scopes.length && !e.paths.length) return true;
  if (e.scopes.some((s) => t.scopes.includes(s))) return true;
  const files = [...t.writes, ...t.inputs];
  return e.paths.some((p) => files.some((f) => globsOverlap(p, f)));
}

/** 派发时注入提示的条目：生效中、适用于任务；按编号排序（只追加，前缀尽量稳定），超出上限时保留最近的 */
export function selectKnowledge(k: KnowledgeFile, t: Pick<TaskFile, 'scopes' | 'writes' | 'inputs'>): KnowledgeEntry[] {
  const all = k.entries.filter((e) => e.status === 'active' && appliesTo(e, t));
  const out: KnowledgeEntry[] = [];
  let chars = 0;
  for (const e of [...all].reverse()) {
    if (out.length >= KNOWLEDGE_PROMPT_MAX || chars + e.content.length > KNOWLEDGE_PROMPT_CHARS) break;
    out.unshift(e);
    chars += e.content.length;
  }
  return out;
}

export const formatEntry = (e: KnowledgeEntry) =>
  `${e.id} [${CATEGORY_LABEL[e.category]}]${e.scopes.length || e.paths.length ? `（${[...e.scopes, ...e.paths].join('、')}）` : ''} ${e.content}`;

export function formatKnowledgeList(entries: readonly KnowledgeEntry[]): string {
  return entries.map((e) => `- ${formatEntry(e)}　${STATUS_LABEL[e.status]}${e.draft ? `（草案 ${e.draft}）` : ''}${e.source.task ? `　来源 ${e.source.flow}/${e.source.task}${e.source.role ? ` ${e.source.role}` : ''}` : ''}`).join('\n');
}

export function searchKnowledge(k: KnowledgeFile, query: string, all: boolean): KnowledgeEntry[] {
  const q = query.trim().toLowerCase();
  return k.entries.filter((e) => (all || e.status === 'active' || e.status === 'candidate')
    && (!q || e.id.toLowerCase() === q || e.content.toLowerCase().includes(q) || e.scopes.includes(q) || e.category === q || CATEGORY_LABEL[e.category] === q));
}

const pick = (k: KnowledgeFile, ids: readonly string[]) => ids.map((id) => {
  const e = k.entries.find((x) => x.id === id);
  if (!e) throw new KnowledgeError(`知识条目 ${id} 不存在`);
  return e;
});

/** 用户确认候选（可同时改写内容） */
export async function acceptCandidate(store: StateStore, id: string, rewrite?: string): Promise<KnowledgeEntry> {
  if (rewrite !== undefined && (rewrite.trim().length < 8 || rewrite.trim().length > KNOWLEDGE_CONTENT_MAX)) throw new KnowledgeError(`改写后的内容需要 8 到 ${KNOWLEDGE_CONTENT_MAX} 字`);
  return store.writeKnowledge((k, ts) => {
    const [e] = pick(k, [id]);
    if (e!.status !== 'candidate') throw new KnowledgeError(`${id} 当前是${STATUS_LABEL[e!.status]}，不是候选`);
    if (rewrite?.trim()) {
      const norm = normalizeContent(rewrite);
      const dup = k.entries.find((x) => x.id !== id && x.status !== 'retired' && normalizeContent(x.content) === norm);
      if (dup) throw new KnowledgeError(`已有相同的知识条目 ${dup.id}`);
      e!.content = rewrite.trim();
    }
    Object.assign(e!, { status: 'active', updated_at: ts });
    return e!;
  }, { actor: 'human', reason: `确认知识候选 ${id}` });
}

/** 废弃条目（候选或生效中） */
export async function retireEntries(store: StateStore, ids: readonly string[], reason: string): Promise<KnowledgeEntry[]> {
  return store.writeKnowledge((k, ts) => {
    const es = pick(k, ids);
    for (const e of es) {
      if (e.status === 'retired') throw new KnowledgeError(`${e.id} 已废弃`);
      Object.assign(e, { status: 'retired', updated_at: ts, ...(reason ? { status_reason: reason.slice(0, 500) } : {}) });
    }
    return es;
  }, { actor: 'human', reason: `废弃知识 ${ids.join('、')}`, ...(reason ? { data: { reason } } : {}) });
}

/** 提升为规则草案时的目标规则文件：条目共同 scope 的第一个规则文件，否则 global */
export function defaultRuleTarget(config: FlowConfig, entries: readonly KnowledgeEntry[]): string {
  const common = entries[0]?.scopes.find((s) => entries.every((e) => e.scopes.includes(s)));
  const rule = common ? config.raw.scopes[common]?.rules?.[0] : undefined;
  return path.posix.basename(rule ?? GLOBAL_RULES);
}

/**
 * 把条目提升为规则草案：在主工作区写 docs/rules-draft/<规则名>.md（现有规则内容 + 追加的条目）并提交到当前分支，
 * 条目记下草案文件；用户经 /flow rules apply 应用后条目才标为"已成为规则"。
 */
export async function promoteToDraft(root: string, store: StateStore, config: FlowConfig, ids: readonly string[], ruleName?: string): Promise<{ file: string; entries: KnowledgeEntry[] }> {
  const entries = pick(store.readKnowledge(), ids);
  const bad = entries.filter((e) => e.status !== 'active');
  if (bad.length) throw new KnowledgeError(`只能提升生效中的条目：${bad.map((e) => `${e.id}（${STATUS_LABEL[e.status]}）`).join('、')}`);
  const name = (ruleName ?? defaultRuleTarget(config, entries)).replace(/\.md$/, '') + '.md';
  if (!/^[\w.-]+\.md$/.test(name) || name.startsWith('.')) throw new KnowledgeError(`规则文件名不合法：${name}`);
  const file = `${DRAFT_DIR}/${name}`;
  const abs = path.join(root, file);
  const base = existsSync(abs) ? readFileSync(abs, 'utf8')
    : existsSync(path.join(root, 'rules', name)) ? readFileSync(path.join(root, 'rules', name), 'utf8') : `# ${name.replace(/\.md$/, '')} 规则\n`;
  const lines = base.trimEnd().split('\n');
  let n = Math.max(0, ...lines.map((l) => Number(/^(\d+)\.\s/.exec(l)?.[1] ?? 0)));
  const added = entries.map((e) => `${++n}. ${e.content.replace(/\s*\n\s*/g, ' ')}（来自知识 ${e.id}）`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n${added.join('\n')}\n`);
  git(root, ['add', '--', file]);
  if (!gitOk(root, ['diff', '--cached', '--quiet', '--', file])) {
    git(root, ['commit', '-q', '--no-verify', '-m', `pi-flow: 知识 ${ids.join('、')} 提升为规则草案`, '--', file], { engineIdentity: true });
  }
  const saved = await store.writeKnowledge((k, ts) => pick(k, ids).map((e) => Object.assign(e, { draft: file, updated_at: ts })),
    { actor: 'human', reason: `知识 ${ids.join('、')} 提升为规则草案 ${file}` });
  return { file, entries: saved };
}

/** 规则草案被应用后：引用这些草案的条目标为"已成为规则"，不再作为知识注入 */
export async function markPromoted(store: StateStore, draftFiles: readonly string[]): Promise<string[]> {
  const hit = store.readKnowledge().entries.filter((e) => e.status === 'active' && e.draft && draftFiles.includes(e.draft)).map((e) => e.id);
  if (!hit.length) return [];
  await store.writeKnowledge((k, ts) => {
    for (const e of k.entries) if (hit.includes(e.id)) Object.assign(e, { status: 'promoted', updated_at: ts });
  }, { actor: 'human', reason: `知识 ${hit.join('、')} 已成为规则` });
  return hit;
}
