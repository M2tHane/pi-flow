// 阶段闸门（第 8 节 gate）：all_tasks_done、S1/F1 必须有任务提案、在集成分支 HEAD 上执行 auto 命令并保存 evidence。
// 通过后：需要人工 → awaiting_human；否则 → done。最后一个阶段一律需要人工（之后合入主分支）。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from './config.ts';
import type { StateStore } from './state-store.ts';
import { git } from './git.ts';
import { worktreesRoot, removeWorktree } from './worktree.ts';
import { evidenceText, runShell } from './verify-runner.ts';
import { PROPOSAL_STAGES } from '../modes/plan.ts';

export interface GateOutcome { stage: string; passed: boolean; needsHuman: boolean; reasons: string[] }

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

  const open = store.listTasks(flowId).filter((t) => t.stage === flow.stage && t.status !== 'done');
  if (open.length) reasons.push(`本阶段还有未完成的任务：${open.map((t) => `${t.id}（${t.status}）`).join('、')}`);
  if (PROPOSAL_STAGES.has(flow.stage) && !store.readProposal(flowId)) reasons.push('架构阶段必须经 flow_propose_tasks 提交任务列表');

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
  return { stage: flow.stage, passed, needsHuman, reasons };
}

/** 本阶段最近一次闸门失败之后，是否还没有任何任务状态变化（避免对同样的结果反复跑闸门） */
export function gateFailedWithoutChange(store: StateStore, flowId: string, stage: string): boolean {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const lastFail = [...events].reverse().find((e) => e.type === 'gate_result' && e.to === 'active' && e.data?.['stage'] === stage);
  if (!lastFail) return false;
  const stageTasks = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  return !events.some((e) => e.seq > lastFail.seq && e.type === 'transition' && e.task && stageTasks.has(e.task));
}
