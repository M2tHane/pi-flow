// 斜杠命令参数解析：Pi 把命令后的原始字符串交给 handler，这里按 shell 风格拆分（支持引号与反斜杠转义）。
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < input.length) { cur += input[++i]; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) throw new Error(`参数中的引号没有闭合：${input}`);
  if (has) out.push(cur);
  return out;
}
