// .flow/ 下所有持久化结构的唯一定义（schema-first）。
// 类型由 schema 派生；schemas/*.json 由 scripts/gen-schemas.ts 从这里生成。
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const IsoTime = Type.String({ minLength: 1 });
const FlowId = Type.String({ pattern: '^[BFX]-[0-9]{3,}$' });
const TaskId = Type.String({ pattern: '^T-[0-9]{3,}$' });

export const TASK_STATUSES = [
  'pending', 'ready', 'in_progress', 'review', 'verifying',
  'queued_merge', 'merging', 'done', 'blocked',
] as const;
export const TaskStatus = Type.Enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_KINDS = ['test', 'impl', 'doc', 'infra', 'integration', 'review-fix', 'merge-fix', 'analysis'] as const;
export const TaskKind = Type.Enum(TASK_KINDS);
export type TaskKind = (typeof TASK_KINDS)[number];

export const STAGE_STATUSES = ['active', 'awaiting_gate', 'awaiting_human', 'done', 'aborted'] as const;
export const StageStatus = Type.Enum(STAGE_STATUSES);
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const EVENT_TYPES = [
  'transition', 'violation', 'note', 'dispatch', 'lease_expired', 'approval',
  'gate_result', 'merge', 'merge_conflict', 'integrity_error',
] as const;
export const EventType = Type.Enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

export const StateFile = Type.Object({
  schema_version: Type.Literal(1),
  version: Type.Integer({ minimum: 0 }),
  active_flow: Nullable(FlowId),
  events_head: Type.String(),
}, { additionalProperties: false });
export type StateFile = Static<typeof StateFile>;

export const Approval = Type.Object({ by: Type.Literal('human'), at: IsoTime, note: Type.Optional(Type.String()) },
  { additionalProperties: false });

export const FlowFile = Type.Object({
  id: FlowId,
  mode: Type.Union([Type.Literal('build'), Type.Literal('feature'), Type.Literal('fix')]),
  title: Type.String(),
  stages: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  stage: Type.String({ minLength: 1 }),
  stage_status: StageStatus,
  integration_branch: Type.String({ minLength: 1 }),
  base_sha: Nullable(Type.String()),
  approvals: Type.Record(Type.String(), Approval),
  created_at: IsoTime,
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type FlowFile = Static<typeof FlowFile>;

export const Dependency = Type.Object({
  task: TaskId,
  type: Type.Union([Type.Literal('hard'), Type.Literal('soft')]),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type Dependency = Static<typeof Dependency>;

export const Lease = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  token_hash: Type.String({ minLength: 64, maxLength: 64 }),
  acquired_at: IsoTime,
  expires_at: IsoTime,
}, { additionalProperties: false });
export type Lease = Static<typeof Lease>;

export const TaskFile = Type.Object({
  id: TaskId,
  stage: Type.String({ minLength: 1 }),
  kind: TaskKind,
  title: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  scopes: Type.Array(Type.String()),
  depends_on: Type.Array(Dependency),
  inputs: Type.Array(Type.String()),
  writes: Type.Array(Type.String()),
  acceptance: Type.Array(Type.String()),
  verify: Type.Array(Type.String()),
  status: TaskStatus,
  attempts: Type.Integer({ minimum: 0 }),
  violations: Type.Integer({ minimum: 0 }),
  lease_expirations: Type.Integer({ minimum: 0 }),
  /** 会话中断（pi 崩溃、被强杀、用户关闭）导致 run 丢失的次数；不计入 attempts */
  interruptions: Type.Optional(Type.Integer({ minimum: 0 })),
  lease: Nullable(Lease),
  impl_run: Nullable(Type.String()),
  branch: Nullable(Type.String()),
  worktree: Nullable(Type.String()),
  base_sha: Nullable(Type.String()),
  blocked_reason: Nullable(Type.String()),
  last_failure: Nullable(Type.String()),
  // scout（analysis 任务）提交的结构化结论（fix 模式）
  findings: Type.Optional(Type.Object({
    location: Type.String(),
    root_cause: Type.String(),
    impact_files: Type.Array(Type.String()),
    suggested_role: Type.String(),
    contract_change: Type.Boolean(),
    estimated_files: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  // merge-fix 专用：被挂起的原任务与冲突文件
  merge_fix_for: Type.Optional(TaskId),
  conflict_files: Type.Optional(Type.Array(Type.String())),
  created_by: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type TaskFile = Static<typeof TaskFile>;

export const FlowEvent = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  ts: IsoTime,
  flow: Nullable(Type.String()),
  actor: Type.String({ minLength: 1 }),
  type: EventType,
  task: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  trigger: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // 本事件所在事务写入的文件（相对 .flow/）及其内容哈希，用于完整性校验
  entities: Type.Optional(Type.Record(Type.String(), Type.String())),
  // 本事件所在事务修改了 state.active_flow 时记录新值，用于校验 state.json
  active_flow: Type.Optional(Nullable(FlowId)),
  prev_hash: Type.String({ minLength: 64, maxLength: 64 }),
  hash: Type.String({ minLength: 64, maxLength: 64 }),
}, { additionalProperties: false });
export type FlowEvent = Static<typeof FlowEvent>;

export const Tokens = Type.Object({
  input: Nullable(Type.Integer({ minimum: 0 })),
  output: Nullable(Type.Integer({ minimum: 0 })),
  cache_read: Nullable(Type.Integer({ minimum: 0 })),
  cache_write: Nullable(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const RunFile = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  flow: Nullable(Type.String()),
  task: Nullable(Type.String()),
  role: Type.String({ minLength: 1 }),
  model: Nullable(Type.String()),
  started_at: IsoTime,
  ended_at: Nullable(IsoTime),
  tokens: Tokens,
  outcome: Nullable(Type.Union([
    Type.Literal('submitted'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('blocked'),
    Type.Literal('failed'), Type.Literal('killed'), Type.Literal('lease_expired'), Type.Literal('noted'),
  ])),
  token_hash: Type.String({ minLength: 64, maxLength: 64 }),
  violations: Type.Integer({ minimum: 0 }),
  /** 子进程 pid（进程组 id）；用于恢复时清理残留进程 */
  pid: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type RunFile = Static<typeof RunFile>;

export const MergeQueueEntry = Type.Object({ flow: Type.String(), task: TaskId, enqueued_at: IsoTime },
  { additionalProperties: false });
export const MergeQueueFile = Type.Object({
  queue: Type.Array(MergeQueueEntry),
  merging: Nullable(Type.Object({ flow: Type.String(), task: TaskId, started_at: IsoTime },
    { additionalProperties: false })),
  // 文本冲突在 writes 内：原任务保持 merging 但让出合并名额，等待 merge-fix 任务（偏离，见 NOTES）
  suspended: Type.Optional(Type.Array(Type.Object({ flow: Type.String(), task: TaskId, merge_fix: TaskId, since: IsoTime },
    { additionalProperties: false }))),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type MergeQueueFile = Static<typeof MergeQueueFile>;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ThinkingLevel = Type.Enum(THINKING_LEVELS);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// —— workflow.yaml ——

const Gate = Type.Object({
  human: Type.Optional(Type.Boolean()),
  auto: Type.Optional(Type.Array(Type.String())),
  all_tasks_done: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** 给人看的高层阶段；底层阶段（S0…S5、F0…）与任务 DAG 只给程序用 */
export const PHASES = ['discovery', 'planning', 'execution', 'acceptance'] as const;
export type Phase = (typeof PHASES)[number];

const StageDef = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  /** 可选：该阶段在 /flow status 中归入哪个高层阶段；缺省按阶段 id 推断 */
  phase: Type.Optional(Type.Enum(PHASES)),
  gate: Gate,
}, { additionalProperties: false });

const ModeDef = Type.Object({ stages: Type.Array(StageDef, { minItems: 1 }) }, { additionalProperties: false });

const PosInt = Type.Integer({ minimum: 1 });

export const WorkflowFile = Type.Object({
  version: Type.Literal(1),
  project: Type.String({ minLength: 1 }),
  main_branch: Type.String({ minLength: 1 }),
  commands: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  limits: Type.Object({
    max_parallel: PosInt,
    max_attempts: PosInt,
    lease_minutes: PosInt,
    max_violations_per_run: PosInt,
    max_task_files: PosInt,
    fix_max_files: PosInt,
  }, { additionalProperties: false }),
  models: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  modes: Type.Object({ build: Type.Optional(ModeDef), feature: Type.Optional(ModeDef) }, { additionalProperties: false }),
  scopes: Type.Record(Type.String(), Type.Object({
    rules: Type.Optional(Type.Array(Type.String())),
    writes: Type.Array(Type.String()),
  }, { additionalProperties: false })),
  tool_groups: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }))),
  roles: Type.Record(Type.String(), Type.Object({
    model: Type.String({ minLength: 1 }),
    thinking: Type.Optional(ThinkingLevel),
    scopes: Type.Optional(Type.Array(Type.String())),
    tools: Type.Array(Type.String({ minLength: 1 })),
    read_paths: Type.Optional(Type.Array(Type.String())),
    writes: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type WorkflowFile = Static<typeof WorkflowFile>;

// —— 任务提案：architect 在 S1/F1 经 flow_propose_tasks 提交，人工批准该阶段闸门后才落为任务 ——

export const ProposedTask = Type.Object({
  id: TaskId,
  stage: Type.String({ minLength: 1 }),
  kind: TaskKind,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  role: Type.String({ minLength: 1 }),
  scopes: Type.Array(Type.String()),
  depends_on: Type.Array(Dependency),
  inputs: Type.Array(Type.String()),
  writes: Type.Array(Type.String(), { minItems: 1 }),
  acceptance: Type.Array(Type.String(), { minItems: 1 }),
  verify: Type.Array(Type.String()),
}, { additionalProperties: false });
export type ProposedTask = Static<typeof ProposedTask>;

export const ProposalFile = Type.Object({
  stage: Type.String(),
  run: Type.String(),
  created_at: IsoTime,
  tasks: Type.Array(ProposedTask, { minItems: 1 }),
  report: Type.Object({
    task_count: Type.Integer(), critical_path: Type.Array(Type.String()), critical_path_length: Type.Integer(),
    max_width: Type.Integer(), hard_ratio: Type.Number(), warnings: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type ProposalFile = Static<typeof ProposalFile>;

// —— 需求访谈：开流程之前由主会话与用户访谈，程序保存摘要（.flow/brief.json，同一时间一份） ——

export const BriefFile = Type.Object({
  mode: Type.Union([Type.Literal('build'), Type.Literal('feature'), Type.Literal('fix')]),
  description: Type.String(),
  sections: Type.Record(Type.String(), Type.String({ maxLength: 4000 })),
  status: Type.Union([Type.Literal('collecting'), Type.Literal('confirmed'), Type.Literal('cancelled')]),
  flow: Nullable(FlowId),
  created_at: IsoTime,
  updated_at: IsoTime,
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type BriefFile = Static<typeof BriefFile>;

// —— 项目级知识库（.flow/knowledge.json）：跨流程积累的约定、坑、决策；只由程序写入 ——

export const KNOWLEDGE_CATEGORIES = ['convention', 'pitfall', 'decision', 'environment', 'dependency'] as const;
export const KnowledgeCategory = Type.Enum(KNOWLEDGE_CATEGORIES);
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];
export const KNOWLEDGE_STATUSES = ['candidate', 'active', 'retired', 'promoted'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KnowledgeEntry = Type.Object({
  id: Type.String({ pattern: '^K-[0-9]{3,}$' }),
  category: KnowledgeCategory,
  content: Type.String({ minLength: 1, maxLength: 500 }),
  /** 适用的 scope；与 paths 都为空表示全局 */
  scopes: Type.Array(Type.String({ minLength: 1 })),
  /** 适用的路径 glob（相对仓库根） */
  paths: Type.Array(Type.String({ minLength: 1 })),
  source: Type.Object({
    /** agent：flow_learn 提交；review：审查打回提炼；merge：合并后验证失败提炼；human：用户 */
    kind: Type.Union([Type.Literal('agent'), Type.Literal('review'), Type.Literal('merge'), Type.Literal('human')]),
    flow: Nullable(Type.String()),
    task: Nullable(Type.String()),
    run: Nullable(Type.String()),
    role: Nullable(Type.String()),
  }, { additionalProperties: false }),
  status: Type.Enum(KNOWLEDGE_STATUSES),
  /** 已提升为规则草案时的草案文件 */
  draft: Type.Optional(Type.String()),
  status_reason: Type.Optional(Type.String({ maxLength: 500 })),
  created_at: IsoTime,
  updated_at: IsoTime,
}, { additionalProperties: false });
export type KnowledgeEntry = Static<typeof KnowledgeEntry>;

export const KnowledgeFile = Type.Object({
  entries: Type.Array(KnowledgeEntry),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type KnowledgeFile = Static<typeof KnowledgeFile>;

// —— ~/.pi/agent/pi-flow.json：用户通过 /flow-config 设置的角色模型与思考级别 ——

export const RoleSettingsFile = Type.Object({
  version: Type.Literal(1),
  roles: Type.Record(Type.String(), Type.Object({
    model: Type.Optional(Type.String({ pattern: '^[^/\\s]+/\\S+$' })),
    thinking: Type.Optional(ThinkingLevel),
  }, { additionalProperties: false })),
  updated_at: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type RoleSettingsFile = Static<typeof RoleSettingsFile>;

export const SCHEMAS = {
  state: StateFile,
  flow: FlowFile,
  task: TaskFile,
  event: FlowEvent,
  run: RunFile,
  'merge-queue': MergeQueueFile,
  workflow: WorkflowFile,
  'role-settings': RoleSettingsFile,
  proposal: ProposalFile,
  brief: BriefFile,
  knowledge: KnowledgeFile,
} as const;
export type SchemaKind = keyof typeof SCHEMAS;

/** 校验并返回中文错误列表；空数组表示通过。 */
export function validate(kind: SchemaKind, value: unknown): string[] {
  const schema = SCHEMAS[kind];
  if (Value.Check(schema, value)) return [];
  return Value.Errors(schema, value).map((e) => `${kind}${e.instancePath || '/'}: ${e.message}`);
}
