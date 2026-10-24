// meme_add 谐音字段 + OCR / 语音转文字返回整形回归。
// 离线运行，不需要 DSH / SnowLuma / QQ。

import assert from 'node:assert/strict';
import { addMeme, formatMemeList, normalizeMemeEntry } from '../src/meme-lib.js';
import { extractTextPayload, formatOcrResult, formatVoiceTextResult, formatMediaToolError } from '../src/media-tools.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. 老调用（只传 text）保持兼容：pinyin 自动算，variants 为空
{
  const res = addMeme([], { text: '废物' });
  assert.equal(res.created, true);
  assert.equal(res.entry.pinyin, 'feiwu');
  assert.deepEqual(res.entry.variants, []);
  ok('qq_meme_add 老调用不带新参数仍可用');
}

// 2. 显式 pinyin 覆盖自动计算
{
  const res = addMeme([], { text: '飞舞', pinyin: 'FEI-WU' });
  assert.equal(res.entry.pinyin, 'feiwu');
  ok('pinyin 显式传入会归一化');
}

// 3. variants 去重 + 与 text 自身重复会被剔除
{
  const res = addMeme([], { text: '废物', variants: ['飞舞', '飞舞', '废物', ' ', '飞物'] });
  assert.deepEqual(res.entry.variants, ['飞舞', '飞物']);
  ok('variants 去重且排除自身');
}

// 4. 再次 add 合并 variants，不覆盖已有
{
  let list = addMeme([], { text: '废物', variants: ['飞舞'], meaning: '没用' }).entries;
  const again = addMeme(list, { text: '废物', variants: ['飞舞', '飞物'] });
  assert.deepEqual(again.entry.variants.sort(), ['飞舞', '飞物'].sort());
  assert.equal(again.entry.usedCount, 1);
  assert.equal(again.entry.meaning, '没用');
  ok('重复记梗合并 variants 且保留含义');
}

// 5. formatMemeList 返回 pinyin / variants
{
  const list = addMeme([], { text: '蚌埠住了', pinyin: '', variants: ['蹦不住了'] }).entries;
  const view = formatMemeList(list, { limit: 10 });
  assert.equal(view.entries[0].pinyin, 'bengbuzhule');
  assert.deepEqual(view.entries[0].variants, ['蹦不住了']);
  ok('qq_meme_list / query 返回 pinyin 与 variants');
}

// 6. 历史 memes.json 条目缺字段也能读（向后兼容）
{
  const old = normalizeMemeEntry({ text: '典', meaning: '典型' });
  assert.equal(old.pinyin, 'dian');
  assert.deepEqual(old.variants, []);
  ok('历史条目缺 pinyin / variants 时自动补齐');
}

// 7. OCR：常见返回形状都能抠出文字
{
  assert.equal(extractTextPayload('你好'), '你好');
  assert.equal(extractTextPayload({ text: '你好' }), '你好');
  assert.equal(extractTextPayload({ result: '你好' }), '你好');
  assert.equal(extractTextPayload({ data: { texts: ['你好', '世界'] } }), '你好\n世界');
  assert.equal(formatOcrResult({ text: '你好' }).empty, false);
  ok('OCR 支持 string / text / result / texts');
}

// 8. OCR 空结果：如实说没有
{
  const empty = formatOcrResult({ text: '   ' });
  assert.equal(empty.empty, true);
  assert.match(empty.text, /没有识别到文字/);
  ok('OCR 空结果不编造');
}

// 9. PTT：正常与空结果
{
  assert.equal(formatVoiceTextResult({ text: '在吗' }).text, '在吗');
  const empty = formatVoiceTextResult({});
  assert.equal(empty.empty, true);
  assert.match(empty.text, /听不清\/转不出来/);
  ok('语音转文字空结果明确说听不清');
}

// 10. 404 与通用错误
{
  const ocr404 = formatMediaToolError(new Error('HTTP 404'), 'ocr');
  assert.match(ocr404, /OCR 接口不可用/);
  const voice404 = formatMediaToolError(new Error('HTTP 404'), 'voice');
  assert.match(voice404, /语音转文字接口不可用/);
  const voiceErr = formatMediaToolError(new Error('timeout'), 'voice');
  assert.match(voiceErr, /听不清\/转不出来/);
  assert.match(voiceErr, /timeout/);
  ok('OCR/PTT 的 404 与非 404 错误都有明确提示');
}

console.log(`\n总计: ${passed} 项通过`);
