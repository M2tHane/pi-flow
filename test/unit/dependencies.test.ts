import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../src/core/config.ts';
import { checkDependencies, compareVersions, inRange, PI_REQUIREMENT } from '../../src/core/dependencies.ts';
import { REAL_TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';

const config = parseConfig(TEST_YAML);
const probe = { serena: () => true, serenaVersion: () => '1.7.0', codegraphVersion: () => '1.6.0' };
const pkg = (root: string, name: string, version: string) => {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, version }));
};
const by = (items: ReturnType<typeof checkDependencies>, item: string) => items.find((i) => i.item === item)!;

test('版本比较与验证区间', () => {
  assert.ok(compareVersions('1.0.0', '0.99.2') > 0);
  assert.ok(compareVersions('0.99.0', '0.99.0') === 0);
  assert.ok(inRange('1.0.0', PI_REQUIREMENT.tested));
  assert.ok(inRange('0.99.2', PI_REQUIREMENT.tested));
  assert.ok(!inRange('2.0.0', PI_REQUIREMENT.tested));
});

test('依赖检查：Pi 过低报错、超出验证范围提醒；插件按角色是否用到检查，缺失给安装命令与链接；版本不符提醒', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-deps-'));
  try {
    const root = path.join(dir, 'nm');
    pkg(root, '@bacnh85/pi-serena', '0.9.20');
    pkg(root, '@vndv/pi-codegraph', '0.3.0');
    const items = checkDependencies({ config, piVersion: '1.0.0', packageRoots: [root], probe });
    assert.equal(by(items, 'Pi').level, 'ok');
    assert.equal(by(items, '@bacnh85/pi-serena').level, 'ok');
    const cg = by(items, '@vndv/pi-codegraph');
    assert.equal(cg.level, 'warn');
    assert.match(cg.detail, /0\.3\.0 未经验证.*pi install npm:@vndv\/pi-codegraph@0\.1\.10/);
    const web = by(items, 'pi-web-access');
    assert.equal(web.level, 'warn');
    assert.match(web.detail, /未安装：researcher .*pi install npm:pi-web-access.*https:\/\/github\.com\/nicobailon\/pi-web-access/);
    assert.equal(by(items, 'Serena').level, 'ok');
    assert.equal(by(items, 'codegraph').level, 'ok');

    assert.equal(by(checkDependencies({ config, piVersion: '0.98.0', packageRoots: [root], probe }), 'Pi').level, 'error');
    assert.match(by(checkDependencies({ config, piVersion: '2.1.0', packageRoots: [root], probe }), 'Pi').detail, /未经验证/);
    const noSerena = checkDependencies({ config, packageRoots: [root], probe: { ...probe, serena: () => false } });
    assert.match(by(noSerena, 'Serena').detail, /uv tool install serena-agent.*github\.com\/oraios\/serena/);
    // 没有角色用到的插件不检查
    const noWeb = parseConfig(TEST_YAML.replace('tools: [read, write, "@web", flow_note, flow_submit]', 'tools: [read, write, flow_note, flow_submit]'));
    assert.equal(checkDependencies({ config: noWeb, packageRoots: [root], probe }).find((i) => i.item === 'pi-web-access'), undefined);
    // 主 agent 的选择题提问插件：模板里 orchestrator 用到，没装时提醒（不影响开始）
    const ask = by(checkDependencies({ config: parseConfig(REAL_TEMPLATE_YAML), packageRoots: [root], probe }), '@tian.zuo/pi-ask-user');
    assert.equal(ask.level, 'warn');
    assert.match(ask.detail, /未安装：orchestrator .*pi install npm:@tian\.zuo\/pi-ask-user/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
