// 第二轮 B + C 验收：上游 handoff 传给下游；项目级知识库的写入、注入、候选、废弃、提升为规则与完整性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { acceptCandidate, retireEntries, promoteToDraft, markPromoted, selectKnowledge } from '../../src/core/knowledge.ts';
import { applyDrafts, listDrafts } from '../../src/core/rules-draft.ts';
import { renderStatus } from '../../src/core/status-view.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');
const LESSON = '订单金额一律用整数分存储，避免浮点误差';

async function implement(a: FakeAgent, file: string, note: string) {
  assert.ok((await a.call('flow_claim')).ok);
  assert.ok((await a.call('write', { path: file, content: 'x\n' })).ok, file);
  await a.call('flow_note', { text: note });
  const r = await a.call('flow_submit', { summary: file });
  assert.ok(r.ok, r.text);
}

test('知识库：agent 提交的知识注入后续同 scope 任务的提示，下游看到上游 handoff；审查打回生成候选，确认后才注入；可废弃、可提升为规则；完整性校验覆盖', async () => {
  const p = await setupProject({ yaml: YAML, tasks: [
    mkTask('T-001', { verify: [] }),
    mkTask('T-002', { verify: [], deps: [{ task: 'T-001', type: 'hard', reason: '需要订单模型' }] }),
    mkTask('T-003', { role: 'frontend-engineer', scopes: ['frontend'], writes: ['src/web/t-003/**'], verify: [] }),
  ] });
  try {
    const settings = { version: 1 as const, roles: { 'backend-engineer': { model: 'f/m' }, 'frontend-engineer': { model: 'f/m' }, reviewer: { model: 'f/r' } } };
    const { engine, launcher, errors } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') {
        if (a.env.task === 'T-001' && nth === 1) {
          assert.ok((await a.call('flow_approve', { decision: 'reject', issues: [{ location: 'src/server/t-001/a.ts:1', problem: '缺少金额校验', expected: '金额必须是正整数' }] })).ok);
        } else assert.ok((await a.call('flow_approve', { decision: 'pass', notes: 'ok' })).ok);
        return;
      }
      if (a.env.task === 'T-001') {
        if (nth === 1) {
          const r = await a.call('flow_learn', { category: 'convention', content: LESSON, scopes: ['backend'] });
          assert.ok(r.ok, r.text);
          assert.ok(!(await a.call('flow_learn', { category: 'convention', content: `${LESSON}。` })).ok, '重复内容被拒');
          assert.ok(!(await a.call('flow_learn', { category: 'pitfall', content: '范围不存在的经验条目', scopes: ['nope'] })).ok, 'scope 不存在被拒');
          // agent 不能直接改知识库文件
          const w = await a.call('write', { path: path.join(p.dir, '.flow/knowledge.json'), content: '{}' });
          assert.ok(!w.ok, w.text);
        }
        return implement(a, 'src/server/t-001/a.ts', `订单模型已建好（第 ${nth} 次）`);
      }
      if (a.env.task === 'T-002') return implement(a, 'src/server/t-002/a.ts', '完成');
      return implement(a, 'src/web/t-003/a.ts', '完成');
    }, settings);
    await engine.next(p.flowId);
    await engine.idle();
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    for (const id of ['T-001', 'T-002', 'T-003']) assert.equal(p.store.readTask(p.flowId, id).status, 'done', id);

    const specOf = (task: string) => launcher.launched.find((s) => s.env['PI_FLOW_TASK'] === task && s.env['PI_FLOW_ROLE'] !== 'reviewer')!;
    const sys = (task: string) => readFileSync(specOf(task).appendSystemPromptFiles[0]!, 'utf8');
    // 同 scope 的后续任务看到知识；其他 scope 的看不到
    assert.match(sys('T-002'), new RegExp(`K-001 \\[约定\\]（backend） ${LESSON}`));
    assert.ok(!sys('T-003').includes(LESSON));
    // 下游看到上游 handoff
    assert.match(specOf('T-002').prompt, /## 上游任务的 handoff[\s\S]*T-001「任务 T-001」（硬依赖，已完成）[\s\S]*订单模型已建好（第 2 次）/);
    assert.ok(!specOf('T-003').prompt.includes('上游任务的 handoff'));

    // 审查打回生成候选：未确认前不注入
    const k = p.store.readKnowledge();
    const cand = k.entries.find((e) => e.status === 'candidate')!;
    assert.equal(cand.source.kind, 'review');
    assert.match(cand.content, /T-001「任务 T-001」审查打回：1\. src\/server\/t-001\/a\.ts:1：缺少金额校验/);
    assert.ok(!sys('T-002').includes('缺少金额校验'));
    assert.match(renderStatus(p.store, p.config), /1 条知识候选待确认/);
    const t2 = p.store.readTask(p.flowId, 'T-002');
    await acceptCandidate(p.store, cand.id, '订单金额必须校验为正整数（分）');
    assert.deepEqual(selectKnowledge(p.store.readKnowledge(), t2).map((e) => e.content), [LESSON, '订单金额必须校验为正整数（分）']);
    assert.doesNotMatch(renderStatus(p.store, p.config), /知识候选/);

    // 废弃
    await retireEntries(p.store, [cand.id], '与规则重复');
    assert.deepEqual(selectKnowledge(p.store.readKnowledge(), t2).map((e) => e.id), ['K-001']);

    // 提升为规则草案（主分支上提交），用户应用后条目标为已成为规则
    const r = await promoteToDraft(p.dir, p.store, p.config, ['K-001']);
    assert.equal(r.file, 'docs/rules-draft/backend.md');
    const drafts = listDrafts(p.dir, 'main');
    assert.equal(drafts.length, 1);
    assert.match(drafts[0]!.content, /handler 内不写业务逻辑[\s\S]*1\. 订单金额一律用整数分存储，避免浮点误差（来自知识 K-001）/);
    assert.ok(selectKnowledge(p.store.readKnowledge(), t2).length === 1, '应用前仍作为知识注入');
    applyDrafts(p.dir, drafts, '知识库');
    assert.deepEqual(await markPromoted(p.store, drafts.map((d) => d.file)), ['K-001']);
    assert.match(readFileSync(path.join(p.dir, 'rules/backend.md'), 'utf8'), /来自知识 K-001/);
    assert.deepEqual(selectKnowledge(p.store.readKnowledge(), t2), []);

    // 跨流程保留
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    const f2 = await p.store.createFlow({ mode: 'build', title: '第二个流程', stages: ['S3'], base_sha: p.git('rev-parse', 'HEAD') });
    assert.ok(f2.id !== p.flowId);
    assert.equal(p.store.readKnowledge().entries.length, 2);

    // 完整性校验覆盖知识库
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
    writeFileSync(path.join(p.dir, '.flow/knowledge.json'), JSON.stringify({ entries: [], version: 9 }));
    assert.ok((await p.store.verifyIntegrity()).errors.some((e) => e.includes('knowledge.json')));
  } finally { p.cleanup(); }
});
