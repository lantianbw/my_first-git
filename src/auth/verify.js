// auth/verify — 校验「调用方给的令牌」是否等于「服务端期望的令牌」
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-closed          （依据：D 表 auth/console-token、auth/agent-token「鉴权失败关闭」）
// 单测：tests/verify.test.mjs
//
// 为什么需要：bridge 里 consoleToken / agentToken / relay 令牌各写一遍「有没有给、给得对不对」，
// 有的用 `===` 短路、有的用 timingSafeEqual。这里把判定收成一处，比较一律走 token.js 的
// 常量时间 safeEqual，返回值带固定 code 供调用方做 401/403 区分。
// 边界：不读 cfg、不读 state、不 import bridge；只做比较，不负责下发/记录。

import { safeEqual } from './token.js';

export const spec = Object.freeze({
  name: 'auth/verify',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

/** 视为「没给」：undefined / null / 空串（HTTP 头里常见空串）。 */
const absent = (value) => value === undefined || value === null || value === '';

/**
 * @pure 返回 { ok, code?, reason }。
 * code: 'MISSING'（该给没给）| 'MISMATCH'（给了但对不上 / 期望值缺失）| 'NOT_REQUIRED'（不要求且没给）
 * expected 为空时一律 mismatch：服务端没配期望值就无从校验，不能当成「放行」。
 */
export function verifyToken({ provided, expected, required = true } = {}) {
  if (absent(provided)) {
    return required
      ? { ok: false, code: 'MISSING', reason: '缺少令牌' }
      : { ok: true, code: 'NOT_REQUIRED', reason: '本项不要求令牌，且未提供' };
  }
  if (typeof expected !== 'string' || expected === '') {
    return { ok: false, code: 'MISMATCH', reason: '服务端未配置期望令牌，无法校验' };
  }
  if (safeEqual(provided, expected)) return { ok: true, reason: '令牌匹配' };
  return { ok: false, code: 'MISMATCH', reason: '令牌不匹配' };
}
