// tests/outbound-send.test.mjs — outbound/send 特征测试（发送前文本整形）
//
// 这些用例锁的是 **bridge.js 里 splitLongSegment / singleLineForQQ 的既有行为**，
// 期望值全部由中枢原函数实跑得出，不是"看起来合理"的猜测。将来把中枢换成委托
// 本模块时，只要这份文件全绿，发出去的字节就没变。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec, DEFAULT_MAX_CHARS, singleLineForQQ, splitLongSegment,
  prepareOutboundText, handle
} from '../src/outbound/send.js';

/** 是否存在孤立代理（真 emoji 被拦腰切断的痕迹）。 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const dropSpaces = (s) => String(s).replace(/\s+/g, '');

// ── 契约 ────────────────────────────────────────────────────────────────

test('契约：spec 冻结、名字与路径一致、locked、无 deps/guards', () => {
  assert.equal(spec.name, 'outbound/send');
  assert.ok(Object.isFrozen(spec));
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.default, true);
  assert.equal(spec.toggle.hot, true);
  assert.deepEqual([...spec.deps], []);
  assert.deepEqual([...spec.optionalDeps], []);
  assert.deepEqual([...spec.guards], []);
});

test('DEFAULT_MAX_CHARS 与中枢默认值一致（500）', () => {
  assert.equal(DEFAULT_MAX_CHARS, 500);
});

// ── singleLineForQQ ─────────────────────────────────────────────────────

test('singleLineForQQ：换行与连续空格压成单空格并 trim', () => {
  assert.equal(singleLineForQQ('\n\n a \n\n b  c\t\td \n'), 'a b c d');
});

test('singleLineForQQ：null / undefined / 空串 → 空串', () => {
  assert.equal(singleLineForQQ(null), '');
  assert.equal(singleLineForQQ(undefined), '');
  assert.equal(singleLineForQQ(''), '');
  assert.equal(singleLineForQQ('  \n\t '), '');
});

test('singleLineForQQ：不吞全角空格与 NBSP（只认半角空格和 tab）', () => {
  assert.equal(singleLineForQQ('a\u00a0\u00a0b'), 'a\u00a0\u00a0b');
  assert.equal(singleLineForQQ('a\u3000\u3000b'), 'a\u3000\u3000b');
});

test('singleLineForQQ：数字等非字符串按中枢口径转字符串', () => {
  assert.equal(singleLineForQQ(12345), '12345');
});

// ── splitLongSegment ────────────────────────────────────────────────────

test('splitLongSegment：空内容 → []（null / 纯空白同）', () => {
  assert.deepEqual(splitLongSegment('', 10), []);
  assert.deepEqual(splitLongSegment('   ', 10), []);
  assert.deepEqual(splitLongSegment(null, 10), []);
  assert.deepEqual(splitLongSegment(undefined, 10), []);
});

test('splitLongSegment：不超长时只 trim，不切', () => {
  assert.deepEqual(splitLongSegment('  你好  ', 10), ['你好']);
});

test('splitLongSegment：恰好等于上限仍是一条', () => {
  assert.deepEqual(splitLongSegment('x'.repeat(500), 500).map((s) => s.length), [500]);
});

test('splitLongSegment：上限非法（0 / NaN / undefined / Infinity / 字符串）回退 500', () => {
  for (const max of [0, -1, NaN, undefined, Infinity, '600']) {
    assert.deepEqual(
      splitLongSegment('x'.repeat(600), max).map((s) => s.length),
      [500, 100],
      `max=${String(max)}`
    );
  }
});

test('splitLongSegment：小数上限向下取整', () => {
  assert.deepEqual(splitLongSegment('x'.repeat(600), 500.9).map((s) => s.length), [500, 100]);
});

test('splitLongSegment：按逗号类标点攒段并保留标点', () => {
  assert.deepEqual(
    splitLongSegment('第一句话，第二句话，第三句话', 6),
    ['第一句话，', '第二句话，', '第三句话']
  );
});

test('splitLongSegment：超长且无标点时按上限硬切，字符不丢', () => {
  const parts = splitLongSegment('啊'.repeat(12), 5);
  assert.deepEqual(parts.map((s) => s.length), [5, 5, 2]);
  assert.equal(parts.join(''), '啊'.repeat(12));
});

test('splitLongSegment：emoji 代理对不被切开', () => {
  const parts = splitLongSegment('😀'.repeat(6), 5);
  assert.deepEqual(parts.map((s) => s.length), [4, 4, 4]);
  assert.ok(parts.every((p) => !hasLoneSurrogate(p)));
  assert.equal(parts.join(''), '😀'.repeat(6));
});

test('splitLongSegment：URL 永不被切断，也不泄漏占位符', () => {
  const url = 'https://example.com/very/long/path?q=1&x=2';
  for (let n = 1; n <= 520; n++) {
    const parts = splitLongSegment('啊'.repeat(n) + url, 500);
    const joined = parts.join('');
    assert.ok(joined.includes(url), `n=${n} URL 丢了`);
    assert.ok(!joined.includes('\u0000'), `n=${n} 泄漏 NUL`);
    assert.ok(!joined.includes('URL0'), `n=${n} 泄漏字面量 URL0`);
  }
  const two = splitLongSegment('啊'.repeat(600) + url + '中间' + url, 500).join('');
  assert.equal(two.split(url).length - 1, 2);
});

test('splitLongSegment：超长段因占位符要让步，但不会失控', () => {
  const url = 'https://example.com/very/long/path?q=1&x=2';
  const parts = splitLongSegment('啊'.repeat(2000) + url, 500);
  const worst = Math.max(...parts.map((s) => s.length));
  assert.ok(worst <= 500 + 40, `最长 ${worst}`);
});

test('splitLongSegment：切点空白被吃掉，但字符一个不少', () => {
  const parts = splitLongSegment('aaa bbb ccc ddd', 7);
  assert.deepEqual(parts, ['aaa bbb', ' ccc dd', 'd']);
  assert.equal(dropSpaces(parts.join('')), dropSpaces('aaa bbb ccc ddd'));
});

// ── prepareOutboundText ─────────────────────────────────────────────────

test('prepareOutboundText：先切再压平，空段被过滤', () => {
  assert.deepEqual(prepareOutboundText('第一段\n\n第二段', { maxChars: 4 }), ['第一段', '第二段']);
});

test('prepareOutboundText：单条短文本压平后仍是一条', () => {
  assert.deepEqual(prepareOutboundText('\n 你好 \n 世界 \n', { maxChars: 100 }), ['你好 世界']);
});

test('prepareOutboundText：空输入 → []，缺省上限 500', () => {
  assert.deepEqual(prepareOutboundText('   '), []);
  assert.deepEqual(prepareOutboundText('x'.repeat(600)).map((s) => s.length), [500, 100]);
});

test('prepareOutboundText：每一条都不含换行（QQ 单条消息不吞换行）', () => {
  const parts = prepareOutboundText('啊\n'.repeat(400), { maxChars: 50 });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => !p.includes('\n')));
});

// ── handle ──────────────────────────────────────────────────────────────

test('handle：无 ctx 也能工作（本模块不读任何依赖）', () => {
  assert.equal(handle(undefined, { action: 'single-line', text: 'a\nb' }).value, 'a b');
  assert.deepEqual(handle(undefined, { action: 'split', text: '啊'.repeat(12), max: 5 }).value, ['啊啊啊啊啊', '啊啊啊啊啊', '啊啊']);
  assert.deepEqual(handle(undefined, { action: 'prepare', text: 'a\n\nb', maxChars: 10 }).value, ['a b']);
});

test('handle：缺省 action 走 prepare', () => {
  const out = handle({}, { text: 'a\nb' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, ['a b']);
});

test('handle：split 透传 max', () => {
  const out = handle({}, { action: 'split', text: 'x'.repeat(600), max: 100 });
  assert.equal(out.value.length, 6);
  assert.ok(out.value.every((s) => s.length === 100));
});

test('handle：会退化成 [object Object] 的入参一律拒收（fail closed）', () => {
  for (const text of [{ a: 1 }, [1, 2], () => '', Symbol('x')]) {
    const out = handle({}, { action: 'prepare', text });
    assert.equal(out.ok, false, String(typeof text));
    assert.equal(out.code, 'INVALID_ARGS');
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
  }
});

test('handle：可无损转字符串的原样接受', () => {
  assert.deepEqual(handle({}, { action: 'prepare', text: 123 }).value, ['123']);
  assert.deepEqual(handle({}, { action: 'prepare', text: true }).value, ['true']);
  assert.deepEqual(handle({}, { action: 'prepare', text: null }).value, []);
});

test('handle：未知 action 拒绝且带可读原因', () => {
  const out = handle({}, { action: 'nope', text: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_ARGS');
  assert.match(out.error, /nope/);
});
