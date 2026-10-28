import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, isDuplicate, handle } from '../src/outbound/dedupe.js';

// 固定"现在"：本模块不读时钟，所有时间都从 now 传入。
const NOW = 1761600000000;
const MIN = 60000;

/** 一条 21 字的样本：改 1 个字后 Dice 恰好是 0.9，用来卡阈值边界。 */
const ASCII_BASE = 'abcdefghijklmnopqrstu';

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'outbound/dedupe');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('完全相同：命中并带回 matchedAt', () => {
  const out = isDuplicate('好的，我看看', [{ text: '好的，我看看', at: NOW - 1000 }], { now: NOW });

  assert.equal(out.duplicate, true);
  assert.equal(out.matchedAt, NOW - 1000);
  assert.equal(out.similarity, 1);
});

test('窗口外不判重：10 分钟前说过的不算重复', () => {
  const history = [{ text: '好的，我看看', at: NOW - 11 * MIN }];
  const out = isDuplicate('好的，我看看', history, { now: NOW });
  assert.equal(out.duplicate, false);
  assert.equal(out.matchedAt, undefined);

  // 同一句话放进窗口内就命中
  const inside = isDuplicate('好的，我看看', [{ text: '好的，我看看', at: NOW - 5 * MIN }], { now: NOW });
  assert.equal(inside.duplicate, true);

  // 窗口可调
  const wide = isDuplicate('好的，我看看', history, { now: NOW, windowMs: 30 * MIN });
  assert.equal(wide.duplicate, true);
});

test('相似改写：改一个字仍判重（Dice 0.9375 ≥ 0.9）', () => {
  const original = '今天晚上我们一起去看电影吧，听说那部片子评价很不错，票已经买好了。';
  const rewritten = original.replace('买', '订');

  const out = isDuplicate(rewritten, [{ text: original, at: NOW - MIN }], { now: NOW });
  assert.equal(out.duplicate, true);
  assert.ok(out.similarity >= 0.9);
  assert.ok(out.similarity < 1);
});

test('不同内容：意思差得远就不判重', () => {
  const history = [{ text: '今天晚上我们一起去看电影吧，票已经买好了。', at: NOW - MIN }];

  assert.equal(isDuplicate('服务器又挂了快去重启', history, { now: NOW }).duplicate, false);
  // 短句改写差一个词，2-gram 重叠只有 0.6，也不该判重
  assert.equal(isDuplicate('今天天气很好', [{ text: '今天天气不错', at: NOW - MIN }], { now: NOW }).duplicate, false);
});

test('空文本：不判重，哪怕历史里也全是空串', () => {
  const history = [{ text: '', at: NOW - MIN }, { text: '   ', at: NOW - MIN }, { text: '好的', at: NOW - MIN }];

  for (const empty of ['', '   ', '\n\t ', null, undefined]) {
    assert.deepEqual(isDuplicate(empty, history, { now: NOW }), { duplicate: false });
  }
});

test('单字：没有 2-gram，只靠完全一致命中', () => {
  assert.equal(isDuplicate('好', [{ text: '好', at: NOW - MIN }], { now: NOW }).duplicate, true);
  assert.equal(isDuplicate('好', [{ text: '很好', at: NOW - MIN }], { now: NOW }).duplicate, false);
  assert.equal(isDuplicate('嗯', [{ text: '嗯嗯', at: NOW - MIN }], { now: NOW }).duplicate, false);
});

test('归一：大小写与空白不影响判定', () => {
  assert.equal(isDuplicate('Hello World', [{ text: 'hello   world', at: NOW - MIN }], { now: NOW }).duplicate, true);
  assert.equal(isDuplicate('今天 天气 不错', [{ text: '今天天气不错', at: NOW - MIN }], { now: NOW }).duplicate, true);
  assert.equal(isDuplicate('OK', [{ text: 'ok', at: NOW - MIN }], { now: NOW }).duplicate, true);
});

test('similarity 边界：恰好 0.9 判重，抬高一档就不判', () => {
  const changed = 'abcdefghijXlmnopqrstu'; // 改 1 字 → 36/40 = 0.9
  const history = [{ text: ASCII_BASE, at: NOW - MIN }];

  const atThreshold = isDuplicate(changed, history, { now: NOW, similarity: 0.9 });
  assert.equal(atThreshold.duplicate, true);
  assert.equal(atThreshold.similarity, 0.9);

  assert.equal(isDuplicate(changed, history, { now: NOW, similarity: 0.91 }).duplicate, false);
  assert.equal(isDuplicate(changed, history, { now: NOW, similarity: 0.89 }).duplicate, true);
});

test('history 为空：数组为空 / 不是数组都不判重，也不抛错', () => {
  for (const empty of [[], undefined, null, 'not-an-array', 42]) {
    assert.deepEqual(isDuplicate('随便一句话', empty, { now: NOW }), { duplicate: false });
  }
});

test('历史条目没有时间戳时按「窗口内」处理', () => {
  const out = isDuplicate('好的', ['好的'], { now: NOW });
  assert.equal(out.duplicate, true);
  assert.equal('matchedAt' in out, false, '没有时间戳就不该编一个出来');
});

test('不传 now 时不做窗口过滤，但仍可判重', () => {
  const history = [{ text: '好的', at: 0 }];
  assert.equal(isDuplicate('好的', history).duplicate, true);
  assert.equal(isDuplicate('好的', history, { now: NOW }).duplicate, false);
});

test('纯函数：不改入参，重复调用结果一致', () => {
  const history = [{ text: '好的，我看看', at: NOW - MIN }];
  const snapshot = JSON.parse(JSON.stringify(history));

  const first = isDuplicate('好的我看看', history, { now: NOW });
  const second = isDuplicate('好的我看看', history, { now: NOW });

  assert.deepEqual(history, snapshot);
  assert.deepEqual(first, second);
});

test('handle：契约形状 { ok, value }，缺省 now 时取 ctx.now()', () => {
  let called = 0;
  const ctx = { now: () => { called += 1; return NOW; } };

  const out = handle(ctx, '好的', [{ text: '好的', at: NOW - MIN }]);
  assert.equal(out.ok, true);
  assert.equal(out.value.duplicate, true);
  assert.equal(called, 1);

  // args 里给了 now 就不该再调 ctx.now
  handle(ctx, '好的', [{ text: '好的', at: NOW - MIN }], { now: NOW });
  assert.equal(called, 1);

  // 没有 ctx 也不抛
  assert.equal(handle(undefined, '好的', []).value.duplicate, false);
});
