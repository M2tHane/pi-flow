// 以 RPC 模式驱动 pi：发送一条 prompt，按计划应答扩展 UI 的 select/confirm/input，收集 notify。
// 用法：node rpc-driver.ts <cwd> <plan.json> <pi 参数...>
//   plan.json = { prompt: string, answers: string[] }，answers 依次用于每个对话框：select 按选项前缀匹配，confirm 用 "yes"/"no"，input 原样
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface DriveResult { selects: { title: string; options: string[]; answer: string | null }[]; notifies: string[]; exitCode: number | null }

export function drive(cwd: string, prompt: string, answers: string[], piArgs: string[], timeoutMs = 60_000): Promise<DriveResult> {
  const proc = spawn('pi', ['--mode', 'rpc', '--no-session', ...piArgs], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const result: DriveResult = { selects: [], notifies: [], exitCode: null };
  const queue = [...answers];
  const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + '\n');
  let buf = '';
  let done = false;
  const finish = () => { if (!done) { done = true; proc.stdin.end(); setTimeout(() => proc.kill(), 500); } };
  const timer = setTimeout(() => { result.notifies.push('[driver] 超时'); finish(); }, timeoutMs);
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'extension_ui_request') {
        if (msg.method === 'notify') { result.notifies.push(msg.message); continue; }
        if (msg.method === 'select') {
          const want = queue.shift();
          const pick = want === undefined ? undefined : (msg.options as string[]).find((o) => o.startsWith(want));
          result.selects.push({ title: msg.title, options: msg.options, answer: pick ?? null });
          send(pick === undefined ? { type: 'extension_ui_response', id: msg.id, cancelled: true } : { type: 'extension_ui_response', id: msg.id, value: pick });
        } else if (msg.method === 'confirm') {
          send({ type: 'extension_ui_response', id: msg.id, confirmed: queue.shift() === 'yes' });
        } else if (msg.method === 'input' || msg.method === 'editor') {
          const v = queue.shift();
          send(v === undefined ? { type: 'extension_ui_response', id: msg.id, cancelled: true } : { type: 'extension_ui_response', id: msg.id, value: v });
        }
      } else if (msg.type === 'response' && msg.command === 'prompt') {
        // prompt 命令已被接受；扩展命令执行完后没有 agent 事件，靠 agent_settled 或短暂空闲结束
        setTimeout(finish, 1500);
      } else if (msg.type === 'agent_settled') {
        finish();
      }
    }
  });
  send({ id: 'p1', type: 'prompt', message: prompt });
  return new Promise((resolve) => proc.on('exit', (code) => { clearTimeout(timer); result.exitCode = code; resolve(result); }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cwd, planFile, ...piArgs] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planFile!, 'utf8')) as { prompt: string; answers: string[] };
  drive(cwd!, plan.prompt, plan.answers, piArgs).then((r) => console.log(JSON.stringify(r, null, 2)));
}
