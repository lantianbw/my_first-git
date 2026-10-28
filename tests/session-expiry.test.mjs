import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, shouldRotate } from '../src/session/expiry.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

// 默认就「已满足」的底子，各用例只改动其中一两项。
const base = {
  createdAt: NOW - 25 * HOUR,
  lastIncomingAt: NOW - 20 * MINUTE,
  now: NOW,
  maxAgeMs: 24 * HOUR,
  idleMs: 10 * MINUTE,
  enabled: true,
  isOwnerKey: true
};

test('disabled：开关不是严格 true 就不轮换（含 spec 契约）', () => {
  assert.equal(spec.name, 'session/expiry');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(shouldRotate({ ...base, enabled: false }), { rotate: false, reason: 'disabled' });
  assert.deepEqual(shouldRotate({ ...base, enabled: undefined }), { rotate: false, reason: 'disabled' });
  assert.deepEqual(shouldRotate({ ...base, enabled: 'true' }), { rotate: false, reason: 'disabled' });
  // 关掉时其它条件再满足也不轮换
  assert.deepEqual(shouldRotate({ ...base, enabled: false, createdAt: NOW - 999 * HOUR }), {
    rotate: false,
    reason: 'disabled'
  });
});

test('not-owner：群聊或非主人私聊不轮换', () => {
  assert.deepEqual(shouldRotate({ ...base, isOwnerKey: false }), { rotate: false, reason: 'not-owner' });
  assert.deepEqual(shouldRotate({ ...base, isOwnerKey: undefined }), { rotate: false, reason: 'not-owner' });
  // enabled 判定优先于 owner 判定
  assert.equal(shouldRotate({ ...base, enabled: false, isOwnerKey: false }).reason, 'disabled');
});

test('no-timestamp：缺 createdAt 不轮换，并回传 needsStamp', () => {
  assert.deepEqual(shouldRotate({ ...base, createdAt: undefined }), {
    rotate: false,
    reason: 'no-timestamp',
    needsStamp: true
  });
  assert.deepEqual(shouldRotate({ ...base, createdAt: 0 }), {
    rotate: false,
    reason: 'no-timestamp',
    needsStamp: true
  });
  assert.deepEqual(shouldRotate({ ...base, createdAt: '不是数字' }), {
    rotate: false,
    reason: 'no-timestamp',
    needsStamp: true
  });
});

test('too-young：未满 maxAgeMs 不轮换，回传剩余时间', () => {
  const result = shouldRotate({ ...base, createdAt: NOW - HOUR, maxAgeMs: 2 * HOUR });
  assert.deepEqual(result, { rotate: false, reason: 'too-young', remainingMs: HOUR });
  // 阈值没给时按默认 24h
  assert.deepEqual(shouldRotate({ ...base, createdAt: NOW - 23 * HOUR, maxAgeMs: 0 }), {
    rotate: false,
    reason: 'too-young',
    remainingMs: HOUR
  });
});

test('busy：年龄够了但没空闲够 idleMs，回传剩余时间', () => {
  const result = shouldRotate({ ...base, lastIncomingAt: NOW - MINUTE, idleMs: 10 * MINUTE });
  assert.deepEqual(result, { rotate: false, reason: 'busy', remainingMs: 9 * MINUTE });
  // lastIncomingAt 缺失 → 视为很久没说话，不算 busy
  assert.deepEqual(shouldRotate({ ...base, lastIncomingAt: undefined }), { rotate: true, reason: 'ready' });
});

test('ready：开关开、owner、年龄与空闲都满足 → 轮换', () => {
  assert.deepEqual(shouldRotate(base), { rotate: true, reason: 'ready' });
  assert.deepEqual(shouldRotate({ ...base, createdAt: NOW - 100 * HOUR, lastIncomingAt: NOW - HOUR }), {
    rotate: true,
    reason: 'ready'
  });
});

test('边界：年龄恰好等于 maxAgeMs 即轮换，差 1ms 则不行', () => {
  assert.deepEqual(shouldRotate({ ...base, createdAt: NOW - 24 * HOUR }), { rotate: true, reason: 'ready' });
  assert.deepEqual(shouldRotate({ ...base, createdAt: NOW - 24 * HOUR + 1 }), {
    rotate: false,
    reason: 'too-young',
    remainingMs: 1
  });
});

test('边界：空闲恰好等于 idleMs 即轮换，差 1ms 则 busy', () => {
  assert.deepEqual(shouldRotate({ ...base, lastIncomingAt: NOW - 10 * MINUTE }), { rotate: true, reason: 'ready' });
  assert.deepEqual(shouldRotate({ ...base, lastIncomingAt: NOW - 10 * MINUTE + 1 }), {
    rotate: false,
    reason: 'busy',
    remainingMs: 1
  });
});
