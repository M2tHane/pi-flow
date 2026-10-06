import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMemory, NOTES_MESSAGE_TYPE } from '../../src/pi-adapter/memory.ts';

function mockPi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  return { handlers, pi: { on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => { handlers.set(ev, h); return () => {}; } } };
}
function mockCtx(percent: number | null) {
  const calls: { customInstructions?: string; onComplete?: () => void }[] = [];
  return { calls, ctx: { getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }), compact: (o: { customInstructions?: string; onComplete?: () => void }) => calls.push(o) } };
}

test('memory：笔记作为不显示的 custom 消息放在末尾；没有笔记时不改动消息', async () => {
  const { pi, handlers } = mockPi();
  let notes: string | null = null;
  let near = false;
  installMemory(pi as never, { active: () => true, notesMessage: (_c, n) => { near = n; return notes; }, compactAt: () => 0.7 });
  const context = handlers.get('context')!;
  assert.equal(await context({ messages: [{ role: 'user' }] }, mockCtx(10).ctx), undefined);
  notes = '笔记内容';
  const r = await context({ messages: [{ role: 'user' }] }, mockCtx(65).ctx) as { messages: { role: string; customType?: string; content?: string; display?: boolean }[] };
  assert.equal(r.messages.length, 2);
  assert.deepEqual([r.messages[1]!.role, r.messages[1]!.customType, r.messages[1]!.content, r.messages[1]!.display], ['custom', NOTES_MESSAGE_TYPE, '笔记内容', false]);
  assert.equal(near, true, '离阈值 10 个百分点以内时提醒');
  await context({ messages: [] }, mockCtx(50).ctx);
  assert.equal(near, false);
});

test('memory：回合结束时超过阈值才压缩，压缩进行中不重复触发，完成后可再次触发；不生效的上下文不处理', async () => {
  const { pi, handlers } = mockPi();
  let active = true;
  installMemory(pi as never, { active: () => active, notesMessage: () => null, compactAt: () => 0.7 });
  const turnEnd = handlers.get('turn_end')!;
  const low = mockCtx(69);
  turnEnd({}, low.ctx);
  assert.equal(low.calls.length, 0);
  const unknown = mockCtx(null);
  turnEnd({}, unknown.ctx);
  assert.equal(unknown.calls.length, 0, '刚压缩完占用未知时不触发');
  const high = mockCtx(75);
  turnEnd({}, high.ctx);
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 1);
  assert.match(high.calls[0]!.customInstructions!, /history/);
  handlers.get('session_compact')!({}, high.ctx);
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 2);
  high.calls[1]!.onComplete!();
  active = false;
  turnEnd({}, high.ctx);
  assert.equal(high.calls.length, 2);
});
