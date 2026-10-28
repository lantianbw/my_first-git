// obs/log-format — 把一条日志渲染成单行文本（纯函数，不碰 IO、不读时钟）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 obs/log「fail open」/ H2 obs/log=locked）
// deps：无                       （optional：无）
// 失败策略：fail-open            （依据：D 表 obs/log「日志坏了不能带走进程」——本模块不抛业务错）
// 单测：tests/log-format.test.mjs
//
// 为什么需要：现在一行的样子是在 bridge.js 的 log() 里用模板串拼出来的，截断长度、换行处理、
// 脱敏顺序全焊在函数体里，想验证「超过 1000 字会变成什么样」「meta 会不会被塞进来」只能起桥。
// 这里把「行长什么样」抽出来：给同样的字段，永远得到同样的字符串，且可以在任何地方复用
// （控制台、工具日志、审计旁路），不必再各写一套格式。
//
// 边界：不写文件、不打印、不读 Date.now（at 一律由调用方传）、不做采样与轮转、不判断级别是否合法。
// 也不内置脱敏 —— 脱敏是独立导出的 redact()，调用方按「先脱敏、后格式化」组合，与 bridge.log 的
// 既有顺序一致（脱敏作用在原始文本上，格式化的截断不会把 *** 从中间劈开）。
//
// 行格式（与 bridge.js log() 对齐，额外补了级别与日期）：
//   <本地时间带时区> [<level>] [<scope>] <message> <meta-json>
//   例：2026-10-28T00:10:28+08:00 [warn] [bridge] 发送失败 {"code":"EPIPE"}
//
// 与旧实现的差异（有意为之）：
//   · 旧 localClock() 只给 HH:MM:SS，跨天的日志分不清是哪一天；这里给完整日期 + 时区偏移
//   · 旧 log() 把换行折成空格；这里折成 ⏎，保留「原文分几行」这个信息
//   · 旧 log() 没有级别与 meta；这里显式带上

import { SENSITIVE_RE } from '../sensitive.js';

/** 正文上限：与 bridge.js 的 LOG_LINE_MAX 一致（1000）。 */
const MAX_BODY_LEN = 1000;
const TRUNCATED_SUFFIX = '…[截断]';
const NEWLINE_MARK = '⏎';

export const spec = Object.freeze({
  name: 'obs/log-format',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间 + 时区偏移（不用 toISOString 的 UTC，否则和本地对不上 8 小时）。 */
function localIso(at) {
  const d = new Date(at);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** 折成单行：任何换行都变成 ⏎（`\r\n` 只算一次）。 */
function singleLine(text) {
  return String(text).replace(/[\r\n]+/g, NEWLINE_MARK);
}

/** 把任意值渲染成文本：字符串原样，其余走 JSON，序列化失败也不抛。 */
function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return '(日志参数无法序列化)';
  }
}

/** meta 只在有值（非 null/undefined/空对象/空数组/空串）时才追加。 */
function metaTextOf(meta) {
  if (meta === undefined || meta === null || meta === '') return '';
  let json;
  try {
    json = JSON.stringify(meta);
  } catch {
    return '[meta 无法序列化]';
  }
  if (json === undefined || json === '{}' || json === '[]') return '';
  return singleLine(json);
}

/**
 * 渲染一行日志。
 *
 * @param {object}  line
 * @param {number}  line.at       毫秒时间戳（调用方注入 now()，本模块不读系统时钟）
 * @param {string}  [line.level]  级别，缺省 info；原样小写化，不做白名单校验
 * @param {string}  [line.scope]  模块/域标签，缺省不输出该段
 * @param {*}       [line.message] 正文；非字符串走 JSON
 * @param {*}       [line.meta]   附加结构，空值不追加
 * @returns {string} 单行、无换行、正文不超过 MAX_BODY_LEN
 */
export function formatLine({ at, level, scope, message, meta } = {}) {
  if (!Number.isFinite(at)) {
    throw new TypeError('formatLine: at 必须是毫秒时间戳（由调用方注入 now()，本模块不读系统时钟）');
  }

  const lv = String(level ?? 'info').trim().toLowerCase() || 'info';
  const sc = singleLine(String(scope ?? '').trim());

  let body = singleLine(textOf(message));
  const metaText = metaTextOf(meta);
  if (metaText) body = body ? `${body} ${metaText}` : metaText;
  // 截断口径与旧 log() 一致：作用在正文上，前缀（时间/级别/域）不参与预算
  if (body.length > MAX_BODY_LEN) body = `${body.slice(0, MAX_BODY_LEN)}${TRUNCATED_SUFFIX}`;

  const head = `${localIso(at)} [${lv}]${sc ? ` [${sc}]` : ''}`;
  return body ? `${head} ${body}` : head;
}

/**
 * 脱敏：路径 / 凭据赋值 / 已知令牌。
 *
 * 语义与 bridge.js 的 redactSensitiveText 一致：正则里没有 g 就补上再全局替换为 ***；
 * 字符串项按精确子串替换（裸令牌既不是路径也没有 `token=` 形态，只有精确名单能拦住）。
 * 每次都用新建的 RegExp，避免调用方传入带 g 的正则时被 lastIndex 拖成有状态。
 *
 * @param {string} text
 * @param {Array<RegExp|string>|RegExp|string} [patterns] 缺省用共享的 SENSITIVE_RE
 * @returns {string}
 */
export function redact(text, patterns = [SENSITIVE_RE]) {
  let out = String(text ?? '');
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of list) {
    if (!pattern) continue;
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      out = out.replace(new RegExp(pattern.source, flags), '***');
    } else if (typeof pattern === 'string') {
      if (out.includes(pattern)) out = out.split(pattern).join('***');
    }
  }
  return out;
}
