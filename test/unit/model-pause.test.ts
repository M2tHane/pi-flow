import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUnavailable, matchPausedModel, parseRetryAfter, pauseDuration } from '../../src/core/model-pause.ts';
import type { ModelPause } from '../../src/core/schemas.ts';

test('classifyUnavailable：额度用完', () => {
  for (const msg of [
    'Codex error: The usage limit has been reached',
    'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
    '429 You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota',
    'Monthly usage limit reached',
    'Your credit balance is too low to access the Anthropic API',
  ]) assert.equal(classifyUnavailable(msg)?.kind, 'quota', msg);
});

test('classifyUnavailable：限流、过载、服务或网络不可用', () => {
  for (const msg of [
    '429 Too Many Requests', 'Rate limit reached for requests', 'overloaded_error: Overloaded', '503 Service Unavailable',
    '529', 'connect ECONNREFUSED 127.0.0.1:7863', 'fetch failed', 'getaddrinfo ENOTFOUND api.example.com', 'Connection error.',
  ]) assert.equal(classifyUnavailable(msg)?.kind, 'unavailable', msg);
});

test('classifyUnavailable：其他错误仍按失败处理；stderr 只在异常退出时参考，且不认裸状态码', () => {
  for (const msg of [null, '', 'aborted', '被 guard 终止', 'Context length exceeded', 'Invalid API key']) assert.equal(classifyUnavailable(msg), null, String(msg));
  assert.equal(classifyUnavailable(null, 'Error: 429 Too Many Requests', 0), null, '正常退出不看 stderr');
  assert.equal(classifyUnavailable(null, 'Error: Too Many Requests', 1)?.kind, 'unavailable');
  assert.equal(classifyUnavailable(null, 'line 503 of log', 1), null, 'stderr 中的数字不当作状态码');
});

test('parseRetryAfter 与 pauseDuration', () => {
  assert.equal(parseRetryAfter('Try again in ~42 min.'), 42 * 60_000);
  assert.equal(parseRetryAfter('limit resets in 2 hours'), 2 * 3_600_000);
  assert.equal(parseRetryAfter('please retry after 30s'), 30_000);
  assert.equal(parseRetryAfter('retry-after: 120'), 120_000);
  assert.equal(parseRetryAfter('rate limited'), undefined);
  assert.equal(classifyUnavailable('usage limit. Try again in ~42 min.')?.retryAfterMs, 42 * 60_000);
  assert.equal(pauseDuration({ kind: 'quota' }, 1), null, '额度用完且无恢复时间：等用户');
  assert.equal(pauseDuration({ kind: 'quota', retryAfterMs: 42 * 60_000 }, 1), 42 * 60_000);
  assert.equal(pauseDuration({ kind: 'unavailable', retryAfterMs: 5_000 }, 1), 60_000, '至少暂停 1 分钟');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => pauseDuration({ kind: 'unavailable' }, n)! / 60_000), [5, 10, 20, 40, 60, 60]);
});

test('matchPausedModel：完整名、只写 id、all', () => {
  const mk = (model: string): ModelPause => ({ model, kind: 'quota', reason: '', since: 'x', strikes: 1, roles: [], tasks: [] });
  const ps = [mk('openai-codex/gpt-6.1-sol'), mk('Workbuddy/glm-5.3-flash')];
  assert.deepEqual(matchPausedModel(ps, 'gpt-6.1-sol').map((p) => p.model), ['openai-codex/gpt-6.1-sol']);
  assert.deepEqual(matchPausedModel(ps, 'Workbuddy/glm-5.3-flash').map((p) => p.model), ['Workbuddy/glm-5.3-flash']);
  assert.equal(matchPausedModel(ps, 'all').length, 2);
  assert.equal(matchPausedModel(ps, 'nope').length, 0);
});
