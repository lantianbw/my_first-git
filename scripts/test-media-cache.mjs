// 入站媒体理解（OCR / 语音转写）与转发 OCR 的回归。
//
// 钉住的边界：
//   1. 缓存：同引用命中不再请求；TTL 过期清空；上限淘汰最旧；
//   2. OCR：空结果/过短不注入，避免白占提示词 token；超长截断；
//   3. 语音：autoPtt=mention 只在私聊/被@/被引用时转写；失败降级且保留 messageId；
//   4. 转发：总预算 forwardImageMax 生效，ocrText 写回 media；
//   5. 入库：mediaText 进 recentMessages，并能出现在唤醒快照里。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  normalizeMediaConfig,
  imageCacheKey,
  pttCacheKey,
  getCachedMedia,
  putCachedMedia,
  buildMediaTextLine
} from '../src/media-cache.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 记录型 fetch：OCR 返回固定文字；可模拟转写失败。 */
function makeFetch({ ocrText = '', pttFail = false } = {}) {
  const log = [];
  let ocrCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const action = String(url).split('/').pop();
    let body = {};
    try { body = JSON.parse(init.body ?? '{}'); } catch {}
    log.push({ action, body });
    if (action === 'ocr_image') {
      ocrCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', retcode: 0, data: ocrText ? { text: ocrText } : {} })
      };
    }
    if (action === 'fetch_ptt_text') {
      if (pttFail) return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, wording: '转写失败' }) };
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: '今天好累' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  };
  return { fetchImpl, log, ocrCalls: () => ocrCalls };
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────
await test('配置归一：autoPtt 三态、上限与阈值', () => {
  assert.equal(normalizeMediaConfig({}).autoPtt, 'mention');
  assert.equal(normalizeMediaConfig({ autoPtt: true }).autoPtt, true);
  assert.equal(normalizeMediaConfig({ autoPtt: false }).autoPtt, false);
  assert.equal(normalizeMediaConfig({ autoPtt: 'weird' }).autoPtt, 'mention');
  assert.equal(normalizeMediaConfig({ forwardImageMax: 999 }).forwardImageMax, 20);
  assert.equal(normalizeMediaConfig({ maxImagesPerWake: 0 }).maxImagesPerWake, 0);
  assert.equal(normalizeMediaConfig({ ocrMinChars: 0 }).ocrMinChars, 1);
  assert.equal(normalizeMediaConfig({ autoOcr: false }).autoOcr, false);
});

await test('缓存键：图片按 url/file，语音按 messageId', () => {
  assert.equal(imageCacheKey({ url: 'https://cdn/a.png' }), imageCacheKey({ file: 'x', url: 'https://cdn/a.png' }));
  assert.notEqual(imageCacheKey({ url: 'https://cdn/a.png' }), imageCacheKey({ url: 'https://cdn/b.png' }));
  assert.equal(imageCacheKey({ url: 'https://cdn/a.png' }), imageCacheKey({ url: 'https://cdn/a.png' }));
  assert.equal(imageCacheKey({ file: '' }), '');
  assert.match(imageCacheKey({ url: 'u' }), /^image:[a-f0-9]{32}$/);
  assert.equal(pttCacheKey('123'), 'ptt:123');
  assert.equal(pttCacheKey(''), '');
});

await test('缓存过期：TTL 外命中失败并清条目', () => {
  const key = imageCacheKey({ url: 'https://cdn/a.png' });
  const cache = putCachedMedia({ entries: {} }, key, { kind: 'image', ref: 'u', text: 'x', ok: true }, { now: 1000 });
  assert.equal(getCachedMedia(cache, key, { ttlMs: 100, now: 1050 }).hit, true);
  const expired = getCachedMedia(cache, key, { ttlMs: 100, now: 1200 });
  assert.equal(expired.hit, false);
  assert.equal(expired.cache.entries[key], undefined);
});

await test('缓存上限：超出 500 条淘汰最旧', () => {
  let cache = { entries: {} };
  for (let i = 0; i < 60; i += 1) {
    cache = putCachedMedia(cache, `image:${'a'.repeat(20)}${i}`, { kind: 'image', text: 't', ok: true }, { maxEntries: 50, now: 1000 + i });
  }
  assert.equal(Object.keys(cache.entries).length, 50);
  assert.equal(cache.entries[`image:${'a'.repeat(20)}0`], undefined);
  assert.ok(cache.entries[`image:${'a'.repeat(20)}59`]);
});

await test('文案整形：图片空结果不注入、语音失败保留 messageId', () => {
  assert.equal(buildMediaTextLine({ kind: 'image', text: '群友在打游戏', ok: true }), '[图片] 文字：群友在打游戏');
  assert.equal(buildMediaTextLine({ kind: 'image', text: '', ok: false }), '');
  assert.equal(buildMediaTextLine({ kind: 'image', text: '好', ok: true }), '[图片] 文字：好');
  assert.equal(buildMediaTextLine({ kind: 'image', text: '1234567890', ok: true, maxChars: 4 }), '[图片] 文字：1234…');
  assert.equal(buildMediaTextLine({ kind: 'record', text: '今天好累', ok: true, duration: 3 }), '[语音 3″] 转写：今天好累');
  assert.equal(buildMediaTextLine({ kind: 'record', text: '', ok: false, messageId: '123' }), '[语音]（转写不可用，messageId=123）');
});

// ── 集成 ─────────────────────────────────────────────────────────────────────
await test('入站图片：OCR 有字才注入', async () => {
  const f = makeFetch({ ocrText: '群友在打游戏' });
  const h = await bridgeHarness({ globals: { fetch: f.fetchImpl } });
  try {
    h.setMode('reserved2');
    const lines = await h.enrichIncomingMediaV2({
      segments: [{ type: 'image', data: { url: 'https://cdn/a.png' } }],
      mediaList: [{ kind: 'image', url: 'https://cdn/a.png' }],
      messageId: '1001',
      kind: 'group',
      textContent: '看这个',
      quoteTargetIsSelf: false
    });
    assert.deepEqual([...lines], ['[图片] 文字：群友在打游戏']);
  } finally { await h.close(); }
});

await test('入站图片：空结果与过短文字都不注入', async () => {
  const empty = makeFetch({ ocrText: '' });
  const h1 = await bridgeHarness({ globals: { fetch: empty.fetchImpl } });
  try {
    h1.setMode('reserved2');
    const lines = await h1.enrichIncomingMediaV2({
      segments: [{ type: 'image', data: { url: 'https://cdn/a.png' } }],
      mediaList: [{ kind: 'image', url: 'https://cdn/a.png' }],
      messageId: '1002',
      kind: 'group',
      textContent: '',
      quoteTargetIsSelf: false
    });
    assert.equal(lines.length, 0, '空 OCR 结果不得注入');
  } finally { await h1.close(); }

  const short = makeFetch({ ocrText: '好' });
  const h2 = await bridgeHarness({ globals: { fetch: short.fetchImpl } });
  try {
    h2.setMode('reserved2');
    const lines = await h2.enrichIncomingMediaV2({
      segments: [],
      mediaList: [{ kind: 'image', url: 'https://cdn/b.png' }],
      messageId: '1003',
      kind: 'group',
      textContent: '',
      quoteTargetIsSelf: false
    });
    assert.equal(lines.length, 0, 'OCR 文字少于 ocrMinChars(4) 必须丢弃');
  } finally { await h2.close(); }
});

await test('语音：私聊自动转写，失败降级并保留 messageId', async () => {
  const ok = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: ok.fetchImpl } });
  try {
    h.setMode('reserved2');
    const lines = await h.enrichIncomingMediaV2({
      segments: [{ type: 'record', data: { duration: 3 } }],
      mediaList: [],
      messageId: '2001',
      kind: 'private',
      textContent: '',
      quoteTargetIsSelf: false
    });
    assert.deepEqual([...lines], ['[语音 3″] 转写：今天好累']);
  } finally { await h.close(); }

  const fail = makeFetch({ pttFail: true });
  const h2 = await bridgeHarness({ globals: { fetch: fail.fetchImpl } });
  try {
    h2.setMode('reserved2');
    const lines = await h2.enrichIncomingMediaV2({
      segments: [{ type: 'record', data: { duration: 0 } }],
      mediaList: [],
      messageId: '2002',
      kind: 'private',
      textContent: '',
      quoteTargetIsSelf: false
    });
    assert.deepEqual([...lines], ['[语音]（转写不可用，messageId=2002）']);
  } finally { await h2.close(); }
});

await test('语音：群聊 mention 模式只在被@/被引用时转写', async () => {
  const f = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: f.fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('小鲸鱼', '999');
    const base = { segments: [{ type: 'record', data: { duration: 2 } }], mediaList: [], kind: 'group' };
    assert.equal((await h.enrichIncomingMediaV2({ ...base, messageId: '2003', textContent: '随便聊聊', quoteTargetIsSelf: false })).length, 0);
    assert.equal((await h.enrichIncomingMediaV2({ ...base, messageId: '2004', textContent: '随便聊聊', quoteTargetIsSelf: true })).length, 1);
    assert.equal((await h.enrichIncomingMediaV2({ ...base, messageId: '2005', textContent: '@小鲸鱼 听一下', quoteTargetIsSelf: false })).length, 1);
    const pttCalls = f.log.filter((entry) => entry.action === 'fetch_ptt_text').length;
    assert.equal(pttCalls, 2, '未被@/引用时不得请求转写');
  } finally { await h.close(); }
});

await test('缓存命中：同一图片第二次不再请求 OCR', async () => {
  const f = makeFetch({ ocrText: '群友在打游戏' });
  const h = await bridgeHarness({ globals: { fetch: f.fetchImpl } });
  try {
    h.setMode('reserved2');
    const args = {
      segments: [],
      mediaList: [{ kind: 'image', url: 'https://cdn/same.png' }],
      messageId: '3001',
      kind: 'group',
      textContent: '',
      quoteTargetIsSelf: false
    };
    await h.enrichIncomingMediaV2(args);
    await h.enrichIncomingMediaV2({ ...args, messageId: '3002' });
    assert.equal(f.ocrCalls(), 1, '同 url 第二次必须命中缓存');
  } finally { await h.close(); }
});

await test('转发 OCR：预算截断且写回 media.ocrText', async () => {
  const f = makeFetch({ ocrText: '转发里的字' });
  const h = await bridgeHarness({ globals: { fetch: f.fetchImpl } });
  try {
    h.setMode('reserved2');
    const media = [1, 2, 3, 4].map((n) => ({ kind: 'image', url: `https://cdn/f${n}.png` }));
    await h.decorateForwardMediaOcr([{ media }], 2);
    assert.equal(media[0].ocrText, '转发里的字');
    assert.equal(media[1].ocrText, '转发里的字');
    assert.equal(media[2].ocrText, undefined, '超过预算的图片不做 OCR');
    assert.equal(f.ocrCalls(), 2);
  } finally { await h.close(); }
});

await test('入库：mediaText 出现在 recentMessages 与唤醒快照', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(
      'group:456', '张三', '[图片]', '[图片]', false, false, '4001',
      [{ kind: 'image', url: 'https://cdn/a.png' }], '9001', [], ['[图片] 文字：群友在打游戏']
    );
    const st = h.getSocialV2State('group:456');
    assert.deepEqual(st.recentMessages.at(-1).mediaText, ['[图片] 文字：群友在打游戏']);
    const snapshot = JSON.stringify(h.buildWakeSnapshotV2('group:456'));
    assert.ok(snapshot.includes('群友在打游戏'), '快照必须带 OCR 文字');
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
