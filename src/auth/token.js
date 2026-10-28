// auth/token — 生成会话令牌、校验令牌形状、常量时间比较
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 auth/agent-token「fail closed」/ H2 auth/*=locked）
// deps：无                       （optional：random）
// 失败策略：fail-closed          （依据：D 表 auth/agent-token「会话令牌是二代会话隔离的唯一凭据」）
// 单测：tests/token.test.mjs
//
// 为什么需要：令牌的三件事现在散在 bridge.js 里——生成是 `crypto.randomBytes(24).toString('hex')`
// 直接写在业务分支里（:3488 / :4995），形状检查只有 consoleToken 那一处内联正则（:3833），
// 比较是 tokenEq（:3848）。三处口径各写一遍，想加一条「令牌必须 32 位」就得全仓搜。抽出来之后
// 生成只依赖注入的随机源，比较有一段可单测的常量时间实现。
//
// 边界：不读写文件、不碰 state、不读 crypto/Date/环境变量（随机源由调用方注入）、不判断令牌
// 是否「属于某个会话」——那是 agentTokenOk 的职责（要查会话状态），本模块只回答
// 「这串字符长得像不像令牌」与「两串字符是否相同」。
//
// 与现有实现的差异（有意为之）：
//   · 现有 tokenEq 先比长度、长度不同就短路返回（`x.length === y.length && timingSafeEqual(...)`），
//     长度本身就是一条时序侧信道；本模块的 safeEqual 无论长度是否相同都跑完整循环，
//     长度差只作为结果位参与最后判定。
//   · 现有生成是 48 位 hex（24 字节）；这里默认 32 位（调用方可指定 16~128）。
//   · 生成用的是 hex 字符集（与现有 agentToken 一致），而形状校验按 bridge.js 里 consoleToken
//     的判定放宽到 `[A-Za-z0-9_-]`（16~128），这样手工配置的控制台令牌也能通过。

/** 形状边界：与 bridge.js consoleToken 的判定（16~128、[A-Za-z0-9_-]）保持一致。 */
const MIN_LEN = 16;
const MAX_LEN = 128;

/** 生成用字符集：hex，与 crypto.randomBytes(24).toString('hex') 同族。 */
const ALPHABET = '0123456789abcdef';

/** 形状正则：无 g 标志，避免 lastIndex 让判定变成有状态。 */
const SHAPE_RE = /^[A-Za-z0-9_-]+$/;

export const spec = Object.freeze({
  name: 'auth/token',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze(['random']),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/**
 * 生成一个定长令牌。
 *
 * 只使用注入的 random()（[0,1)），不读 crypto、不读 Date —— 这样测试可以完全复现。
 * random 缺失时**拒绝生成**而不是退回 Math.random：凭证用弱随机源比拿不到凭证更危险，
 * 且 Math.random 被 F.7 明令禁止。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.length=32] 令牌长度，必须在 16~128 之间
 * @param {Function} opts.random     () => [0,1)
 * @returns {string} 定长 hex 字符串
 */
export function makeToken({ length = 32, random } = {}) {
  if (!Number.isInteger(length) || length < MIN_LEN || length > MAX_LEN) {
    throw new RangeError(`makeToken: length 必须是 ${MIN_LEN}~${MAX_LEN} 的整数（收到 ${String(length)}）`);
  }
  if (typeof random !== 'function') {
    throw new TypeError('makeToken: 必须注入 random()（optionalDeps: random），不退回 Math.random');
  }

  let out = '';
  for (let i = 0; i < length; i += 1) {
    const r = Number(random());
    // 越界（random() 返回 1、负数或 NaN）一律夹到合法下标，绝不产出 undefined
    const idx = Number.isFinite(r)
      ? Math.min(ALPHABET.length - 1, Math.max(0, Math.floor(r * ALPHABET.length)))
      : 0;
    out += ALPHABET[idx];
  }
  return out;
}

/**
 * 判断字符串是否「长得像令牌」：只看长度与字符集，不看内容是否真实/有效/未过期。
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isTokenShape(value) {
  if (typeof value !== 'string') return false;
  if (value.length < MIN_LEN || value.length > MAX_LEN) return false;
  return SHAPE_RE.test(value);
}

/**
 * 常量时间比较两串字符。
 *
 * 无论长度是否相同都跑满 max(len) 次循环：长度差只在最后作为结果位参与判定，
 * 不产生「长度不同就立刻返回」的短路（现有 tokenEq 有这条短路）。
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;

  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length; // 长度差先记进结果，不提前返回
  for (let i = 0; i < len; i += 1) {
    // 越界位置按 0 参与异或，循环次数只取决于较长的那个
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
