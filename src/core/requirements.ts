// 需求讨论（D0）：主会话逐轮追问用户，结论经 flow_requirements 提交。程序把需求说明提交到集成分支（不经过工作区），
// 再交给阶段闸门与用户审批；用户打回时主会话带着意见继续追问。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { PROTOTYPE_STAGE, requirementsFile } from '../modes/plan.ts';

export const REQUIREMENTS_STAGE = 'D0';
export const REQUIREMENTS_MAX = 60_000;

export class RequirementsError extends Error {}

/** 需求讨论时注入主会话的技能 */
export const DISCUSSION_SKILLS = ['grilling', 'write-requirements'];

/** 当前处在需求讨论中（D0 进行中、还没提交需求说明）时返回要注入主会话的技能正文，否则返回空串 */
export function discussionSkills(store: StateStore, skillsDir: string): string {
  const id = store.readState().active_flow;
  if (!id) return '';
  const f = store.readFlow(id);
  if (f.mode === 'fix' || f.stage !== REQUIREMENTS_STAGE || f.stage_status !== 'active' || f.requirements?.submitted) return '';
  return DISCUSSION_SKILLS.map((n) => {
    const file = path.join(skillsDir, n, 'SKILL.md');
    return existsSync(file) ? `## 技能 ${n}\n\n${readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()}` : '';
  }).filter(Boolean).join('\n\n');
}

/** 把一个文件直接提交到分支上（独立索引，update-ref 带旧值）；内容没变时不提交，返回 null */
export function commitFileToBranch(root: string, branch: string, rel: string, content: string, message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const parent = git(root, ['rev-parse', ref]).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-req-'));
  try {
    const file = path.join(dir, 'content');
    writeFileSync(file, content);
    const blob = git(root, ['hash-object', '-w', '--path', rel, file]).trim();
    if (gitOk(root, ['cat-file', '-e', `${parent}:${rel}`]) && git(root, ['rev-parse', `${parent}:${rel}`]).trim() === blob) return null;
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(root, ['read-tree', parent], { env });
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { env });
    const tree = git(root, ['write-tree'], { env }).trim();
    const sha = git(root, ['commit-tree', tree, '-p', parent, '-m', message], { engineIdentity: true }).trim();
    git(root, ['update-ref', ref, sha, parent]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 提交需求说明：写到集成分支、记下是否需要原型阶段；之后由引擎执行阶段闸门（等用户审批） */
export async function submitRequirements(root: string, store: StateStore, flowId: string, content: string, prototype: boolean, actor: string): Promise<{ path: string; sha: string | null }> {
  const flow = store.readFlow(flowId);
  if (flow.mode === 'fix') throw new RequirementsError('修复流程没有需求讨论阶段。');
  if (flow.stage !== REQUIREMENTS_STAGE) throw new RequirementsError(`当前是阶段 ${flow.stage}，需求讨论（${REQUIREMENTS_STAGE}）已结束；要改需求请用户 /flow-reject 或用 flow_replan。`);
  if (flow.stage_status !== 'active') throw new RequirementsError(flow.stage_status === 'awaiting_human' ? '需求说明已提交，等待用户审批（/flow-approve 或 /flow-reject "<意见>"）。' : `阶段 ${flow.stage} 当前是 ${flow.stage_status}，不能提交需求说明。`);
  const text = content.trim();
  if (!text) throw new RequirementsError('需求说明不能为空。');
  if (text.length > REQUIREMENTS_MAX) throw new RequirementsError(`需求说明超过 ${REQUIREMENTS_MAX} 字，请精简。`);
  const rel = flow.requirements?.path ?? requirementsFile(flow.mode, flow.title);
  const sha = commitFileToBranch(root, flow.integration_branch, rel, `${text}\n`, `pi-flow: ${flowId} 需求说明${(flow.requirements?.rounds ?? 0) ? `（第 ${flow.requirements!.rounds + 1} 版）` : ''}`);
  if (flow.stages.includes(PROTOTYPE_STAGE)) {
    const skip = (flow.skip_stages ?? []).filter((x) => x !== PROTOTYPE_STAGE);
    await store.setSkipStages(flowId, prototype ? skip : [...skip, PROTOTYPE_STAGE], actor, prototype ? '需要原型阶段' : '不需要原型阶段（没有界面）');
  }
  await store.setRequirements(flowId, { submitted: true, rounds: flow.requirements?.rounds ?? 0, path: rel }, actor, `提交需求说明 ${rel}`);
  return { path: rel, sha };
}

/** 用户打回或闸门未通过：回到讨论，带上意见 */
export async function reopenRequirements(store: StateStore, flowId: string, feedback: string, actor: string): Promise<void> {
  const r = store.readFlow(flowId).requirements;
  await store.setRequirements(flowId, { submitted: false, rounds: (r?.rounds ?? 0) + 1, ...(r?.path ? { path: r.path } : {}), feedback }, actor, '需求说明需要修改');
}

/** 需求说明是否已在集成分支上（闸门检查） */
export function requirementsMissing(root: string, branch: string, rel: string | undefined): string | null {
  if (!rel) return '需求讨论还没有提交需求说明（主会话用 flow_requirements 提交）';
  return gitOk(root, ['cat-file', '-e', `${branch}:${rel}`]) ? null : `集成分支上没有需求说明 ${rel}`;
}
