// 第五轮新增的 subagent 工具：flow_propose_modules（architect 提交模块清单）、flow_sync（实现者把集成分支合进自己的工作区）、
// flow_accept / flow_accept_confirm（验收者逐条提交结论）。纯业务实现，不依赖 Pi。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import type { ProposedTask, TaskFile } from '../core/schemas.ts';
import { validateDag, dagReport, formatDagReport } from '../core/dag.ts';
import { git, gitOk } from '../core/git.ts';
import { snapshot } from '../core/worktree.ts';
import { isProtected } from '../core/paths.ts';
import { DESIGN_DOC, EXECUTION_STAGE, PROPOSAL_STAGES, THEME_CSS } from '../modes/plan.ts';
import { recordAcceptance } from '../core/acceptance.ts';
import { findingLine, recordReview } from '../core/final-review.ts';
import { FlowToolError, checkRunOf, type ToolContext, type ToolResult } from './tool-common.ts';

const actor = (ctx: ToolContext) => `run:${ctx.env.run}`;

// —— flow_propose_modules ——

export const ModuleDef = Type.Object({
  id: Type.String({ pattern: '^M-[0-9]+$', description: '模块编号 M-1、M-2…（只在本次提交内使用，批准后由程序换成任务编号）' }),
  title: Type.String({ minLength: 1, maxLength: 200, description: '模块名与它负责的事，例如"知识库：文档上传、切分、检索与管理页面"' }),
  writes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 40, description: '模块的可写范围（目录 glob），前端、后端、测试都包括，例如 backend/app/kb/**、frontend/src/pages/kb/**、backend/tests/kb/**' }),
  shared: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: '要登记的公共文件（路由注册、菜单、迁移目录、文案等）：可以写，不算进模块之间的互斥' })),
  acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 30, description: '验收标准：只写能用代码测试或命令验证的（接口、服务函数、组件与逻辑的测试），独立验收者会逐条确认；界面效果、桌面应用与浏览器里的操作不写在这里，写进 manual_checks' }),
  manual_checks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20, description: '界面与软件层面的检查，由用户打开应用测试与验收（例如"桌面端发一句话能看到流式回复"、"表单校验提示正确"）：不派 agent 验证，模块验收通过后列给用户' })),
  size: Type.Optional(Type.Union([Type.Literal('S'), Type.Literal('M'), Type.Literal('L')], { description: '模块大小，决定每次运行的时间预算：S 小改动（一两个文件）、M 一般模块（默认）、L 大模块（跨前后端、很多文件）' })),
  inputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 30, description: '要先读的文件（需求说明、接口文档等；docs/modules.md、docs/glossary.md、AGENTS.md 会自动加上，原型页面与设计规范按 ui、ui_pages 自动加上）' })),
  ui: Type.Optional(Type.Boolean({ description: '模块有界面（页面、组件）：自动加上设计规范 DESIGN.md 与共用样式，并多一条由用户打开查看的检查"界面遵循设计规范"' })),
  ui_pages: Type.Optional(Type.Array(Type.String({ pattern: '^prototype/.+\\.html$' }), { maxItems: 20, description: '模块负责实现的原型页面（prototype/*.html）：自动加进输入，并多一条由用户打开查看的检查"界面按原型实现"；写了就隐含 ui' })),
  depends_on: Type.Optional(Type.Array(Type.Object({
    module: Type.String({ pattern: '^M-[0-9]+$' }),
    reason: Type.String({ minLength: 1, maxLength: 300, description: '为什么必须等它验收通过才能开工' }),
  }, { additionalProperties: false }), { maxItems: 20, description: '必须先完成（验收通过）的模块；互不依赖的模块会并行' })),
}, { additionalProperties: false });

export const ProposeModulesParams = Type.Object({
  modules: Type.Array(ModuleDef, { minItems: 1, maxItems: 50 }),
  assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 30, description: '需求没说清、你按默认方案处理的地方；用户批准时确认' })),
}, { additionalProperties: false });

/** 模块清单转成实施阶段的任务（临时编号 T-001 起，批准后重新编号） */
export function modulesToTasks(ctx: ToolContext, p: Static<typeof ProposeModulesParams>): { tasks: ProposedTask[]; errors: string[] } {
  const errors: string[] = [];
  const ids = new Map(p.modules.map((m, i) => [m.id, `T-${String(i + 1).padStart(3, '0')}`]));
  if (ids.size !== p.modules.length) errors.push('模块编号有重复');
  const verify = ['test'].filter((c) => ctx.config.commands[c]?.trim());
  // 界面模块：原型页面与设计规范交给实现者，验收时对照（文件以 architect 工作区里的为准）
  const wt = ctx.store.readTask(ctx.env.flow, ctx.env.task).worktree;
  const has = (f: string) => !!wt && existsSync(path.join(wt, f));
  const design = [DESIGN_DOC, THEME_CSS].filter(has);
  const tasks = p.modules.map((m): ProposedTask => {
    const pages = m.ui_pages ?? [];
    for (const pg of pages) if (!has(pg)) errors.push(`${m.id}：原型里没有 ${pg}`);
    const ui = !!m.ui || pages.length > 0;
    // 界面的测试与验收交给用户：agent 不启动桌面应用与浏览器，界面条目不派验收者，模块验收通过后列给用户打开查看
    const uiChecks = [
      ...(pages.length ? [`界面按原型 ${pages.join('、')} 实现：页面结构、交互与加载、空、错误、无权限四种状态和原型一致`] : []),
      ...(ui && design.length ? [`界面遵循 ${DESIGN_DOC}：颜色、字号、间距等用 ${THEME_CSS} 中的变量，不另写一套`] : []),
      ...(ui && !pages.length && !design.length ? ['打开界面看一遍：布局、交互与样式'] : []),
    ];
    const manual = [...(m.manual_checks ?? []), ...uiChecks];
    for (const w of [...m.writes, ...(m.shared ?? [])]) {
      if (w === '**' || w === '*' || w.startsWith('/') || w.split('/').includes('..')) errors.push(`${m.id}：可写范围 ${w} 不合法（要具体到模块的目录，不能是整个仓库或仓库外）`);
      else if (isProtected(w.replace(/\/\*\*$/, '/x'))) errors.push(`${m.id}：${w} 是受保护路径（.flow、.git、workflow.yaml、rules、.pi）`);
    }
    for (const d of m.depends_on ?? []) if (!ids.has(d.module)) errors.push(`${m.id}：依赖的模块 ${d.module} 不存在`);
    return {
      id: ids.get(m.id)!, stage: EXECUTION_STAGE, kind: 'impl', title: m.title, role: 'implementer', scopes: ['code'],
      depends_on: (m.depends_on ?? []).filter((d) => ids.has(d.module)).map((d) => ({ task: ids.get(d.module)!, type: 'hard' as const, reason: d.reason })),
      inputs: [...new Set([...(m.inputs ?? []), ...pages, ...(ui ? design : []), 'docs/modules.md', 'docs/glossary.md', 'AGENTS.md'])], writes: [...m.writes], acceptance: [...m.acceptance], verify,
      ...(m.shared?.length ? { shared: [...m.shared] } : {}), needs_acceptance: true,
      ...(m.size ? { size: m.size } : {}), ...(manual.length ? { manual_checks: manual } : {}),
    };
  });
  return { tasks, errors };
}

export async function flowProposeModules(ctx: ToolContext, p: Static<typeof ProposeModulesParams>): Promise<ToolResult> {
  const t = checkRunOf(ctx);
  if (!PROPOSAL_STAGES.has(t.stage)) throw new FlowToolError(`flow_propose_modules 只能在规划阶段（D2）使用，当前任务属于 ${t.stage}。`);
  const { tasks, errors } = modulesToTasks(ctx, p);
  const v = validateDag(tasks, ctx.config.dagCatalog());
  errors.push(...v.errors);
  if (errors.length) throw new FlowToolError(`模块清单校验失败，未保存：\n${errors.map((e) => `- ${e}`).join('\n')}\n建议：逐条修正后重新调用 flow_propose_modules。`);
  const report = dagReport(tasks, v.warnings);
  await ctx.store.saveProposal(ctx.env.flow, { stage: t.stage, run: ctx.env.run, created_at: (ctx.now?.() ?? new Date()).toISOString(), tasks, report,
    ...(p.assumptions?.length ? { assumptions: p.assumptions } : {}) }, actor(ctx));
  const order = p.modules.map((m) => `${m.id}→${tasks[p.modules.indexOf(m)]!.id} ${m.title}${m.depends_on?.length ? `（等 ${m.depends_on.map((d) => d.module).join('、')}）` : ''}`).join('\n');
  return { text: `模块清单已保存（用户批准规划阶段后生效，批准前可以重新提交覆盖）。\n${order}\n${formatDagReport(report)}`, details: { ...report } };
}

// —— flow_sync ——

export const SyncParams = Type.Object({}, { additionalProperties: false });

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** 把集成分支最新代码合进任务分支：没有冲突直接完成；有冲突时留下冲突标记，由实现者解决后再调用一次完成提交 */
export async function flowSync(ctx: ToolContext): Promise<ToolResult> {
  const t = checkRunOf(ctx);
  if (!t.worktree || !t.base_sha) throw new FlowToolError('任务没有工作区，无法同步。');
  if (t.kind === 'merge-fix') throw new FlowToolError('解决合并冲突的任务不需要同步。');
  const wt = t.worktree;
  const integ = ctx.store.readFlow(ctx.env.flow).integration_branch;
  const merging = gitOk(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merging) {
    const files = git(wt, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean)
      .concat(git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean));
    const marked = [...new Set(files)].filter((f) => { const p = path.join(wt, f); return existsSync(p) && CONFLICT_MARKER.test(readFileSync(p, 'utf8')); });
    if (marked.length) throw new FlowToolError(`这些文件还有冲突标记，解决后再调用 flow_sync：${marked.join('、')}`);
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '--no-edit', '--no-verify'], { engineIdentity: true });
    return finishSync(ctx, t, wt, integ, '冲突已解决，同步完成');
  }
  snapshot(wt, `[${ctx.env.flow}/${t.id}] 同步前的进度`);
  const head = git(wt, ['rev-parse', integ]).trim();
  if (gitOk(wt, ['merge-base', '--is-ancestor', head, 'HEAD'])) return { text: '工作区已经包含集成分支的最新代码，不需要同步。' };
  let ok = true;
  try { git(wt, ['merge', '--no-edit', '--no-ff', '--no-verify', head], { engineIdentity: true, allowFail: true }); } catch { ok = false; }
  if (!ok) {
    const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    if (!conflicts.length) { gitOk(wt, ['merge', '--abort']); throw new FlowToolError('合并失败但没有冲突文件，已放弃这次同步。'); }
    return { text: `同步时有冲突，冲突标记留在这些文件里：${conflicts.join('、')}\n逐个解决（保留双方需要的内容，删掉 <<<<<<< ======= >>>>>>> 标记），然后再调用一次 flow_sync 完成同步。` };
  }
  return finishSync(ctx, t, wt, integ, '同步完成');
}

async function finishSync(ctx: ToolContext, t: TaskFile, wt: string, integ: string, what: string): Promise<ToolResult> {
  // 之后的改动以合进来的集成分支提交为基线：提交时只检查自己的改动
  const base = git(wt, ['merge-base', 'HEAD', integ]).trim();
  await ctx.store.updateTask(ctx.env.flow, t.id, { base_sha: base }, { actor: actor(ctx), type: 'note', reason: `同步集成分支（${base.slice(0, 8)}）` });
  const stat = git(wt, ['diff', '--stat', `${t.base_sha}`, base]).trim().split('\n').at(-1) ?? '';
  return { text: `${what}：已合入集成分支 ${base.slice(0, 8)}${stat ? `（其他模块的改动：${stat.trim()}）` : ''}。跑一下相关测试，确认和别的模块的改动一起能工作。` };
}

// —— flow_accept / flow_accept_confirm ——

const ResultItem = Type.Object({
  id: Type.String({ pattern: '^A-[0-9]+$', description: '条目编号' }),
  passed: Type.Boolean({ description: '是否做到' }),
  evidence: Type.String({ minLength: 1, maxLength: 2000, description: '证据：运行的命令、请求与响应、看到的结果；未通过时写清差在哪' }),
  manual: Type.Optional(Type.Boolean({ description: '这一条只能打开应用看效果才能最终确认（你不能启动桌面应用或浏览器）：用测试与命令能查的都查过且没问题时 passed 填 true、manual 填 true，程序会交给用户自己查看；查到问题照常判未通过' })),
}, { additionalProperties: false });

export const AcceptParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 1000, description: '一段话总结验收情况' }),
  results: Type.Array(ResultItem, { minItems: 1, maxItems: 60, description: '每条验收标准一个结论，编号见任务说明' }),
}, { additionalProperties: false });
export const AcceptConfirmParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  results: Type.Array(ResultItem, { minItems: 1, maxItems: 60, description: '只回答待复查的条目，不能新增' }),
}, { additionalProperties: false });

async function submitAccept(ctx: ToolContext, p: Static<typeof AcceptParams>, kind: 'check' | 'confirm'): Promise<ToolResult> {
  const t = checkRunOf(ctx);
  if (!t.accept_of || t.accept_kind !== kind || t.status !== 'in_progress') {
    throw new FlowToolError(kind === 'check' ? 'flow_accept 只能在验收任务中使用。' : 'flow_accept_confirm 只能在复查任务中使用。');
  }
  const errs = await recordAcceptance(ctx.store, ctx.env.flow, t, p.results, p.summary, actor(ctx));
  if (errs.length) throw new FlowToolError(`结论未保存：\n${errs.map((e) => `- ${e}`).join('\n')}`);
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `${kind === 'check' ? '验收' : '复查'}结论：${p.summary}\n${p.results.map((r) => `- ${r.id} ${r.passed ? '通过' : '未通过'}${r.manual ? '（需要用户打开查看）' : ''}：${r.evidence}`).join('\n')}`, actor(ctx));
  // 验收是只读的：工作区里运行产生的文件随工作区一起丢弃，不检查改动
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: [] } });
  } catch (e) { throw new FlowToolError((e as Error).message); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), kind === 'check' ? '提交验收结论' : '提交复查结论');
  const failed = p.results.filter((r) => !r.passed).length;
  return { text: `已提交（${p.results.length - failed} 条通过，${failed} 条未通过）。你的工作已完成，请直接结束。` };
}

// —— flow_review_report（最终代码审查，可选） ——

export const ReviewReportParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 1000, description: '一段话总结代码质量与主要问题' }),
  findings: Type.Array(Type.Object({
    id: Type.String({ pattern: '^R-[0-9]+$', description: '编号 R-1、R-2……' }),
    level: Type.Union([Type.Literal('must'), Type.Literal('suggest')], { description: 'must：必须改（违反成文规范或明确的缺陷，会自动交给负责的模块修复）；suggest：建议（由用户挑选要不要修）' }),
    basis: Type.String({ minLength: 1, maxLength: 500, description: '依据：规范出处（文件 + 哪一条）或坏味道名称' }),
    files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20, description: '涉及的文件（仓库内相对路径，必须是这次改动里的文件）' }),
    location: Type.String({ maxLength: 500, description: '位置：函数名或行号范围' }),
    problem: Type.String({ minLength: 1, maxLength: 2000, description: '问题' }),
    expected: Type.String({ minLength: 1, maxLength: 2000, description: '期望怎么改' }),
  }, { additionalProperties: false }), { maxItems: 60, description: '全部问题；没有问题提交空列表' }),
}, { additionalProperties: false });

export async function flowReviewReport(ctx: ToolContext, p: Static<typeof ReviewReportParams>): Promise<ToolResult> {
  const t = checkRunOf(ctx);
  if (!t.final_review || t.status !== 'in_progress') throw new FlowToolError('flow_review_report 只能在最终代码审查任务中使用。');
  const errs = await recordReview(ctx.env.root, ctx.store, ctx.env.flow, t, p.findings, p.summary, actor(ctx));
  if (errs.length) throw new FlowToolError(`结论未保存：\n${errs.map((e) => `- ${e}`).join('\n')}`);
  await ctx.store.appendHandoff(ctx.env.flow, t.id, `审查结论：${p.summary}\n${p.findings.map((f) => `- ${findingLine(f)}`).join('\n')}`, actor(ctx));
  try {
    await ctx.store.transitionTask(ctx.env.flow, t.id, { to: 'done', trigger: 'report', actor: actor(ctx), facts: { token: ctx.env.token, diff_files: [] } });
  } catch (e) { throw new FlowToolError((e as Error).message); }
  await ctx.store.updateRun(ctx.env.run, { outcome: 'submitted' }, actor(ctx), '提交审查结论');
  const must = p.findings.filter((f) => f.level === 'must').length;
  return { text: `已提交（${p.findings.length} 条问题，必须改 ${must} 条）。你的工作已完成，请直接结束。` };
}

export const flowAccept = (ctx: ToolContext, p: Static<typeof AcceptParams>) => submitAccept(ctx, p, 'check');
export const flowAcceptConfirm = (ctx: ToolContext, p: Static<typeof AcceptConfirmParams>) => submitAccept(ctx, p, 'confirm');
