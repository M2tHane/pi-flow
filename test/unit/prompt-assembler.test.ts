import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgent, parseAgentFile } from '../../src/core/agents.ts';
import { assemblePrompt, ruleFilesFor, stageReviewSections } from '../../src/core/prompt-assembler.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEST_YAML);
const PKG_AGENTS = path.join(import.meta.dirname, '../../agents');

test('解析角色文件；项目 .pi/agents 覆盖包内定义', () => {
  const a = parseAgentFile('---\nname: x\ntier: strong\nthinking: high\n---\n\n正文\n', 'x.md');
  assert.equal(a.name, 'x');
  assert.equal(a.tier, 'strong');
  assert.equal(a.thinking, 'high');
  assert.equal(a.prompt, '正文');
  assert.throws(() => parseAgentFile('没有 frontmatter', 'y.md'), /frontmatter/);
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-ag-'));
  try {
    assert.match(loadAgent('reviewer', dir, PKG_AGENTS).prompt, /只读审查者/);
    mkdirSync(path.join(dir, '.pi/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.pi/agents/reviewer.md'), '---\nname: reviewer\n---\n项目自定义\n');
    assert.equal(loadAgent('reviewer', dir, PKG_AGENTS).prompt, '项目自定义');
    assert.throws(() => loadAgent('ghost', dir, PKG_AGENTS), /ghost/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('规则按 global + 任务 scopes 选择，缺失的文件报告出来', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-rules-'));
  try {
    mkdirSync(path.join(dir, 'rules'));
    writeFileSync(path.join(dir, 'rules/global.md'), 'G1');
    writeFileSync(path.join(dir, 'rules/backend.md'), 'B1');
    const r = ruleFilesFor(config, dir, ['backend', 'shared']);
    assert.deepEqual(r.rules.map((x) => x.path), ['rules/global.md', 'rules/backend.md']);
    assert.deepEqual(r.missing, ['rules/shared-types.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('提示组装顺序：角色提示 → 规则 → 任务与输入 → handoff 与打回意见；稳定前缀与任务无关', () => {
  const agent = { name: 'backend-engineer', tier: 'medium', thinking: null, description: '', prompt: 'ROLE-PROMPT' };
  const rules = [{ path: 'rules/global.md', content: 'RULE-G' }, { path: 'rules/backend.md', content: 'RULE-B' }];
  const t1 = mkTask('T-001', { title: '导出 API', acceptance: ['POST /exports 参数非法返回 422'], inputs: ['docs/contracts/export.ts'],
    last_failure: 'src/a.ts:3 缺少校验，应返回 422', base_sha: 'abc123' });
  const p1 = assemblePrompt({ agent, rules, task: t1, flowId: 'B-001', handoff: '## 上次做到 X', mode: 'impl', commands: config.commands });
  const p2 = assemblePrompt({ agent, rules, task: mkTask('T-002'), flowId: 'B-001', handoff: '', mode: 'impl', commands: config.commands });
  assert.equal(p1.system, p2.system, '稳定前缀不应随任务变化');
  const order = ['ROLE-PROMPT', 'RULE-G', 'RULE-B'].map((s) => p1.system.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0]! >= 0);
  const u = p1.user;
  const idx = ['T-001', '导出 API', 'POST /exports', 'docs/contracts/export.ts', 'src/server/t-001/**', 'pnpm test', '## 上次做到 X', '缺少校验']
    .map((s) => u.indexOf(s));
  assert.ok(idx.every((i) => i >= 0), JSON.stringify(idx));
  assert.ok(idx.indexOf(Math.max(...idx)) === idx.length - 1, '打回意见应在最后');
  assert.ok(u.indexOf('flow_claim') >= 0);
  assert.ok(!p1.system.includes('T-001'));
});

test('审查提示包含 base_sha 与验收标准', () => {
  const agent = { name: 'reviewer', tier: 'strong', thinking: null, description: '', prompt: 'R' };
  const p = assemblePrompt({ agent, rules: [], task: mkTask('T-001', { base_sha: 'abc123', acceptance: ['验收一'] }), flowId: 'B-001',
    handoff: 'H', mode: 'review', commands: config.commands, diffStat: ' src/a.ts | 3 +++' });
  assert.match(p.user, /abc123/);
  assert.match(p.user, /验收一/);
  assert.match(p.user, /flow_approve/);
  assert.match(p.user, /src\/a\.ts \| 3/);
});

test('第二轮起的审查：附上次打回的问题与之后的改动，只核对上次的问题；到轮次上限时允许只剩建议就通过', () => {
  const agent = { name: 'reviewer', tier: 'medium', thinking: null, description: '', prompt: 'R' };
  const task = mkTask('T-001', { base_sha: 'abc123', last_failure: '1. a.ts:3：缺少校验；期望：加校验' });
  const base = { agent, rules: [], task, flowId: 'B-001', handoff: '', commands: config.commands };
  const first = assemblePrompt({ ...base, mode: 'review' });
  assert.match(first.user, /上次未通过的原因/);
  assert.doesNotMatch(first.user, /轮审查/);
  const pr = { round: 2, issues: task.last_failure!, head: 'def456', sinceDiff: ' src/a.ts | 2 +-' };
  const second = assemblePrompt({ ...base, mode: 'review', previousReview: pr });
  assert.match(second.user, /## 第 2 轮审查：先核对上次打回的问题\n\n上次审查打回的问题：\n1\. a\.ts:3：缺少校验/);
  assert.match(second.user, /git diff def456 HEAD[\s\S]*src\/a\.ts \| 2/);
  assert.match(second.user, /逐条核对[\s\S]*只为两类问题打回[\s\S]*不要提出新的改进建议[\s\S]*flow_block/);
  assert.doesNotMatch(second.user, /上次未通过的原因/, '不重复列出');
  assert.doesNotMatch(second.user, /轮次上限/);
  assert.match(assemblePrompt({ ...base, mode: 'review', previousReview: { ...pr, round: 3, maxRounds: 3 } }).user, /已到审查轮次上限（3 轮）/);
  const impl = assemblePrompt({ ...base, agent: { ...agent, name: 'backend-engineer' }, mode: 'impl', previousReview: pr });
  assert.doesNotMatch(impl.user, /轮审查/, '实施提示不受影响');
  assert.match(impl.user, /上次未通过的原因/);
});

test('审查提示直接附上 diff：第一轮是全部改动，第二轮起是上次审查之后的改动；没给时不出现', () => {
  const agent = { name: 'reviewer', tier: 'medium', thinking: null, description: '', prompt: 'R' };
  const base = { agent, rules: [], task: mkTask('T-001', { base_sha: 'abc123' }), flowId: 'B-001', handoff: '', mode: 'review' as const, commands: config.commands };
  const first = assemblePrompt({ ...base, inlineDiff: 'diff --git a/x b/x\n+1\n' });
  assert.match(first.user, /## 本任务的全部改动（已附 diff，不必再运行 git diff）\n```diff\ndiff --git a\/x b\/x\n\+1\n```/);
  assert.ok(first.user.indexOf('```diff') < first.user.indexOf('开始：审查'));
  const second = assemblePrompt({ ...base, inlineDiff: '', previousReview: { round: 2, issues: '1. x', head: 'def4567890abcdef' } });
  assert.match(second.user, /## 上次审查（def4567890ab）之后的改动（已附 diff，不必再运行 git diff）\n（没有改动）/);
  assert.doesNotMatch(assemblePrompt(base).user, /已附 diff/);
});

test('审查设计任务时附上 architect 申报的超出需求的设计；没申报时写明应只覆盖需求', () => {
  const agent = { name: 'reviewer', tier: 'medium', thinking: null, description: '', prompt: 'R' };
  const base = { agent, rules: [], task: mkTask('T-002', { stage: 'S1', kind: 'doc' }), flowId: 'B-001', handoff: '', mode: 'review' as const, commands: config.commands };
  assert.match(assemblePrompt({ ...base, proposalExtras: ['迁移支持回滚：方便演示环境重置'] }).user, /超出需求的设计（extras）\n- 迁移支持回滚[\s\S]*按缺陷打回/);
  assert.match(assemblePrompt({ ...base, proposalExtras: [] }).user, /没有申报：文档应当只覆盖需求/);
  assert.doesNotMatch(assemblePrompt(base).user, /extras/);
});

test('返工接着上一次的对话：用户消息只有续做说明，系统提示不变', () => {
  const agent = { name: 'backend-engineer', tier: 'medium', thinking: null, description: '', prompt: 'R' };
  const task = mkTask('T-001', { base_sha: 'abc123', last_failure: '审查前验证失败：test 退出码 1' });
  const base = { agent, rules: [], task, flowId: 'B-001', handoff: 'HANDOFF', mode: 'impl' as const, commands: config.commands, scratchDir: '/tmp/s/r-2' };
  const full = assemblePrompt(base);
  const cont = assemblePrompt({ ...base, continuation: { run: 'r-1' } });
  assert.equal(cont.system, full.system, '系统提示相同，命中缓存');
  assert.match(cont.user, /^# 继续任务 B-001\/T-001[\s\S]*r-1[\s\S]*审查前验证失败：test 退出码 1[\s\S]*\/tmp\/s\/r-2[\s\S]*flow_claim/);
  assert.doesNotMatch(cont.user, /验收标准|HANDOFF/, '任务说明与 handoff 已在对话里，不重复');
  assert.ok(cont.user.length < full.user.length);
});

test('重新派发时提示工作区已有的改动，位于任务说明之后、handoff 之前', () => {
  const agent = { name: 'backend-engineer', tier: 'medium', thinking: null, description: '', prompt: 'R' };
  const p = assemblePrompt({ agent, rules: [], task: mkTask('T-001', { base_sha: 'abc123' }), flowId: 'B-001', handoff: 'HANDOFF', mode: 'impl',
    commands: config.commands, existingWork: ' src/server/t-001/a.ts | 3 +++\n\n未提交：\n?? src/server/t-001/b.ts' });
  const iWork = p.user.indexOf('## 工作区已有的改动');
  assert.ok(iWork > p.user.indexOf('## verify 命令') && iWork < p.user.indexOf('HANDOFF'));
  assert.match(p.user, /git diff abc123[\s\S]*b\.ts/);
  const review = assemblePrompt({ agent, rules: [], task: mkTask('T-001'), flowId: 'B-001', handoff: '', mode: 'review', commands: config.commands, existingWork: 'x' });
  assert.doesNotMatch(review.user, /工作区已有的改动/, '审查提示不需要');
});

test('拆任务时附上各实施角色的模型：全是强模型提示拆大任务，否则提示拆小任务', () => {
  const agent = { name: 'architect', tier: 'strong', thinking: null, description: '', prompt: 'A' };
  const base = { agent, rules: [], task: mkTask('T-002', { stage: 'S1', kind: 'doc', role: 'architect' }), flowId: 'B-001', handoff: '', mode: 'impl' as const, commands: config.commands };
  assert.match(assemblePrompt({ ...base, implModels: [{ role: 'backend-engineer', model: 'p/gpt', strong: true }] }).user, /实施角色的模型[\s\S]*backend-engineer：p\/gpt（强模型）[\s\S]*拆大任务/);
  assert.match(assemblePrompt({ ...base, implModels: [{ role: 'backend-engineer', model: 'p/glm', strong: false }] }).user, /不是强模型：任务要小/);
  assert.doesNotMatch(assemblePrompt(base).user, /实施角色的模型/);
});

test('适配已有测试：阶段审查与确认列出改了别的角色已有测试的任务，要求核对没有削弱', () => {
  const adj = [{ task: 'T-003', files: ['tests/acceptance/api.test.js'] }];
  const review = stageReviewSections({ kind: 'review', baseSha: null, testAdjustments: adj }).join('\n');
  assert.match(review, /修改了别的角色已有测试的改动\n- T-003：tests\/acceptance\/api\.test\.js/);
  assert.match(review, /削弱测试，作为问题提出/);
  const confirm = stageReviewSections({ kind: 'confirm', baseSha: null, issues: [], testAdjustments: adj }).join('\n');
  assert.match(confirm, /判为未解决/);
  assert.doesNotMatch(stageReviewSections({ kind: 'review', baseSha: null }).join('\n'), /已有测试的改动/);
});
