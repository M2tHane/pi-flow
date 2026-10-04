// 各模式的阶段计划：设计阶段（S0、S1、F0、F1）的任务由程序生成；其余阶段的任务来自 architect 提交并经批准的 DAG。
import type { TaskInput } from '../core/state-store.ts';

export type FlowMode = 'build' | 'feature';

export const DESIGN_STAGES = new Set(['S0', 'S1', 'F0', 'F1']);
/** 批准后落地任务提案的阶段 */
export const PROPOSAL_STAGES = new Set(['S1', 'F1']);

/** 各阶段注入的技能（子进程以 --no-skills 运行，由 prompt-assembler 注入） */
export const STAGE_SKILLS: Record<string, string[]> = {
  S0: ['write-prd'],
  S1: ['design-contract', 'decompose-dag', 'write-rules'],
  F0: ['write-feature-spec'],
  F1: ['design-contract', 'decompose-dag', 'write-rules'],
};

export function slug(text: string): string {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return ascii || `feature-${Date.now().toString(36)}`;
}

/** 设计阶段的任务（不含 id，由调用方分配）；非设计阶段返回空数组 */
export function designTasks(mode: FlowMode, stage: string, description: string): Omit<TaskInput, 'id'>[] {
  const base = { kind: 'doc' as const, role: 'architect', depends_on: [], verify: [] as string[] };
  if (mode === 'build' && stage === 'S0') {
    return [{ ...base, stage, title: '撰写 PRD', scopes: ['docs'], writes: ['docs/PRD.md'], inputs: ['docs/PRD.md'], acceptance: [
      'docs/PRD.md 包含背景与目标、用户与场景、功能范围、非目标、可验证的验收标准、约束与假设、未决问题',
      '每条验收标准都能被自动化测试验证',
      `内容覆盖用户的描述：${description}`,
      '需求没说清但有合理默认方案的，写进"约束与假设"由用户审批时确认；只有无法合理假设、又会改变功能范围的才用 flow_block 提一个问题',
    ] }];
  }
  if (mode === 'build' && stage === 'S1') {
    return [{ ...base, stage, title: '架构、ADR、契约与任务 DAG', scopes: ['docs', 'shared'], writes: ['docs/**', 'src/shared/**'],
      inputs: ['docs/PRD.md'], acceptance: [
        'docs/ARCHITECTURE.md 写明模块边界、依赖方向与数据模型',
        '重大技术选型各写一条 ADR（docs/adr/），给出对比与建议，不替用户拍板',
        'docs/contracts/ 中有数据模型 schema，每个模块一个契约文件，只写模块之间的边界（前端组件之间的装配不写），写到函数级：对外函数的名字、参数（名、类型、约束）、返回值、可能的错误；REST 接口写路径、方法、请求与响应、错误码（批准后只读）',
        '按默认方案处理的不清楚之处写进 flow_propose_tasks 的 assumptions（不要为此停下来提问）',
        '经 flow_propose_tasks 提交覆盖 S2 至 S4 的任务 DAG：实现任务自带测试；inputs 列出依赖的契约条目；硬依赖写 reason；软依赖配 integration 任务',
        '针对选定的技术栈，在 docs/rules-draft/ 写规则草案（与 rules/ 同名表示替换）；工具链与 workflow.yaml 的命令不符时写 docs/rules-draft/commands.yaml',
      ] }];
  }
  if (mode === 'feature' && stage === 'F0') {
    const file = `docs/features/${slug(description)}.md`;
    return [{ ...base, stage, title: `功能说明：${description}`.slice(0, 120), scopes: ['docs'], writes: ['docs/features/**', 'docs/PRD.md'],
      inputs: ['docs/PRD.md', 'docs/features/_template.md'], acceptance: [
        `${file} 包含目标、非目标、可验证的验收标准、受影响模块、是否需要改契约`,
        'docs/PRD.md 追加该功能的条目并链接到功能说明',
        '需求没说清但有合理默认方案的，写进功能说明的"假设"一节；只有无法合理假设、又会改变范围的才用 flow_block 提一个问题',
      ] }];
  }
  if (mode === 'feature' && stage === 'F1') {
    return [{ ...base, stage, title: '影响面分析与本功能的任务 DAG', scopes: ['docs', 'shared'], writes: ['docs/**', 'src/shared/**'],
      inputs: ['docs/features/', 'docs/ARCHITECTURE.md', 'docs/contracts/'], acceptance: [
        '用 codegraph 做影响面分析，结果写入功能说明的"受影响模块"',
        '复用现有架构与契约；需要改契约时先写 ADR',
        '新增或修改的对外函数与接口在契约中写到函数级（名字、参数、返回值、错误）',
        '按默认方案处理的不清楚之处写进 flow_propose_tasks 的 assumptions（不要为此停下来提问）',
        '经 flow_propose_tasks 提交本功能的任务 DAG（S3、S4）：实现任务自带测试；inputs 列出依赖的契约条目；S4 包含新功能的联调测试',
        '本功能引入新的约定时，在 docs/rules-draft/ 写规则草案（可选）',
      ] }];
  }
  return [];
}
