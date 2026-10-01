// 子进程加载的第三方插件：按角色用到的工具组，找到已安装的 Pi 包并用 -e 加载（在 pi-flow 的 guard 扩展之前）。
// 已核实：-e 可以指向包根目录（按包规则加载 pi.extensions）；pi-web-access 的工具注册后需 setActiveTools 激活（subagent 扩展会做）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../core/config.ts';

/** 工具组 → 提供这些工具的 Pi 包 */
export const GROUP_PACKAGES: Record<string, string> = {
  serena_read: '@bacnh85/pi-serena',
  serena_edit: '@bacnh85/pi-serena',
  codegraph: '@vndv/pi-codegraph',
  web: 'pi-web-access',
};

export function packageRoots(projectRoot: string, agentDir: string): string[] {
  return [path.join(projectRoot, '.pi', 'npm', 'node_modules'), path.join(agentDir, 'npm', 'node_modules')];
}

/** 角色需要的插件包根目录（去重，未安装的跳过）；同时返回缺失的包 */
export function pluginExtensionsFor(config: FlowConfig, role: string, roots: string[]): { paths: string[]; missing: string[] } {
  const r = config.role(role);
  const pkgs = new Set<string>();
  for (const [group, tools] of Object.entries(config.raw.tool_groups)) {
    const pkg = GROUP_PACKAGES[group];
    if (pkg && tools.some((t) => r.tools.has(t))) pkgs.add(pkg);
  }
  const paths: string[] = [];
  const missing: string[] = [];
  for (const pkg of pkgs) {
    const hit = roots.map((root) => path.join(root, ...pkg.split('/'))).find((p) => existsSync(path.join(p, 'package.json')));
    if (hit) paths.push(hit);
    else missing.push(pkg);
  }
  return { paths, missing };
}
