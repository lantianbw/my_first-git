// memory/affection-profile — 好感度 / 关系温度（memberImpressions 正向关系字段）的纯函数
//
// 契约：docs/module-contract.md（B.1 spec 同 content/memory-* 一族）
// deps：无
// 失败策略：fail-open          （依据：D 表「记忆写坏只少一条提示，不影响收发」）
// 单测：tests/memory-affection.test.mjs
//
// 为什么存在：M3 的风险档案只记「负面边界」（爱下套 / 不能接的话题 / 已拒绝的称呼），
// 结果模型对所有人一律设防，态度没有分化。好感度补的是正向一侧：谁是聊得来的、谁刚闹过别扭。
// 两者并列但不互相改写——risk 管「不能做什么」，affection 管「愿意多亲近」。
//
// 边界：不读 state、不读时钟、不写文件、不记日志、不发消息、不改传入对象。
//
// 好感度形状（memberImpressions.<name>）：
//   affection: {
//     score: number   // -100 ~ 100，整数；0 = 一般，正 = 亲近，负 = 疏远
//     tags: string[]  // 可选：关系标签（如「投缘」「聊猫」，最多 5 条、每条 ≤20 字）
//   }
// 兼容：affection 直接写成数字（或数值字符串）的旧/手写数据，按「只有分数、没有标签」读。
//
// 为什么用有符号分而不是 0~100：关系是双向的，被反复施压会往下走（见 KINSHIP_COOLING_DELTA），
// 0 作为「陌生人/一般」的中点比「50」更好读，也不依赖误以为的初始好感。

export const spec = Object.freeze({
  name: 'memory/affection-profile',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

/** 好感度下限（最冷）。 */
export const AFFECTION_MIN = -100;
/** 好感度上限（最亲近）。 */
export const AFFECTION_MAX = 100;
/** 关系标签条数上限。 */
export const AFFECTION_TAGS_LIMIT = 5;
/** 单条关系标签字符上限。 */
export const AFFECTION_TAG_MAX_CHARS = 20;
/**
 * 亲属称呼被出站守卫拦一次，关系温度下调的分值。
 * 与 M3 的 markKinshipRefusal 并列使用（纯函数不改 risk，只改 affection）；
 * 数值刻意温和：一次冒犯不至于翻脸，但连续施压会一路走冷。
 */
export const KINSHIP_COOLING_DELTA = -10;

/**
 * 温度档位（按分数从高到低匹配第一个命中的 min）。
 * 文案只做「方向提示」，具体怎么说话仍由人格决定，本模块不改写话术。
 */
export const AFFECTION_LEVELS = Object.freeze([
  Object.freeze({ min: 60, label: '亲近' }),
  Object.freeze({ min: 25, label: '聊得来' }),
  Object.freeze({ min: -20, label: '一般' }),
  Object.freeze({ min: -60, label: '有点疏远' }),
  Object.freeze({ min: AFFECTION_MIN, label: '冷淡' })
]);

/** 有原型污染风险的对象键名，写印象前一律拦截（与 risk-profile.js 一致）。 */
const FORBIDDEN_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(AFFECTION_MIN, Math.min(AFFECTION_MAX, Math.round(n)));
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const tags = [];
  for (const item of raw) {
    const text = trimText(item).slice(0, AFFECTION_TAG_MAX_CHARS);
    if (text && !tags.includes(text)) tags.push(text);
    if (tags.length >= AFFECTION_TAGS_LIMIT) break;
  }
  return tags;
}

/**
 * @pure 把任意落盘形态的 affection 归一成 { score, tags }。
 * 数字 / 数值字符串 → 只取分数；对象 → 取 score + tags；其余（缺字段、脏数据）→ 0 + 空标签。
 * 分数一律四舍五入并夹在 -100~100。
 *
 * @param {unknown} raw
 * @returns {{ score: number, tags: string[] }}
 */
export function normalizeAffection(raw) {
  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim())) {
    return { score: clampScore(raw), tags: [] };
  }
  if (raw && typeof raw === 'object') {
    return { score: clampScore(raw.score), tags: normalizeTags(raw.tags) };
  }
  return { score: 0, tags: [] };
}

/**
 * @pure 印象条目上是否写了好感度（用来决定渲染不渲染，避免给没记录的人凭空补「一般」）。
 *
 * @param {object} im 单条 impression
 * @returns {boolean}
 */
export function hasAffection(im) {
  const raw = im && typeof im === 'object' ? im.affection : undefined;
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'string') return raw.trim() !== '' && Number.isFinite(Number(raw));
  return !!raw && typeof raw === 'object';
}

/**
 * @pure 分数 → 温度档位文案。给唤醒记忆块和未来的写入点复用。
 *
 * @param {number} score
 * @returns {string} 亲近 / 聊得来 / 一般 / 有点疏远 / 冷淡
 */
export function describeAffection(score) {
  const n = clampScore(score);
  for (const level of AFFECTION_LEVELS) {
    if (n >= level.min) return level.label;
  }
  return AFFECTION_LEVELS[AFFECTION_LEVELS.length - 1].label;
}

/**
 * @pure 读某人的好感度（缺记录时是 0 / 无标签，不代表写入过）。
 *
 * @param {object} [memberImpressions]
 * @param {string} name
 * @returns {{ score: number, tags: string[] }}
 */
export function getAffection(memberImpressions, name) {
  const target = trimText(name);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const im = target ? impressions[target] : null;
  return normalizeAffection(im && im.affection);
}

/**
 * @pure 把好感度设为某个值（越界自动夹住），保留已有标签。
 * 名字非法 / 分数非有限数时返回原样拷贝（不写脏数据）。
 *
 * @returns {object} 新的 memberImpressions 表（浅拷贝，只替换目标条目）
 */
export function setAffection(memberImpressions, name, score) {
  const target = trimText(name);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const next = { ...impressions };
  if (!target || FORBIDDEN_NAMES.includes(target)) return next;
  if (!Number.isFinite(Number(score))) return next;

  const old = next[target] || {};
  const current = normalizeAffection(old.affection);
  next[target] = { ...old, affection: { score: clampScore(score), tags: current.tags } };
  return next;
}

/**
 * @pure 好感度增减（delta 可正可负），结果夹在 -100~100，保留已有标签。
 * 名字非法 / delta 非有限数时返回原样拷贝。
 *
 * @param {object} [memberImpressions]
 * @param {string} name
 * @param {number} delta
 * @returns {object} 新的 memberImpressions 表（浅拷贝，只替换目标条目）
 */
export function adjustAffection(memberImpressions, name, delta) {
  const target = trimText(name);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const next = { ...impressions };
  if (!target || FORBIDDEN_NAMES.includes(target)) return next;
  if (!Number.isFinite(Number(delta))) return next;

  const old = next[target] || {};
  const current = normalizeAffection(old.affection);
  next[target] = {
    ...old,
    affection: { score: clampScore(current.score + Number(delta)), tags: current.tags }
  };
  return next;
}

/**
 * @pure 给某人挂一条关系标签（去重、截断、最多 5 条），不动分数。
 * 名字非法 / 标签为空时返回原样拷贝。
 *
 * @returns {object} 新的 memberImpressions 表（浅拷贝，只替换目标条目）
 */
export function addAffectionTag(memberImpressions, name, tag) {
  const target = trimText(name);
  const text = trimText(tag).slice(0, AFFECTION_TAG_MAX_CHARS);
  const impressions = (memberImpressions && typeof memberImpressions === 'object') ? memberImpressions : {};
  const next = { ...impressions };
  if (!target || FORBIDDEN_NAMES.includes(target) || !text) return next;

  const old = next[target] || {};
  const current = normalizeAffection(old.affection);
  const tags = current.tags.includes(text) || current.tags.length >= AFFECTION_TAGS_LIMIT
    ? current.tags.slice()
    : [...current.tags, text];
  next[target] = { ...old, affection: { score: current.score, tags } };
  return next;
}
