// 依赖检查：Pi 版本、角色用到的 Pi 插件、插件背后的程序（Serena、codegraph 命令行）。
// 验证过的版本集中登记在这里；升级依赖并验证后只改这张表。
// 插件版本不在验证范围时只提醒：pi-flow 按工具白名单启用工具，guard 对取不到路径的写操作一律阻断，
// 所以插件改了工具名或参数名时，相关工具会失效，但不会放宽安全检查。
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FlowConfig } from './config.ts';

export type Level = 'ok' | 'warn' | 'error';
export interface DependencyItem { level: Level; item: string; detail: string }

/** 版本区间 [min, below)；显示为 label */
export interface Tested { min: string; below: string; label: string }

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** Pi：低于 minimum 不能运行（codemode、--session-dir 等依赖 0.99）；tested 之外提示未经验证 */
export const PI_REQUIREMENT = { minimum: '0.99.0', tested: { min: '0.99.0', below: '2.0.0', label: '0.99.x – 1.x' } as Tested };

export interface PluginSpec {
  pkg: string;
  /** 提供哪些工具组的工具（workflow.yaml 的 tool_groups） */
  groups: string[];
  tested: Tested;
  install: string;
  links: string[];
  purpose: string;
}

export const PLUGINS: PluginSpec[] = [
  {
    pkg: '@bacnh85/pi-serena', groups: ['serena_read', 'serena_edit'], tested: { min: '0.9.20', below: '0.10.0', label: '0.9.x（已验证 0.9.20）' },
    install: 'pi install npm:@bacnh85/pi-serena',
    links: ['https://www.npmjs.com/package/@bacnh85/pi-serena', 'https://github.com/bacnh85/pi-extensions/tree/main/pi-serena'],
    purpose: '符号级读取与编辑',
  },
  {
    pkg: '@vndv/pi-codegraph', groups: ['codegraph'], tested: { min: '0.1.10', below: '0.2.0', label: '0.1.x（已验证 0.1.10）' },
    install: 'pi install npm:@vndv/pi-codegraph',
    links: ['https://www.npmjs.com/package/@vndv/pi-codegraph', 'https://github.com/vndv/pi-codegraph'],
    purpose: '调用关系与影响面分析',
  },
  {
    pkg: 'pi-web-access', groups: ['web'], tested: { min: '0.35.0', below: '0.36.0', label: '0.35.x（已验证 0.35.0）' },
    install: 'pi install npm:pi-web-access',
    links: ['https://www.npmjs.com/package/pi-web-access', 'https://github.com/nicobailon/pi-web-access'],
    purpose: '联网搜索与抓取（researcher）',
  },
  {
    pkg: '@tian.zuo/pi-ask-user', groups: ['ask'], tested: { min: '0.2.1', below: '0.3.0', label: '0.2.x（已验证 0.2.1）' },
    install: 'pi install npm:@tian.zuo/pi-ask-user',
    links: ['https://www.npmjs.com/package/@tian.zuo/pi-ask-user', 'https://github.com/TianZuo555/pi-extensions'],
    purpose: '选择题提问（讨论需求时，没有时改用文字提问）',
  },
];

export const SERENA = {
  tested: { min: '1.7.0', below: '2.0.0', label: '1.x（已验证 1.7.0）' } as Tested,
  install: 'uv tool install serena-agent（需要先装 uv：https://docs.astral.sh/uv/）',
  links: ['https://github.com/oraios/serena'],
};
export const CODEGRAPH_CLI = {
  tested: { min: '1.6.0', below: '2.0.0', label: '1.x（已验证 1.6.0）' } as Tested,
  install: 'npm i -g @colbymchenry/codegraph，然后在项目里执行 codegraph init -i',
  links: ['https://www.npmjs.com/package/@colbymchenry/codegraph'],
};

const parse = (v: string) => (v.match(/(\d+)\.(\d+)\.(\d+)/) ?? v.match(/(\d+)\.(\d+)()/) ?? []).slice(1, 4).map((x) => Number(x || 0));
/** a < b 返回负数 */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
export const inRange = (v: string, t: Tested) => compareVersions(v, t.min) >= 0 && compareVersions(v, t.below) < 0;

function runVersion(bin: string, args: string[]): string | null {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
    return out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** 已安装的 Pi 包版本：按 roots 顺序（项目级优先）找 package.json */
export function installedPackage(pkg: string, roots: readonly string[]): { dir: string; version: string } | null {
  for (const root of roots) {
    const file = path.join(root, ...pkg.split('/'), 'package.json');
    if (!existsSync(file)) continue;
    try {
      return { dir: path.dirname(file), version: String((JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0') };
    } catch {
      return { dir: path.dirname(file), version: '0.0.0' };
    }
  }
  return null;
}

/** pi-serena 查找 Serena Python 的位置（与其 worker.ts 一致）：SERENA_PYTHON、uv tool dir 下的 serena-agent */
export function serenaInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['SERENA_PYTHON'] && existsSync(env['SERENA_PYTHON'])) return true;
  const dirs: string[] = [];
  try { dirs.push(execFileSync('uv', ['tool', 'dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim()); } catch { /* 没有 uv */ }
  dirs.push(path.join(homedir(), '.local', 'share', 'uv', 'tools'));
  return dirs.some((d) => d && (existsSync(path.join(d, 'serena-agent', 'bin', 'python')) || existsSync(path.join(d, 'serena-agent', 'Scripts', 'python.exe'))));
}

/** 哪些角色用到了某个插件的工具组 */
export function rolesUsing(config: FlowConfig, groups: readonly string[]): string[] {
  const tools = new Set(groups.flatMap((g) => config.raw.tool_groups[g] ?? []));
  return Object.keys(config.roles).filter((r) => [...config.roles[r]!.tools].some((t) => tools.has(t)));
}

const linkText = (links: readonly string[]) => links.join(' ');

export interface DependencyDeps {
  config?: FlowConfig;
  /** 当前 Pi 的版本（主会话中由 pi-adapter 提供）；不提供则不检查 */
  piVersion?: string;
  /** Pi 包的安装位置（项目级优先）；不提供则不检查插件 */
  packageRoots?: string[];
  /** 测试用：替换命令与 Serena 检测 */
  probe?: { serena?: () => boolean; serenaVersion?: () => string | null; codegraphVersion?: () => string | null };
}

export function checkDependencies(d: DependencyDeps): DependencyItem[] {
  const out: DependencyItem[] = [];
  const push = (level: Level, item: string, detail: string) => out.push({ level, item, detail });

  if (d.piVersion) {
    const v = d.piVersion;
    if (compareVersions(v, PI_REQUIREMENT.minimum) < 0) {
      push('error', 'Pi', `${v}，需要 ${PI_REQUIREMENT.minimum} 以上。升级：npm install -g ${PI_PACKAGE}`);
    } else if (!inRange(v, PI_REQUIREMENT.tested)) {
      push('warn', 'Pi', `${v} 未经验证（已验证 ${PI_REQUIREMENT.tested.label}）。如遇问题，回退：npm install -g ${PI_PACKAGE}@1`);
    } else {
      push('ok', 'Pi', v);
    }
  }

  const config = d.config;
  if (config && d.packageRoots) {
    for (const p of PLUGINS) {
      const roles = rolesUsing(config, p.groups);
      if (!roles.length) continue;
      const hit = installedPackage(p.pkg, d.packageRoots);
      if (!hit) {
        push('warn', p.pkg, `未安装：${roles.join('、')} 的${p.purpose}工具不可用。安装：${p.install}（${linkText(p.links)}）`);
      } else if (!inRange(hit.version, p.tested)) {
        push('warn', p.pkg, `${hit.version} 未经验证（已验证 ${p.tested.label}）：工具名或参数若有变化，相关工具会失效（安全检查不会放宽）。可安装验证过的版本：${p.install}@${p.tested.min}`);
      } else {
        push('ok', p.pkg, hit.version);
      }
    }
  }

  if (config && rolesUsing(config, ['serena_read', 'serena_edit']).length) {
    const ok = (d.probe?.serena ?? serenaInstalled)();
    if (!ok) {
      push('warn', 'Serena', `未找到（pi-serena 需要它）。安装：${SERENA.install}（${linkText(SERENA.links)}）`);
    } else {
      const v = (d.probe?.serenaVersion ?? (() => runVersion('serena', ['--version'])))();
      if (v && !inRange(v, SERENA.tested)) push('warn', 'Serena', `${v} 未经验证（已验证 ${SERENA.tested.label}）`);
      else push('ok', 'Serena', v ?? '已安装');
    }
  }

  const needCodegraph = !config || rolesUsing(config, ['codegraph']).length > 0;
  if (needCodegraph) {
    const v = (d.probe?.codegraphVersion ?? (() => runVersion(process.env['PI_FLOW_CODEGRAPH_BIN'] ?? 'codegraph', ['--version'])))();
    if (!v) push('warn', 'codegraph', `未安装：合并后验证将运行全量测试，codegraph 工具不可用。安装：${CODEGRAPH_CLI.install}（${linkText(CODEGRAPH_CLI.links)}）`);
    else if (!inRange(v, CODEGRAPH_CLI.tested)) push('warn', 'codegraph', `${v} 未经验证（已验证 ${CODEGRAPH_CLI.tested.label}）`);
    else push('ok', 'codegraph', v);
  }
  return out;
}

/** 子进程启动时发现角色配置的工具没有注册（插件缺失或不兼容）时记录的事件原因 */
export const MISSING_TOOLS_REASON = '子进程缺少工具';
