import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RoleTable, keyName, textWidth, type RoleRow } from '../../src/commands/role-table.ts';
import { runFlowConfig, type UiPort } from '../../src/commands/flow-config.ts';
import { loadRoleSettings } from '../../src/core/role-settings.ts';
import { parseConfig } from '../../src/core/config.ts';
import { REAL_TEMPLATE_YAML } from '../helpers/config.ts';

const models = [
  { ref: 'a/big', levels: ['off', 'low', 'high'] as const },
  { ref: 'b/small', levels: ['off'] as const },
].map((m) => ({ ref: m.ref, levels: [...m.levels] }));
const rows = (): RoleRow[] => [
  { role: 'architect', purpose: '模块规划', defaults: { model: 'a/big' } },
  { role: 'implementer', purpose: '模块实现', defaults: {} },
];
const DOWN = '\x1b[B';

test('按键名：传统序列与 Kitty 序列', () => {
  assert.equal(keyName('\x1b[A'), 'up');
  assert.equal(keyName('\x1bOB'), 'down');
  assert.equal(keyName('\x1b[1;1C'), 'right');
  assert.equal(keyName('\t'), 'tab');
  assert.equal(keyName('\x1b[9u'), 'tab');
  assert.equal(keyName('\x1b[Z'), 'shift-tab');
  assert.equal(keyName('\r'), 'enter');
  assert.equal(keyName('\x1b'), 'escape');
  assert.equal(keyName('x'), undefined);
});

const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';

test('Enter 打开选择列表，上下选择，Enter 确认，Esc 返回不改', () => {
  const t = new RoleTable(rows(), models);
  t.handleInput(ENTER);                       // 模型列：列表 [默认, a/big, b/small]
  assert.deepEqual(t.picker!.options, [undefined, 'a/big', 'b/small']);
  t.handleInput(DOWN); t.handleInput(DOWN);
  t.handleInput(ENTER);
  assert.equal(t.rows[0]!.model, 'b/small');
  assert.equal(t.picker, null);
  t.handleInput(ENTER);                       // 再打开：高亮停在当前值
  assert.equal(t.picker!.index, 2);
  t.handleInput(UP); t.handleInput(UP);       // 回到"默认"
  t.handleInput(ESC);                         // Esc 只关列表
  assert.equal(t.rows[0]!.model, 'b/small');
  t.handleInput(ENTER); t.handleInput(UP); t.handleInput(UP); t.handleInput(ENTER);
  assert.equal(t.rows[0]!.model, undefined);
});

test('Tab 切列、选行；备用模型与思考强度；Backspace 恢复默认；Esc 保存退出', () => {
  const t = new RoleTable(rows(), models);
  t.handleInput('\t'); t.handleInput(ENTER); t.handleInput(DOWN); t.handleInput(ENTER);
  assert.equal(t.rows[0]!.escalate, 'a/big');
  t.handleInput('\t'); t.handleInput(ENTER);          // 思考强度：默认模型 a/big 的 off/low/high
  assert.deepEqual(t.picker!.options, [undefined, 'off', 'low', 'high']);
  t.handleInput(DOWN); t.handleInput(DOWN); t.handleInput(ENTER);
  assert.equal(t.rows[0]!.thinking, 'low');
  t.handleInput(DOWN);
  assert.equal(t.row, 1);
  t.handleInput(UP);
  t.handleInput('\x7f');
  assert.equal(t.rows[0]!.thinking, undefined);
  assert.equal(t.handleInput(ESC), 'save');
});

test('换到不支持当前思考强度的模型时，思考强度回到默认', () => {
  const t = new RoleTable(rows(), models);
  t.handleInput('\t'); t.handleInput('\t');
  t.handleInput(ENTER); t.handleInput(DOWN); t.handleInput(DOWN); t.handleInput(DOWN); t.handleInput(ENTER);
  assert.equal(t.rows[0]!.thinking, 'high');
  t.handleInput('\t');                                 // 回到模型列
  t.handleInput(ENTER); t.handleInput(DOWN); t.handleInput(DOWN); t.handleInput(ENTER);   // b/small 只支持 off
  assert.equal(t.rows[0]!.model, 'b/small');
  assert.equal(t.rows[0]!.thinking, undefined);
});

test('列表打开时底部提示换成列表的按键，且不超宽', () => {
  const t = new RoleTable(rows(), models);
  assert.match(t.render(120).at(-1)!, /Enter 修改当前格.*Esc 保存并退出/);
  t.handleInput(ENTER);
  const lines = t.render(60);
  assert.match(lines.at(-1)!, /Enter 确认.*Esc 返回/);
  assert.ok(lines.some((l) => l.includes('选择 architect 的模型')));
});

test('渲染：每行不超过终端宽度，含表头与当前行标记', () => {
  const t = new RoleTable(rows(), models);
  for (const width of [60, 100, 160]) {
    const lines = t.render(width);
    for (const l of lines) assert.ok(textWidth(l.replace(/\x1b\[[0-9;]*m/g, '')) <= width, `宽 ${width}：${l}`);
  }
  const text = t.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /角色\s+职责\s+模型\s+备用模型\s+思考强度/);
  assert.match(text, /→ architect/);
  assert.match(t.render(120).at(-1)!, /Esc 保存并退出/);
});

test('/flow-config 表格：保存各行的模型、备用模型与思考强度，放弃时不写', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-rt-'));
  try {
    const settingsPath = path.join(dir, 'pi-flow.json');
    const config = parseConfig(REAL_TEMPLATE_YAML.replace('strong: "<provider/model>"', 'strong: "a/big"'));
    const mk = (edit: ((r: RoleRow[]) => RoleRow[] | null)): UiPort => ({
      select: async () => undefined, notify: () => {},
      editTable: async (r) => edit(r),
    });
    const modelOpts = [{ ref: 'a/big', name: 'Big', levels: ['off', 'low', 'high'] as const }, { ref: 'b/small', name: 'Small', levels: ['off'] as const }]
      .map((m) => ({ ...m, levels: [...m.levels] }));
    const deps = (ui: UiPort) => ({ ui, models: modelOpts, config, settingsPath });

    const seen: RoleRow[][] = [];
    const out = await runFlowConfig('', deps(mk((r) => {
      seen.push(r);
      return r.map((x) => (x.role === 'architect' ? { ...x, model: 'b/small', escalate: 'a/big', thinking: 'off' as const } : x));
    })));
    assert.match(out, /已保存/);
    assert.ok(seen[0]!.some((r) => r.role === 'orchestrator' && r.purpose.includes('主 agent')));
    const s = loadRoleSettings(settingsPath).roles['architect']!;
    assert.deepEqual(s, { model: 'b/small', thinking: 'off', escalate_model: 'a/big' });

    // 再打开：现有设置带入；恢复默认后清除
    const out2 = await runFlowConfig('', deps(mk((r) => {
      assert.equal(r.find((x) => x.role === 'architect')!.model, 'b/small');
      return r.map((x) => ({ ...x, model: undefined, escalate: undefined, thinking: undefined }));
    })));
    assert.match(out2, /已保存/);
    assert.deepEqual(loadRoleSettings(settingsPath).roles, {});

    assert.match(await runFlowConfig('', deps(mk(() => null))), /放弃/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
