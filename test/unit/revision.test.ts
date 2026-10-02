import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/config.ts';
import { checkRevision, revisionMapping } from '../../src/core/revision.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';
import type { RevisionTask } from '../../src/core/schemas.ts';

const config = parseConfig(TEST_YAML);
const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
const nt = (id: string, over: Partial<RevisionTask> = {}): RevisionTask => ({
  id, stage: 'S3', kind: 'impl', title: `新任务 ${id}`, role: 'backend-engineer', scopes: ['backend'], depends_on: [],
  inputs: [], writes: [`src/server/${id.toLowerCase()}/**`], acceptance: ['可验证'], verify: [], ...over,
});

test('修订校验：阶段不能早于当前或是设计阶段；调整依赖造成环、指向不存在的任务都被拒；只报告修订引入的错误', () => {
  const tasks = [mkTask('T-001', { status: 'done' }), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003', { deps: [hard('T-002')] })];
  const r = checkRevision(config, STAGES, 'S3', tasks, {
    add: [nt('N-001', { stage: 'S2' }), nt('N-002', { stage: 'S1' })],
    rewire: [{ task: 'T-002', depends_on: [hard('T-003')] }, { task: 'T-003', depends_on: [hard('T-009')] }],
    cancel: [],
  });
  assert.ok(r.errors.some((e) => e.startsWith('N-001：stage S2 不合法')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.startsWith('N-002：stage S1 不合法')));
  assert.ok(r.errors.some((e) => e.includes('T-009')));
  const cyc = checkRevision(config, STAGES, 'S3', tasks, { add: [], rewire: [{ task: 'T-002', depends_on: [hard('T-003')] }], cancel: [] });
  assert.ok(cyc.errors.some((e) => e.includes('环')), cyc.errors.join('\n'));
  assert.deepEqual(checkRevision(config, STAGES, 'S3', tasks, { add: [], rewire: [], cancel: [] }).errors, ['修订没有任何改动']);
});

test('修订中的先行验收测试：新增测试被多个任务硬依赖时，其余依赖改为承载者；编号映射接在现有任务之后', () => {
  const tasks = [mkTask('T-001', { status: 'done' }), mkTask('T-002')];
  const test1 = nt('N-001', { kind: 'test', role: 'test-engineer', scopes: ['acceptance'], writes: ['tests/acceptance/x/**'], verify: ['test'] });
  const r = checkRevision(config, STAGES, 'S3', tasks, {
    add: [test1, nt('N-002', { depends_on: [hard('N-001')] })],
    rewire: [],
    cancel: [],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(revisionMapping(tasks, r.revision.add), { 'N-001': 'T-003', 'N-002': 'T-004' });
  const r2 = checkRevision(config, STAGES, 'S3', tasks, {
    add: [test1, nt('N-002', { depends_on: [hard('N-001')] }), nt('N-003', { depends_on: [hard('N-001')] })], rewire: [], cancel: [],
  });
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(r2.revision.add.find((t) => t.id === 'N-003')!.depends_on.map((d) => d.task), ['N-002']);
  assert.ok(r2.notes.some((n) => n.startsWith('N-003 的依赖')), r2.notes.join('\n'));
});
