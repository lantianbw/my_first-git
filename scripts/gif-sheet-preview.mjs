// 肉眼验收：把 sample-animated.gif 的拼图写到 %TEMP%\gif-sheet-preview.png。
// 拼图应看到 3 列 2 行的数字 1~6（8 帧等间隔抽 6 帧，首帧 1、末帧 8 附近）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeGifToSheet } from '../src/gif-frames.js';

const src = fileURLToPath(new URL('../tests/fixtures/sample-animated.gif', import.meta.url));
const out = join(tmpdir(), 'gif-sheet-preview.png');

const gif = readFileSync(src);
const sheet = decodeGifToSheet(gif);
if (!sheet) {
  console.error('拼图失败：decodeGifToSheet 返回 null');
  process.exit(1);
}
writeFileSync(out, sheet.png);
console.log(`原图: ${src} (${gif.length} bytes)`);
console.log(`拼图: ${out}`);
console.log(`尺寸: ${sheet.width}x${sheet.height}  帧数: ${sheet.frames}  字节: ${sheet.png.length}`);
