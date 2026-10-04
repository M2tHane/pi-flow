// 阶段闸门（第 8 节 gate）：all_tasks_done、S1/F1 必须有任务提案、在集成分支 HEAD 上执行 auto 命令并保存 evidence。
// 通过后：需要人工 → awaiting_human；否则 → done。最后一个阶段一律需要人工（之后合入主分支）。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import { isSettled } from './state-machine.ts';
import type { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { worktreesRoot, removeWorktree } from './worktree.ts';
import { evidenceText, runShell } from './verify-runner.ts';
import { PROPOSAL_STAGES } from '../modes/plan.ts';

/** failed：失败的闸门命令与输出（阶段末审查据此生成修复任务） */
export interface GateOutcome { stage: string; passed: boolean; needsHuman: boolean; reasons: string[]; failed?: { command: string; output: string } }

export function stageDef(config: FlowConfig, mode: 'build' | 'feature', stage: string) {
  const def = config.raw.modes[mode]?.stages.find((s) => s.id === stage);
  if (!def) throw new Error(`workflow.yaml 的 modes.${mode} 中没有阶段 ${stage}`);
  return def;
}

export async function runStageGate(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<GateOutcome> {
  const flow = store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_gate') throw new Error(`阶段 ${flow.stage} 不在 awaiting_gate 状态`);
  if (flow.mode === 'fix') throw new Error('fix 流程不使用阶段闸门');
  const def = stageDef(config, flow.mode, flow.stage);
  const isLast = flow.stage === flow.stages.at(-1);
  const needsHuman = !!def.gate.human || isLast;
  const reasons: string[] = [];
  let failed: GateOutcome['failed'];

  const open = store.listTasks(flowId).filter((t) => t.stage === flow.stage && !isSettled(t));
  if (open.length) reasons.push(`本阶段还有未完成的任务：${open.map((t) => `${t.id}（${t.status}）`).join('、')}`);
  if (PROPOSAL_STAGES.has(flow.stage) && !store.readProposal(flowId)) reasons.push('规划阶段必须经 flow_propose_modules 提交模块清单');
  // 新项目的规划阶段必须写出项目专属规则（批准时应用到 rules/project.md）
  if (PROPOSAL_STAGES.has(flow.stage) && flow.mode === 'build' && !gitOk(root, ['cat-file', '-e', `${flow.integration_branch}:docs/rules-draft/project.md`])) {
    reasons.push('规划阶段必须写出项目专属规则 docs/rules-draft/project.md');
  }

  if (!reasons.length && def.gate.auto?.length) {
    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);
    mkdirSync(path.dirname(wt), { recursive: true });
    removeWorktree(root, wt);
    git(root, ['worktree', 'add', '-q', '--detach', wt, flow.integration_branch]);
    try {
      for (const name of def.gate.auto) {
        const shell = config.commands[name]!;
        const r = { command: name, ...(await runShell(shell.replace('{files}', '').trim(), wt, timeoutMs)) };
        await store.saveStageEvidence(flowId, flow.stage, `gate-${name}.log`, evidenceText(r, shell), 'gate');
        if (r.exit_code !== 0) {
          reasons.push(`闸门命令 ${name} 失败（退出码 ${r.exit_code}）：${r.output.trim().split('\n').slice(-8).join(' / ')}`);
          failed = { command: name, output: r.output };
          break;
        }
      }
    } finally {
      removeWorktree(root, wt);
    }
  }

  const passed = reasons.length === 0;
  if (passed) {
    await store.transitionStage(flowId, { to: needsHuman ? 'awaiting_human' : 'done', trigger: 'gate_passed', actor: 'gate', needs_human: needsHuman });
  } else {
    await store.transitionStage(flowId, { to: 'active', trigger: 'gate_failed', actor: 'gate', reason: reasons.join('；') });
  }
  return { stage: flow.stage, passed, needsHuman, reasons, ...(failed ? { failed } : {}) };
}

/** 本阶段最近一次闸门失败之后，是否还没有任何任务状态变化（避免对同样的结果反复跑闸门） */
export function gateFailedWithoutChange(store: StateStore, flowId: string, stage: string): boolean {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const lastFail = [...events].reverse().find((e) => e.type === 'gate_result' && e.to === 'active' && e.data?.['stage'] === stage);
  if (!lastFail) return false;
  const stageTasks = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  return !events.some((e) => e.seq > lastFail.seq && e.type === 'transition' && e.task && stageTasks.has(e.task));
}
