// outbound/rate — 滑动窗口限流器（工厂）
//
// 契约：docs/module-contract.md v1.1（本模块是工厂，暂无 handle，理由见文件末尾）
// deps：now                   （optional：无）
// 失败策略：fail-open          （依据：D 表 `outbound/batch` 邻近口径——限流器只回答
//                              「还能不能发」，拒绝是正常返回值而非异常；限流器自身出错
//                              最多退化成「照发」，不能把发送链路卡死）
// 单测：tests/rate.test.mjs
//
// 为什么需要：bridge 里的频率控制是散着的——voiceBudgetCheck 用两个数组数
// 每分钟/每小时条数（bridge.js:2313），eco-lib 的 takeWindowQuota 又是另一套，
// 各自把 Date.now() 和可变数组焊在闭包里，既没法在多会话间复用，也很难断言边界。
// 这里给出一个统一的滑动窗口：注入时钟、显式传时刻、实例自带状态。
//
// 边界：只维护「最近 windowMs 内放行过哪些时刻」。不读写文件、不落 state、
// 不发消息、不碰全局变量。状态只在工厂闭包里，实例之间互不可见（多 key 就多实例），
// 也不会通过返回值泄漏出去——返回的是新对象，内部数组不出工厂。
//
// 为什么是滑动窗口而不是固定窗口：固定窗口在窗口交界处会放过 2×max 条
// （59 秒发满、61 秒再发满），群聊里那看起来就是「刷屏」。滑动窗口数的是
// 「此刻往前 windowMs」，没有交界突刺。

export const spec = Object.freeze({
  name: 'outbound/rate',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MAX = 10;

/** 正整数（窗口至少 1ms）；非法值回落默认。 */
function sizeOf(value, fallback, min = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * 建一个滑动窗口限流器。状态（已放行的时刻）只活在这个闭包里。
 *
 * @param {object}   options
 * @param {number}   [options.windowMs] 窗口长度（毫秒），默认 60000
 * @param {number}   [options.max]      窗口内最多放行几条，默认 10；0 表示全拒
 * @param {Function|number} options.now 时钟：返回毫秒时间戳的函数（ctx.now）；
 *                                      传数字则视为固定时钟，方便复现
 * @returns {{ allow: (at?: number) => {allow: boolean, remaining: number, resetAt: number},
 *            remaining: (at?: number) => number,
 *            resetAt: (at?: number) => number }}
 */
export function createRateLimiter(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const windowMs = sizeOf(opts.windowMs, DEFAULT_WINDOW_MS, 1);
  const max = sizeOf(opts.max, DEFAULT_MAX, 0);

  const clock =
    typeof opts.now === 'function'
      ? opts.now
      : Number.isFinite(Number(opts.now))
        ? () => Number(opts.now)
        : null;

  // 没有时钟就无法定义「窗口」——与其偷偷退回 Date.now()（F.7 禁止），不如装配期就报清楚。
  if (!clock) {
    throw new Error('createRateLimiter 需要一个 now 时钟：请传入返回毫秒时间戳的函数（通常是 ctx.now）');
  }

  /** 放行过的时刻，未按时间排序的可能（时钟回拨），所以下面一律不做「首元素最旧」的假设。 */
  const stamps = [];

  const timeOf = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : Number(clock());
  };

  /** 窗口内的记录：at - ts < windowMs 才算「此刻仍在窗口里」。 */
  const activeAt = (at) => stamps.filter((ts) => at - ts < windowMs);

  /** 清掉已经滑出窗口的记录（不改动仍在窗口内的那些）。 */
  const pruneAt = (at) => {
    for (let i = stamps.length - 1; i >= 0; i -= 1) {
      if (at - stamps[i] >= windowMs) stamps.splice(i, 1);
    }
  };

  /** 最早一条记录过期的时刻 = 下一次「腾出名额」的时间；空窗返回 0。 */
  const earliestReset = (at) => {
    const active = activeAt(at);
    if (!active.length) return 0;
    return Math.min(...active) + windowMs;
  };

  return Object.freeze({
    /** 申请一次放行。放行才记账，拒绝不占名额。 */
    allow(value) {
      const at = timeOf(value);
      pruneAt(at);
      if (stamps.length >= max) {
        return { allow: false, remaining: 0, resetAt: earliestReset(at) };
      }
      stamps.push(at);
      return { allow: true, remaining: Math.max(0, max - stamps.length), resetAt: earliestReset(at) };
    },

    /** 此刻还剩几个名额（只读，不改状态）。 */
    remaining(value) {
      const at = timeOf(value);
      return Math.max(0, max - activeAt(at).length);
    },

    /** 此刻之前最早腾出名额的时刻；窗口内没有记录返回 0。 */
    resetAt(value) {
      return earliestReset(timeOf(value));
    }
  });
}

// 说明：本模块按 B.1 应当 export spec + handle，但它是**工厂**——handle 每次调用都会
// 新建实例，状态当场丢失，等于没限流。正确接法是中枢在装配期调一次 createRateLimiter，
// 把返回的三方法挂到 ctx（如 ctx.rate），模块本身保持无状态。
