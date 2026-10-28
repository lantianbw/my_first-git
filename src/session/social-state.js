// session/social-state — 二代仿真会话状态的「读侧归一」与「写盘前合并裁剪」
//
// 契约：docs/module-contract.md v1.1（B.1 spec + handle / D 表 session/social-state「同 session/store」/ H2 locked）
// deps：无                      （optional：无）
// 失败策略：fail open  —— 依据 D 表 session/store 行：读失败降级为可用空态、绝不回写覆盖；
//                        写失败的 fail closed 由落盘方（persist/atomic + 中枢）承担，本模块不做 IO。
// 单测：tests/session-social-state.test.mjs
//
// 为什么需要：social-v2.json 是「AI 记得刚才聊了什么」的唯一载体。它的结构归一两处内嵌在
// bridge.js（loadSocialV2State 的逐字段三元组、saveSocialV2State 的逐字段 slice），两边字段
// 清单各写一遍 —— 加一个字段要同时改两处、漏一处就是「读回来是 undefined、写出去被丢掉」，
// 而且都要起半个桥才能验证。抽成纯函数后可离线断言「空文件 = 完整默认形状」「脏类型不炸」
// 「写盘前一定裁剪到上限」这三条最容易回归的性质。
//
// 边界：不读文件、不写文件、不拼 state/ 路径（那一份 IO 与原子写留在中枢）；不生成 agentToken
// （令牌是随机数，按下发约束归中枢）；不读 cfg（wakeConfig 的默认值由中枢算好，经 wakeDefaults
// 注入，模块不发明配置语义）；不碰时钟与随机数；不 console、不 import 任何东西。
//
// 与旧实现的对应关系：
//   · normalizeSocialState  ← loadSocialV2State 里 `const st = {...}` 那一整段（:11348-11389）
//     加 triggers 白名单过滤（:11353 / pickWakeTriggersV2 :11124）与 speakerIds 归一
//     （:11392 / normalizeSpeakerIdsV2 :11103）。
//   · mergeSocialPatch      ← saveSocialV2State 里逐字段 slice 的上限（:11447-11470），
//     外加「patch 覆盖、未提到的字段保留」的合并语义。
//
// 三处刻意的边界差异（都是为了守住「不读 cfg / 不产随机数 / 不改语义」）：
//   1. agentToken 缺失时给空串，不生成随机令牌 —— 旧实现此处 crypto.randomBytes(16) 并去重，
//      令牌生成与跨会话去重都上移中枢。
//   2. wakeConfig 的默认值不在此发明：不传 wakeDefaults 时只做结构归一，绝不像
//      defaultWakeConfigV2 那样读 cfg、算 sleepUntil。
//   3. activeTopics 一律原样保留（线上现在就是 0 条）。归一不造话题、不清话题、不改字段名 ——
//      要改这块的业务语义请单独提案，别混在「搬结构」里。
//
// 已知的既有口径（照搬，不"修"）：lastReadThroughSeq 用 Math.min(值, lastUnreadSeq) 夹住，
// 而 lastUnreadSeq 缺省是 0 —— 于是老文件里一条只有 lastReadThroughSeq 的记录会被夹成 0。

/** 唤醒触发器的**唯一**合法字段集合（与 bridge.js:11123 同一份清单）。 */
export const WAKE_TRIGGER_KEYS = Object.freeze([
  'atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability'
]);

/** 状态里所有「数组形」字段。缺省、类型错都归空数组。 */
const ARRAY_FIELDS = Object.freeze([
  'recentMessages', 'unread', 'wakeTimes', 'sendTimes',
  'proactiveWakeTimes', 'stickerCollectTimes', 'activeTopics', 'pendingThoughts'
]);

/** 运行期句柄字段：存在就原样保留（清掉会让中枢手里的定时器失联），缺失补 null。 */
const HANDLE_FIELDS = Object.freeze(['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer']);

/**
 * 写盘前各字段的保留上限，逐条对齐 saveSocialV2State（bridge.js:11447-11470）。
 * 超出时保留**最后** N 条：时间序列里新值永远在尾部。
 */
export const SAVE_LIMITS = Object.freeze({
  recentMessages: 200,
  unread: 100,
  wakeTimes: 200,
  sendTimes: 500,
  proactiveWakeTimes: 50,
  stickerCollectTimes: 500,
  activeTopics: 50,
  pendingThoughts: 50
});

/** 出现的键一律丢弃：JSON.parse 出来的自有 __proto__ 是原型链污染的入口。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const fail = (code, error) => ({ ok: false, code, error });

/** 普通对象判定：null / 数组 / 标量 都算「不是一张表」。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 旧实现里 `Number(x) || 0` 的同一口径：NaN / 空串 / null 都归 0。 */
function num(value) {
  return Number(value) || 0;
}

/**
 * 只保留白名单键的 triggers（bridge.js:11124 pickWakeTriggersV2 的同一语义）。
 *
 * @pure
 * @param {unknown} source 状态里的 triggers
 * @param {unknown} fallback 缺省值来源（通常是注入的 wakeDefaults.triggers）
 */
function pickWakeTriggers(source, fallback) {
  const src = isRecord(source) ? source : {};
  const fb = isRecord(fallback) ? fallback : {};
  const out = {};
  for (const name of WAKE_TRIGGER_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
    // 显式的 null 也照抄：旧实现只跳过 undefined。
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * 指定群友唤醒名单归一（bridge.js:11103 normalizeSpeakerIdsV2 的同一语义）。
 * 只留正整数字符串、去重、上限 20。
 *
 * @pure
 */
function normalizeSpeakerIds(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const item of rawList) {
    const s = String(item ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}

/** memberImpressions 只做一层浅拷贝并丢掉危险键（不深拷：值由调用方持有）。 */
function sanitizeImpressions(value) {
  const out = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 把一份读到的会话状态归一成固定形状。
 *
 * 入参可以是 JSON.parse 的结果、旧版本残留、甚至脏数据 —— 一律给出**可用**状态，不抛错
 * （D 表：读 fail open）。返回新对象，入参一个字段都不改。
 *
 * @pure
 * @param {unknown} value 持久化里的单个会话状态
 * @param {{ wakeDefaults?: object, key?: string }} [opts]
 *   wakeDefaults —— 中枢用 cfg 算好的唤醒默认值（本模块不读 cfg）
 *   key          —— 规范会话键；`private:*` 会清空指定群友唤醒名单
 * @returns {object} 归一后的状态（字段清单见 expectedDefaults）
 */
export function normalizeSocialState(value, opts = {}) {
  const src = isRecord(value) ? value : {};
  const wakeDefaults = isRecord(opts?.wakeDefaults) ? opts.wakeDefaults : null;
  const key = typeof opts?.key === 'string' ? opts.key : '';

  // wakeConfig：默认值在下、状态值在上；triggers 单独走白名单，避免旧文件里的垃圾键被带进内存。
  const wcSrc = isRecord(src.wakeConfig) ? src.wakeConfig : {};
  const wakeConfig = { ...(wakeDefaults ?? {}), ...wcSrc };
  const triggers = pickWakeTriggers(wcSrc.triggers, wakeDefaults?.triggers);
  // 旧实现在加载后**总是**赋值 speakerIds（缺失即 []），这里保持同一口径：下游可以无脑读数组。
  triggers.speakerIds = key.startsWith('private:') ? [] : normalizeSpeakerIds(triggers.speakerIds);
  wakeConfig.triggers = triggers;

  const out = { wakeConfig };
  for (const field of ARRAY_FIELDS) {
    // 复制一层：调用方后续 push/splice 不该反向改到入参（JSON 里的原数组仍被引用，不深拷）。
    out[field] = Array.isArray(src[field]) ? src[field].slice() : [];
  }

  out.lastWakeReason = String(src.lastWakeReason ?? '');
  out.lastAiReplyAt = num(src.lastAiReplyAt);
  out.lastActionAt = num(src.lastActionAt);
  out.agentToken = src.agentToken ? String(src.agentToken) : '';
  out.bootstrapSent = !!src.bootstrapSent;

  for (const field of HANDLE_FIELDS) out[field] = src[field] ?? null;

  out.lastIncomingAt = num(src.lastIncomingAt);
  out.preSleepWaitSatisfiedAt = num(src.preSleepWaitSatisfiedAt);
  out.preSleepWaitObservedAt = num(src.preSleepWaitObservedAt);
  out.preSleepWaitAccumMs = num(src.preSleepWaitAccumMs);
  out.lastUnreadSeq = num(src.lastUnreadSeq);
  // 读水位不能超过已读水位：旧实现在这里做 min 夹取，保持不动（含"缺省 0 会夹成 0"的老口径）。
  out.lastReadThroughSeq = Number.isSafeInteger(src.lastReadThroughSeq) && src.lastReadThroughSeq >= 0
    ? Math.min(src.lastReadThroughSeq, out.lastUnreadSeq)
    : 0;

  // 已在内存里的 Set 要原样带过来：mergeSocialPatch 会在保存前跑一遍归一，重置它等于让 AI 忘掉看过哪些消息。
  out.modelSeenSeqs = src.modelSeenSeqs instanceof Set ? new Set(src.modelSeenSeqs) : new Set();
  out.memberImpressions = sanitizeImpressions(src.memberImpressions);

  return out;
}

/**
 * 把一次局部更新合并进当前状态，并按写盘上限裁剪。
 *
 * 语义：
 *   · patch 里**提供了**的字段覆盖 current；显式 undefined 视为"未提供"（保留原值）。
 *   · wakeConfig 只合并一层，patch 给 `{mode}` 不会把 triggers / wakeCount 抹掉。
 *   · 结果再走一遍归一（patch 里的脏类型兜得住），最后按 SAVE_LIMITS 保留尾部 N 条。
 *   · 不改入参；返回新对象。
 *
 * @pure
 * @param {unknown} current 当前状态（可以是上一次 merge 的结果）
 * @param {unknown} patch 局部更新
 * @returns {object} 合并并裁剪后的状态
 */
export function mergeSocialPatch(current, patch) {
  const base = normalizeSocialState(current);
  const p = isRecord(patch) ? patch : {};

  const merged = { ...base };
  for (const [k, v] of Object.entries(p)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (v === undefined) continue;
    if (k === 'wakeConfig' && isRecord(v)) {
      merged.wakeConfig = { ...base.wakeConfig, ...v };
      continue;
    }
    merged[k] = v;
  }

  // 用 base.wakeConfig 当默认值：patch 没提到的配置项回落到当前值，而不是被清空。
  const out = normalizeSocialState(merged, { wakeDefaults: base.wakeConfig });

  for (const [field, limit] of Object.entries(SAVE_LIMITS)) {
    out[field] = Array.isArray(out[field]) ? out[field].slice(-limit) : [];
  }
  return out;
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx。
 *   normalize — 入参 { state, wakeDefaults?, key? } → { ok:true, value:归一后的状态 }
 *   merge     — 入参 { current, patch }             → { ok:true, value:合并裁剪后的状态 }
 *
 * @param {object} _ctx
 * @param {{ action?: 'normalize'|'merge', state?: unknown, wakeDefaults?: object, key?: string, current?: unknown, patch?: unknown }} [args]
 */
export function handle(_ctx, args) {
  const action = args?.action;
  if (action === 'normalize') {
    return { ok: true, value: normalizeSocialState(args?.state, { wakeDefaults: args?.wakeDefaults, key: args?.key }) };
  }
  if (action === 'merge') {
    return { ok: true, value: mergeSocialPatch(args?.current, args?.patch) };
  }
  return fail('INVALID_ARGS', `未知动作：${String(action)}（只支持 normalize / merge）`);
}

export const spec = Object.freeze({
  name: 'session/social-state',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：仿真状态是「AI 记得刚才聊了什么」的载体，关掉会让它反复发言、重复自我介绍。
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});
