import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContent, looksLikeVocativeAddress, spec, DEFAULT_META_BLOCK_WORDS } from '../src/guards/outbound-content.js';

test('正常文本原样放行', () => {
  const v = evaluateContent({ text: '在，怎么了' });
  assert.equal(v.ok, true);
  assert.equal(v.text, '在，怎么了');
});

test('元信息命中：拦下，reason 带命中的词', () => {
  const v = evaluateContent({ text: '我选择本次不发言' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
  assert.equal(v.word, '我选择本次不发言');
  assert.match(v.reason, /元信息泄漏/);
});

test('自定义词表覆盖默认词表', () => {
  const v = evaluateContent({ text: '内部口令XYZ', words: ['内部口令XYZ'] });
  assert.equal(v.ok, false);
  assert.equal(v.word, '内部口令XYZ');
});

test('meta 关闭时不再拦元信息', () => {
  const v = evaluateContent({ text: '我选择本次不发言', metaEnabled: false });
  assert.equal(v.ok, true);
});

test('「饲养员」一律拦（含 owner 私聊）', () => {
  for (const isOwnerPrivate of [true, false]) {
    const v = evaluateContent({ text: '饲养员吃饭了', isOwnerPrivate });
    assert.equal(v.ok, false);
    assert.equal(v.kind, 'address');
  }
});

test('「老爹」呼语：非 owner 私聊、非群聊 → 拦', () => {
  const v = evaluateContent({ text: '老爹，我饿了', isOwnerPrivate: false, isGroup: false });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'vocative');
});

test('「老爹」非呼语：非 owner 私聊 → 改写成「你」并标记 replaced', () => {
  const v = evaluateContent({ text: '今天老爹给我买了个蛋糕', isOwnerPrivate: false, isGroup: false });
  assert.equal(v.ok, true);
  assert.equal(v.replaced, true);
  assert.equal(v.text, '今天你给我买了个蛋糕');
});

test('群聊里「老爹」不改写也不拦（群友知道她有个爹）', () => {
  const v = evaluateContent({ text: '老爹，我饿了', isGroup: true });
  assert.equal(v.ok, true);
  assert.equal(v.text, '老爹，我饿了');
});

test('owner 私聊里「老爹」原样放行', () => {
  const v = evaluateContent({ text: '老爹，我饿了', isOwnerPrivate: true });
  assert.equal(v.ok, true);
  assert.equal(v.text, '老爹，我饿了');
});

test('address 关闭时「饲养员」放行', () => {
  const v = evaluateContent({ text: '饲养员吃饭了', addressEnabled: false });
  assert.equal(v.ok, true);
});

test('呼语判定的边界', () => {
  assert.equal(looksLikeVocativeAddress('老爹'), true);
  assert.equal(looksLikeVocativeAddress('老爹，'), true);
  assert.equal(looksLikeVocativeAddress('老爹！你在吗'), true);
  assert.equal(looksLikeVocativeAddress('老爹今天又加班到很晚'), false);
  assert.equal(looksLikeVocativeAddress('我爸'), false);
});

test('spec 与默认词表符合契约', () => {
  assert.equal(spec.name, 'guards/outbound-content');
  assert.equal(spec.toggle.level, 'owner');
  assert.ok(DEFAULT_META_BLOCK_WORDS.length >= 10);
  assert.ok(DEFAULT_META_BLOCK_WORDS.includes('我选择本次不发言'));
});
