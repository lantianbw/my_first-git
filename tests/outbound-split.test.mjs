import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, splitText, handle } from '../src/outbound/split.js';

/** 去掉所有空白后比较——分段会吃掉段首尾的空格，字符本身一个都不能少。 */
const strip = (text) => String(text).replace(/\s+/g, '');

/** 所有段落非空，且拼起来去空白后与原文一致。 */
function assertLossless(text, result) {
  for (const part of result.parts) {
    assert.ok(part.length > 0, `出现了空段：${JSON.stringify(result.parts)}`);
  }
  assert.equal(strip(result.parts.join('')), strip(text));
}

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'outbound/split');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('短文本：不超上限就原样一段', () => {
  const out = splitText('今晚吃什么', { maxChars: 120 });
  assert.deepEqual(out.parts, ['今晚吃什么']);
  assert.equal(out.truncated, false);
  assert.match(out.reason, /单段/);
});

test('恰好在断句符：每段都以句末标点收尾', () => {
  const text = '一二三四。五六七八。';
  const out = splitText(text, { maxChars: 5 });

  assert.deepEqual(out.parts, ['一二三四。', '五六七八。']);
  assert.equal(out.truncated, false);
  assert.match(out.reason, /断句符/);
  assertLossless(text, out);
});

test('无断句符：按 maxChars 硬切', () => {
  const out = splitText('abcdefghij', { maxChars: 4 });
  assert.deepEqual(out.parts, ['abcd', 'efgh', 'ij']);
  assert.match(out.reason, /硬切/);
  assertLossless('abcdefghij', out);
});

test('超多段：超过 maxParts 合并尾段并标 truncated，内容不丢', () => {
  const text = 'A。'.repeat(10); // 10 段
  const out = splitText(text, { maxChars: 2, maxParts: 3 });

  assert.equal(out.parts.length, 3);
  assert.equal(out.truncated, true);
  assert.match(out.reason, /合并/);
  assert.equal(out.parts[2], 'A。'.repeat(8)); // 后 8 段并进末段
  assertLossless(text, out);
});

test('空串：不产生段落，给一句说明', () => {
  const out = splitText('');
  assert.deepEqual(out.parts, []);
  assert.equal(out.truncated, false);
  assert.match(out.reason, /空文本/);
});

test('空白串：全是空白也等于没有内容', () => {
  const out = splitText('   \n\t  ');
  assert.deepEqual(out.parts, []);
  assert.equal(out.truncated, false);
  assert.match(out.reason, /空白/);
});

test('单字：一个字也是一段，下界不塌成空串', () => {
  assert.deepEqual(splitText('好').parts, ['好']);
  assert.deepEqual(splitText('abc', { maxChars: 1 }).parts, ['a', 'b', 'c']);
});

test('全角标点：！？； 都算断句符', () => {
  const text = '你好！今天？算了；';
  const out = splitText(text, { maxChars: 3 });

  assert.deepEqual(out.parts, ['你好！', '今天？', '算了；']);
  assertLossless(text, out);
});

test('maxChars 边界：等于上限不切，多一个字才切', () => {
  assert.deepEqual(splitText('abcd', { maxChars: 4 }).parts, ['abcd']);
  assert.deepEqual(splitText('abcde', { maxChars: 4 }).parts, ['abcd', 'e']);
});

test('字符完整性：多种输入拼接后与原文去空白逐字相等', () => {
  const cases = [
    { text: '第一句。第二句！第三句？', options: { maxChars: 4 } },
    { text: '完全没有标点的一长串文字需要被硬切开但不能丢字', options: { maxChars: 5 } },
    { text: '短句。再来一句比较长的没有标点的内容', options: { maxChars: 6 } },
    { text: ' 前后有空格 。 中间 也有空格 ', options: { maxChars: 3 } },
    { text: 'A。'.repeat(12), options: { maxChars: 2, maxParts: 4 } },
    { text: '😀表情也算字符😀不能被劈开😀', options: { maxChars: 3 } }
  ];

  for (const { text, options } of cases) {
    const out = splitText(text, options);
    assertLossless(text, out);
    assert.equal(out.parts.length <= Math.max(1, options.maxParts ?? 6), true, `段数超上限：${text}`);
  }
});

test('代理对保护：硬切不会产生半个 emoji', () => {
  const out = splitText('😀😀😀', { maxChars: 3 });
  assert.equal(out.parts.length, 3);
  for (const part of out.parts) {
    assert.equal(part.length, 2, '一个 emoji 占两个码元');
    assert.equal([...part].length, 1, '不能是孤立代理');
    assert.equal(part, '😀');
  }
});

test('自定义 breakOn 与非法参数降级', () => {
  // 只认逗号
  const comma = splitText('一二三，四五六，七八九', { maxChars: 4, breakOn: '，' });
  assert.deepEqual(comma.parts, ['一二三，', '四五六，', '七八九']);

  // breakOn 为空 → 只能硬切
  const forced = splitText('abcdef', { maxChars: 3, breakOn: '' });
  assert.deepEqual(forced.parts, ['abc', 'def']);

  // 非法数字回落默认，不抛错
  for (const bad of [{ maxChars: 0 }, { maxChars: Number.NaN }, { maxChars: -5, maxParts: 0 }]) {
    const out = splitText('测试文本', bad);
    assert.deepEqual(out.parts, ['测试文本']);
    assert.equal(typeof out.reason, 'string');
  }
});

test('handle：契约形状 { ok, value }，与 splitText 一致', () => {
  const out = handle({}, '一二三四。五六七八。', { maxChars: 5 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, splitText('一二三四。五六七八。', { maxChars: 5 }));
  assert.equal(out.value.parts.length, 2);
});
