import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageAccumulator } from '../../src/core/metrics.ts';

const msg = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'message_end', message: { role: 'assistant', provider: 'Workbuddy', model: 'glm-5.3-flash', usage, stopReason: 'toolUse',
    content: [{ type: 'text', text: '' }], ...extra },
});

test('按 LF 分帧累加 usage，跨 chunk 边界也正确', () => {
  const a = new UsageAccumulator();
  const stream = [
    '{"type":"session","id":"x"}',
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'hi' } }),
    msg({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }),
    msg({ input: 50, output: 5, cacheRead: 300, cacheWrite: 7 }, { stopReason: 'stop', content: [{ type: 'text', text: '完成 了' }] }),
  ].join('\n') + '\n';
  for (let i = 0; i < stream.length; i += 37) a.pushChunk(stream.slice(i, i + 37));
  const r = a.result();
  assert.deepEqual(r.tokens, { input: 150, output: 15, cache_read: 300, cache_write: 7 });
  assert.equal(r.model, 'Workbuddy/glm-5.3-flash');
  assert.equal(r.turns, 2);
  assert.equal(r.stopReason, 'stop');
  assert.equal(r.lastText, '完成 了');
  assert.equal(r.error, null);
});

test('拿不到的字段记 null，不估算；错误被记录', () => {
  const a = new UsageAccumulator();
  a.pushChunk(msg({ input: 10 }, { stopReason: 'error', errorMessage: 'Connection error.' }) + '\n');
  const r = a.result();
  assert.deepEqual(r.tokens, { input: 10, output: null, cache_read: null, cache_write: null });
  assert.equal(r.error, 'Connection error.');
  assert.deepEqual(new UsageAccumulator().result().tokens, { input: null, output: null, cache_read: null, cache_write: null });
});
