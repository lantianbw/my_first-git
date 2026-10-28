// tests/session-lifecycle.test.mjs — session/lifecycle 特征测试（两条纯判定）
//
// 锁的是 bridge.js 里 isCurrentSession() 与 shouldRotateSession() 的**判定部分**。
// 簿记部分（retireSession / reconcileSessionPolicies / 时间戳回填）不在本模块内，
// 也不在这里断言——那是中枢的内存 Map 操作。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as expiry from '../src/session/expiry.js';
import { spec, isCurrentSession, shouldRotate, handle } from '../src/session/lifecycle.js';

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

/** 一个「三个闸全过」的轮换入参。 */
function rotateArgs(overrides = {}) {
  const createdAt = 1_700_000_000_000;
  const now = createdAt + 24 * HOUR;
  return {
    createdAt,
    lastIncomingAt: now - 10 * MIN,
    now,
    maxAgeMs: 24 * HOUR,
    idleMs: 10 * MIN,
    enabled: true,
    isOwnerKey: true,
    ...overrides
  };
}

/** 一个「三项全匹配」的会话判定入参。 */
function currentArgs(overrides = {}) {
  return {
    allowed: true,
    mappedSessionId: 'sess-abc',
    sessionId: 'sess-abc',
    storedPolicy: '["reserved2","qq-chat-v2",null]',
    currentPolicy: '["reserved2","qq-chat-v2",null]',
    ...overrides
  };
}

// ── 契约 ────────────────────────────────────────────────────────────────

test('契约：spec 冻结、名字与路径一致、semver、locked、无 deps/guards', () => {
  assert.equal(spec.name, 'session/lifecycle');
  assert.ok(Object.isFrozen(spec));
  assert.match(spec.version, /^\d+\.\d+\.\d+$/);
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.default, true);
  assert.equal(spec.toggle.hot, true);
  assert.deepEqual([...spec.deps], []);
  assert.deepEqual([...spec.optionalDeps], []);
  assert.deepEqual([...spec.guards], []);
});

test('复用 session/expiry 的 shouldRotate，没有第二份实现', () => {
  assert.equal(shouldRotate, expiry.shouldRotate);
});

// ── shouldRotate：三个闸 ────────────────────────────────────────────────

test('age 闸边界：正好 24h 放行（其余闸全过 → 轮换）', () => {
  const out = shouldRotate(rotateArgs());
  assert.equal(out.rotate, true);
  assert.equal(out.reason, 'ready');
});

test('age 闸边界：差 1ms 不轮换，并给出还差多久', () => {
  const args = rotateArgs();
  const out = shouldRotate({ ...args, now: args.now - 1 });
  assert.equal(out.rotate, false);
  assert.equal(out.reason, 'too-young');
  assert.equal(out.remainingMs, 1);
});

test('idle 闸边界：正好 10min 放行（≥ 口径，与中枢的 > 有意不同）', () => {
  const args = rotateArgs();
  const out = shouldRotate({ ...args, lastIncomingAt: args.now - 10 * MIN });
  assert.equal(out.rotate, true);
  assert.equal(out.reason, 'ready');
});

test('idle 闸边界：9min59.999s 不轮换，并说明在等对话间隙', () => {
  const args = rotateArgs();
  const out = shouldRotate({ ...args, lastIncomingAt: args.now - (10 * MIN - 1) });
  assert.equal(out.rotate, false);
  assert.equal(out.reason, 'busy');
  assert.equal(out.remainingMs, 1);
});

test('createdAt 缺失：不轮换，且要求中枢回填时间戳', () => {
  for (const createdAt of [undefined, null, 0, 'not-a-number']) {
    const out = shouldRotate(rotateArgs({ createdAt }));
    assert.equal(out.rotate, false, String(createdAt));
    assert.equal(out.reason, 'no-timestamp', String(createdAt));
    assert.equal(out.needsStamp, true, String(createdAt));
  }
});

test('enabled=false：完全不轮换（开关优先于一切）', () => {
  assert.deepEqual(shouldRotate(rotateArgs({ enabled: false })), { rotate: false, reason: 'disabled' });
  // 未声明也算关：宁可不换，也不能凭 undefined 就退役主人会话
  assert.equal(shouldRotate(rotateArgs({ enabled: undefined })).reason, 'disabled');
});

test('非 owner key：不轮换（轮换只服务于主人私聊）', () => {
  assert.deepEqual(shouldRotate(rotateArgs({ isOwnerKey: false })), { rotate: false, reason: 'not-owner' });
  assert.equal(shouldRotate(rotateArgs({ isOwnerKey: undefined })).reason, 'not-owner');
});

test('时钟倒退（now < createdAt）：按 0 岁处理，不给负 remaining', () => {
  const args = rotateArgs();
  const out = shouldRotate({ ...args, now: args.createdAt - 5 * HOUR });
  assert.equal(out.rotate, false);
  assert.equal(out.reason, 'too-young');
  assert.equal(out.remainingMs, 24 * HOUR);
});

test('阈值非法：maxAgeMs/idleMs 回退默认 24h / 10min', () => {
  const args = rotateArgs();
  for (const maxAgeMs of [0, -1, NaN, undefined, 'x']) {
    const out = shouldRotate({ ...args, maxAgeMs });
    assert.equal(out.rotate, true, `maxAgeMs=${String(maxAgeMs)} 应回退 24h 后放行`);
  }
  for (const idleMs of [0, -1, NaN, undefined]) {
    const out = shouldRotate({ ...args, idleMs });
    assert.equal(out.rotate, true, `idleMs=${String(idleMs)} 应回退 10min 后放行`);
  }
});

test('空入参不抛：返回不轮换', () => {
  const out = shouldRotate();
  assert.equal(out.rotate, false);
  assert.equal(out.reason, 'disabled');
});

// ── isCurrentSession：三处比对 ──────────────────────────────────────────

test('会话 id 不等 → 不是当前会话', () => {
  assert.equal(isCurrentSession(currentArgs({ mappedSessionId: 'sess-old' })), false);
});

test('会话 id 相等且其余匹配 → 是当前会话', () => {
  assert.equal(isCurrentSession(currentArgs()), true);
});

test('策略字符串不等 → 不是当前会话（模式/preset/owner 变化）', () => {
  assert.equal(isCurrentSession(currentArgs({ storedPolicy: '["reserved2","qq-chat",null]' })), false);
});

test('策略缺失 → 不是当前会话（不能拿「没存过」当「一样」）', () => {
  assert.equal(isCurrentSession(currentArgs({ storedPolicy: undefined })), false);
  assert.equal(isCurrentSession(currentArgs({ currentPolicy: null })), false);
});

test('策略两边都是数组时按序列化比较', () => {
  const policy = ['reserved2', 'qq-chat-v2', null];
  assert.equal(isCurrentSession(currentArgs({ storedPolicy: policy, currentPolicy: [...policy] })), true);
  assert.equal(isCurrentSession(currentArgs({ storedPolicy: policy, currentPolicy: ['reserved2', 'other', null] })), false);
});

test('allowed=false → 不是当前会话（准入优先，其余全对也不行）', () => {
  assert.equal(isCurrentSession(currentArgs({ allowed: false })), false);
});

test('allowed 不是布尔 true（如字符串 "true"）→ 不是当前会话', () => {
  assert.equal(isCurrentSession(currentArgs({ allowed: 'true' })), false);
  assert.equal(isCurrentSession(currentArgs({ allowed: 1 })), false);
});

test('会话 id 缺失/非字符串 → 不是当前会话（两边都缺也不算「同一个」）', () => {
  assert.equal(isCurrentSession(currentArgs({ sessionId: undefined, mappedSessionId: undefined })), false);
  assert.equal(isCurrentSession(currentArgs({ sessionId: '', mappedSessionId: '' })), false);
  assert.equal(isCurrentSession(currentArgs({ sessionId: 123, mappedSessionId: 123 })), false);
});

test('空入参不抛：返回 false', () => {
  assert.equal(isCurrentSession(), false);
  assert.equal(isCurrentSession({}), false);
});

// ── handle ──────────────────────────────────────────────────────────────

test('handle：current-session 返回布尔', () => {
  const ok = handle({}, { action: 'current-session', ...currentArgs() });
  assert.deepEqual(ok, { ok: true, value: true });
  const stale = handle({}, { action: 'current-session', ...currentArgs({ sessionId: 'x' }) });
  assert.equal(stale.value, false);
});

test('handle：rotate 返回判定对象', () => {
  const out = handle({}, { action: 'rotate', ...rotateArgs() });
  assert.equal(out.ok, true);
  assert.equal(out.value.rotate, true);
  assert.equal(out.value.reason, 'ready');
});

test('handle：未知或缺失 action 一律拒绝（不默认执行任何判定）', () => {
  for (const action of [undefined, '', 'rotate-all', 'current']) {
    const out = handle({}, action === undefined ? {} : { action });
    assert.equal(out.ok, false, String(action));
    assert.equal(out.code, 'INVALID_ARGS', String(action));
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
  }
});

test('handle：无 ctx 也能工作（本模块不读任何依赖）', () => {
  assert.equal(handle(undefined, { action: 'rotate', ...rotateArgs() }).value.rotate, true);
  assert.equal(handle(undefined, { action: 'current-session', ...currentArgs() }).value, true);
});
