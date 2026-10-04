// 第五轮实验（docs/BENCHMARK-5.md）的原生 Pi 一侧：在已有仓库上做多需求，按时间线注入追加需求、杀进程、额度窗口。
//   node scripts/bench5-native.ts --base <基线仓库> --req <需求文件> --append <追加需求文件>
//     [--append-min 20] [--kill-min 35] [--quota-from 50] [--quota-to 65] [--max-min 360] [--model provider/id] [--thinking high]
// pi 以 RPC 模式运行：追加需求在运行中用 steer 送达（等同于用户在会话里插话）；杀进程用 kill -9 整个进程组，10 秒后 `-c` 接着原会话发"继续"。
// 额度窗口按方案的退回做法模拟：窗口开始时杀掉进程，窗口结束后接着原会话发"继续"。
// 每次人工动作记在 <会话目录>/timeline.jsonl：scripted（方案内置）与 corrective（代答提问、意外退出后重启）分开。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`缺少参数 ${k}`); process.exit(2); } return path.resolve(v.replace(/^~/, homedir())); };
const BASE = need('--base');
const REQ = readFileSync(need('--req'), 'utf8').trim();
const APPEND = readFileSync(need('--append'), 'utf8').trim();
const MIN = 60_000;
const AT = { append: Number(opt('--append-min', '20')) * MIN, kill: Number(opt('--kill-min', '35')) * MIN, quotaFrom: Number(opt('--quota-from', '50')) * MIN, quotaTo: Number(opt('--quota-to', '65')) * MIN, max: Number(opt('--max-min', '360')) * MIN };
const MODEL = opt('--model', 'openai-codex/gpt-6.1-sol')!;
const THINKING = opt('--thinking', 'high')!;
const ANSWER = '同意你给出的建议（默认方案），按建议继续。';
const PLUGINS = path.join(homedir(), '.pi/agent/npm/node_modules');
const EXT = ['@bacnh85/pi-serena', '@vndv/pi-codegraph', 'pi-subagents', 'pi-web-access'].map((p) => path.join(PLUGINS, p));
for (const e of EXT) if (!existsSync(e)) { console.error(`缺少插件：${e}`); process.exit(1); }

// —— 准备项目（不计时）：克隆基线、安装依赖 ——
const dir = mkdtempSync(path.join(tmpdir(), 'pi-bench5-native-'));
const sessionDir = `${dir}.session`;
const sh = (cmd: string, a: string[], cwd = dir) => execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
execFileSync('git', ['clone', '-q', BASE, dir]);
sh('git', ['remote', 'remove', 'origin']);
const baseSha = sh('git', ['rev-parse', 'HEAD']);
console.log('安装依赖…');
sh('pnpm', ['install', '--frozen-lockfile'], path.join(dir, 'frontend'));
sh('go', ['mod', 'download'], path.join(dir, 'backend'));
execFileSync('mkdir', ['-p', sessionDir]);
console.log(`项目目录：${dir}\n会话目录：${sessionDir}\n基线：${baseSha}\n模型：${MODEL}（${THINKING}）\n时间线：追加 ${AT.append / MIN} 分、杀进程 ${AT.kill / MIN} 分、额度窗口 ${AT.quotaFrom / MIN}–${AT.quotaTo / MIN} 分`);

const t0 = Date.now();
const el = () => Date.now() - t0;
const stamp = () => `${(el() / MIN).toFixed(1)}m`;
const timeline = (kind: string, cls: 'scripted' | 'corrective' | 'info', note = '') => {
  appendFileSync(path.join(sessionDir, 'timeline.jsonl'), JSON.stringify({ t_min: +(el() / MIN).toFixed(2), kind, class: cls, note }) + '\n');
  console.log(`\n▶ [${stamp()}] ${kind}${note ? `：${note}` : ''}`);
};

type Phase = 'running' | 'idle' | 'down' | 'done';
let phase: Phase = 'down';
let child: ChildProcess | null = null;
let launches = 0;
let lastText = '';
let answers = 0;
let crashes = 0;
const flags = { appended: false, killed: false, quotaStarted: false, quotaEnded: false };
let expectExit = false;

function send(cmd: Record<string, unknown>) { child?.stdin?.write(JSON.stringify(cmd) + '\n'); }

function launch(cont: boolean, message: string) {
  const n = launches++;
  const args = ['--mode', 'rpc', '--session-dir', sessionDir, ...(cont ? ['-c'] : []),
    '--no-extensions', '--no-skills', '--no-prompt-templates', ...EXT.flatMap((e) => ['-e', e]), '--model', MODEL, '--thinking', THINKING];
  const c = spawn('pi', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } });
  child = c;
  expectExit = false;
  const raw = path.join(sessionDir, `stdout-${n}.jsonl`);
  let buf = '';
  c.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    appendFileSync(raw, chunk);
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
      let ev: { type?: string; toolName?: string; message?: { role?: string; content?: { type: string; text?: string }[] }; success?: boolean; command?: string; error?: string };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'tool_execution_start') console.log(`  [${stamp()}] ${ev.toolName}`);
      if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const text = (ev.message.content ?? []).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('').trim();
        if (text) lastText = text;
      }
      if (ev.type === 'response' && ev.success === false) console.log(`  [${stamp()}] 命令 ${ev.command} 被拒：${ev.error}`);
      if (ev.type === 'agent_settled' && child === c) onSettled();
    }
  });
  c.stderr!.setEncoding('utf8').on('data', (d: string) => appendFileSync(path.join(sessionDir, 'stderr.log'), d));
  c.on('close', (code) => {
    if (child !== c) return;
    child = null;
    if (expectExit || phase === 'done') return;
    // 意外退出：重启接着原会话（纠正性干预），最多 3 次
    phase = 'down';
    if (++crashes > 3) { timeline('stop', 'info', `pi 意外退出 ${crashes} 次，停止`); finish(); return; }
    timeline('restart_after_crash', 'corrective', `pi 退出码 ${code}`);
    setTimeout(() => launch(true, '继续'), 10_000);
  });
  phase = 'running';
  send({ id: `p${n}`, type: 'prompt', message });
}

function killGroup() {
  if (!child?.pid) return;
  expectExit = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  child = null;
  phase = 'down';
}

const asks = (t: string) => /[？?]\s*$|请确认|是否需要|要不要|你希望/.test(t.slice(-300));

function onSettled() {
  if (phase !== 'running') return;
  if (asks(lastText) && answers < 3) {
    answers++;
    timeline('answer_question', 'corrective', lastText.slice(-200).replace(/\s+/g, ' '));
    send({ type: 'prompt', message: ANSWER });
    return;
  }
  if (!flags.appended) {
    // 在追加时间点之前就停下了：追加需求作为一次新的请求给出
    flags.appended = true;
    timeline('append_after_finish', 'scripted', '在追加时间点前已停下，追加需求作为新请求给出');
    send({ type: 'prompt', message: APPEND });
    return;
  }
  phase = 'idle';
  timeline('settled', 'info', lastText.slice(0, 200).replace(/\s+/g, ' '));
  finish();
}

let finishing = false;
function finish() {
  if (finishing) return;
  finishing = true;
  phase = 'done';
  clearInterval(tick);
  if (!flags.killed) timeline('kill_not_triggered', 'info');
  if (!flags.quotaStarted) timeline('quota_not_triggered', 'info');
  killGroup();
  report();
}

const tick = setInterval(() => {
  const t = el();
  if (t >= AT.max) { timeline('stop', 'info', `超过 ${AT.max / MIN} 分钟上限`); finish(); return; }
  if (!flags.appended && t >= AT.append && phase === 'running') {
    flags.appended = true;
    timeline('append', 'scripted', '运行中用 steer 送达追加需求');
    send({ type: 'steer', message: APPEND });
  }
  if (!flags.killed && t >= AT.kill && phase === 'running') {
    flags.killed = true;
    timeline('kill', 'scripted', 'kill -9 进程组');
    killGroup();
    setTimeout(() => { timeline('resume', 'scripted', 'pi -c，发"继续"'); launch(true, '继续'); }, 10_000);
  }
  if (!flags.quotaStarted && t >= AT.quotaFrom && phase === 'running') {
    flags.quotaStarted = true;
    timeline('quota_start', 'scripted', '模拟额度用完：停掉进程，等待窗口结束');
    killGroup();
  }
  if (flags.quotaStarted && !flags.quotaEnded && t >= AT.quotaTo && phase === 'down') {
    flags.quotaEnded = true;
    timeline('quota_end', 'scripted', '额度恢复，pi -c，发"继续"');
    launch(true, '继续');
  }
}, 5_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { timeline('stop', 'info', `收到 ${sig}`); finish(); setTimeout(() => process.exit(130), 2_000); });

timeline('start', 'scripted', '发出需求 R1–R3');
launch(false, REQ);

function report() {
  const wall = el();
  // 会话文件（主会话 + subagent 子会话）的用量
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl') && !e.name.startsWith('stdout-') && e.name !== 'timeline.jsonl') files.push(p); } };
  walk(sessionDir);
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, tools: 0, compactions: 0 };
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      let o: { type?: string; message?: { role?: string; content?: { type: string }[]; usage?: Record<string, unknown> } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'compaction') sum.compactions++;
      const m = o.message;
      if (m?.role !== 'assistant') continue;
      sum.tools += (m.content ?? []).filter((x) => x.type === 'toolCall').length;
      if (!m.usage) continue;
      sum.turns++;
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) sum[k] += Number(m.usage[k] ?? 0) || 0;
      sum.cost += Number((m.usage['cost'] as { total?: number } | undefined)?.total ?? 0);
    }
  }
  const tl = existsSync(path.join(sessionDir, 'timeline.jsonl')) ? readFileSync(path.join(sessionDir, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; class: string }) : [];
  let tests = '';
  try { sh('bash', ['bench/test.sh']); tests = '全部通过'; } catch (e) { tests = `失败：${String((e as { stdout?: string }).stdout ?? '').split('\n').filter((l) => /FAIL|Tests |✖/.test(l)).slice(0, 10).join(' | ')}`; }
  const status = sh('git', ['status', '--porcelain']).split('\n').filter(Boolean);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const text = [
    '# 第五轮：原生 Pi 结果',
    `项目目录：${dir}`,
    `总耗时：${(wall / MIN).toFixed(1)} 分钟（含额度窗口）`,
    `人工动作：方案内置 ${tl.filter((x) => x.class === 'scripted').length} 次，纠正性干预 ${tl.filter((x) => x.class === 'corrective').length} 次（${tl.filter((x) => x.class === 'corrective').map((x) => x.kind).join('、') || '无'}）`,
    `会话文件 ${files.length} 个；上下文压缩 ${sum.compactions} 次`,
    `token：输入 ${fmt(sum.input)}，输出 ${fmt(sum.output)}，缓存读 ${fmt(sum.cacheRead)}，缓存写 ${fmt(sum.cacheWrite)}；金额 ${sum.cost.toFixed(4)}`,
    `轮数 ${sum.turns}，工具调用 ${sum.tools}`,
    `bench/test.sh：${tests}`,
    `改动（相对基线，含未提交）：${sh('git', ['diff', '--shortstat', baseSha]) || '无'}；未提交 ${status.length} 个文件`,
    `\n最后的回复：\n${lastText.slice(0, 2000)}`,
  ].join('\n');
  console.log(`\n${text}`);
  writeFileSync(path.join(sessionDir, 'report.md'), text);
  process.exit(0);
}
