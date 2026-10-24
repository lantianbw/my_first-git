// 入站媒体理解（OCR / 语音转写）的配置归一、缓存与文案整形。
//
// 设计约束：
// - 缓存落 state/media-cache.json：图片按 file/url 的 hash、语音按 messageId；
//   有 TTL（默认 7 天）与条数上限（500），避免无限增长；
// - 失败结果也要缓存（ok:false，短 TTL 也按同一 TTL），防止对同一张失败图片反复重试；
// - 文案只在这里生成：模型看到的是「[图片] 文字：…」「[语音 3″] 转写：…」这种可直接读的行，
//   而不是需要再解析的 JSON；
// - 空/过短的 OCR 由调用方丢弃，本模块只负责按阈值判断。

import crypto from 'node:crypto';

export const MEDIA_CACHE_DEFAULTS = Object.freeze({
  autoOcr: true,
  ocrMinChars: 4,
  ocrMaxChars: 200,
  autoPtt: 'mention',
  cacheTtlMs: 604800000,
  maxImagesPerWake: 4,
  forwardImageMax: 8,
  maxEntries: 500
});

const int = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** socialV2.media 归一化；autoPtt 允许 true / false / "mention"。 */
export function normalizeMediaConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ptt = src.autoPtt;
  const autoPtt = ptt === true ? true : ptt === false ? false : 'mention';
  return {
    autoOcr: src.autoOcr !== false,
    ocrMinChars: int(src.ocrMinChars, MEDIA_CACHE_DEFAULTS.ocrMinChars, 1, 1000),
    ocrMaxChars: int(src.ocrMaxChars, MEDIA_CACHE_DEFAULTS.ocrMaxChars, 1, 2000),
    autoPtt,
    cacheTtlMs: int(src.cacheTtlMs, MEDIA_CACHE_DEFAULTS.cacheTtlMs, 0, 30 * 86_400_000),
    maxImagesPerWake: int(src.maxImagesPerWake, MEDIA_CACHE_DEFAULTS.maxImagesPerWake, 0, 20),
    forwardImageMax: int(src.forwardImageMax, MEDIA_CACHE_DEFAULTS.forwardImageMax, 1, 20),
    maxEntries: int(src.maxEntries, MEDIA_CACHE_DEFAULTS.maxEntries, 10, 5000)
  };
}

/** 图片引用 hash：优先 url（更稳定），其次 file。 */
export function imageRefOf(media) {
  if (!media || typeof media !== 'object') return '';
  return String(media.url || media.file || media.emojiId || '').trim();
}

export function imageCacheKey(media) {
  const ref = imageRefOf(media);
  if (!ref) return '';
  return `image:${crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32)}`;
}

export function pttCacheKey(messageId) {
  const id = String(messageId ?? '').trim();
  if (!id) return '';
  return `ptt:${id}`;
}

/** state/media-cache.json 的形状归一。坏条目丢弃，不让整库作废。 */
export function normalizeMediaCache(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = {};
  const source = src.entries && typeof src.entries === 'object' && !Array.isArray(src.entries) ? src.entries : {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^(image|ptt):[A-Za-z0-9]+$/.test(key) || !value || typeof value !== 'object') continue;
    entries[key] = {
      kind: value.kind === 'record' ? 'record' : 'image',
      ref: String(value.ref ?? '').slice(0, 512),
      text: String(value.text ?? '').slice(0, 2000),
      ok: value.ok !== false,
      at: int(value.at, 0, 0, Number.MAX_SAFE_INTEGER),
      duration: int(value.duration, 0, 0, 3600)
    };
  }
  return { entries };
}

/** 读缓存：命中且未过期返回 entry（过期条目一并清掉）。 */
export function getCachedMedia(cache, key, { ttlMs = MEDIA_CACHE_DEFAULTS.cacheTtlMs, now = Date.now() } = {}) {
  const safe = normalizeMediaCache(cache);
  if (!key || !safe.entries[key]) return { hit: false, entry: null, cache: safe };
  const entry = safe.entries[key];
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (ttl > 0 && now - entry.at >= ttl) {
    delete safe.entries[key];
    return { hit: false, entry: null, cache: safe };
  }
  return { hit: true, entry, cache: safe };
}

/** 写缓存：按 at 淘汰最旧的，保持 maxEntries 上限。 */
export function putCachedMedia(cache, key, value, { maxEntries = MEDIA_CACHE_DEFAULTS.maxEntries, now = Date.now() } = {}) {
  const safe = normalizeMediaCache(cache);
  if (!key || !/^(image|ptt):[A-Za-z0-9]+$/.test(key)) return safe;
  safe.entries[key] = {
    kind: value?.kind === 'record' ? 'record' : 'image',
    ref: String(value?.ref ?? '').slice(0, 512),
    text: String(value?.text ?? '').slice(0, 2000),
    ok: value?.ok !== false,
    at: now,
    duration: int(value?.duration, 0, 0, 3600)
  };
  const limit = Math.max(10, Number(maxEntries) || MEDIA_CACHE_DEFAULTS.maxEntries);
  const keys = Object.keys(safe.entries);
  if (keys.length > limit) {
    keys.sort((a, b) => safe.entries[a].at - safe.entries[b].at);
    for (const old of keys.slice(0, keys.length - limit)) delete safe.entries[old];
  }
  return safe;
}

/** 语音时长文案：3″ / 65″（秒）。 */
function durationLabel(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return n > 0 ? ` ${n}″` : '';
}

/**
 * 生成模型可直接读的媒体行。
 * @param {{kind:'image'|'record', text?:string, ok?:boolean, duration?:number, messageId?:string, maxChars?:number}} input
 * @returns {string} 空串表示「不注入」（例如 OCR 结果为空/过短）
 */
export function buildMediaTextLine(input = {}) {
  const kind = input.kind === 'record' ? 'record' : 'image';
  const ok = input.ok !== false;
  const text = String(input.text ?? '').replace(/\s+/g, ' ').trim();
  if (kind === 'record') {
    if (!ok || !text) {
      const id = String(input.messageId ?? '').trim();
      return id ? `[语音]（转写不可用，messageId=${id}）` : '[语音]（转写不可用）';
    }
    const max = Math.max(20, Number(input.maxChars) || 2000);
    const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
    return `[语音${durationLabel(input.duration)}] 转写：${clipped}`;
  }
  if (!ok || !text) return '';
  const max = Math.max(1, Number(input.maxChars) || 200);
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return `[图片] 文字：${clipped}`;
}
