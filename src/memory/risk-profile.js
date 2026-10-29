// memory/risk-profile — 记忆与边界档案（memberImpressions 风险字段）的纯函数
//
// 契约：docs/module-contract.md（B.1 spec 同 content/memory-* 一族）
// deps：无
// 失败策略：fail-open          （依据：D 表「记忆写坏只少一条提示，不影响收发」）
// 单测：tests/memory-boundary.test.mjs
//
// 为什么存在：亲属称呼被出站守卫拦一次，就该在对方档案上记一笔「已拒绝」，
// 让下次唤醒时模型不用重新谈判（10-26~28 就是靠一次次松口把「乖孩子」磨成「爷爷」）。
// 这段逻辑原本内联在 bridge.js 的 markKinshipRefusalV2 里，混着 getSocialV2State /
// saveSocialV2State / log 三个副作用，没法单独验「私聊记、群聊不记、重复不叠加」。
// 搬到模块后，接缝落在「数据进、数据出」：本模块只做纯计算，状态读写仍留在中枢。
//
// 边界：不读 state、不读时钟、不写文件、不记日志、不发消息、不改传入对象。
//
// 风险档案形状（memberImpressions.<name>）：
//   traits: string[]               // 既有：可读的印象标签（最多 10 条）
//   interactionCount: number       // 既有：互动次数
//   lastSeenAt: number             // 既有：最近一次见到（毫秒）
//   noKinshipTitle: true           // 兼容旧字段：曾要过亲属称呼且已被拒
//   risk: {                        // 新增：风险档案（P2-1）
//     trapHappy: boolean           //   爱下套
//     noGoTopics: string[]         //   不能接的话题
//     refusedTitles: string[]      //   已拒绝的称呼
//   }

export const spec = Object.freeze({
  name: 'memory/risk-profile',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

/** 拒绝亲属称呼时写进档案的可读标签，与 traits 里那条保持一致（只记一条，不叠加）。 */
export const KINSHIP_REFUSAL_TRAIT = '要过亲属称呼，已拒绝';
/** 已拒绝称呼档案里的通用条目：出站守卫只知道是亲属称呼这一类，不知道具体哪个词。 */
export const KINSHIP_REFUSED_TITLE = '亲属称呼';

/** 有原型污染风险的对象键名，写印象前一律拦截（与 bridge.js 既有约定一致）。 */
const FORBIDDEN_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** traits 上限：与 bridge.js 既有印象写入的上限保持一致。 */
const TRAITS_LIMIT = 10;

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
  return list;
}

/**
 * @pure 从最近消息里找最后一个「对方」的称呼（取 sender 或 userId）。
 * 私聊里基本就是对方本人；没找到或全是我方消息时返回空串。
 * 只读，不改入参。
 *
 * @param {Array} recentMessages 会话的 recentMessages（旧→新）
 * @returns {string} 对方名字（可能为空串）
 */
export function latestCounterpartName(recentMessages) {
  const msgs = Array.isArray(recentMessages) ? recentMessages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m && !m.isSelf && (m.sender || m.userId)) return String(m.sender || m.userId);
  }
  return '';
}

/**
 * @pure 记录一次「亲属称呼被拒」。
 *
 * 判定规则（与抽离前的 markKinshipRefusalV2 行为一致）：
 *   1. 群聊不记 —— key 不以 `private:` 开头时直接返回 null；
 *      群里分不清是谁在要称呼，宁可不记，只靠当轮拦截。
 *   2. 找不到对方名字（或名字是原型污染键）返回 null。
 *   3. 重复不叠加 —— traits 与 risk.refusedTitles 都去重，noKinshipTitle 保持 true。
 *
 * @param {object} input
 * @param {string} input.key               会话 key（private:xxx / group:xxx）
 * @param {Array}  [input.recentMessages]  会话最近消息
 * @param {object} [input.memberImpressions] 现有印象表（不会被改写）
 * @returns {null | { name: string, memberImpressions: object }}
 *          不记时返回 null；要记时返回新的印象表（浅拷贝，只替换目标条目）。
 */
export function markKinshipRefusal({ key, recentMessages, memberImpressions }) {
  if (!String(key).startsWith('private:')) return null;

  const name = latestCounterpartName(recentMessages);
  if (!name || FORBIDDEN_NAMES.includes(name)) return null;

  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const old = impressions[name] || {};

  const traits = Array.isArray(old.traits) ? old.traits.slice(0, TRAITS_LIMIT) : [];
  uniquePush(traits, KINSHIP_REFUSAL_TRAIT);

  const risk = (old.risk && typeof old.risk === 'object') ? old.risk : {};
  const refusedTitles = uniquePush(
    Array.isArray(risk.refusedTitles) ? risk.refusedTitles.slice() : [],
    KINSHIP_REFUSED_TITLE
  );

  const nextImpressions = { ...impressions };
  nextImpressions[name] = {
    ...old,
    traits,
    noKinshipTitle: true,
    risk: { ...risk, refusedTitles }
  };
  return { name, memberImpressions: nextImpressions };
}

/**
 * @pure 往某人的风险档案里追加「不能接的话题」。
 * 供未来的写入点（如群聊陷阱识别）复用；重复话题去重，不改入参。
 *
 * @returns {object} 新的 memberImpressions 表（浅拷贝）；名字非法时返回原样拷贝
 */
export function addNoGoTopic(memberImpressions, name, topic) {
  const target = trimText(name);
  const text = trimText(topic);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const next = { ...impressions };
  if (!target || FORBIDDEN_NAMES.includes(target) || !text) return next;

  const old = next[target] || {};
  const risk = (old.risk && typeof old.risk === 'object') ? old.risk : {};
  const noGoTopics = uniquePush(Array.isArray(risk.noGoTopics) ? risk.noGoTopics.slice() : [], text.slice(0, 50));
  next[target] = { ...old, risk: { ...risk, noGoTopics } };
  return next;
}

/**
 * @pure 给某人的风险档案打「爱下套」标记（或撤销）。
 * 不改入参。
 *
 * @returns {object} 新的 memberImpressions 表（浅拷贝）；名字非法时返回原样拷贝
 */
export function setTrapHappy(memberImpressions, name, value) {
  const target = trimText(name);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const next = { ...impressions };
  if (!target || FORBIDDEN_NAMES.includes(target)) return next;

  const old = next[target] || {};
  const risk = (old.risk && typeof old.risk === 'object') ? old.risk : {};
  next[target] = { ...old, risk: { ...risk, trapHappy: value !== false } };
  return next;
}
