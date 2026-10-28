import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, escapeCq, stripInvisible, prepareOutbound, handle } from '../src/outbound/escape.js';

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'outbound/escape');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('转义四个字符：& [ ] , 依次换成实体', () => {
  assert.equal(escapeCq('a&b[c]d,e'), 'a&amp;b&#91;c&#93;d&#44;e');
  assert.equal(escapeCq('CQ:at'), 'CQ:at', '没有这四个字符就不该动');
  assert.equal(escapeCq('[CQ:at,qq=all]'), '&#91;CQ:at&#44;qq=all&#93;');
});

test('正常标点不变：全角标点与普通符号一律不动', () => {
  const clean = '你好，世界！《书名》「引用」（括号）？；：、—…～ 100% #tag @某人';
  assert.equal(escapeCq(clean), clean);
  assert.equal(stripInvisible(clean), clean);
});

test('零宽字符去除：ZWSP / ZWJ / BOM / 软连字符都不留', () => {
  assert.equal(stripInvisible('\u200B你\u200D好\u200C呀\uFEFF'), '你好呀');
  assert.equal(stripInvisible('a\u00ADb'), 'ab');
  assert.equal(stripInvisible('\u2060word\u2063'), 'word');
  assert.equal(stripInvisible('前\u2028后'), '前后');
});

test('控制符去除：C0 / DEL / C1 删掉，但换行保留', () => {
  assert.equal(stripInvisible('\u0000a\u0007b\u001Bc\u007Fd\u009Fe'), 'abcde');
  assert.equal(stripInvisible('a\tb'), 'ab', '制表符在 QQ 里没有意义');
  assert.equal(stripInvisible('a\r\nb'), 'a\nb', 'CRLF 收敛成 LF');
  assert.equal(stripInvisible('第一行\n第二行'), '第一行\n第二行', '换行是内容，必须留');
});

test('空串：所有函数都安全返回空结果', () => {
  assert.equal(escapeCq(''), '');
  assert.equal(stripInvisible(''), '');
  assert.deepEqual(prepareOutbound(''), { text: '', changed: false, removed: 0 });

  for (const empty of [null, undefined, 0]) {
    assert.equal(escapeCq(empty), String(empty ?? ''));
    assert.deepEqual(prepareOutbound(empty), { text: String(empty ?? ''), changed: false, removed: 0 });
  }
});

test('幂等：已转义的文本再转一次不变', () => {
  const once = escapeCq('a&b[c]d,e');
  assert.equal(escapeCq(once), once, '重跑不该变成 &amp;amp;');

  assert.equal(escapeCq('&amp;'), '&amp;');
  assert.equal(escapeCq('&#44;'), '&#44;');
  assert.equal(escapeCq('&#91;CQ&#93;'), '&#91;CQ&#93;');

  const prepared = prepareOutbound('a&b[c]d,e').text;
  assert.equal(prepareOutbound(prepared).text, prepared);
});

test('prepareOutbound 计数：removed 是删掉的字符个数', () => {
  assert.equal(prepareOutbound('a\u200Bb\u200Bc').removed, 2);
  assert.equal(prepareOutbound('\u0000\u0001\u0002abc').removed, 3);
  assert.equal(prepareOutbound('干净文本').removed, 0);

  // 转义只是替换、不是删除，不能计入 removed
  assert.equal(prepareOutbound('a,b[c]').removed, 0);
});

test('changed 标记：只在真的改动过时为 true', () => {
  assert.equal(prepareOutbound('一句正常的话。').changed, false);
  assert.equal(prepareOutbound('一句\u200B正常的话。').changed, true);
  assert.equal(prepareOutbound('有,逗号').changed, true);
  assert.equal(prepareOutbound('[CQ:at]').changed, true);
});

test('组合场景：先删不可见再转义，逐字保序', () => {
  const dirty = '\u200B你好\uFEFF，&[CQ:at,qq=1]\u0000\n第二行';
  const out = prepareOutbound(dirty);

  assert.equal(out.removed, 3); // \u200B / \uFEFF / \u0000
  assert.equal(out.changed, true);
  assert.equal(out.text, '你好，&amp;&#91;CQ:at&#44;qq=1&#93;\n第二行');

  // 保序：换行还在原来那个位置，前后文没被重排
  assert.equal(out.text.indexOf('你好，'), 0);
  assert.ok(out.text.indexOf('\n第二行') > out.text.indexOf('qq=1'));
  assert.equal(out.text.endsWith('第二行'), true);
});

test('handle：按动作分发，未知动作返回 INVALID_ARGS', () => {
  assert.deepEqual(handle({}, { action: 'escape', text: 'a,b' }).value, 'a&#44;b');
  assert.equal(handle({}, { action: 'strip', text: 'a\u200Bb' }).value, 'ab');
  assert.equal(handle({}, {}).value.text, '');

  const bad = handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
});
