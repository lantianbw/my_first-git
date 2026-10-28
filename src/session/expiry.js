// session/expiry — 判断当前会话该不该轮换（纯函数版 shouldRotateSession）
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （由调用方传毫秒时间戳，模块不读时钟）
// 失败策略：fail-open            （依据：D 表 session/lifecycle「退役失败只是多留一个旧会话」）
// 单测：tests/session-expiry.test.mjs
//
// 为什么需要：bridge.js 的 shouldRotateSession 把开关、owner 判定、时间戳迁移、年龄、空闲
// 五个判断揉在一起，还顺手写 state（state.sessionMeta[key] = { createdAt }）。抽成纯函数后
// 「该不该换」可以单测，「记时间戳」仍留给中枢执行（needsStamp 标记）。
// 边界：不读时钟、不写 state、不查会话是否存在、不 import bridge；只回答该不该轮换。
//
// 与 bridge 的差异：那里空闲判定是 `idleMs > 10 分钟`（严格大于），这里按契约改为
// `idle >= idleMs`——边界值恰好到点即可轮换，避免再多等一个 tick。

export const spec = Object.freeze({
  name: 'session/expiry',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 阈值类参数：只有正数才认，0 / 负数 / 非数字一律回默认值（与 bridge 的 Number(x) > 0 一致）。 */
function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @pure 返回 { rotate, reason, remainingMs?, needsStamp? }。
 * reason: 'disabled' | 'not-owner' | 'no-timestamp' | 'too-young' | 'busy' | 'ready'
 */
export function shouldRotate({
  createdAt,
  lastIncomingAt,
  now,
  maxAgeMs,
  idleMs,
  enabled,
  isOwnerKey
} = {}) {
  if (enabled !== true) return { rotate: false, reason: 'disabled' };
  if (isOwnerKey !== true) return { rotate: false, reason: 'not-owner' };

  const created = num(createdAt, 0);
  // 老会话没记过创建时间：从本次起计时，不立即轮换（bridge 里的升级迁移）。
  if (!created) return { rotate: false, reason: 'no-timestamp', needsStamp: true };

  const at = Math.max(0, num(now, 0));
  const age = Math.max(0, at - created);
  const maxAge = positive(maxAgeMs, DEFAULT_MAX_AGE_MS);
  if (age < maxAge) return { rotate: false, reason: 'too-young', remainingMs: maxAge - age };

  // 只在对话间隙换：聊天中退役会打断正在进行的话题。
  const idle = Math.max(0, at - num(lastIncomingAt, 0));
  const idleLimit = positive(idleMs, DEFAULT_IDLE_MS);
  if (idle < idleLimit) return { rotate: false, reason: 'busy', remainingMs: idleLimit - idle };

  return { rotate: true, reason: 'ready' };
}
