import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, nextDelay, delaysOf } from '../src/heal/retry.js';

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'heal/retry');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('三档递增：5s → 15s → 45s（factor=3 的等比曲线）', () => {
  assert.deepEqual(nextDelay({ attempt: 1 }), { delayMs: 5_000, capped: false, reason: 'growth' });
  assert.deepEqual(nextDelay({ attempt: 2 }), { delayMs: 15_000, capped: false, reason: 'growth' });
  assert.deepEqual(nextDelay({ attempt: 3 }), { delayMs: 45_000, capped: false, reason: 'growth' });

  // 严格递增，且每次都是上一次的 factor 倍
  const curve = delaysOf(4).map((d) => d.delayMs);
  assert.deepEqual(curve, [5_000, 15_000, 45_000, 135_000]);
  for (let i = 1; i < curve.length; i += 1) assert.ok(curve[i] > curve[i - 1], `第 ${i + 1} 档必须更大`);
});

test('上限夹紧：触顶后固定 maxMs 并标记 capped', () => {
  const atCap = nextDelay({ attempt: 10 });
  assert.deepEqual(atCap, { delayMs: 300_000, capped: true, reason: 'capped' });

  // 再往后多少次都一样，不会溢出成 Infinity/NaN
  for (const attempt of [11, 50, 1_000]) {
    const r = nextDelay({ attempt });
    assert.equal(r.delayMs, 300_000, `attempt=${attempt}`);
    assert.equal(r.capped, true);
  }

  // 自定义上限同样生效
  assert.equal(nextDelay({ attempt: 5, baseMs: 1_000, factor: 2, maxMs: 6_000 }).delayMs, 6_000);
  assert.equal(nextDelay({ attempt: 4, baseMs: 1_000, factor: 2, maxMs: 6_000 }).delayMs, 6_000, '8s 夹到 6s');
  assert.equal(nextDelay({ attempt: 3, baseMs: 1_000, factor: 2, maxMs: 6_000 }).delayMs, 4_000);
});

test('attempt=0 及非法 attempt：降级回首档，不抛', () => {
  for (const attempt of [0, -1, -99, NaN, 'abc', null, Infinity]) {
    const r = nextDelay({ attempt });
    assert.equal(r.delayMs, 5_000, `attempt=${String(attempt)}`);
    assert.equal(r.capped, false);
    assert.equal(r.reason, 'fallback', `attempt=${String(attempt)} 应标 fallback`);
  }

  // 不传 attempt 走参数默认值 1（能算就正常算），与「显式传非法值」不是一回事
  assert.deepEqual(nextDelay({ attempt: undefined }), { delayMs: 5_000, capped: false, reason: 'growth' });

  // 无参调用按 attempt=1 正常计算（全缺省时 base=5s），只有显式传入非法值才降级
  assert.deepEqual(nextDelay(), { delayMs: 5_000, capped: false, reason: 'growth' });

  // 降级也尊重自定义首档
  assert.equal(nextDelay({ attempt: 0, baseMs: 800 }).delayMs, 800);
});

test('factor=1：等距退避（不增长也不夹紧）', () => {
  const curve = delaysOf(5, { factor: 1 });
  assert.deepEqual(curve.map((d) => d.delayMs), [5_000, 5_000, 5_000, 5_000, 5_000]);
  assert.ok(curve.every((d) => d.capped === false));
  assert.ok(curve.every((d) => d.reason === 'growth'));
});

test('jitter 上下界：random=0 取下界，random=1 取上界，0.5 不偏移', () => {
  const base = { attempt: 2, baseMs: 10_000, factor: 2, jitter: 0.2 };
  // attempt=2 → raw=20000，±20% → [16000, 24000]
  assert.equal(nextDelay({ ...base, random: 0 }).delayMs, 16_000, '下界');
  assert.equal(nextDelay({ ...base, random: 1 }).delayMs, 24_000, '上界');
  assert.equal(nextDelay({ ...base, random: 0.5 }).delayMs, 20_000, '中点不偏移');

  // 抖动不能突破上限，也不能变成 0 延迟的忙等
  assert.equal(nextDelay({ attempt: 5, baseMs: 10_000, factor: 2, jitter: 0.2, random: 1, maxMs: 50_000 }).delayMs, 50_000);
  assert.equal(nextDelay({ attempt: 1, baseMs: 100, jitter: 1, random: 0 }).delayMs, 1, '下限兜到 1ms');

  // jitter=0（缺省）时 random 不影响结果
  assert.equal(nextDelay({ attempt: 3, random: 0 }).delayMs, nextDelay({ attempt: 3, random: 1 }).delayMs);
});

test('delaysOf：长度 = count，且与逐次调用一致', () => {
  assert.equal(delaysOf(0).length, 0);
  assert.equal(delaysOf(1).length, 1);
  assert.equal(delaysOf(6).length, 6);

  // 非法 count 不抛，返回空数组
  assert.deepEqual(delaysOf(-3), []);
  assert.deepEqual(delaysOf(NaN), []);
  assert.deepEqual(delaysOf(undefined), []);

  // 逐项等于 nextDelay(attempt=i+1)
  const curve = delaysOf(6);
  curve.forEach((item, index) => {
    assert.deepEqual(item, nextDelay({ attempt: index + 1 }), `第 ${index + 1} 项`);
  });

  // 曲线形态：先涨后平（触顶后全是 maxMs 且 capped）
  const tail = curve.slice(-2);
  assert.ok(tail.every((d) => d.delayMs === 300_000 && d.capped === true));
  assert.equal(curve[0].capped, false);
});

test('capped 标记：恰好等于上限不算夹紧，超过才算', () => {
  // base=100000 ×3：10万 → 30万（正好等于上限）→ 90万（超限）
  const exact = nextDelay({ attempt: 2, baseMs: 100_000, factor: 3, maxMs: 300_000 });
  assert.equal(exact.delayMs, 300_000);
  assert.equal(exact.capped, false, '恰好等于上限不算 capped');
  assert.equal(exact.reason, 'growth');

  const over = nextDelay({ attempt: 3, baseMs: 100_000, factor: 3, maxMs: 300_000 });
  assert.equal(over.delayMs, 300_000);
  assert.equal(over.capped, true, '超过上限才算 capped');
  assert.equal(over.reason, 'capped');

  // 抖动把值顶到上限时同样标 capped（delayMs 已等于 maxMs，不能报 false）
  const jittered = nextDelay({ attempt: 2, baseMs: 100_000, factor: 3, maxMs: 300_000, jitter: 0.2, random: 1 });
  assert.equal(jittered.delayMs, 300_000);
  assert.equal(jittered.capped, true);
});

test('非法入参：配置项越界抛 RangeError，非整数 attempt 向下取整', () => {
  assert.throws(() => nextDelay({ attempt: 1, baseMs: 0 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, baseMs: -1 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, factor: 0 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, factor: -2 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, maxMs: 0 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, jitter: 2 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, jitter: -0.1 }), RangeError);
  assert.throws(() => nextDelay({ attempt: 1, baseMs: NaN }), RangeError);

  // attempt 是运行期取值：小数向下取整（与旧 nextDelay 的 Math.floor 一致）
  assert.equal(nextDelay({ attempt: 2.7 }).delayMs, 15_000);
  assert.equal(nextDelay({ attempt: '3' }).delayMs, 45_000, '数字字符串按数值处理');

  // random 越界只夹不改判（不抛）：默认首档 5s，attempt=2 → raw 15s，±20% → [12s, 18s]
  assert.equal(nextDelay({ attempt: 2, jitter: 0.2, random: 5 }).delayMs, 18_000);
  assert.equal(nextDelay({ attempt: 2, jitter: 0.2, random: -5 }).delayMs, 12_000);
});
