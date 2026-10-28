// inbound/segments — 入站消息段归一（两遍：带引用 / 纯文本）与媒体元数据提取
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 inbound/segments）
// deps：无                      （optional：无）
// 失败策略：fail-closed（**仅本条消息**）
//   依据：D 表 inbound/segments「归一失败 → 丢弃这一条并记账；绝不能把半截文本投给模型（会答错人）」
// 单测：tests/segments.test.mjs
//
// 为什么搬：segmentsToText / extractMediaFromSegments 原本内联在 bridge.js，靠闭包读 forward.js
// 的卡片格式化、靠调用方现传 resolveAtName / resolveReply 才能跑起来；想单测「一条 @ + 引用 +
// 图片的群消息会变成什么」就得起整个桥。搬出来后是「纯函数 + 注入解析器」，node --test 直接覆盖。
//
// 边界：不取字节、不下载、不读 state、不写日志、不 import bridge、不读时钟。
// @ 昵称与被引用原文的解析由调用方以函数注入 —— 本模块不知道群成员是谁、也不知道消息缓存。
//
// 与搬出前的三处刻意差异（都是为了让 fail closed 能真的落地）：
//   1. 返回结果对象 { ok:true, text } / { ok:false, code, error }，**不再把异常抛给调用方**。
//      segments 既不是纯文本也不是数组、或某一段在归一过程中抛错时，**整条消息**判失败；
//      不做「跳过坏段继续拼」—— 半截文本比没有文本更危险。
//   2. 旧代码里两处 `catch {}`（@ 昵称解析、引用原文解析）改为把原因记进 notes 后回退，
//      不再静默吞错（契约 F.5）。
//   3. 新增可选 maxText：默认不截断（与搬出前逐字节一致），要限长的调用方显式传；
//      截断走 truncateText（按码点安全，不会切坏 emoji 代理对）。
//
// 两遍的用法（桥里就是这么调的）：
//   带引用：segmentsToText(segments, { resolveAtName, resolveReply })
//   纯文本：segmentsToText(segments, { resolveAtName, includeReply: false })

import { forwardIdFromData, formatCardText } from '../forward.js';
import { truncateText } from '../md-to-plain.js';

export const spec = Object.freeze({
  name: 'inbound/segments',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：文本收发链路的入站归一，关掉等于桥收不到任何消息（契约 H1 / A.4）
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 媒体摘要（QQ 表情的 summary）限长，与搬出前一致。 */
const MAX_SUMMARY = 60;

const fail = (code, error) => ({ ok: false, code, error });

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 校验并取出段数组。
 * `null` / `undefined` 视为「没有段」（与搬出前 `segments ?? []` 一致，不判失败）；
 * 其它非数组（对象 / 数字 / Buffer）判 INVALID_ARGS —— 旧实现在这里会抛 TypeError。
 *
 * @param {unknown} segments
 * @returns {{ ok: true, segments: Array } | { ok: false, code: string, error: string }}
 */
function asSegmentList(segments) {
  if (segments == null) return { ok: true, segments: [] };
  if (Array.isArray(segments)) return { ok: true, segments };
  return fail('INVALID_ARGS', `消息段必须是数组或纯文本，收到 ${describeValue(segments)}`);
}

/** maxText 归一：非有限数 / ≤0 一律当「不截断」，避免误把整条消息截成空串。 */
function toLimit(maxText) {
  if (maxText == null) return Infinity;
  const limit = Number(maxText);
  if (!Number.isFinite(limit) || limit <= 0) return Infinity;
  return Math.floor(limit);
}

/**
 * 收尾：按需截断，并补齐 truncated / notes 两个字段（形状固定，便于调用方与单测断言）。
 */
function finish(text, maxText, notes = []) {
  const raw = String(text ?? '');
  const limit = toLimit(maxText);
  if (limit === Infinity || raw.length <= limit) {
    return { ok: true, text: raw, truncated: false, notes };
  }
  notes.push(`文本超过 ${limit} 字，已截断（原 ${raw.length} 字）`);
  return { ok: true, text: truncateText(raw, limit), truncated: true, notes };
}

/**
 * 媒体摘要会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
export function sanitizeMediaSummary(value, max = MAX_SUMMARY) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

/**
 * 单段 → 文本。可能抛（data 取值器异常等），由调用方统一按「整条失败」处理。
 * 注意：`notes` 是出参，解析器失败只记账并回退，不算归一失败（回退结果本身就是完整的）。
 */
async function renderSegment(seg, { resolveAtName, resolveReply, includeReply, notes }) {
  const d = seg?.data ?? {};
  switch (seg?.type) {
    case 'text': return d.text ?? '';
    case 'at': {
      if (d.qq === 'all') return '@全体成员';
      // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
      let name = null;
      try {
        name = resolveAtName ? await resolveAtName(String(d.qq)) : null;
      } catch (error) {
        notes.push(`@${d.qq} 昵称解析失败，回退 QQ 号：${error?.message ?? error}`);
        name = null;
      }
      return name ? `@${name}` : `@${d.qq}`;
    }
    case 'face': return `[表情${d.id ?? ''}]`;
    // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
    case 'mface': return `[表情${d.summary ? `:${d.summary}` : ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': {
      // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
      // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
      if (!includeReply) return '';
      let replyText = '';
      if (resolveReply) {
        try {
          const info = await resolveReply(String(d.id));
          if (info?.sender || info?.text) {
            const parts = [];
            if (info.sender) parts.push(info.sender);
            if (info.text) parts.push(info.text);
            replyText = `[引用 ${parts.join('：')}]`;
          }
        } catch (error) {
          notes.push(`引用 ${d.id} 解析失败，回退 [引用消息]：${error?.message ?? error}`);
        }
      }
      return replyText || '[引用消息]';
    }
    case 'json': return formatCardText(d.data ?? d.content ?? d);
    // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
    // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
    // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
    // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
    // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
    case 'markdown': return String(d.text ?? d.content ?? '[Markdown]');
    case 'forward': {
      const fid = forwardIdFromData(d);
      return fid ? `[转发消息 id=${fid}]` : '[转发消息]';
    }
    default: return `[${seg?.type ?? '未知'}]`;
  }
}

/**
 * 消息段 → 文本（入站归一的第一遍；换 includeReply 得到第二遍）。
 *
 * @param {string|Array|null|undefined} segments OneBot 的 message 字段
 * @param {object} [options]
 * @param {(qq: string) => Promise<string|null>|string|null} [options.resolveAtName] @ 昵称解析器
 * @param {(id: string) => Promise<{sender?: string, text?: string}|null>|null} [options.resolveReply] 引用解析器
 * @param {boolean} [options.includeReply=true] false = 跳过 reply 段（纯文本那一遍）
 * @param {number} [options.maxText] 文本上限（按 UTF-16 码元算，截断保代理对完整）；缺省不截断
 * @returns {Promise<{ ok: true, text: string, truncated: boolean, notes: string[] }
 *   | { ok: false, code: 'INVALID_ARGS'|'UPSTREAM', error: string }>}
 */
export async function segmentsToText(segments, options = {}) {
  const {
    resolveAtName = null,
    resolveReply = null,
    includeReply = true,
    maxText = Infinity
  } = options ?? {};

  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return finish(segments.trim(), maxText);

  const list = asSegmentList(segments);
  if (!list.ok) return list;

  const notes = [];
  const out = [];
  for (let i = 0; i < list.segments.length; i += 1) {
    const seg = list.segments[i];
    try {
      out.push(await renderSegment(seg, { resolveAtName, resolveReply, includeReply, notes }));
    } catch (error) {
      // fail closed（仅这条消息）：一段坏掉就整条失败，绝不把拼到一半的文本交给模型。
      return fail('UPSTREAM', `第 ${i + 1}/${list.segments.length} 段归一失败（${seg?.type ?? '未知'}）：${error?.message ?? error}`);
    }
  }
  return finish(out.join('').trim(), maxText, notes);
}

/** 单段的媒体元数据；不是媒体段返回 null。可能抛，由调用方统一兜。 */
function mediaOf(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const d = seg.data ?? {};
  // SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 + emoji_id/emoji_package_id/key/url**
  // （实测 sub_type 可能是 0，靠 emoji_id 区分），部分网关实现则用 mface 段。这三个字段必须留：
  // 一旦 get_image 取不到（市场表情不在网关缓存里），emoji_id 推出的 CDN 是唯一兜底。
  const emojiFields = {
    emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
    emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
    emojiKey: String(d.key ?? '')
  };
  if (seg.type === 'image') {
    return {
      kind: 'image',
      file: String(d.file ?? ''),
      url: String(d.url ?? ''),
      // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
      // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
      // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
      subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
      summary: sanitizeMediaSummary(d.summary),
      ...emojiFields
    };
  }
  if (seg.type === 'mface') {
    // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
    return {
      kind: 'sticker',
      file: String(d.file ?? ''),
      url: String(d.url ?? ''),
      subType: '1',
      summary: sanitizeMediaSummary(d.summary),
      ...emojiFields
    };
  }
  if (seg.type === 'face') {
    return {
      kind: 'face',
      faceId: String(d.id ?? ''),
      url: String(d.url ?? ''),
      summary: sanitizeMediaSummary(d.summary)
    };
  }
  return null;
}

/**
 * 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
 * 供一代自动内联、二代按需工具、控制台/日志使用。
 *
 * @param {Array|null|undefined} segments
 * @returns {{ ok: true, media: Array } | { ok: false, code: 'INVALID_ARGS'|'UPSTREAM', error: string }}
 */
export function extractMediaFromSegments(segments) {
  // 纯文本消息（string）本来就没有媒体段：与搬出前一致，返回空列表而不是判失败。
  // 这一条不能省 —— 有些 OneBot 实现把 message 直接给成 string，若在这里 fail closed，
  // 整条纯文本群消息会被当成「归一失败」丢掉。
  if (typeof segments === 'string') return { ok: true, media: [] };

  const list = asSegmentList(segments);
  if (!list.ok) return list;

  const media = [];
  for (let i = 0; i < list.segments.length; i += 1) {
    const seg = list.segments[i];
    try {
      const item = mediaOf(seg);
      if (item) media.push(item);
    } catch (error) {
      return fail('UPSTREAM', `第 ${i + 1}/${list.segments.length} 段媒体提取失败（${seg?.type ?? '未知'}）：${error?.message ?? error}`);
    }
  }
  return { ok: true, media };
}

/**
 * 契约门面（B.1）。三个动作：
 *   text  — 带引用归一（默认）
 *   plain — 纯文本归一（跳过 reply 段）
 *   media — 媒体元数据提取
 *
 * @param {object} _ctx
 * @param {{ action?: 'text'|'plain'|'media', segments?: any, resolveAtName?: Function,
 *   resolveReply?: Function, maxText?: number }} args
 */
export function handle(_ctx, args) {
  const action = args?.action ?? 'text';
  if (action === 'text') return segmentsToText(args?.segments, args);
  if (action === 'plain') return segmentsToText(args?.segments, { ...args, includeReply: false });
  if (action === 'media') return extractMediaFromSegments(args?.segments);
  return fail('INVALID_ARGS', `未知动作：${String(action)}（只支持 text / plain / media）`);
}
