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

test('默认不用先行验收测试：修订新增被实现任务硬依赖的测试任务被拒', () => {
  const tasks = [mkTask('T-001', { status: 'done' }), mkTask('T-002')];
  const test1 = nt('N-001', { kind: 'test', role: 'test-engineer', scopes: ['acceptance'], writes: ['tests/acceptance/x/**'], verify: ['test'] });
  const r = checkRevision(config, STAGES, 'S3', tasks, { add: [test1, nt('N-002', { depends_on: [hard('N-001')] })], rewire: [], cancel: [] });
  assert.ok(r.errors.some((e) => /不用"先行验收测试"/.test(e)), r.errors.join('\n'));
});

test('修订中的先行验收测试（testing.leading_tests: true）：新增测试被多个任务硬依赖时，其余依赖改为承载者；编号映射接在现有任务之后', () => {
  const config = parseConfig(TEST_YAML.replace('leading_tests: false', 'leading_tests: true '));
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

test('修订可以取消已阻塞的任务（依赖它的任务要一并调整），不能取消进行中的任务', () => {
  const tasks = [mkTask('T-001', { status: 'blocked', blocked_reason: '卡住' }), mkTask('T-002', { deps: [hard('T-001')] }), mkTask('T-003', { status: 'in_progress' })];
  const ok = checkRevision(config, STAGES, 'S3', tasks, { add: [], rewire: [{ task: 'T-002', depends_on: [] }], cancel: [{ task: 'T-001', reason: '验收标准不合理' }] });
  assert.deepEqual(ok.errors, []);
  const dangling = checkRevision(config, STAGES, 'S3', tasks, { add: [], rewire: [], cancel: [{ task: 'T-001', reason: 'x' }] });
  assert.ok(dangling.errors.some((e) => e.includes('依赖被取消的 T-001')));
  const running = checkRevision(config, STAGES, 'S3', tasks, { add: [], rewire: [], cancel: [{ task: 'T-003', reason: 'x' }] });
  assert.ok(running.errors.some((e) => e.includes('进行中或已完成的任务不能取消')), running.errors.join('\n'));
});

test('调整依赖可以指向本次新增的任务，批准时改写为正式编号', () => {
  const tasks = [mkTask('T-001', { status: 'done' }), mkTask('T-002', { deps: [hard('T-001')] })];
  const r = checkRevision(config, STAGES, 'S3', tasks, { add: [nt('N-001')], rewire: [{ task: 'T-002', depends_on: [hard('N-001')] }], cancel: [] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.revision.rewire[0]!.depends_on.map((d) => d.task), ['N-001'], '保存时仍是临时编号');
});

test('改 API 文档：写 docs/contracts 必须标 contract_change；标了的必须是只写 docs/ 的文档任务', () => {
  const tasks = [mkTask('T-001', { status: 'done' })];
  const doc = { kind: 'doc' as const, role: 'architect', scopes: ['docs'], inputs: [], verify: [], depends_on: [], acceptance: ['a'], stage: 'S3', title: '改接口' };
  const missing = checkRevision(config, STAGES, 'S3', tasks, { add: [{ ...doc, id: 'N-001', writes: ['docs/contracts/**'] }], rewire: [], cancel: [] });
  assert.ok(missing.errors.some((e) => /contract_change/.test(e)), missing.errors.join('\n'));
  const wrongKind = checkRevision(config, STAGES, 'S3', tasks, { add: [{ ...doc, id: 'N-001', kind: 'impl', role: 'backend-engineer', scopes: ['backend'], writes: ['src/server/x/**'], contract_change: true }], rewire: [], cancel: [] });
  assert.ok(wrongKind.errors.some((e) => /kind 必须是 doc/.test(e)) && wrongKind.errors.some((e) => /只能写 docs\//.test(e)), wrongKind.errors.join('\n'));
  const ok = checkRevision(config, STAGES, 'S3', tasks, { add: [{ ...doc, id: 'N-001', writes: ['docs/contracts/**'], contract_change: true }], rewire: [], cancel: [] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.revision.add[0]!.contract_change, true);
});
