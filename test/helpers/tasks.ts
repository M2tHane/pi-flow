import type { TaskFile, Dependency, TaskKind } from '../../src/core/schemas.ts';

export function mkTask(id: string, over: Partial<TaskFile> & { deps?: Dependency[] } = {}): TaskFile {
  const { deps, ...rest } = over;
  return {
    id, stage: 'S3', kind: 'impl' as TaskKind, title: `任务 ${id}`, role: 'backend-engineer', scopes: ['backend'],
    depends_on: deps ?? [], inputs: [], writes: [`src/server/${id.toLowerCase()}/**`], acceptance: ['可验证'],
    verify: ['test'], status: 'pending', attempts: 0, violations: 0, lease_expirations: 0, lease: null,
    impl_run: null, branch: null, worktree: null, base_sha: null, blocked_reason: null, last_failure: null,
    created_by: 'architect', version: 1, ...rest,
  };
}
export const hard = (task: string, reason = '需要其产物'): Dependency => ({ task, type: 'hard', reason });
export const soft = (task: string): Dependency => ({ task, type: 'soft' });
