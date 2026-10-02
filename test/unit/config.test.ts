import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../../src/core/config.ts';
import { TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';

const errorsOf = (yaml: string): string[] => {
  try {
    parseConfig(yaml);
  } catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  return [];
};

test('模板 workflow.yaml 通过校验', () => {
  const c = parseConfig(TEMPLATE_YAML);
  assert.equal(c.limits.max_parallel, 2);
  assert.ok(c.warnings.some((w) => w.includes('models.strong')), '未填写模型应给出警告');
});

test('角色 writes 由 scopes 并集推导', () => {
  const c = parseConfig(TEST_YAML);
  assert.deepEqual(c.roles['architect']!.writes, ['docs/**', 'src/shared/**']);
  assert.deepEqual(c.roles['reviewer']!.writes, []);
  assert.deepEqual(c.roles['orchestrator']!.readPaths, ['docs/**', '.flow/**']);
  assert.equal(c.roles['backend-engineer']!.env['PI_SERENA_STRICT'], '1');
  assert.equal(c.roles['backend-engineer']!.modelTier, 'medium');
});

test('工具组展开；bash_readonly 映射为 bash 并标记只读', () => {
  const c = parseConfig(TEST_YAML);
  const be = c.roles['backend-engineer']!;
  assert.ok(be.tools.has('serena_replace_symbol_body'));
  assert.ok(be.tools.has('serena_find_symbol'));
  assert.equal(be.bash, 'full');
  const rv = c.roles['reviewer']!;
  assert.equal(rv.bash, 'readonly');
  assert.ok(rv.tools.has('bash'));
  assert.ok(!rv.tools.has('bash_readonly'));
  const rt = c.activeTools('reviewer');
  assert.deepEqual(rt.slice(0, 3), ['codemode', 'read', 'bash']);
  assert.ok(rt.includes('serena_find_symbol') && rt.includes('codegraph_impact') && rt.includes('flow_approve') && rt.includes('flow_block'));
  assert.ok(!rt.some((t) => c.toolKind(t) === 'write'), '只读角色不应启用写工具');
  assert.ok(!c.toolKind('serena_rename_symbol') || c.toolKind('serena_rename_symbol') === 'other');
  assert.ok(!c.activeTools('orchestrator').includes('flow_block'));
  assert.equal(c.toolKind('serena_replace_content'), 'write');
  assert.equal(c.toolKind('edit'), 'write');
  assert.equal(c.toolKind('web_search'), 'web');
});

test('引用不存在的 scope、工具组、命令、模型档位时报错并指出位置', () => {
  const bad = TEST_YAML
    .replace('scopes: [backend],  tools', 'scopes: [backend, ghost],  tools')
    .replace('"@web"', '"@nope"')
    .replace('auto: [install, typecheck, lint]', 'auto: [install, deploy]')
    .replace('researcher:        { model: cheap', 'researcher:        { model: turbo');
  const errs = errorsOf(bad);
  const all = errs.join('\n');
  assert.match(all, /roles\.backend-engineer\.scopes\[1\]（第 \d+ 行）.*ghost/);
  assert.match(all, /roles\.researcher\.tools\[2\].*nope/);
  assert.match(all, /modes\.build\.stages\[2\]\.gate\.auto\[1\].*deploy/);
  assert.match(all, /roles\.researcher\.model.*turbo/);
});

test('未知工具名、语法错误、schema 错误', () => {
  assert.match(errorsOf(TEST_YAML.replace('tools: [read, write, "@web"', 'tools: [read, scribble, "@web"')).join(), /scribble/);
  assert.match(errorsOf('version: 1\nproject: [').join(), /YAML/);
  assert.match(errorsOf(TEST_YAML.replace('max_parallel: 2', 'max_parallel: "two"')).join(), /limits\/max_parallel|limits\.max_parallel/);
});

test('角色的 writes 不能手写为与 scopes 不一致', () => {
  const errs = errorsOf(TEST_YAML.replace('scopes: [research], tools: [read, write, "@web", flow_note, flow_submit] }',
    'scopes: [research], tools: [read, write, "@web", flow_note, flow_submit], writes: ["src/**"] }'));
  assert.match(errs.join(), /roles\.researcher\.writes.*scopes/);
});

test('越权配置被拒：orchestrator 有写工具、无 writes 的角色有写工具、非 reviewer 有审批工具', () => {
  assert.match(errorsOf(TEST_YAML.replace('tools: [read, flow_status', 'tools: [read, bash, flow_status')).join(), /orchestrator.*bash/);
  assert.match(errorsOf(TEST_YAML.replace('tools: [codemode, read, bash_readonly, "@serena_read", "@codegraph", flow_approve]',
    'tools: [codemode, read, bash_readonly, "@serena_read", "@serena_edit", "@codegraph", flow_approve]')).join(), /reviewer.*serena_replace_symbol_body/);
  assert.match(errorsOf(TEST_YAML.replace('flow_claim, flow_note, flow_submit] }\n  test-engineer', 'flow_claim, flow_note, flow_submit, flow_approve] }\n  test-engineer')).join(), /flow_approve.*reviewer/);
  assert.match(errorsOf(TEST_YAML.replace('tools: [codemode, read, bash_readonly, "@serena_read", "@codegraph", flow_approve]',
    'tools: [codemode, read, bash, bash_readonly, "@serena_read", "@codegraph", flow_approve]')).join(), /bash_readonly/);
});
