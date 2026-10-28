// scheduler/interval — 算「下一次唤醒 / 再静默多久」该等多少毫秒
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `scheduler/wake` 行——算歪了最多早叫或晚叫一次，下条消息仍会重算）
// 单测：tests/interval.test.mjs
//
// 为什么需要：等待时长散在两处——suggestQuietMsV2（bridge.js:11502）按「上句没说完 / 15 秒内
// 连发 3 条」在 8000 和 12000 之间挑一个，replyTimingV2（:13693）再按 cfg 的 min/max 夹一遍，
// 两处都嵌着 Date.now() 和会话状态。于是「为什么这轮等了 12 秒」只能靠线上日志倒推。
// 这里把这段折成一次纯计算：输入活跃度与边界，输出毫秒与一句人能读的理由。
//
// 边界：只算数。不读时钟、不掷骰子、不排定时器、不写状态、不 import bridge.js。
// 抖动用的随机数必须由调用方传入（random），不传就取 0.5（不偏移），
// 这样同一入参永远得到同一结果，测试才可能稳定。
//
// 与 bridge 的一处**语义差异**：原实现里「15 秒内连发 3 条」是把等待**拉长**到 12 秒
// （等对方把话说完），那是静默窗口；本模块算的是唤醒间隔——会话越热，越该早点回来看，
// 所以活跃度越高间隔越短。两者方向相反，不要拿旧日志的 12 秒来对这里的数。

export const spec = Object.freeze({
  name: 'scheduler/interval',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

/** 默认值取自 bridge：defaultQuietMs 8000，硬上限 120000（replyTimingV2 的 min(120000, …)）。 */
const DEFAULTS = Object.freeze({ baseMs: 8000, minMs: 1000, maxMs: 120000 });

/** 无抖动时的活跃度中性点：0.5 落在 baseMs 上，往上收缩、往下放宽。 */
const NEUTRAL = 0.5;

/** 合法非负数；其余（NaN / 负数 / Infinity / 'abc'）一律回落。 */
function sizeOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 0~1 的比例；越界夹紧，非法值取中性 0.5。 */
function ratioOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 活跃度分档，只用于 reason 措辞。 */
function levelOf(activity) {
  if (activity >= 0.67) return '高';
  if (activity >= 0.34) return '中';
  return '低';
}

/**
 * @pure 下一次间隔。
 *
 * 基准映射：activity 0 → maxMs，0.5 → baseMs，1 → minMs（分段线性，单调不增）。
 * 抖动：ms × (1 + (random × 2 - 1) × jitterRatio)，即 random 0 取下界、1 取上界、0.5 不偏移。
 * 最后整体夹进 [minMs, maxMs]，所以即使 base 或抖动越界，结果也不会跑出去。
 *
 * @param {object} context
 * @param {number} [context.activity]    0~1，1 表示会话最热（越热间隔越短）
 * @param {number} [context.baseMs]      activity=0.5 时的基准间隔，默认 8000
 * @param {number} [context.minMs]       下限，默认 1000
 * @param {number} [context.maxMs]       上限，默认 120000
 * @param {number} [context.jitterRatio] 抖动幅度 0~1，默认 0（不抖动）
 * @param {number} [context.random]      调用方掷好的 [0,1) 随机数，默认 0.5
 * @returns {{ ms: number, reason: string }}
 */
export function nextInterval(context = {}) {
  const src = context && typeof context === 'object' ? context : {};

  let minMs = sizeOf(src.minMs, DEFAULTS.minMs);
  let maxMs = sizeOf(src.maxMs, DEFAULTS.maxMs);
  // 上下界写反时交换，而不是悄悄把结果夹成 0：宁可给出一个可用区间，也不返回无意义的值。
  if (minMs > maxMs) [minMs, maxMs] = [maxMs, minMs];

  const baseMs = sizeOf(src.baseMs, DEFAULTS.baseMs);
  const activity = ratioOf(src.activity, NEUTRAL);
  const jitterRatio = ratioOf(src.jitterRatio, 0);
  const random = ratioOf(src.random, NEUTRAL);

  let raw;
  if (activity >= NEUTRAL) {
    const t = (activity - NEUTRAL) / NEUTRAL; // 0 → base，1 → min
    raw = baseMs + (minMs - baseMs) * t;
  } else {
    const t = activity / NEUTRAL; // 0 → max，1 → base
    raw = maxMs + (baseMs - maxMs) * t;
  }

  const jitter = 1 + (random * 2 - 1) * jitterRatio;
  const wanted = Math.round(raw * jitter);
  const ms = Math.min(maxMs, Math.max(minMs, wanted));

  const parts = [
    `${levelOf(activity)}活跃（${activity.toFixed(2)}）`,
    `基准 ${Math.round(raw)}ms`,
    jitterRatio > 0 ? `抖动 ×${jitter.toFixed(2)}` : '无抖动'
  ];
  if (ms !== wanted) parts.push(`夹紧到 ${ms}ms（区间 ${minMs}~${maxMs}）`);

  return { ms, reason: parts.join('，') };
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx。
 *
 * @param {object} _ctx
 * @param {object} args 同 nextInterval 的入参
 * @returns {{ ok: true, value: { ms: number, reason: string } }}
 */
export function handle(_ctx, args) {
  return { ok: true, value: nextInterval(args) };
}
