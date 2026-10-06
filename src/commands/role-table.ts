// /flow-config 的角色表格：每行一个角色，列为 角色、职责、模型、备用模型、思考强度。
// 纯逻辑（状态、按键、渲染），不依赖 Pi；由 pi-adapter 用 ctx.ui.custom 承载。
import type { ThinkingLevel } from '../core/schemas.ts';

export interface RoleRow {
  role: string;
  purpose: string;
  /** 用户设置的值；undefined 表示用默认 */
  model?: string;
  escalate?: string;
  thinking?: ThinkingLevel;
  /** 不设置时实际生效的默认（来自 workflow.yaml）；没有则 undefined */
  defaults: { model?: string; escalate?: string; thinking?: string };
}

export interface TableModel { ref: string; levels: ThinkingLevel[] }

export type Column = 'model' | 'escalate' | 'thinking';
const COLUMNS: Column[] = ['model', 'escalate', 'thinking'];
const HEADERS = ['角色', '职责', '模型', '备用模型', '思考强度'];

export type KeyName = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shift-tab' | 'enter' | 'escape' | 'delete';

/** 终端按键序列 → 名称；同时认传统序列与 Kitty 键盘协议（CSI u / 带修饰符的方向键） */
export function keyName(data: string): KeyName | undefined {
  const arrow = /^\x1b(?:\[|O)(?:1;\d+(?::\d+)?)?([ABCD])$/.exec(data);
  if (arrow) return ({ A: 'up', B: 'down', C: 'right', D: 'left' } as const)[arrow[1] as 'A' | 'B' | 'C' | 'D'];
  if (data === '\t' || /^\x1b\[9(?:;1)?(?::\d+)?u$/.test(data)) return 'tab';
  if (data === '\x1b[Z' || /^\x1b\[9;2(?::\d+)?u$/.test(data)) return 'shift-tab';
  if (data === '\r' || data === '\n' || /^\x1b\[13(?:;\d+)?u$/.test(data)) return 'enter';
  if (data === '\x1b' || /^\x1b\[27(?:;\d+)?u$/.test(data)) return 'escape';
  if (data === '\x7f' || data === '\b' || data === '\x1b[3~' || /^\x1b\[127(?:;\d+)?u$/.test(data)) return 'delete';
  return undefined;
}

/** 终端显示宽度：CJK 与全角字符占两列 */
function charWidth(cp: number): number {
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6))) return 2;
  return 1;
}
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}
/** 截断到不超过 width 列，超出加省略号；再补空格到刚好 width 列 */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let w = 0;
  const over = textWidth(s) > width;
  const limit = over ? width - 1 : width;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  if (over) { out += '…'; w += 1; }
  return out + ' '.repeat(Math.max(0, width - w));
}

const REVERSE = '\x1b[7m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export type TableResult = 'save' | undefined;

export class RoleTable {
  readonly rows: RoleRow[];
  row = 0;
  col: Column = 'model';
  /** 打开时是选择列表：候选值（第一个为"默认"）与当前高亮 */
  picker: { options: (string | undefined)[]; index: number } | null = null;
  private readonly models: TableModel[];

  constructor(rows: RoleRow[], models: TableModel[]) {
    this.rows = rows.map((r) => ({ ...r, defaults: { ...r.defaults } }));
    this.models = models;
  }

  /** 该行当前生效的模型（用户设置优先，否则默认），用于决定可选的思考级别 */
  private effectiveModel(r: RoleRow): string | undefined {
    return r.model ?? r.defaults.model;
  }

  private levelsOf(ref: string | undefined): ThinkingLevel[] | undefined {
    if (!ref) return undefined;
    const lower = ref.toLowerCase();
    return this.models.find((m) => m.ref.toLowerCase() === lower)?.levels;
  }

  /** 列的候选值：第一个（undefined）是"默认" */
  private options(r: RoleRow, col: Column): (string | undefined)[] {
    if (col === 'thinking') {
      const levels = this.levelsOf(this.effectiveModel(r)) ?? (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as ThinkingLevel[]);
      return [undefined, ...levels];
    }
    return [undefined, ...this.models.map((m) => m.ref)];
  }

  private current(r: RoleRow, col: Column): string | undefined {
    return col === 'model' ? r.model : col === 'escalate' ? r.escalate : r.thinking;
  }

  private openPicker(): void {
    const r = this.rows[this.row]!;
    const options = this.options(r, this.col);
    const cur = this.current(r, this.col);
    const at = cur === undefined ? 0 : options.findIndex((o) => o?.toLowerCase() === cur.toLowerCase());
    this.picker = { options, index: Math.max(0, at) };
  }

  private set(r: RoleRow, col: Column, value: string | undefined): void {
    if (col === 'model') {
      r.model = value;
      // 新模型不支持当前思考级别时回到默认
      const levels = this.levelsOf(this.effectiveModel(r));
      if (r.thinking && levels && !levels.includes(r.thinking)) r.thinking = undefined;
    } else if (col === 'escalate') r.escalate = value;
    else r.thinking = value as ThinkingLevel | undefined;
  }

  handleInput(data: string): TableResult {
    const key = keyName(data);
    const p = this.picker;
    if (p) {
      if (key === 'up') p.index = (p.index - 1 + p.options.length) % p.options.length;
      else if (key === 'down') p.index = (p.index + 1) % p.options.length;
      else if (key === 'enter') { this.set(this.rows[this.row]!, this.col, p.options[p.index]); this.picker = null; }
      else if (key === 'escape') this.picker = null;
      return undefined;
    }
    switch (key) {
      case 'up': this.row = (this.row - 1 + this.rows.length) % this.rows.length; break;
      case 'down': this.row = (this.row + 1) % this.rows.length; break;
      case 'tab': this.col = COLUMNS[(COLUMNS.indexOf(this.col) + 1) % COLUMNS.length]!; break;
      case 'shift-tab': this.col = COLUMNS[(COLUMNS.indexOf(this.col) + COLUMNS.length - 1) % COLUMNS.length]!; break;
      case 'enter': this.openPicker(); break;
      case 'delete': this.set(this.rows[this.row]!, this.col, undefined); break;
      case 'escape': return 'save';
      default: break;
    }
    return undefined;
  }

  private cell(r: RoleRow, col: Column): string {
    const own = col === 'model' ? r.model : col === 'escalate' ? r.escalate : r.thinking;
    if (own) {
      const unavailable = col !== 'thinking' && !this.levelsOf(own) ? ' [不可用]' : '';
      return `${own}${unavailable}`;
    }
    const def = r.defaults[col];
    return def ? `默认（${def}）` : col === 'escalate' ? '默认' : col === 'model' ? '默认（未填写）' : '默认';
  }

  render(width: number): string[] {
    const body = this.rows.map((r) => [r.role, r.purpose, this.cell(r, 'model'), this.cell(r, 'escalate'), this.cell(r, 'thinking')]);
    const natural = HEADERS.map((h, i) => Math.max(textWidth(h), ...body.map((b) => textWidth(b[i]!))));
    const gap = 2;
    const marker = 2;
    // 窄终端先压缩职责列，再压缩其余列
    const budget = Math.max(20, width - marker - gap * (HEADERS.length - 1));
    const w = [...natural];
    const minW = [8, 6, 10, 10, 8];
    let over = w.reduce((a, b) => a + b, 0) - budget;
    for (const i of [1, 2, 3, 0, 4]) {
      if (over <= 0) break;
      const cut = Math.min(over, w[i]! - minW[i]!);
      if (cut > 0) { w[i]! -= cut; over -= cut; }
    }
    const line = (cells: string[], focusRow: boolean, header = false): string => {
      const parts = cells.map((c, i) => {
        const text = fit(c, w[i]!);
        const colIdx = i - 2;
        if (header) return `${BOLD}${text}${RESET}`;
        if (focusRow && colIdx >= 0 && COLUMNS[colIdx] === this.col) return `${REVERSE}${text}${RESET}`;
        if (i === 1) return `${DIM}${text}${RESET}`;
        return text;
      });
      return `${focusRow ? '→ ' : '  '}${parts.join(' '.repeat(gap))}`;
    };
    const lines = [`${BOLD}pi-flow：各角色的模型与思考强度${RESET}`, ''];
    lines.push(line(HEADERS, false, true));
    body.forEach((b, i) => lines.push(line(b, i === this.row)));
    lines.push('');
    const p = this.picker;
    if (p) {
      const r = this.rows[this.row]!;
      const colName = { model: '模型', escalate: '备用模型', thinking: '思考强度' }[this.col];
      lines.push(`${BOLD}选择 ${r.role} 的${colName}${RESET}`);
      const VISIBLE = 10;
      const start = Math.min(Math.max(0, p.index - Math.floor(VISIBLE / 2)), Math.max(0, p.options.length - VISIBLE));
      const shown = p.options.slice(start, start + VISIBLE);
      if (start > 0) lines.push(`${DIM}  ↑ 还有 ${start} 项${RESET}`);
      shown.forEach((o, i) => {
        const label = o ?? (r.defaults[this.col] ? `默认（${r.defaults[this.col]}）` : '默认');
        const mark = this.current(r, this.col)?.toLowerCase() === o?.toLowerCase() ? ' ✓' : '';
        const text = fit(`${label}${mark}`, Math.max(1, width - 2)).trimEnd();
        lines.push(start + i === p.index ? `${REVERSE}→ ${text}${RESET}` : `  ${text}`);
      });
      if (start + VISIBLE < p.options.length) lines.push(`${DIM}  ↓ 还有 ${p.options.length - start - VISIBLE} 项${RESET}`);
      lines.push('');
    }
    const hint = p ? '↑↓ 选择  Enter 确认  Esc 返回' : '↑↓ 选择角色  Tab 切换列  Enter 修改当前格  Backspace 恢复默认  Esc 保存并退出';
    lines.push(`${DIM}${fit(hint, width).trimEnd()}${RESET}`);
    return lines;
  }
}
