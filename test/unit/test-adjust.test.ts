import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adjustableTests, testAdjustEnabled, testAdjustments } from '../../src/core/test-adjust.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { tmpRepo } from '../helpers/repo.ts';
import type { TaskFile } from '../../src/core/schemas.ts';

test('可适配的已有测试：基线上已有、writes 之外的测试文件；改动只算修改，新增与删除不算', () => {
  const r = tmpRepo();
  try {
    const put = (f: string, c: string) => { mkdirSync(path.dirname(path.join(r.dir, f)), { recursive: true }); writeFileSync(path.join(r.dir, f), c); };
    put('tests/acceptance/a.test.js', 'a'); put('tests/acceptance/b.test.js', 'b'); put('tests/server/s.test.js', 's'); put('src/server/x.js', 'x'); put('src/web/v.spec.js', 'v');
    r.git('add', '-A'); r.git('commit', '-qm', 'base');
    const base = r.git('rev-parse', 'HEAD');
    const writes = ['src/server/**', 'tests/server/**'];
    assert.deepEqual(adjustableTests(r.dir, base, writes).sort(), ['src/web/v.spec.js', 'tests/acceptance/a.test.js', 'tests/acceptance/b.test.js']);
    put('tests/acceptance/a.test.js', 'a2'); rmSync(path.join(r.dir, 'tests/acceptance/b.test.js')); put('tests/acceptance/c.test.js', 'c'); put('tests/server/s.test.js', 's2');
    r.git('add', '-A'); r.git('commit', '-qm', 'change');
    assert.deepEqual(testAdjustments(r.dir, base, writes), ['tests/acceptance/a.test.js']);
  } finally { r.cleanup(); }
});

test('适配已有测试的开关：默认开；只读角色、只读任务、merge-fix 不适用；testing.adjust_tests: false 关闭', () => {
  const t = (over: Partial<TaskFile>) => ({ kind: 'impl', role: 'backend-engineer', ...over }) as TaskFile;
  const on = parseConfig(TEST_YAML);
  assert.equal(testAdjustEnabled(on, t({})), true);
  assert.equal(testAdjustEnabled(on, t({ kind: 'review-fix' })), true);
  assert.equal(testAdjustEnabled(on, t({ kind: 'merge-fix' })), false);
  assert.equal(testAdjustEnabled(on, t({ kind: 'analysis', role: 'reviewer' })), false);
  assert.equal(testAdjustEnabled(parseConfig(TEST_YAML.replace(/^  adjust_tests: true .*$/m, '  adjust_tests: false')), t({})), false);
});
