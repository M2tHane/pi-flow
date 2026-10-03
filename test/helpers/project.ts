// 测试项目夹具：临时 git 仓库 + workflow.yaml + 规则 + 已初始化的 .flow/ + 一个 build 流程与集成分支。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../../src/core/state-store.ts';
import { parseConfig, type FlowConfig } from '../../src/core/config.ts';
import { ensureIntegrationBranch, worktreesRoot } from '../../src/core/worktree.ts';
import type { TaskInput } from '../../src/core/state-store.ts';
import { tmpRepo } from './repo.ts';
import { TEST_YAML } from './config.ts';

export const PROJECT_YAML = TEST_YAML
  .replace(/commands:[\s\S]*?\nlimits:/, `commands:
  install:   "true"
  typecheck: "true"
  lint:      "true"
  test:      "test -f src/server/t-001/a.ts && ! grep -q FAIL src/server/t-001/a.ts"
  test_affected: "true {files}"
  e2e:       "true"
limits:`);

/** 关闭逐任务审查（模板默认）：提交后直接进入合并队列，合并时跑全量 typecheck、lint、test */
export const DIRECT_YAML = PROJECT_YAML.replace(/^  per_task: true$/m, '  per_task: false');
/** 模板默认的新流程：不逐任务审查，阶段末审查一次 */
export const STAGE_REVIEW_YAML = DIRECT_YAML.replace(/^  stage_end: false$/m, '  stage_end: true');

export interface Project {
  dir: string;
  git: (...a: string[]) => string;
  store: StateStore;
  config: FlowConfig;
  flowId: string;
  cleanup: () => void;
}

export async function setupProject(opts: { yaml?: string; tasks?: TaskInput[]; now?: () => Date; files?: Record<string, string> } = {}): Promise<Project> {
  const repo = tmpRepo();
  const yaml = opts.yaml ?? PROJECT_YAML;
  writeFileSync(path.join(repo.dir, 'workflow.yaml'), yaml);
  mkdirSync(path.join(repo.dir, 'rules'));
  writeFileSync(path.join(repo.dir, 'rules/global.md'), '- 完成定义：verify 全绿');
  writeFileSync(path.join(repo.dir, 'rules/backend.md'), '- handler 内不写业务逻辑');
  writeFileSync(path.join(repo.dir, 'README.md'), 'demo');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
    writeFileSync(path.join(repo.dir, rel), content);
  }
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const config = parseConfig(yaml);
  const store = await StateStore.init(repo.dir, { ...(opts.now ? { now: opts.now } : {}), limits: config.limits });
  const base = repo.git('rev-parse', 'HEAD');
  const flow = await store.createFlow({ mode: 'build', title: '演示', stages: ['S3'], base_sha: base });
  ensureIntegrationBranch(repo.dir, flow.integration_branch, base);
  if (opts.tasks?.length) await store.addTasks(flow.id, opts.tasks, 'architect');
  const cleanup = () => { rmSync(worktreesRoot(repo.dir), { recursive: true, force: true }); repo.cleanup(); };
  return { dir: repo.dir, git: repo.git, store, config, flowId: flow.id, cleanup };
}
