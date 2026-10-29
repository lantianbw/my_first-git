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
//   risk: {                        // 风险档案（P2-1）
//     trapHappy: boolean           //   爱下套
//     noGoTopics: string[]         //   不能接的话题
//     refusedTitles: string[]      //   已拒绝的称呼
//   }
//   evidence: Array<{              // 原话证据（M13）：最近 3 条、新的在前
//     quote: string                //   原话（压空白后截断 40 字）
//     at: number                   //   时间戳（毫秒）
//     key: string                  //   来源会话（private:xxx / group:xxx）
//     kind: string                 //   'kinship' | 'trap' | 'topic' | 'affection'
//   }>
// 兼容：没有 evidence 的老数据照旧读写；本模块只在拿到非空原话时才补 evidence，
// 不写空数组、不补默认值。

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

/** 每条印象最多保留几条原话证据（新的在前，超出的淘汰最旧）。 */
export const EVIDENCE_LIMIT = 3;
/** 原话截断长度（压空白后）。提示词预算有限，只留够判断语境的一句。 */
export const EVIDENCE_QUOTE_MAX_CHARS = 40;
/** 证据类型：这条原话支撑哪类判断。 */
export const EVIDENCE_KINDS = Object.freeze(['kinship', 'trap', 'topic', 'affection']);

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

/** 压掉换行/连续空白并裁到 40 字；非字符串一律按空串处理。 */
export function normalizeEvidenceQuote(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.slice(0, EVIDENCE_QUOTE_MAX_CHARS);
}

/**
 * @pure 把任意落盘形态的一条证据归一成 { quote, at, key, kind }。
 * 形状不合法（不是对象 / 原话为空）返回 null，由调用方跳过。
 */
export function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const quote = normalizeEvidenceQuote(raw.quote);
  if (!quote) return null;
  const at = Number(raw.at);
  return {
    quote,
    at: Number.isFinite(at) ? at : 0,
    key: typeof raw.key === 'string' ? raw.key : '',
    kind: typeof raw.kind === 'string' ? raw.kind : ''
  };
}

/**
 * @pure 追加一条证据：新的在前、同 quote 去重、最多 3 条（超出的淘汰最旧）。
 * 同句再次出现时把它提到最前（保留最新时间），不产生第二条。
 * 返回新数组，不改入参。
 *
 * @param {Array} [list] 现有 evidence（新的在前）
 * @param {{quote:string, at?:number, key?:string, kind?:string}} entry 新证据
 * @returns {Array<{quote:string, at:number, key:string, kind:string}>}
 */
export function appendEvidence(list, entry) {
  const deduped = [];
  for (const value of Array.isArray(list) ? list : []) {
    const item = normalizeEvidence(value);
    if (!item) continue;
    if (deduped.some((x) => x.quote === item.quote)) continue;
    deduped.push(item);
  }
  const next = normalizeEvidence(entry);
  if (!next) return deduped.slice(0, EVIDENCE_LIMIT);
  const rest = deduped.filter((x) => x.quote !== next.quote);
  return [next, ...rest].slice(0, EVIDENCE_LIMIT);
}

/**
 * @pure 读「最近 1 条」原话：只看 evidence 里第一条有效记录（数据已按新的在前排好）。
 * 传了 kinds 时，最新一条的 kind 不在其中就返回空串——保证一条印象最多渲染一句原话，
 * 且这句原话只归它支撑的那类结论（risk 或 affection），不会两边重复。
 * 没有 evidence / 全是脏数据时返回空串（老数据照旧渲染）。
 *
 * @param {Array} [evidence]
 * @param {string[]} [kinds]
 * @returns {string}
 */
export function latestEvidenceQuote(evidence, kinds) {
  const list = Array.isArray(evidence) ? evidence : [];
  let newest = null;
  for (const value of list) {
    newest = normalizeEvidence(value);
    if (newest) break;
  }
  if (!newest) return '';
  if (Array.isArray(kinds) && kinds.length && !kinds.includes(newest.kind)) return '';
  return newest.quote;
}

/**
 * @pure 从最近消息里找最后一个「对方」以及那条消息（原话 / 时间）。
 * 私聊里基本就是对方本人；没找到或全是我方消息时返回 null。
 * 只读，不改入参。
 *
 * @param {Array} recentMessages 会话的 recentMessages（旧→新）
 * @returns {null | { name: string, text: string, at: number }}
 */
export function latestCounterpartMessage(recentMessages) {
  const msgs = Array.isArray(recentMessages) ? recentMessages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m && !m.isSelf && (m.sender || m.userId)) {
      return {
        name: String(m.sender || m.userId),
        // 入站消息用 text；语音等记录用 at 而不是 time，这里一并兜住。
        text: String(m.text || m.plain || m.tail || ''),
        at: Number(m.time) || Number(m.at) || 0
      };
    }
  }
  return null;
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
  const latest = latestCounterpartMessage(recentMessages);
  return latest ? latest.name : '';
}

/**
 * @pure 记录一次「亲属称呼被拒」。
 *
 * 判定规则（与抽离前的 markKinshipRefusalV2 行为一致）：
 *   1. 群聊不记 —— key 不以 `private:` 开头时直接返回 null；
 *      群里分不清是谁在要称呼，宁可不记，只靠当轮拦截。
 *   2. 找不到对方名字（或名字是原型污染键）返回 null。
 *   3. 重复不叠加 —— traits 与 risk.refusedTitles 都去重，noKinshipTitle 保持 true。
 *   4. 原话证据 —— 拿到对方的非空原话时，存一条 kind:'kinship' 的 evidence；
 *      时间优先用那条消息自己的 time（没有就用调用方注入的 now），不读系统时钟。
 *
 * @param {object} input
 * @param {string} input.key               会话 key（private:xxx / group:xxx）
 * @param {Array}  [input.recentMessages]  会话最近消息
 * @param {object} [input.memberImpressions] 现有印象表（不会被改写）
 * @param {number} [input.now]             毫秒时间戳（消息本身没有时间时兜底）
 * @returns {null | { name: string, memberImpressions: object }}
 *          不记时返回 null；要记时返回新的印象表（浅拷贝，只替换目标条目）。
 */
export function markKinshipRefusal({ key, recentMessages, memberImpressions, now }) {
  if (!String(key).startsWith('private:')) return null;

  const latest = latestCounterpartMessage(recentMessages);
  if (!latest || FORBIDDEN_NAMES.includes(latest.name)) return null;
  const name = latest.name;

  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const old = impressions[name] || {};

  const traits = Array.isArray(old.traits) ? old.traits.slice(0, TRAITS_LIMIT) : [];
  uniquePush(traits, KINSHIP_REFUSAL_TRAIT);

  const risk = (old.risk && typeof old.risk === 'object') ? old.risk : {};
  const refusedTitles = uniquePush(
    Array.isArray(risk.refusedTitles) ? risk.refusedTitles.slice() : [],
    KINSHIP_REFUSED_TITLE
  );

  const entry = {
    ...old,
    traits,
    noKinshipTitle: true,
    risk: { ...risk, refusedTitles }
  };
  // 只在自己拿到了非空原话时才补 evidence：空文本不写空数组、不补默认值。
  const quote = normalizeEvidenceQuote(latest.text);
  if (quote) {
    entry.evidence = appendEvidence(old.evidence, {
      quote,
      at: latest.at || Number(now) || 0,
      key: String(key),
      kind: 'kinship'
    });
  }

  const nextImpressions = { ...impressions };
  nextImpressions[name] = entry;
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
