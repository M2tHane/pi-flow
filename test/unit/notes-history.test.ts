import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotesError, applyNoteOps, emptyNotes, notesContextMessage, renderNotes, seedTaskNotes } from '../../src/core/notes.ts';
import { formatSearch, loadHistory, readHistoryEntry, searchHistory, READ_CHUNK } from '../../src/core/history.ts';
import { MAIN_NOTES_REL, StateStore, taskNotesRel } from '../../src/core/state-store.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { NOTE_SECTION_MAX_ITEMS } from '../../src/core/schemas.ts';

test('notes：add、replace、remove、set 按顺序执行；序号越界与缺字段报错', () => {
  const n = emptyNotes('t');
  applyNoteOps(n, [{ section: 'todo', op: 'add', text: 'A' }, { section: 'todo', op: 'add', text: 'B' }, { section: 'todo', op: 'replace', index: 2, text: 'B2' }]);
  assert.deepEqual(n.todo, ['A', 'B2']);
  applyNoteOps(n, [{ section: 'todo', op: 'remove', index: 1 }, { section: 'done', op: 'add', text: 'A' }, { section: 'goal', op: 'set', items: ['G1', 'G2'] }]);
  assert.deepEqual([n.todo, n.done, n.goal], [['B2'], ['A'], ['G1', 'G2']]);
  assert.throws(() => applyNoteOps(n, [{ section: 'todo', op: 'remove', index: 5 }]), NotesError);
  assert.throws(() => applyNoteOps(n, [{ section: 'todo', op: 'add' }]), /缺少 text/);
  assert.throws(() => applyNoteOps(n, [{ section: 'todo', op: 'set' }]), /缺少 items/);
  const full = emptyNotes('t');
  full.pitfalls = Array.from({ length: NOTE_SECTION_MAX_ITEMS }, (_, i) => `p${i}`);
  assert.throws(() => applyNoteOps(full, [{ section: 'pitfalls', op: 'add', text: 'x' }]), /先合并或删除/);
});

test('notes：渲染带分区与序号；空笔记不放回上下文，接近阈值时只放提醒', () => {
  const n = emptyNotes('2026-10-04T00:00:00Z');
  assert.match(renderNotes(n), /（空）/);
  assert.equal(notesContextMessage(n, { title: '笔记', nearCompaction: false }), null);
  assert.match(notesContextMessage(n, { title: '笔记', nearCompaction: true })!, /接近压缩阈值/);
  applyNoteOps(n, [{ section: 'current', op: 'add', text: '写检索接口' }, { section: 'decisions', op: 'add', text: '用 SQLite FTS' }]);
  const text = renderNotes(n, '任务 T-001 的笔记');
  assert.match(text, /### 当前进度（current）\n1\. 写检索接口/);
  assert.match(text, /### 关键决策（decisions）\n1\. 用 SQLite FTS/);
  assert.doesNotMatch(text, /待完成/);
  assert.match(notesContextMessage(n, { title: '任务 T-001 的笔记', nearCompaction: false })!, /由程序在每次请求时放回上下文/);
});

test('notes：初始笔记由任务说明与验收标准生成', () => {
  const s = seedTaskNotes({ title: '知识库模块', acceptance: ['上传文档返回 201', '检索按相关度排序'] });
  assert.deepEqual(s.goal, ['任务：知识库模块', '验收：上传文档返回 201', '验收：检索按相关度排序']);
  assert.deepEqual(s.todo, ['上传文档返回 201', '检索按相关度排序']);
});

test('notes：StateStore 读写任务笔记与主会话笔记，带版本与事件；不合法的修改不落盘', async () => {
  const r = tmpRepo();
  try {
    writeFileSync(path.join(r.dir, 'x'), 'x'); r.git('add', '.'); r.git('commit', '-qm', 'init');
    const store = await StateStore.init(r.dir);
    assert.equal(store.readNotes(MAIN_NOTES_REL), null);
    const n = await store.writeNotes(MAIN_NOTES_REL, (cur) => { applyNoteOps(cur, [{ section: 'goal', op: 'add', text: '用户偏好中文' }]); return cur; }, { actor: 'orchestrator', reason: '更新主会话笔记' });
    assert.equal(n.goal[0], '用户偏好中文');
    assert.equal(store.readNotes(MAIN_NOTES_REL)!.version, 1);
    await assert.rejects(store.writeNotes(MAIN_NOTES_REL, (cur) => applyNoteOps(cur, [{ section: 'goal', op: 'remove', index: 9 }]), { actor: 'o', reason: 'x' }), NotesError);
    assert.deepEqual(store.readNotes(MAIN_NOTES_REL)!.goal, ['用户偏好中文']);
    await store.writeNotes(taskNotesRel('B-001', 'T-001'), (cur) => { cur.todo.push('a'); }, { actor: 'dispatcher', reason: '初始笔记' });
    assert.deepEqual(store.readNotes(taskNotesRel('B-001', 'T-001'))!.todo, ['a']);
    await assert.rejects(store.writeNotes('flows/B-001/other.json', () => {}, { actor: 'x', reason: 'x' }), /不是笔记文件/);
    assert.ok((await store.verifyIntegrity()).ok);
  } finally { r.cleanup(); }
});

function session(lines: object[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hist-'));
  const f = path.join(dir, 's.jsonl');
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  return f;
}
const msg = (id: string, ts: string, message: object) => ({ type: 'message', id, timestamp: ts, message });

test('history：读取会话条目（用户、助手含工具调用、工具结果、压缩摘要），fork 复制的条目只保留一次', () => {
  const a = session([
    { type: 'session', id: 'h' },
    msg('e1', '2026-10-04T01:00:00Z', { role: 'user', content: [{ type: 'text', text: '实现借出接口' }] }),
    msg('e2', '2026-10-04T01:01:00Z', { role: 'assistant', content: [{ type: 'text', text: '先看路由' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'routes.go' } }] }),
    msg('e3', '2026-10-04T01:02:00Z', { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'r.Get("/entities", HandleEntitiesGetAll)' }] }),
    { type: 'compaction', id: 'e4', timestamp: '2026-10-04T02:00:00Z', summary: '已完成数据模型' },
  ]);
  const b = session([msg('e3', '2026-10-04T01:02:00Z', { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'dup' }] }),
    msg('e5', '2026-10-04T03:00:00Z', { role: 'assistant', content: [{ type: 'text', text: '归还接口返回 409' }] })]);
  try {
    const entries = loadHistory([a, b, '/nonexistent.jsonl']);
    assert.deepEqual(entries.map((e) => `${e.id}:${e.kind}`), ['e1:user', 'e2:assistant', 'e3:tool:read', 'e4:summary', 'e5:assistant']);
    assert.match(entries[1]!.text, /\[调用 read\] \{"path":"routes.go"\}/);
  } finally { rmSync(path.dirname(a), { recursive: true }); rmSync(path.dirname(b), { recursive: true }); }
});

test('history：多个词全部命中优先，否则退回任一命中；按命中次数再按新近排序；read 分段', () => {
  const big = 'x'.repeat(READ_CHUNK + 50);
  const f = session([
    msg('e1', '2026-10-04T01:00:00Z', { role: 'user', content: [{ type: 'text', text: 'loan return 409 when no open loan' }] }),
    msg('e2', '2026-10-04T01:01:00Z', { role: 'assistant', content: [{ type: 'text', text: 'loan model done' }] }),
    msg('e3', '2026-10-04T01:02:00Z', { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: `test output ${big}` }] }),
    msg('e4', '2026-10-04T01:03:00Z', { role: 'assistant', content: [{ type: 'text', text: '数量调整理由必填' }] }),
  ]);
  try {
    const entries = loadHistory([f]);
    assert.deepEqual(searchHistory(entries, 'loan 409').map((h) => h.entry.id), ['e1']);
    assert.deepEqual(searchHistory(entries, 'loan').map((h) => h.entry.id), ['e1', 'e2']);
    assert.deepEqual(searchHistory(entries, 'LOAN zebra').map((h) => h.entry.id), ['e1', 'e2'], '没有全部命中时退回任一命中');
    assert.deepEqual(searchHistory(entries, '理由必填').map((h) => h.entry.id), ['e4']);
    assert.match(formatSearch(searchHistory(entries, 'loan'), entries.length), /^找到 2 条（共 4 条历史）[\s\S]*#e1 \[2026-10-04T01:00:00 user\]/);
    assert.match(formatSearch([], 4), /没有找到/);
    const part1 = readHistoryEntry(entries, '#e3');
    assert.match(part1, /第 1–8000 字，共 \d+ 字；用 offset 8000 继续/);
    assert.match(readHistoryEntry(entries, 'e3', READ_CHUNK), /第 8001–/);
    assert.match(readHistoryEntry(entries, 'nope'), /没有编号为 nope/);
  } finally { rmSync(path.dirname(f), { recursive: true }); }
});
