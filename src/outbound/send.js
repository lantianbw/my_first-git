// outbound/send — 发送前的文本整形：单行压平，超长切分（URL 与代理对不切开）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 outbound/send 行）
// deps：无                    （optional：无；纯计算，ctx 一个字段都不读）
// 失败策略：fail-closed        （依据：D 表 `outbound/send` 行——整形失败的文本宁可拒发，
//                              也不能把超长段、半个 emoji 或 [object Object] 发出去；
//                              handle 对不可无损转字符串的入参回 INVALID_ARGS）
// 单测：tests/outbound-send.test.mjs
// 导出 @pure：singleLineForQQ / splitLongSegment / prepareOutboundText（跨域可直接 import，
//             不读 ctx、不读时钟、不产生副作用）
// args：{ action: 'prepare'|'split'|'single-line', text, max?, maxChars? }
//
// 为什么需要：`singleLineForQQ()` 与 `splitLongSegment()` 内嵌在 bridge.js 的发送链路里，
// 想验证「会不会把一条 URL 切断 / 会不会把 emoji 劈成两半」只能起整个桥发真消息。
// 这两段各背着一场真实事故：
//   · URL 占位符 `\u0000URL<n>\u0000` 曾被按上限硬切拦腰截断，还原正则失配 →
//     URL 整条消失、裸 NUL 与字面量 "URL0" 被发进群里（13 个偏移里坏了 5 个）；
//   · 硬切曾落在代理对中间 → 两个孤立代理各成一条 QQ 消息，永远拼不回来，群友看到方块。
// 目前只有 scripts/test-voice.mjs 用 eval 从 bridge.js 里抽源码来测，脆且只覆盖 URL 一种。
// 抽成纯函数后：进字符串出数组，可离线断言字符完整性，也能被别的通道（控制台预览、
// 语音字幕）复用。
//
// 边界：只整形字符串。不发送、不排队、不重试、不判断"该不该发"、不读 cfg / state /
// process.env、不读写文件、不联网、不打日志、不用 Date.now() / Math.random()、
// 不 import bridge.js、不改写入参。
// 真正的发送（sendToQQ / onebotSend / 失败记账）仍在中枢：本模块只管"发什么字节"。
//
// 与中枢原实现的一致性（换接时必须逐字节不变）：
//   · 同一套正则与顺序：先 `\s*\n\s*` 压行，再 `[ \t]{2,}` 压空格，最后 trim；
//   · 同一默认上限 500，同一"非法上限回退 500、小数向下取整"口径；
//   · 长度按 **UTF-16 码元** 计（`s.length`），不是码点——改成 [...s].length 会让
//     含 emoji 的段落切点整体偏移；
//   · 同一占位符协议与"宁可某段略超上限，也绝不切开占位符"的让步；
//   · 同一代理对退格规则（末位是高位代理就退一格，退成空串则不退，保证循环前进）。
// 唯一刻意差异：`handle` 会拒绝 object / array / function / symbol 入参。原实现走
// `String(v ?? '')`，对象会变成 "[object Object]" 直接发给用户；属可见的谎报，按
// fail-closed 拒收。纯函数仍保留原转换口径，供将来逐字节替换。
//
// 已知副作用（沿用原实现，不要"顺手修"）：按标点攒段时每段会 trim，切点处的空白会被
// 吃掉。所以"拼接 === 原文"只在去掉空白后成立，这条不变式由单测守着。

export const spec = Object.freeze({
  name: 'outbound/send',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // 文本收发本体：关掉就没有"能发得出去"的消息（超长段会被 QQ 直接拒），故 locked。
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 中枢沿用的单条上限（字符数，按 UTF-16 码元计）。 */
export const DEFAULT_MAX_CHARS = 500;

/** handle 支持的 action；不在这里的一律 INVALID_ARGS。 */
const ACTIONS = Object.freeze(['prepare', 'split', 'single-line']);

/**
 * @pure 压成一行：换行与行内连续半角空格/tab 变单空格，再 trim。
 * 只认半角空格与 tab；全角空格、NBSP 原样保留（群里排版靠它们）。
 *
 * @param {unknown} s
 * @returns {string}
 */
export function singleLineForQQ(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * @pure 把一段文本切成若干条不超过 max 的消息。
 *
 * 顺序：遮罩 URL → 按逗号类标点攒段（标点跟着前一段）→ 超长 token 硬切（占位符整块
 * 输出、代理对不切开）→ 还原 URL → 丢空段。
 *
 * @param {unknown} segment
 * @param {number} [max] 单段上限（UTF-16 码元）；非法值回退 DEFAULT_MAX_CHARS
 * @returns {string[]}
 */
export function splitLongSegment(segment, max) {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_CHARS;
  if (s.length <= safeMax) return [s];

  // URL 先换成占位符：整条地址是不可拆分的最小单位，否则会被硬切。
  const urlRe = /https?:\/\/[^\s，。；、]+/g;
  const urls = [];
  const masked = s.replace(urlRe, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  // 逗号类标点断句：split 带捕获组，标点留在偶数位，拼回前一段。
  const raw = masked.split(/([，、；：,;:])/);
  const tokens = [];
  for (let i = 0; i < raw.length; i += 2) {
    tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
  }

  const out = [];
  let cur = '';
  const placeholderAll = /\u0000URL\d+\u0000/g;
  /** 把 token 切成 {text, isPlaceholder} 序列；占位符整体一块，绝不拆。 */
  const splitByPlaceholder = (tok) => {
    const pieces = [];
    let last = 0;
    let m;
    placeholderAll.lastIndex = 0;
    while ((m = placeholderAll.exec(tok)) !== null) {
      if (m.index > last) pieces.push({ text: tok.slice(last, m.index), isPlaceholder: false });
      pieces.push({ text: m[0], isPlaceholder: true });
      last = m.index + m[0].length;
    }
    if (last < tok.length) pieces.push({ text: tok.slice(last), isPlaceholder: false });
    return pieces;
  };

  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.length > safeMax) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      for (const piece of splitByPlaceholder(tok)) {
        if (piece.isPlaceholder) {
          out.push(piece.text);
          continue;
        }
        for (let i = 0; i < piece.text.length;) {
          let end = Math.min(i + safeMax, piece.text.length);
          // 绝不在代理对中间下刀：末位是高位代理就退一格让给下一段；
          // 只剩 1 个码元可退时不退（否则循环不前进）。
          if (end < piece.text.length && end - i > 1) {
            const lastCode = piece.text.charCodeAt(end - 1);
            if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
          }
          out.push(piece.text.slice(i, end));
          i += end - i;
        }
      }
    } else if (cur.length + tok.length <= safeMax) {
      cur += tok;
    } else {
      out.push(cur);
      cur = tok;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
    .filter(Boolean);
}

/**
 * @pure 发送前整形：切段 + 逐段压成一行 + 丢空段。
 * 等价于中枢 `planSocialTimeline()` 关闭分条时的那一支。
 *
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options]
 * @returns {string[]}
 */
export function prepareOutboundText(text, options = {}) {
  const maxChars = options && typeof options === 'object' ? options.maxChars : undefined;
  return splitLongSegment(text, maxChars).map(singleLineForQQ).filter(Boolean);
}

/**
 * 把入参收敛成字符串。
 * object / array / function / symbol 会退化成 "[object Object]" 之类，属可见谎报，直接拒。
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function coerceText(value, field) {
  if (value === undefined || value === null) return '';
  const type = typeof value;
  if (type === 'string') return value;
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  throw new TypeError(`${field} 必须是字符串（收到 ${type}）：转字符串会退化成占位文本，拒发`);
}

/**
 * 契约门面。
 *
 * @param {object} [_ctx] 本模块不读任何 ctx 字段（deps 为空）
 * @param {object} [args]
 * @param {'prepare'|'split'|'single-line'} [args.action] 缺省 prepare
 * @param {unknown} args.text 待整形文本
 * @param {number} [args.max] split 的单段上限
 * @param {number} [args.maxChars] prepare 的单段上限
 * @returns {{ok: true, value: string|string[]} | {ok: false, code: string, error: string}}
 */
export function handle(_ctx, args = {}) {
  const action = String(args.action ?? 'prepare');
  if (!ACTIONS.includes(action)) {
    return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
  }
  try {
    const text = coerceText(args.text, 'text');
    if (action === 'single-line') return { ok: true, value: singleLineForQQ(text) };
    if (action === 'split') return { ok: true, value: splitLongSegment(text, args.max) };
    return { ok: true, value: prepareOutboundText(text, { maxChars: args.maxChars }) };
  } catch (error) {
    // 拒发而不是抛给调用方：调用方拿到 code 就能决定"这条不发"，
    // 抛出则会被上层当成 UPSTREAM 走重试，而重试同一个坏入参永远不会成功。
    return { ok: false, code: 'INVALID_ARGS', error: error?.message ?? String(error) };
  }
}
