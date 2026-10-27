// 回归：GIF 抽帧拼图（src/gif-frames.js）。
// 素材：tests/fixtures/sample-animated.gif（8 帧 400×300，每帧一个数字 1~8）、
//       tests/fixtures/sample-static.gif（单帧负例）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { decodeGifToSheet, isGifBuffer } from '../src/gif-frames.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)));

test('动图：拼图成功，帧数在 2~6，PNG 不超过 1.5MB', () => {
  const gif = fixture('sample-animated.gif');
  assert.equal(isGifBuffer(gif, ''), true, '应凭 GIF89a 头认出 GIF');

  const sheet = decodeGifToSheet(gif);
  assert.notEqual(sheet, null);
  assert.ok(sheet.frames >= 2 && sheet.frames <= 6, `frames=${sheet.frames}`);
  assert.ok(Buffer.isBuffer(sheet.png));
  assert.ok(sheet.png.length <= 1_500_000, `png=${sheet.png.length}`);
  assert.ok(sheet.width > 0 && sheet.height > 0);

  // 400×300 的 6 帧 3 列 2 行：单格缩到 240×180，四周与格间各 4px。
  assert.equal(sheet.width, 3 * 240 + 4 * 4);
  assert.equal(sheet.height, 2 * 180 + 3 * 4);
});

test('单帧 GIF：frames === 1（仍是合法拼图）', () => {
  const sheet = decodeGifToSheet(fixture('sample-static.gif'));
  assert.notEqual(sheet, null);
  assert.equal(sheet.frames, 1);
  assert.ok(sheet.png.length > 0);
});

test('非 GIF 输入：返回 null', () => {
  assert.equal(decodeGifToSheet(Buffer.from('not a gif')), null);
  assert.equal(isGifBuffer(Buffer.from('not a gif')), false);
  assert.equal(isGifBuffer(Buffer.alloc(0), 'image/gif'), true, 'mime 是 image/gif 时直接认');
});

test('同输入两次产物字节完全一致（无随机性）', () => {
  const gif = fixture('sample-animated.gif');
  const a = decodeGifToSheet(gif);
  const b = decodeGifToSheet(gif);
  assert.equal(a.frames, b.frames);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.ok(a.png.equals(b.png), '两次拼图字节应完全相同');
});
