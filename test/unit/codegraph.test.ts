import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { affectedTests, codegraphSync } from '../../src/core/codegraph.ts';

// 用假的 codegraph 可执行文件验证解析与降级，不依赖本机安装
function fakeBin(dir: string, script: string): string {
  const p = path.join(dir, 'codegraph');
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('affectedTests：解析 JSON；未索引、出错、为空时返回 null', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-cg-'));
  try {
    process.env['PI_FLOW_CODEGRAPH_BIN'] = fakeBin(dir, `echo '{"changedFiles":["a.ts"],"affectedTests":["tests/a.test.ts"]}'`);
    assert.equal(await affectedTests(dir, ['a.ts']), null, '没有 .codegraph 时不调用');
    mkdirSync(path.join(dir, '.codegraph'));
    assert.deepEqual(await affectedTests(dir, ['a.ts']), ['tests/a.test.ts']);
    assert.equal(await affectedTests(dir, []), null);
    process.env['PI_FLOW_CODEGRAPH_BIN'] = fakeBin(dir, `echo '{"affectedTests":[]}'`);
    assert.equal(await affectedTests(dir, ['a.ts']), null, '为空时退回全量测试');
    process.env['PI_FLOW_CODEGRAPH_BIN'] = fakeBin(dir, 'exit 3');
    assert.equal(await affectedTests(dir, ['a.ts']), null);
    process.env['PI_FLOW_CODEGRAPH_BIN'] = path.join(dir, 'missing');
    assert.equal(await affectedTests(dir, ['a.ts']), null);
    await codegraphSync(dir);
  } finally {
    delete process.env['PI_FLOW_CODEGRAPH_BIN'];
    rmSync(dir, { recursive: true, force: true });
  }
});
