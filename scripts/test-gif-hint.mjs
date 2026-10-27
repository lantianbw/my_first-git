// 回归：动图线索（gifHintOf）与「有了线索但字节是首帧 PNG」的降级判定。
//
// 线上故障背景：已部署的 GIF 拼图从未触发（'gif → sheet' 日志 0 次），原因是网关把动图
// 转成了 PNG 首帧，isGifBuffer 认不出来。这里锁住两点：
//   1) 消息段元信息（.gif 文件名 / 动画文案 / subType=1 / .gif URL）能给出线索；
//   2) 有线索但字节不是 GIF 时，不能去拼图（会白跑），只能走「只取到首帧」兜底。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { decodeGifToSheet, gifHintOf, gifMediaPlan, isGifBuffer } from '../src/gif-frames.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const pngBytes = () => {
  const buf = Buffer.alloc(64, 0x7f);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
};

test('线索 1：file 以 .gif 结尾', () => {
  assert.match(gifHintOf({ kind: 'image', file: 'ABCDEF1234.gif' }), /^file:.*\.gif$/);
  assert.equal(gifHintOf({ file: 'ABCDEF1234.GIF' }), 'file:ABCDEF1234.GIF', '后缀大小写都要认');
  assert.equal(gifHintOf({ file: 'ABCDEF1234.png' }), '', 'png 后缀不算线索');
});

test('线索 2：summary 含「动画」或「动图」', () => {
  assert.equal(gifHintOf({ summary: '[动画表情]' }), 'summary:动画');
  assert.equal(gifHintOf({ summary: '[动图]' }), 'summary:动图');
  assert.equal(gifHintOf({ summary: '[图片]' }), '');
});

test('线索 3：subType 为 1（数字或字符串都认）', () => {
  assert.equal(gifHintOf({ kind: 'image', subType: '1' }), 'subType=1');
  assert.equal(gifHintOf({ kind: 'image', subType: 1 }), 'subType=1');
  assert.equal(gifHintOf({ kind: 'image', subType: '0' }), '', "subType '0' 是普通图，不是线索");
  assert.equal(gifHintOf({ kind: 'image', subType: 2 }), '');
  // mface（市场表情）的 subType 是本地写死的 '1'，不是网关给的证据，不能当动图线索。
  assert.equal(gifHintOf({ kind: 'sticker', subType: '1', summary: '[表情]' }), '');
  // 但 sticker 若真有 .gif 的 file/url，仍能凭这两条认出动图。
  assert.equal(gifHintOf({ kind: 'sticker', subType: '1', url: 'https://e/x.gif' }), 'url:gif');
});

test('线索 4：url 含 .gif', () => {
  assert.equal(gifHintOf({ url: 'https://multimedia.nt.qq.com.cn/x/a.gif?term=2&x=1' }), 'url:gif');
  assert.equal(gifHintOf({ url: 'https://multimedia.nt.qq.com.cn/x/a.png' }), '');
});

test('线索 5：全部为空时返回空串（不要误报）', () => {
  assert.equal(gifHintOf({}), '');
  assert.equal(gifHintOf({ kind: 'image', file: '', summary: '', subType: '0', url: '' }), '');
  assert.equal(gifHintOf(null), '');
  assert.equal(gifHintOf(undefined), '');
  assert.equal(gifHintOf('not an object'), '');
});

test('线索 6：优先级固定（file 先于 summary / subType / url）', () => {
  const media = { file: 'x.gif', summary: '[动画]', subType: '1', url: 'https://e/x.gif' };
  assert.equal(gifHintOf(media), 'file:x.gif');
});

test('真 GIF：计划是拼图（sheet），并且确实能产出拼图', () => {
  const gif = fixture('sample-animated.gif');
  const hint = gifHintOf({ file: 'sample-animated.gif' });
  assert.equal(isGifBuffer(gif), true);
  assert.equal(gifMediaPlan(gif, 'image/gif', hint), 'sheet');
  assert.notEqual(decodeGifToSheet(gif), null);
});

test('有线索但字节是 PNG（网关转码首帧）：不许拼图，走兜底文案', () => {
  const png = pngBytes();
  const hint = gifHintOf({ summary: '[动画表情]', subType: '1' });
  assert.notEqual(hint, '');
  assert.equal(isGifBuffer(png), false);
  assert.equal(gifMediaPlan(png, 'image/png', hint), 'first-frame-only');
  // 拼图本身也必须拒绝掉，而不是产出一张空图。
  assert.equal(decodeGifToSheet(png), null);
});

test('既无线索又非 GIF：按静态图处理（不插任何动图文案）', () => {
  assert.equal(gifMediaPlan(pngBytes(), 'image/png', ''), 'static');
  assert.equal(gifMediaPlan(pngBytes(), 'image/png', gifHintOf({ summary: '[图片]' })), 'static');
});
