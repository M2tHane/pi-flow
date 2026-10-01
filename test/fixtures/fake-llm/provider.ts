// Pi 扩展：注册假 LLM provider（provider=fakellm），模型 id 即脚本名。由 FAKE_LLM_URL 指定服务地址。
import { readdirSync } from 'node:fs';
import path from 'node:path';

export default function (pi: any) {
  const url = process.env['FAKE_LLM_URL'];
  const dir = process.env['FAKE_LLM_SCRIPTS'];
  if (!url || !dir) return;
  const models = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
    id: f.slice(0, -5), name: `fake ${f.slice(0, -5)}`, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
  }));
  pi.registerProvider('fakellm', { baseUrl: url, apiKey: 'fake-key', api: 'openai-completions', models });
}
