import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDag, computeReady, dagStats, mutexPairs, conflictsWith, remainingPath, type DagCatalog } from '../../src/core/dag.ts';
import { mkTask, hard, soft } from '../helpers/tasks.ts';

const catalog: DagCatalog = {
  roles: {
    'backend-engineer': { scopes: ['backend'] },
    'frontend-engineer': { scopes: ['frontend'] },
    'test-engineer': { scopes: ['acceptance'] },
  },
  scopes: {
    backend: ['src/server/**', 'tests/server/**'],
    frontend: ['src/web/**', 'tests/web/**'],
    acceptance: ['tests/acceptance/**', 'tests/e2e/**'],
  },
  commands: ['typecheck', 'test', 'e2e'],
  maxTaskFiles: 12,
};

test('合法 DAG 通过校验', () => {
  const tasks = [
    mkTask('T-001', { kind: 'test', role: 'test-engineer', scopes: ['acceptance'], writes: ['tests/acceptance/a/**'] }),
    mkTask('T-002', { deps: [hard('T-001', '先有验收测试')] }),
  ];
  const r = validateDag(tasks, catalog);
  assert.deepEqual(r.errors, []);
});

test('检出环', () => {
  const tasks = [mkTask('T-001', { deps: [hard('T-002')] }), mkTask('T-002', { deps: [hard('T-001')] })];
  const r = validateDag(tasks, catalog);
  assert.ok(r.errors.some((e) => e.includes('环')), r.errors.join('\n'));
});

test('检出引用不存在的依赖与重复 id', () => {
  const r = validateDag([mkTask('T-001', { deps: [hard('T-009')] }), mkTask('T-001')], catalog);
  assert.ok(r.errors.some((e) => e.includes('T-009')));
  assert.ok(r.errors.some((e) => e.includes('重复')));
});

test('检出缺 reason 的硬依赖', () => {
  const r = validateDag([mkTask('T-001'), mkTask('T-002', { deps: [{ task: 'T-001', type: 'hard' }] })], catalog);
  assert.ok(r.errors.some((e) => e.includes('reason')));
});

test('检出缺 integration 的软依赖；有 integration 时通过', () => {
  const base = [
    mkTask('T-001'),
    mkTask('T-002', { role: 'frontend-engineer', scopes: ['frontend'], writes: ['src/web/x/**'], deps: [soft('T-001')] }),
  ];
  const r1 = validateDag(base, catalog);
  assert.ok(r1.errors.some((e) => e.includes('integration')), r1.errors.join('\n'));

  const onlyOneSide = [...base, mkTask('T-003', { kind: 'integration', role: 'test-engineer', scopes: ['acceptance'],
    writes: ['tests/e2e/x/**'], deps: [hard('T-001', '联调')] })];
  assert.ok(validateDag(onlyOneSide, catalog).errors.some((e) => e.includes('integration')));

  const ok = [...base, mkTask('T-003', { kind: 'integration', role: 'test-engineer', scopes: ['acceptance'],
    writes: ['tests/e2e/x/**'], deps: [hard('T-001', '联调'), hard('T-002', '联调')] })];
  assert.deepEqual(validateDag(ok, catalog).errors, []);
});

test('检出非法角色、scope、命令与越出 scope 的 writes', () => {
  const r = validateDag([
    mkTask('T-001', { role: 'nobody' }),
    mkTask('T-002', { scopes: ['frontend'] }),
    mkTask('T-003', { verify: ['deploy'] }),
    mkTask('T-004', { writes: ['src/web/**'] }),
    mkTask('T-005', { scopes: ['ghost'] }),
  ], catalog);
  const all = r.errors.join('\n');
  assert.match(all, /T-001.*nobody/);
  assert.match(all, /T-002.*frontend/);
  assert.match(all, /T-003.*deploy/);
  assert.match(all, /T-004.*src\/web/);
  assert.match(all, /T-005.*ghost/);
});

test('writes 过多给出警告而非错误', () => {
  const writes = Array.from({ length: 13 }, (_, i) => `src/server/f${i}.ts`);
  const r = validateDag([mkTask('T-001', { writes })], catalog);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
});

test('硬依赖阻塞 ready，软依赖不阻塞', () => {
  const tasks = [
    mkTask('T-001', { status: 'in_progress' }),
    mkTask('T-002', { deps: [hard('T-001')] }),
    mkTask('T-003', { deps: [soft('T-001')] }),
    mkTask('T-004', { stage: 'S4' }),
  ];
  assert.deepEqual(computeReady(tasks, 'S3'), ['T-003']);
  tasks[0]!.status = 'done';
  assert.deepEqual(computeReady(tasks, 'S3'), ['T-002', 'T-003']);
});

test('软依赖前驱阻塞时后继照常 ready', () => {
  const tasks = [mkTask('T-001', { status: 'blocked' }), mkTask('T-002', { deps: [soft('T-001')] })];
  assert.deepEqual(computeReady(tasks, 'S3'), ['T-002']);
});

test('关键路径、宽度、硬依赖占比', () => {
  // T1 -> T2 -> T4 (硬)；T1 -> T3 (硬)；T3 ~> T5 (软)
  const tasks = [
    mkTask('T-001'), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003', { deps: [hard('T-001')] }),
    mkTask('T-004', { deps: [hard('T-002')] }), mkTask('T-005', { deps: [soft('T-003')] }),
  ];
  const s = dagStats(tasks);
  assert.equal(s.taskCount, 5);
  assert.equal(s.criticalPathLength, 3);
  assert.deepEqual(s.criticalPath, ['T-001', 'T-002', 'T-004']);
  assert.equal(s.maxWidth, 2);
  assert.equal(s.hardRatio, 0.75);
  const rp = remainingPath(tasks);
  assert.equal(rp.get('T-001'), 3);
  assert.equal(rp.get('T-004'), 1);
});

test('互斥由 writes 重叠自动推导', () => {
  const a = mkTask('T-001', { writes: ['src/server/**'] });
  const b = mkTask('T-002', { writes: ['src/server/export/**'] });
  const c = mkTask('T-003', { writes: ['src/web/**'] });
  assert.deepEqual(mutexPairs([a, b, c]), [['T-001', 'T-002']]);
  assert.equal(conflictsWith(a, b), true);
  assert.equal(conflictsWith(a, c), false);
});
