// 真实模型冒烟：用 /flow-config 中的模型从零跑一个小项目的 build 流程（S0→S5），实施中途发起一次计划修订。
//   node scripts/real-build.ts [--keep] [--no-replan] [--dir <已有项目目录>]
// 任务阻塞时自动解除一次（代替用户），同一任务再次阻塞则停止。
// 每一步都通过 pi -p 执行斜杠命令（不调用主会话模型）；闸门由脚本代替用户批准，批准前打印要审批的内容。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activePauses, describePause } from '../src/core/model-pause.ts';
import { StateStore } from '../src/core/state-store.ts';
import { costReport, formatRow } from '../src/core/cost.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(ROOT, 'src/pi-adapter/extension.ts');
const argv = process.argv.slice(2);
const args = new Set(argv);
const existing = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : undefined;
const DEFAULT_DESC = '做一个纯 JavaScript（ES 模块，Node 24，无第三方依赖）的待办清单库：createTodoList() 返回对象，提供 add(title) 返回带自增 id 的待办、list() 返回全部待办、done(id) 标记完成（id 不存在时抛错）。数据只保存在内存中。代码放在 src/server/todo/，测试用 node:test。';
const desc = argv.includes('--desc') ? argv[argv.indexOf('--desc') + 1]! : DEFAULT_DESC;
const sh = (cwd: string, cmd: string, a: string[]) => execFileSync(cmd, a, { cwd, encoding: 'utf8' }).trim();
const t0 = Date.now();
const stamp = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const step = (s: string) => console.log(`\n\x1b[1m▶ [${stamp()}] ${s}\x1b[0m`);

// 当前正在执行的 pi 命令：脚本被中断时转发 SIGTERM，让它结束自己拉起的 subagent，而不是留下孤儿进程
let current: ReturnType<typeof spawn> | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，结束正在执行的 pi 命令及其子进程…`);
    if (!current) process.exit(130);
    current.once('close', () => process.exit(130));
    current.kill('SIGTERM');
    setTimeout(() => process.exit(130), 15_000).unref();
  });
}

function pi(cwd: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn('pi', ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', EXTENSION, message],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
    c.stderr.on('data', (b) => { out += b; process.stdout.write(b); });
    current = c;
    c.on('close', (code) => { current = null; return code === 0 ? resolve(out) : reject(new Error(`pi 退出码 ${code}`)); });
  });
}

const dir = existing ?? mkdtempSync(path.join(tmpdir(), 'pi-flow-real-build-'));
console.log(`项目目录：${dir}`);
try {
  if (!existing) {
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "todo-lib", "type": "module", "scripts": { "test": "node --test" } }\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '空项目']);

  step('/flow init');
  await pi(dir, '/flow init');
  const wf = path.join(dir, 'workflow.yaml');
  // 纯 JS 项目：没有 typecheck、lint、e2e；测试用 node --test
  writeFileSync(wf, readFileSync(wf, 'utf8').replace(/commands:[\s\S]*?\nlimits:/, `commands:
  install: "true"
  typecheck: "true"
  lint: "true"
  test: "node --test --test-timeout=60000"
  test_affected: "node --test --test-timeout=60000 {files}"
  e2e: "node --test --test-timeout=60000"
limits:`));
  sh(dir, 'git', ['add', 'workflow.yaml']);
  sh(dir, 'git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '调整命令']);

  step('/flow-build --direct');
  await pi(dir, `/flow-build --direct ${JSON.stringify(desc)}`);
  }
  const store = new StateStore(dir);
  let replanned = args.has('--no-replan') || store.listTasks(store.readState().active_flow ?? '').some((t) => !!t.replan);
  const unblocked = new Set<string>();
  const unblockCount = new Map<string, number>();
  const replannedFor = new Set<string>();
  let lastSig = '';
  let stalled = 0;
  for (let i = 0; i < 40; i++) {
    const active = store.readState().active_flow;
    if (!active) break;
    const f = store.readFlow(active);
    const rev = store.readRevision(active);
    if (rev?.status === 'proposed') {
      step(`计划修订待批准：${rev.summary}`);
      await pi(dir, '/flow approve');
      continue;
    }
    if (f.stage_status === 'awaiting_human') {
      step(`阶段 ${f.stage} 等待批准`);
      if (f.stage === 'S0' && existsSync(path.join(dir, '.flow'))) {
        try { console.log(sh(dir, 'git', ['show', `${f.integration_branch}:docs/PRD.md`]).slice(0, 3000)); } catch { /* 无 PRD */ }
      }
      await pi(dir, f.stage === f.stages.at(-1) ? '/flow approve --yes' : '/flow approve --rules all');
      continue;
    }
    const blocked = store.listTasks(active).filter((t) => t.status === 'blocked');
    const busy = store.listTasks(active).some((t) => t.lease || ['verifying', 'queued_merge', 'merging'].includes(t.status) || t.status === 'ready');
    if (blocked.length && !busy) {
      // 代替"只和主 agent 对话、不动代码"的用户回答：同一任务最多三次，采纳 agent 给出的建议
      const b = blocked.find((t) => (unblockCount.get(t.id) ?? 0) < 3);
      if (!b) { step(`任务多次阻塞，停止：${blocked.map((t) => `${t.id}：${t.blocked_reason}`).join('；')}`); break; }
      // 上游测试或计划本身有误（agent 建议修订计划）：代替用户把原话交给 architect 修订，批准后再解除阻塞
      if (/修订计划/.test(b.blocked_reason ?? '') && !replannedFor.has(b.id)) {
        replannedFor.add(b.id);
        step(`${b.id} 阻塞并建议修订计划：${b.blocked_reason}\n→ 代替用户发起 /flow replan`);
        await pi(dir, `/flow replan ${JSON.stringify(`任务 ${b.id} 阻塞：${b.blocked_reason}`)}`);
        continue;
      }
      unblockCount.set(b.id, (unblockCount.get(b.id) ?? 0) + 1);
      unblocked.add(b.id);
      step(`${b.id} 阻塞：${b.blocked_reason}\n→ 代替用户回答（第 ${unblockCount.get(b.id)} 次）`);
      await pi(dir, `/flow unblock ${b.id} "同意你给出的建议（默认方案），按建议继续。如果需要临时实验，放在提示中给出的临时目录里。"`);
      continue;
    }
    const pauses = activePauses(store, new Date());
    const sig = store.listTasks(active).map((t) => `${t.id}:${t.status}:${t.attempts}`).join(',');
    stalled = pauses.length && sig === lastSig ? stalled + 1 : 0;
    lastSig = sig;
    if (stalled >= 2) {
      // 模型额度用完或服务不可用，且再派发也没有进展：不空转，停下等用户（恢复后用 --dir 接着跑）
      step(`模型暂停，停止：${pauses.map((p) => describePause(p, new Date())).join('；')}\n恢复后：node scripts/real-build.ts --dir ${dir} --keep`);
      break;
    }
    if (!replanned && f.stage === 'S3' && store.listTasks(active).some((t) => t.stage === 'S3' && t.status === 'done')) {
      replanned = true;
      step('实施中途发起计划修订');
      await pi(dir, '/flow replan "还需要 remove(id) 删除待办（id 不存在时抛错），以及 clearDone() 清除已完成的待办"');
      continue;
    }
    step(`阶段 ${f.stage}（${f.stage_status}）→ /flow next`);
    await pi(dir, '/flow next');
  }
  step('结果');
  console.log(sh(dir, 'git', ['log', '--oneline', '--first-parent', 'main']));
  const flowId = store.listFlows().find((id) => store.readFlow(id).mode === 'build')!;
  const flow = store.readFlow(flowId);
  console.log(`\n流程 ${flowId}：${flow.stage}/${flow.stage_status}，耗时 ${stamp()}`);
  for (const t of store.listTasks(flowId)) console.log(`- ${t.id} [${t.stage}/${t.kind}] ${t.title}（${t.role}）${t.status}${t.attempts ? ` 返工 ${t.attempts}` : ''}${t.blocked_reason ? ` 阻塞：${t.blocked_reason.slice(0, 120)}` : ''}`);
  try { console.log(`\n测试：${sh(dir, 'node', ['--test', '--test-reporter=tap']).split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('，')}`); } catch (e) { console.log(`测试失败：${String(e).slice(0, 500)}`); }
  const cost = costReport(store, { flow: flowId });
  console.log(`\n${formatRow(cost.total)}`);
  for (const r of cost.byRole) console.log(formatRow(r));
  console.log(`\n知识库：${store.readKnowledge().entries.map((e) => `${e.id}[${e.status}] ${e.content.slice(0, 80)}`).join('\n  ') || '（空）'}`);
  const ev = store.readEvents().filter((e) => e.flow === flowId);
  console.log(`\n违规 ${ev.filter((e) => e.type === 'violation').length} 次：${ev.filter((e) => e.type === 'violation').map((e) => (e.reason ?? '').slice(0, 100)).join('\n  ')}`);
  console.log(`审查打回 ${ev.filter((e) => e.trigger === 'review_reject').length} 次；审查前验证失败 ${ev.filter((e) => e.trigger === 'precheck_fail').length} 次；验证失败 ${ev.filter((e) => e.trigger === 'verify_fail').length} 次；合并后验证失败 ${ev.filter((e) => e.trigger === 'merge_verify_fail').length} 次；免审查 ${ev.filter((e) => e.trigger === 'review_skip').length} 次`);
  // 工具调用统计（来自会话留档；codemode 脚本内部的调用不单独计）
  const { summarizeSession, findSessionFile } = await import('../src/core/session-log.ts');
  const calls = new Map<string, { runs: number; calls: number; errors: number }>();
  for (const r of store.listRuns().filter((x) => x.flow === flowId)) {
    const f = r.session_file ?? (r.session_dir ? findSessionFile(r.session_dir) : null);
    const row = calls.get(r.role) ?? { runs: 0, calls: 0, errors: 0 };
    row.runs++;
    if (f && existsSync(f)) { const s = summarizeSession(f); row.calls += s.toolCalls.length; row.errors += s.toolCalls.filter((c) => c.error).length; }
    calls.set(r.role, row);
  }
  console.log(`\n工具调用（顶层，按角色）：`);
  for (const [role, c] of calls) console.log(`  ${role}：${c.runs} 次运行，${c.calls} 次工具调用，其中失败 ${c.errors} 次`);
  const runs = store.listRuns().filter((x) => x.flow === flowId);
  console.log(`升级模型的运行 ${runs.filter((r) => r.escalated).length} 次；低风险审查 ${runs.filter((r) => r.review_mode === 'light').length} 次；强模型审查 ${runs.filter((r) => r.review_mode === 'strong').length} 次；被终止 ${runs.filter((r) => r.outcome === 'killed').length} 次；接着上次对话的返工 ${runs.filter((r) => r.forked_from).length} 次；模型暂停 ${runs.filter((r) => r.outcome === 'unavailable').length} 次`);
  console.log(`完整性校验：${(await store.verifyIntegrity()).ok ? '通过' : '失败'}`);
} finally {
  if (!args.has('--keep')) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.worktrees`, { recursive: true, force: true }); }
}
