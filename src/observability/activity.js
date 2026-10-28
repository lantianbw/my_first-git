// observability/activity — 审计日志的单行格式化与窗口统计
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （optional：无）
// 失败策略：fail-open            （依据：D 表 obs/activity「审计轨迹缺失不阻断发送」）
// 单测：tests/activity.test.mjs
//
// 为什么需要：bridge 的 appendActivity 只写一行纯文本，控制台要看「这段时间谁触发了什么」
// 得自己 grep。这里把「一行怎么写、怎么换行、key 怎么脱敏、窗口内怎么汇总」定下来，
// 日志与新看板共用同一口径。
// 边界：不写文件、不读时钟（at/now 都由入参给）、不 import bridge；纯计算。
// 复用：key 脱敏直接 import session/key 的 @pure redactKey，避免两处遮法不一致。

import { redactKey } from '../session/key.js';

export const spec = Object.freeze({
  name: 'observability/activity',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
const NEWLINE_MARK = '⏎';

const pad = (value) => String(value).padStart(2, '0');

/** 本地时间（与 bridge 的 localClock 同口径，不用 toISOString 的 UTC）。 */
function clockText(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 内部换行一律换成 ⏎，保证一条日志只占一行。 */
function oneLine(value) {
  return String(value ?? '').replace(/\r\n|[\r\n]/g, NEWLINE_MARK).trim();
}

function redact(value) {
  if (value === undefined || value === null || value === '') return '';
  return redactKey(value);
}

function detailText(entry) {
  return oneLine(entry?.detail);
}

/**
 * @pure 单行审计文本：`时间 | kind | 脱敏 key | 详情`；没有的段直接省略。
 * at 缺失时退回 now（都是入参，不读 Date.now）。
 */
export function formatActivity({ at, kind, key, detail, now } = {}) {
  const stamp = Number(at);
  const fallback = Number(now);
  const atMs = Number.isFinite(stamp) && stamp > 0
    ? stamp
    : (Number.isFinite(fallback) && fallback > 0 ? fallback : 0);

  const parts = [clockText(atMs), oneLine(kind) || 'info'];
  const keyText = redact(key);
  if (keyText) parts.push(keyText);
  const text = detailText({ detail });
  if (text) parts.push(text);
  return parts.join(' | ');
}

/**
 * @pure 只统计 [now - windowMs, now] 内的条目。
 * byKey 用脱敏后的 key 计数（这份汇总本身就会进日志/看板）。
 * latest 是最新一条的格式化单行文本，没有条目时为 ''。
 */
export function summarize(entries, { windowMs, now } = {}) {
  const at = Number(now);
  const nowMs = Number.isFinite(at) ? at : 0;
  const span = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_WINDOW_MS;

  const byKind = {};
  const byKey = {};
  let total = 0;
  let latestAt = Number.NEGATIVE_INFINITY;
  let latest = '';

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const time = Number(entry.at);
    if (!Number.isFinite(time) || time < nowMs - span || time > nowMs) continue;

    total += 1;
    const kind = oneLine(entry.kind) || 'info';
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    const keyText = redact(entry.key);
    if (keyText) byKey[keyText] = (byKey[keyText] ?? 0) + 1;

    if (time >= latestAt) {
      latestAt = time;
      latest = formatActivity({ ...entry, now: nowMs });
    }
  }

  return { total, byKind, byKey, latest };
}
