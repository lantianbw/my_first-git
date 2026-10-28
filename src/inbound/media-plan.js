// inbound/media-plan — 纯决策：这条入站媒体该怎么处理
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 inbound/media「fail open」/ H2 inbound/gif=free）
// deps：无                       （optional：无）
// 失败策略：fail-open            （依据：D 表 inbound/media「媒体理解失败退化为提示，不影响文字」）
// 单测：tests/media-plan.test.mjs
//
// 为什么需要：入站媒体现在是在 resolveMediaList 里边取字节、边判 GIF、边判预算、边发 part，
// 四个判断缠在一段 async 代码里，想单测「一张 9MB 的动图会被怎么处理」就得起 OneBot 客户端。
// 这里把「该怎么处理」抽成不碰 IO 的纯函数：给同样的元信息，永远得到同样的计划。
//
// 边界：不取字节、不解码 GIF、不算拼图大小、不碰模块开关的读取（gifEnabled/ocrEnabled 由调用方
// 从 ctx 取好再传进来）、不发 part、不写日志。只回答 action + reason + 估算字节。
//
// 判定顺序（与 resolveMediaList / gifMediaPlan 一致）：
//   1. 语音（ptt/voice/record/audio）→ skip，上层用 pttTextFor 转文字
//   2. 非图片 kind（video/file/未知）→ skip
//   3. 原始字节 > maxBytes → skip（现有代码是 `>`，等于上限仍然放行）
//   4. mime 是 image/gif：gifEnabled → sheet（抽帧拼图）；关掉 → image（模型只看首帧）
//   5. 字节不是 GIF 但有动图线索（网关转码成首帧 PNG）：gifEnabled → gif-first-frame；关掉 → image
//   6. 其余 → image（ocrEnabled 时 reason 标 image-ocr，仅用于说明上层会补 ocrText）
//
// 已知偏差：现有代码的预算检查发生在拼图**之后**，按拼图字节算；纯决策拿不到拼图结果，
// 只能按原始字节保守判断，所以 estimatedBytes 给的是上界（sheet 通常比原 GIF 小）。
// 调用方拿到 action='sheet' 后仍应在 decodeGifToSheet 之后用真实字节复核一次预算。

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 与 bridge.js MAX_MEDIA_BYTES 默认值一致

/** 会作为 image part 进入上下文的 kind（face 在 OneBot 里也是图片实体）。 */
const IMAGE_KINDS = new Set(['image', 'sticker', 'face', 'mface', 'market-face', 'friend-face']);

/** 语音：不在本条处理，交给上层 ASR 转文字。 */
const VOICE_KINDS = new Set(['ptt', 'voice', 'record', 'audio']);

export const spec = Object.freeze({
  name: 'inbound/media-plan',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

const plan = (action, reason, estimatedBytes) => ({ action, reason, estimatedBytes });

/**
 * 决定单条媒体怎么处理。
 *
 * @param {object} input
 * @param {string}  input.kind        OneBot 段类型：image / sticker / face / ptt / …
 * @param {string}  [input.mimeType]  字节嗅探或网关给的 MIME，'image/gif' 视为真 GIF
 * @param {number}  [input.bytes]     原始字节数（缺省按 0 处理）
 * @param {string}  [input.gifHint]   动图线索（gifHintOf 的返回值），非空即有线索
 * @param {boolean} [input.ocrEnabled] 上层是否会对图片补 OCR 文本
 * @param {boolean} [input.gifEnabled] inbound/gif 模块开关，缺省视为开（H1 default:true）
 * @param {number}  [input.maxBytes]  单条字节上限，缺省 8MB
 * @returns {{ action: 'sheet'|'image'|'skip'|'gif-first-frame', reason: string, estimatedBytes: number }}
 */
export function planOf({ kind, mimeType, bytes, gifHint, ocrEnabled, gifEnabled, maxBytes } = {}) {
  const kindKey = String(kind ?? '').trim().toLowerCase();
  const mime = String(mimeType ?? '').trim().toLowerCase();
  const hint = String(gifHint ?? '').trim();
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const gifOn = gifEnabled === undefined ? true : Boolean(gifEnabled);
  const ocrOn = ocrEnabled === true;

  // 1. 语音走 skip：转文字由上层负责，这里不进 image part
  if (VOICE_KINDS.has(kindKey)) return plan('skip', 'voice-to-text', 0);

  // 2. 非图片类型：不认识就不猜，宁可不发
  if (!IMAGE_KINDS.has(kindKey)) return plan('skip', 'unsupported-kind', 0);

  // 3. 超限：与现有代码一致用 `>`，恰好等于上限仍然放行
  if (size > limit) return plan('skip', 'over-limit', 0);

  // 4. 真 GIF：只有开关打开才抽帧拼图
  if (mime === 'image/gif') {
    return gifOn ? plan('sheet', 'gif-sheet', size) : plan('image', 'gif-disabled', size);
  }

  // 5. 线索说是动图、字节却是首帧 PNG（网关转码）：开关打开时才值得给模型加说明
  if (hint) {
    return gifOn ? plan('gif-first-frame', 'gif-hint-transcoded', size) : plan('image', 'gif-disabled', size);
  }

  // 6. 普通静态图
  return plan('image', ocrOn ? 'image-ocr' : 'image', size);
}
