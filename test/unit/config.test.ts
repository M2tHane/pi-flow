import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../../src/core/config.ts';
import { TEMPLATE_YAML, TEST_YAML, REAL_TEMPLATE_YAML } from '../helpers/config.ts';

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
  assert.equal(c.limits.max_parallel, 3);
  assert.equal(parseConfig(TEST_YAML).limits.max_parallel, 2, '测试用配置保持 2');
  assert.ok(c.warnings.some((w) => w.includes('models.strong')), '未填写模型应给出警告');
});

test('角色 writes 由 scopes 并集推导', () => {
  const c = parseConfig(TEST_YAML);
  assert.deepEqual(c.roles['architect']!.writes, ['docs/**', 'src/shared/**']);
  assert.deepEqual(c.roles['acceptor']!.writes, []);
  assert.deepEqual(c.roles['orchestrator']!.readPaths, ['docs/**', '.flow/**']);
  assert.deepEqual(c.roles['backend-engineer']!.env, {}, '模板不再给实施角色开 Serena 严格模式（弱模型被反复拦下）');
  const strict = parseConfig(TEST_YAML.replace(/(  backend-engineer:[^\n]*) \}/, '$1, env: { PI_SERENA_STRICT: "1" } }'));
  assert.equal(strict.roles['backend-engineer']!.env['PI_SERENA_STRICT'], '1', '需要时仍可在 workflow.yaml 中按角色开启');
  assert.equal(c.roles['backend-engineer']!.modelTier, 'medium');
});

test('工具组展开；bash_readonly 映射为 bash 并标记只读', () => {
  const c = parseConfig(TEST_YAML);
  const be = c.roles['backend-engineer']!;
  assert.ok(be.tools.has('serena_replace_symbol_body'));
  assert.ok(be.tools.has('serena_find_symbol'));
  assert.equal(be.bash, 'full');
  // architect：只读 bash（读代码、跑只读命令），写文件只用 write/edit
  const real = parseConfig(REAL_TEMPLATE_YAML);
  const rv = real.roles['architect']!;
  assert.equal(rv.bash, 'readonly');
  assert.ok(rv.tools.has('bash'));
  assert.ok(!rv.tools.has('bash_readonly'));
  const rt = real.activeTools('architect');
  assert.ok(rt.includes('bash') && rt.includes('serena_find_symbol') && rt.includes('codegraph_impact') && rt.includes('flow_submit') && rt.includes('flow_block') && rt.includes('notes') && rt.includes('history'));
  // orchestrator：需求讨论时读代码（read、grep、find、ls），隐式拥有 flow_requirements，没有写工具
  const ot = real.activeTools('orchestrator');
  assert.ok(ot.includes('grep') && ot.includes('flow_requirements') && ot.includes('flow_replan'));
  assert.ok(!ot.some((t) => real.toolKind(t) === 'write'));
  assert.deepEqual(real.roles['orchestrator']!.readPaths, ['**']);
  assert.ok(real.activeTools('acceptor').includes('flow_accept') && !real.activeTools('acceptor').some((t) => real.toolKind(t) === 'write'));
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

test('越权配置被拒：orchestrator 有写工具、无 writes 的角色有写工具、验收与模块清单工具给了别的角色', () => {
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace('tools: [read, grep, find, ls, flow_status', 'tools: [read, bash, grep, find, ls, flow_status')).join(), /orchestrator.*bash/);
  const acc = 'tools: [read, bash, "@serena_read", "@codegraph", flow_accept, flow_accept_confirm]';
  const des = 'tools: [read, write, edit, flow_note, flow_submit]';
  assert.ok(REAL_TEMPLATE_YAML.includes(acc) && REAL_TEMPLATE_YAML.includes(des));
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(acc, 'tools: [read, bash, "@serena_read", "@serena_edit", "@codegraph", flow_accept, flow_accept_confirm]')).join(), /acceptor.*serena_replace_symbol_body/);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(des, 'tools: [read, write, edit, flow_note, flow_submit, flow_accept]')).join(), /flow_accept 只能分配给 acceptor/);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(des, 'tools: [read, write, edit, flow_note, flow_submit, flow_propose_modules]')).join(), /flow_propose_modules 只能分配给 architect/);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(des, 'tools: [read, write, edit, flow_note, flow_submit, flow_requirements]')).join(), /flow_requirements 只能分配给 orchestrator/);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(des, 'tools: [read, write, edit, flow_note, flow_submit, flow_review_report]')).join(), /flow_review_report 只能分配给 reviewer/);
  // 最终代码审查默认关闭；开启时需要 reviewer 角色
  assert.equal(parseConfig(REAL_TEMPLATE_YAML).raw.review?.final, false);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace('final: false', 'final: true').replace(/^  reviewer:.*\n/m, '')).join(), /review\.final 开启时需要 reviewer 角色/);
  assert.match(errorsOf(REAL_TEMPLATE_YAML.replace(des, 'tools: [read, write, edit, bash, bash_readonly, flow_note, flow_submit]')).join(), /bash_readonly/);
});
