// 网上找表情图（二期，默认关闭）。
//
// 只在 config.json 的 socialV2.stickerWeb.enabled === true 时才允许联网；默认 false。
// 安全口径：
//   · 联网抓取一律走 src/safe-fetch.js（SSRF 防护 + 大小上限 + 图片嗅探），不自己拼 http 请求。
//   · 只接受真·PNG / JPEG / GIF（按字节签名判断，不看 Content-Type，避免拿到报错页）。
//   · 单张 ≤1MB、单次总量 ≤3MB；单日调用次数受 config 的 maxPerDay 限制。
//   · 本模块只"取候选"，不写收藏表情库、不发消息、也不把 URL 交给 QQ。

import { safeFetch, safeFetchBuffer } from './safe-fetch.js';

export const BING_IMAGE_SEARCH = 'https://www.bing.com/images/search';
export const MAX_CANDIDATES = 5;
export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 3_000_000;
const MAX_HTML_CHARS = 800_000;

/** 按字节签名判断真实图片类型（不用 Content-Type，防止 HTML 报错页混进来）。 */
export function mimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const head = buffer.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  return '';
}

/** 从 Bing 图片搜索结果 HTML 里抠出 murl（原始图片地址），去重后取前 limit 条。 */
export function parseBingImageUrls(html, limit = MAX_CANDIDATES) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  // Bing 把 JSON 里的引号转义成 &quot;，形如 murl&quot;:&quot;https://...&quot;
  const re = /murl&quot;:&quot;(https:\/\/[^&]+?)&quot;/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** 读配置门：只有 enabled === true 才放行；maxPerDay 默认 3。 */
export function stickerWebConfig(cfg) {
  const raw = cfg?.socialV2?.stickerWeb ?? {};
  return {
    enabled: raw.enabled === true,
    maxPerDay: Math.max(0, Math.floor(Number(raw.maxPerDay) || 0)) || 3
  };
}

// 单日配额（按北京时间切日）。仅进程内计数：重启清零，够用且不引入写盘。
const quota = { day: '', used: 0 };

function beijingDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

export function resetDailyQuota() {
  quota.day = '';
  quota.used = 0;
}

export function quotaSnapshot(now = Date.now()) {
  const day = beijingDay(now);
  const used = quota.day === day ? quota.used : 0;
  return { day, used };
}

/**
 * 搜网上表情图。
 * @returns {Promise<Array<{url: string, mimeType: string, buffer: Buffer}>>}
 *   任何失败（未开启、超配额、抓不到、全是报错页）都返回空数组 —— 调用方静默降级成发文字。
 */
export async function searchWebImage(query, { cfg, now = Date.now(), fetchHtml = safeFetch, fetchBinary = safeFetchBuffer, onLog = () => {} } = {}) {
  const gate = stickerWebConfig(cfg);
  if (!gate.enabled) {
    onLog('[web-sticker] 未开启（socialV2.stickerWeb.enabled=false），跳过联网找图');
    return [];
  }
  const text = String(query ?? '').trim();
  if (!text) return [];

  const day = beijingDay(now);
  if (quota.day !== day) {
    quota.day = day;
    quota.used = 0;
  }
  if (quota.used >= gate.maxPerDay) {
    onLog(`[web-sticker] 今日配额已用完（${quota.used}/${gate.maxPerDay}）`);
    return [];
  }
  quota.used += 1;
  onLog(`[web-sticker] query="${text.replace(/"/g, "'")}" day=${day} quota=${quota.used}/${gate.maxPerDay}`);

  let html = '';
  try {
    const page = await fetchHtml(`${BING_IMAGE_SEARCH}?q=${encodeURIComponent(text)}`, MAX_HTML_CHARS);
    html = page?.body ?? '';
  } catch (error) {
    onLog(`[web-sticker] 搜索页抓取失败：${error?.message ?? error}`);
    return [];
  }
  const urls = parseBingImageUrls(html, MAX_CANDIDATES);
  if (!urls.length) return [];

  const results = [];
  let total = 0;
  for (const url of urls) {
    if (total >= MAX_TOTAL_BYTES) break;
    let buffer = null;
    try {
      const fetched = await fetchBinary(url, MAX_IMAGE_BYTES);
      buffer = fetched?.buffer ?? null;
    } catch (error) {
      onLog(`[web-sticker] 下载失败 ${url.slice(0, 80)}：${error?.message ?? error}`);
      continue;
    }
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_BYTES) continue;
    const mimeType = mimeFromBuffer(buffer);
    if (!mimeType) continue;                     // HTML 报错页 / webp 等一律丢弃
    if (total + buffer.length > MAX_TOTAL_BYTES) break;
    total += buffer.length;
    results.push({ url, mimeType, buffer });
  }
  return results;
}
