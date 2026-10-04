// 真实 pi 子进程 + 假 LLM（OpenAI 兼容流式服务）：验证 pi-adapter（启动参数、子进程扩展、guard、flow_* 工具、token 统计）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Engine } from '../../src/core/dispatcher.ts';
import { PiLauncher, buildPiArgs } from '../../src/pi-adapter/launcher.ts';
import { summarizeSession } from '../../src/core/session-log.ts';
import { pluginExtensionsFor } from '../../src/pi-adapter/plugins.ts';
import { readFileSync } from 'node:fs';
import { parseConfig } from '../../src/core/config.ts';
import { PROJECT_YAML } from '../helpers/project.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject, DIRECT_YAML, STAGE_REVIEW_YAML } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }

before(async () => {
  llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: '/tmp/pi-flow-e2e-llm.log' });
  process.env['FAKE_LLM_URL'] = llm.url;
  // 测试不需要联网：关闭模型目录刷新与版本检查（网络不通时 pi 启动会被拖慢约 60 秒）
  process.env['PI_OFFLINE'] = '1';
  process.env['PI_SKIP_VERSION_CHECK'] = '1';
  process.env['FAKE_LLM_SCRIPTS'] = SCRIPTS;
});
after(() => llm?.close());

test('buildPiArgs：关闭扩展发现、guard 扩展最后、工具白名单、提示放在 -- 之后', () => {
  const args = buildPiArgs({ cwd: '/w', model: 'p/m', thinking: 'low', tools: ['read', 'flow_claim'], extensions: ['/x.ts', '/sub.ts'],
    appendSystemPromptFiles: ['/s.md'], prompt: '--不是参数', env: {} });
  assert.deepEqual(args.slice(0, 8), ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']);
  assert.equal(args[args.lastIndexOf('-e') + 1], '/sub.ts');
  assert.deepEqual(args.slice(-2), ['--', '--不是参数']);
  const kept = buildPiArgs({ cwd: '/w', model: null, thinking: null, tools: [], extensions: [], appendSystemPromptFiles: [], prompt: 'x', env: {}, sessionDir: '/s/r-1' });
  assert.deepEqual(kept.slice(0, 5), ['--mode', 'json', '-p', '--session-dir', '/s/r-1']);
  assert.ok(!kept.includes('--no-session'));
  const forked = buildPiArgs({ cwd: '/w', model: null, thinking: null, tools: [], extensions: [], appendSystemPromptFiles: [], prompt: 'x', env: {}, sessionDir: '/s/r-2', forkFrom: '/s/r-1/a.jsonl' });
  assert.deepEqual(forked.slice(0, 7), ['--mode', 'json', '-p', '--session-dir', '/s/r-2', '--fork', '/s/r-1/a.jsonl']);
  assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === 'read,flow_claim');
});

test('真实 pi 子进程：实施 → 审查 → verify → 合并；越权被拦且计入违规；token 用量写入 run', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: {
        'backend-engineer': { model: 'fakellm/impl-happy' }, reviewer: { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''} ${t.blocked_reason ?? ''}`);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;', '审查者的写入必须被拦下');

    const violations = p.store.readEvents().filter((e) => e.type === 'violation');
    assert.deepEqual(violations.map((v) => [v.data?.['role'], v.data?.['rule']]), [['backend-engineer', 'write_paths'], ['reviewer', 'bash']]);

    const runs = p.store.listRuns();
    const impl = runs.find((r) => r.role === 'backend-engineer')!;
    const rev = runs.find((r) => r.role === 'reviewer')!;
    assert.equal(impl.outcome, 'submitted');
    assert.equal(rev.outcome, 'approved');
    assert.equal(impl.model, 'fakellm/impl-happy');
    // 假 LLM：默认每轮 prompt 100+turn、completion 10；第 3 轮 800/30/缓存 600 → input 不含缓存
    assert.equal(impl.tokens.output, 10 * 5 + 30);
    assert.equal(impl.tokens.cache_read, 600);
    assert.ok(impl.tokens.input! > 0 && rev.tokens.input! > 0);
    // 会话留档：每个 run 的会话文件在 <项目>.worktrees/.sessions/<run>/ 下，可摘要出工具调用与最后的回复
    for (const r of [impl, rev]) {
      assert.ok(r.session_file && r.session_file.startsWith(r.session_dir!), JSON.stringify(r));
      assert.ok(existsSync(r.session_file));
    }
    const s = summarizeSession(impl.session_file!);
    assert.deepEqual(s.toolCalls.map((c) => c.name).filter((n) => n.startsWith('flow_')), ['flow_claim', 'flow_note', 'flow_submit']);
    assert.ok(s.toolCalls.some((c) => c.error), '被 guard 拦下的写入应显示为失败的工具调用');
    assert.deepEqual((await p.store.verifyIntegrity()).errors, []);
  } finally { p.cleanup(); }
});

test('codemode：审查者在脚本中并行调用工具；脚本内的越权调用同样被 guard 拦下并计违规', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const yaml = PROJECT_YAML.replace(/(  reviewer:\s+\{[^}]*tools: \[)/, '$1codemode, ');
  assert.match(yaml, /reviewer:[^\n]*codemode/);
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const config = parseConfig(yaml);
    const logFile = '/tmp/pi-flow-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-happy' }, reviewer: { model: 'fakellm/review-codemode' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: (role) => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts'), ...pluginExtensionsFor(config, role, []).paths],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''}`);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;', '脚本中的写入被拦下');
    const v = p.store.readEvents().filter((e) => e.type === 'violation' && e.data?.['role'] === 'reviewer');
    assert.equal(v.length, 1);
    assert.equal(v[0]!.data?.['tool'], 'bash');
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'review-codemode');
    assert.ok(reqs[0].tools.includes('codemode'), JSON.stringify(reqs[0].tools));
    const result = JSON.stringify(reqs[1].last);
    assert.match(result, /Script failed/);
    assert.match(result, /DIFF:.*a\.ts.*FILE:export const a = 1;/);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：模型返回额度用完（429 insufficient_quota）时暂停该模型，任务不计失败', { skip: !piAvailable && 'pi 不可用', timeout: 120_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/quota' }, reviewer: { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.attempts, 0, `${t.last_failure ?? ''}`);
    assert.equal(t.lease, null);
    const runs = p.store.listRuns();
    assert.equal(runs.length, 1, '暂停后不再派发');
    assert.equal(runs[0]!.outcome, 'unavailable');
    const pause = p.store.readModelPauses().pauses[0];
    assert.equal(pause?.model, 'fakellm/quota');
    assert.equal(pause?.kind, 'quota');
    assert.match(pause?.reason ?? '', /quota/);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：返工时接着上一次的对话继续（--fork），只给简短的续做说明', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const logFile = '/tmp/pi-flow-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-fork' }, reviewer: { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''}`);
    assert.equal(t.attempts, 1, '第一次提交在审查前验证中失败');
    const impl = p.store.listRuns().filter((r) => r.role === 'backend-engineer').sort((a, b) => a.started_at.localeCompare(b.started_at));
    assert.equal(impl.length, 2);
    assert.equal(impl[1]!.forked_from, impl[0]!.run_id);
    assert.equal(impl[1]!.outcome, 'submitted');
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'impl-fork');
    const second = reqs.find((r) => r.turn === 5)!;
    assert.ok(second, '第二次运行的第一个请求带着上一次的 5 条回复');
    assert.match(JSON.stringify(second.last), /继续任务[\s\S]*审查前验证失败[\s\S]*flow_claim/);
    assert.ok(impl[1]!.session_file && impl[1]!.session_file !== impl[0]!.session_file, '新会话单独留档');
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：关闭逐任务审查时提交直接合并，合并时全量测试失败退回，接着上一次的对话修好后合入', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ yaml: DIRECT_YAML, tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const logFile = '/tmp/pi-flow-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: p.config, launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-fork' }, reviewer: { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.status} ${t.last_failure ?? ''}`);
    assert.equal(t.attempts, 1, '第一次提交在合并时的全量测试中失败');
    const runs = p.store.listRuns().sort((a, b) => a.started_at.localeCompare(b.started_at));
    assert.deepEqual(runs.map((r) => r.role), ['backend-engineer', 'backend-engineer'], '没有派审查');
    assert.equal(runs[1]!.forked_from, runs[0]!.run_id);
    const triggers = p.store.readEvents().filter((e) => e.task === 'T-001' && e.type === 'transition').map((e) => e.trigger);
    assert.deepEqual(triggers.filter((x) => x !== 'dispatch' && x !== 'schedule'), ['submit_direct', 'merge_start', 'merge_verify_fail', 'submit_direct', 'merge_start', 'merge_done']);
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'impl-fork');
    const second = reqs.find((r) => r.turn === 5)!;
    assert.ok(second, '第二次运行的第一个请求带着上一次的 5 条回复');
    assert.match(JSON.stringify(second.last), /继续任务[\s\S]*合并后验证失败[\s\S]*全量/);
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：阶段末审查——审查者用 flow_review_report 提交清单，修复合入后用 flow_review_confirm 确认（多出的字段被参数格式拒绝）', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const yaml = STAGE_REVIEW_YAML.replace(/^  auto_dispatch: false$/m, '  auto_dispatch: true');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['typecheck', 'test'] })] });
  try {
    const logFile = '/tmp/pi-flow-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const errors: unknown[] = [];
    const engine = new Engine({
      root: p.dir, store: p.store, config: parseConfig(yaml), launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-stage' }, reviewer: { model: 'fakellm/stage-review' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
      onError: (e) => errors.push(e),
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(errors, []);
    const sr = p.store.readStageReview(p.flowId, 'S3')!;
    assert.equal(sr.status, 'done', JSON.stringify(sr));
    assert.deepEqual(sr.issues.map((i) => [i.id, i.module, i.files]), [['R-1', 'server', ['src/server/t-001/a.ts']]]);
    assert.deepEqual(sr.confirm, [{ id: 'R-1', resolved: true }]);
    const fix = p.store.readTask(p.flowId, sr.fix_tasks[0]!);
    assert.equal(fix.status, 'done');
    // 修复任务接着 T-001 的对话继续（fork），不从头读代码
    assert.equal(fix.fork_from_task, 'T-001');
    const implRuns = p.store.listRuns().filter((r) => r.role === 'backend-engineer').sort((a, b) => a.started_at.localeCompare(b.started_at));
    assert.equal(implRuns[1]!.task, fix.id);
    assert.equal(implRuns[1]!.forked_from, implRuns[0]!.run_id);
    assert.match(p.store.readHandoff(p.flowId, fix.id), /接着之前的对话修 R-1/);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 2;');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'stage-review');
    assert.ok(reqs.some((r) => r.tools.includes('flow_review_report') && r.tools.includes('flow_review_confirm')), '审查者的工具里有阶段审查的两个工具');
    assert.ok(reqs.some((r) => /flow_review_confirm[\s\S]*must not have additional properties/.test(JSON.stringify(r.last))), '多出的字段被参数格式拒绝');
  } finally { p.cleanup(); }
});

test('真实 pi 子进程：bash 命令没给超时或超过上限时改成 limits.bash_timeout_s', { skip: !piAvailable && 'pi 不可用', timeout: 120_000 }, async () => {
  const yaml = PROJECT_YAML.replace(/^  bash_timeout_s: 300 /m, '  bash_timeout_s: 2   ');
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const logFile = '/tmp/pi-flow-e2e-llm.log';
    const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
    const engine = new Engine({
      root: p.dir, store: p.store, config: parseConfig(yaml), launcher: new PiLauncher(),
      roleSettings: () => ({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-sleep' }, reviewer: { model: 'fakellm/review-pass' } } }),
      packageAgentsDir: path.join(ROOT, 'agents'),
      subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
      extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
    });
    const t0 = Date.now();
    await engine.promote(p.flowId);
    await engine.dispatch(p.flowId, 'T-001');
    // 只等第一次运行：两次 sleep 30 各在 2 秒后被结束
    while (p.store.listRuns().every((r) => !r.ended_at) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
    engine.killAll();
    await engine.idle();
    const reqs = readFileSync(logFile, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.model === 'impl-sleep');
    assert.match(JSON.stringify(reqs.find((r) => r.turn === 1)?.last), /timed out after 2 seconds/);
    assert.match(JSON.stringify(reqs.find((r) => r.turn === 2)?.last), /timed out after 2 seconds/);
  } finally { p.cleanup(); }
});
