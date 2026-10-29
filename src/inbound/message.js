// inbound/message — 把一条入站消息定形为统一 DTO（纯函数：无 IO、无时钟、无状态）
//
// 契约：docs/module-contract.md v1.1（B.1 spec + handle）· docs/inbound-message-dto.md（字段表 / 第四节归一口径）
// deps：无                    （optional：无）
// 失败策略：fail-closed（**仅本条消息**）
//   依据：DTO 契约第三节 —— 返回 {ok:false} 时调用方丢弃这一条并记账，绝不把半截文本投给模型
//         （与 D 表 `inbound/segments` 同口径）
// 单测：tests/inbound-message.test.mjs
//
// 为什么需要：同一条入站消息现在被三处各自拼装（appendRecentMessage / appendSocialV2Message /
// handleIncoming 的 msg），字段名与归一规则互不一致 —— 媒体被拍平后 emojiId/subType 丢掉，市场表情
// 只能先走必然失败的 get_image；文本一处存原文、一处截到 200 字，下游只能靠猜；forwardIds 只在其
// 中一处做过清洗。这里把「定形」收敛成一个可单测的纯函数，三处构造点最终读同一个对象。
//
// 边界：不解析消息段（segmentsToText 的产物由调用方传入）、不取字节、不下载、不读 cfg/state/
// process.env、不写文件、不联网、不读时钟、不打日志、不 import bridge.js（F.1）。
// 不分配 seq、不去重 forwardIds、不限流 —— 三者都要跨消息状态，留中枢（DTO 第六节）。
// text/plainText 一律保留原文：截断是消费者的事（DTO 第四节 text/plainText 行）。
//
// 复用而非复制：summary 走 segments.js 的 sanitizeMediaSummary、forward id 走 forward.js 的
// sanitizeForwardId —— 第四节点名要求「走」这两个函数；复制一份只会在下次改白名单/限长时漂移
// （F.6 允许 import 显式导出的纯函数，两者都不读 IO、import 时零副作用）。

import { sanitizeMediaSummary } from './segments.js';
import { sanitizeForwardId } from '../forward.js';

export const spec = Object.freeze({
  name: 'inbound/message',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：文本收发的入站定形，关掉等于消息形状退回三处各拼一套（契约 H1 / H2 `inbound/message` 行）
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** `mediaText` 最多带几条（与 appendSocialV2Message 的 `.slice(0, 6)` 一致）。 */
const MAX_MEDIA_TEXT = 6;

/** DTO §2 的 kind 白名单；其余一律按 image 处理（`safeMedia` 同口径）。 */
const MEDIA_KINDS = Object.freeze(['image', 'sticker', 'face']);

/** 会话键：`group:<id>` / `private:<id>`，id 不含空白（已过 parseKey 的规范形态）。 */
const KEY_RE = /^(group|private):(\S+)$/;

/** 会话类型；key 前缀与 kind 必须一致，否则对象自相矛盾。 */
const SESSION_KINDS = Object.freeze(['group', 'private']);

/** 媒体项上「有就带上、空就不写」的定位字段（顺序即 DTO §2 的字段顺序）。 */
const MEDIA_LOCATOR_FIELDS = Object.freeze(['file', 'url', 'faceId', 'emojiId', 'emojiPackageId', 'emojiKey']);

const fail = (code, error) => ({ ok: false, code, error });

/** 取值归一：null/undefined → ''，其余按 String 转（**不 trim**，trim 由各字段自己决定）。 */
function toStr(value) {
  return value == null ? '' : String(value);
}

/** 可空字符串：空串与纯空白都归一为 null —— DTO 里「没有」写 null，不写 ''。 */
function toNullable(value) {
  const s = toStr(value).trim();
  return s || null;
}

/** 错误信息里回显入参：字符串只截 40 字（一条群消息可以很长，日志不能被它淹掉）。 */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    return value.length > 40 ? `"${value.slice(0, 40)}…"（共 ${value.length} 字）` : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * seq 归一：DTO 里 0 表示「未知」。
 * 只认数字（`'7'` 这类字符串是调用方拼错，静默当 0 比猜成 7 安全）；负数/NaN/Infinity 同样归 0，
 * 因为 seq 只用于未读水位，值坏了不该因此丢掉整条消息。
 */
function toSeq(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * mediaText 归一：去空白、丢空串、最多 6 条（与 handleIncoming 的 msg 组装逐字一致）。
 * 非数组一律当「没有补充文本」，不判失败 —— 只影响模型多看到一句话，不该丢消息。
 */
function sanitizeMediaText(list) {
  if (!Array.isArray(list)) return [];
  return list.map((line) => toStr(line).trim()).filter(Boolean).slice(0, MAX_MEDIA_TEXT);
}

/**
 * poke 归一：null 或 `{ targetId, targetIsSelf, groupId }`（DTO §2）。
 * `targetIsSelf` 只信任入参，不由 targetId 反推 —— 模块拿不到 selfId（不读 cfg）。
 * 非 null 且非对象一律判失败：静默当 null 会把「拍了我一下」的唤醒吞掉，属于谎报。
 */
function readPoke(value) {
  if (value == null) return { ok: true, poke: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('INVALID_ARGS', `poke 只接受 null 或对象，收到 ${describeValue(value)}`);
  }
  return {
    ok: true,
    poke: {
      targetId: toNullable(value.targetId),
      targetIsSelf: value.targetIsSelf === true,
      groupId: toNullable(value.groupId)
    }
  };
}

/**
 * @pure 单条媒体归一（DTO §4 kind/face/image·sticker/summary/subType 五行）。
 * 不是对象、或没有可定位标识时返回 null（由 sanitizeMediaList 丢掉这一项，不连坐整条消息）。
 *
 * @param {unknown} m OneBot 段产物或已归一过的媒体项
 * @returns {{kind: 'image'|'sticker'|'face', file?: string, url?: string, faceId?: string,
 *   emojiId?: string, emojiPackageId?: string, emojiKey?: string, subType?: string,
 *   summary?: string} | null}
 */
export function sanitizeMediaItem(m) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return null;

  // kind 白名单：只有 face / sticker 能被认出来，其余（含 video、拼错的 image_sticker）一律 image。
  const kind = MEDIA_KINDS.includes(m.kind) ? m.kind : 'image';
  const item = { kind };

  // 定位字段：OneBot 常给 '' 而不是缺字段，空串/纯空白一律视为没有 ——
  // 否则调用方会拿 ' ' 当文件名去 get_image，白跑一次请求。
  for (const field of MEDIA_LOCATOR_FIELDS) {
    const value = toStr(m[field]).trim();
    if (value) item[field] = value;
  }

  // subType：线上段字段是 snake_case 的 `sub_type`，SDK 类型拼作 `subType`。两个都读、snake 优先
  // —— 只读 camelCase 会永远是空串且不报错（segments.js `mediaOf` 已记录过这个坑）。
  const subType = toStr(m.sub_type ?? m.subType).trim();
  if (subType) item.subType = subType;

  // summary 走 segments 的 sanitizeMediaSummary：压掉换行/控制字符并限长 60，
  // 否则一条群消息能用摘要里的换行伪造出新的提示词段落。
  const summary = sanitizeMediaSummary(m.summary);
  if (summary) item.summary = summary;

  // 丢弃规则与 appendSocialV2Message 的 `.filter(...)` 同口径：
  // face 必须有 faceId；image/sticker 的 file/url/emojiId 至少一个非空。
  if (item.kind === 'face') return item.faceId ? item : null;
  return item.file || item.url || item.emojiId ? item : null;
}

/** 去重用的标识：face 按 faceId，其余按 file → url → emojiId 的首个非空值。 */
function mediaIdentity(item) {
  if (item.kind === 'face') return `face:${item.faceId}`;
  return `${item.kind}:${item.file || item.url || item.emojiId}`;
}

/**
 * @pure 媒体列表归一：丢空项 + 去重（标识 = kind + 定位字段）。
 * 截断/限额不在这里做 —— 一屏能放几张图由消费者决定。
 *
 * @param {unknown} list
 * @returns {Array<object>} 归一后的 MediaItem 数组（非数组 → []）
 */
export function sanitizeMediaList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = sanitizeMediaItem(raw);
    if (!item) continue;
    const identity = mediaIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(item);
  }
  return out;
}

/**
 * @pure 转发 id 清洗（DTO §4 `forwardIds` 行）。
 * 只清洗、不过滤重复：同一张转发卡片出现两次就是两条记录，去重需要跨消息状态，留中枢（§6）。
 *
 * @param {unknown} list
 * @returns {string[]} 通过白名单的 id（非数组 → []）
 */
export function sanitizeForwardIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const id = sanitizeForwardId(raw);
    if (id) out.push(id);
  }
  return out;
}

/**
 * @pure 入站消息定形（DTO §2 全字段，一个不多一个不少）。
 *
 * 入参就是三个构造点已经拼好的散装字段；本模块只做归一与派生，不改语义：
 *   - 派生字段（hasMedia / hasForward）一律由归一后的列表算出，不信任入参；
 *   - text 保留原文（不 trim、不截断）；plainText 缺失时回退 text（无引用时两者相同）；
 *   - chatId 缺失时取 key 的后半段（key 已过 parseKey，是规范形态）。
 *
 * @param {object} input
 * @returns {{ ok: true, message: object } | { ok: false, code: 'INVALID_ARGS', error: string }}
 */
export function normalizeInbound(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('INVALID_ARGS', `入站消息必须是对象，收到 ${describeValue(input)}`);
  }

  // ── 身份：key 必须已是规范键，kind 必须与 key 前缀一致 ──────────────────
  const key = toStr(input.key).trim();
  const keyed = KEY_RE.exec(key);
  if (!keyed) {
    return fail('INVALID_ARGS', `key 必须是 group:<id> 或 private:<id>，收到 ${describeValue(input.key)}`);
  }
  const keyKind = keyed[1];
  const chatId = toStr(input.chatId).trim() || keyed[2];

  const kind = toStr(input.kind).trim();
  if (!SESSION_KINDS.includes(kind)) {
    return fail('INVALID_ARGS', `kind 只允许 group / private，收到 ${describeValue(input.kind)}`);
  }
  if (kind !== keyKind) {
    return fail('INVALID_ARGS', `kind=${kind} 与 key=${key} 不一致（对象自相矛盾的消息不投给模型）`);
  }

  // ── 时间：必须由调用方传入。模块不读 Date.now()（F.7），所以这里没有兜底值 ──
  const time = input.time;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    return fail('INVALID_ARGS', `time 必须由调用方传入有限毫秒时间戳，收到 ${describeValue(time)}`);
  }

  const poked = readPoke(input.poke);
  if (!poked.ok) return poked;

  // ── 媒体 / 转发 ──────────────────────────────────────────────────────
  const media = sanitizeMediaList(input.media);
  const forwardIds = sanitizeForwardIds(input.forwardIds);

  // 文本保留原文：连首尾空白都不动（行首 `/` 的指令判定、引用格式都靠它），截断留消费者。
  const text = toStr(input.text);
  const plainText = input.plainText == null ? text : toStr(input.plainText);

  const message = {
    key,
    kind,
    chatId,
    userId: toStr(input.userId).trim(),
    senderName: toStr(input.senderName).trim(),

    messageId: toStr(input.messageId).trim(),
    seq: toSeq(input.seq),

    isSelf: input.isSelf === true,
    isOwner: input.isOwner === true,
    quoteTargetIsSelf: input.quoteTargetIsSelf === true,

    text,
    plainText,

    media,
    hasMedia: media.length > 0,
    mediaText: sanitizeMediaText(input.mediaText),

    forwardIds,
    hasForward: forwardIds.length > 0,
    poke: poked.poke,
    atUserId: toNullable(input.atUserId),

    time
  };

  return { ok: true, message };
}

/**
 * 契约门面（B.1）。四个动作与四个导出函数一一对应：
 *   normalize    — 入站消息定形（args.input）
 *   media-item   — 单条媒体归一（args.item），丢弃时 value 为 null
 *   media-list   — 媒体列表归一（args.list）
 *   forward-ids  — 转发 id 清洗（args.list）
 *
 * @param {object} _ctx 本模块 deps 为空，ctx 不参与计算（保留签名以符合契约）
 * @param {{ action?: 'normalize'|'media-item'|'media-list'|'forward-ids', input?: object,
 *   item?: unknown, list?: unknown }} [args]
 * @returns {{ ok: true, value: any } | { ok: false, code: 'INVALID_ARGS', error: string }}
 */
export function handle(_ctx, args = {}) {
  const action = String(args?.action ?? 'normalize');
  if (action === 'normalize') {
    const result = normalizeInbound(args?.input);
    // 归一失败直接把 {ok:false,code,error} 透出（B.2 的失败形状），成功才裹一层 value。
    return result.ok ? { ok: true, value: result.message } : result;
  }
  if (action === 'media-item') return { ok: true, value: sanitizeMediaItem(args?.item) };
  if (action === 'media-list') return { ok: true, value: sanitizeMediaList(args?.list) };
  if (action === 'forward-ids') return { ok: true, value: sanitizeForwardIds(args?.list) };
  return fail('INVALID_ARGS', `未知 action：${action}（只支持 normalize / media-item / media-list / forward-ids）`);
}
