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
        '-e', provider, '-e', path.join(ROOT, 'src/pi-adapter/extension.ts'), '--model', 'fakellm/orch',
        '/flow resume', '开始调度'], {
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

    const reqs = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.model === 'orch');
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
