import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, createRateLimiter } from '../src/outbound/rate.js';

/** 固定窗口 1000ms / 2 条；now 传数字即固定时钟，时刻一律显式传入便于推算。 */
const make = (over = {}) => createRateLimiter({ windowMs: 1000, max: 2, now: 0, ...over });

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'outbound/rate');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('首条允许：放行、剩 max-1、resetAt 是一整个窗口之后', () => {
  const limiter = make();
  const out = limiter.allow(0);

  assert.deepEqual(out, { allow: true, remaining: 1, resetAt: 1000 });
});

test('边界等于 max：第 max 条仍然放行，剩余归零', () => {
  const limiter = make({ max: 3 });

  assert.equal(limiter.allow(0).remaining, 2);
  assert.equal(limiter.allow(1).remaining, 1);

  const last = limiter.allow(2);
  assert.equal(last.allow, true);
  assert.equal(last.remaining, 0);
});

test('超出拒绝：第 max+1 条被拒，且给出 resetAt', () => {
  const limiter = make({ max: 2 });

  limiter.allow(0);
  limiter.allow(10);

  const rejected = limiter.allow(20);
  assert.equal(rejected.allow, false);
  assert.equal(rejected.remaining, 0);
  assert.equal(rejected.resetAt, 1000); // 最早一条 0 + 窗口 1000
});

test('窗口滑过后恢复：老记录滑出后名额回来', () => {
  const limiter = make({ max: 2 });

  limiter.allow(0);
  limiter.allow(10);
  assert.equal(limiter.allow(20).allow, false);

  // 1005 时 0 已滑出（1005-0 ≥ 1000），10 还在窗口内 → 腾出一个名额
  const recovered = limiter.allow(1005);
  assert.equal(recovered.allow, true);
  assert.equal(recovered.remaining, 0);

  // 再过一整个窗口，全部滑出
  assert.equal(limiter.remaining(2010), 2);
});

test('剩余数正确：只读推断，不消耗名额', () => {
  const limiter = make({ max: 2 });

  assert.equal(limiter.remaining(0), 2);
  limiter.allow(0);
  assert.equal(limiter.remaining(0), 1);
  limiter.allow(1);
  assert.equal(limiter.remaining(0), 0);

  // 反复查剩余不该改变状态
  limiter.remaining(0);
  limiter.remaining(0);
  assert.equal(limiter.allow(2).allow, false);

  // 窗口内滑走一条就回到 1
  assert.equal(limiter.remaining(900), 0);
  assert.equal(limiter.remaining(1000), 1); // 0 已滑出，1 还在
  assert.equal(limiter.remaining(1500), 2);
});

test('resetAt 正确：取最早一条记录 + 窗口', () => {
  const limiter = make({ max: 3 });

  assert.equal(limiter.resetAt(0), 0, '空窗口没有可重置的时刻');
  limiter.allow(1000);
  assert.equal(limiter.allow(1100).resetAt, 2000);
  assert.equal(limiter.resetAt(1500), 2000);

  // 记录滑出后归零（1100 那条要到 2100 才过期）
  assert.equal(limiter.resetAt(2000), 2100);
  assert.equal(limiter.resetAt(2100), 0);
  assert.equal(limiter.resetAt(5000), 0);
});

test('多 key 独立：两个实例互不影响（状态不泄漏）', () => {
  const groupA = make({ max: 1 });
  const groupB = make({ max: 1 });

  assert.equal(groupA.allow(0).allow, true);
  assert.equal(groupB.allow(0).allow, true, '另一个实例不该被 A 的放行影响');

  assert.equal(groupA.allow(0).allow, false);
  assert.equal(groupB.allow(0).allow, false);
  assert.equal(groupA.remaining(0), 0);
  assert.equal(groupB.remaining(0), 0);
});

test('时间倒退不崩：时钟回拨时按「仍在窗口内」计算，不抛错', () => {
  const limiter = make({ windowMs: 10000, max: 2 });

  assert.equal(limiter.allow(5000).allow, true);
  assert.equal(limiter.allow(4000).allow, true, '回拨后的时刻仍应被接受');

  const third = limiter.allow(4500);
  assert.equal(third.allow, false);
  assert.equal(third.resetAt, 14000); // min(5000, 4000) + 10000

  // 继续倒退也不崩
  assert.doesNotThrow(() => limiter.allow(-1));
  assert.equal(Number.isFinite(limiter.resetAt(-1)), true);
});

test('max = 0：全部拒绝，且不会记账', () => {
  const limiter = make({ max: 0 });

  for (const at of [0, 100, 999]) {
    const out = limiter.allow(at);
    assert.equal(out.allow, false);
    assert.equal(out.remaining, 0);
  }
  assert.equal(limiter.remaining(0), 0);
  assert.equal(limiter.resetAt(0), 0);
});

test('注入时钟：不传 at 时取 now()，传了 at 就不碰时钟', () => {
  let ticks = 0;
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => { ticks += 1; return now; } });

  now = 0;
  assert.equal(limiter.allow().allow, true);
  assert.equal(ticks, 1);

  now = 500;
  assert.equal(limiter.allow().allow, false);
  assert.equal(ticks, 2);

  const before = ticks;
  limiter.allow(1500);
  assert.equal(ticks, before, '显式传 at 时不该再读时钟');
});

test('非法参数：窗口/上限回落默认，缺时钟直接报可读错误', () => {
  const limiter = createRateLimiter({ windowMs: Number.NaN, max: -3, now: 0 });
  assert.equal(limiter.allow(0).allow, true);

  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 1 }), /now 时钟/);
});

test('返回对象被冻结，外部改不动内部状态', () => {
  const limiter = make();
  assert.ok(Object.isFrozen(limiter));

  const out = limiter.allow(0);
  out.remaining = 99;
  out.allow = false;

  // 改返回值不影响限流器
  assert.equal(limiter.remaining(0), 1);
});
