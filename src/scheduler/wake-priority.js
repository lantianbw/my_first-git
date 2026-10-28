// scheduler/wake-priority — 判定一条入站消息该不该唤醒、优先级多高
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `scheduler/wake` 行——漏一次唤醒，下条消息仍会触发投递，不构成静默故障）
// 单测：tests/wake-priority.test.mjs
//
// 为什么需要：bridge.js:13578 的 evaluateWakeTriggerV2 把「该不该叫醒」和「优先级多高」
// 混在八十行里，中间还夹着 Date.now()、Math.random()、作息门控和会话状态，既写不了断言
// 也没法单独调。这里把判定抽干净：时钟、随机、忙碌状态一律由调用方算好传进来，
// 于是「@ 到底压不压得住概率」「冷却期内 owner 说话要不要叫」这种问题，
// 都能用一行断言问清楚，而不是等线上复盘。
//
// 边界：只判断。不排期、不发消息、不写状态、不读时钟、不掷骰子、不 import bridge.js。
// 同一入参永远同一结论；模块内没有任何跨调用状态。
//
// 优先级刻度沿用 bridge.js:14174 的 WAKE_PRIORITY（private/atMention/question/
// nameMention/keyword/anyMessage），只补了 probability=10——原表里没有这一项，
// 靠 ?? 0 兜底，等于「概率触发永远垫底且和未命中同分」，这里把它显式化。

export const spec = Object.freeze({
  name: 'scheduler/wake-priority',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

/** 优先级刻度。同一档位内数值相同，跨档位严格递减，便于直接比大小做合并升级。 */
const PRIORITY = Object.freeze({
  owner: 100, // 私聊 / owner 直接说话，等同原表 private
  atMention: 90, // 被 @ 或被引用
  question: 80, // 冲着 AI 来的提问
  nameMention: 70, // 文本里出现机器人昵称
  keyword: 60, // 关键词命中（reason 会带上具体词）
  anyMessage: 50, // anyMessage 全量触发
  probability: 10, // 概率触发（骰子由调用方掷）
  blocked: 0 // 不唤醒时统一 0，避免调用方误把「本该 90 但被拒」当成 90 用
});

/** 冷却窗口默认值：分钟。桥里只有 8s 的 batchWindow，挡不住「同一句话触发两次」。 */
const DEFAULT_COOLDOWN_MINUTES = 2;

/** 纯英文/数字的短词（DS、R1）要走词边界，否则 ADS / BDSM / DSL 全会误命中。 */
const SHORT_KEYWORD_RE = /^[a-z0-9]+$/;

/** 冷却分钟数：只认非负有限数，其余回默认；显式传 0 表示不要冷却。 */
function cooldownOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MINUTES;
}

/** 取第一个命中的关键词，返回原样大小写的词（用于 reason）。 */
function firstKeywordHit(keywords, lower) {
  if (!Array.isArray(keywords)) return null;
  for (const raw of keywords) {
    const word = String(raw ?? '').trim();
    if (!word) continue;
    const needle = word.toLowerCase();
    if (SHORT_KEYWORD_RE.test(needle) && needle.length <= 4) {
      if (new RegExp(`\\b${needle}\\b`).test(lower)) return word;
    } else if (lower.includes(needle)) {
      return word;
    }
  }
  return null;
}

/**
 * @pure 按「越具体越优先」的顺序判定触发类型，返回 { priority, reason } 或 null。
 *
 * 与 bridge 的一处**有意偏离**：原实现把 anyMessage 放在最前面（bridge.js:13592），
 * 于是开了 anyMessage 的会话里，@ 和关键词也会被降级成 50。这里改成按 specificity
 * 排序，anyMessage 只作为兜底。合并窗口的升级逻辑本来就按优先级取高，
 * 这个偏离只是让它在一开始就选对，不改变「谁该被叫醒」的结论。
 */
function detect(triggers, lower, flags) {
  if (flags.isOwner === true) {
    return { priority: PRIORITY.owner, reason: 'owner 直接说话' };
  }

  if (flags.isMentioned === true && triggers.atMention !== false) {
    return { priority: PRIORITY.atMention, reason: '被 @ 或被引用' };
  }

  if (flags.isQuestion === true && triggers.question !== false) {
    return { priority: PRIORITY.question, reason: '冲着 AI 的提问' };
  }

  const nickname = typeof triggers.nickname === 'string' ? triggers.nickname.trim() : '';
  if (triggers.nameMention !== false && nickname) {
    const needle = nickname.toLowerCase();
    // 原实现同时认 "@昵称" 和裸昵称（bridge.js:13601），这里保持一致。
    if (lower.includes(`@${needle}`) || lower.includes(needle)) {
      return { priority: PRIORITY.nameMention, reason: `提到昵称「${nickname}」` };
    }
  }

  const keyword = firstKeywordHit(triggers.keywords, lower);
  if (keyword) return { priority: PRIORITY.keyword, reason: `关键词命中「${keyword}」` };

  if (triggers.anyMessage === true) {
    return { priority: PRIORITY.anyMessage, reason: '任意消息命中（anyMessage）' };
  }

  // 只认调用方掷好的布尔结果。triggers.probability 那串 0~1 的配置**不参与判定**，
  // 否则本函数就得自己掷骰子，测试再也不可能稳定。
  if (triggers.probabilityHit === true) {
    return { priority: PRIORITY.probability, reason: '概率命中（调用方已掷骰）' };
  }

  return null;
}

/**
 * @pure 判定一条消息该不该唤醒。
 *
 * @param {object}  context
 * @param {object}  [context.triggers]             唤醒配置（atMention / nameMention / nickname / keywords / question / anyMessage / probabilityHit / cooldownMinutes）
 * @param {string}  [context.message]              消息纯文本（不含 `[引用 …]` 前缀）
 * @param {boolean} [context.isOwner]              owner 直接说话
 * @param {boolean} [context.isBusy]               会话正忙（有待发唤醒 / 回合在跑）
 * @param {number}  [context.minutesSinceLastWake] 距上次唤醒的分钟数，缺省视为从未唤醒
 * @param {boolean} [context.isMentioned]          调用方判定的 @ / 引用命中
 * @param {boolean} [context.isQuestion]           调用方判定的「冲着 AI 提问」
 * @returns {{ wake: boolean, priority: number, reason: string }}
 */
export function priorityOf(context = {}) {
  const { triggers, message, isOwner, isBusy, minutesSinceLastWake, isMentioned, isQuestion } = context ?? {};

  const config = triggers && typeof triggers === 'object' ? triggers : {};
  const lower = String(message ?? '').toLowerCase();

  const hit = detect(config, lower, { isOwner, isMentioned, isQuestion });

  // 忙时不叫醒：原逻辑会把原因压进 pendingWakeReasons 等回合结束再重放，
  // 那是调度器的活；这里只负责说「现在别叫」。
  if (isBusy === true) {
    return {
      wake: false,
      priority: PRIORITY.blocked,
      reason: `会话正忙，暂不唤醒（本次本应：${hit ? hit.reason : '无触发'}）`
    };
  }

  const cooldown = cooldownOf(config.cooldownMinutes);
  const since = Number(minutesSinceLastWake);
  // 负数说明时钟或数据坏了，不能让它把机器人永久静音，按「未知」放行。
  if (Number.isFinite(since) && since >= 0 && since < cooldown) {
    return {
      wake: false,
      priority: PRIORITY.blocked,
      reason: `距上次唤醒仅 ${since} 分钟，冷却 ${cooldown} 分钟内不重复唤醒`
    };
  }

  if (!hit) {
    return { wake: false, priority: PRIORITY.blocked, reason: '无触发条件命中，不唤醒' };
  }

  return { wake: true, priority: hit.priority, reason: hit.reason };
}

/**
 * 契约门面（B.1）。本模块 deps 为空，handle 不读 ctx，只把 args 转给 priorityOf；
 * 存在意义是让中枢能按统一形状装配，而不是让调用方特判一个纯函数。
 *
 * @param {object} _ctx 中枢注入的上下文（本模块不使用）
 * @param {object} args 同 priorityOf 的入参
 * @returns {{ ok: true, value: { wake: boolean, priority: number, reason: string } }}
 */
export function handle(_ctx, args) {
  return { ok: true, value: priorityOf(args) };
}
