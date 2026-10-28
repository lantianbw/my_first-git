// guards/length — 长度软干预：判定「拦不拦、说什么」，以及本轮重试额度的流转
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/length 行）
// deps：无                      （阈值、发送历史、时钟、重试计数全部由调用方传入）
// 失败策略：fail-open            （依据：D 表 guards/length 行——纯软干预，异常一律放行）
// 单测：tests/length.test.mjs
//
// 为什么需要：判定与记账原来内嵌在 bridge.js 的 `guardLengthNudgeV2()` 里，重试计数是闭包里的
// 模块级 `Map`（`lengthNudgeRetriesV2`）——改阈值要动 1.6 万行中枢，「本轮拦过没有」藏在闭包里
// 无法单测，跨调用状态也违反 F.2。搬出来后分两层：`evaluateLengthNudge()` 只判文本；
// `guardLengthNudge()` 负责解析配置分节、算「最近发过」、把重试计数由入参读进、由返回值带走。
// 模块自己不留任何状态，调用方（中枢）仍是唯一持有 Map 的人。
//
// 边界：不读 cfg（配置分节原样传入）、不读时钟（now 传入）、不记状态、不发消息、不改写文本、
// 不写日志（只返回 activity 字符串，落日志由调用方做）。异常不抛给调用方：降级放行，并在
// error 字段里带回可读原因供调用方记账。

export const spec = Object.freeze({
  name: 'guards/length',
  version: '1.1.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze(['outbound.length']),
  // 阈值属体验参数，只有主人该调；AI 自调等于可以无限刷屏。
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

export const DEFAULTS = Object.freeze({
  maxSingleChars: 40,
  multiThreshold: 12,
  recentWindowMs: 600_000
});

const toList = (messages) => (Array.isArray(messages) ? messages : [messages]).map((m) => String(m ?? ''));

const isPlainObject = (value) => value !== null && typeof value === 'object';

/** 本轮已拒次数：非数/负数/NaN 一律按 0（旧实现是 `map.get(key) || 0`）。 */
const toRetries = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * @param {object} input
 * @param {string|string[]} input.messages        待发的一条或多条文本
 * @param {number} [input.maxSingleChars=40]      单条上限
 * @param {number} [input.multiThreshold=12]      多条模式下每条的最小长度阈值
 * @param {boolean} [input.sentRecently=false]    窗口期内是否已经发过
 * @param {number} [input.usedThisRound=0]        本轮唤醒内已拒绝过几次
 * @returns {{ok:true} | {ok:false, kind:'single'|'multi', reason:string, length?:number, count?:number, threshold?:number}}
 */
export function evaluateLengthNudge({
  messages,
  maxSingleChars = DEFAULTS.maxSingleChars,
  multiThreshold = DEFAULTS.multiThreshold,
  sentRecently = false,
  usedThisRound = 0
} = {}) {
  const maxSingle = Number(maxSingleChars) > 0 ? Number(maxSingleChars) : DEFAULTS.maxSingleChars;
  const threshold = Number(multiThreshold) > 0 ? Number(multiThreshold) : DEFAULTS.multiThreshold;
  const list = toList(messages);

  for (const msg of list) {
    if (msg.length > maxSingle) {
      return {
        ok: false,
        kind: 'single',
        length: msg.length,
        reason: `outbound guard: 这条 ${msg.length} 字太长了（上限 ${maxSingle} 字），请拆成几条自然的短句或精简后重发`
      };
    }
  }

  if (list.length >= 2 && list.every((m) => m.length > threshold) && sentRecently && Number(usedThisRound) < 1) {
    return {
      ok: false,
      kind: 'multi',
      count: list.length,
      threshold,
      reason: `outbound guard: 本轮建议只发一条短句——10 分钟内已发过且这次每条都超过 ${threshold} 字；请合并成一条短句再发（重试一次仍偏长会放行）`
    };
  }

  return { ok: true };
}

/**
 * 守卫入口：从 `guardLengthNudgeV2(key, st, messages)` 原样搬来，只把三者改成入参——
 * 配置分节（原来读 cfg.socialV2.guard.lengthNudge）、时钟（原来 Date.now()）、
 * 本轮计数（原来是模块级 Map）。
 *
 * 行为与旧实现逐项对齐：
 *   1. 分节关闭（`false` 或 `{enabled:false}`）→ 直接放行，不动计数；
 *   2. 单条超长 → 拦，**不**消耗重试额度（旧实现只在 multi 分支 set）；
 *   3. 多条偏长 + 窗口内发过 + 本轮未拦过 → 拦一次，计数 +1；
 *   4. 已拦过一次 → 放行（防死锁）；调用方在下一轮唤醒时把计数清零。
 *
 * @param {object} input
 * @param {string} input.key                会话 key（只用于拼 activity 文案）
 * @param {string|string[]} input.messages  待发文本
 * @param {object|boolean|null} [input.section] cfg.socialV2.guard.lengthNudge 原样传入
 * @param {number[]} [input.sendTimes=[]]   该会话最近的发送时间戳
 * @param {number} input.now                毫秒时间戳（必填，由调用方注入）
 * @param {number} [input.retries=0]        本轮已拒次数（调用方持有）
 * @returns {{ok:true, reason:'', retries:number, degraded?:true, error?:string}
 *          |{ok:false, kind:'single'|'multi', reason:string, retries:number, length?:number, count?:number, threshold?:number, activity:string}}
 */
export function guardLengthNudge(options) {
  let used = 0;
  try {
    const { key = '', messages, section, sendTimes, now, retries = 0 } = options ?? {};
    used = toRetries(retries);

    // 旧 guardSectionEnabledV2：对象看 enabled !== false，布尔看 !== false，缺失视为开。
    const enabled = isPlainObject(section) ? section.enabled !== false : section !== false;
    if (!enabled) return { ok: true, reason: '', retries: used };

    const tune = isPlainObject(section) ? section : {};
    const ms = Number(now);
    if (!Number.isFinite(ms)) throw new TypeError('now 必须是毫秒时间戳（由调用方注入）');

    // 旧实现是 (st?.sendTimes || []).some(...)：null/undefined 当空数组；其它非数组属入参违约。
    const times = sendTimes ?? [];
    if (!Array.isArray(times)) throw new TypeError('sendTimes 必须是数组');

    const windowMs = Number(tune.recentWindowMs) > 0 ? Number(tune.recentWindowMs) : DEFAULTS.recentWindowMs;
    const sentRecently = times.some((t) => ms - Number(t) < windowMs);

    const verdict = evaluateLengthNudge({
      messages,
      maxSingleChars: tune.maxSingleChars,
      multiThreshold: tune.multiThreshold,
      sentRecently,
      usedThisRound: used
    });
    if (verdict.ok) return { ok: true, reason: '', retries: used };

    if (verdict.kind === 'single') {
      return {
        ok: false,
        kind: 'single',
        reason: verdict.reason,
        length: verdict.length,
        retries: used,
        activity: `[guard] length-nudge·单条超长 (${key}): ${verdict.length} 字`
      };
    }

    return {
      ok: false,
      kind: 'multi',
      reason: verdict.reason,
      count: verdict.count,
      threshold: verdict.threshold,
      retries: used + 1,
      activity: `[guard] length-nudge (${key}): ${verdict.count} 条均超 ${verdict.threshold} 字`
    };
  } catch (error) {
    // 软干预：判定失败绝不能挡住发送（D 表 fail-open）。错误不吞——放在 error 里交给调用方记账。
    return {
      ok: true,
      reason: '',
      retries: used,
      degraded: true,
      error: `length-nudge 判定异常，已放行：${error?.message ?? error}`
    };
  }
}
