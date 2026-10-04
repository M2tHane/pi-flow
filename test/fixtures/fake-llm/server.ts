// 假 LLM：OpenAI chat completions 兼容的流式服务，按脚本返回文本或工具调用。测试不依赖真实模型。
// 脚本：<scriptsDir>/<model>.json = { steps: Step[] }；第 n 次请求（按请求中 assistant 消息数计）返回 steps[n]。
// 每个请求追加记录到 <logFile>（JSONL），便于断言系统提示与声明的工具。
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Step {
  text?: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  /** 返回前延迟（模拟慢模型），毫秒 */
  delay_ms?: number;
  /** 返回 HTTP 错误（模拟额度用完、限流）：{ status: 429, message: 'insufficient_quota ...' } */
  error?: { status: number; message: string; code?: string };
}

const isNotes = (m: { content: unknown }) => JSON.stringify(m.content ?? '').includes('由程序在每次请求时放回上下文');

export interface FakeLlm { url: string; close(): Promise<void> }

export function startFakeLlm(opts: { scriptsDir: string; logFile?: string; port?: number }): Promise<FakeLlm> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const payload = JSON.parse(body || '{}') as { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      const turn = payload.messages.filter((m) => m.role === 'assistant').length;
      if (opts.logFile) {
        appendFileSync(opts.logFile, JSON.stringify({
          model: payload.model, turn,
          system: payload.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content),
          tools: (payload.tools ?? []).map((t) => t.function.name),
          // pi-flow 每次请求在末尾放回的笔记单独记录；last 是笔记之前的最后一条消息
          last: payload.messages.filter((m) => !isNotes(m)).at(-1),
          notes: payload.messages.filter(isNotes).map((m) => m.content).at(-1) ?? null,
        }) + '\n');
      }
      const file = path.join(opts.scriptsDir, `${payload.model}.json`);
      // 脚本可以是 { steps } 或 { variants: [{ match, steps }] }：按第一条用户消息中是否包含 match 选择
      const script = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { steps?: Step[]; variants?: { match: string; steps: Step[] }[] } : {};
      const firstUser = JSON.stringify(payload.messages.find((m) => m.role === 'user')?.content ?? '');
      const steps: Step[] = script.variants ? (script.variants.find((v) => firstUser.includes(v.match))?.steps ?? []) : (script.steps ?? []);
      const step: Step = steps[turn] ?? { text: '（脚本已结束）' };
      if (step.delay_ms) await new Promise((r) => setTimeout(r, step.delay_ms));
      if (step.error) {
        res.writeHead(step.error.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.error.message, type: step.error.code ?? 'error', code: step.error.code ?? null } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = `chatcmpl-${turn}`;
      const send = (delta: unknown, finish: string | null = null, usage?: unknown) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: payload.model,
          choices: usage && !delta ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
      send({ role: 'assistant', content: '' });
      if (step.text) send({ content: step.text });
      (step.tool_calls ?? []).forEach((tc, i) => send({ tool_calls: [{ index: i, id: `call_${turn}_${i}`, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }));
      send({}, step.tool_calls?.length ? 'tool_calls' : 'stop');
      const u = step.usage ?? { prompt_tokens: 100 + turn, completion_tokens: 10, cached_tokens: 0 };
      send(null, null, { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,
        total_tokens: u.prompt_tokens + u.completion_tokens, prompt_tokens_details: { cached_tokens: u.cached_tokens ?? 0 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

// 独立运行：node server.ts <scriptsDir> <logFile> <port>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [scriptsDir, logFile, port] = process.argv.slice(2);
  startFakeLlm({ scriptsDir: scriptsDir!, logFile, port: Number(port ?? 0) }).then((s) => console.log(s.url));
}
