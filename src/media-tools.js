// 只读媒体工具的返回整形（OCR / 语音转文字）。
//
// 为什么单独抽出来：SnowLuma 的 action 返回形状不稳定（string / {text} / {texts[]} /
// {data:{...}} 都见过），而这些分支又必须「如实说没有」——空结果不能编，
// HTTP 404 也要给出可操作的提示。抽成纯函数后可以离线回归。

/** 从任意常见形状里抠出文本（深度有限，去重，按出现顺序拼接）。 */
export function extractTextPayload(data, { maxDepth = 4 } = {}) {
  const found = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (depth > maxDepth || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text && !seen.has(text)) { seen.add(text); found.push(text); }
      return;
    }
    if (typeof value === 'number') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['text', 'result', 'transcription', 'content', 'message', 'data', 'texts', 'items']) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(data, 0);
  return found.join('\n').trim();
}

/** OCR 结果：空结果如实说没有，不猜图。 */
export function formatOcrResult(data) {
  const text = extractTextPayload(data);
  if (text) return { text, empty: false };
  return { text: '没有识别到文字：图片里可能没有文字，或服务端未返回结果。', empty: true };
}

/** 语音转文字：腾讯侧偶发空结果，明确说听不清/转不出来。 */
export function formatVoiceTextResult(data) {
  const text = extractTextPayload(data);
  if (text) return { text, empty: false };
  return { text: '听不清/转不出来：腾讯侧本次返回空结果，换个时间或让对方重发试试。', empty: true };
}

/**
 * 把 OneBot 调用错误翻译成工具能直接回给模型的话。
 * @param {unknown} error
 * @param {'ocr'|'voice'} kind
 */
export function formatMediaToolError(error, kind) {
  const raw = String(error?.message ?? error ?? '');
  const is404 = /HTTP\s*404|\b404\b/.test(raw);
  if (kind === 'ocr') {
    if (is404) return `OCR 接口不可用（HTTP 404）：当前 SnowLuma 未提供 ocr_image，先升级/检查协议端。`;
    return `OCR 失败：${raw}`;
  }
  if (is404) return `语音转文字接口不可用（HTTP 404）：当前 SnowLuma 未提供 fetch_ptt_text。`;
  return `听不清/转不出来（转写失败）：${raw}`;
}
