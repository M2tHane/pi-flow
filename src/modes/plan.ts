// 各模式的阶段计划（第五轮）：需求 D0 → 原型 D1 → 规划 D2 → 实施 E。
// D0–D2 的任务由程序生成；E 的模块任务来自 architect 在 D2 提交、经用户批准的模块清单。
import type { TaskInput } from '../core/state-store.ts';
import type { TaskFile } from '../core/schemas.ts';

export type FlowMode = 'build' | 'feature';

export const DESIGN_STAGES = new Set(['D0', 'D1', 'D2']);
/** 批准后落地模块清单的阶段 */
export const PROPOSAL_STAGES = new Set(['D2']);
/** 原型阶段：没有界面时跳过 */
export const PROTOTYPE_STAGE = 'D1';
/** 实施阶段：模块任务所在的阶段 */
export const EXECUTION_STAGE = 'E';

/** 各阶段注入的技能（子进程以 --no-skills 运行，由 prompt-assembler 注入）；按角色区分 */
export const STAGE_SKILLS: Record<string, Record<string, string[]>> = {
  D0: { analyst: ['write-requirements'] },
  D1: { designer: ['write-prototype'] },
  D2: { architect: ['plan-modules', 'write-rules'] },
  E: { implementer: ['write-handoff'] },
};

export function skillsFor(stage: string, role: string): string[] {
  return STAGE_SKILLS[stage]?.[role] ?? [];
}

export function slug(text: string): string {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return ascii || `feature-${Date.now().toString(36)}`;
}

/** 需求说明的路径：新项目一份，已有项目每个功能一份 */
export function requirementsFile(mode: FlowMode, description: string): string {
  return mode === 'build' ? 'docs/requirements.md' : `docs/requirements/${slug(description)}.md`;
}

/** 设计阶段的任务（不含 id）；after 是同一批中前置任务的下标（硬依赖） */
export type PlannedTask = Omit<TaskInput, 'id' | 'depends_on'> & { after?: number[] };

/** 写作者（各阶段产出文档的角色）：打回时只让它接着原会话修改 */
export const STAGE_WRITER: Record<string, string> = { D0: 'analyst', D1: 'designer', D2: 'architect' };

export function designTasks(mode: FlowMode, stage: string, description: string, opts: { requirements?: string } = {}): PlannedTask[] {
  const req = opts.requirements ?? requirementsFile(mode, description);
  const what = mode === 'build' ? '这个新项目' : '这次要加的功能';
  if (stage === 'D0') {
    const advocate = (who: 'user' | 'dev'): PlannedTask => ({
      stage, kind: 'analysis', advocate: who, role: who === 'user' ? 'user-advocate' : 'dev-advocate', scopes: [], inputs: [], writes: [], verify: [],
      title: who === 'user' ? '需求讨论：用户视角' : '需求讨论：开发视角',
      acceptance: who === 'user'
        ? [`从用户与产品的角度写出对${what}的意见：谁用、核心场景、必须有和可以以后做的、用户能验证的验收标准、边界情况`,
          '用户描述没说清的地方，给出你建议的默认做法和理由，不要停下来提问',
          '意见写进 flow_note（可以分几次写），最后 flow_submit 一句话总结']
        : [`从开发与工程的角度写出对${what}的意见：可行性、复杂度和成本最高的地方、风险、依赖、更省的做法${mode === 'feature' ? '、对现有代码的影响' : ''}`,
          mode === 'feature' ? '先读现有代码（codegraph、serena）了解相关模块，再给意见' : '建议合适的技术栈（说明理由）',
          '意见写进 flow_note（可以分几次写），最后 flow_submit 一句话总结'],
    });
    return [advocate('user'), advocate('dev'), {
      stage, kind: 'doc', role: 'analyst', scopes: ['requirements'], inputs: [req], writes: [req], verify: [], after: [0, 1],
      title: `汇总需求说明：${description}`.slice(0, 120),
      acceptance: [
        `${req} 包含：需求清单与优先级（MVP / 以后 / 不做）、每条需求的 done-when 验收标准（能被测试或实际操作验证）、关键决策与取舍、两方仍有的分歧及你的建议`,
        `${req} 写明打算用的界面风格和理由（没有界面写"无界面"）`,
        '上游的用户视角、开发视角意见都要考虑；分歧不替用户拍板，列出来由用户决定',
        `内容覆盖用户的描述：${description}`,
        'flow_submit 时用 prototype 说明是否需要原型阶段（没有界面或只改后端时为 false）',
      ],
    }];
  }
  if (stage === 'D1') {
    return [{
      stage, kind: 'doc', role: 'designer', scopes: ['prototype'], inputs: [req], writes: ['prototype/**'], verify: [],
      title: `原型：${description}`.slice(0, 120),
      acceptance: [
        `按 ${req} 中定下的风格，为每个 MVP 页面生成可点击的 HTML 原型（prototype/*.html，无框架、无构建），prototype/index.html 是导航页`,
        '用贴近真实的示例数据填满页面，每个 MVP 功能都能点击演示效果（新增、编辑、删除、筛选、详情等）',
        '每个页面都能切换加载、空、错误、无权限四种状态；某种状态确实不会出现时标明 N/A 与理由',
        '所有页面共用一份 prototype/styles.css，不各自另写样式',
      ],
    }];
  }
  if (stage === 'D2') {
    return [{
      stage, kind: 'doc', role: 'architect', scopes: ['planning'], inputs: [req, 'prototype/'], verify: [],
      writes: ['docs/modules.md', 'docs/interfaces/**', 'docs/adr/**', 'docs/rules-draft/**', 'AGENTS.md'],
      title: mode === 'build' ? '模块规划与项目规则' : '本功能涉及的模块与验收标准',
      acceptance: [
        mode === 'build'
          ? 'docs/modules.md 写明技术栈、目录结构、模块清单（每个模块负责的需求、验收标准、可写范围、登记的公共文件）和模块之间的依赖（阶段顺序）'
          : '先读现有代码确定这次涉及哪些模块；docs/modules.md 追加本功能：涉及的模块、各自改什么、验收标准、可写范围',
        'docs/interfaces/<模块>.md 只写模块之间的调用（A 要调用 B 的哪些 API 或服务）；模块内部怎么做不写',
        mode === 'build'
          ? 'docs/rules-draft/project.md 写项目专属规则（技术栈的用法、目录与命名约定、测试怎么写和怎么跑、错误处理）；docs/rules-draft/commands.yaml 按技术栈写 install、typecheck、lint、test 等命令'
          : 'docs/rules-draft/project.md 补充本功能引入的新约定（没有就保持现状）；命令需要变化时写 docs/rules-draft/commands.yaml',
        'AGENTS.md 写开发说明（结构、命令、约定），给之后所有在这个仓库里工作的 agent 看',
        '用 flow_propose_modules 提交模块清单：每个模块一个模型负责前端、后端与测试；互不依赖的模块能并行，依赖写 reason',
      ],
    }];
  }
  return [];
}

/** 打回时的修订任务：只让写作者接着原会话修改 */
export function revisionTask(stage: string, prev: TaskFile): PlannedTask {
  return {
    stage, kind: prev.kind, role: prev.role, scopes: [...prev.scopes], inputs: [...prev.inputs], writes: [...prev.writes], verify: [],
    title: `修订：${prev.title.replace(/^修订：/, '')}`.slice(0, 200), acceptance: [...prev.acceptance, '按用户的意见修改（见 handoff），其余内容保持一致'],
    fork_from_task: prev.id,
  };
}
