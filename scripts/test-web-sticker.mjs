// 回归：二期「网上找表情图」的解析与守门逻辑（src/web-sticker.js）。
//
// 不真联网：搜索页用 tests/fixtures/bing-images.html，图片字节用内存里的假 buffer。
// 覆盖：murl 提取（去重、只收 https、限 5 条）、真实类型嗅探（丢弃 HTML 报错页）、
//       单张/总量上限、配置门默认关闭、单日配额。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_IMAGE_BYTES,
  mimeFromBuffer,
  parseBingImageUrls,
  quotaSnapshot,
  resetDailyQuota,
  searchWebImage,
  stickerWebConfig
} from '../src/web-sticker.js';

const fixtureHtml = readFileSync(fileURLToPath(new URL('../tests/fixtures/bing-images.html', import.meta.url)), 'utf8');

const pngBytes = (size = 200) => {
  const buf = Buffer.alloc(size, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
};
const jpegBytes = (size = 200) => {
  const buf = Buffer.alloc(size, 0x22);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return buf;
};
const gifBytes = (size = 200) => {
  const buf = Buffer.alloc(size, 0x33);
  Buffer.from('GIF89a', 'latin1').copy(buf, 0);
  return buf;
};
const htmlBytes = () => Buffer.from('<!doctype html><html>error page</html>', 'utf8');

test('解析 Bing 结果：去重、只收 https、取前 5 条', () => {
  const urls = parseBingImageUrls(fixtureHtml);
  assert.equal(urls.length, 5, `实际: ${JSON.stringify(urls)}`);
  assert.equal(urls[0], 'https://cdn.example.com/a/one.jpg');
  assert.equal(urls[1], 'https://cdn.example.com/b/two.png');
  assert.equal(urls[2], 'https://cdn.example.com/c/three.gif');
  assert.equal(urls[3], 'https://cdn.example.com/e/five.webp');
  assert.equal(urls[4], 'https://cdn.example.com/f/six.jpg');
  // http:// 的那条（four.jpg）不该出现
  assert.ok(!urls.some((u) => u.includes('four.jpg')));
  assert.equal(urls.filter((u) => u.endsWith('one.jpg')).length, 1, '重复项必须去重');
  assert.deepEqual(parseBingImageUrls('没有 murl 的页面'), []);
});

test('真实类型嗅探：PNG / JPEG / GIF 认，HTML 报错页不认', () => {
  assert.equal(mimeFromBuffer(pngBytes()), 'image/png');
  assert.equal(mimeFromBuffer(jpegBytes()), 'image/jpeg');
  assert.equal(mimeFromBuffer(gifBytes()), 'image/gif');
  assert.equal(mimeFromBuffer(htmlBytes()), '');
  assert.equal(mimeFromBuffer(Buffer.from('not an image at all')), '');
});

test('配置门默认关闭；显式 true 才放行，maxPerDay 缺省 3', () => {
  assert.deepEqual(stickerWebConfig({}), { enabled: false, maxPerDay: 3 });
  assert.deepEqual(stickerWebConfig({ socialV2: { stickerWeb: { enabled: false, maxPerDay: 3 } } }), { enabled: false, maxPerDay: 3 });
  assert.deepEqual(stickerWebConfig({ socialV2: { stickerWeb: { enabled: true, maxPerDay: 2 } } }), { enabled: true, maxPerDay: 2 });
});

test('默认关闭时不联网：返回空数组且一次都没抓', async () => {
  resetDailyQuota();
  let calls = 0;
  const results = await searchWebImage('嘲讽队友手滑', {
    cfg: {},
    fetchHtml: async () => { calls += 1; return { body: fixtureHtml }; },
    fetchBinary: async () => { calls += 1; return { buffer: pngBytes() }; }
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0, '关闭状态下不能发起任何网络请求');
});

test('开启后：只收真图片，HTML 报错页与超限图跳过', async () => {
  resetDailyQuota();
  const cfg = { socialV2: { stickerWeb: { enabled: true, maxPerDay: 3 } } };
  const oversized = pngBytes(MAX_IMAGE_BYTES + 1);
  const bytesByUrl = new Map([
    ['https://cdn.example.com/a/one.jpg', jpegBytes()],
    ['https://cdn.example.com/b/two.png', htmlBytes()],          // 报错页 → 丢弃
    ['https://cdn.example.com/c/three.gif', gifBytes()],
    ['https://cdn.example.com/e/five.webp', pngBytes(700_000)],
    ['https://cdn.example.com/f/six.jpg', oversized]             // 超 1MB → 丢弃
  ]);
  const fetched = [];
  const results = await searchWebImage('被夸了不好意思', {
    cfg,
    fetchHtml: async () => ({ body: fixtureHtml }),
    fetchBinary: async (url) => {
      fetched.push(url);
      const buffer = bytesByUrl.get(url);
      if (!buffer) throw new Error('404');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('超过单张上限');
      return { buffer };
    }
  });

  assert.deepEqual(results.map((r) => r.mimeType), ['image/jpeg', 'image/gif', 'image/png']);
  assert.ok(results.every((r) => Buffer.isBuffer(r.buffer) && r.buffer.length <= MAX_IMAGE_BYTES));
  assert.equal(fetched.length, 5, '5 个候选都应尝试下载');
  assert.deepEqual(quotaSnapshot(), { ...quotaSnapshot(), used: 1 });
});

test('单日配额：maxPerDay 用完后不再联网', async () => {
  resetDailyQuota();
  const cfg = { socialV2: { stickerWeb: { enabled: true, maxPerDay: 2 } } };
  const deps = {
    cfg,
    fetchHtml: async () => ({ body: fixtureHtml }),
    fetchBinary: async () => ({ buffer: pngBytes() })
  };
  assert.ok((await searchWebImage('第一条', deps)).length > 0);
  assert.ok((await searchWebImage('第二条', deps)).length > 0);
  assert.deepEqual(await searchWebImage('第三条', deps), [], '第三次必须被配额挡掉');
  assert.equal(quotaSnapshot().used, 2);
});

test('搜索页抓取失败：静默返回空数组，不抛错给调用方', async () => {
  resetDailyQuota();
  const cfg = { socialV2: { stickerWeb: { enabled: true, maxPerDay: 3 } } };
  const results = await searchWebImage('随便', {
    cfg,
    fetchHtml: async () => { throw new Error('网络不通'); },
    fetchBinary: async () => ({ buffer: pngBytes() })
  });
  assert.deepEqual(results, []);
});
