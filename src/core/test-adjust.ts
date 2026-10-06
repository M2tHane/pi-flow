// 适配已有测试（第四轮后续）：合并时跑全量测试，改了接口的模块会让别的模块已有的测试失败，
// 而有权改那些测试的任务往往排在后面。实施类任务因此可以修改基线上已有的测试文件（不限角色可写范围），
// 只能修改，不能新增或删除；改了哪些记在任务上与 handoff 里。
import type { FlowConfig } from './config.ts';
import type { TaskFile } from './schemas.ts';
import { git } from './git.ts';
import { matchesAny } from './paths.ts';

export const TEST_GLOBS = ['tests/**', 'test/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'] as const;

/** 本任务能否适配已有测试：testing.adjust_tests 未关闭、有可写范围的实施类任务（不含 merge-fix 与只读任务） */
export function testAdjustEnabled(config: FlowConfig, t: TaskFile): boolean {
  if (config.raw.testing?.adjust_tests === false) return false;
  if (t.kind === 'analysis' || t.kind === 'merge-fix' || t.kind === 'doc') return false;
  return config.role(t.role).writes.length > 0;
}

/** 基线上已有、在任务 writes 之外的测试文件 */
export function adjustableTests(worktree: string, base: string, writes: readonly string[]): string[] {
  return git(worktree, ['ls-tree', '-r', '--name-only', base]).split('\n')
    .filter((f) => f && matchesAny(f, TEST_GLOBS) && !matchesAny(f, writes));
}

/** 相对基线只修改过（不是新增、删除）的 writes 之外的已有测试文件 */
export function testAdjustments(worktree: string, base: string, writes: readonly string[]): string[] {
  return git(worktree, ['diff', '--name-status', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([st, f]) => st === 'M' && !!f && matchesAny(f, TEST_GLOBS) && !matchesAny(f, writes))
    .map(([, f]) => f!).sort();
}
