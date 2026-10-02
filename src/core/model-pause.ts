// 模型暂停：子进程因模型额度用完、限流、服务不可用而结束时，不判任务失败，而是暂停这个模型的派发。
// 识别规则集中在 classifyUnavailable；判定不了的仍按 run_failed 处理。
// Pi 自己会对限流、过载、5xx、网络错误自动重试（默认 3 次），对额度用完不重试；错误传到这里时已是最终结果。
import type { StateStore } from './state-store.ts';
import type { ModelPause, ModelPauseKind } from './schemas.ts';

export interface Unavailable {
  kind: ModelPauseKind;
  /** 错误原文（截断） */
  reason: string;
  /** 提供方给出的重试等待时间（毫秒）；没有时为 undefined */
  retryAfterMs?: number;
}

/** 额度、余额、订阅用量耗尽：通常要几小时才恢复 */
const QUOTA = /usage.?limit|insufficient_quota|quota.?exceeded|exceeded (?:your )?(?:current )?quota|out of budget|billing|available balance|credit balance|UsageLimitError/i;
/** 限流、过载、服务或网络不可用（本地代理没启动也算） */
const UNAVAILABLE = /rate.?limit|too many requests|overloaded|high demand|service.?unavailable|bad gateway|gateway.?time.?out|ECONNREFUSED|connection.?refused|connection.?error|network.?error|fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|upstream.?connect|ResourceExhausted/i;
/** HTTP 状态码只在模型返回的错误信息里认，stderr 中的数字太容易误判 */
const UNAVAILABLE_STATUS = /\b(?:429|500|502|503|504|520|524|529)\b/;

/** 判断一次 run 的结束原因是否是模型服务不可用；error 是最后一条 assistant 的 errorMessage */
export function classifyUnavailable(error: string | null | undefined, stderrTail = '', exitCode: number | null = null): Unavailable | null {
  const err = error && error !== 'aborted' ? error : '';
  const stderr = exitCode ? stderrTail.slice(-2000) : '';
  const text = `${err}\n${stderr}`;
  let kind: ModelPauseKind | null = null;
  if (QUOTA.test(text)) kind = 'quota';
  else if (UNAVAILABLE.test(text) || UNAVAILABLE_STATUS.test(err)) kind = 'unavailable';
  if (!kind) return null;
  const reason = (err || stderr).replace(/\s+/g, ' ').trim().slice(0, 300);
  const retryAfterMs = parseRetryAfter(text);
  return { kind, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

const UNIT_MS: Record<string, number> = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 };

/** 从错误信息中读出重试等待时间：「Try again in ~42 min」「resets in 2 hours」「retry-after: 30」 */
export function parseRetryAfter(text: string): number | undefined {
  const m = /(?:try again|retry|resets?|reset)\s+(?:in|after)\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (m) return Math.round(Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!);
  const h = /retry-after["']?\s*[:=]\s*["']?(\d+)/i.exec(text);
  if (h) return Number(h[1]) * 1000;
  return undefined;
}

/** 暂时不可用的退避：5 分钟起，连续暂停时加倍，最多 60 分钟 */
export const UNAVAILABLE_BASE_MS = 5 * 60_000;
export const UNAVAILABLE_MAX_MS = 60 * 60_000;

/** 暂停时长；null 表示等用户手动恢复（额度用完且提供方没给恢复时间） */
export function pauseDuration(u: Pick<Unavailable, 'kind' | 'retryAfterMs'>, strikes: number): number | null {
  if (u.retryAfterMs !== undefined) return Math.max(u.retryAfterMs, 60_000);
  if (u.kind === 'quota') return null;
  return Math.min(UNAVAILABLE_BASE_MS * 2 ** Math.max(0, strikes - 1), UNAVAILABLE_MAX_MS);
}

/** 暂停是否仍生效：没有恢复时间（等用户）或恢复时间未到 */
export const pauseActive = (p: ModelPause, now: Date): boolean => !p.retry_after || now.getTime() < Date.parse(p.retry_after);

/** 模型当前生效的暂停；没有时返回 null */
export function activePause(store: StateStore, model: string, now: Date): ModelPause | null {
  const p = store.readModelPauses().pauses.find((x) => x.model === model);
  return p && pauseActive(p, now) ? p : null;
}

export function activePauses(store: StateStore, now: Date): ModelPause[] {
  return store.readModelPauses().pauses.filter((p) => pauseActive(p, now));
}

/** 记录（或延长）模型暂停；同一模型自动恢复后又不可用时 strikes 加 1，退避加倍 */
export async function recordPause(store: StateStore, input: { model: string; role: string; flow: string; task: string; u: Unavailable; now: Date }): Promise<ModelPause> {
  const { model, role, flow, task, u, now } = input;
  const key = `${flow}/${task}`;
  return store.writeModelPauses((f) => {
    const i = f.pauses.findIndex((p) => p.model === model);
    const cur = i >= 0 ? f.pauses[i]! : null;
    // 仍在暂停期内（并发的其他 run 也撞上了）：只合并受影响的角色与任务，不加 strikes
    const stillActive = cur && pauseActive(cur, now);
    const strikes = cur ? (stillActive ? cur.strikes : cur.strikes + 1) : 1;
    const ms = stillActive && cur!.retry_after === undefined ? null : pauseDuration(u, strikes);
    const retryAfter = ms === null ? undefined : new Date(now.getTime() + ms).toISOString();
    const keepQuota = stillActive && cur!.kind === 'quota';
    const next: ModelPause = {
      model, kind: keepQuota ? 'quota' : u.kind, reason: keepQuota ? cur!.reason : u.reason, since: stillActive ? cur!.since : now.toISOString(),
      ...(retryAfter ? { retry_after: stillActive && cur!.retry_after && cur!.retry_after > retryAfter ? cur!.retry_after : retryAfter } : {}),
      strikes,
      roles: [...new Set([...(cur?.roles ?? []), role])],
      tasks: [...new Set([...(cur?.tasks ?? []), key])],
    };
    if (i >= 0) f.pauses[i] = next; else f.pauses.push(next);
    return next;
  }, { actor: 'dispatcher', flow, task, reason: `模型 ${model} ${u.kind === 'quota' ? '额度用完' : '暂时不可用'}，暂停派发`, data: { model_pause: model, kind: u.kind } });
}

/** 解除暂停（用户恢复，或模型已成功响应）；返回被解除的记录 */
export async function clearPause(store: StateStore, model: string, actor: string, reason: string): Promise<ModelPause | null> {
  if (!store.readModelPauses().pauses.some((p) => p.model === model)) return null;
  return store.writeModelPauses((f) => {
    const i = f.pauses.findIndex((p) => p.model === model);
    return i >= 0 ? f.pauses.splice(i, 1)[0]! : null;
  }, { actor, reason: `模型 ${model} 恢复派发：${reason}`, data: { model_resume: model } });
}

/** 用户输入的模型名：完整 provider/id，或只写 id（唯一匹配时） */
export function matchPausedModel(pauses: readonly ModelPause[], name: string): ModelPause[] {
  if (name === 'all') return [...pauses];
  const exact = pauses.filter((p) => p.model === name);
  if (exact.length) return exact;
  return pauses.filter((p) => p.model.split('/').slice(1).join('/') === name);
}

const KIND_LABEL: Record<ModelPauseKind, string> = { quota: '额度用完', unavailable: '暂时不可用（限流、过载或服务连不上）' };

/** 给人看的一行说明 */
export function describePause(p: ModelPause, now: Date): string {
  const when = p.retry_after
    ? `约 ${Math.max(1, Math.round((Date.parse(p.retry_after) - now.getTime()) / 60_000))} 分钟后自动恢复`
    : '需要你手动恢复';
  return `模型 ${p.model} ${KIND_LABEL[p.kind]}，已暂停派发（${when}）；影响 ${p.roles.join('、')}：${p.tasks.join('、')}。原因：${p.reason}`;
}
