// tests/outbound-batch.test.mjs — outbound/batch 单测（间隔公式 / 上下界夹取 / 分发）
import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, DEFAULTS, computeGaps, clampGap, handle } from '../src/outbound/batch.js';

test('契约：spec 冻结、名字与路径一致、locked', () => {
  assert.equal(spec.name, 'outbound/batch');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['cfg', 'now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
  assert.ok(Object.isFrozen(spec.deps));
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('单段：不产生任何间隔（字符串与对象都一样）', () => {
  assert.deepEqual(computeGaps(['只有一条'], { mode: 'fixed', gapMs: 2000 }), []);
  assert.deepEqual(computeGaps([{ text: '只有一条' }], { mode: 'byLength' }), []);
  assert.deepEqual(computeGaps(['a'], { random: 0.5 }), []);
});

test('空数组 / null / undefined / 非数组：一律没有间隔', () => {
  assert.deepEqual(computeGaps([], { mode: 'fixed' }), []);
  assert.deepEqual(computeGaps(null, { mode: 'fixed' }), []);
  assert.deepEqual(computeGaps(undefined, { mode: 'fixed' }), []);
  // 旧实现只吃数组；字符串/对象被误传时这里按"没有可发内容"处理，不逐字取 length
  assert.deepEqual(computeGaps('abc', { mode: 'fixed' }), []);
  assert.deepEqual(computeGaps({ length: 3 }, { mode: 'fixed' }), []);
});

test('多段 fixed：gapMs 填满 n-1 个间隔', () => {
  const out = computeGaps(['一', '二', '三', '四'], { mode: 'fixed', gapMs: 1500 });
  assert.deepEqual(out, [1500, 1500, 1500]);
});

test('fixed：gaps 数组逐项夹取；数组不够长就整段回退 gapMs', () => {
  assert.deepEqual(
    computeGaps(['a', 'b', 'c'], { mode: 'fixed', gaps: [0, 999999] }),
    [DEFAULTS.clampMinMs, DEFAULTS.maxGapMs] // 0 视为取 min=300；999999 夹到 10000
  );
  assert.deepEqual(
    computeGaps(['a', 'b', 'c'], { mode: 'fixed', gaps: [500], gapMs: 1200 }),
    [1200, 1200]
  );
});

test('fixed：缺省参数时落在 1000ms（不是 clampGap 的 300）', () => {
  assert.deepEqual(computeGaps(['a', 'b'], { mode: 'fixed' }), [1000]);
  assert.equal(clampGap(undefined), 300);
});

test('byLength：base + 本段字数 * perChar，末段不参与', () => {
  // 800 + 3*20 = 860
  assert.deepEqual(computeGaps(['一二三', 'x'], { mode: 'byLength' }), [860]);
  assert.deepEqual(
    computeGaps([{ text: '一二三' }, { content: 'xy' }, { plain: 'z' }], { mode: 'byLength' }),
    [860, 840]
  );
});

test('byLength：全是空白段与空串也照字符数算，且最少按 1 字', () => {
  assert.deepEqual(computeGaps(['   ', '  ', ' '], { mode: 'byLength' }), [860, 840]);
  // 空串 length=0 → max(1, 0) = 1 → 800 + 20 = 820
  assert.deepEqual(computeGaps(['', '', ''], { mode: 'byLength' }), [820, 820]);
});

test('byLength：算出超上界时被 maxGapMs 夹住', () => {
  const long = 'x'.repeat(30); // 800 + 30*100 = 3800
  assert.deepEqual(
    computeGaps([long, 'y'], { mode: 'byLength', gapPerCharMs: 100, maxGapMs: 2000 }),
    [2000]
  );
});

test('clampGap 下界：低于 min 一律抬到 min', () => {
  assert.equal(clampGap(50), 300);
  assert.equal(clampGap(10, { burstIntervalMinMs: 200 }), 200);
  // 绝对下界 100：配置写得再小也不会低于 100
  assert.equal(clampGap(10, { burstIntervalMinMs: 20 }), 100);
});

test('clampGap 上界：高于 max 一律压到 max；max < min 时以 min 为准', () => {
  assert.equal(clampGap(999999), 10000);
  assert.equal(clampGap(999999, { maxGapMs: 5000 }), 5000);
  assert.equal(clampGap(500, { burstIntervalMinMs: 200, maxGapMs: 100 }), 200);
});

test('clampGap 非法入参：null / undefined / NaN 取 min，小数四舍五入', () => {
  assert.equal(clampGap(null), 300);
  assert.equal(clampGap(undefined), 300);
  assert.equal(clampGap(Number.NaN), 300);
  assert.equal(clampGap(''), 300);
  assert.equal(clampGap(1234.6), 1235);
});

test('auto：随机源注入（固定数字 / 函数），短间隔落在配置区间', () => {
  // random=0 → randInt(1000, 3000) = 1000
  assert.deepEqual(computeGaps(['a', 'b', 'c', 'd'], { random: 0 }), [1000, 1000, 1000]);
  // random=0.5 → floor(1000 + 0.5*2001) = 2000
  assert.deepEqual(computeGaps(['a', 'b'], { random: () => 0.5 }), [2000]);
  // 显式配置区间
  assert.deepEqual(
    computeGaps(['a', 'b'], { burstIntervalMinMs: 1200, burstIntervalMaxMs: 1200, random: 0.7 }),
    [1200]
  );
});

test('auto：长间隔概率为 1 时走 longGap 区间，并仍受 maxGapMs 夹取', () => {
  assert.deepEqual(
    computeGaps(['a', 'b', 'c'], { longGapProbability: 1, random: 0 }),
    [5000, 5000]
  );
  assert.deepEqual(
    computeGaps(['a', 'b'], {
      longGapProbability: 1,
      longGapMinMs: 9000,
      longGapMaxMs: 20000,
      maxGapMs: 10000,
      random: 0.5
    }),
    [10000]
  );
  // 概率 0 时不抽长间隔（旧实现靠 && 短路）
  assert.deepEqual(
    computeGaps(['a', 'b'], { longGapProbability: 0, longGapMinMs: 9000, random: 0 }),
    [1000]
  );
});

test('auto：缺随机源时拒绝，不猜间隔', () => {
  assert.throws(() => computeGaps(['a', 'b']), /随机源/);
  const bad = handle({}, { action: 'compute-gaps', segments: ['a', 'b'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  assert.match(bad.error, /随机源/);
});

test('段数很多：间隔数量与上下界稳定（200 段）', () => {
  const segments = Array.from({ length: 200 }, (_, i) => `第${i}条`);
  const out = computeGaps(segments, {
    mode: 'byLength',
    gapBaseMs: 100,
    gapPerCharMs: 1,
    burstIntervalMinMs: 4000,
    maxGapMs: 6000
  });
  assert.equal(out.length, 199);
  for (const gap of out) {
    assert.equal(gap, 4000, '短文本算出的间隔低于 min，应被抬到 4000');
    assert.ok(Number.isInteger(gap));
  }
});

test('handle：两个 action 正常分发，未知 action 拒绝', () => {
  const gaps = handle({}, { action: 'compute-gaps', segments: ['a', 'b'], options: { mode: 'fixed', gapMs: 1300 } });
  assert.equal(gaps.ok, true);
  assert.deepEqual(gaps.value, [1300]);

  const one = handle({}, { action: 'clamp-gap', ms: 1, options: { burstIntervalMinMs: 900 } });
  assert.equal(one.ok, true);
  assert.equal(one.value, 900);

  for (const args of [{ action: 'nope' }, {}, { action: 'compute' }]) {
    const bad = handle({}, args);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_ARGS');
    assert.equal(typeof bad.error, 'string');
  }
});
