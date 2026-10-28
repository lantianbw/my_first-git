import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, nextInterval, handle } from '../src/scheduler/interval.js';

// 固定一组边界：base 10000 / [1000, 60000]，无抖动时数值可手算。
const RANGE = { baseMs: 10000, minMs: 1000, maxMs: 60000, jitterRatio: 0 };

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'scheduler/interval');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('区间夹紧：基准远超上限时取上限，reason 说明夹紧', () => {
  const out = nextInterval({ ...RANGE, baseMs: 999999, activity: 0.5 });
  assert.equal(out.ms, 60000);
  assert.match(out.reason, /夹紧/);
});

test('区间夹紧：活跃度把结果压到下限以下时取下限', () => {
  const out = nextInterval({ baseMs: 1000, minMs: 4000, maxMs: 20000, jitterRatio: 0, activity: 0.9 });
  assert.equal(out.ms, 4000);
});

test('高活跃：间隔最短，落在下限', () => {
  const out = nextInterval({ ...RANGE, activity: 1 });
  assert.equal(out.ms, 1000);
  assert.equal(out.ms, RANGE.minMs);
  assert.match(out.reason, /高活跃/);
});

test('中活跃：中性活跃度正好落在基准上', () => {
  const out = nextInterval({ ...RANGE, activity: 0.5 });
  assert.equal(out.ms, 10000);
  assert.equal(out.ms, RANGE.baseMs);
  assert.match(out.reason, /中活跃/);
});

test('低活跃：间隔最长，落在上限', () => {
  const out = nextInterval({ ...RANGE, activity: 0 });
  assert.equal(out.ms, 60000);
  assert.equal(out.ms, RANGE.maxMs);
  assert.match(out.reason, /低活跃/);
});

test('活跃度单调：越活跃间隔越短，且始终在区间内', () => {
  const series = [0, 0.25, 0.5, 0.75, 1].map((activity) => nextInterval({ ...RANGE, activity }).ms);

  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i - 1] > series[i], `activity 升高时 ${series[i - 1]} 应大于 ${series[i]}`);
  }
  for (const ms of series) {
    assert.ok(ms >= RANGE.minMs && ms <= RANGE.maxMs, `${ms} 越界`);
  }
});

test('抖动：random 0 取下界、0.5 不偏移、1 取上界', () => {
  const base = { ...RANGE, jitterRatio: 0.2, activity: 0.5 };

  assert.equal(nextInterval({ ...base, random: 0 }).ms, 8000); // 10000 × 0.8
  assert.equal(nextInterval({ ...base, random: 0.5 }).ms, 10000); // 不偏移
  assert.equal(nextInterval({ ...base, random: 1 }).ms, 12000); // 10000 × 1.2

  // 抖动再大也不会突破区间：下界 ×0 → 0 被抬到 min，上界 ×2 → 100000 被压到 max
  assert.equal(nextInterval({ ...RANGE, baseMs: 10000, jitterRatio: 1, random: 0 }).ms, RANGE.minMs);
  assert.equal(nextInterval({ ...RANGE, baseMs: 50000, jitterRatio: 1, random: 1 }).ms, RANGE.maxMs);
});

test('抖动由传入的 random 决定：不传时按中性 0.5，结果可复现', () => {
  const args = { ...RANGE, jitterRatio: 0.3, activity: 0.4 };
  const a = nextInterval(args);
  const b = nextInterval(args);
  assert.deepEqual(a, b);
  assert.equal(a.ms, nextInterval({ ...args, random: 0.5 }).ms);
});

test('min === max：区间退化成一个点，任何活跃度与抖动都只能取该值', () => {
  const flat = { baseMs: 9000, minMs: 5000, maxMs: 5000, jitterRatio: 0.9 };

  assert.equal(nextInterval({ ...flat, activity: 0, random: 1 }).ms, 5000);
  assert.equal(nextInterval({ ...flat, activity: 1, random: 0 }).ms, 5000);
  assert.equal(nextInterval({ ...flat, activity: 0.5, random: 0.3 }).ms, 5000);
});

test('非法入参降级：不抛错、不出 NaN、结果仍落在默认区间', () => {
  const junk = nextInterval({
    baseMs: 'abc',
    minMs: Number.NaN,
    maxMs: -100,
    activity: 'high',
    jitterRatio: Number.POSITIVE_INFINITY,
    random: Number.NaN
  });

  assert.equal(Number.isFinite(junk.ms), true);
  assert.equal(junk.ms, 8000); // 默认 base，中性活跃度，不抖动
  assert.ok(!/NaN|Infinity/.test(junk.reason));

  for (const input of [undefined, null, {}, 'nonsense', []]) {
    const out = nextInterval(input);
    assert.equal(Number.isFinite(out.ms), true);
    assert.ok(out.ms >= 1000 && out.ms <= 120000);
    assert.equal(typeof out.reason, 'string');
    assert.ok(out.reason.trim().length > 0);
  }
});

test('上下界写反时自动交换，而不是返回 0 或负数', () => {
  const out = nextInterval({ baseMs: 3000, minMs: 5000, maxMs: 1000, activity: 0.5, jitterRatio: 0 });
  assert.equal(out.ms, 3000);
  assert.ok(out.ms >= 1000 && out.ms <= 5000);
});

test('活跃度越界被夹到 0~1，不会算出区间外的值', () => {
  const high = nextInterval({ ...RANGE, activity: 5 });
  const low = nextInterval({ ...RANGE, activity: -3 });
  assert.equal(high.ms, 1000);
  assert.equal(low.ms, 60000);
});

test('handle：契约形状 { ok, value }，与 nextInterval 一致', () => {
  const out = handle({}, { ...RANGE, activity: 1 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, nextInterval({ ...RANGE, activity: 1 }));
  assert.equal(out.value.ms, 1000);
});
