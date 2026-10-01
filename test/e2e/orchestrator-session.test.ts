// 真实 pi 主会话：/flow resume 进入调度模式；orchestrator 越权被拦；每轮注入"唯一允许的下一步"；派发与等待跑通。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm/server.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'test/fixtures/fake-llm/scripts');
const LOG = path.join(tmpdir(), `pi-flow-orch-llm-${process.pid}.log`);
let llm: FakeLlm;
let piAvailable = true;
try { execFileSync('pi', ['--version'], { stdio: 'ignore' }); } catch { piAvailable = false; }
before(async () => { llm = await startFakeLlm({ scriptsDir: SCRIPTS, logFile: LOG }); });
after(() => { rmSync(LOG, { force: true }); return llm?.close(); });

test('调度模式：orchestrator 不能自己写代码，只能 dispatch/wait；任务经子进程完成', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-agentdir-'));
  try {
    writeFileSync(path.join(agentDir, 'pi-flow.json'), JSON.stringify({ version: 1, roles: {
      orchestrator: { model: 'fakellm/orch' }, 'backend-engineer': { model: 'fakellm/impl-happy' }, reviewer: { model: 'fakellm/review-pass' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    // 必须异步：假 LLM 在本进程内，spawnSync 会阻塞事件循环导致死锁
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/plain',
        '/flow resume', '开始调度', '/flow off', '你好'], {
        cwd: p.dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FLOW_EXTRA_EXTENSIONS: provider },
      });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (b) => { stdout += b; });
      c.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /恢复摘要/);
    const store = new StateStore(p.dir);
    assert.equal(store.readTask(p.flowId, 'T-001').status, 'done', r.stdout + r.stderr);

    // write 已从启用工具中移除，Pi 直接拒绝；读 docs/ 之外的文件被 guard 拦下并记录违规
    const orchViolations = store.readEvents().filter((e) => e.type === 'violation' && e.data?.['role'] === 'orchestrator');
    assert.deepEqual(orchViolations.map((e) => [e.data?.['tool'], e.data?.['rule']]), [['read', 'read_paths']]);
    assert.match(orchViolations[0]!.reason ?? '', /你是调度者，不能直接修改代码。请调用 flow_dispatch\(T-001\)/);

    const all = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // 进入调度模式后主会话切到 /flow-config 中 orchestrator 的模型；/flow off 后恢复原模型与工具
    const mainReqs = all.filter((x) => x.model === 'orch' || x.model === 'plain');
    assert.equal(mainReqs[0].model, 'orch', '调度模式使用 orchestrator 的模型');
    const last = mainReqs.at(-1);
    assert.equal(last.model, 'plain', '/flow off 后恢复原模型');
    assert.ok(['read', 'bash', 'edit', 'write'].every((t) => last.tools.includes(t)), `恢复原工具：${last.tools}`);
    assert.match(r.stdout + r.stderr, /已退出调度模式，恢复原来的模型（fakellm\/plain）/);
    const reqs = all.filter((x) => x.model === 'orch');
    assert.match(JSON.stringify(reqs[1].last), /Tool write not found/);
    // 只启用了 orchestrator 的工具
    assert.deepEqual([...reqs[0].tools].sort(), ['flow_dispatch', 'flow_status', 'flow_wait', 'read']);
    const sys = JSON.stringify(reqs[0].system);
    assert.match(sys, /你是 pi-flow 的调度者/);
    assert.match(sys, /唯一允许的下一步.*flow_dispatch\(T-001\)/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    p.cleanup();
  }
});

test('真实 pi：在空仓库执行 /flow-build，自动初始化并完成 S0 任务，停在等待人工批准', { skip: !piAvailable && 'pi 不可用', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-build-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-agentdir-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(path.join(agentDir, 'pi-flow.json'), JSON.stringify({ version: 1, roles: {
      architect: { model: 'fakellm/arch-prd' }, reviewer: { model: 'fakellm/review-pass' } } }));
    const provider = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
    const out = await new Promise<{ status: number | null; text: string }>((resolve) => {
      const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '/flow-build "做一个待办应用"'], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: SCRIPTS, PI_FLOW_EXTRA_EXTENSIONS: provider },
      });
      let text = '';
      c.stdout.on('data', (b) => { text += b; });
      c.stderr.on('data', (b) => { text += b; });
      const timer = setTimeout(() => c.kill('SIGKILL'), 240_000);
      c.on('close', (status) => { clearTimeout(timer); resolve({ status, text }); });
    });
    assert.equal(out.status, 0, out.text);
    assert.match(out.text, /已创建流程 B-001（build）/);
    const store = new StateStore(dir);
    const flow = store.readFlow('B-001');
    assert.equal(flow.stage, 'S0');
    assert.equal(flow.stage_status, 'awaiting_human', out.text);
    assert.equal(store.readTask('B-001', 'T-001').status, 'done');
    assert.match(execFileSync('git', ['show', 'flow/B-001/integration:docs/PRD.md'], { cwd: dir, encoding: 'utf8' }), /待办应用 PRD/);
    assert.match(out.text, /\/flow approve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.worktrees`, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
