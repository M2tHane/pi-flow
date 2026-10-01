// 演示项目的端到端脚本。
//   node scripts/demo.ts             用本地假模型跑完 build 流程 S0→S5（真实 pi 进程，不需要模型服务）
//   node scripts/demo.ts --real-fix  用你在 /flow-config 中为各角色设置的真实模型跑一次 /flow-fix
//   --keep                           保留演示目录（默认结束后删除）
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/core/state-store.ts';
import { costReport, formatRow } from '../src/core/cost.ts';
import { startFakeLlm } from '../test/fixtures/fake-llm/server.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(ROOT, 'src/pi-adapter/extension.ts');
const PROVIDER = path.join(ROOT, 'test/fixtures/fake-llm/provider.ts');
const LLM_SCRIPTS = path.join(ROOT, 'scripts/demo/llm');
const args = new Set(process.argv.slice(2));

const sh = (cwd: string, cmd: string, a: string[]) => execFileSync(cmd, a, { cwd, encoding: 'utf8' }).trim();
const step = (s: string) => console.log(`\n\x1b[1m▶ ${s}\x1b[0m`);

function pi(cwd: string, messages: string[], env: Record<string, string>, extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      ...extra, '-e', EXTENSION, ...messages], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
    c.stderr.on('data', (b) => { out += b; process.stdout.write(b); });
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`pi 退出码 ${code}`))));
  });
}

function writeWorkflowCommands(dir: string, commands: Record<string, string>): void {
  const file = path.join(dir, 'workflow.yaml');
  const body = Object.entries(commands).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/commands:[\s\S]*?\nlimits:/, `commands:\n${body}\nlimits:`));
  sh(dir, 'git', ['add', 'workflow.yaml']);
  sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '演示：调整 workflow.yaml 的命令']);
}

async function fakeBuild(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-demo-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-demo-agent-'));
  const llm = await startFakeLlm({ scriptsDir: LLM_SCRIPTS });
  const env = { PI_CODING_AGENT_DIR: agentDir, FAKE_LLM_URL: llm.url, FAKE_LLM_SCRIPTS: LLM_SCRIPTS, PI_FLOW_EXTRA_EXTENSIONS: PROVIDER };
  const extra = ['-e', PROVIDER];
  try {
    console.log(`演示目录：${dir}`);
    sh(dir, 'git', ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(agentDir, 'pi-flow.json'), JSON.stringify({ version: 1, roles: {
      architect: { model: 'fakellm/demo-architect' }, reviewer: { model: 'fakellm/demo-review' },
      'infra-engineer': { model: 'fakellm/demo-infra' }, 'test-engineer': { model: 'fakellm/demo-test' },
      'backend-engineer': { model: 'fakellm/demo-backend' } } }));

    step('/flow init，然后把命令换成演示项目能跑的版本');
    await pi(dir, ['/flow init'], env, extra);
    writeWorkflowCommands(dir, { install: 'true', typecheck: 'true', lint: 'true', test: 'node --test', test_affected: 'node --test {files}', e2e: 'node --test' });

    step('/flow-build：创建流程，architect 撰写 PRD');
    await pi(dir, ['/flow-build --direct "做一个待办应用"'], env, extra);
    const store = new StateStore(dir);
    for (let i = 0; i < 20 && store.readState().active_flow; i++) {
      const f = store.readFlow(store.readState().active_flow!);
      if (f.stage_status === 'awaiting_human') {
        step(`阶段 ${f.stage} 等待批准 → /flow approve${f.stage === f.stages.at(-1) ? ' --yes（合入主分支）' : ''}`);
        await pi(dir, [f.stage === f.stages.at(-1) ? '/flow approve --yes' : '/flow approve'], env, extra);
      } else {
        step(`阶段 ${f.stage}（${f.stage_status}）→ /flow next`);
        await pi(dir, ['/flow next'], env, extra);
      }
    }
    step('结果');
    console.log(sh(dir, 'git', ['log', '--oneline', '--first-parent', 'main']).split('\n').filter((l) => !l.includes('flow-state:')).join('\n'));
    console.log(`\nmain 上的实现：\n${sh(dir, 'git', ['show', 'main:src/server/todo/index.mjs'])}`);
    console.log(`\n测试：${sh(dir, 'node', ['--test', '--test-reporter=tap']).split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('，')}`);
    console.log(`\n${formatRow(costReport(store).total)}`);
    const integrity = await store.verifyIntegrity();
    console.log(`完整性校验：${integrity.ok ? '通过' : integrity.errors.join('；')}`);
    if (store.readState().active_flow) throw new Error('流程没有结束');
  } finally {
    await llm.close();
    rmSync(agentDir, { recursive: true, force: true });
    if (!args.has('--keep')) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.worktrees`, { recursive: true, force: true }); }
  }
}

async function realFix(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-demo-fix-'));
  try {
    console.log(`演示目录：${dir}（使用 /flow-config 中设置的真实模型）`);
    sh(dir, 'git', ['init', '-q', '-b', 'main']);
    mkdirSync(path.join(dir, 'src/server/calc'), { recursive: true });
    mkdirSync(path.join(dir, 'tests/server'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "calc-demo", "type": "module", "scripts": { "test": "node --test" } }\n');
    writeFileSync(path.join(dir, 'src/server/calc/add.mjs'), '// 两数相加\nexport function add(a, b) {\n  return a - b;\n}\n');
    writeFileSync(path.join(dir, 'tests/server/sanity.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sanity', () => assert.equal(1, 1));\n");
    sh(dir, 'git', ['add', '.']);
    sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '计算器（含缺陷）']);

    step('/flow init');
    await pi(dir, ['/flow init'], {});
    writeWorkflowCommands(dir, { install: 'true', typecheck: 'true', lint: 'true', test: 'node --test', test_affected: 'node --test {files}', e2e: 'true' });

    step('/flow-fix（真实模型）');
    const started = Date.now();
    await pi(dir, ['/flow-fix "add(1, 2) 返回 -1，期望返回 3。src/server/calc/add.mjs 中的 add 函数结果不对。"'], {});
    const store = new StateStore(dir);
    const fix = store.listFlows().map((id) => store.readFlow(id)).find((f) => f.mode === 'fix')!;
    step('结果');
    console.log(`修复 ${fix.id}：${fix.stage_status}，耗时 ${Math.round((Date.now() - started) / 1000)} 秒`);
    for (const t of store.listTasks(fix.id)) console.log(`- ${t.id} ${t.role} ${t.status}${t.attempts ? `（返工 ${t.attempts} 次）` : ''}`);
    console.log(`\nmain 上的 add.mjs：\n${readFileSync(path.join(dir, 'src/server/calc/add.mjs'), 'utf8')}`);
    const logs = readdirSync(path.join(dir, '.flow/fixes')).filter((f) => f.endsWith('.md'));
    if (logs[0]) console.log(readFileSync(path.join(dir, '.flow/fixes', logs[0]), 'utf8'));
    console.log(`完整性校验：${(await store.verifyIntegrity()).ok ? '通过' : '失败'}`);
  } finally {
    if (!args.has('--keep')) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.worktrees`, { recursive: true, force: true }); }
  }
}

await (args.has('--real-fix') ? realFix() : fakeBuild());
