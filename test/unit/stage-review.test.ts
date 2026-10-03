import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/config.ts';
import { failingFiles, fixRoleFor, issueFileErrors, planFixTasks, stageReviewEnabled } from '../../src/core/stage-review.ts';
import type { FlowFile } from '../../src/core/schemas.ts';
import { TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEMPLATE_YAML);
const done = [
  mkTask('T-001', { status: 'done' }),
  mkTask('T-002', { status: 'done', role: 'frontend-engineer', scopes: ['frontend'], writes: ['src/web/t-002/**'] }),
];
const issue = (id: string, module: string, files: string[]) => ({ id, module, location: `${files[0]}:1`, problem: 'p', expected: 'e', files });

test('阶段审查只在 build/feature 的实施阶段启用，review.stage_end: false 关闭', () => {
  const flow = (mode: FlowFile['mode'], stage: string) => ({ mode, stage }) as FlowFile;
  assert.equal(stageReviewEnabled(config, flow('build', 'S3')), true);
  assert.equal(stageReviewEnabled(config, flow('build', 'S1')), false);
  assert.equal(stageReviewEnabled(config, flow('feature', 'F0')), false);
  assert.equal(stageReviewEnabled(config, flow('fix', 'X1')), false);
  assert.equal(stageReviewEnabled(parseConfig(TEST_YAML), flow('build', 'S3')), false);
});

test('修复任务按模块与负责的角色分组：角色优先取写过这些文件的任务，可写范围限定在问题涉及的文件', () => {
  const plan = planFixTasks(config, done, 'S3', [
    issue('R-1', 'server', ['src/server/t-001/a.ts']), issue('R-2', 'web', ['src/web/t-002/x.ts']), issue('R-3', 'server', ['src/server/t-001/b.ts', 'src/server/t-001/a.ts']),
  ], 1);
  assert.deepEqual(plan.tasks.map((t) => [t.id, t.role, t.review_issues, t.writes, t.kind]), [
    ['T-003', 'backend-engineer', ['R-1', 'R-3'], ['src/server/t-001/a.ts', 'src/server/t-001/b.ts'], 'review-fix'],
    ['T-004', 'frontend-engineer', ['R-2'], ['src/web/t-002/x.ts'], 'review-fix'],
  ]);
  assert.deepEqual(plan.tasks[0]!.verify, ['typecheck', 'test']);
  assert.match(plan.handoffs['T-003']!, /R-1［server］[\s\S]*R-3［server］/);
  assert.equal(fixRoleFor(config, done, ['docs/guide.md']), null, 'architect 不承担修复');
});

test('问题文件校验：契约、受保护文件、通配符、越出所有角色的文件被拒', () => {
  assert.deepEqual(issueFileErrors(config, done, 'x', ['src/server/t-001/a.ts']), []);
  assert.match(issueFileErrors(config, done, 'x', ['docs/contracts/api.md']).join(), /契约或受保护/);
  assert.match(issueFileErrors(config, done, 'x', ['workflow.yaml']).join(), /契约或受保护/);
  assert.match(issueFileErrors(config, done, 'x', ['src/server/**']).join(), /具体路径/);
  assert.match(issueFileErrors(config, done, 'x', ['../x.ts']).join(), /具体路径/);
  assert.match(issueFileErrors(config, done, 'x', ['src/server/a.ts', 'src/web/b.ts']).join(), /没有实施角色/);
});

test('从失败日志中找出仓库里的文件：相对路径、带行号、绝对路径取仓库内的后缀', () => {
  const tracked = new Set(['src/server/a.ts', 'tests/server/a.test.ts', 'package.json']);
  const out = failingFiles('FAIL tests/server/a.test.ts\n  at /tmp/wt/B-001-T-003/src/server/a.ts:12:3\nsrc/web/none.ts(1,1): error\nv1.2.3', tracked);
  assert.deepEqual(out, ['tests/server/a.test.ts', 'src/server/a.ts']);
});

test('审查者隐式拥有阶段审查的两个工具；其他角色不能声明', () => {
  assert.ok(config.role('reviewer').tools.has('flow_review_report'));
  assert.ok(config.role('reviewer').tools.has('flow_review_confirm'));
  assert.ok(!config.role('backend-engineer').tools.has('flow_review_report'));
  assert.throws(() => parseConfig(TEMPLATE_YAML.replace('flow_claim, flow_note, flow_submit] }\n  frontend', 'flow_claim, flow_note, flow_submit, flow_review_confirm] }\n  frontend')), /flow_review_confirm 只能分配给 reviewer/);
});
