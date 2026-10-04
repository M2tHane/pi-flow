// 第二轮 D + E 验收：租约心跳续租；子进程会话留档的查看与按保留期清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { makeEngine } from '../helpers/engine.ts';
import { mkTask } from '../helpers/tasks.ts';
import { SubagentRuntime } from '../../src/core/subagent-runtime.ts';
import { runEnvFrom } from '../../src/tools/subagent-tools.ts';
import { runFlowCommand, type CommandEnv } from '../../src/commands/flow.ts';
import { doctor } from '../../src/core/doctor.ts';
import { sessionDirOf, summarizeSession } from '../../src/core/session-log.ts';

const MIN = 60_000;

test('租约心跳：持续调用工具的 run 超过 lease_minutes 不被杀；停止调用工具后按时过期', async () => {
  let clock = new Date('2026-10-01T00:00:00Z').getTime();
  const now = () => new Date(clock);
  const p = await setupProject({ now, tasks: [mkTask('T-001', { verify: [] })] });
  try {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { engine, launcher } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass', notes: 'ok' }); return; }
      await hold;
    }, undefined, undefined, { now }); // 引擎与存储共用同一个时钟
    await engine.next(p.flowId);
    const env = runEnvFrom(launcher.launched[0]!.env)!;
    const rt = new SubagentRuntime(env, p.store, p.config, now);
    const lease = () => p.store.readTask(p.flowId, 'T-001').lease!;
    const start = Date.parse(lease().expires_at);
    assert.equal(start - clock, 45 * MIN);
    const read = () => rt.gate({ toolName: 'read', input: { path: 'README.md' } }, p.store.readTask(p.flowId, 'T-001').worktree!);

    clock += 10 * MIN;
    await read();
    assert.equal(Date.parse(lease().expires_at), start, '剩余超过一半时不续租（不产生状态提交）');
    clock += 20 * MIN;
    await read();
    assert.equal(Date.parse(lease().expires_at), clock + 45 * MIN, '剩余不足一半时续到 现在 + lease_minutes');
    const renewals = p.store.readEvents().filter((e) => e.reason === '续租');
    assert.equal(renewals.length, 1);

    clock += 30 * MIN; // 距开始 60 分钟，超过最初的 45 分钟
    assert.deepEqual(engine.checkLeases(), [], '持续调用工具的 run 不被杀');
    await read();
    clock += 46 * MIN; // 之后不再调用工具
    assert.deepEqual(engine.checkLeases(), [env.run], '长时间没有工具调用的 run 按时过期');

    // 伪造 token 不能续租
    clock -= 46 * MIN;
    await assert.rejects(p.store.renewLease(p.flowId, 'T-001', env.run, '0'.repeat(64), new Date(clock + 90 * MIN).toISOString(), 'x'), /不能续租/);
    release();
    await engine.idle();
  } finally { p.cleanup(); }
});

test('会话留档：run 记录会话目录；/flow run 显示工具调用摘要与最后的回复；doctor --fix 按保留期清理', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: [] })] });
  try {
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass', notes: 'ok' }); return; }
      await a.call('flow_claim');
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'x' });
      await a.call('flow_note', { text: 'n' });
      await a.call('flow_submit', { summary: 's' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const runs = p.store.listRuns();
    assert.equal(runs.length, 2);
    for (const r of runs) assert.equal(r.session_dir, sessionDirOf(p.dir, r.run_id));

    // 假子进程不写会话文件：这里按 Pi 的会话格式写一份，模拟真实 pi 的留档
    const impl = runs.find((r) => r.role === 'backend-engineer')!;
    const lines = [
      { type: 'session', version: 3, id: 'u', timestamp: '2026-10-01T00:00:00Z', cwd: '/w' },
      { type: 'message', id: 'a', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'flow_claim', arguments: {} }] } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '准备写文件' }, { type: 'toolCall', id: 'c2', name: 'write', arguments: { path: '/etc/x', content: 'y' } }] } },
      { type: 'message', id: 'c', parentId: 'b', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'write', content: [{ type: 'text', text: '越界：只能写 worktree' }], isError: true } },
      'not json',
      { type: 'message', id: 'd', parentId: 'c', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '已提交，结束。' }] } },
    ];
    mkdirSync(impl.session_dir!, { recursive: true });
    const file = path.join(impl.session_dir!, '2026_u.jsonl');
    writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
    const s = summarizeSession(file);
    assert.deepEqual(s.toolCalls.map((c) => [c.name, !!c.error]), [['flow_claim', false], ['write', true]]);
    assert.equal(s.lastText, '已提交，结束。');

    const env: CommandEnv = {
      root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
      engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
      roleSettings: () => ({ version: 1, roles: {} }), availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
    };
    assert.match(await runFlowCommand('run', env), new RegExp(`${impl.run_id}　B-001/T-001　backend-engineer　submitted`));
    const detail = await runFlowCommand(`run ${impl.run_id}`, env);
    assert.match(detail, /工具调用（2 次，失败 1 次）[\s\S]*2\. write \{"path":"\/etc\/x"[\s\S]*✗ 越界：只能写 worktree[\s\S]*最后的回复：已提交，结束。/);
    const rev = runs.find((r) => r.role === 'reviewer')!;
    assert.match(await runFlowCommand(`run ${rev.run_id}`, env), /会话记录：没有找到/);

    // 保留期：未到期不清理；到期后 --fix 清理；运行中的不清理
    const later = (days: number) => () => new Date(Date.parse(impl.ended_at!) + days * 86_400_000);
    assert.ok(!(await doctor(p.dir, p.store, { now: later(13) })).warnings.some((w) => w.includes('会话留档')));
    const warn = await doctor(p.dir, p.store, { now: later(15) });
    assert.ok(warn.warnings.some((w) => w.includes('2 个会话留档超过 14 天')), warn.warnings.join('\n'));
    assert.ok(existsSync(file));
    const fixed = await doctor(p.dir, p.store, { now: later(15), fix: true, sessionRetentionDays: 14 });
    assert.ok(fixed.fixed.some((f) => f.includes('清理 2 个超过 14 天的会话留档')));
    assert.ok(!existsSync(impl.session_dir!));
  } finally { p.cleanup(); }
});

test('原地打转：连续 5 次相同的工具调用被拦下并提示换思路，第 10 次结束本次运行（计一次失败，重新派发后完成）', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    const seen: string[] = [];
    const { engine } = makeEngine(p, async (role, nth, a) => {
      if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass' }); return; }
      await a.call('flow_claim');
      if (nth === 1) {
        // 同一条调用反复执行：第 5 次起被拦下，第 10 次本次运行被结束
        for (let i = 1; i <= 12; i++) {
          const r = await a.call('read', { path: 'README.md' }).catch((e) => ({ ok: false, text: String(e) }));
          seen.push(`${i}:${r.ok ? 'ok' : r.text.slice(0, 40)}`);
          if (/原地打转/.test(r.text)) return;
        }
        return;
      }
      // 换一种调用后计数重置
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('flow_note', { text: '完成' });
      await a.call('flow_submit', { summary: 's' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    assert.deepEqual(seen.slice(0, 4).map((x) => x.split(':')[1]), ['ok', 'ok', 'ok', 'ok']);
    assert.match(seen[4]!, /连续 5 次/);
    assert.match(seen.at(-1)!, /10.*原地打转|原地打转/);
    assert.equal(seen.length, 10);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done');
    assert.equal(t.attempts, 1);
    assert.ok(p.store.readEvents().some((e) => e.type === 'note' && /原地打转/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});

test('残留进程：子进程把命令放到后台被 guard 拦下；运行结束后，工作目录在 worktree 里的残留进程被结束', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001', { verify: ['test'] })] });
  try {
    let orphan = 0;
    const { engine } = makeEngine(p, async (role, _n, a) => {
      if (role === 'reviewer') { await a.call('flow_approve', { decision: 'pass' }); return; }
      await a.call('flow_claim');
      const bg = await a.call('bash', { command: 'sleep 30 &' });
      assert.equal(bg.ok, false);
      assert.match(bg.text, /禁止把命令放到后台运行/);
      const nh = await a.call('bash', { command: 'setsid sleep 30' });
      assert.equal(nh.ok, false);
      // 模拟绕过 guard 留下的进程（例如脚本内部起的后台进程）：工作目录在 worktree 里
      const wt = p.store.readTask(p.flowId, 'T-001').worktree!;
      const child = spawn('sleep', ['60'], { cwd: wt, detached: true, stdio: 'ignore' });
      child.unref();
      orphan = child.pid!;
      await a.call('write', { path: 'src/server/t-001/a.ts', content: 'ok' });
      await a.call('flow_note', { text: '完成' });
      await a.call('flow_submit', { summary: 's' });
    });
    await engine.next(p.flowId);
    await engine.idle();
    const t1 = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t1.status, 'done', `${t1.blocked_reason} | ${t1.last_failure}`);
    const alive = (() => { try { process.kill(orphan, 0); return true; } catch { return false; } })();
    assert.equal(alive, false, '残留进程已被结束');
    assert.ok(p.store.readEvents().some((e) => e.type === 'note' && /残留进程/.test(e.reason ?? '')));
  } finally { p.cleanup(); }
});
