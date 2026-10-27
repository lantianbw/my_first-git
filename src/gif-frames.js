// GIF 多帧 → 单张静态网格图（PNG）。
//
// 为什么需要：桥把入站图片以 base64 image part 交给多模态模型，而模型对 GIF 只解第一帧，
// 「动图」的信息（挥手、点头、连续动作）全丢了。这里把等间隔抽出的几帧拼成一张分镜图，
// 再配一句话说明阅读顺序，模型就能看到动作序列。
//
// 依赖只有 gifuct-js（解析）与 pngjs（编码），都是纯 JS；缩放是自己写的最近邻采样，
// 不引 sharp / jimp / canvas / imagemagick / ffmpeg。

import { parseGIF, decompressFrames } from 'gifuct-js';
import { PNG } from 'pngjs';

const GIF_HEADERS = ['GIF87a', 'GIF89a'];
const PAD = 4;            // 格间白边（px）
const MAX_COLS = 3;       // 3 列优先
const SHRINK_CELL = 160;  // 降温和的最后一档

/** 是不是 GIF：看 mime，或看前 6 字节的 GIF87a / GIF89a 头。 */
export function isGifBuffer(buffer, mimeType) {
  if (String(mimeType || '').trim().toLowerCase() === 'image/gif') return true;
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return false;
  return GIF_HEADERS.includes(buffer.toString('latin1', 0, 6));
}

/**
 * 从消息段里找「这是动图」的线索。
 *
 * 为什么需要：线上网关对动图往往返回**转码后的 PNG 首帧**，字节头不是 GIF89a，
 * isGifBuffer 不成立，整段拼图逻辑就被跳过了（线上 'gif → sheet' 日志 0 次即此因）。
 * 消息段自带的元信息（文件名后缀、summary 文案、subType、URL）是唯一还能拿到真相的地方。
 *
 * @returns 命中时返回不带空格的线索串（可直接进日志），否则 ''。
 */
export function gifHintOf(media) {
  if (!media || typeof media !== 'object') return '';
  const file = String(media.file ?? '').trim();
  if (/\.gif$/i.test(file)) return `file:${file.split('/').pop().slice(-16)}`;
  const summary = String(media.summary ?? '');
  if (summary.includes('动画')) return 'summary:动画';
  if (summary.includes('动图')) return 'summary:动图';
  // subType=1 只在 image 段（网关原样给的值）上算线索：mface（市场表情）段的 subType
  // 是本地写死成 '1' 的常量（extractMediaFromSegments），拿它当"动图证据"会让每一张
  // 静态市场表情都被标成动图，反而误导模型。
  if (media.kind !== 'sticker' && (media.subType === '1' || Number(media.subType) === 1)) return 'subType=1';
  const url = String(media.url ?? '');
  if (/\.gif/i.test(url)) return 'url:gif';
  return '';
}

/**
 * 由字节与线索决定怎么处理：真 GIF 才拼图；只是"看起来像动图"的（网关已转码成首帧 PNG）
 * 走兜底文案；两者都不成立就按静态图处理。
 * @returns {'sheet'|'first-frame-only'|'static'}
 */
export function gifMediaPlan(buffer, mimeType, hint) {
  if (isGifBuffer(buffer, mimeType)) return 'sheet';
  return hint ? 'first-frame-only' : 'static';
}

/**
 * 把 GIF 抽帧拼成一张 PNG。
 * @returns {{ png: Buffer, frames: number, width: number, height: number } | null}
 *   非 GIF、解码失败、0 帧、或降到最低档仍超 maxBytes 时为 null（调用方保留原 GIF）。
 */
export function decodeGifToSheet(buffer, { maxFrames = 6, cellMax = 240, maxBytes = 1_500_000 } = {}) {
  if (!isGifBuffer(buffer)) return null;
  let decoded = null;
  try {
    decoded = compositeGifFrames(buffer);
  } catch {
    return null;   // 损坏的 GIF 不该把整条消息带崩
  }
  if (!decoded || !decoded.frames.length) return null;

  const total = decoded.frames.length;
  const cap = Math.max(1, Math.min(Math.floor(Number(maxFrames)) || 6, total));
  const cell = Math.max(16, Math.floor(Number(cellMax)) || 240);
  // 降级链：先降帧 6→4→2，再降单格尺寸。每次都重新抽样，保证仍然首尾覆盖。
  const plan = [
    { frames: cap, cellMax: cell },
    { frames: Math.min(4, cap), cellMax: cell },
    { frames: Math.min(2, cap), cellMax: cell },
    { frames: Math.min(2, cap), cellMax: Math.min(SHRINK_CELL, cell) }
  ];
  const seen = new Set();
  for (const attempt of plan) {
    const key = `${attempt.frames}@${attempt.cellMax}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const picked = pickEvenly(decoded.frames, attempt.frames);
    const sheet = renderSheet(picked, decoded.width, decoded.height, attempt.cellMax);
    if (!sheet) continue;
    const png = encodePng(sheet);
    if (png.length <= maxBytes) {
      return { png, frames: picked.length, width: sheet.width, height: sheet.height };
    }
  }
  return null;
}

/** 等间隔抽帧：首帧必取、末帧必取（n>=2 时），中间均匀分布；索引重复时去重。 */
function pickEvenly(frames, count) {
  const total = frames.length;
  const want = Math.max(1, Math.min(count, total));
  if (want >= total) return frames.slice();
  if (want === 1) return [frames[0]];
  const out = [];
  let last = -1;
  for (let i = 0; i < want; i += 1) {
    const idx = Math.round((i * (total - 1)) / (want - 1));
    if (idx === last) continue;
    last = idx;
    out.push(frames[idx]);
  }
  return out;
}

/** 逐帧合成到逻辑画布上，产出每帧的整幅 RGBA 快照（含 disposal 处理）。 */
function compositeGifFrames(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const gif = parseGIF(arrayBuffer);
  const raw = decompressFrames(gif, true);
  const width = Number(gif?.lsd?.width) || 0;
  const height = Number(gif?.lsd?.height) || 0;
  if (!width || !height || !Array.isArray(raw)) return null;

  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  let prevDims = null;
  let prevDisposal = 0;
  let restoreSnapshot = null;
  for (const frame of raw) {
    if (!frame || !frame.dims) continue;
    // 先处理「上一帧」留下的 disposal，再画「本帧」。
    if (prevDims) {
      if (prevDisposal === 2) clearRect(canvas, width, height, prevDims);
      else if (prevDisposal === 3 && restoreSnapshot) canvas.set(restoreSnapshot);
    }
    const disposal = Number(frame.disposalType) || 0;
    restoreSnapshot = disposal === 3 ? canvas.slice() : null;
    drawPatch(canvas, width, height, frame.dims, frame.patch);
    frames.push(canvas.slice());
    prevDims = frame.dims;
    prevDisposal = disposal;
  }
  return frames.length ? { width, height, frames } : null;
}

function clearRect(canvas, width, height, dims) {
  const left = Math.max(0, dims.left | 0);
  const top = Math.max(0, dims.top | 0);
  const right = Math.min(width, left + (dims.width | 0));
  const bottom = Math.min(height, top + (dims.height | 0));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * width + x) * 4;
      canvas[i] = 0; canvas[i + 1] = 0; canvas[i + 2] = 0; canvas[i + 3] = 0;
    }
  }
}

function drawPatch(canvas, width, height, dims, patch) {
  if (!patch || !patch.length) return;
  const left = Math.max(0, dims.left | 0);
  const top = Math.max(0, dims.top | 0);
  const pw = dims.width | 0;
  const ph = dims.height | 0;
  for (let y = 0; y < ph; y += 1) {
    const ty = top + y;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < pw; x += 1) {
      const tx = left + x;
      if (tx < 0 || tx >= width) continue;
      const si = (y * pw + x) * 4;
      const di = (ty * width + tx) * 4;
      canvas[di] = patch[si];
      canvas[di + 1] = patch[si + 1];
      canvas[di + 2] = patch[si + 2];
      canvas[di + 3] = patch[si + 3];
    }
  }
}

/** 最近邻缩放到 cellMax 以内 —— 自己算，不引图像库；缩到整数尺寸保证结果可复现。 */
function scaleNearest(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/** 网格排版：≤3 帧一行，≤6 帧两行三列；格间与四周各 4px 白边。 */
function renderSheet(frames, srcW, srcH, cellMax) {
  const scale = Math.min(1, cellMax / Math.max(srcW, srcH));
  const cellW = Math.max(1, Math.round(srcW * scale));
  const cellH = Math.max(1, Math.round(srcH * scale));
  const count = frames.length;
  const cols = count <= 3 ? Math.max(1, count) : MAX_COLS;
  const rows = Math.ceil(count / cols);
  const width = cols * cellW + (cols + 1) * PAD;
  const height = rows * cellH + (rows + 1) * PAD;
  // 白底：alpha 也填 255，透明帧叠上去不会在 PNG 里透出黑色。
  const out = Buffer.alloc(width * height * 4, 0xff);
  frames.forEach((frame, i) => {
    const scaled = scaleNearest(frame, srcW, srcH, cellW, cellH);
    const x0 = PAD + (i % cols) * (cellW + PAD);
    const y0 = PAD + Math.floor(i / cols) * (cellH + PAD);
    for (let y = 0; y < cellH; y += 1) {
      for (let x = 0; x < cellW; x += 1) {
        const si = (y * cellW + x) * 4;
        const alpha = scaled[si + 3] / 255;
        const di = ((y0 + y) * width + (x0 + x)) * 4;
        for (let c = 0; c < 3; c += 1) {
          out[di + c] = Math.round(scaled[si + c] * alpha + 255 * (1 - alpha));
        }
      }
    }
  });
  return { width, height, data: out };
}

function encodePng({ width, height, data }) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data);
  return PNG.sync.write(png);
}
