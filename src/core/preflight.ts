// 前置条件检查：git、node、仓库、workflow.yaml、规则文件、角色模型；Pi 版本、插件与其背后的程序（dependencies.ts）。
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, type FlowConfig } from './config.ts';
import { resolveRoleModel } from './role-settings.ts';
import type { RoleSettingsFile } from './schemas.ts';
import { gitOk } from './git.ts';
import { checkDependencies, type DependencyDeps } from './dependencies.ts';

export interface PreflightItem { level: 'ok' | 'warn' | 'error'; item: string; detail: string }

export interface PreflightDeps {
  root: string;
  roleSettings?: RoleSettingsFile;
  /** 可用模型（provider/id，小写比较）；不提供则不检查可用性 */
  availableModels?: string[];
  config?: FlowConfig;
  /** 当前 Pi 版本（主会话中由 pi-adapter 提供） */
  piVersion?: string;
  /** Pi 包的安装位置（项目级优先），用于检查插件 */
  packageRoots?: string[];
  probe?: DependencyDeps['probe'];
}

const ver = (s: string) => (s.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const atLeast = (v: number[], min: number[]) => (v[0]! > min[0]!) || (v[0] === min[0] && v[1]! >= min[1]!);

function cmd(bin: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function preflight(d: PreflightDeps): PreflightItem[] {
  const out: PreflightItem[] = [];
  const push = (level: PreflightItem['level'], item: string, detail: string) => out.push({ level, item, detail });

  const gitV = cmd('git', ['--version']);
  if (!gitV) push('error', 'git', '未安装 git');
  else if (!atLeast(ver(gitV), [2, 30])) push('error', 'git', `${gitV}，需要 2.30 以上（worktree 支持）`);
  else push('ok', 'git', gitV);

  const nodeV = process.versions.node;
  push(atLeast(ver(nodeV), [22, 0]) ? 'ok' : 'error', 'node', `v${nodeV}${atLeast(ver(nodeV), [22, 0]) ? '' : '，需要 22 以上'}`);

  if (!gitOk(d.root, ['rev-parse', '--git-dir'])) {
    push('error', '仓库', `${d.root} 不是 git 仓库，请先 git init`);
    return out;
  }
  push(gitOk(d.root, ['rev-parse', '--verify', 'HEAD']) ? 'ok' : 'warn', '提交', gitOk(d.root, ['rev-parse', '--verify', 'HEAD']) ? '已有提交' : '仓库还没有提交，/flow init 会做初始提交');

  let config = d.config;
  const wf = path.join(d.root, 'workflow.yaml');
  if (!config) {
    if (!existsSync(wf)) {
      push('warn', 'workflow.yaml', '不存在，执行 /flow init 生成');
    } else {
      try {
        config = loadConfig(wf);
        push('ok', 'workflow.yaml', '校验通过');
        for (const w of config.warnings) push('warn', 'workflow.yaml', w);
      } catch (e) {
        push('error', 'workflow.yaml', (e as Error).message);
      }
    }
  }
  if (config) {
    const mainBranch = config.raw.main_branch;
    if (gitOk(d.root, ['rev-parse', '--verify', 'HEAD'])) {
      push(gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${mainBranch}`]) ? 'ok' : 'error', '主分支', `${mainBranch}${gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${mainBranch}`]) ? '' : ' 不存在，请修改 workflow.yaml 的 main_branch'}`);
    }
    const rules = new Set(['rules/global.md', ...Object.values(config.raw.scopes).flatMap((s) => s.rules ?? [])]);
    const missing = [...rules].filter((r) => !existsSync(path.join(d.root, r)));
    push(missing.length ? 'warn' : 'ok', '规则文件', missing.length ? `缺少 ${missing.join('、')}（执行 /flow init 补齐）` : `${rules.size} 个`);
    if (d.roleSettings) {
      const avail = d.availableModels?.map((m) => m.toLowerCase());
      const problems: string[] = [];
      for (const role of Object.keys(config.roles)) {
        const r = resolveRoleModel(config, d.roleSettings, role);
        if (!r.model) problems.push(`${role} 未设置模型`);
        else if (avail && !avail.includes(r.model.toLowerCase())) problems.push(`${role} 的模型 ${r.model} 当前不可用`);
      }
      push(problems.length ? 'warn' : 'ok', '角色模型', problems.length ? `${problems.join('；')}。执行 /flow-config 设置` : '全部角色已设置可用模型');
    }
  }

  const deps = checkDependencies({ ...(config ? { config } : {}), ...(d.piVersion ? { piVersion: d.piVersion } : {}),
    ...(d.packageRoots ? { packageRoots: d.packageRoots } : {}), ...(d.probe ? { probe: d.probe } : {}) });
  for (const i of deps) {
    if (i.item === 'codegraph' && i.level === 'ok' && !existsSync(path.join(d.root, '.codegraph'))) {
      push('warn', 'codegraph', `${i.detail} 已安装但项目未索引，执行 codegraph init -i`);
    } else {
      push(i.level, i.item, i.item === 'codegraph' && i.level === 'ok' ? `${i.detail}，已索引` : i.detail);
    }
  }
  return out;
}

export function formatPreflight(items: PreflightItem[]): string {
  const mark = { ok: '✓', warn: '!', error: '✗' } as const;
  return items.map((i) => `${mark[i.level]} ${i.item}：${i.detail}`).join('\n');
}
