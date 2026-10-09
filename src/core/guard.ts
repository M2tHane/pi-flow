// guard：工具调用拦截与角色策略（第 14 节）。纯判断，不做写入；违规记录由调用方交给 StateStore。
// 判定顺序：1 工具白名单（含 orchestrator 读路径）→ 2 写路径白名单 → 3 受保护路径 → 4 bash 约束 → 5 敏感读取。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { BUILTIN_READ_TOOLS, BUILTIN_WRITE_TOOLS, type FlowConfig, type ResolvedRole } from './config.ts';
import { INTERFACES_PATH, globsOverlap, isProtected, matchesAny, protectedGlobs } from './paths.ts';
import { parseShell, type SimpleCommand, type Word } from './shell.ts';

export type GuardRule = 'tool_whitelist' | 'read_paths' | 'write_paths' | 'protected' | 'bash' | 'sensitive';
export type GuardDecision = { allow: true } | { allow: false; rule: GuardRule; reason: string };

export interface ToolCall { toolName: string; input: Record<string, unknown> }

export interface GuardContext {
  config: FlowConfig;
  role: string;
  /** 子进程工作目录 */
  cwd: string;
  /** 可写根目录：实施类为任务 worktree，主工作区角色为项目根 */
  workspaceRoot: string;
  /** 主工作区（项目根）。与 workspaceRoot 不同时，主工作区整体不可写 */
  mainRoot: string;
  /** 任务 writes（merge-fix 为冲突文件列表）；与角色 writes 同时生效 */
  writes?: string[];
  /** 实现类任务（第五轮）：可以在模块之间的接口文档（docs/interfaces/）里追加（只能新增，提交时由程序检查），不受任务可写范围限制 */
  interfaceAdditions?: boolean;
  /** 可以修改的已有测试文件（testing.adjust_tests，第四轮后续）：基线上已有、writes 之外；新增删除由 flow_submit 拒绝 */
  adjustableTests?: readonly string[];
  /** 本 run 的临时目录（项目与 worktree 之外）：可以 cd、写入、删除、移动 */
  scratchDir?: string;
  /** 给 orchestrator 的指引中填入的 ready 任务 */
  readyTaskId?: string;
  homeDir?: string;
}

/**
 * 扩展工具（serena 等）中被视为路径的参数名。
 * 待 M0 核实 serena 真实参数名后补全；写工具取不到路径时按"无法校验即阻断"处理。
 */
export const DEFAULT_PATH_KEYS = ['path', 'paths', 'relative_path', 'file', 'files', 'file_path', 'filepath', 'filename', 'dir', 'directory', 'target'];

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DEV_FILES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const INPUT_OPS = new Set(['<', '<>', '<&']);

const IMPL_FORBIDDEN: Record<string, string> = {
  tee: '请用 write/edit 工具写文件',
  wget: '只有 researcher 可以联网；访问本机服务用 curl http://localhost:<端口>/...', ssh: '禁止远程连接', scp: '禁止远程连接', sftp: '禁止远程连接',
  eval: 'eval 无法校验，请直接写出命令', popd: '不支持 popd',
  setsid: '新会话中的进程不受超时管理，请前台运行', disown: '后台进程不受超时管理，请前台运行',
};
/**
 * 会打开桌面应用或浏览器窗口的命令：agent 只写代码、跑测试，看效果交给用户（ZCode 实测：验收者反复拉起用户的桌面端）。
 * 无界面（headless）的浏览器测试照常由测试命令运行；项目自己的启动命令写在 workflow.yaml 的 gui_commands。
 */
const GUI_BINARIES = new Set(['open', 'xdg-open', 'osascript', 'electron', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'firefox', 'msedge']);
const GUI_SUBCOMMANDS: Record<string, readonly string[]> = { playwright: ['open', 'codegen', 'show-report', 'show-trace'], cypress: ['open'], gio: ['open'] };
export const GUI_REASON = '不能启动桌面应用或打开浏览器窗口：你只写代码、跑测试（无界面的测试照常运行）。需要打开看效果的，写进 handoff（验收时用 manual 标给用户），由用户自己打开查看。';

/** 命令（已剥离 sudo、env 等包装）是否会打开图形界面 */
export function opensGui(words: readonly string[], projectCommands: readonly string[] = []): boolean {
  const base = (w: string) => path.basename(w);
  if (!words.length) return false;
  if (GUI_BINARIES.has(base(words[0]!))) return true;
  if (words.includes('--headed') || words.some((w) => w === '--ui' || w.startsWith('--ui='))) return true;
  // npx electron、pnpm exec playwright open 等：在参数里找界面程序
  for (let i = 0; i < words.length; i++) {
    const w = base(words[i]!);
    if (i > 0 && w === 'electron') return true;
    const subs = GUI_SUBCOMMANDS[w];
    if (subs && subs.includes(words[i + 1] ?? '')) return true;
  }
  const line = scriptLine(words);
  return projectCommands.some((c) => { const p = scriptLine(c.trim().split(/\s+/)); return !!p && (line === p || line.startsWith(`${p} `) || line.startsWith(`${p}:`)); });
}

/** package.json 脚本里会打开界面的写法（electron-builder 等打包命令不算） */
const GUI_SCRIPT = /(^|[\s"'&|;(])(electron(?![-\w])|electron-vite\s+(dev|preview)|electron-forge\s+start|tauri\s+dev|expo\s+start|react-native\s+run-|cypress\s+open|playwright\s+(open|codegen)|xdg-open|open\s+(-a\s|https?:)|--headed|--open\b)/;
/** 脚本调用的 node 文件里拉起界面的写法 */
const GUI_FILE = /(spawn\w*|exec\w*)\(\s*['"`]electron['"`]|require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]|new\s+BrowserWindow\b|headless:\s*false/;
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNER_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'exec', 'dlx', 'x', 'ci', 'why', 'list', 'ls', 'outdated', 'update', 'link', 'publish', 'pack']);

/**
 * npm、pnpm、yarn、bun 运行的 package.json 脚本是否会打开界面：看脚本本身、它调用的同包脚本、以及 node 运行的文件（最多 4 层）。
 * 只认简单写法（runner [run] <脚本>）；pnpm --filter 等跨包写法交给 workflow.yaml 的 gui_commands。
 */
export function scriptOpensGui(words: readonly string[], cwd: string, stopAt: string): boolean {
  if (!RUNNERS.has(path.basename(words[0] ?? ''))) return false;
  const rest = words.slice(1);
  const name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0];
  if (!name || name.startsWith('-') || RUNNER_BUILTINS.has(name)) return false;
  let dir = path.resolve(cwd);
  let pkgFile = '';
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) { pkgFile = path.join(dir, 'package.json'); break; }
    if (dir === stopAt || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  if (!pkgFile) return false;
  let scripts: Record<string, string>;
  try { scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return false; }
  const seen = new Set<string>();
  const visit = (script: string, depth: number): boolean => {
    const body = scripts[script];
    if (!body || seen.has(script) || depth > 4) return false;
    seen.add(script);
    if (GUI_SCRIPT.test(body)) return true;
    for (const m of body.matchAll(/(?:^|[\s"'&|;(])node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?js|cjs|ts|mts))/g)) {
      try { if (GUI_FILE.test(readFileSync(path.resolve(dir, m[1]!), 'utf8'))) return true; } catch { /* 文件不存在：不算 */ }
    }
    for (const m of body.matchAll(/(?:^|[\s"'&|;(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.@/-]+)/g)) if (visit(m[1]!, depth + 1)) return true;
    return false;
  };
  return visit(name, 0);
}

/** pnpm run dev 与 pnpm dev 视为同一条命令 */
function scriptLine(words: readonly string[]): string {
  const w = words.filter(Boolean);
  if (w.length > 2 && ['npm', 'pnpm', 'yarn', 'bun'].includes(path.basename(w[0]!)) && w[1] === 'run') return [w[0], ...w.slice(2)].join(' ');
  return w.join(' ');
}

/**
 * curl 只访问本机时放行（验收者要调用自己启动的服务；角色提示里写了用 curl，旧规则却一律拦下，ZCode 实测因此违规到上限）。
 * 不能写文件、不能走代理、不能读配置文件；返回 null 表示放行，否则返回拒绝原因。
 */
const CURL_DENY_FLAGS = new Set(['-o', '--output', '-O', '--remote-name', '--remote-name-all', '-T', '--upload-file', '-K', '--config', '-x', '--proxy', '--output-dir', '-c', '--cookie-jar', '-D', '--dump-header']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
export function localCurlDenied(args: readonly string[]): string | null {
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = a.startsWith('--') ? a.split('=')[0]! : a;
    if (CURL_DENY_FLAGS.has(flag) || (/^-[a-zA-Z]+$/.test(a) && /[oOTKxcD]/.test(a.slice(1)))) {
      const value = a.includes('=') ? a.split('=').slice(1).join('=') : args[i + 1];
      if ((flag === '-o' || flag === '--output' || flag === '-D' || flag === '--dump-header') && value === '/dev/null') { if (!a.includes('=')) i++; continue; }
      return `curl 不能使用 ${a}（不能写文件、走代理或读配置）`;
    }
    if (a.startsWith('-')) continue;
    let host: string;
    try { host = new URL(/^[a-z]+:\/\//i.test(a) ? a : `http://${a}`).hostname; } catch { continue; }
    if (!/^[a-z]+:\/\//i.test(a) && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(a)) continue;
    urls++;
    if (!LOCAL_HOSTS.has(host) && host !== '::1') return `curl 只能访问本机（localhost、127.0.0.1），不能访问 ${host}；只有 researcher 可以联网`;
  }
  return urls ? null : 'curl 只能访问本机地址（http://localhost:<端口>/...），请写出完整的 URL';
}

/** 实施类角色可以对临时目录与任务 writes 内的文件使用的文件操作 */
const FILE_OPS = new Set(['rm', 'mv', 'cp', 'rmdir']);
const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'git', 'pwd', 'echo', 'printf', 'tree', 'file',
  'stat', 'du', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'jq', 'which', 'basename', 'dirname', 'realpath', 'true', 'false',
  'test', '[', 'nl', 'column', 'comm', 'shasum', 'sha256sum', 'md5', 'md5sum', 'xxd', 'hexdump', 'od', 'date', 'cd',
]);
const GIT_READONLY = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'grep', 'shortlog', 'describe',
  'merge-base', 'name-rev', 'rev-list', 'show-ref', 'branch',
]);
const GIT_IMPL_FORBIDDEN: Record<string, string> = {
  rebase: '改写历史', 'filter-branch': '改写历史', 'filter-repo': '改写历史', 'update-ref': '改写引用', replace: '改写历史',
  switch: '切换分支', worktree: '操作 worktree', clean: '删除未跟踪文件', push: '推送由引擎在合并时完成',
  fetch: '联网', pull: '联网', remote: '修改远程配置', reflog: '改写 reflog', tag: '修改共享标签',
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'timeout', 'stdbuf', 'xargs']);

const ok: GuardDecision = { allow: true };
const deny = (rule: GuardRule, reason: string): GuardDecision => ({ allow: false, rule, reason });

type Area = { area: 'workspace' | 'main' | 'scratch' | 'outside'; abs: string; rel: string };

class Evaluator {
  readonly ctx: GuardContext;
  readonly role: ResolvedRole;
  readonly ws: string;
  readonly main: string;
  readonly home: string;
  readonly scratch: string | null;

  constructor(ctx: GuardContext) {
    this.ctx = ctx;
    this.role = ctx.config.role(ctx.role);
    this.ws = realpathSafe(ctx.workspaceRoot);
    this.main = realpathSafe(ctx.mainRoot);
    this.home = ctx.homeDir ?? homedir();
    this.scratch = ctx.scratchDir ? realpathDeep(path.resolve(ctx.scratchDir)) : null;
  }

  get isOrchestrator() { return this.role.name === 'orchestrator'; }
  get isReadonlyRole() { return !this.isOrchestrator && this.role.writes.length === 0; }

  hint(): string {
    if (this.isOrchestrator) {
      return this.ctx.readyTaskId
        ? `你是调度者，不能直接修改代码。请调用 flow_dispatch(${this.ctx.readyTaskId}) 交给对应 subagent。`
        : '你是调度者，不能直接修改代码。任务由程序派发给对应 subagent，用 flow_wait 等待结果。';
    }
    if (this.role.name === 'acceptor') return '你是独立验收者，不能修改仓库里的文件（临时文件放在临时目录）；结论用 flow_accept（复查用 flow_accept_confirm）提交。';
    if (this.isReadonlyRole) return `你是只读角色（${this.role.name}），不能修改任何文件；结论请写进 flow_note 并 flow_submit。`;
    return `你是 ${this.role.name}，只能修改本任务 writes 内的文件；确需越界时调用 flow_block 说明原因，不要换一种方式再试。`;
  }

  /** 与 Pi 的 resolveToCwd 一致：Unicode 空格、去掉 @ 前缀、~、file://；再解析符号链接。 */
  resolveToolPath(input: string, cwd = this.ctx.cwd): string {
    let p = input.replace(UNICODE_SPACES, ' ');
    if (p.startsWith('@')) p = p.slice(1);
    if (p === '~') p = this.home;
    else if (p.startsWith('~/')) p = path.join(this.home, p.slice(2));
    if (/^file:\/\//.test(p)) p = fileURLToPath(p);
    return realpathDeep(path.resolve(cwd, p));
  }

  classify(abs: string): Area {
    const inScratch = this.scratch ? within(this.scratch, abs) : null;
    if (inScratch !== null) return { area: 'scratch', abs, rel: inScratch };
    const inWs = within(this.ws, abs);
    if (inWs !== null) return { area: 'workspace', abs, rel: inWs };
    const inMain = within(this.main, abs);
    if (inMain !== null) return { area: 'main', abs, rel: inMain };
    return { area: 'outside', abs, rel: abs };
  }

  effectiveWrites(): string[] {
    return this.ctx.writes ?? this.role.writes;
  }

  checkWrite(rawPath: string, tool: string, cwd?: string): GuardDecision {
    const a = this.classify(this.resolveToolPath(rawPath, cwd));
    if (a.area === 'scratch') return this.isReadonlyRole || this.isOrchestrator ? deny('write_paths', `只读角色不能写文件。${this.hint()}`) : ok;
    if (a.area === 'main') return deny('write_paths', `不能写主工作区（${a.rel}），只能修改当前 worktree 内的文件。${this.hint()}`);
    if (a.area === 'outside') return deny('write_paths', `只能写当前 worktree 内的文件，${a.abs} 在其外。${this.hint()}`);
    const writes = this.effectiveWrites();
    const inTask = (matchesAny(a.rel, writes) && matchesAny(a.rel, this.role.writes))
      || (!!this.ctx.interfaceAdditions && matchesAny(a.rel.toLowerCase(), [INTERFACES_PATH]))
      || (this.ctx.adjustableTests?.includes(a.rel) ?? false);
    if (!inTask) {
      return deny('write_paths', `${a.rel} 不在本任务可写范围内（${writes.join(', ') || '无'}）。${tool} 被阻断。${this.hint()}`);
    }
    if (isProtectedNocase(a.rel)) {
      return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读（${protectedGlobs().join('、')}）。`);
    }
    return ok;
  }

  checkSensitive(rawPath: string, cwd?: string): GuardDecision {
    const a = this.classify(this.resolveToolPath(rawPath, cwd));
    if (isSensitiveRel(a.rel)) return deny('sensitive', `禁止读取敏感文件 ${a.rel}（.env*、*.pem、secrets/**）。`);
    return ok;
  }

  checkReadPaths(rawPath: string | undefined): GuardDecision {
    const allowed = this.role.readPaths;
    if (!allowed) return ok;
    const a = this.classify(this.resolveToolPath(rawPath ?? '.'));
    // 工作区根目录（grep、find、ls 不给路径时）：只有 read_paths 含 ** 时允许
    if (a.area !== 'workspace' || !matchesAny(a.rel === '.' ? '' : a.rel, allowed)) {
      return deny('read_paths', `${this.role.name} 只能读取 ${allowed.join('、')}，${a.rel} 不在其中。${this.hint()}`);
    }
    return ok;
  }

  run(call: ToolCall): GuardDecision {
    const { toolName: tool, input } = call;
    // 1. 工具白名单
    if (!this.role.tools.has(tool)) {
      return deny('tool_whitelist', this.isOrchestrator ? this.hint() : `角色 ${this.role.name} 无权使用工具 ${tool}。${this.hint()}`);
    }
    const kind = this.ctx.config.toolKind(tool);
    const builtin = (BUILTIN_READ_TOOLS as readonly string[]).includes(tool) || (BUILTIN_WRITE_TOOLS as readonly string[]).includes(tool);
    const paths = extractPaths(input, builtin ? ['path'] : DEFAULT_PATH_KEYS);

    if (kind === 'read' || kind === 'ext-read') {
      if (kind === 'read') {
        const rp = this.checkReadPaths(paths[0]);
        if (!rp.allow) return rp;
      }
      for (const p of paths) {
        const s = this.checkSensitive(p);
        if (!s.allow) return s;
      }
      // find 的 pattern、grep 的 glob 是文件名模式
      for (const key of ['pattern', 'glob'] as const) {
        const v = input[key];
        if ((tool === 'find' && key === 'pattern') || (tool === 'grep' && key === 'glob')) {
          if (typeof v === 'string' && sensitiveGlob(v)) return deny('sensitive', `禁止搜索敏感文件（${v}）。`);
        }
      }
      return ok;
    }
    if (kind === 'write') {
      // 2 + 3. 写路径白名单与受保护路径
      if (!paths.length) return deny('write_paths', `无法确定 ${tool} 的写入路径，已按写操作阻断。${this.hint()}`);
      for (const p of paths) {
        const d = this.checkWrite(p, tool);
        if (!d.allow) return d;
      }
      return ok;
    }
    if (kind === 'bash') {
      const command = input['command'];
      if (typeof command !== 'string') return deny('bash', 'bash 调用缺少 command 参数');
      return new BashChecker(this).check(command, this.ctx.cwd);
    }
    return ok;
  }
}

class BashChecker {
  private readonly ev: Evaluator;
  private readonly readonly: boolean;

  constructor(ev: Evaluator) {
    this.ev = ev;
    this.readonly = ev.role.bash === 'readonly';
  }

  check(command: string, startCwd: string, depth = 0): GuardDecision {
    if (depth > 4) return deny('bash', '嵌套的 shell 层数过多，无法校验');
    const parsed = parseShell(command);
    if (parsed.errors.length) return deny('bash', `无法解析的命令（${parsed.errors[0]}），已阻断。请改写为简单命令。`);
    // 后台运行的进程脱离 bash 超时的管理，结束外层后会留下孤儿进程（真实冒烟：死循环的测试在后台堆积，占满 CPU）
    if (parsed.background) return deny('bash', '禁止把命令放到后台运行（&）：后台进程不受超时管理，容易留下一直运行的孤儿进程。请前台运行；需要限时就给 bash 调用设置 timeout。');
    let cwd = startCwd;
    // 同一条命令中先用字面量赋值的变量（例如 D=/tmp/x; cp a $D/b），在校验时代入；其余变量仍按无法校验处理
    const vars = new Map<string, string>();
    for (const raw of parsed.commands) {
      const cmd = raw.nested ? raw : substituteVars(raw, vars);
      if (!cmd.nested && !cmd.words.length) {
        for (const a of cmd.assignments) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a.text);
          if (m) { if (a.dynamic) vars.delete(m[1]!); else vars.set(m[1]!, m[2]!); }
        }
      }
      const r = this.checkCommand(cmd, cmd.nested ? startCwd : cwd, depth);
      if (!r.decision.allow) return r.decision;
      if (r.cwd && !cmd.nested) cwd = r.cwd;
    }
    return ok;
  }

  private checkCommand(cmd: SimpleCommand, cwd: string, depth: number): { decision: GuardDecision; cwd?: string } {
    const red = this.checkRedirects(cmd, cwd);
    if (!red.allow) return { decision: red };

    let words = cmd.words;
    let viaXargs = false;
    // 剥离包装命令
    for (;;) {
      const name = words[0];
      if (!name) return { decision: ok };
      if (name.dynamic || name.glob) return { decision: deny('bash', `命令名 ${name.text} 含变量或通配，无法校验，已阻断`) };
      const base = path.basename(name.text);
      if (!WRAPPERS.has(base)) break;
      if (this.readonly && !['xargs', 'command', 'time'].includes(base)) {
        return { decision: deny('bash', `只读角色不能使用 ${base}。${this.ev.hint()}`) };
      }
      if (base === 'xargs') viaXargs = true;
      const rest = stripWrapper(base, words.slice(1));
      if (!rest.length && base === 'env') return { decision: deny('sensitive', '禁止打印环境变量（可能含密钥）。') };
      words = rest;
    }
    const name = path.basename(words[0]!.text);
    const args = words.slice(1);

    // 嵌套 shell：递归校验 -c 内容
    if (SHELLS.has(name)) {
      const ci = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
      if (ci >= 0) {
        const inner = args[ci + 1];
        if (!inner || inner.dynamic) return { decision: deny('bash', `${name} -c 的内容含变量，无法校验`) };
        return { decision: this.check(inner.text, cwd, depth + 1) };
      }
      if (this.readonly) return { decision: deny('bash', `只读角色不能执行脚本。${this.ev.hint()}`) };
    }

    if (['printenv', 'set', 'export', 'declare'].includes(name) && (name === 'printenv' || args.length === 0 || args[0]?.text === '-p')) {
      return { decision: deny('sensitive', '禁止打印环境变量（可能含密钥）。') };
    }

    // 5. 敏感读取（参数）
    for (const w of args) {
      const s = this.sensitiveWord(w, cwd);
      if (!s.allow) return { decision: s };
    }

    if (name === 'cd' || name === 'pushd') return this.checkCd(args, cwd);

    const texts = words.map((w) => w.text);
    if (opensGui(texts, this.ev.ctx.config.raw.gui_commands ?? []) || scriptOpensGui(texts, cwd, this.ev.ws)) return { decision: deny('bash', GUI_REASON) };

    if (this.readonly) return { decision: this.checkReadonly(name, args) };

    // 4. 实施类角色的 bash 约束；rm、mv、cp、rmdir 只能作用于临时目录与本任务 writes 内的文件
    if (FILE_OPS.has(name)) {
      if (viaXargs) return { decision: deny('bash', `${name} 的参数来自标准输入（xargs），无法校验，已阻断。`) };
      return { decision: this.checkFileOps(name, args, cwd) };
    }
    if (name === 'curl') {
      const why = localCurlDenied(args.map((w) => w.text));
      return { decision: why ? deny('bash', `${why}。`) : ok };
    }
    if (name in IMPL_FORBIDDEN) return { decision: deny('bash', `禁止使用 ${name}：${IMPL_FORBIDDEN[name]}。`) };
    if ((name === 'sed' || name === 'gsed') && args.some((w) => /^-[^-]*i/.test(w.text) || w.text.startsWith('--in-place'))) {
      return { decision: deny('bash', '禁止 sed -i 原地修改，请用 edit 工具。') };
    }
    if (name === 'perl' && args.some((w) => /^-[^-]*i/.test(w.text))) return { decision: deny('bash', '禁止 perl -i 原地修改，请用 edit 工具。') };
    if (name === 'git') return { decision: this.checkGitImpl(args) };
    if (name === 'find') {
      const f = this.checkFind(args, cwd, depth);
      if (!f.allow) return { decision: f };
    }
    return { decision: ok };
  }

  private checkRedirects(cmd: SimpleCommand, cwd: string): GuardDecision {
    for (const r of cmd.redirects) {
      if (r.fdDup || r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue;
      const t = r.target;
      if (INPUT_OPS.has(r.op)) {
        const s = this.sensitiveWord(t, cwd);
        if (!s.allow) return s;
        if (r.op !== '<>') continue;
      }
      if (!OUTPUT_OPS.has(r.op)) continue;
      if (t.dynamic || t.glob) return deny('bash', `重定向目标 ${t.text} 含变量或通配，无法校验，已阻断`);
      const target = t.tilde ? path.join(this.ev.home, t.text.slice(1)) : t.text;
      if (DEV_FILES.has(target) || /^\/dev\/fd\/\d+$/.test(target)) continue;
      if (this.readonly) return deny('bash', `只读角色不能重定向输出到文件（${t.text}）。${this.ev.hint()}`);
      const a = this.ev.classify(realpathDeep(path.resolve(cwd, target)));
      if (a.area === 'main') return deny('bash', `不能写主工作区（${a.rel}）。${this.ev.hint()}`);
      if (a.area === 'workspace' && isProtectedNocase(a.rel)) {
        return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读。`);
      }
    }
    return ok;
  }

  private checkFileOps(name: string, args: Word[], cwd: string): GuardDecision {
    const targets = args.filter((w) => !w.text.startsWith('-') || w.dynamic);
    if (!targets.length) return deny('bash', `${name} 缺少文件参数，无法校验，已阻断。`);
    // cp 的源文件只读（已做敏感检查），只校验目标；其余命令校验全部路径
    const checked = name === 'cp' ? targets.slice(-1) : targets;
    const scratchHint = this.ev.scratch ? `临时文件请放在临时目录 ${this.ev.scratch}。` : '';
    for (const w of checked) {
      if (w.dynamic || w.glob) return deny('bash', `${name} 的参数 ${w.text} 含变量或通配，无法校验，已阻断。`);
      const a = this.ev.classify(realpathDeep(path.resolve(cwd, w.tilde ? path.join(this.ev.home, w.text.slice(1)) : w.text)));
      if (a.area === 'scratch') continue;
      if (a.area !== 'workspace') return deny('bash', `${name} 只能作用于临时目录或本任务 writes 内的文件，${w.text} 不在其中。${scratchHint}`);
      const writes = this.ev.effectiveWrites();
      // 未被 git 跟踪的文件（之前运行留下的临时文件）可以删除：删除它们不会改动仓库内容
      if ((name === 'rm' || name === 'rmdir') && a.rel !== '.' && untracked(this.ev.ws, a.rel)) continue;
      if (!matchesAny(a.rel, writes) || !matchesAny(a.rel, this.ev.role.writes)) {
        return deny('bash', `${name} 只能作用于本任务 writes 内的文件（${writes.join(', ') || '无'}），${a.rel} 不在其中。${scratchHint}`);
      }
      if (isProtectedNocase(a.rel)) return deny('protected', `${a.rel} 是受保护路径，对所有 agent 只读。`);
    }
    return ok;
  }

  private checkCd(args: Word[], cwd: string): { decision: GuardDecision; cwd?: string } {
    const target = args.find((w) => !w.text.startsWith('-') || w.text === '-');
    if (!target || target.text === '-' || target.tilde) {
      return { decision: deny('bash', '禁止切到 worktree 之外（cd 无参数、cd -、cd ~）。') };
    }
    if (target.dynamic) return { decision: deny('bash', `cd 目标 ${target.text} 含变量，无法校验`) };
    const abs = realpathDeep(path.resolve(cwd, target.text));
    const area = this.ev.classify(abs).area;
    if (area !== 'workspace' && !(area === 'scratch' && !this.readonly)) {
      return { decision: deny('bash', `禁止切到 worktree 之外：${target.text}。${this.ev.scratch && !this.readonly ? `临时实验请在临时目录 ${this.ev.scratch} 中进行。` : ''}`) };
    }
    return { decision: ok, cwd: abs };
  }

  private checkReadonly(name: string, args: Word[]): GuardDecision {
    const no = (why: string) => deny('bash', `只读角色不能执行该命令（${why}）。${this.ev.hint()}`);
    if (!READONLY_COMMANDS.has(name)) return no(name);
    const flags = args.map((w) => w.text);
    const positional = flags.filter((f) => !f.startsWith('-'));
    if (name === 'find' && flags.some((f) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(f))) return no(`find ${flags.find((f) => /^-(exec|execdir|ok|okdir|delete|fp|fl)/.test(f))}`);
    if (name === 'sort' && flags.some((f) => f === '-o' || f.startsWith('--output') || /^-[a-z]*o/.test(f))) return no('sort -o');
    if (name === 'tree' && flags.some((f) => f === '-o')) return no('tree -o');
    if ((name === 'uniq' || name === 'xxd') && positional.length >= 2) return no(`${name} 输出到文件`);
    if (name === 'date' && flags.some((f) => f === '-s' || f.startsWith('--set'))) return no('date -s');
    if (name === 'git') {
      const g = parseGit(args);
      if (g.globals.length) return no(`git ${g.globals[0]}`);
      if (!g.sub || !GIT_READONLY.has(g.sub)) return no(`git ${g.sub ?? ''}`);
      if (g.rest.some((w) => w.text.startsWith('--output') || w.text === '-o' && g.sub !== 'log')) return no('git --output');
      if (g.sub === 'branch' && g.rest.some((w) => !['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'].includes(w.text))) {
        return no('git branch 只能列出分支');
      }
    }
    return ok;
  }

  private checkGitImpl(args: Word[]): GuardDecision {
    const g = parseGit(args);
    if (g.globals.length) return deny('bash', `禁止使用 git ${g.globals[0]} 操作其他仓库或工作区。`);
    if (!g.sub) return ok;
    const rest = g.rest.map((w) => w.text);
    const why = GIT_IMPL_FORBIDDEN[g.sub];
    if (why) return deny('bash', `禁止 git ${g.sub}（${why}）。`);
    const dd = rest.indexOf('--');
    const beforeDd = dd >= 0 ? rest.slice(0, dd) : rest;
    switch (g.sub) {
      case 'reset': {
        const okArgs = beforeDd.every((a) => a === '-q' || a === '--quiet' || (dd >= 0 && a === 'HEAD'));
        if (!okArgs) return deny('bash', '禁止 git reset 改写历史；取消暂存请用 git reset -- <文件>。');
        return ok;
      }
      case 'commit':
        if (rest.some((a) => a === '--amend' || a.startsWith('--fixup') || a.startsWith('--squash'))) return deny('bash', '禁止 git commit --amend 等改写历史的操作。');
        return ok;
      case 'checkout': {
        // 只允许 git checkout [<提交>] -- <文件>：按提交恢复文件，不会切换分支
        const positional = beforeDd.filter((a) => a !== '-q' && a !== '--quiet');
        if (dd < 0 || positional.length > 1 || positional.some((a) => a.startsWith('-'))) {
          return deny('bash', '禁止 git checkout 切换分支；恢复文件请用 git checkout [<提交>] -- <文件>。');
        }
        return ok;
      }
      case 'branch':
        if (rest.some((a) => !['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'].includes(a))) {
          return deny('bash', '禁止创建、删除、重命名分支；任务分支由引擎管理。');
        }
        return ok;
      case 'config':
        if (!rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a.startsWith('--get'))) {
          return deny('bash', '禁止修改 git 配置（worktree 与主仓库共享配置）。');
        }
        return ok;
      default:
        return ok;
    }
  }

  private checkFind(args: Word[], cwd: string, depth: number): GuardDecision {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!.text;
      if (a === '-delete') return deny('bash', '禁止 find -delete。');
      if (/^-(fprint|fprint0|fprintf|fls)$/.test(a)) {
        const t = args[k + 1];
        if (!t) continue;
        const area = this.ev.classify(realpathDeep(path.resolve(cwd, t.text)));
        if (t.dynamic || area.area === 'main' || (area.area === 'workspace' && isProtectedNocase(area.rel))) {
          return deny('bash', `find ${a} 的目标不允许：${t.text}`);
        }
      }
      if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
        const end = args.findIndex((w, j) => j > k && (w.text === ';' || w.text === '+'));
        const inner = args.slice(k + 1, end < 0 ? undefined : end);
        const r = this.checkCommand({ assignments: [], words: inner, redirects: [], nested: true }, cwd, depth + 1);
        if (!r.decision.allow) return r.decision;
      }
    }
    return ok;
  }

  private sensitiveWord(w: Word, cwd: string): GuardDecision {
    if (w.dynamic) return ok;
    let text = w.text;
    const eq = text.startsWith('-') ? text.indexOf('=') : -1;
    if (text.startsWith('-')) {
      if (eq < 0) return ok;
      text = text.slice(eq + 1);
    }
    if (!text) return ok;
    if (w.tilde) text = path.join(this.ev.home, text.slice(1));
    if (w.glob) {
      return sensitiveGlob(text) ? deny('sensitive', `禁止读取敏感文件（${w.text}）。`) : ok;
    }
    return this.ev.checkSensitive(text, cwd);
  }
}

function stripWrapper(name: string, rest: Word[]): Word[] {
  let k = 0;
  const skipOpts = (withArg: Set<string>) => {
    while (k < rest.length && rest[k]!.text.startsWith('-')) {
      const t = rest[k]!.text;
      k += withArg.has(t) ? 2 : 1;
      if (t === '--') break;
    }
  };
  switch (name) {
    case 'env':
      skipOpts(new Set(['-u', '-C', '-S']));
      while (k < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[k]!.text)) k++;
      break;
    case 'sudo': skipOpts(new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'])); break;
    case 'nice': skipOpts(new Set(['-n'])); break;
    case 'timeout': skipOpts(new Set(['-s', '-k', '--signal', '--kill-after'])); k++; break;
    case 'stdbuf': skipOpts(new Set(['-i', '-o', '-e'])); break;
    case 'xargs': skipOpts(new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-i'])); break;
    default: skipOpts(new Set());
  }
  return rest.slice(k);
}

function parseGit(args: Word[]): { globals: string[]; sub: string | null; rest: Word[] } {
  const globals: string[] = [];
  let k = 0;
  while (k < args.length && args[k]!.text.startsWith('-')) {
    const t = args[k]!.text;
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { globals.push(t); k += 2; continue; }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) globals.push(t.split('=')[0]!);
    if (t === '-c') { k += 2; continue; }
    k++;
  }
  return { globals, sub: args[k]?.text ?? null, rest: args.slice(k + 1) };
}

function extractPaths(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}

function isProtectedNocase(rel: string): boolean {
  return isProtected(rel.toLowerCase());
}

function isSensitiveRel(rel: string): boolean {
  const segs = rel.toLowerCase().split('/');
  const baseName = segs.at(-1) ?? '';
  return baseName.startsWith('.env') || baseName.endsWith('.pem') || segs.slice(0, -1).includes('secrets') || baseName === 'secrets';
}

/** 文件名模式是否可能匹配敏感文件。按 shell 语义，未以 . 开头的模式不匹配点文件。 */
function sensitiveGlob(pattern: string): boolean {
  const segs = pattern.toLowerCase().split('/').filter(Boolean);
  const last = segs.at(-1) ?? '';
  if (segs.some((s) => s.includes('secret'))) return true;
  if (last.startsWith('.') && globsOverlap(last, '.env*')) return true;
  if (last === '*' || last === '**') return false;
  // 如 *.pem、*.p?m：按非点文件语义匹配
  return minimatch('key.pem', last);
}

/** 把只引用了已知字面量变量的词代入为静态文本；含命令替换、算术展开或未知变量的保持动态 */
function substituteVars(cmd: SimpleCommand, vars: ReadonlyMap<string, string>): SimpleCommand {
  if (!vars.size) return cmd;
  const sub = (w: Word): Word => {
    if (!w.dynamic || /\$\(|`/.test(w.text)) return w;
    let unknown = false;
    const text = w.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
      const v = vars.get((a ?? b)!);
      if (v === undefined) { unknown = true; return _m; }
      return v;
    });
    return unknown || text.includes('$') ? w : { ...w, text, dynamic: false };
  };
  return { ...cmd, words: cmd.words.map(sub), redirects: cmd.redirects.map((r) => ({ ...r, target: sub(r.target) })), assignments: cmd.assignments.map(sub) };
}

/** 路径（文件或目录）在 worktree 中没有任何被 git 跟踪的文件 */
function untracked(ws: string, rel: string): boolean {
  try {
    return execFileSync('git', ['ls-files', '--', rel], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '';
  } catch {
    return false;
  }
}

function within(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** 解析最近的已存在祖先的真实路径（处理符号链接与大小写），再拼回不存在的部分。 */
function realpathDeep(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSafe(cur), ...tail);
}

export function checkToolCall(call: ToolCall, ctx: GuardContext): GuardDecision {
  return new Evaluator(ctx).run(call);
}

export interface ViolationSink {
  recordViolation(v: {
    flow: string | null; task: string | null; run: string; role: string; tool: string; rule: string; reason: string; detail?: string;
  }, maxPerRun: number): Promise<{ count: number; terminate: boolean; blocked: boolean }>;
}

export interface RunRef { flow: string | null; task: string | null; run: string }

export type EnforceResult =
  | { allow: true }
  | { allow: false; reason: string; rule: GuardRule; count: number; terminate: boolean };

/** 判定并在阻断时记录 violation（第 14 节第 6 条）。由 pi-adapter 的工具调用钩子调用。 */
export async function enforceToolCall(call: ToolCall, ctx: GuardContext, sink: ViolationSink, run: RunRef): Promise<EnforceResult> {
  const d = checkToolCall(call, ctx);
  if (d.allow) return d;
  const max = ctx.config.limits.max_violations_per_run;
  const command = call.toolName === 'bash' && typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  const detail = command ? command.slice(0, 200) : typeof call.input['path'] === 'string' ? call.input['path'] : undefined;
  const r = await sink.recordViolation({ ...run, role: ctx.role, tool: call.toolName, rule: d.rule, reason: d.reason,
    ...(detail ? { detail } : {}) }, max);
  const tail = r.terminate
    ? `\n违规次数已达上限 ${max}，本次运行将被终止，任务转为 blocked，等待用户处理。`
    : `\n（违规 ${r.count}/${max}，达到上限将终止本次运行）`;
  return { allow: false, rule: d.rule, reason: d.reason + tail, count: r.count, terminate: r.terminate };
}
