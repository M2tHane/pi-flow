// 路径规范化与 glob 关系判断。guard、dag、提交 diff 检查共用。
import path from 'node:path';
import { minimatch } from 'minimatch';

const MM = { dot: true } as const;
const GLOB_CHARS = /[*?[\]{}]/;

export const PROTECTED_PATHS = ['.flow/**', '.git/**', 'workflow.yaml', 'rules/**', '.pi/**'] as const;
export const CONTRACTS_PATH = 'docs/contracts/**';
export const SENSITIVE_PATHS = ['**/.env*', '**/*.pem', 'secrets/**', '**/secrets/**'] as const;

/** 把路径规范化为相对 root 的 posix 路径；越出 root 返回 null。不解析符号链接（由调用方用 realpath 处理）。 */
export function normalizeRelPath(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function matchesAny(rel: string, globs: readonly string[]): boolean {
  return globs.some((g) => minimatch(rel, g, MM));
}

export function protectedGlobs(opts: { contractsLocked: boolean }): string[] {
  return opts.contractsLocked ? [...PROTECTED_PATHS, CONTRACTS_PATH] : [...PROTECTED_PATHS];
}

export function isProtected(rel: string, opts: { contractsLocked: boolean }): boolean {
  return matchesAny(rel, protectedGlobs(opts));
}

export function isSensitive(rel: string): boolean {
  return matchesAny(rel, SENSITIVE_PATHS);
}

/** 模式 inner 匹配的路径是否一定落在 outer 内（保守判断：不确定时返回 false）。 */
export function globWithin(inner: string, outer: string): boolean {
  return minimatch.braceExpand(inner).every((i) =>
    minimatch.braceExpand(outer).some((o) => minimatch(i, o, MM)));
}

/** 两个模式是否可能匹配同一路径（保守判断：不确定时返回 true）。 */
export function globsOverlap(a: string, b: string): boolean {
  for (const x of minimatch.braceExpand(a)) {
    for (const y of minimatch.braceExpand(b)) {
      if (segsOverlap(x.split('/').filter(Boolean), y.split('/').filter(Boolean))) return true;
    }
  }
  return false;
}

function segsOverlap(a: string[], b: string[]): boolean {
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (a[i] === '**') r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (b[j] === '**') r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = segOverlap(a[i]!, b[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function segOverlap(x: string, y: string): boolean {
  const gx = GLOB_CHARS.test(x);
  const gy = GLOB_CHARS.test(y);
  if (!gx && !gy) return x === y;
  if (!gx) return minimatch(x, y, MM);
  if (!gy) return minimatch(y, x, MM);
  // 两边都是通配：比较字面前缀与后缀，冲突即不重叠
  const [px, sx] = literalEnds(x);
  const [py, sy] = literalEnds(y);
  const prefixOk = px.startsWith(py) || py.startsWith(px);
  const suffixOk = sx.endsWith(sy) || sy.endsWith(sx);
  return prefixOk && suffixOk;
}

function literalEnds(s: string): [string, string] {
  const first = s.search(GLOB_CHARS);
  let last = -1;
  for (let i = s.length - 1; i >= 0; i--) if (GLOB_CHARS.test(s[i]!)) { last = i; break; }
  return [s.slice(0, first), s.slice(last + 1)];
}
