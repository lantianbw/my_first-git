// outbound/split — 把一段超长文本切成若干条可发送的短消息
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `outbound/send` 邻近口径——切分只是排版，
//                              切不开最多退化成超长单段交给发送层拒绝，绝不吞掉字符；
//                              真正的发送失败由 outbound/send 的 fail-closed 兜底）
// 单测：tests/outbound-split.test.mjs
//
// 为什么需要：bridge.js:9289 的 splitLongSegment 把「按标点攒段 → 超长 token 硬切 →
// 代理对保护 → URL 占位符还原」塞在发送链路里，还依赖发送侧的 500 字上限，
// 想单独验证「会不会吞字」只能起桥发真消息。这里把它抽成纯函数：进文本出数组，
// 既能断言字符完整性，也能被别的通道（控制台、语音字幕）复用。
//
// 边界：只切字符串。不发送、不排队、不读配置、不读时钟、不改入参、不 import bridge.js。
// 段落内容永远来自入参：拼接所有段落（去空白）必须与原文（去空白）逐字相等，
// 这条不变式由单测的「字符完整性」用例守着。
//
// 与 bridge 原实现的三处差异（都是有意的）：
//   1. 断句符默认取句末标点 `。！？；`；原实现按逗号类 `，、；：,;:` 攒段。
//      逗号处断句会把一句话拆成两半，句末标点更接近「一条消息说一件事」。
//   2. 加了 maxParts 上限：原实现不设限，一段长文可能变成十几条消息刷屏；
//      这里超过上限就把尾巴合并成最后一条，并标 truncated（内容是合并，不是丢弃）。
//   3. 不做 URL 占位符那一套：URL 保护依赖发送链路里的遮罩协议，属于 outbound/send；
//      纯切分这一层只保证不切断代理对（emoji 半字）。

export const spec = Object.freeze({
  name: 'outbound/split',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

const DEFAULT_MAX_CHARS = 120;
const DEFAULT_MAX_PARTS = 6;
const DEFAULT_BREAK_ON = '。！？；';

/** 正整数；非法（NaN / 0 / 负数 / Infinity）一律回落默认值。 */
function sizeOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 代理对高位：切在它后面会把 emoji 劈成两半，永久拼不回来（同 bridge.js:9344）。 */
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

/**
 * @pure 切分文本。
 *
 * 策略：窗口内**从后往前**找最后一个断句符，尽量让每段既装满又停在句子边界；
 * 窗口内没有断句符就按 maxChars 硬切（避开代理对）。切完若段数超过 maxParts，
 * 把第 maxParts 段之后的全部合并进最后一段。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxChars] 单段上限（字符数，按 UTF-16 码元计），默认 120
 * @param {number} [options.maxParts] 最多几条，超出则合并尾段，默认 6
 * @param {string} [options.breakOn]  断句符集合，默认 '。！？；'
 * @returns {{ parts: string[], truncated: boolean, reason: string }}
 */
export function splitText(text, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxChars = sizeOf(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxParts = sizeOf(opts.maxParts, DEFAULT_MAX_PARTS);
  const breakOn = typeof opts.breakOn === 'string' ? opts.breakOn : DEFAULT_BREAK_ON;

  const source = typeof text === 'string' ? text : String(text ?? '');
  const trimmed = source.trim();

  if (!trimmed) {
    return {
      parts: [],
      truncated: false,
      reason: source ? '全是空白字符，无需分段' : '空文本，无需分段'
    };
  }

  if (trimmed.length <= maxChars) {
    return { parts: [trimmed], truncated: false, reason: `未超过 ${maxChars} 字，单段发送` };
  }

  const parts = [];
  let rest = trimmed;
  let cutByBreak = false;
  let cutByForce = false;

  while (rest.length > maxChars) {
    let cut = -1;
    for (let i = maxChars - 1; i >= 0; i -= 1) {
      if (breakOn.includes(rest[i])) {
        cut = i + 1; // 断句符留在本段末尾
        cutByBreak = true;
        break;
      }
    }
    if (cut <= 0) {
      cut = maxChars;
      cutByForce = true;
      // 硬切才可能劈开代理对；退一格把整个字符让给下一段（cut>1 保证循环一定前进）
      if (cut < rest.length && cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) {
        cut -= 1;
      }
    }

    const piece = rest.slice(0, cut).trim();
    if (piece) parts.push(piece); // 不产生空段
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());

  let truncated = false;
  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    // 合并尾段：用空串拼接，保证字符一个不少地被带走
    head.push(parts.slice(maxParts - 1).join(''));
    parts.length = 0;
    parts.push(...head);
    truncated = true;
  }

  const how = cutByForce
    ? cutByBreak
      ? `断句符优先，其余按 ${maxChars} 字硬切`
      : `无断句符，按 ${maxChars} 字硬切`
    : '都在断句符后切分';

  const reason = truncated
    ? `${how}，超出 ${maxParts} 段上限，尾部合并为末段（末段 ${parts[parts.length - 1].length} 字）`
    : `${how}，共 ${parts.length} 段`;

  return { parts, truncated, reason };
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx。
 *
 * @param {object} _ctx
 * @param {string} text
 * @param {object} [options] 同 splitText
 * @returns {{ ok: true, value: { parts: string[], truncated: boolean, reason: string } }}
 */
export function handle(_ctx, text, options) {
  return { ok: true, value: splitText(text, options) };
}
