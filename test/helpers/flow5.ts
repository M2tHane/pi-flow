// 第五轮新流程的测试夹具：真实模板（命令换成本地可跑的）、各角色的假模型、命令环境。
import path from 'node:path';
import type { Project } from './project.ts';
import type { makeEngine } from './engine.ts';
import { REAL_TEMPLATE_YAML } from './config.ts';
import type { CommandEnv } from '../../src/commands/flow.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';

/** 全量测试：仓库里有 BROKEN 文件时失败 */
export const FLOW5_YAML = REAL_TEMPLATE_YAML
  .replace(/commands:[\s\S]*?\nlimits:/, 'commands:\n  install: "true"\n  typecheck: "true"\n  lint: "true"\n  test: "test ! -e BROKEN"\nlimits:')
  .replace(/^  auto_dispatch: true .*$/m, '  auto_dispatch: false');
export const SETTINGS5: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['orchestrator', 'user-advocate', 'dev-advocate', 'analyst', 'designer', 'architect', 'implementer', 'acceptor', 'researcher'].map((r) => [r, { model: 'fake/m' }])) };

export function cmdEnv(p: Project, engine: ReturnType<typeof makeEngine>['engine']): CommandEnv {
  return {
    root: p.dir, packageRoot: path.join(import.meta.dirname, '../..'), ui: null,
    engine: () => ({ store: p.store, engine, config: p.config }), store: () => p.store,
    roleSettings: () => SETTINGS5, availableModels: () => [], activateOrchestrator: () => {}, waitForIdle: true,
  };
}

