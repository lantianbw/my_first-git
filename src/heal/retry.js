// heal/retry — 指数退避的通用计算（纯函数：不等待、不重试、不读时钟）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 heal/onebot「fail open，退避永不放弃」/ H2 heal/onebot=locked）
// deps：无                       （optional：无）
// 失败策略：fail-open            （依据：D 表 heal/onebot「重试只负责重连，不能让重试吞消息」）
// 单测：tests/retry.test.mjs
//
// 为什么需要：src/onebot-retry.js 把退避写死成一张表 [5000,15000,60000,300000] + 一个下标截断，
// 只能回答「OneBot 第几次重连等多久」。可 DSH 端口漂移、模型 429、MCP 重连都需要退避，
// 每处再抄一张表就会出现「有的 3 次放弃、有的永不放弃」。这里把它泛化成 base×factor^(n-1)，
// 并显式支持抖动（thundering herd 时同一秒重连会再撞一次）。
//
// 边界：只算数字。不 setTimeout、不 sleep、不判断「还该不该重试」、不记录状态；
// 随机数由调用方以 random（[0,1] 的单个值）传入，本模块不持有随机源。
//
// 与 onebot-retry 的差异（重要）：旧表是 5s → 15s → 60s → 300s，比值分别是 3× / 4× / 5×，
// **不是等比数列**，所以任何单一 factor 都无法逐档复现（factor=3 时第 3 档是 45s，旧表是 60s）。
// 要完全等价只能继续用显式表；本模块服务的是「新写的重试点」，按 factor=3 的干净曲线走。

/** 缺省值：base 5s、×3、封顶 5 分钟 —— 与 onebot-retry 的首档/末档一致。 */
const DEFAULTS = Object.freeze({ baseMs: 5_000, factor: 3, maxMs: 300_000, jitter: 0 });

const REASON = Object.freeze({
  GROWTH: 'growth',
  CAPPED: 'capped',
  FALLBACK: 'fallback'
});

export const spec = Object.freeze({
  name: 'heal/retry',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`nextDelay: ${name} 必须是正的有限数字（收到 ${String(value)}）`);
  }
  return value;
}

function requireJitter(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`nextDelay: jitter 必须是 0~1 的比例（收到 ${String(value)}）`);
  }
  return value;
}

/**
 * 算第 attempt 次重试该等多久。
 *
 * @param {object} [opts]
 * @param {number} [opts.attempt=1]   第几次重试，从 1 开始；<1 或非数字退回首档
 * @param {number} [opts.baseMs=5000] 首档间隔
 * @param {number} [opts.factor=3]    每次的倍数
 * @param {number} [opts.maxMs=300000] 上限，触顶后不再增长
 * @param {number} [opts.jitter=0]    抖动比例 0~1（0.2 = ±20%）
 * @param {number} [opts.random=0.5]  [0,1] 的取值，决定抖动落在区间哪一点（0=下界，1=上界）
 * @returns {{ delayMs: number, capped: boolean, reason: string }}
 */
export function nextDelay({
  attempt = 1,
  baseMs = DEFAULTS.baseMs,
  factor = DEFAULTS.factor,
  maxMs = DEFAULTS.maxMs,
  jitter = DEFAULTS.jitter,
  random = 0.5
} = {}) {
  requirePositive(baseMs, 'baseMs');
  requirePositive(factor, 'factor');
  requirePositive(maxMs, 'maxMs');
  requireJitter(jitter);

  // attempt 是运行期取值：非法时降级到首档，而不是把重连链路打断
  const n = Math.floor(Number(attempt));
  if (!Number.isFinite(n) || n < 1) {
    const delayMs = Math.min(baseMs, maxMs);
    return { delayMs, capped: baseMs > maxMs, reason: REASON.FALLBACK };
  }

  const raw = baseMs * factor ** (n - 1);

  // 触顶（含 factor 巨大导致的 Infinity）：直接给上限，不再抖动 —— 夹紧就是夹紧
  if (!(raw <= maxMs)) {
    return { delayMs: maxMs, capped: true, reason: REASON.CAPPED };
  }

  // 抖动对称分布：random=0 → 下界 (1-jitter)，random=1 → 上界 (1+jitter)
  const r = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
  const target = raw * (1 + jitter * (2 * r - 1));
  // capped 的口径是「最终值被夹到了上限」：抖动顶上去也算夹紧，避免 delayMs===maxMs 却报 capped:false
  const capped = target > maxMs;
  // 下限 1ms：jitter=1 且 random=0 时算出 0，0 延迟等于忙等
  const delayMs = Math.max(1, Math.min(maxMs, Math.round(target)));

  return { delayMs, capped, reason: capped ? REASON.CAPPED : REASON.GROWTH };
}

/**
 * 一次看清整条退避曲线（调度器做「预计何时恢复」提示时用）。
 *
 * @param {number} count 要算几档
 * @param {object} [opts] 同 nextDelay，但不含 attempt
 * @returns {Array<{delayMs:number, capped:boolean, reason:string}>} 长度 = count
 */
export function delaysOf(count, opts = {}) {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const out = [];
  for (let attempt = 1; attempt <= total; attempt += 1) {
    out.push(nextDelay({ ...opts, attempt }));
  }
  return out;
}
