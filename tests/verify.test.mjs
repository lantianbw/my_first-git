import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, verifyToken } from '../src/auth/verify.js';

const EXPECTED = 'a'.repeat(32);

test('正常：一致即通过，不带错误 code（含 spec 契约）', () => {
  assert.equal(spec.name, 'auth/verify');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  const result = verifyToken({ provided: EXPECTED, expected: EXPECTED });
  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.ok(result.reason.length > 0);
});

test('缺失：required 默认 true，未提供即 MISSING', () => {
  assert.deepEqual(verifyToken({ provided: undefined, expected: EXPECTED }), {
    ok: false,
    code: 'MISSING',
    reason: '缺少令牌'
  });
  assert.equal(verifyToken({ provided: null, expected: EXPECTED }).code, 'MISSING');
  assert.equal(verifyToken({ expected: EXPECTED }).code, 'MISSING');
});

test('不匹配：内容不符或长度不符都是 MISMATCH', () => {
  const wrong = verifyToken({ provided: 'b'.repeat(32), expected: EXPECTED });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'MISMATCH');

  const short = verifyToken({ provided: 'a'.repeat(31), expected: EXPECTED });
  assert.equal(short.code, 'MISMATCH');

  const long = verifyToken({ provided: `${EXPECTED}x`, expected: EXPECTED });
  assert.equal(long.code, 'MISMATCH');

  // 非字符串输入不会抛，按不匹配处理
  assert.equal(verifyToken({ provided: 12345, expected: EXPECTED }).code, 'MISMATCH');
});

test('required=false 且未提供：放行，code=NOT_REQUIRED', () => {
  assert.deepEqual(verifyToken({ provided: undefined, expected: EXPECTED, required: false }), {
    ok: true,
    code: 'NOT_REQUIRED',
    reason: '本项不要求令牌，且未提供'
  });
  assert.equal(verifyToken({ provided: null, expected: '', required: false }).ok, true);
});

test('required=false 但提供了错误值：仍然 MISMATCH，不能因为不要求就放松', () => {
  const result = verifyToken({ provided: 'b'.repeat(32), expected: EXPECTED, required: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MISMATCH');

  // 提供了就一定要校验，哪怕 required=false
  assert.equal(verifyToken({ provided: EXPECTED, expected: EXPECTED, required: false }).ok, true);
});

test('空字符串：按「未提供」处理，required 时 MISSING、不要求时 NOT_REQUIRED', () => {
  assert.equal(verifyToken({ provided: '', expected: EXPECTED }).code, 'MISSING');
  assert.deepEqual(verifyToken({ provided: '', expected: EXPECTED, required: false }), {
    ok: true,
    code: 'NOT_REQUIRED',
    reason: '本项不要求令牌，且未提供'
  });
});

test('expected 为空：无法校验，一律 MISMATCH（fail closed）', () => {
  for (const expected of ['', undefined, null, 123]) {
    const result = verifyToken({ provided: EXPECTED, expected });
    assert.equal(result.ok, false, String(expected));
    assert.equal(result.code, 'MISMATCH');
    assert.equal(result.reason, '服务端未配置期望令牌，无法校验');
  }
  // 空 expected + 未提供 + required=false 仍走 NOT_REQUIRED（没有需要校验的东西）
  assert.equal(verifyToken({ provided: undefined, expected: '', required: false }).code, 'NOT_REQUIRED');
});
