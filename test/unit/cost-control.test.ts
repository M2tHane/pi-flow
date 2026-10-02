import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/config.ts';
import { assessRisk, escalationModel, resolveModelRef } from '../../src/core/cost-control.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const YAML = TEST_YAML.replace(/models:[\s\S]*?\nmodes:/, 'models:\n  strong: "p/strong"\n  medium: "p/medium"\n  cheap:  "<provider/model>"\nmodes:');
const config = parseConfig(YAML);

test('风险判定：只改文档或测试、改动小才算低风险；契约、shared、超限、失败过、先行验收测试一律高风险', () => {
  const doc = mkTask('T-001', { kind: 'doc' });
  assert.equal(assessRisk(config, doc, [doc], [{ path: 'docs/guide.md', lines: 20 }]).low, true);
  assert.equal(assessRisk(config, doc, [doc], [{ path: 'tests/a.test.ts', lines: 20 }, { path: 'README.md', lines: 3 }]).low, true);
  const hi = (changes: { path: string; lines: number }[], t = doc, tasks = [doc]) => assessRisk(config, t, tasks, changes).reasons.join('；');
  assert.match(hi([{ path: 'src/server/a.ts', lines: 1 }]), /不只是文档或测试/);
  assert.match(hi([{ path: 'docs/contracts/api.md', lines: 1 }]), /契约/);
  assert.match(hi([{ path: 'docs/a.md', lines: 101 }]), /超过 100/);
  assert.match(hi([1, 2, 3, 4].map((i) => ({ path: `docs/${i}.md`, lines: 1 }))), /4 个文件/);
  assert.match(hi([{ path: 'docs/a.md', lines: 1 }], { ...doc, attempts: 1 }), /失败过/);
  assert.match(hi([]), /拿不到改动/);
  const lead = mkTask('T-002', { kind: 'test' });
  assert.match(hi([{ path: 'tests/acceptance/a.test.ts', lines: 5 }], lead, [lead, mkTask('T-003', { deps: [hard('T-002')] })]), /先行验收测试/);
  const off = parseConfig(`${YAML}\nreview:\n  low_risk:\n    enabled: false\n`);
  assert.equal(assessRisk(off, doc, [doc], [{ path: 'docs/a.md', lines: 1 }]).low, false);
});

test('模型引用与升级：档位或 provider/model；占位符取不到；默认升到上一档；/flow-config 优先；与原模型相同不升级', () => {
  assert.equal(resolveModelRef(config, 'strong'), 'p/strong');
  assert.equal(resolveModelRef(config, 'cheap'), null);
  assert.equal(resolveModelRef(config, 'x/y'), 'x/y');
  const none = { version: 1 as const, roles: {} };
  assert.equal(escalationModel(config, none, 'backend-engineer', 'p/medium'), 'p/strong');
  assert.equal(escalationModel(config, none, 'reviewer', 'p/strong'), null, 'strong 没有上一档');
  assert.equal(escalationModel(config, { version: 1, roles: { 'backend-engineer': { escalate_model: 'q/big' } } }, 'backend-engineer', 'p/medium'), 'q/big');
  assert.equal(escalationModel(config, none, 'backend-engineer', 'p/strong'), null);
  assert.throws(() => parseConfig(YAML.replace('roles:\n', 'roles:\n  x-role: { model: medium, tools: [read], escalate_model: huge }\n')), /模型档位 huge 未在 models 中定义/);
});
