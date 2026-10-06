// 引擎测试夹具：fake-subagent 按角色与第几次派发选择脚本。
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Engine, type EngineDeps } from '../../src/core/dispatcher.ts';
import type { MergeHooks, MergeResult } from '../../src/core/merge-queue.ts';
import type { RoleSettingsFile } from '../../src/core/schemas.ts';
import { FakeLauncher, type FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import type { Project } from './project.ts';

/** 包内角色（agents/）加上测试夹具里只用于运行时机制测试的旧角色 */
export const AGENTS = [path.join(import.meta.dirname, '../../agents'), path.join(import.meta.dirname, '../fixtures/agents')].join(path.delimiter);
export const ALL_FAKE: RoleSettingsFile = { version: 1, roles: Object.fromEntries(
  ['backend-engineer', 'frontend-engineer', 'architect', 'test-engineer', 'implementer', 'acceptor'].map((r) => [r, { model: 'fake/model', thinking: 'low' as const }])) };

export type RoleScript = (role: string, nth: number, a: FakeAgent) => Promise<void>;

export function makeEngine(p: Project, scripts: RoleScript, settings = ALL_FAKE, mergeHooks?: MergeHooks, extra: Partial<EngineDeps> = {}) {
  const launcher = new FakeLauncher(p.store, p.config, (spec, nth) => (a) => scripts(spec.env['PI_FLOW_ROLE']!, nth, a));
  const errors: unknown[] = [];
  const merges: MergeResult[] = [];
  const engine = new Engine({
    root: p.dir, store: p.store, config: p.config, roleSettings: () => settings, launcher,
    packageAgentsDir: AGENTS, subagentExtension: '/dev/null/subagent.ts',
    onError: (e) => errors.push(e), onMerge: (r) => merges.push(r), ...(mergeHooks ? { mergeHooks } : {}), ...extra,
  });
  return { engine, launcher, errors, merges };
}

/** 模拟他人直接向某分支提交（不切换主工作区） */
export function commitToBranch(root: string, branch: string, files: Record<string, string>, message: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-ext-'));
  rmSync(dir, { recursive: true });
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  git(root, 'worktree', 'add', '-q', dir, branch);
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=other', '-c', 'user.email=o@x', 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  } finally {
    git(root, 'worktree', 'remove', '--force', dir);
  }
}
