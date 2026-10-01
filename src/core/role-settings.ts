// 用户级角色设置（/flow-config）：每个角色的模型与思考级别。文件路径由 pi-adapter 提供（~/.pi/agent/pi-flow.json）。
// 优先级：本文件 > workflow.yaml 的角色档位（models.<tier>）与 roles.<role>.thinking。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validate, type RoleSettingsFile, type ThinkingLevel } from './schemas.ts';
import type { FlowConfig } from './config.ts';

export const ROLE_SETTINGS_FILENAME = 'pi-flow.json';

export class RoleSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleSettingsError';
  }
}

export interface RoleSetting { model?: string; thinking?: ThinkingLevel }

const empty = (): RoleSettingsFile => ({ version: 1, roles: {} });

export function loadRoleSettings(file: string): RoleSettingsFile {
  if (!existsSync(file)) return empty();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new RoleSettingsError(`${file} 不是合法 JSON，请修复或删除后重新执行 /flow-config`);
  }
  const errs = validate('role-settings', raw);
  if (errs.length) throw new RoleSettingsError(`${path.basename(file)} 格式错误（${file}）：${errs.join('；')}`);
  return raw as RoleSettingsFile;
}

export function saveRoleSettings(file: string, settings: RoleSettingsFile, now = new Date()): void {
  const next: RoleSettingsFile = { ...settings, updated_at: now.toISOString() };
  const errs = validate('role-settings', next);
  if (errs.length) throw new RoleSettingsError(`角色设置不合法：${errs.join('；')}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** 设置角色；字段为 undefined 表示清除该字段（回到 workflow.yaml 默认）。 */
export function setRole(settings: RoleSettingsFile, role: string, value: RoleSetting): RoleSettingsFile {
  if (value.model !== undefined && !/^[^/\s]+\/\S+$/.test(value.model)) {
    throw new RoleSettingsError(`模型必须写成 provider/model 形式，例如 workbuddy/glm-5.3-flash（收到：${value.model}）`);
  }
  const entry: RoleSetting = {};
  if (value.model !== undefined) entry.model = value.model;
  if (value.thinking !== undefined) entry.thinking = value.thinking;
  const roles = { ...settings.roles };
  if (Object.keys(entry).length) roles[role] = entry;
  else delete roles[role];
  return { ...settings, roles };
}

export function unsetRole(settings: RoleSettingsFile, role: string): RoleSettingsFile {
  const roles = { ...settings.roles };
  delete roles[role];
  return { ...settings, roles };
}

export interface ResolvedRoleModel {
  model: string | null;
  thinking: ThinkingLevel | null;
  modelSource: 'flow-config' | 'workflow' | 'unset';
  thinkingSource: 'flow-config' | 'workflow' | 'default';
}

const isPlaceholder = (m: string) => /^<.*>$/.test(m.trim());

export function resolveRoleModel(config: FlowConfig, settings: RoleSettingsFile, role: string): ResolvedRoleModel {
  const r = config.role(role);
  const s = settings.roles[role] ?? {};
  let model: string | null = null;
  let modelSource: ResolvedRoleModel['modelSource'] = 'unset';
  if (s.model) { model = s.model; modelSource = 'flow-config'; }
  else if (r.model && !isPlaceholder(r.model)) { model = r.model; modelSource = 'workflow'; }
  let thinking: ThinkingLevel | null = null;
  let thinkingSource: ResolvedRoleModel['thinkingSource'] = 'default';
  if (s.thinking) { thinking = s.thinking; thinkingSource = 'flow-config'; }
  else if (r.thinking) { thinking = r.thinking; thinkingSource = 'workflow'; }
  return { model, thinking, modelSource, thinkingSource };
}
