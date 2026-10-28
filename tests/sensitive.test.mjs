import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSensitive, spec } from '../src/guards/sensitive.js';

test('普通聊天放行', () => {
  assert.deepEqual(evaluateSensitive({ text: '在，怎么了？今晚吃啥' }), { ok: true });
});

test('Windows 路径：拦下', () => {
  const v = evaluateSensitive({ text: '文件在 C:\\Users\\Bob\\secrets.txt' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'sensitive');
});

test('UNIX 路径：拦下', () => {
  const v = evaluateSensitive({ text: '看 /home/bob/.ssh/id_rsa' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'sensitive');
});

test('凭据赋值形态：拦下', () => {
  for (const text of ['token=abcd1234', '密码 是 hunter2', 'api_key: sk-xxxx']) {
    const v = evaluateSensitive({ text });
    assert.equal(v.ok, false, text);
    assert.equal(v.kind, 'sensitive', text);
  }
});

test('已知令牌精确命中：拦下且 kind=token', () => {
  const v = evaluateSensitive({ text: '这是令牌 a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 别外传', knownTokens: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'] });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'token');
});

test('裸 32-hex 不在名单时不拦（避免误伤表情 md5）', () => {
  const v = evaluateSensitive({ text: '这张表情 md5 是 a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', knownTokens: [] });
  assert.equal(v.ok, true);
});

test('不在审计范围时即使命中凭据也放行', () => {
  const v = evaluateSensitive({ text: 'token=abcd1234', isAuditKey: false });
  assert.equal(v.ok, true);
});

test('空文本放行', () => {
  assert.deepEqual(evaluateSensitive({ text: '' }), { ok: true });
  assert.deepEqual(evaluateSensitive({}), { ok: true });
});

test('spec 符合契约：locked 级别', () => {
  assert.equal(spec.name, 'guards/sensitive');
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.hot, true);
});

test('连续调用结果稳定（正则无 g 标志的状态污染）', () => {
  const text = 'token=abcd1234';
  for (let i = 0; i < 5; i += 1) {
    assert.equal(evaluateSensitive({ text }).ok, false);
  }
  assert.equal(evaluateSensitive({ text: '正常的一句话' }).ok, true);
});
