// 本地保存的文件名整形回归（纯函数，不依赖 bridge 运行时）。
import assert from 'node:assert/strict';
import { sanitizeSaveName, extFromMime, ensureExt, ensureImageExt } from '../src/save-path.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

test('路径穿越/绝对路径都被压平成 basename', () => {
  assert.equal(sanitizeSaveName('../evil.txt'), 'evil.txt');
  assert.equal(sanitizeSaveName('..\\..\\win.txt'), 'win.txt');
  assert.equal(sanitizeSaveName('/abs/path/a.md'), 'a.md');
  assert.equal(sanitizeSaveName('目录/子目录/笔记.md'), '笔记.md');
});

test('非法字符与隐藏文件前缀被清理', () => {
  assert.equal(sanitizeSaveName('a<b>c:d.txt'), 'a_b_c_d.txt');
  assert.equal(sanitizeSaveName('  ...hidden  '), 'hidden');
  assert.equal(sanitizeSaveName('a"b|c?.txt'), 'a_b_c_.txt');
});

test('空名用 fallback，超长截到 80', () => {
  assert.equal(sanitizeSaveName('', 'fallback.txt'), 'fallback.txt');
  assert.equal(sanitizeSaveName('   ', 'note.txt'), 'note.txt');
  assert.equal(sanitizeSaveName('x'.repeat(200)).length, 80);
});

test('扩展名推断与补齐', () => {
  assert.equal(extFromMime('image/png'), 'png');
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(extFromMime('image/webp'), 'webp');
  assert.equal(extFromMime('image/gif'), 'gif');
  assert.equal(extFromMime('text/plain'), '');
  assert.equal(ensureExt('cat', 'png'), 'cat.png');
  assert.equal(ensureExt('cat.jpg', 'png'), 'cat.jpg');
  assert.equal(ensureExt('cat', ''), 'cat');
});

test('图片保存名：非图片扩展名按真实 mime 改写', () => {
  assert.equal(ensureImageExt('config.json', 'jpg'), 'config.jpg');
  assert.equal(ensureImageExt('cat', 'png'), 'cat.png');
  assert.equal(ensureImageExt('cat.png', 'jpg'), 'cat.png');
  assert.equal(ensureImageExt('a.b.webp', 'jpg'), 'a.b.webp');
  assert.equal(ensureImageExt('', 'jpg'), '');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
