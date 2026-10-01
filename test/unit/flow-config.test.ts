import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitArgs } from '../../src/commands/args.ts';
import { runFlowConfig, type UiPort, type ModelOption } from '../../src/commands/flow-config.ts';
import { loadRoleSettings } from '../../src/core/role-settings.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEMPLATE_YAML } from '../helpers/config.ts';

const config = parseConfig(TEMPLATE_YAML.replace('medium: "<provider/model>"', 'medium: "workbuddy/glm-5.3-flash"'));
const models: ModelOption[] = [
  { ref: 'workbuddy/glm-5.3-flash', name: 'GLM 5.3 Flash', levels: ['off', 'minimal', 'low', 'medium', 'high'] },
  { ref: 'openai-codex/gpt-5.5', name: 'GPT-5.5', levels: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { ref: 'local/tiny', name: 'Tiny', levels: ['off'] },
];

function env() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-fc-'));
  const settingsPath = path.join(dir, 'pi-flow.json');
  return { settingsPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 脚本化 UI：每次 select 用回调按选项文本挑选 */
function fakeUi(choices: ((title: string, options: string[]) => string | undefined)[]) {
  const seen: { title: string; options: string[] }[] = [];
  const notes: string[] = [];
  const ui: UiPort = {
    async select(title, options) {
      seen.push({ title, options });
      const pick = choices.shift();
      return pick ? pick(title, options) : undefined;
    },
    notify(msg) { notes.push(msg); },
  };
  return { ui, seen, notes };
}
const starts = (prefix: string) => (_t: string, opts: string[]) => {
  const o = opts.find((x) => x.startsWith(prefix));
  if (!o) throw new Error(`没有以 ${prefix} 开头的选项：${opts.join(' | ')}`);
  return o;
};

test('splitArgs 支持引号与转义', () => {
  assert.deepEqual(splitArgs('set  architect "workbuddy/glm-5.3-flash" high'), ['set', 'architect', 'workbuddy/glm-5.3-flash', 'high']);
  assert.deepEqual(splitArgs(`--feature "订单 导出" 'a b' c\\ d`), ['--feature', '订单 导出', 'a b', 'c d']);
  assert.deepEqual(splitArgs('  '), []);
  assert.throws(() => splitArgs('"abc'), /引号/);
});

test('交互：为角色选择模型与思考级别并保存；可连续设置多个角色', async () => {
  const { settingsPath, cleanup } = env();
  try {
    const { ui, seen } = fakeUi([
      starts('设置各角色'),
      starts('architect'), starts('workbuddy/glm-5.3-flash'), starts('high'),
      starts('reviewer'), starts('openai-codex/gpt-5.5'), starts('xhigh'),
      starts('完成'),
      starts('完成'),
    ]);
    await runFlowConfig('', { ui, models, config, settingsPath });
    const s = loadRoleSettings(settingsPath);
    assert.deepEqual(s.roles['architect'], { model: 'workbuddy/glm-5.3-flash', thinking: 'high' });
    assert.deepEqual(s.roles['reviewer'], { model: 'openai-codex/gpt-5.5', thinking: 'xhigh' });
    // 思考级别只列出该模型支持的
    const thinkingMenu = seen.find((x) => x.title.includes('architect') && x.title.includes('思考'))!;
    assert.ok(!thinkingMenu.options.some((o) => o.startsWith('xhigh')));
    // 角色菜单显示当前设置
    const roleMenus = seen.filter((x) => x.title.includes('选择角色'));
    assert.ok(roleMenus.at(-1)!.options.some((o) => o.startsWith('architect') && o.includes('workbuddy/glm-5.3-flash') && o.includes('high')));
    assert.ok(roleMenus[0]!.options.some((o) => o.startsWith('backend-engineer') && o.includes('workflow.yaml')));
  } finally { cleanup(); }
});

test('交互：选择"使用默认"会清除覆盖；取消不写文件', async () => {
  const { settingsPath, cleanup } = env();
  try {
    await runFlowConfig('set scout local/tiny off', { ui: null, models, config, settingsPath });
    const { ui } = fakeUi([starts('设置各角色'), starts('scout'), starts('使用 workflow.yaml'), starts('使用默认'), starts('完成'), starts('完成')]);
    await runFlowConfig('', { ui, models, config, settingsPath });
    assert.equal(loadRoleSettings(settingsPath).roles['scout'], undefined);

    const { ui: ui2 } = fakeUi([starts('设置各角色'), starts('architect'), () => undefined]);
    await runFlowConfig('', { ui: ui2, models, config, settingsPath });
    assert.equal(loadRoleSettings(settingsPath).roles['architect'], undefined);
  } finally { cleanup(); }
});

test('非交互：set / show / unset / models', async () => {
  const { settingsPath, cleanup } = env();
  try {
    const deps = { ui: null, models, config, settingsPath };
    assert.match(await runFlowConfig('set architect WorkBuddy/GLM-5.3-flash medium', deps), /architect.*workbuddy\/glm-5\.3-flash.*medium/);
    assert.deepEqual(loadRoleSettings(settingsPath).roles['architect'], { model: 'workbuddy/glm-5.3-flash', thinking: 'medium' });
    await runFlowConfig('set researcher default low', deps);
    assert.deepEqual(loadRoleSettings(settingsPath).roles['researcher'], { thinking: 'low' });
    const shown = await runFlowConfig('show', deps);
    assert.match(shown, /architect.*workbuddy\/glm-5\.3-flash.*medium.*\/flow-config/);
    assert.match(shown, /backend-engineer.*workbuddy\/glm-5\.3-flash.*workflow\.yaml/);
    assert.match(shown, /pi-flow\.json/);
    assert.match(await runFlowConfig('models', deps), /local\/tiny.*off/);
    await runFlowConfig('unset architect', deps);
    assert.equal(loadRoleSettings(settingsPath).roles['architect'], undefined);
    await runFlowConfig('unset all', deps);
    assert.deepEqual(loadRoleSettings(settingsPath).roles, {});
  } finally { cleanup(); }
});

test('非交互：非法输入给出中文错误且不写文件', async () => {
  const { settingsPath, cleanup } = env();
  try {
    const deps = { ui: null, models, config, settingsPath };
    await assert.rejects(runFlowConfig('set nobody workbuddy/glm-5.3-flash', deps), /角色 nobody 不存在/);
    await assert.rejects(runFlowConfig('set architect foo/bar', deps), /模型 foo\/bar 不可用/);
    await assert.rejects(runFlowConfig('set architect local/tiny high', deps), /local\/tiny 不支持思考级别 high.*off/);
    await assert.rejects(runFlowConfig('set architect workbuddy/glm-5.3-flash ultra', deps), /思考级别/);
    await assert.rejects(runFlowConfig('set architect', deps), /用法/);
    assert.match(await runFlowConfig('', deps), /用法/);
    assert.deepEqual(loadRoleSettings(settingsPath).roles, {});
  } finally { cleanup(); }
});
