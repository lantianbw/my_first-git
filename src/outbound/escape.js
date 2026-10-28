// outbound/escape — 发送前把文本里的「危险字符」和「看不见的垃圾」清掉
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `outbound/send` 邻近口径——净化是加一道保险，
//                              它本身出错时调用方仍应把原文发出去，而不是卡住）
// 单测：tests/escape.test.mjs
//
// 为什么需要：两件事一直散在两处。bridge.js:773 的 escapeCqText 只把 `[CQ:` 换成 `[CQ：`，
// 防的是「模型输出 [CQ:at,qq=all] 就能 @ 全体」这条注入；md-to-plain.js 的 mdToPlain 管
// Markdown 降级；至于零宽字符（模型很爱在长文里插 \u200B 当软换行）根本没人管，
// 到了 QQ 里就是莫名其妙的口口和断行。这里把「净化」收成三个可单测的纯函数。
//
// 边界：只处理字符串。不读文件、不联网、不读时钟、不改入参、不 import bridge.js。
// 三个函数互不依赖，可以单独用；prepareOutbound 只负责按固定顺序串起来。
//
// 两处与仓库既有实现的差异（都是有意的）：
//   1. **转义范围**。escapeCqText 只处理 `[CQ:` 前缀；这里按 OneBot 规范把
//      `& [ ] ,` 四个字符转成实体（&amp; &#91; &#93; &#44;），因为只有这样才能防住
//      `[CQ:at,qq=...]` 这类拼接注入。**前提是接收端会做 CQ 解码**；如果发送链路把
//      文本当纯文本原样发出，用户就会看到 `&#44;` 这种字面量——接线上要确认这一点。
//   2. **换行保留**。meme-lib.js:54 的不可见字符正则连 `\n` 一起删（那是表情文案，无所谓）；
//      这里是发给人的消息，换行是内容，所以只保留 `\n`，其余 C0/C1 控制符全删。

export const spec = Object.freeze({
  name: 'outbound/escape',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

/**
 * 零宽 + 控制符。保留 `\n`（0x0A），其余 C0/C1、DEL、零宽连接符、BOM、软连字符全删。
 * 判定标准是「人眼看不见、但会占位或改变排版」。
 */
const INVISIBLE_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u2060-\u2064\uFEFF]/g;

/** CQ 实体表。`&` 必须能识别「已经转义过」，否则重跑一次就会变成 &amp;amp;。 */
const CQ_MAP = Object.freeze({ '&': '&amp;', '[': '&#91;', ']': '&#93;', ',': '&#44;' });

/**
 * 单趟替换，且跳过已成型的实体（&amp; / &#91; / &#93; / &#44;），从而做到幂等。
 * 逐个替换会踩顺序坑：先换 `[` 再换 `&`，会把自己刚生成的 `&#91;` 再转一遍。
 */
const CQ_RE = /&(?!(?:amp|#91|#93|#44);)|\[|\]|,/g;

/** 把任意入参收敛成字符串（null/undefined → 空串，避免 "undefined" 被发进群）。 */
const asText = (text) => (typeof text === 'string' ? text : String(text ?? ''));

/**
 * @pure 转义 CQ 语法字符 `& [ ] ,`，正常标点（，。！？；：、「」（））一律不动。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeCq(text) {
  return asText(text).replace(CQ_RE, (ch) => CQ_MAP[ch]);
}

/**
 * @pure 去掉零宽字符与控制符，保留换行。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInvisible(text) {
  return asText(text).replace(INVISIBLE_RE, '');
}

/**
 * @pure 发送前净化：先去不可见字符，再转义 CQ 字符（顺序固定，保证逐字保序）。
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean, removed: number }} removed 是删掉的字符个数
 */
export function prepareOutbound(text) {
  const source = asText(text);
  const hits = source.match(INVISIBLE_RE);
  const removed = hits ? hits.length : 0;
  const cleaned = escapeCq(source.replace(INVISIBLE_RE, ''));
  return { text: cleaned, changed: cleaned !== source, removed };
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx；动作名选择用哪个函数。
 *
 * @param {object} _ctx
 * @param {{ action?: 'prepare'|'escape'|'strip', text?: string }} args
 * @returns {{ ok: true, value: any } | { ok: false, code: string, error: string }}
 */
export function handle(_ctx, args) {
  const action = args?.action ?? 'prepare';
  if (action === 'prepare') return { ok: true, value: prepareOutbound(args?.text) };
  if (action === 'escape') return { ok: true, value: escapeCq(args?.text) };
  if (action === 'strip') return { ok: true, value: stripInvisible(args?.text) };
  return { ok: false, code: 'INVALID_ARGS', error: `未知动作：${String(action)}（只支持 prepare / escape / strip）` };
}
