// 极简 shell 解析：只为 guard 服务，提取简单命令、重定向与命令替换。
// 无法确定的结构返回 errors，由 guard 按"无法校验即阻断"处理。

export interface Word {
  /** 去掉引号后的文本；变量与替换部分原样保留 */
  text: string;
  /** 含未展开的变量、命令替换或算术展开 */
  dynamic: boolean;
  /** 含未加引号的通配符 */
  glob: boolean;
  /** 以未加引号的 ~ 开头 */
  tilde: boolean;
}

export interface Redirect {
  op: string;
  fd: string | null;
  target: Word;
  /** >&N / <&N 形式的文件描述符复制，不涉及文件 */
  fdDup: boolean;
}

export interface SimpleCommand {
  assignments: Word[];
  words: Word[];
  redirects: Redirect[];
  /** 是否位于命令替换、进程替换中（其中的 cd 不影响外层） */
  nested: boolean;
}

export interface ParseResult {
  commands: SimpleCommand[];
  errors: string[];
}

const REDIRECT_OPS = ['&>>', '<<<', '<<-', '>>', '>|', '<>', '<<', '>&', '<&', '&>', '>', '<'];
const SEPARATORS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'];

export function parseShell(src: string, nested = false): ParseResult {
  const out: ParseResult = { commands: [], errors: [] };
  const p = new Parser(src, nested, out);
  try {
    p.run();
  } catch (e) {
    out.errors.push((e as Error).message);
  }
  return out;
}

class Parser {
  private i = 0;
  private cur: SimpleCommand;
  private pendingHeredocs: { delim: string; expand: boolean }[] = [];
  private readonly src: string;
  private readonly nested: boolean;
  private readonly out: ParseResult;

  constructor(src: string, nested: boolean, out: ParseResult) {
    this.src = src;
    this.nested = nested;
    this.out = out;
    this.cur = this.fresh();
  }

  private fresh(): SimpleCommand {
    return { assignments: [], words: [], redirects: [], nested: this.nested };
  }

  private flush() {
    const c = this.cur;
    // 去掉分组用的 { }
    c.words = c.words.filter((w, idx) => !(w.text === '{' && idx === 0) && !(w.text === '}' && !w.dynamic));
    if (c.words.length || c.redirects.length || c.assignments.length) this.out.commands.push(c);
    this.cur = this.fresh();
  }

  run() {
    const s = this.src;
    while (this.i < s.length) {
      const ch = s[this.i]!;
      if (ch === ' ' || ch === '\t') { this.i++; continue; }
      if (ch === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (ch === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      const redir = this.matchRedirect();
      if (redir) { this.readRedirect(redir.op, redir.fd, redir.len); continue; }
      const sep = SEPARATORS.find((op) => s.startsWith(op, this.i));
      if (sep) {
        this.i += sep.length;
        this.flush();
        if (sep === '\n') this.readHeredocBodies();
        continue;
      }
      const w = this.readWord();
      if (!this.cur.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) this.cur.assignments.push(w);
      else this.cur.words.push(w);
    }
    this.flush();
    if (this.pendingHeredocs.length) this.readHeredocBodies();
  }

  private matchRedirect(): { op: string; fd: string | null; len: number } | null {
    const s = this.src;
    let j = this.i;
    while (j < s.length && /[0-9]/.test(s[j]!)) j++;
    const fd = j > this.i ? s.slice(this.i, j) : null;
    const op = REDIRECT_OPS.find((o) => s.startsWith(o, j));
    if (!op) return null;
    if (fd && op.startsWith('&')) return null;
    if ((op === '<' || op === '>') && s[j + 1] === '(') return null;
    return { op, fd, len: j - this.i + op.length };
  }

  private readRedirect(op: string, fd: string | null, len: number) {
    this.i += len;
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i++;
    if (this.i >= this.src.length || '\n;|&<>'.includes(this.src[this.i]!)) throw new Error(`重定向 ${op} 缺少目标`);
    const quotedStart = this.src[this.i] === '"' || this.src[this.i] === "'";
    const target = this.readWord();
    const fdDup = (op === '>&' || op === '<&') && /^(\d+|-)$/.test(target.text);
    if (op === '<<' || op === '<<-') {
      this.pendingHeredocs.push({ delim: target.text, expand: !quotedStart && !target.text.includes('\\') });
    }
    this.cur.redirects.push({ op, fd, target, fdDup });
  }

  private readHeredocBodies() {
    const s = this.src;
    while (this.pendingHeredocs.length) {
      const h = this.pendingHeredocs.shift()!;
      const lines: string[] = [];
      let found = false;
      while (this.i < s.length) {
        let end = s.indexOf('\n', this.i);
        if (end === -1) end = s.length;
        const line = s.slice(this.i, end);
        this.i = Math.min(end + 1, s.length);
        if (line.replace(/^\t+/, '') === h.delim) { found = true; break; }
        lines.push(line);
      }
      if (!found) throw new Error(`heredoc 缺少结束标记 ${h.delim}`);
      if (h.expand) this.scanSubstitutions(lines.join('\n'));
    }
  }

  /** 扫描 heredoc 正文中的 $(...) 与 `...` */
  private scanSubstitutions(body: string) {
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '\\') { k++; continue; }
      if (body.startsWith('$(', k) && !body.startsWith('$((', k)) {
        const end = findClose(body, k + 2);
        this.sub(body.slice(k + 2, end));
        k = end;
      } else if (body[k] === '`') {
        const end = body.indexOf('`', k + 1);
        if (end === -1) throw new Error('未闭合的反引号');
        this.sub(body.slice(k + 1, end));
        k = end;
      }
    }
  }

  private sub(inner: string) {
    const r = parseShell(inner, true);
    this.out.commands.push(...r.commands);
    this.out.errors.push(...r.errors);
  }

  private readWord(): Word {
    const s = this.src;
    const w: Word = { text: '', dynamic: false, glob: false, tilde: s[this.i] === '~' };
    while (this.i < s.length) {
      const ch = s[this.i]!;
      if (' \t\n;&|()'.includes(ch)) break;
      if ((ch === '<' || ch === '>') && s[this.i + 1] === '(') {
        const end = findClose(s, this.i + 2);
        this.sub(s.slice(this.i + 2, end));
        w.text += s.slice(this.i, end + 1);
        w.dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (ch === '<' || ch === '>') break;
      if (ch === '\\') {
        if (this.i + 1 < s.length) w.text += s[this.i + 1];
        this.i += 2;
        continue;
      }
      if (ch === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end === -1) throw new Error('未闭合的单引号');
        w.text += s.slice(this.i + 1, end);
        this.i = end + 1;
        continue;
      }
      if (ch === '"') { this.readDouble(w); continue; }
      if (ch === '$' || ch === '`') { this.readDollar(w); continue; }
      if ('*?['.includes(ch)) w.glob = true;
      w.text += ch;
      this.i++;
    }
    return w;
  }

  private readDouble(w: Word) {
    const s = this.src;
    this.i++;
    while (this.i < s.length && s[this.i] !== '"') {
      const ch = s[this.i]!;
      if (ch === '\\' && '$`"\\\n'.includes(s[this.i + 1] ?? '')) {
        w.text += s[this.i + 1];
        this.i += 2;
      } else if (ch === '$' || ch === '`') {
        this.readDollar(w);
      } else {
        w.text += ch;
        this.i++;
      }
    }
    if (s[this.i] !== '"') throw new Error('未闭合的双引号');
    this.i++;
  }

  private readDollar(w: Word) {
    const s = this.src;
    w.dynamic = true;
    if (s[this.i] === '`') {
      const end = s.indexOf('`', this.i + 1);
      if (end === -1) throw new Error('未闭合的反引号');
      this.sub(s.slice(this.i + 1, end));
      w.text += s.slice(this.i, end + 1);
      this.i = end + 1;
      return;
    }
    if (s.startsWith('$((', this.i)) {
      const end = findClose(s, this.i + 2);
      w.text += s.slice(this.i, end + 1);
      this.i = end + 1;
      return;
    }
    if (s.startsWith('$(', this.i)) {
      const end = findClose(s, this.i + 2);
      this.sub(s.slice(this.i + 2, end));
      w.text += s.slice(this.i, end + 1);
      this.i = end + 1;
      return;
    }
    if (s.startsWith('${', this.i)) {
      const end = s.indexOf('}', this.i);
      if (end === -1) throw new Error('未闭合的 ${');
      w.text += s.slice(this.i, end + 1);
      this.i = end + 1;
      return;
    }
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])?/.exec(s.slice(this.i))!;
    if (!m[1]) w.dynamic = false;
    w.text += m[0];
    this.i += m[0].length;
  }
}

/** 从 start（左括号之后）找到匹配的右括号位置，跳过引号。 */
function findClose(s: string, start: number): number {
  let depth = 1;
  for (let k = start; k < s.length; k++) {
    const ch = s[k]!;
    if (ch === '\\') { k++; continue; }
    if (ch === "'") {
      k = s.indexOf("'", k + 1);
      if (k === -1) break;
      continue;
    }
    if (ch === '"') {
      for (k++; k < s.length && s[k] !== '"'; k++) if (s[k] === '\\') k++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return k;
  }
  throw new Error('未闭合的括号');
}
