// 结构化笔记（第五轮）：目标、已完成、待完成、当前进度、关键决策、踩过的坑。
// agent 用 notes 工具增量维护；每次请求由扩展原样放回上下文（借鉴 pi-state-flow），压缩后不丢。
// 任务笔记同一任务的所有运行共用一份，主 agent 笔记跨流程保留。存放与读写由 StateStore 负责。
import { Type, type Static } from 'typebox';
import { NOTE_ITEM_MAX, NOTE_SECTIONS, NOTE_SECTION_MAX_ITEMS, type NoteSection, type NotesFile, type TaskFile } from './schemas.ts';

export const NOTE_SECTION_LABELS: Record<NoteSection, string> = {
  goal: '目标与约束', done: '已完成', todo: '待完成', current: '当前进度', decisions: '关键决策', pitfalls: '踩过的坑',
};

export const NoteOp = Type.Object({
  section: Type.Enum(NOTE_SECTIONS, { description: 'goal 目标与约束、done 已完成、todo 待完成、current 当前进度、decisions 关键决策、pitfalls 踩过的坑' }),
  op: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove'), Type.Literal('set')], { description: 'add 追加一条；replace 替换第 index 条；remove 删除第 index 条；set 用 items 整体替换该分区' }),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: NOTE_ITEM_MAX, description: 'add、replace 的内容' })),
  index: Type.Optional(Type.Integer({ minimum: 1, description: 'replace、remove 的条目序号（从 1 开始，见 read 的输出）' })),
  items: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: NOTE_ITEM_MAX }), { maxItems: NOTE_SECTION_MAX_ITEMS, description: 'set 的全部条目' })),
}, { additionalProperties: false });
export type NoteOp = Static<typeof NoteOp>;

export const NotesParams = Type.Object({
  action: Type.Union([Type.Literal('read'), Type.Literal('update')], { description: 'read 读取当前笔记；update 按 ops 修改' }),
  ops: Type.Optional(Type.Array(NoteOp, { minItems: 1, maxItems: 20, description: 'update 的修改，按顺序执行' })),
}, { additionalProperties: false });
export type NotesParams = Static<typeof NotesParams>;

export const NOTES_DESCRIPTION = '结构化笔记：goal 目标与约束、done 已完成、todo 待完成、current 当前进度、decisions 关键决策、pitfalls 踩过的坑。笔记每次请求都会原样放回上下文，上下文被压缩后也不会丢；完成一部分工作、做出决策、踩到坑、改变计划时及时 update（例如把 todo 的条目移到 done，并更新 current）。';

export class NotesError extends Error {
  constructor(message: string) { super(message); this.name = 'NotesError'; }
}

export const emptyNotes = (ts: string): NotesFile => ({ goal: [], done: [], todo: [], current: [], decisions: [], pitfalls: [], updated_at: ts, version: 1 });

export const isEmptyNotes = (n: NotesFile | null): boolean => !n || NOTE_SECTIONS.every((s) => n[s].length === 0);

/** 在笔记上执行修改（原地）；不合法时抛 NotesError，调用方的事务不提交 */
export function applyNoteOps(n: NotesFile, ops: readonly NoteOp[]): void {
  for (const [i, o] of ops.entries()) {
    const list = n[o.section];
    const where = `第 ${i + 1} 条修改（${o.section} ${o.op}）`;
    const at = () => {
      if (!o.index || o.index > list.length) throw new NotesError(`${where}：index 必须在 1–${list.length} 之间`);
      return o.index - 1;
    };
    switch (o.op) {
      case 'add':
        if (!o.text) throw new NotesError(`${where}：缺少 text`);
        if (list.length >= NOTE_SECTION_MAX_ITEMS) throw new NotesError(`${where}：该分区已有 ${NOTE_SECTION_MAX_ITEMS} 条，先合并或删除旧条目`);
        list.push(o.text);
        break;
      case 'replace':
        if (!o.text) throw new NotesError(`${where}：缺少 text`);
        list[at()] = o.text;
        break;
      case 'remove':
        list.splice(at(), 1);
        break;
      case 'set':
        if (!o.items) throw new NotesError(`${where}：缺少 items`);
        n[o.section] = [...o.items];
        break;
    }
  }
}

/** 给模型看的笔记（带序号，供 replace、remove 引用） */
export function renderNotes(n: NotesFile | null, title = '笔记'): string {
  if (isEmptyNotes(n)) return `## ${title}\n（空）`;
  const parts = NOTE_SECTIONS.filter((s) => n![s].length).map((s) => `### ${NOTE_SECTION_LABELS[s]}（${s}）\n${n![s].map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
  return `## ${title}（更新于 ${n!.updated_at}）\n${parts.join('\n\n')}`;
}

/** 任务第一次运行前由程序填入的初始笔记：目标是任务说明与验收标准，待完成是验收标准逐条 */
export function seedTaskNotes(t: Pick<TaskFile, 'title' | 'acceptance'>, extraGoal: readonly string[] = []): Pick<NotesFile, 'goal' | 'todo'> {
  const goal = [`任务：${t.title}`, ...extraGoal, ...t.acceptance.map((a) => `验收：${a}`)].map(clip);
  return { goal: goal.slice(0, NOTE_SECTION_MAX_ITEMS), todo: t.acceptance.map(clip).slice(0, NOTE_SECTION_MAX_ITEMS) };
}

const clip = (s: string) => (s.length > NOTE_ITEM_MAX ? `${s.slice(0, NOTE_ITEM_MAX - 1)}…` : s);

/** 放回上下文的笔记消息；临近压缩阈值时附上提醒 */
export function notesContextMessage(n: NotesFile | null, opts: { title: string; nearCompaction: boolean }): string | null {
  const reminder = opts.nearCompaction ? '\n\n[提醒] 上下文接近压缩阈值。先用 notes update 记下当前进度（done、todo、current），压缩后只保留笔记与最近的对话；之前的细节可以用 history 检索。' : '';
  if (isEmptyNotes(n) && !reminder) return null;
  return `[pi-flow ${opts.title}，由程序在每次请求时放回上下文；用 notes 工具修改]\n${renderNotes(n, opts.title)}${reminder}`;
}
