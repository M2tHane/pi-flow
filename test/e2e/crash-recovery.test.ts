// M5 验收：在任务进行中与合并进行中分别强杀引擎进程（SIGKILL），重启后都能正确恢复。真实 pi 子进程 + 假 LLM。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { Engine } from '../../src/core/dispatcher.ts';
import { resume, processAlive } from '../../src/core/resume.ts';
import { PiLauncher } from '../../src/pi-adapter/launcher.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
before(async () => {
  llm = await startFakeLlm({ scriptsDir: SCRIPTS });
  process.env['FAKE_LLM_URL'] = llm.url;
  // 测试不需要联网：关闭模型目录刷新与版本检查（网络不通时 pi 启动会被拖慢约 60 秒）
  process.env['PI_OFFLINE'] = '1';
  process.env['PI_SKIP_VERSION_CHECK'] = '1';
  process.env['FAKE_LLM_SCRIPTS'] = SCRIPTS;
});
const drivers: ChildProcess[] = [];
after(() => { for (const d of drivers) d.kill('SIGKILL'); return llm?.close(); });

const until = async (cond: () => boolean, ms = 180_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 100)); }
};

function startDriver(p: Project, settings: object): ChildProcess {
  return spawn(process.execPath, [path.join(ROOT, 'test/fixtures/crash-driver.ts'), p.dir, JSON.stringify(settings)], {
    stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
  });
}

function recoveryEngine(p: Project, store: StateStore, settings: object) {
  return new Engine({
    root: p.dir, store, config: p.config, launcher: new PiLauncher(), roleSettings: () => settings as never,
    packageAgentsDir: path.join(ROOT, 'agents'), subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
    extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
  });
}

const GOOD = { version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-happy' }, reviewer: { model: 'fakellm/review-pass' } } };

test('任务进行中强杀引擎：残留 pi 子进程被清理，任务在原 worktree 上重新派发并完成', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const driver = startDriver(p, { version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-slow' }, reviewer: { model: 'fakellm/review-pass' } } });
    drivers.push(driver);
    let pid = 0;
    await until(() => {
      const t = p.store.readTask(p.flowId, 'T-001');
      if (!t.lease || !t.worktree) return false;
      try { pid = p.store.readRun(t.lease.run_id).pid ?? 0; } catch { return false; }
      return pid > 0 && existsSync(path.join(t.worktree, 'src/server/t-001/a.ts'));
    });
    driver.kill('SIGKILL');
    await new Promise((r) => driver.on('exit', r));
    assert.ok(processAlive(pid), '引擎被杀后，pi 子进程成为残留进程');

    const store = new StateStore(p.dir, { limits: p.config.limits });
    const r = await resume({ root: p.dir, store, config: p.config });
    assert.ok(r.ok, r.brief);
    await until(() => !processAlive(pid), 10_000);
    const t = store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'in_progress');
    assert.equal(t.attempts, 0, '会话中断不计入失败次数');
    assert.equal(t.interruptions, 1);

    const engine = recoveryEngine(p, store, GOOD);
    await engine.pump(p.flowId);
    await engine.idle();
    const done = store.readTask(p.flowId, 'T-001');
    assert.equal(done.status, 'done', `${done.status} ${done.last_failure ?? ''}`);
    assert.equal(p.git('show', `flow/${p.flowId}/integration:src/server/t-001/a.ts`), 'export const a = 1;');
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally { for (const d of drivers) d.kill('SIGKILL'); p.cleanup(); }
});

test('合并进行中强杀引擎：合并回滚到队首，重启后完成合并', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const flag = path.join(ROOT, `.tmp-crash-flag-${process.pid}`);
  rmSync(flag, { force: true });
  // 合并后验证的 test 命令在 flag 出现前一直很慢，便于在合并途中强杀
  const yaml = PROJECT_YAML.replace(/  test:      ".*"/, `  test:      "[ -f ${flag} ] || sleep 60"`);
  const p = await setupProject({ yaml, tasks: [mkTask('T-001', { verify: ['typecheck'] })] });
  try {
    const driver = startDriver(p, GOOD);
    drivers.push(driver);
    await until(() => p.store.readTask(p.flowId, 'T-001').status === 'merging'
      && p.store.readEvents().some((e) => e.reason === 'rebase 到集成分支'));
    driver.kill('SIGKILL');
    await new Promise((r) => driver.on('exit', r));
    writeFileSync(flag, '');

    const store = new StateStore(p.dir, { limits: p.config.limits });
    const r = await resume({ root: p.dir, store, config: p.config });
    assert.ok(r.actions.some((a) => a.includes('放回合并队首')), r.actions.join('\n'));
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'queued_merge');

    const engine = recoveryEngine(p, store, GOOD);
    await engine.pump(p.flowId);
    await engine.idle();
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.git('log', '--format=%s', `flow/${p.flowId}/integration`).split('\n').filter((l) => l.startsWith('[B-001/T-001]')).length, 1, '只合入一次');
    assert.deepEqual((await store.verifyIntegrity()).errors, []);
  } finally {
    for (const d of drivers) d.kill('SIGKILL');
    rmSync(flag, { force: true });
    p.cleanup();
  }
});

test('引擎所在的 pi 收到 SIGTERM：结束它拉起的 subagent，不留孤儿进程；/flow resume 照常恢复', { skip: !piAvailable && 'pi 不可用', timeout: 240_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-agentdir-'));
  try {
    writeFileSync(path.join(agentDir, 'pi-flow.json'), JSON.stringify({ version: 1, roles: { 'backend-engineer': { model: 'fakellm/impl-slow' }, reviewer: { model: 'fakellm/review-pass' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    const main = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '/flow next'], {
      cwd: p.dir, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FLOW_EXTRA_EXTENSIONS: provider },
    });
    drivers.push(main);
    const store = new StateStore(p.dir);
    let sub = 0;
    await until(() => { const r = store.listRuns()[0]; sub = r?.pid ?? 0; return !!sub && existsSync(path.join(p.dir, '..', path.basename(p.dir) + '.worktrees')) && store.readTask(p.flowId, 'T-001').lease !== null; });
    await until(() => readFileSafe(path.join(p.dir + '.worktrees', `${p.flowId}-T-001`, 'src/server/t-001/a.ts')) === 'half\n');
    assert.ok(processAlive(sub), 'subagent 正在运行');
    const closed = new Promise((r) => main.once('close', r));
    main.kill('SIGTERM');
    await closed;
    await until(() => !processAlive(sub), 15_000);
    assert.equal(processAlive(sub), false, 'subagent 随引擎一起结束');
    const r = await resume({ root: p.dir, store, config: p.config, activeRunIds: new Set() });
    assert.ok(r.ok, r.brief);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    p.cleanup();
  }
});

function readFileSafe(f: string): string | null {
  try { return readFileSync(f, 'utf8'); } catch { return null; }
}
