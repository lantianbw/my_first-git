import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, renderSummary, renderDaily, handle } from '../src/cost/report.js';

/** 从输出里摘出百分比（排除标题行与合计行，只看数据行）。 */
function sharesIn(text) {
  return text
    .split('\n')
    .filter((line) => !line.includes('摘要') && !line.includes('趋势') && !line.startsWith('合计') && !line.startsWith('─') && !line.startsWith('（'))
    .flatMap((line) => line.match(/(\d+\.\d)%/g) ?? [])
    .map((token) => Number.parseFloat(token));
}

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'cost/report');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('空摘要：不抛错，给一句人话而不是空表', () => {
  for (const input of [undefined, null, {}, { conversations: [] }, { conversations: 'bad' }]) {
    const out = renderSummary(input);
    assert.equal(typeof out, 'string');
    assert.match(out, /暂无数据/);
    assert.ok(!out.includes('NaN'));
    assert.ok(!out.includes('undefined'));
  }
});

test('单会话：花费、占比、轮次、token 都对得上', () => {
  const out = renderSummary({
    totals: { cost: 12.5 },
    conversations: [
      { key: 'private:10001', cost: 12.5, turns: 4, buckets: { cacheMiss: 1000, cacheHit: 500, cacheWrite: 0, output: 200 } }
    ]
  });

  assert.match(out, /1 个会话/);
  assert.match(out, /private:10001/);
  assert.match(out, /¥12\.50/);
  assert.match(out, /100\.0%/);
  assert.match(out, /1\.7K/);
  assert.ok(out.split('\n').length >= 5);
});

test('多会话：按花费降序排列', () => {
  const out = renderSummary({
    conversations: [
      { key: 'cheap', cost: 1 },
      { key: 'pricey', cost: 20 },
      { key: 'middle', cost: 5 }
    ]
  });

  const pricey = out.indexOf('¥20.00');
  const middle = out.indexOf('¥5.00');
  const cheap = out.indexOf('¥1.00');

  assert.ok(pricey > 0 && middle > 0 && cheap > 0);
  assert.ok(pricey < middle, '贵的应排在前面');
  assert.ok(middle < cheap, '次贵的应排在中间');
});

test('占比：三均分也合计 100.0%，不会出现 99.9', () => {
  const out = renderSummary({
    conversations: [
      { key: 'a', cost: 1 },
      { key: 'b', cost: 1 },
      { key: 'c', cost: 1 }
    ]
  });

  const shares = sharesIn(out);
  assert.equal(shares.length, 3);
  const sum = shares.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `占比合计应为 100，实际 ${sum}`);
  assert.match(out, /合计.*100\.0%/);
});

test('日表：按日期升序一行一天，含趋势条与合计', () => {
  const rows = [
    { date: '2026-10-27', cost: 25, tokens: 240000, turns: 10 },
    { date: '2026-10-26', cost: 12.5, tokens: 120000, turns: 8 }
  ];
  const out = renderDaily(rows);

  assert.match(out, /每日成本趋势 · 2 天/);
  assert.ok(out.indexOf('2026-10-26') < out.indexOf('2026-10-27'), '应升序');
  assert.match(out, /¥12\.50/);
  assert.match(out, /120\.0K/);
  assert.match(out, /合计/);
  assert.ok(out.includes('█'), '应有趋势条');

  // 最大值占满整条，次大只占一半（按降序比较长度，不依赖行序）
  const bars = (out.match(/█+/g) ?? []).map((bar) => bar.length).sort((a, b) => b - a);
  assert.deepEqual(bars, [12, 6]);
});

test('日表：缺日期排最后，空输入给提示', () => {
  const out = renderDaily([{ date: '2026-10-26', cost: 2 }, { cost: 9 }, {}]);
  const lines = out.split('\n');
  assert.ok(lines.some((line) => line.startsWith('—')), '缺日期应显示 —');
  assert.ok(out.lastIndexOf('—') > out.indexOf('2026-10-26'), '缺日期的应排在最后');

  assert.match(renderDaily([]), /暂无数据/);
  assert.match(renderDaily(undefined), /暂无数据/);
});

test('缺字段降级：没有 key / cost / buckets 也不崩，不泄出 undefined', () => {
  const out = renderSummary({ conversations: [{}, { key: 'group:1' }] });

  assert.match(out, /未命名会话/);
  assert.match(out, /¥0\.00/);
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('NaN'));
});

test('超大数缩写：1.5M / 2.5K，钱只加千分位不缩写', () => {
  const big = renderSummary({
    conversations: [{ key: 'huge', cost: 1234567.891, buckets: { cacheMiss: 1000000, cacheHit: 500000 } }]
  });
  assert.match(big, /1\.5M/);
  // 金额保留两位小数 + 千分位，不用 K/M（否则会藏掉分位）
  assert.match(big, /¥1,234,567\.89/);

  const k = renderSummary({ conversations: [{ key: 'mid', cost: 1, totalTokens: 2500 }] });
  assert.match(k, /2\.5K/);
});

test('NaN 保护：脏数字一律归零，输出里不出现 NaN / Infinity', () => {
  const out = renderSummary({
    totals: { cost: Number.NaN },
    conversations: [
      { key: 'bad', cost: Number.NaN, turns: Number.NaN, buckets: { cacheMiss: Number.NaN, cacheHit: Infinity } }
    ]
  });

  assert.ok(!/NaN|Infinity/.test(out));
  assert.match(out, /¥0\.00/);

  const daily = renderDaily([{ date: '2026-10-26', cost: Number.NaN, tokens: Number.POSITIVE_INFINITY }]);
  assert.ok(!/NaN|Infinity/.test(daily));
});

test('被 summary(limit) 截断时，明示账本总额与差额', () => {
  const out = renderSummary({
    totals: { cost: 100 },
    conversations: [{ key: 'a', cost: 10 }]
  });

  assert.match(out, /账本总额 ¥100\.00/);
  assert.match(out, /差额 ¥90\.00/);

  // 未截断时不该出现这句
  const clean = renderSummary({ totals: { cost: 10 }, conversations: [{ key: 'a', cost: 10 }] });
  assert.ok(!clean.includes('账本总额'));
});

test('handle：按动作分发，未知动作返回 INVALID_ARGS 而不抛错', () => {
  const ok = handle({}, { action: 'summary', summary: {} });
  assert.equal(ok.ok, true);
  assert.match(ok.value, /暂无数据/);

  const daily = handle({}, { action: 'daily', rows: [] });
  assert.equal(daily.ok, true);

  const bad = handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  assert.match(bad.error, /未知动作/);
});
