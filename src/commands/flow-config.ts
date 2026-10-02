// /flow-config：为各角色设置模型与思考级别（effort），保存到用户级 ~/.pi/agent/pi-flow.json。
// 交互模式经 UiPort 选择；无 UI 时（print/json 模式）使用子命令：show、models、set、unset。
import { THINKING_LEVELS, type ThinkingLevel } from '../core/schemas.ts';
import type { FlowConfig } from '../core/config.ts';
import {
  loadRoleSettings, resolveRoleModel, saveRoleSettings, setEscalation, setRole, unsetRole, type RoleSetting,
} from '../core/role-settings.ts';
import { escalationModel, strongReviewModel } from '../core/cost-control.ts';
import { splitArgs } from './args.ts';

export interface UiPort {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

export interface ModelOption {
  /** provider/id，与 pi --model 参数一致 */
  ref: string;
  name: string;
  /** 该模型支持的思考级别 */
  levels: ThinkingLevel[];
}

export interface FlowConfigDeps {
  ui: UiPort | null;
  models: ModelOption[];
  config: FlowConfig;
  settingsPath: string;
  now?: () => Date;
}

export class FlowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowConfigError';
  }
}

const USAGE = [
  '用法：',
  '  /flow-config                         交互式设置（需要终端界面）',
  '  /flow-config show                    查看各角色当前的模型与思考级别',
  '  /flow-config models                  列出可用模型及其支持的思考级别',
  '  /flow-config set <角色> <provider/model|default> [思考级别|default]',
  '  /flow-config unset <角色|all>        清除设置，回到 workflow.yaml 默认',
  '  /flow-config escalate <角色> <provider/model|default>   同一任务失败多次后改用的模型（default：workflow.yaml 或上一档）；对 reviewer 是高风险任务审查用的模型',
  `思考级别：${THINKING_LEVELS.join('、')}`,
].join('\n');

const MENU_SET = '设置各角色的模型与思考级别';
const MENU_SHOW = '查看当前设置';
const MENU_CLEAR = '清除所有角色设置';
const MENU_ESCALATE = '设置失败后升级用的模型（reviewer：高风险审查用的模型）';
const DONE = '完成';
const USE_WORKFLOW = '使用 workflow.yaml 默认';
const USE_DEFAULT = '使用默认';

export async function runFlowConfig(args: string, deps: FlowConfigDeps): Promise<string> {
  const argv = splitArgs(args);
  const sub = argv[0];
  if (!sub) {
    if (!deps.ui) return `当前模式没有交互界面。\n${USAGE}`;
    return interactive(deps, deps.ui);
  }
  switch (sub) {
    case 'show': return describeAll(deps);
    case 'models': return describeModels(deps);
    case 'set': return cmdSet(argv.slice(1), deps);
    case 'unset': return cmdUnset(argv.slice(1), deps);
    case 'escalate': return cmdEscalate(argv.slice(1), deps);
    case 'help': case '-h': case '--help': return USAGE;
    default: throw new FlowConfigError(`未知子命令 ${sub}。\n${USAGE}`);
  }
}

function roles(deps: FlowConfigDeps): string[] {
  return Object.keys(deps.config.roles);
}

function findModel(deps: FlowConfigDeps, ref: string): ModelOption | undefined {
  const lower = ref.toLowerCase();
  return deps.models.find((m) => m.ref.toLowerCase() === lower);
}

/** 模型（含 workflow.yaml 默认）支持的思考级别；目录里查不到时列出全部，由 Pi 在运行时按模型能力收窄 */
function levelsFor(deps: FlowConfigDeps, role: string, ref: string | undefined): ThinkingLevel[] {
  const effective = ref ?? resolveRoleModel(deps.config, { version: 1, roles: {} }, role).model;
  return (effective && findModel(deps, effective)?.levels) || [...THINKING_LEVELS];
}

function describeRole(deps: FlowConfigDeps, role: string): string {
  const settings = loadRoleSettings(deps.settingsPath);
  const r = resolveRoleModel(deps.config, settings, role);
  const tier = deps.config.role(role).modelTier;
  const modelText = r.modelSource === 'flow-config' ? `${r.model}（/flow-config）`
    : r.modelSource === 'workflow' ? `${r.model}（workflow.yaml ${tier} 档）`
      : `未设置模型（workflow.yaml ${tier} 档未填写）`;
  const unavailable = r.model && deps.models.length && !findModel(deps, r.model) ? ' [当前不可用]' : '';
  const thinkingText = r.thinking
    ? `思考 ${r.thinking}${r.thinkingSource === 'flow-config' ? '（/flow-config）' : '（workflow.yaml）'}`
    : '思考 默认';
  // reviewer 不做失败升级；它的升级模型用于高风险任务的审查
  if (role === 'reviewer') {
    const strong = r.model ? strongReviewModel(deps.config, settings, role, r.model) : null;
    return `${modelText}${unavailable} · ${thinkingText}${strong ? ` · 高风险审查用 ${strong}` : ''}`;
  }
  const esc = r.model ? escalationModel(deps.config, settings, role, r.model) : null;
  return `${modelText}${unavailable} · ${thinkingText}${esc ? ` · 失败后升级 ${esc}` : ''}`;
}

function describeAll(deps: FlowConfigDeps): string {
  const width = Math.max(...roles(deps).map((r) => r.length));
  const lines = roles(deps).map((r) => `  ${r.padEnd(width)}  ${describeRole(deps, r)}`);
  return [`角色模型设置（保存于 ${deps.settingsPath}，优先于 workflow.yaml）：`, ...lines].join('\n');
}

function describeModels(deps: FlowConfigDeps): string {
  if (!deps.models.length) return '没有可用模型。请先在 Pi 中配置模型提供商（/login 或 ~/.pi/agent/models.json）。';
  return ['可用模型：', ...deps.models.map((m) => `  ${m.ref}  ${m.name}  思考：${m.levels.join('、')}`)].join('\n');
}

function parseThinking(v: string | undefined): ThinkingLevel | undefined {
  if (v === undefined || v === 'default') return undefined;
  if (!(THINKING_LEVELS as readonly string[]).includes(v)) {
    throw new FlowConfigError(`思考级别 ${v} 不合法，可选：${THINKING_LEVELS.join('、')}、default`);
  }
  return v as ThinkingLevel;
}

function validateSetting(deps: FlowConfigDeps, role: string, value: RoleSetting): RoleSetting {
  if (!deps.config.roles[role]) throw new FlowConfigError(`角色 ${role} 不存在。可选角色：${roles(deps).join('、')}`);
  let model = value.model;
  if (model !== undefined) {
    const m = findModel(deps, model);
    if (!m) throw new FlowConfigError(`模型 ${model} 不可用。执行 /flow-config models 查看可用模型`);
    model = m.ref;
  }
  if (value.thinking !== undefined) {
    const levels = levelsFor(deps, role, model);
    if (!levels.includes(value.thinking)) {
      const name = model ?? resolveRoleModel(deps.config, { version: 1, roles: {} }, role).model ?? '该模型';
      throw new FlowConfigError(`${name} 不支持思考级别 ${value.thinking}，可选：${levels.join('、')}`);
    }
  }
  return { ...(model !== undefined ? { model } : {}), ...(value.thinking !== undefined ? { thinking: value.thinking } : {}) };
}

function save(deps: FlowConfigDeps, role: string, value: RoleSetting): void {
  const next = setRole(loadRoleSettings(deps.settingsPath), role, value);
  saveRoleSettings(deps.settingsPath, next, deps.now?.());
}

function cmdSet(argv: string[], deps: FlowConfigDeps): string {
  const [role, modelArg, thinkingArg] = argv;
  if (!role || !modelArg || argv.length > 3) throw new FlowConfigError(USAGE);
  const value = validateSetting(deps, role, {
    ...(modelArg !== 'default' ? { model: modelArg } : {}),
    ...(parseThinking(thinkingArg) ? { thinking: parseThinking(thinkingArg)! } : {}),
  });
  save(deps, role, value);
  return `已保存：${role} → ${describeRole(deps, role)}`;
}

function cmdEscalate(argv: string[], deps: FlowConfigDeps): string {
  const [role, modelArg] = argv;
  if (!role || !modelArg || argv.length > 2) throw new FlowConfigError(USAGE);
  if (!deps.config.roles[role]) throw new FlowConfigError(`角色 ${role} 不存在。可选角色：${roles(deps).join('、')}`);
  let model: string | undefined;
  if (modelArg !== 'default') {
    const m = findModel(deps, modelArg);
    if (!m) throw new FlowConfigError(`模型 ${modelArg} 不可用。执行 /flow-config models 查看可用模型`);
    model = m.ref;
  }
  saveRoleSettings(deps.settingsPath, setEscalation(loadRoleSettings(deps.settingsPath), role, model), deps.now?.());
  return `已保存：${role} → ${describeRole(deps, role)}`;
}

function cmdUnset(argv: string[], deps: FlowConfigDeps): string {
  const [role] = argv;
  if (!role || argv.length > 1) throw new FlowConfigError(USAGE);
  if (role === 'all') {
    saveRoleSettings(deps.settingsPath, { version: 1, roles: {} }, deps.now?.());
    return '已清除所有角色设置，全部回到 workflow.yaml 默认。';
  }
  if (!deps.config.roles[role]) throw new FlowConfigError(`角色 ${role} 不存在。可选角色：${roles(deps).join('、')}`);
  saveRoleSettings(deps.settingsPath, unsetRole(loadRoleSettings(deps.settingsPath), role), deps.now?.());
  return `已清除 ${role} 的设置：${describeRole(deps, role)}`;
}

async function interactive(deps: FlowConfigDeps, ui: UiPort): Promise<string> {
  for (;;) {
    const choice = await ui.select('pi-flow 配置', [MENU_SET, MENU_ESCALATE, MENU_SHOW, MENU_CLEAR, DONE]);
    if (!choice || choice === DONE) return '已退出 /flow-config。';
    if (choice === MENU_SHOW) ui.notify(describeAll(deps), 'info');
    else if (choice === MENU_CLEAR) {
      saveRoleSettings(deps.settingsPath, { version: 1, roles: {} }, deps.now?.());
      ui.notify('已清除所有角色设置。', 'info');
    } else if (choice === MENU_SET) {
      await editRoles(deps, ui);
    } else if (choice === MENU_ESCALATE) {
      await editEscalation(deps, ui);
    }
  }
}

async function editEscalation(deps: FlowConfigDeps, ui: UiPort): Promise<void> {
  for (;;) {
    const labels = roles(deps).map((r) => `${r} · ${describeRole(deps, r)}`);
    const pick = await ui.select('选择角色：同一任务失败多次后改用哪个模型（reviewer：高风险任务审查用哪个模型）', [DONE, ...labels]);
    if (!pick || pick === DONE) return;
    const role = roles(deps)[labels.indexOf(pick)];
    if (!role) return;
    const modelLabels = deps.models.map((m) => `${m.ref}  ${m.name}`);
    const modelPick = await ui.select(role === 'reviewer' ? 'reviewer：高风险任务审查用的模型' : `${role}：失败后升级用的模型`, [USE_WORKFLOW, ...modelLabels]);
    if (!modelPick) continue;
    const model = modelPick === USE_WORKFLOW ? undefined : deps.models[modelLabels.indexOf(modelPick)]?.ref;
    saveRoleSettings(deps.settingsPath, setEscalation(loadRoleSettings(deps.settingsPath), role, model), deps.now?.());
    ui.notify(`已保存：${role} → ${describeRole(deps, role)}`, 'info');
  }
}

async function editRoles(deps: FlowConfigDeps, ui: UiPort): Promise<void> {
  for (;;) {
    const labels = roles(deps).map((r) => `${r} · ${describeRole(deps, r)}`);
    const pick = await ui.select('选择角色（设置后回到此列表，可继续修改其他角色）', [DONE, ...labels]);
    if (!pick || pick === DONE) return;
    const role = roles(deps)[labels.indexOf(pick)];
    if (!role) return;

    const wfModel = resolveRoleModel(deps.config, { version: 1, roles: {} }, role).model;
    const modelLabels = deps.models.map((m) => `${m.ref}  ${m.name}`);
    const modelPick = await ui.select(`${role}：选择模型`, [`${USE_WORKFLOW}（${wfModel ?? '未填写'}）`, ...modelLabels]);
    if (!modelPick) continue;
    const model = modelPick.startsWith(USE_WORKFLOW) ? undefined : deps.models[modelLabels.indexOf(modelPick)]?.ref;

    const levels = levelsFor(deps, role, model);
    const thinkingPick = await ui.select(`${role}：选择思考级别（effort）`, [USE_DEFAULT, ...levels]);
    if (!thinkingPick) continue;
    const thinking = thinkingPick === USE_DEFAULT ? undefined : (thinkingPick as ThinkingLevel);

    save(deps, role, validateSetting(deps, role, { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }));
    ui.notify(`已保存：${role} → ${describeRole(deps, role)}`, 'info');
  }
}
