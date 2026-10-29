// inbound/file-risk — 判定一条入站消息里的「群文件」文件名是否像钩子（资源合集 / 解压密码 / 网盘…）
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// 任务书：docs/module-ownership.md M1 · docs/trap-hardening-handover.md §6-2
// deps：无                      （词表由调用方按需传入，模块不读 cfg）
// 失败策略：fail-open            （依据：D 表口径——判定坏了按「无命中」，绝不因为一个文件名丢掉整条消息）
// 单测：tests/inbound-file-risk.test.mjs
//
// 为什么需要：2026-10-29 15:22 群里发来 `PC电脑资源大合集打开即可下载 .txt`，桥接把文件名拼进
// 上下文后接了话（「这文件名比内容还长」）。这类文件名不是聊天内容，是钩子：模型一旦复述或评价，
// 就等于替它做了扩散。判定必须放在**入站**——等到出站守卫已经来不及，话已经说出口了。
//
// 边界：只读入参（消息段 + 已归一文本），不下载、不取字节、不读 cfg/state/时钟、不打日志、
// 不 import bridge.js。返回结论（suspicious / hits / names / reason），
// 「记 [guard] suspicious-file」与「不唤醒」由中枢决定（模块不管记账，也不管会话状态）。
//
// 只认 file 段与文本里的 `[文件…]` 标记：群友在聊天里打出「网盘」不算命中——
// 那不是文件，误伤正常聊天比漏放一条更贵（这条规则只该管文件）。

import { truncateText } from '../md-to-plain.js';

export const spec = Object.freeze({
  name: 'inbound/file-risk',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // 新规则、还没跑过真实流量：归 owner 管，默认开。
  // 注意：本轮只允许 bridge.js 一处调用，moduleSwitch 尚未接线 —— 要关只能在调用点改，
  // 不要以为控制台能把它拨掉。
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

/**
 * 默认词表：文件名命中任一即视为可疑群文件。
 *
 * 取舍：`下载` / `网盘` 单独一个词也算命中。误伤成本 = 这条群消息不接话（文件还在，人还能自己看）；
 * 漏放成本 = 帮一个钓鱼文件名做了背书。词表是**整表覆盖**语义（传了非空数组就丢掉内置表）。
 *
 * `资源大合集` 是单列的变体：15:22 那条实际写的是「资源大合集」，字面「资源合集」匹配不到它
 * （中间多了个「大」）。同类写法会继续冒出来，所以变体只能靠加词，不靠猜。
 */
export const DEFAULT_SUSPICIOUS_FILE_KEYWORDS = Object.freeze([
  '资源合集',
  '资源大合集',
  '下载',
  '解压密码',
  '打开即可',
  '网盘'
]);

/** 参与判定的文件名上限：超长名字后半段必然是填充噪声，也避免日志被一条消息撑爆。 */
const MAX_NAME_CHARS = 120;

/** 回显到 activity 的文件名上限（`[guard] suspicious-file` 那一行只留可辨认的一截）。 */
const MAX_REASON_NAME = 40;

/** file 段里可能放文件名的字段（线上是 `name`，网关实现有 `file_name` / `fileName` / `file`）。 */
const FILE_NAME_FIELDS = Object.freeze(['name', 'file_name', 'fileName', 'file']);

/** 零宽/控制字符：拆字变体会把关键词拆成「资\u200b源合集」，匹配前必须先拔掉。 */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff\u2028\u2029]/g;

/** 文本里的文件标记（segments.js 的 `[文件${d.name}]`；网关把段拍平成字符串时只剩它）。 */
const FILE_MARKER_RE = /\[文件([^\]]{0,120})\]/g;

/** 字符串化永不抛：入参可能是 null 原型对象、Symbol、toString 抛错的怪东西（D 表 fail-open）。 */
function safeString(value) {
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * @pure 匹配用的归一化副本：NFKC（全角→半角）+ 小写 + 去零宽/控制字符 + 去全部空白。
 * 去空白是为了让「资 源 合 集」「下载\n」这类拆字写法也能命中；判定始终在副本上做，
 * 返回的 names 仍是原文。
 */
function normalizeForMatch(value) {
  return safeString(value).normalize('NFKC').toLowerCase().replace(INVISIBLE_RE, '').replace(/\s+/g, '');
}

/** 一条消息段里的文件名；不是 file 段、没有可用字段时返回 ''（不连坐整条消息）。 */
function fileNameOfSegment(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'file') return '';
  const data = seg.data;
  if (!data || typeof data !== 'object') return '';
  for (const field of FILE_NAME_FIELDS) {
    const name = safeString(data[field]).replace(/[\r\n\t]+/g, ' ').trim();
    if (name) return truncateText(name, MAX_NAME_CHARS);
  }
  return '';
}

/** 文本里的 `[文件…]` 标记 → 文件名列表（没有标记时返回空数组，正则不回溯整段文本）。 */
function namesFromText(text) {
  const raw = safeString(text);
  if (!raw.includes('[文件')) return [];
  const out = [];
  FILE_MARKER_RE.lastIndex = 0;
  let matched = FILE_MARKER_RE.exec(raw);
  while (matched) {
    const name = matched[1].replace(/[\r\n\t]+/g, ' ').trim();
    if (name) out.push(truncateText(name, MAX_NAME_CHARS));
    matched = FILE_MARKER_RE.exec(raw);
  }
  return out;
}

/** 词表归一：非数组 / 空数组 / 全空白 → 用内置表（与 settings 里 `words: []` 的既有语义一致）。 */
function resolveKeywords(value) {
  if (!Array.isArray(value)) return DEFAULT_SUSPICIOUS_FILE_KEYWORDS;
  const list = value.map((item) => safeString(item).trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_SUSPICIOUS_FILE_KEYWORDS;
}

/** 命中关键词的第一个文件名（用于 activity 回显；不命中返回 ''）。 */
function firstHitName(normalizedNames, normalizedHits) {
  for (const item of normalizedNames) {
    if (normalizedHits.some((needle) => item.normalized.includes(needle))) return item.name;
  }
  return '';
}

/** 单行摘要：只给关键词 + 一截文件名，够运维对账，又不把整条消息塞进日志。 */
function buildReason(hits, name) {
  const words = `命中「${hits.join('/')}」`;
  if (!name) return words;
  const shown = truncateText(name, MAX_REASON_NAME);
  return `${words}：${shown}${shown.length < name.length ? '…' : ''}`;
}

/**
 * @pure 判定一条入站消息是否带可疑群文件。
 *
 * 入参：
 *   segments — OneBot 消息段（只读 file 段的文件名；其它段一律忽略）
 *   text     — 已归一的文本（读 `[文件…]` 标记，覆盖「段被拍平成字符串」的网关实现）
 *   keywords — 可选词表（非空数组整表覆盖内置表；空/缺省用内置表）
 *
 * 返回：`{ ok: true, suspicious, hits, names, reason }`
 *   - hits 按词表顺序、去重；names 是参与判定的原文文件名（去重、限长）
 *   - 不命中时 hits 为空数组、reason 为 ''
 *   - 永不抛：任何一段/一个字段坏掉都只影响它自己（fail-open）
 *
 * @param {{ segments?: unknown, text?: unknown, keywords?: unknown }} [input]
 * @returns {{ ok: true, suspicious: boolean, hits: string[], names: string[], reason: string }}
 */
export function assessFileRisk(input = {}) {
  const names = [];
  const seen = new Set();
  const push = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  const segments = Array.isArray(input?.segments) ? input.segments : [];
  for (const seg of segments) {
    try {
      push(fileNameOfSegment(seg));
    } catch {
      // 单段取值器抛错（data 是 Proxy、getter 炸了）：跳过这一段，继续看别的段（fail-open）。
    }
  }
  for (const name of namesFromText(input?.text)) push(name);

  const normalizedNames = names.map((name) => ({ name, normalized: normalizeForMatch(name) }));
  const hits = [];
  const normalizedHits = [];
  for (const keyword of resolveKeywords(input?.keywords)) {
    const needle = normalizeForMatch(keyword);
    if (!needle || normalizedHits.includes(needle)) continue;
    if (!normalizedNames.some((item) => item.normalized.includes(needle))) continue;
    normalizedHits.push(needle);
    hits.push(keyword);
  }

  const suspicious = hits.length > 0;
  return {
    ok: true,
    suspicious,
    hits,
    names,
    reason: suspicious ? buildReason(hits, firstHitName(normalizedNames, normalizedHits)) : ''
  };
}

/**
 * 契约门面（B.1）。本模块 deps 为空，ctx 不参与计算。
 *
 * @param {object} _ctx
 * @param {{ action?: 'assess', segments?: unknown, text?: unknown, keywords?: unknown }} [args]
 * @returns {{ ok: true, value: object } | { ok: false, code: 'INVALID_ARGS', error: string }}
 */
export function handle(_ctx, args = {}) {
  const action = String(args?.action ?? 'assess');
  if (action === 'assess') return { ok: true, value: assessFileRisk(args) };
  return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}（只支持 assess）` };
}
