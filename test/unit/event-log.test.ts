import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { GENESIS_HASH, buildEvent, verifyChain, appendEvents, readEvents, canonicalJson, gitCommitPaths, STATE_COMMIT_PREFIX } from '../../src/core/event-log.ts';
import type { FlowEvent } from '../../src/core/schemas.ts';
import { tmpRepo } from '../helpers/repo.ts';

function chain(n: number): FlowEvent[] {
  const out: FlowEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(buildEvent(out.at(-1) ?? null, {
      ts: `2026-01-01T00:00:0${i}Z`, flow: 'B-001', actor: 'engine', type: 'transition', task: 'T-001', from: 'a', to: 'b',
    }));
  }
  return out;
}

test('canonicalJson 与键顺序无关', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
});

test('哈希链：正常链通过', () => {
  const ev = chain(5);
  assert.equal(ev[0]!.prev_hash, GENESIS_HASH);
  assert.equal(ev[4]!.seq, 5);
  const r = verifyChain(ev);
  assert.deepEqual(r.errors, []);
  assert.equal(r.head, ev[4]!.hash);
});

test('哈希链：篡改字段、删除、调换顺序都被检出', () => {
  const tampered = chain(5);
  tampered[2] = { ...tampered[2]!, to: 'done' };
  assert.match(verifyChain(tampered).errors.join(), /seq 3/);

  const rehashed = chain(5);
  const forged = buildEvent(rehashed[1]!, { ts: 'x', flow: 'B-001', actor: 'engine', type: 'note' });
  rehashed[2] = forged; // 重新计算了自身哈希，但下一条的 prev_hash 对不上
  assert.ok(verifyChain(rehashed).errors.length > 0);

  const removed = chain(5);
  removed.splice(1, 1);
  assert.ok(verifyChain(removed).errors.length > 0);

  const swapped = chain(5);
  [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
  assert.ok(verifyChain(swapped).errors.length > 0);
});

test('append 与 read 往返；损坏的行报告行号', () => {
  const { dir, cleanup } = tmpRepo();
  try {
    const file = path.join(dir, 'events.jsonl');
    const ev = chain(3);
    appendEvents(file, ev.slice(0, 2));
    appendEvents(file, ev.slice(2));
    assert.deepEqual(readEvents(file).events, ev);
    writeFileSync(file, readFileSync(file, 'utf8') + '{not json\n');
    const r = readEvents(file);
    assert.match(r.errors.join(), /第 4 行/);
  } finally { cleanup(); }
});

test('git commit 只提交指定路径，带固定前缀', () => {
  const { dir, git, cleanup } = tmpRepo();
  try {
    mkdirSync(path.join(dir, '.flow'));
    writeFileSync(path.join(dir, '.flow/state.json'), '{}');
    writeFileSync(path.join(dir, 'other.txt'), 'x');
    git('add', 'other.txt');
    const sha = gitCommitPaths(dir, ['.flow'], 'B-001 T-001 ready -> in_progress');
    assert.ok(sha);
    assert.equal(git('log', '-1', '--format=%s'), `${STATE_COMMIT_PREFIX} B-001 T-001 ready -> in_progress`);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['.flow/state.json']);
    assert.match(git('status', '--porcelain'), /^A  other\.txt/m);
    // 无变化时不产生空提交
    assert.equal(gitCommitPaths(dir, ['.flow'], 'noop'), null);
  } finally { cleanup(); }
});
