import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  normalizeInbound,
  sanitizeMediaItem,
  sanitizeMediaList,
  sanitizeForwardIds,
  handle
} from '../src/inbound/message.js';

const TIME = 1_700_000_000_000;

/** 一份「三处构造点都会拼出来」的最小合法输入；单测只覆盖差异字段。 */
function makeInput(overrides = {}) {
  return {
    key: 'group:123456789',
    kind: 'group',
    chatId: '123456789',
    userId: '987654321',
    senderName: '小明',
    messageId: '4521',
    seq: 7,
    isSelf: false,
    isOwner: false,
    quoteTargetIsSelf: false,
    text: '在吗',
    plainText: '在吗',
    media: [],
    mediaText: [],
    forwardIds: [],
    poke: null,
    atUserId: null,
    time: TIME,
    ...overrides
  };
}

/** 断言归一成功并取出 message，失败时把整个结果打出来（比 assert.ok 更好定位）。 */
function ok(input) {
  const result = normalizeInbound(input);
  assert.equal(result.ok, true, `期望归一成功，实际 ${JSON.stringify(result)}`);
  return result.message;
}

test('spec：契约字段齐备且已冻结（locked / deps 空）', () => {
  assert.equal(spec.name, 'inbound/message');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.deps));
  assert.ok(Object.isFrozen(spec.toggle));
});

test('DTO 字段集合与顺序固定：20 个，一个不多一个不少', () => {
  const msg = ok(makeInput());
  assert.deepEqual(Object.keys(msg), [
    'key', 'kind', 'chatId', 'userId', 'senderName',
    'messageId', 'seq',
    'isSelf', 'isOwner', 'quoteTargetIsSelf',
    'text', 'plainText',
    'media', 'hasMedia', 'mediaText',
    'forwardIds', 'hasForward', 'poke', 'atUserId',
    'time'
  ]);
});

test('正常路径：群聊带引用 + 图片 + 媒体文本 + 转发 + @', () => {
  const msg = ok(makeInput({
    quoteTargetIsSelf: true,
    isOwner: true,
    text: '[引用 小红：在吗][图片]',
    plainText: '[图片]',
    media: [{ kind: 'image', file: 'abc.image', url: 'https://cdn.example/x', sub_type: 0 }],
    mediaText: ['图片里写着：早安'],
    forwardIds: ['fwd-1'],
    atUserId: '111222333'
  }));

  assert.equal(msg.key, 'group:123456789');
  assert.equal(msg.kind, 'group');
  assert.equal(msg.chatId, '123456789');
  assert.equal(msg.userId, '987654321');
  assert.equal(msg.senderName, '小明');
  assert.equal(msg.messageId, '4521');
  assert.equal(msg.seq, 7);
  assert.equal(msg.isOwner, true);
  assert.equal(msg.quoteTargetIsSelf, true);
  assert.equal(msg.isSelf, false);
  assert.equal(msg.text, '[引用 小红：在吗][图片]');
  assert.equal(msg.plainText, '[图片]');
  assert.deepEqual(msg.media, [{ kind: 'image', file: 'abc.image', url: 'https://cdn.example/x', subType: '0' }]);
  assert.equal(msg.hasMedia, true);
  assert.deepEqual(msg.mediaText, ['图片里写着：早安']);
  assert.deepEqual(msg.forwardIds, ['fwd-1']);
  assert.equal(msg.hasForward, true);
  assert.equal(msg.poke, null);
  assert.equal(msg.atUserId, '111222333');
  assert.equal(msg.time, TIME);
});

test('私聊：chatId 缺省时取 key 后半段（key 已过 parseKey）', () => {
  const msg = ok(makeInput({ key: 'private:555', kind: 'private', chatId: undefined, senderName: '' }));
  assert.equal(msg.kind, 'private');
  assert.equal(msg.chatId, '555');
  assert.equal(msg.senderName, '', '空显示名允许');
  assert.equal(ok(makeInput({ key: 'group:123456789', chatId: '  ' })).chatId, '123456789');
});

test('三类媒体：image / sticker / face 各自保留标识字段', () => {
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'image', file: 'a.jpg' }),
    { kind: 'image', file: 'a.jpg' }
  );
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'sticker', url: 'https://cdn.example/s.gif', subType: '1' }),
    { kind: 'sticker', url: 'https://cdn.example/s.gif', subType: '1' }
  );
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'face', faceId: 123, summary: '笑' }),
    { kind: 'face', faceId: '123', summary: '笑' }
  );
});

test('kind 白名单：非法 kind 一律 image；face 缺 faceId / image-sticker 无标识则丢弃', () => {
  assert.deepEqual(sanitizeMediaItem({ kind: 'video', file: 'a.mp4' }), { kind: 'image', file: 'a.mp4' });
  assert.deepEqual(sanitizeMediaItem({ file: 'a.jpg' }), { kind: 'image', file: 'a.jpg' }, 'kind 缺失按 image');
  assert.deepEqual(sanitizeMediaItem({ kind: 'IMAGE', file: 'a.jpg' }), { kind: 'image', file: 'a.jpg' });

  assert.equal(sanitizeMediaItem({ kind: 'face', url: 'https://cdn.example/x' }), null, 'face 必须带 faceId');
  assert.equal(sanitizeMediaItem({ kind: 'image' }), null, 'file/url/emojiId 全空要丢');
  assert.equal(sanitizeMediaItem({ kind: 'sticker', file: '  ', url: '', emojiId: '' }), null, '纯空白不算标识');
  assert.deepEqual(sanitizeMediaItem({ kind: 'image', emojiId: 'e1' }), { kind: 'image', emojiId: 'e1' }, 'emojiId 单独也算');

  for (const junk of [null, undefined, 'image', 42, []]) {
    assert.equal(sanitizeMediaItem(junk), null, String(junk));
  }
});

test('subType：snake_case 优先、回退 camelCase、数字转字符串', () => {
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'image', file: 'a', sub_type: '1', subType: '0' }),
    { kind: 'image', file: 'a', subType: '1' }
  );
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'image', file: 'a', subType: 0 }),
    { kind: 'image', file: 'a', subType: '0' },
    '数字 0 也要转成字符串，不能被当真值丢掉'
  );
  assert.deepEqual(sanitizeMediaItem({ kind: 'image', file: 'a', sub_type: '' }), { kind: 'image', file: 'a' });
  assert.equal('subType' in sanitizeMediaItem({ kind: 'image', file: 'a' }), false, '没有就不写字段');
});

test('summary：压掉换行/控制字符、限长 60、空摘要不落字段', () => {
  const item = sanitizeMediaItem({ kind: 'image', file: 'a', summary: '  line1\nline2\u0000  ' });
  assert.equal(item.summary, 'line1 line2');

  const long = sanitizeMediaItem({ kind: 'image', file: 'a', summary: 'x'.repeat(100) });
  assert.equal(long.summary.length, 60);

  assert.equal('summary' in sanitizeMediaItem({ kind: 'image', file: 'a', summary: '   ' }), false);
});

test('emoji 三兄弟不丢：emojiId / emojiPackageId / emojiKey', () => {
  assert.deepEqual(
    sanitizeMediaItem({ kind: 'sticker', url: 'https://cdn.example/s', emojiId: 'e1', emojiPackageId: 'p1', emojiKey: 'k1' }),
    { kind: 'sticker', url: 'https://cdn.example/s', emojiId: 'e1', emojiPackageId: 'p1', emojiKey: 'k1' }
  );
});

test('sanitizeMediaList：丢空项、按 kind+标识去重、非数组返回空数组', () => {
  const list = sanitizeMediaList([
    { kind: 'image', file: 'a.jpg' },
    { kind: 'image', file: 'a.jpg' },
    { kind: 'sticker', file: 'a.jpg' },
    null,
    { kind: 'face' },
    { kind: 'image', url: 'https://cdn.example/b.jpg' },
    { kind: 'image', file: ' a.jpg ' }
  ]);
  assert.equal(list.length, 3, '重复的 image 与空 face 被丢掉，sticker 因 kind 不同保留');
  assert.deepEqual(list.map((m) => m.kind), ['image', 'sticker', 'image']);

  for (const junk of [undefined, null, 'image', { 0: { kind: 'image', file: 'a' } }]) {
    assert.deepEqual(sanitizeMediaList(junk), [], String(junk));
  }
});

test('sanitizeForwardIds：脏数据过滤、不去重、非数组返回空数组', () => {
  assert.deepEqual(
    sanitizeForwardIds(['abc123', ' abc123 ', '', null, 'has space', 'x'.repeat(300), 'a/b=c']),
    ['abc123', 'abc123', 'a/b=c'],
    '空值/超长/带空白字符被丢掉；重复项保留（去重留中枢）'
  );
  assert.deepEqual(sanitizeForwardIds(undefined), []);
  assert.deepEqual(sanitizeForwardIds('abc123'), []);
  assert.deepEqual(sanitizeForwardIds([{}, '  ', null, undefined]), [], '不是 id 的形状一律丢掉');

  // sanitizeForwardId 本身会把标量转成字符串再校验（既有实现，appendSocialV2Message 同样如此）：
  // 0 / false 会变成 '0' / 'false' 留下来。这里如实钉住，不在本模块另加一层类型判断。
  assert.deepEqual(sanitizeForwardIds([0, false]), ['0', 'false']);
});

test('mediaText：去空白、最多 6 条、非数组当没有', () => {
  const msg = ok(makeInput({ mediaText: ['a', ' ', 'b', 2, 'c', 'd', 'e', 'f', 'g'] }));
  assert.deepEqual(msg.mediaText, ['a', 'b', '2', 'c', 'd', 'e']);
  assert.deepEqual(ok(makeInput({ mediaText: 'ocr 文本' })).mediaText, []);
  assert.deepEqual(ok(makeInput({ mediaText: undefined })).mediaText, []);
});

test('空文本：text / plainText 都是空串，hasMedia 为 false', () => {
  const msg = ok(makeInput({ text: '', plainText: undefined, media: [], mediaText: [] }));
  assert.equal(msg.text, '');
  assert.equal(msg.plainText, '');
  assert.equal(msg.hasMedia, false);
  assert.deepEqual(msg.media, []);
});

test('messageId：缺失为空串、数字转字符串（可空但类型固定）', () => {
  assert.equal(ok(makeInput({ messageId: undefined })).messageId, '');
  assert.equal(ok(makeInput({ messageId: null })).messageId, '');
  assert.equal(ok(makeInput({ messageId: 4521 })).messageId, '4521');
});

test('plainText：缺失时回退 text，显式空串不回落', () => {
  assert.equal(ok(makeInput({ text: 'hi', plainText: undefined })).plainText, 'hi');
  assert.equal(ok(makeInput({ text: 'hi', plainText: '' })).plainText, '');
});

test('poke 三种形态：null / 群聊指向自己 / 私聊无目标', () => {
  assert.equal(ok(makeInput({ poke: undefined })).poke, null);

  assert.deepEqual(
    ok(makeInput({ poke: { targetId: 987654321, targetIsSelf: true, groupId: 123456789 } })).poke,
    { targetId: '987654321', targetIsSelf: true, groupId: '123456789' }
  );

  assert.deepEqual(
    ok(makeInput({ key: 'private:555', kind: 'private', poke: { targetId: null, targetIsSelf: false } })).poke,
    { targetId: null, targetIsSelf: false, groupId: null }
  );

  // targetIsSelf 只信任入参，不由 targetId 反推（模块拿不到 selfId）
  assert.deepEqual(
    ok(makeInput({ poke: { targetId: '', targetIsSelf: true, groupId: ' ' } })).poke,
    { targetId: null, targetIsSelf: true, groupId: null }
  );
});

test('poke 畸形（非 null 非对象）→ INVALID_ARGS，不静默当 null', () => {
  for (const poke of ['self', 1, [], true]) {
    const result = normalizeInbound(makeInput({ poke }));
    assert.equal(result.ok, false, String(poke));
    assert.equal(result.code, 'INVALID_ARGS');
    assert.match(result.error, /poke/);
  }
});

test('时间必传：缺失 / null / NaN / 字符串 / Infinity 一律 INVALID_ARGS', () => {
  for (const time of [undefined, null, Number.NaN, '1700000000000', Infinity]) {
    const result = normalizeInbound(makeInput({ time }));
    assert.equal(result.ok, false, String(time));
    assert.equal(result.code, 'INVALID_ARGS');
    assert.match(result.error, /time/);
  }
});

test('非法 key → INVALID_ARGS（含空串、缺 id、非规范前缀、含空白、非字符串）', () => {
  for (const key of ['', '   ', 'group', 'group:', 'qq:123', 'group:12 34', 123, null]) {
    const result = normalizeInbound(makeInput({ key }));
    assert.equal(result.ok, false, String(key));
    assert.equal(result.code, 'INVALID_ARGS');
    assert.match(result.error, /key/);
  }
});

test('非法 kind / kind 与 key 不一致 → INVALID_ARGS', () => {
  for (const kind of ['channel', '', undefined, 1, null]) {
    const result = normalizeInbound(makeInput({ kind }));
    assert.equal(result.ok, false, String(kind));
    assert.equal(result.code, 'INVALID_ARGS');
    assert.match(result.error, /kind/);
  }

  const mismatch = normalizeInbound(makeInput({ kind: 'private' }));
  assert.equal(mismatch.ok, false, 'group: 的 key 配 private 的 kind 属于自相矛盾');
  assert.equal(mismatch.code, 'INVALID_ARGS');
  assert.match(mismatch.error, /不一致/);
});

test('fail closed 但不抛：非对象输入返回 ok:false', () => {
  for (const input of [null, undefined, [], 'group:1', 42, true]) {
    assert.doesNotThrow(() => normalizeInbound(input), String(input));
    const result = normalizeInbound(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.code, 'INVALID_ARGS');
    assert.equal(typeof result.error, 'string');
  }
});

test('文本保留原文：不截断、不动首尾空白', () => {
  const long = '啊'.repeat(3000);
  assert.equal(ok(makeInput({ text: long })).text.length, 3000);
  assert.equal(ok(makeInput({ text: long, plainText: long })).plainText.length, 3000);
  assert.equal(ok(makeInput({ text: '  缩进保留  ' })).text, '  缩进保留  ');
});

test('seq 归一：非数字/非正数 → 0（未知），小数取整', () => {
  assert.equal(ok(makeInput({ seq: undefined })).seq, 0);
  assert.equal(ok(makeInput({ seq: -3 })).seq, 0);
  assert.equal(ok(makeInput({ seq: '7' })).seq, 0, '字符串 seq 视为未知，不猜');
  assert.equal(ok(makeInput({ seq: Number.NaN })).seq, 0);
  assert.equal(ok(makeInput({ seq: 7.9 })).seq, 7);
});

test('atUserId 归一：空白 → null，数字转字符串，all 原样保留', () => {
  assert.equal(ok(makeInput({ atUserId: '' })).atUserId, null);
  assert.equal(ok(makeInput({ atUserId: '   ' })).atUserId, null);
  assert.equal(ok(makeInput({ atUserId: 12345 })).atUserId, '12345');
  assert.equal(ok(makeInput({ atUserId: 'all' })).atUserId, 'all', '不校验数字形态，all 有信息量');
});

test('纯函数：不改入参、同输入同输出、返回对象不共享', () => {
  const input = makeInput({
    media: [{ kind: 'image', file: 'a.jpg', summary: '笑' }],
    mediaText: ['x'],
    forwardIds: ['f1'],
    poke: { targetId: '1', targetIsSelf: false, groupId: '2' }
  });
  const snapshot = JSON.stringify(input);

  const first = ok(input);
  const second = ok(input);

  assert.equal(JSON.stringify(input), snapshot, '入参未被增删改');
  assert.deepEqual(first, second, '同输入同输出');
  assert.notEqual(first, second, '不返回共享的缓存对象');
  assert.notEqual(first.media, second.media, 'media 数组不共享引用');
  assert.notEqual(first.media[0], second.media[0], 'media 项不共享引用');
  assert.notEqual(first.poke, second.poke, 'poke 不共享引用');
  assert.notEqual(first.mediaText, second.mediaText);
});

test('handle：四个 action + 默认 normalize + 未知 action 拒绝', () => {
  const normalized = handle({}, { action: 'normalize', input: makeInput() });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.key, 'group:123456789');
  assert.equal(normalized.value.time, TIME);

  assert.equal(handle({}, { input: makeInput() }).ok, true, 'action 缺省按 normalize');

  const rejected = handle({}, { action: 'normalize', input: makeInput({ kind: 'channel' }) });
  assert.deepEqual(Object.keys(rejected).sort(), ['code', 'error', 'ok'], '失败形状与 B.2 一致');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INVALID_ARGS');

  assert.deepEqual(
    handle({}, { action: 'media-item', item: { kind: 'face', faceId: '9' } }),
    { ok: true, value: { kind: 'face', faceId: '9' } }
  );
  assert.deepEqual(handle({}, { action: 'media-item', item: { kind: 'face' } }), { ok: true, value: null });

  assert.equal(
    handle({}, { action: 'media-list', list: [{ kind: 'image', file: 'a' }, { kind: 'image', file: 'a' }] }).value.length,
    1
  );
  assert.deepEqual(handle({}, { action: 'forward-ids', list: ['has space', 'ok-1'] }).value, ['ok-1']);

  const unknown = handle({}, { action: 'nope' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'INVALID_ARGS');
  assert.match(unknown.error, /nope/);

  assert.doesNotThrow(() => handle(), '不传 ctx/args 也不能抛');
  assert.equal(handle().ok, false);
});
