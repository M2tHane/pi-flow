// 第四轮：阶段末审查一次 → 按模块并行修复 → 只确认不新增 → 全量测试与有限重试；崩溃恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { worktreePath } from '../../src/core/worktree.ts';
import { StateStore } from '../../src/core/state-store.ts';
import { resume } from '../../src/core/resume.ts';
import { actionsNeeded, renderStatus } from '../../src/core/status-view.ts';
import { nextStep } from '../../src/core/context-injector.ts';
import { setupProject, STAGE_REVIEW_YAML, type Project } from '../helpers/project.ts';
import { makeEngine, type RoleScript } from '../helpers/engine.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { mkTask } from '../helpers/tasks.ts';

const AUTO = STAGE_REVIEW_YAML.replace(/^  auto_dispatch: false$/m, '  auto_dispatch: true').replace(/  test:      ".*"/, '  test:      "true"');
const forever = () => new Promise<void>(() => {});
const until = async (cond: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
};
const TASKS = () => [mkTask('T-001'), mkTask('T-002', { role: 'frontend-engineer', scopes: ['frontend'], writes: ['src/web/t-002/**'] })];
const ISSUES = [
  { module: 'server', location: 'src/server/t-001/a.ts:1', problem: '没有校验输入', expected: '非法输入抛 ValidationError', files: ['src/server/t-001/a.ts'] },
  { module: 'server', location: 'src/server/t-001/b.ts:1', problem: '缺少测试', expected: '补上错误路径的测试', files: ['src/server/t-001/b.ts'] },
  { module: 'web', location: 'src/web/t-002/x.ts:1', problem: '与契约的字段名不符', expected: '改成 accountId', files: ['src/web/t-002/x.ts'] },
];

async function write(a: FakeAgent, files: Record<string, string>) {
  await a.call('flow_claim');
  for (const [p, c] of Object.entries(files)) assert.ok((await a.call('write', { path: p, content: c })).ok, p);
  await a.call('flow_note', { text: '完成' });
  const r = await a.call('flow_submit', { summary: Object.keys(files).join(',') });
  assert.ok(r.ok, r.text);
}

/** 实施任务、修复任务按 writes 写文件；审查与确认由参数决定 */
function script(p: Project, opts: { report?: (a: FakeAgent) => Promise<void>; confirm?: (a: FakeAgent) => Promise<void>; fix?: (a: FakeAgent, nth: number) => Promise<void> } = {}): RoleScript {
  return async (_role, nth, a) => {
    const t = p.store.readTask(p.flowId, a.env.task);
    if (t.stage_review === 'review') return opts.report ? opts.report(a) : void assert.ok((await a.call('flow_review_report', { summary: '没有问题', issues: [] })).ok);
    if (t.stage_review === 'confirm') return opts.confirm?.(a);
    if (t.kind === 'review-fix') {
      if (opts.fix) return opts.fix(a, nth);
      return write(a, Object.fromEntries(t.writes.map((w) => [w.includes('*') ? `${w.replace('/**', '')}/fix.ts` : w, `fixed ${t.id}`])));
    }
    const id = t.id.toLowerCase();
    return write(a, { [`${t.writes[0]!.replace('/**', '')}/${id}.ts`]: id });
  };
}

test('阶段末审查：3 条问题分属两个模块 → 两个修复任务并行 → 确认时清单外编号与漏答被拒、一条未解决 → 只再修一轮不再确认 → 全量测试通过', async () => {
  const p = await setupProject({ yaml: AUTO, tasks: TASKS() });
  try {
    const rejected: string[] = [];
    const { engine, launcher, errors } = makeEngine(p, script(p, {
      report: async (a) => {
        const bad = await a.call('flow_review_report', { summary: 's', issues: [{ ...ISSUES[0]!, files: ['docs/contracts/api.md'] }] });
        assert.equal(bad.ok, false);
        rejected.push(bad.text);
        assert.ok((await a.call('flow_review_report', { summary: '两个模块各有问题', issues: ISSUES })).ok);
      },
      confirm: async (a) => {
        const extra = await a.call('flow_review_confirm', { results: [{ id: 'R-1', resolved: true }, { id: 'R-2', resolved: true }, { id: 'R-3', resolved: true }, { id: 'R-4', resolved: false }] });
        assert.equal(extra.ok, false);
        rejected.push(extra.text);
        const partial = await a.call('flow_review_confirm', { results: [{ id: 'R-1', resolved: true }] });
        assert.equal(partial.ok, false);
        rejected.push(partial.text);
        assert.ok((await a.call('flow_review_confirm', { results: [{ id: 'R-1', resolved: true }, { id: 'R-2', resolved: false, note: '仍缺少错误路径的测试' }, { id: 'R-3', resolved: true }] })).ok);
      },
      fix: async (a) => {
        const t = p.store.readTask(p.flowId, a.env.task);
        const sr = p.store.readStageReview(p.flowId, 'S3')!;
        // 第一轮的两个修复任务同时在做（并行派发）
        if (sr.fix_tasks.includes(t.id)) await until(() => sr.fix_tasks.every((id) => !!p.store.readTask(p.flowId, id).lease));
        await write(a, Object.fromEntries(t.writes.map((w) => [w, `fixed ${t.id}`])));
      },
    }));
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.match(rejected[0]!, /契约或受保护文件/);
    assert.match(rejected[1]!, /R-4 不在清单中.*不能提出新问题/);
    assert.match(rejected[2]!, /还没有回答：R-2、R-3/);

    const sr = p.store.readStageReview(p.flowId, 'S3')!;
    assert.equal(sr.status, 'done');
    assert.deepEqual(sr.issues.map((i) => i.id), ['R-1', 'R-2', 'R-3']);
    const fixes = sr.fix_tasks.map((id) => p.store.readTask(p.flowId, id));
    assert.deepEqual(fixes.map((t) => [t.kind, t.role, t.review_issues, t.writes, t.status]), [
      ['review-fix', 'backend-engineer', ['R-1', 'R-2'], ['src/server/t-001/a.ts', 'src/server/t-001/b.ts'], 'done'],
      ['review-fix', 'frontend-engineer', ['R-3'], ['src/web/t-002/x.ts'], 'done'],
    ]);
    assert.equal(sr.refix_tasks.length, 1);
    const refix = p.store.readTask(p.flowId, sr.refix_tasks[0]!);
    assert.deepEqual([refix.role, refix.review_issues, refix.status], ['backend-engineer', ['R-2'], 'done']);
    assert.match(p.store.readHandoff(p.flowId, refix.id), /仍缺少错误路径的测试/);
    // 审查者只运行两次：审查一次、确认一次；第二轮修复后不再确认
    const reviewerRuns = p.store.listRuns().filter((r) => r.role === 'reviewer');
    assert.deepEqual(reviewerRuns.map((r) => r.review_mode).sort(), ['full', 'strong']);
    const prompts = launcher.launched.filter((s) => s.env['PI_FLOW_ROLE'] === 'reviewer').map((s) => s.prompt);
    assert.match(prompts[0]!, /阶段审查的要求[\s\S]*flow_review_report/);
    assert.match(prompts[0]!, /本阶段的改动[\s\S]*git diff [0-9a-f]{12} HEAD/);
    assert.match(prompts[1]!, /待确认的问题[\s\S]*R-2［server］[\s\S]*flow_review_confirm/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human', 'S3 是最后一个阶段：全量测试通过后等用户批准');
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/web/t-002/x.ts`), `fixed ${fixes[1]!.id}`);
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('阶段末审查：没有问题直接跑全量测试；测试失败按日志生成修复任务，两轮仍失败转"需要你处理"，/flow gate 重跑不再自动修', async () => {
  const yaml = AUTO.replace('auto: [test] }', 'auto: [e2e] }').replace(/  e2e:       ".*"/, `  e2e:       "echo 'FAIL src/server/t-001/t-001.ts:3 expected 1, got 2'; false"`);
  const p = await setupProject({ yaml, tasks: [mkTask('T-001')] });
  try {
    const { engine, errors } = makeEngine(p, script(p));
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const sr = p.store.readStageReview(p.flowId, 'S3')!;
    assert.equal(sr.status, 'needs_human', JSON.stringify(sr));
    assert.equal(sr.issues.length, 0);
    assert.equal(sr.test_rounds.length, 2);
    assert.match(sr.reason ?? '', /e2e.*自动修复 2 轮后仍失败/);
    for (const round of sr.test_rounds) {
      const t = p.store.readTask(p.flowId, round.tasks[0]!);
      assert.deepEqual([t.kind, t.role, t.writes, t.status], ['review-fix', 'backend-engineer', ['src/server/t-001/**'], 'done']);
      assert.match(p.store.readHandoff(p.flowId, t.id), /FAIL src\/server\/t-001\/t-001\.ts:3/);
    }
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    const act = actionsNeeded(p.store, p.config).find((x) => x.key.includes('stage-review'));
    assert.ok(act, JSON.stringify(actionsNeeded(p.store, p.config)));
    assert.match(act.text, /自动修复 2 轮后仍失败/);
    assert.match(renderStatus(p.store, p.config), /阶段审查：需要你处理/);
    assert.equal(nextStep(p.store, 2, 0, p.config).tool, 'none');
    const before = p.store.listTasks(p.flowId).length;
    await engine.rerunGate(p.flowId);
    assert.equal(p.store.listTasks(p.flowId).length, before, '/flow gate 失败后不再自动生成修复任务');
    assert.equal(p.store.readStageReview(p.flowId, 'S3')!.status, 'needs_human');
  } finally { p.cleanup(); }
});

const fresh = (p: Project) => new StateStore(p.dir, { limits: p.config.limits });

async function crashAndResume(p: Project, hangWhen: (t: ReturnType<Project['store']['readTask']>) => boolean) {
  const confirmAll = async (a: FakeAgent) => {
    const sr = p.store.readStageReview(p.flowId, 'S3')!;
    assert.ok((await a.call('flow_review_confirm', { results: sr.issues.map((i) => ({ id: i.id, resolved: true })) })).ok);
  };
  const report = async (a: FakeAgent) => { assert.ok((await a.call('flow_review_report', { summary: 's', issues: ISSUES.slice(0, 1) })).ok); };
  const base = script(p, { report, confirm: confirmAll });
  // 旧引擎：到达指定的任务时挂起（模拟会话被杀）
  const old = makeEngine(p, async (role, nth, a) => (hangWhen(p.store.readTask(p.flowId, a.env.task)) ? forever() : base(role, nth, a)));
  await old.engine.next(p.flowId);
  await until(() => p.store.listTasks(p.flowId).some((t) => hangWhen(t) && !!t.lease));
  const store = fresh(p);
  const r = await resume({ root: p.dir, store, config: p.config });
  assert.ok(r.ok, r.brief);
  const ok = makeEngine({ ...p, store }, script({ ...p, store }, { report, confirm: async (a) => {
    const sr = store.readStageReview(p.flowId, 'S3')!;
    assert.ok((await a.call('flow_review_confirm', { results: sr.issues.map((i) => ({ id: i.id, resolved: true })) })).ok);
  } }));
  await ok.engine.pump(p.flowId);
  await ok.engine.idle();
  assert.deepEqual(ok.errors, []);
  const sr = store.readStageReview(p.flowId, 'S3')!;
  assert.equal(sr.status, 'done', JSON.stringify(sr));
  assert.equal(store.readFlow(p.flowId).stage_status, 'awaiting_human');
  assert.equal(sr.fix_tasks.length, 1, '恢复后不重复生成修复任务');
  assert.deepEqual((await store.verifyIntegrity()).errors, []);
  return { store, sr };
}

test('崩溃恢复：修复中强杀后 /flow resume，修复任务重新派发，确认与全量测试照常完成', async () => {
  const p = await setupProject({ yaml: AUTO, tasks: [mkTask('T-001')] });
  try {
    const { store, sr } = await crashAndResume(p, (t) => t.kind === 'review-fix');
    const fix = store.readTask(p.flowId, sr.fix_tasks[0]!);
    assert.equal(fix.status, 'done');
    assert.equal(fix.interruptions, 1);
    assert.ok(sr.confirm_task && store.readTask(p.flowId, sr.confirm_task).status === 'done');
  } finally { p.cleanup(); }
});

test('崩溃恢复：确认中强杀后 /flow resume，确认任务重新派发，不重复生成修复任务', async () => {
  const p = await setupProject({ yaml: AUTO, tasks: [mkTask('T-001')] });
  try {
    const { store, sr } = await crashAndResume(p, (t) => t.stage_review === 'confirm');
    const confirm = store.readTask(p.flowId, sr.confirm_task!);
    assert.equal(confirm.status, 'done');
    assert.equal(confirm.interruptions, 1);
    assert.deepEqual(sr.confirm.map((c) => c.resolved), [true]);
    for (const id of [sr.review_task!, sr.confirm_task!]) {
      assert.ok(!existsSync(worktreePath(p.dir, p.flowId, id)), `${id} 的 worktree 已回收`);
      assert.equal(p.git('branch', '--list', `flow/${p.flowId}/${id}`), '', `${id} 的分支已删除`);
    }
  } finally { p.cleanup(); }
});

test('修复任务补契约：改动契约已有内容被拒，只新增被接受并合入；确认任务的 handoff 列出补充的契约', async () => {
  const p = await setupProject({ yaml: AUTO, tasks: [mkTask('T-001')], files: { 'docs/contracts/server.md': '# server\n\n## createThing\n参数：name\n' } });
  try {
    const attempts: string[] = [];
    const { engine, errors } = makeEngine(p, script(p, {
      report: async (a) => { assert.ok((await a.call('flow_review_report', { summary: 's', issues: ISSUES.slice(0, 1) })).ok); },
      confirm: async (a) => { assert.ok((await a.call('flow_review_confirm', { results: [{ id: 'R-1', resolved: true }] })).ok); },
      fix: async (a) => {
        await a.call('flow_claim');
        assert.ok((await a.call('write', { path: 'src/server/t-001/a.ts', content: 'fixed' })).ok);
        // 先改已有行：提交被拒
        assert.ok((await a.call('write', { path: 'docs/contracts/server.md', content: '# server\n\n## createThing\n参数：name, extra\n' })).ok);
        await a.call('flow_note', { text: '补契约' });
        const bad = await a.call('flow_submit', { summary: '改已有行' });
        assert.equal(bad.ok, false);
        attempts.push(bad.text);
        // 改成只追加
        assert.ok((await a.call('write', { path: 'docs/contracts/server.md', content: '# server\n\n## createThing\n参数：name\n\n## validateThing\n参数：input；错误：ValidationError\n' })).ok);
        const good = await a.call('flow_submit', { summary: '只追加' });
        assert.ok(good.ok, good.text);
      },
    }));
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    assert.match(attempts[0]!, /只能在契约中新增[\s\S]*git checkout/);
    const sr = p.store.readStageReview(p.flowId, 'S3')!;
    assert.equal(sr.status, 'done');
    assert.match(p.git('show', `flow/${p.flowId}/integration:docs/contracts/server.md`), /## validateThing/);
    assert.match(p.store.readHandoff(p.flowId, sr.confirm_task!), /修复时补充的契约[\s\S]*\+## validateThing/);
    assert.match(p.store.readHandoff(p.flowId, sr.fix_tasks[0]!), /可以直接在对应契约文件里新增/);
  } finally { p.cleanup(); }
});
