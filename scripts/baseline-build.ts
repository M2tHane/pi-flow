// 对照实验：不加载 pi-flow，用原生 pi 从零做同一个项目，统计耗时、token、轮数、工具调用（含 subagent 子会话）。
//   node scripts/baseline-build.ts [--model provider/id] [--thinking high] [--desc "<描述>"] [--keep]
// 只加载 pi-serena、pi-codegraph、pi-subagents 三个插件（--no-extensions 后用 -e 显式加载），不加载其他全局插件、技能、提示模板与上下文文件。
// pi 以 -p 运行；它停下来提问时，代替用户回答"按建议继续"（与 real-build.ts 代替用户采纳建议的做法一致），最多 3 次。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeSession } from '../src/core/session-log.ts';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const MODEL = opt('--model', 'openai-codex/gpt-6.1-sol');
const THINKING = opt('--thinking', 'high');
const DESC = opt('--desc', '做一个个人记账服务（Node 24，ES 模块，无第三方依赖）：账户管理；收支记录（金额、日期、分类、备注，属于某个账户）；分类管理；月度统计（按月、按分类汇总收入与支出）；用 Node http 模块提供 REST API；数据用 JSON 文件存储；支持把收支记录导出为 CSV。测试用 node:test。');
// --desc-file：需求从文件读；--then-file：第一版做完后，在同一会话里再提一次需求变更（与 pi-flow 的 --feature-file 对应）
const DESC_TEXT = argv.includes('--desc-file') ? readFileSync(path.resolve(opt('--desc-file', '')), 'utf8').trim() : DESC;
const THEN = argv.includes('--then-file') ? readFileSync(path.resolve(opt('--then-file', '')), 'utf8').trim() : undefined;
const ANSWER = '同意你给出的建议（默认方案），按建议继续。';
const PLUGINS = path.join(homedir(), '.pi/agent/npm/node_modules');
const EXT = ['@bacnh85/pi-serena', '@vndv/pi-codegraph', 'pi-subagents'].map((p) => path.join(PLUGINS, p));
for (const e of EXT) if (!existsSync(e)) { console.error(`缺少插件：${e}`); process.exit(1); }

const dir = mkdtempSync(path.join(tmpdir(), 'pi-baseline-'));
const sessionDir = `${dir}.session`;
const sh = (cmd: string, a: string[]) => execFileSync(cmd, a, { cwd: dir, encoding: 'utf8' }).trim();
sh('git', ['init', '-q', '-b', 'main']);
writeFileSync(path.join(dir, 'package.json'), '{ "name": "todo-lib", "type": "module", "scripts": { "test": "node --test" } }\n');
sh('git', ['add', '.']);
sh('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@local', 'commit', '-q', '-m', '空项目']);
console.log(`项目目录：${dir}\n会话目录：${sessionDir}\n模型：${MODEL}（${THINKING}）\n插件：${EXT.map((e) => path.basename(e)).join('、')}`);

const t0 = Date.now();
let current: ReturnType<typeof spawn> | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { current?.kill('SIGTERM'); setTimeout(() => process.exit(130), 10_000).unref(); });

/** 运行一次 pi -p；返回最后一条 assistant 文本。stdout 是 JSON 事件流，原样存档供统计 */
function pi(prompt: string, cont: boolean, round: number): Promise<string> {
  const args = ['--mode', 'json', '-p', '--session-dir', sessionDir, ...(cont ? ['-c'] : []),
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    ...EXT.flatMap((e) => ['-e', e]), '--model', MODEL, '--thinking', THINKING, '--', prompt];
  return new Promise((resolve, reject) => {
    const c = spawn('pi', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } });
    current = c;
    let buf = '', last = '', raw = '';
    c.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      raw += chunk; buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'tool_execution_start') console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${ev.toolName}`);
          if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
            const text = (ev.message.content ?? []).filter((x: { type: string }) => x.type === 'text').map((x: { text: string }) => x.text).join('').trim();
            if (text) last = text;
          }
        } catch { /* 非 JSON 行 */ }
      }
    });
    c.stderr.setEncoding('utf8').on('data', (d: string) => process.stderr.write(d));
    c.on('close', (code) => {
      current = null;
      writeFileSync(`${sessionDir}/stdout-round${round}.jsonl`, raw);
      code === 0 ? resolve(last) : reject(new Error(`pi 退出码 ${code}`));
    });
  });
}

const asks = (t: string) => /[？?]\s*$|请确认|是否需要|要不要|你希望/.test(t.slice(-300));
let last = await pi(DESC_TEXT, false, 0);
for (let i = 1; i <= 3 && asks(last); i++) {
  console.log(`\n▶ 它在提问，代替用户回答：${ANSWER}\n  （它的问题：${last.slice(-300)}）`);
  last = await pi(ANSWER, true, i);
}
const buildEnd = Date.now();
if (THEN) {
  console.log(`\n▶ 第一版完成（${((buildEnd - t0) / 60000).toFixed(1)} 分钟），提出需求变更`);
  last = await pi(THEN, true, 10);
  for (let i = 11; i <= 13 && asks(last); i++) last = await pi(ANSWER, true, i);
}
const wall = Date.now() - t0;
// 每轮 pi 命令的主会话用量（来自 JSON 事件流；不含 subagent）
const roundUsage = (prefix: (n: number) => boolean) => {
  const u = { input: 0, output: 0, cacheRead: 0, turns: 0, tools: 0 };
  for (const f of readdirSync(sessionDir).filter((x) => x.startsWith('stdout-round'))) {
    if (!prefix(Number(f.match(/\d+/)![0]))) continue;
    for (const line of readFileSync(path.join(sessionDir, f), 'utf8').split('\n')) {
      try { const ev = JSON.parse(line); if (ev.type === 'tool_execution_start') u.tools++; if (ev.type === 'message_end' && ev.message?.role === 'assistant') { u.turns++; u.input += ev.message.usage?.input ?? 0; u.output += ev.message.usage?.output ?? 0; u.cacheRead += ev.message.usage?.cacheRead ?? 0; } } catch { /* 跳过 */ }
    }
  }
  return u;
};

// —— 统计：会话目录下的全部会话文件（主会话 + subagent 子会话） ——
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl') && !e.name.startsWith('stdout-')) files.push(p); } };
walk(sessionDir);
const parent = files.filter((f) => path.dirname(f) === sessionDir).sort((a, b) => statSync(a).size - statSync(b).size).at(-1);
const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const per = (f: string) => {
  const s = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: { message?: { role?: string; usage?: Record<string, number | { total?: number }> } };
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (m?.role !== 'assistant' || !m.usage) continue;
    s.turns++;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) s[k] += Number(m.usage[k] ?? 0) || 0;
    const c = m.usage['cost'] as { total?: number } | undefined; s.cost += c?.total ?? 0;
  }
  return s;
};
const rows = files.map((f) => ({ f, s: per(f), calls: summarizeSession(f).toolCalls }));
for (const r of rows) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r.s[k];
const calls = rows.flatMap((r) => r.calls);
const byTool = new Map<string, number>();
for (const c of calls) byTool.set(c.name, (byTool.get(c.name) ?? 0) + 1);

let tests = '';
try { tests = sh('node', ['--test', '--test-reporter=tap']).split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join('，'); } catch (e) { tests = `测试失败：${String((e as { stdout?: string }).stdout ?? e).split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join('，') || String(e).slice(0, 300)}`; }
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const report = [
  `\n# 原生 pi 对照结果`,
  ...(THEN ? (() => { const a = roundUsage((n) => n < 10), b = roundUsage((n) => n >= 10); return [`第一版：${((buildEnd - t0) / 60000).toFixed(1)} 分钟，主会话 ${a.turns} 轮、${a.tools} 次工具调用，输入 ${fmt(a.input)}、输出 ${fmt(a.output)}、缓存读 ${fmt(a.cacheRead)}`, `需求变更：${((wall - (buildEnd - t0)) / 60000).toFixed(1)} 分钟，主会话 ${b.turns} 轮、${b.tools} 次工具调用，输入 ${fmt(b.input)}、输出 ${fmt(b.output)}、缓存读 ${fmt(b.cacheRead)}`]; })() : []),
  `总耗时：${(wall / 60000).toFixed(1)} 分钟；代答次数：${Math.max(0, readdirSync(sessionDir).filter((f) => f.startsWith('stdout-round')).length - 1)}`,
  `会话文件：${files.length} 个（主会话 1 个${files.length > 1 ? `，subagent 子会话 ${files.length - 1} 个` : ''}）`,
  `token：输入 ${fmt(sum.input)}，输出 ${fmt(sum.output)}，缓存读 ${fmt(sum.cacheRead)}，缓存写 ${fmt(sum.cacheWrite)}，金额 ${sum.cost.toFixed(4)}`,
  `轮数（assistant 消息）：${sum.turns}`,
  `工具调用：${calls.length} 次，失败 ${calls.filter((c) => c.error).length} 次；按工具：${[...byTool].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，')}`,
  ...rows.map((r) => `  - ${r.f === parent ? '主会话' : '子会话'} ${path.relative(sessionDir, r.f)}：输入 ${fmt(r.s.input)}，输出 ${fmt(r.s.output)}，缓存读 ${fmt(r.s.cacheRead)}，${r.s.turns} 轮，${r.calls.length} 次工具调用`),
  `测试：${tests}`,
  `git 提交：${sh('git', ['rev-list', '--count', 'HEAD'])} 个；文件：${sh('git', ['ls-files']).split('\n').length} 个已跟踪，未提交改动 ${sh('git', ['status', '--porcelain']).split('\n').filter(Boolean).length} 个`,
  `\n最后的回复：\n${last.slice(0, 2000)}`,
].join('\n');
console.log(report);
writeFileSync(`${sessionDir}/report.md`, report);
