// outbound/batch — 计算分条发送时相邻两条之间的等待间隔（毫秒）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 outbound/batch 行）
// deps：cfg, now               （optional：none；本文件是纯计算，二者都不读取，
//                               随机源由调用方以 options.random 显式传入）
// 失败策略：fail-closed         （依据：D 表 `outbound/batch` 行——间隔算错会让分条节奏失真；
//                               auto 模式缺随机源时直接抛错，绝不"猜一个间隔"糊过去）
// 单测：tests/outbound-batch.test.mjs
//
// 为什么需要：`computeGapsV2()` / `clampGapV2()` 原来内嵌在 bridge.js 的发送端点里，
// 三条分支（fixed / byLength / auto）各自读 `cfg.socialV2.send`、auto 还直接调闭包里的
// `randInt()`（内部 Math.random）。想验证"20 条消息的间隔是否都被夹进上下界"只能起桥发真消息。
// 搬出来后是纯函数：进 segments + 参数，出间隔数组，随机源注入即可离线断言。
//
// 边界：只算数。不发送、不排队、不读 cfg / state / process.env、不读写文件、不联网、
// 不打日志、不用 Date.now() / Math.random()、不 import bridge.js、不改写入参。
// 本文件只负责 `outbound/batch` 里的间隔计算一段，真正的发送编排（部分失败抛 err.sent）
// 仍在调用方。
//
// 与 bridge 原实现的三处刻意差异（都是为了"纯"）：
//   1. auto 分支的随机数由 `options.random`（`() => [0,1)`，或一个固定数字）注入；
//      旧实现直接调 `Math.random()`。注入 `() => Math.random()` 时行为逐字一致。
//   2. 段元素除字符串外还接受对象，按 text → content → plain 取文本（同 outbound/dedupe
//      的既有约定）；旧实现对对象会退化成 `String(obj)` = "[object Object]"（15 字），
//      所以**只喂字符串**时与旧实现完全一致，喂对象是这次新支持的形态。
//   3. `segments` 只认数组。旧实现对着 `arguments`/字符串也能算出间隔（靠 `.length`），
//      那属于误用；非数组按"没有可发内容"返回 `[]`（`null` / `undefined` 与旧实现一致）。
//
// 两个容易踩的默认值不同，照旧实现保留：
//   · `clampGap` 的 min 缺省是 **300ms**（`burstIntervalMinMs` 缺失时）；
//   · fixed / auto 分支的 `burstIntervalMinMs` 缺省是 **1000ms**（`|| 1000`），不是 300。

export const spec = Object.freeze({
  name: 'outbound/batch',
  version: '1.0.0',
  deps: Object.freeze(['cfg', 'now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：文本收发链路的节奏参数，关掉等于桥无法分条（契约 H1 / H2）
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 全部缺省值，逐项抄自 bridge.js 的 `clampGapV2` / `computeGapsV2`。 */
export const DEFAULTS = Object.freeze({
  gapFloorMs: 100,            // clampGap 的绝对下界（与 maxGapMs 无关，写死）
  clampMinMs: 300,            // clampGap：burstIntervalMinMs 缺失时
  maxGapMs: 10000,            // clampGap 上界
  gapBaseMs: 800,             // byLength 基准
  gapPerCharMs: 20,           // byLength 每字增量
  burstGapMs: 1000,           // fixed 的 gapMs 缺省，同时是 auto 短间隔 min 缺省
  longGapProbability: 0,      // auto 长间隔概率缺省（配置默认是 0.2，函数缺省 0）
  longGapMinMs: 5000,
  longGapMaxMs: 10000,
  burstIntervalMaxMs: 3000
});

const isObject = (value) => value !== null && typeof value === 'object';

/** 原实现的 `Number(x) || fallback`：0 / NaN / 空串一律回落默认值（负数保留，交给 clampGap 夹）。 */
const numOr = (value, fallback) => Number(value) || fallback;

/** options 传 null / 非对象时按空对象处理（旧实现读的是必传的 sendCfg）。 */
const optionsOf = (value) => (isObject(value) ? value : {});

/** 与 bridge.js 的 `randInt` 逐字一致（含 min > max 时对调）。 */
function randInt(min, max, random) {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + random() * (max - min + 1));
}

/**
 * 随机源：`() => [0,1)`，或一个 0~1 的固定数字（便于复现，口径同 outbound/rate 的 now）。
 * 都没有则返回 null —— auto 分支据此拒绝计算，而不是偷偷退回 Math.random()（契约 F.7）。
 */
function randomOf(opts) {
  if (typeof opts.random === 'function') return opts.random;
  if (opts.random === undefined || opts.random === null) return null;
  const fixed = Number(opts.random);
  return Number.isFinite(fixed) ? () => fixed : null;
}

/**
 * 取一段的文本（只用于 byLength 的字符数）。
 * 字符串直接用；对象按 text → content → plain 取（同 outbound/dedupe 的既有约定）。
 */
function textOf(segment) {
  if (isObject(segment)) {
    return String(segment.text ?? segment.content ?? segment.plain ?? '');
  }
  return String(segment || '');
}

/**
 * @pure 把单个间隔夹到配置允许的上下界内。
 *
 * 公式（与旧实现逐字一致）：
 *   min = max(100, burstIntervalMinMs || 300)
 *   max = max(min, maxGapMs || 10000)
 *   out = max(min, min(max, round(ms || min)))
 *
 * @param {number} ms 期望间隔（毫秒）；非法 / 0 视为"取 min"
 * @param {object} [options] 与 `cfg.socialV2.send` 同名的扁平字段
 * @param {number} [options.burstIntervalMinMs=300]
 * @param {number} [options.maxGapMs=10000]
 * @returns {number} 夹取后的整数毫秒
 */
export function clampGap(ms, options = {}) {
  const opts = optionsOf(options);
  const min = Math.max(DEFAULTS.gapFloorMs, numOr(opts.burstIntervalMinMs, DEFAULTS.clampMinMs));
  const max = Math.max(min, numOr(opts.maxGapMs, DEFAULTS.maxGapMs));
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

/**
 * @pure 计算 n 段之间的 n-1 个间隔。
 *
 * 三条分支（选择规则同旧实现：只有 'fixed' / 'byLength' 被认，其余一律当 'auto'）：
 *   · fixed    —— `gaps` 数组够长就逐项 clampGap；否则用 gapMs（再退 burstIntervalMinMs、1000）
 *                 生成同一个值填满；
 *   · byLength —— base + max(1, 本段字数) * perChar 后 clampGap（末段不算，因为后面没有间隔）；
 *   · auto     —— 每条先按 longGapProbability 抽"是否长间隔"，再在该区间里 randInt，
 *                 最后 clampGap。longProb 为 0 时不消耗随机数（旧实现靠 `&&` 短路，同此）。
 *
 * 段数为 0 或 1 时没有间隔，返回 `[]`（旧实现 `messages.length <= 1` 即返回）。
 *
 * @param {Array<string|{text?:string,content?:string,plain?:string}>|null|undefined} segments
 * @param {object} [options]
 * @param {'auto'|'fixed'|'byLength'} [options.mode='auto']
 * @param {number} [options.gapMs]               fixed 的固定间隔
 * @param {number[]} [options.gaps]              fixed 的逐条间隔（长度须 ≥ 段数-1）
 * @param {Function|number} options.random       auto 必备：`() => [0,1)` 或固定数字
 * @param {number} [options.burstIntervalMinMs=1000] auto 短间隔下限 / clampGap 下限缺省 300
 * @param {number} [options.burstIntervalMaxMs=3000] auto 短间隔上限
 * @param {number} [options.longGapProbability=0]    auto 长间隔概率（夹到 0~1）
 * @param {number} [options.longGapMinMs=5000]       auto 长间隔下限
 * @param {number} [options.longGapMaxMs=10000]      auto 长间隔上限
 * @param {number} [options.gapBaseMs=800]           byLength 基准
 * @param {number} [options.gapPerCharMs=20]         byLength 每字增量
 * @param {number} [options.maxGapMs=10000]          统一上界
 * @returns {number[]} 长度 = max(0, 段数 - 1)
 */
export function computeGaps(segments, options = {}) {
  const opts = optionsOf(options);
  const list = Array.isArray(segments) ? segments : [];
  const delays = [];
  if (list.length <= 1) return delays;

  const count = list.length - 1;
  const mode = opts.mode === 'fixed' || opts.mode === 'byLength' ? opts.mode : 'auto';

  if (mode === 'fixed') {
    if (Array.isArray(opts.gaps) && opts.gaps.length >= count) {
      for (let i = 0; i < count; i += 1) delays.push(clampGap(opts.gaps[i], opts));
    } else {
      const gap = clampGap(numOr(opts.gapMs, numOr(opts.burstIntervalMinMs, DEFAULTS.burstGapMs)), opts);
      for (let i = 0; i < count; i += 1) delays.push(gap);
    }
    return delays;
  }

  if (mode === 'byLength') {
    const base = numOr(opts.gapBaseMs, DEFAULTS.gapBaseMs);
    const perChar = numOr(opts.gapPerCharMs, DEFAULTS.gapPerCharMs);
    for (let i = 0; i < count; i += 1) {
      const chars = Math.max(1, textOf(list[i]).length);
      delays.push(clampGap(base + chars * perChar, opts));
    }
    return delays;
  }

  const random = randomOf(opts);
  // 没有随机源就没有 auto 间隔；与其退回 Math.random()（F.7）或取中点（发明语义），不如拒绝。
  if (!random) {
    throw new TypeError('computeGaps 的 auto 模式需要随机源：请传入返回 [0,1) 的函数（通常是 ctx.random）');
  }

  const longProb = Math.min(1, Math.max(0, numOr(opts.longGapProbability, DEFAULTS.longGapProbability)));
  for (let i = 0; i < count; i += 1) {
    const useLong = longProb > 0 && random() < longProb;
    const min = useLong
      ? numOr(opts.longGapMinMs, DEFAULTS.longGapMinMs)
      : numOr(opts.burstIntervalMinMs, DEFAULTS.burstGapMs);
    const max = useLong
      ? numOr(opts.longGapMaxMs, DEFAULTS.longGapMaxMs)
      : numOr(opts.burstIntervalMaxMs, DEFAULTS.burstIntervalMaxMs);
    delays.push(clampGap(randInt(Math.max(DEFAULTS.gapFloorMs, min), Math.max(DEFAULTS.gapFloorMs, max), random), opts));
  }
  return delays;
}

/**
 * 契约门面（B.1）。
 *
 * args：`{ action: 'compute-gaps', segments, options }` / `{ action: 'clamp-gap', ms, options }`。
 * 参数违约（例如 auto 缺 random）返回 `INVALID_ARGS` + 可读原因，不吞掉原因。
 *
 * @param {object} _ctx deps 声明的 cfg / now 本文件都不用
 * @param {object} [args]
 * @returns {{ok:true, value:number[]|number} | {ok:false, code:string, error:string}}
 */
export function handle(_ctx, args = {}) {
  const action = String(args?.action ?? '');
  try {
    if (action === 'compute-gaps') return { ok: true, value: computeGaps(args.segments, args.options) };
    if (action === 'clamp-gap') return { ok: true, value: clampGap(args.ms, args.options) };
    return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
  } catch (error) {
    return { ok: false, code: 'INVALID_ARGS', error: `间隔计算失败：${error?.message ?? error}` };
  }
}
