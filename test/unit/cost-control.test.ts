import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/config.ts';
import { escalationModel, resolveModelRef } from '../../src/core/cost-control.ts';
import { TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';
import { mkTask, hard } from '../helpers/tasks.ts';

const YAML = TEST_YAML.replace(/models:[\s\S]*?\nmodes:/, 'models:\n  strong: "p/strong"\n  medium: "p/medium"\n  cheap:  "<provider/model>"\nmodes:');
const config = parseConfig(YAML);

test('模型引用与升级：档位或 provider/model；占位符取不到；默认升到上一档；/flow-config 优先；与原模型相同不升级', () => {
  assert.equal(resolveModelRef(config, 'strong'), 'p/strong');
  assert.equal(resolveModelRef(config, 'cheap'), null);
  assert.equal(resolveModelRef(config, 'x/y'), 'x/y');
  const none = { version: 1 as const, roles: {} };
  assert.equal(escalationModel(config, none, 'backend-engineer', 'p/medium'), 'p/strong');
  assert.equal(escalationModel(config, none, 'architect', 'p/strong'), null, 'strong 没有上一档');
  assert.equal(escalationModel(config, { version: 1, roles: { 'backend-engineer': { escalate_model: 'q/big' } } }, 'backend-engineer', 'p/medium'), 'q/big');
  assert.equal(escalationModel(config, none, 'backend-engineer', 'p/strong'), null);
  assert.throws(() => parseConfig(YAML.replace('roles:\n', 'roles:\n  x-role: { model: medium, tools: [read], escalate_model: huge }\n')), /模型档位 huge 未在 models 中定义/);
});

