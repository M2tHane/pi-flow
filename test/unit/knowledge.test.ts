import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/core/config.ts';
import { addEntry, appliesTo, checkInput, selectKnowledge, formatEntry, defaultRuleTarget, KnowledgeError, KNOWLEDGE_PROMPT_MAX } from '../../src/core/knowledge.ts';
import { assemblePrompt, upstreamSection, UPSTREAM_TOTAL } from '../../src/core/prompt-assembler.ts';
import type { KnowledgeFile, KnowledgeEntry } from '../../src/core/schemas.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEST_YAML);
const src = { kind: 'agent' as const, flow: 'B-001', task: 'T-001', run: 'r-1', role: 'backend-engineer' };
const add = (k: KnowledgeFile, content: string, over: Partial<KnowledgeEntry> = {}) =>
  addEntry(k, { category: 'pitfall', content, scopes: over.scopes ?? [], paths: over.paths ?? [], source: src, status: over.status === 'candidate' ? 'candidate' : 'active' }, '2026-10-01T00:00:00Z');

test('知识条目校验：类别、长度、scope 存在、路径在仓库内', () => {
  assert.deepEqual(checkInput(config, { category: 'pitfall', content: '金额一律用整数分存储，避免浮点误差', scopes: ['backend'], paths: ['src/server/**'] }), []);
  const errs = checkInput(config, { category: 'pitfall', content: '短', scopes: ['nope'], paths: ['../x', '/etc/passwd', '.flow/knowledge.json'] });
  assert.equal(errs.length, 5, errs.join('\n'));
  assert.ok(checkInput(config, { category: 'pitfall', content: 'x'.repeat(501) }).some((e) => e.includes('500')));
});

test('知识条目编号递增；内容相同（忽略空白与标点）即判重复；已废弃的不参与去重', () => {
  const k: KnowledgeFile = { entries: [], version: 1 };
  assert.equal(add(k, '金额一律用整数分存储。').id, 'K-001');
  assert.throws(() => add(k, '金额 一律用整数分存储'), KnowledgeError);
  k.entries[0]!.status = 'retired';
  assert.equal(add(k, '金额一律用整数分存储').id, 'K-002');
});

test('按任务选择知识：全局、scope 相交、路径重叠；只取生效中；超出上限保留最近的并按编号排序', () => {
  const k: KnowledgeFile = { entries: [], version: 1 };
  add(k, '全局：提交前跑 typecheck');
  add(k, '后端：handler 只做参数解析', { scopes: ['backend'] });
  add(k, '前端：组件不直接请求接口', { scopes: ['frontend'] });
  add(k, '订单模块：金额用整数分', { paths: ['src/server/orders/**'] });
  add(k, '候选：还没确认', { status: 'candidate' });
  const t = mkTask('T-009', { scopes: ['backend'], writes: ['src/server/orders/api.ts'] });
  assert.deepEqual(selectKnowledge(k, t).map((e) => e.id), ['K-001', 'K-002', 'K-004']);
  assert.equal(appliesTo(k.entries[2]!, t), false);
  for (let i = 0; i < KNOWLEDGE_PROMPT_MAX + 5; i++) add(k, `批量经验第 ${i} 条，内容各不相同`);
  const picked = selectKnowledge(k, t);
  assert.equal(picked.length, KNOWLEDGE_PROMPT_MAX);
  assert.equal(picked.at(-1)!.id, k.entries.at(-1)!.id);
  assert.deepEqual(picked.map((e) => e.id), [...picked.map((e) => e.id)].sort());
});

test('提示：项目知识在系统提示末尾（技能之后），声明不是规则；上游 handoff 在用户消息中、受长度限制；没有时不出现', () => {
  const agent = { name: 'backend-engineer', tier: 'medium', thinking: null, description: '', prompt: 'ROLE' };
  const base = { agent, rules: [{ path: 'rules/global.md', content: 'RULE-G' }], skills: [{ path: 'skills/x', content: 'SKILL-X' }], flowId: 'B-001', handoff: '', mode: 'impl' as const, commands: config.commands };
  const k: KnowledgeFile = { entries: [], version: 1 };
  const e = add(k, '订单金额用整数分存储', { scopes: ['backend'] });
  const p = assemblePrompt({ ...base, task: mkTask('T-002'), knowledge: [formatEntry(e)],
    upstream: [{ id: 'T-001', title: '订单模型', type: 'hard', status: '已完成', handoff: `${'旧内容\n'.repeat(400)}最后：迁移文件已建好` }] });
  assert.ok(p.system.indexOf('SKILL-X') < p.system.indexOf('# 项目知识'));
  assert.match(p.system, /不是规则，与上面的规则冲突时以规则为准[\s\S]*K-001 \[坑\]（backend） 订单金额用整数分存储/);
  assert.match(p.user, /## 上游任务的 handoff[\s\S]*T-001「订单模型」（硬依赖，已完成）[\s\S]*迁移文件已建好/);
  assert.ok(p.user.indexOf('上游任务的 handoff') > p.user.indexOf('verify 命令'));
  const plain = assemblePrompt({ ...base, task: mkTask('T-002'), upstream: [{ id: 'T-001', title: 'x', type: 'soft', status: '已完成', handoff: '' }] });
  assert.ok(!plain.system.includes('# 项目知识'));
  assert.ok(!plain.user.includes('上游任务'));
  const many = upstreamSection(Array.from({ length: 10 }, (_, i) => ({ id: `T-00${i}`, title: 't', type: 'hard' as const, status: '已完成', handoff: 'x'.repeat(2000) })));
  assert.ok(many.length < UPSTREAM_TOTAL + 1000, String(many.length));
  const review = assemblePrompt({ ...base, mode: 'review', task: mkTask('T-002'), upstream: [{ id: 'T-001', title: 'x', type: 'hard', status: '已完成', handoff: 'abc' }] });
  assert.ok(!review.user.includes('上游任务'), '审查提示不带上游 handoff');
});

test('提升为规则草案的目标：条目共同 scope 的规则文件，否则 global', () => {
  const k: KnowledgeFile = { entries: [], version: 1 };
  const a = add(k, '后端约定一：参数用 zod 校验', { scopes: ['backend'] });
  const b = add(k, '后端约定二：错误码集中定义', { scopes: ['backend', 'shared'] });
  const c = add(k, '全局约定：提交信息用中文');
  assert.equal(defaultRuleTarget(config, [a, b]), 'backend.md');
  assert.equal(defaultRuleTarget(config, [a, c]), 'global.md');
});
