// outbound/dedupe — 判断待发文本是不是最近已经说过的内容
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：now                   （optional：无）
// 失败策略：fail-open          （依据：D 表 `outbound/batch` 邻近口径——判重只是去噪，
//                              误判成「不重复」最多多发一条，不能因此卡住发送链路）
// 单测：tests/outbound-dedupe.test.mjs
//
// 为什么需要：模型在长会话里会复读——同一句「好的，我看看」十分钟内发三遍，
// 群友一眼就看出来是机器。按条数限流拦不住（每次文本都「合法」），只能拿最近说过的话
// 做比对。这里把比对做成纯函数：给文本和一段历史，回答「说过没有、哪一条、多像」。
//
// 边界：只读入参。不读时钟（now 由调用方传入）、不写任何去重队列、不发消息、
// 不 import bridge.js。history 里那些「什么时候说的」也只用来判窗口，不改写。
//
// 相似度口径：字符 2-gram 的 Dice 系数 2|A∩B| / (|A|+|B|)。
// 不用编辑距离：中文一句话改一个词，编辑距离仍然很小，但 2-gram 会同时打掉
// 交叉的两个 gram，区分度更接近「读起来是不是同一句」。也不做分词——群里的话
// 一半没有空格，分词器一挂就会把整句判成不相似。

export const spec = Object.freeze({
  name: 'outbound/dedupe',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

const DEFAULT_WINDOW_MS = 600000; // 10 分钟
const DEFAULT_SIMILARITY = 0.9;

/** 归一：小写 + 去掉所有空白。标点**保留**——「？」和「。」是内容差异，不是排版差异。 */
function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, '');
}

/** 字符 2-gram 集合（同 src/scorer.js:50 的切法，重复 gram 只记一次）。 */
function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/** Dice 系数；任一侧不足 2 字（没有 gram）时返回 0，交给完全一致那条路兜。 */
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return (2 * hit) / (a.size + b.size);
}

/** 合法非负毫秒数；其余回落默认。0 是合法值（只比对同一时刻）。 */
function windowOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 0~1 的阈值；越界夹紧，非法值回落默认。 */
function thresholdOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * @pure 判断 text 是否与 history 中的某条重复。
 *
 * history 元素可以是字符串，也可以是 `{ text, at }`（at 单位毫秒，兼容 ts / time / timestamp）。
 * 条目没有可用时间戳时视为「在窗口内」——证明不了它旧，就按新的处理，宁可少发一条。
 *
 * @param {string} text
 * @param {Array<string|{text?:string, at?:number}>} history
 * @param {object} [options]
 * @param {number} [options.windowMs]   回看窗口，默认 600000（10 分钟）
 * @param {number} [options.now]        当前时刻（毫秒），不传则不做窗口过滤
 * @param {number} [options.similarity] 判重阈值 0~1，默认 0.9
 * @returns {{ duplicate: boolean, matchedAt?: number, similarity?: number }}
 */
export function isDuplicate(text, history, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const windowMs = windowOf(opts.windowMs, DEFAULT_WINDOW_MS);
  const threshold = thresholdOf(opts.similarity, DEFAULT_SIMILARITY);

  const nowRaw = Number(opts.now);
  const now = Number.isFinite(nowRaw) ? nowRaw : null;
  const floor = now === null ? null : now - windowMs;

  const target = normalize(text);
  if (!target) return { duplicate: false }; // 空文本不判重

  const list = Array.isArray(history) ? history : [];
  const targetGrams = bigrams(target);

  let best = null;
  for (const entry of list) {
    const item = entry && typeof entry === 'object' ? entry : { text: entry };
    const candidate = normalize(item.text ?? item.content ?? item.plain ?? '');
    if (!candidate) continue;

    const rawAt = Number(item.at ?? item.ts ?? item.time ?? item.timestamp);
    const at = Number.isFinite(rawAt) ? rawAt : undefined;
    if (floor !== null && at !== undefined && at < floor) continue; // 窗口外

    if (candidate === target) {
      return at === undefined
        ? { duplicate: true, similarity: 1 }
        : { duplicate: true, matchedAt: at, similarity: 1 };
    }

    const sim = dice(targetGrams, bigrams(candidate));
    if (!best || sim > best.sim) best = { sim, at };
  }

  if (best && best.sim >= threshold) {
    return best.at === undefined
      ? { duplicate: true, similarity: best.sim }
      : { duplicate: true, matchedAt: best.at, similarity: best.sim };
  }
  return { duplicate: false };
}

/**
 * 契约门面（B.1）。deps 只有 now：args 没给当前时刻时，用中枢注入的 ctx.now() 取。
 *
 * @param {{ now?: () => number }} ctx
 * @param {string} text
 * @param {Array} history
 * @param {object} [options]
 * @returns {{ ok: true, value: { duplicate: boolean, matchedAt?: number, similarity?: number } }}
 */
export function handle(ctx, text, history, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = opts.now !== undefined ? opts.now : (typeof ctx?.now === 'function' ? ctx.now() : undefined);
  return { ok: true, value: isDuplicate(text, history, { ...opts, now }) };
}
