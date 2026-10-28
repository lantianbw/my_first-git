// content/memory-score — 给待注入的记忆按衰减加权打分并排序
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （optional：无）
// 失败策略：fail-open            （依据：D 表 A.13/A.14「15 个内容模块一律 fail open」）
// 单测：tests/memory-score.test.mjs
//
// 为什么需要：memo / relations 里攒下几十条日程、画像、话题，注入窗口只有几百字，
// 得有个统一的「先给谁」口径。这里用指数衰减 + 提及次数增强，把「新近且反复出现」
// 的往前排，而不是靠各调用点各写一套 slice。
// 边界：只做排序与优先级标记。不删任何记忆（archiveThreshold 只回一个布尔标记，
// 删不删由调用方决定）；不读 Date.now（时间一律由调用方以 now 传入）；无 IO、无状态。
//
// 分数 = importance × (1 + ln(1 + reviewCount)) × exp(-Δt / halfLifeMs)
//   Δt = max(0, now - 计时基准)，基准优先 lastMentionAt，缺失时退回 createdAt。

const DAY_MS = 86_400_000;

export const spec = Object.freeze({
  name: 'content/memory-score',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

/** 四类记忆的半衰期（毫秒）：身份最抗衰减，瞬时状态掉得最快。 */
const HALF_LIFE_MS = Object.freeze({
  identity: 180 * DAY_MS,
  months: 30 * DAY_MS,
  event: 7 * DAY_MS,
  state: 1 * DAY_MS
});

const DEFAULT_KIND = 'event';

/** @pure 按 kind 取半衰期；未知 kind 回退 event 的默认值。 */
export function halfLifeFor(kind) {
  const key = String(kind ?? '');
  return Object.hasOwn(HALF_LIFE_MS, key) ? HALF_LIFE_MS[key] : HALF_LIFE_MS[DEFAULT_KIND];
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @pure 单条记忆的衰减分。分数只用于排序，数值本身没有绝对值含义。
 * item: { createdAt, lastMentionAt, reviewCount, importance, kind? }
 */
export function score(item, { now, halfLifeMs } = {}) {
  const entry = item && typeof item === 'object' ? item : {};
  const nowMs = num(now, 0);
  const importance = Math.max(0, num(entry.importance, 1));
  const reviewCount = Math.max(0, num(entry.reviewCount, 0));
  const override = num(halfLifeMs, 0);
  const halfLife = override > 0 ? override : halfLifeFor(entry.kind);
  const lastMentionAt = num(entry.lastMentionAt, 0);
  const createdAt = num(entry.createdAt, 0);
  // 计时基准：优先「最近一次被提及」，没有就退回创建时间；都没有则视为很久以前。
  const since = lastMentionAt || createdAt;
  const delta = Math.max(0, nowMs - since);
  return importance * (1 + Math.log1p(reviewCount)) * Math.exp(-delta / halfLife);
}

/**
 * @pure 按分数降序取前 limit 条。同分保持入参顺序（显式用 index 兜底，不依赖排序实现的稳定性）。
 * 返回 [{ item, score, archived }]；archived 只是标记，入参数组与条目一律原样保留。
 * opts: { now, halfLifeMs?, archiveThreshold? }
 */
export function rank(items, opts = {}, limit) {
  const list = Array.isArray(items) ? items : [];
  const { now, halfLifeMs, archiveThreshold } = opts ?? {};
  const threshold = num(archiveThreshold, NaN);

  const scored = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    scored.push({ item, value: score(item, { now, halfLifeMs }), index });
  });
  scored.sort((a, b) => (b.value - a.value) || (a.index - b.index));

  const size = Number(limit);
  const max = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : scored.length;

  return scored.slice(0, max).map(({ item, value }) => ({
    item,
    score: value,
    archived: Number.isFinite(threshold) ? value < threshold : false
  }));
}
