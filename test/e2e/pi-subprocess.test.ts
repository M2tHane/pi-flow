// 真实 pi 子进程 + 假 LLM（OpenAI 兼容流式服务）：验证 pi-adapter（启动参数、子进程扩展、guard、flow_* 工具、token 统计）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Engine } from '../../src/core/dispatcher.ts';
import { PiLauncher, buildPiArgs } from '../../src/pi-adapter/launcher.ts';
import { summarizeSession } from '../../src/core/session-log.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject } from '../helpers/project.ts';
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
