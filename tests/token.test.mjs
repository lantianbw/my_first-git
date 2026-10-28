import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, makeToken, isTokenShape, safeEqual } from '../src/auth/token.js';

/** 可复现的伪随机源（只用于测试，不参与实现）。 */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('spec：契约字段齐备且已冻结；random 必须注入', () => {
  assert.equal(spec.name, 'auth/token');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, ['random']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  // 没有随机源就不生成，绝不退回 Math.random()
  assert.throws(() => makeToken(), /必须注入 random/);
  assert.throws(() => makeToken({ random: 0.5 }), TypeError);
});

test('默认长度：32 位 hex，两次生成不相同', () => {
  const a = makeToken({ random: seeded(7) });
  const b = makeToken({ random: seeded(9) });

  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b, '不同随机源必须得到不同令牌');
  assert.equal(isTokenShape(a), true, '默认产物必须通过形状校验');
});

test('自定义长度：16 / 48 / 128 都按需定长；越界或非整数报错', () => {
  for (const len of [16, 48, 128]) {
    const token = makeToken({ length: len, random: seeded(len) });
    assert.equal(token.length, len, `length=${len}`);
    assert.match(token, new RegExp(`^[0-9a-f]{${len}}$`));
    assert.equal(isTokenShape(token), true);
  }

  for (const bad of [0, 15, 129, 32.5, '32', null, NaN]) {
    assert.throws(() => makeToken({ length: bad, random: seeded(1) }), RangeError, `length=${String(bad)}`);
  }
});

test('random 边界：0 → 首字符，1 → 末字符（夹住，不产出 undefined）', () => {
  assert.equal(makeToken({ random: () => 0 }), '0'.repeat(32));
  assert.equal(makeToken({ random: () => 1 }), 'f'.repeat(32), 'random()===1 必须夹到末位而不是越界');

  // 越界/异常随机值同样不能把令牌写坏
  for (const r of [0.999999999, -1, NaN, Infinity]) {
    const token = makeToken({ random: () => r });
    assert.equal(token.length, 32);
    assert.match(token, /^[0-9a-f]{32}$/, `random()=${String(r)}`);
    assert.equal(token.includes('undefined'), false);
  }

  // 0 与 1 两端都在合法字符集内
  assert.equal(makeToken({ length: 16, random: () => 0 }) < makeToken({ length: 16, random: () => 1 }), true);
});

test('isTokenShape 正例：16~128 位、[A-Za-z0-9_-] 都算合法形状', () => {
  assert.equal(isTokenShape('a'.repeat(16)), true, '下界');
  assert.equal(isTokenShape('A'.repeat(128)), true, '上界');
  assert.equal(isTokenShape('abcDEF0123456789_-'), true, '大小写 + 下划线 + 连字符');
  assert.equal(isTokenShape('0123456789abcdef0123456789abcdef'), true, '32 位 hex（现有 agentToken 形态）');
  assert.equal(isTokenShape(makeToken({ random: seeded(3) })), true, '自产令牌自校验');
});

test('isTokenShape 反例：长度越界、含非法字符、非字符串一律 false', () => {
  assert.equal(isTokenShape('a'.repeat(15)), false, '少一位');
  assert.equal(isTokenShape('a'.repeat(129)), false, '多一位');
  assert.equal(isTokenShape(''), false);
  assert.equal(isTokenShape('has space in it 1234'), false, '空格');
  assert.equal(isTokenShape('dots.are.not.allowed.012'), false, '点号');
  assert.equal(isTokenShape('slash/not/allowed/0123'), false, '斜杠');
  assert.equal(isTokenShape('中文令牌中文令牌中文令牌中文令牌'), false, '非 ASCII');
  assert.equal(isTokenShape(`abc${'\n'}defghijklmnop`), false, '换行');
  assert.equal(isTokenShape(null), false);
  assert.equal(isTokenShape(undefined), false);
  assert.equal(isTokenShape(1234567890123456), false, '数字不是字符串');
  assert.equal(isTokenShape(['a'.repeat(32)]), false);
});

test('safeEqual 相等 / 不等：逐字符比较', () => {
  const token = makeToken({ random: seeded(11) });

  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, makeToken({ random: seeded(11) })), true, '同一随机源可复现');
  assert.equal(safeEqual(token, makeToken({ random: seeded(12) })), false);

  // 只差一个字符：位置在开头/中间/结尾都必须判不等
  const flip = (s, i) => `${s.slice(0, i)}${s[i] === 'a' ? 'b' : 'a'}${s.slice(i + 1)}`;
  assert.equal(safeEqual(token, flip(token, 0)), false);
  assert.equal(safeEqual(token, flip(token, 16)), false);
  assert.equal(safeEqual(token, flip(token, 31)), false);
});

test('safeEqual 长度不同：前缀全同也判不等（且不抛）', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abcd', 'abc'), false);
  assert.equal(safeEqual('a'.repeat(32), 'a'.repeat(33)), false);
  assert.equal(safeEqual('a'.repeat(33), 'a'.repeat(32)), false);
  assert.equal(safeEqual('x'.repeat(31) + 'y', 'x'.repeat(32)), false, '只差最后一位');
  assert.equal(safeEqual('y', 'x'.repeat(32)), false, '长度悬殊');

  // 两个合法令牌长度不同：不能因为前缀相同就放过
  const long = 'a'.repeat(64);
  const short = 'a'.repeat(32);
  assert.equal(safeEqual(long, short), false);
});

test('safeEqual 空值 / 非字符串：一律 false，不抛', () => {
  assert.equal(safeEqual('', ''), false, '空串不是有效令牌');
  assert.equal(safeEqual('', 'abc'), false);
  assert.equal(safeEqual('abc', ''), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(null, 'a'.repeat(32)), false);
  assert.equal(safeEqual(123, '123'), false);
  assert.equal(safeEqual({}, {}), false);
  assert.equal(safeEqual(['a'], ['a']), false);
});
