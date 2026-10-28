// scheduler/triggers — 从一条群消息的文本里判断命中了哪些唤醒触发，取最高优先级
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `scheduler/wake` 行——漏一次唤醒，下条消息仍会触发投递）
// 单测：tests/triggers.test.mjs
//
// 为什么需要：bridge.js:13578 的 evaluateWakeTriggerV2 把「被 @ 没有 / 叫没叫名字 / 关键词 /
// 是不是在问」全揉在一个函数里，入参是 OneBot 事件对象（event.message 的 at 段、sender.card…），
// 想单独验一条文本要不要理，只能伪造整个事件。这里把文本匹配抽出来：给一段字符串、
// 一组自己的名字、自己的 QQ 号，回答「命中什么、多重要」。
//
// 边界：只读字符串。不读事件、不读配置、不读时钟、不发消息、不 import bridge.js。
// 名字与 QQ 号由调用方传入（selfNames / selfQQ），模块里不写死任何人格词表。
//
// 优先级顺序按需求定：@ 我 > 名字 > 关键词 > 提问 > 任意消息。
// 注意这与 bridge 原表的数值不同（原表里 question 80 高于 nameMention 70），
// 也与同目录的 wake-priority.js 不同——那两处把「提问」排得更高。合并调度时
// 必须二选一，不要拿两个模块的数字混着比。
//
// 与 bridge 的一处对齐、一处偏离：
//   · 对齐：短英文/数字关键词走词边界（DS 不命中 ADS / BDSM），同 bridge.js:13609。
//   · 偏离：提问判定不再硬编码「小鲸鱼 / claude / deepseek」这类人格词表，
//     改为「有疑问特征 + 明确冲着‘你’或自己的名字」。词表属于 persona，不该进调度层。

export const spec = Object.freeze({
  name: 'scheduler/triggers',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

/** 刻度只用于比较，数值本身没有外部含义。 */
const PRIORITY = Object.freeze({
  atMention: 90,
  nameMention: 80,
  keyword: 70,
  question: 60,
  anyMessage: 50,
  none: 0
});

/** 疑问特征：问号，或常见的疑问/征询词。 */
const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|哪|谁|是不是|能不能|行不行|会不会|有没有/;
/** 「冲着你说的」：第二人称，或催促式追问（群聊里 @ 不到人时常用）。 */
const ADDRESS_RE = /(你|您)|在不在|回我|理我|说话/;
/** 纯英文/数字的短词要走词边界，否则 DS 会命中 ADS。 */
const SHORT_WORD_RE = /^[a-z0-9]+$/;

/** 大小写策略：默认不敏感（与 bridge 一致）；triggers.caseSensitive === true 时严格匹配。 */
function normalizer(caseSensitive) {
  return caseSensitive ? (s) => String(s ?? '') : (s) => String(s ?? '').toLowerCase();
}

/** 把自己相关的 @ 片段从文本里剔掉，避免「@昵称」被同时算成 @ 和「提到名字」。 */
function stripAtMentions(text, names, qq) {
  let out = text;
  for (const name of names) out = out.split(`@${name}`).join('');
  if (qq) out = out.split(`@${qq}`).join('');
  return out;
}

/** @ 的识别：OneBot 的 CQ 码、@QQ号、@名字 三种写法都算（CQ 码不分大小写）。 */
function matchAt(text, names, qq) {
  const lowered = text.toLowerCase();
  if (qq) {
    if (lowered.includes(`[cq:at,qq=${qq.toLowerCase()}]`)) return `QQ ${qq}`;
    if (text.includes(`@${qq}`)) return `QQ ${qq}`;
  }
  for (const name of names) {
    if (text.includes(`@${name}`)) return name;
  }
  return null;
}

/**
 * 关键词：数组里第一个命中的词；短英文/数字词按词边界比。
 * 传入的已经过 normalizer（小写与否由 caseSensitive 决定），这里不再二次转换。
 */
function matchKeyword(pairs, text) {
  for (const { word, key } of pairs) {
    if (SHORT_WORD_RE.test(key) && key.length <= 4) {
      if (new RegExp(`\\b${key}\\b`).test(text)) return word;
    } else if (text.includes(key)) {
      return word;
    }
  }
  return null;
}

/**
 * @pure 判断一条消息命中了哪些触发。
 *
 * @param {object}   context
 * @param {object}   [context.triggers]   atMention / nameMention / keywords / question / anyMessage / caseSensitive
 * @param {string}   [context.message]    消息纯文本（可含 CQ 码）
 * @param {string[]} [context.selfNames]  自己可能的叫法（昵称、群名片）
 * @param {string}   [context.selfQQ]     自己的 QQ 号
 * @returns {{ hit: boolean, reason: string, priority: number }}
 */
export function matchTriggers(context = {}) {
  const src = context && typeof context === 'object' ? context : {};
  const config = src.triggers && typeof src.triggers === 'object' ? src.triggers : {};

  const raw = typeof src.message === 'string' ? src.message : String(src.message ?? '');
  if (!raw.trim()) return { hit: false, reason: '空消息，不触发任何唤醒', priority: PRIORITY.none };

  const norm = normalizer(config.caseSensitive === true);
  const text = norm(raw);

  const qq = src.selfQQ === undefined || src.selfQQ === null ? '' : String(src.selfQQ).trim();
  const names = (Array.isArray(src.selfNames) ? src.selfNames : [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean)
    .map(norm);

  // 关键词先按同一套大小写策略归一，避免「配置写 DS、正文写 ds」这种半匹配。
  const keywordPairs = (Array.isArray(config.keywords) ? config.keywords : [])
    .map((word) => String(word ?? '').trim())
    .filter(Boolean)
    .map((word) => ({ word, key: norm(word) }));

  const hits = [];

  if (config.atMention !== false) {
    const at = matchAt(text, names, qq);
    if (at) hits.push({ priority: PRIORITY.atMention, reason: `被 @（${at}）` });
  }

  if (config.nameMention !== false && names.length) {
    const probe = stripAtMentions(text, names, qq);
    const name = names.find((n) => probe.includes(n));
    if (name) hits.push({ priority: PRIORITY.nameMention, reason: `提到名字「${name}」` });
  }

  const keyword = matchKeyword(keywordPairs, text);
  if (keyword) hits.push({ priority: PRIORITY.keyword, reason: `关键词命中「${keyword}」` });

  if (config.question !== false && QUESTION_RE.test(text) && ADDRESS_RE.test(text)) {
    hits.push({ priority: PRIORITY.question, reason: '像在追问 AI（疑问 + 指向你）' });
  }

  if (config.anyMessage === true) {
    hits.push({ priority: PRIORITY.anyMessage, reason: '任意消息触发（anyMessage）' });
  }

  if (!hits.length) return { hit: false, reason: '未命中任何触发条件', priority: PRIORITY.none };

  // 取最高；同分时保留先加进来的（at > name > keyword > question > any 的检查顺序）。
  let top = hits[0];
  for (const hit of hits) if (hit.priority > top.priority) top = hit;

  const others = hits.filter((hit) => hit !== top).map((hit) => hit.reason);
  const reason = others.length ? `${top.reason}；同时命中：${others.join('、')}` : top.reason;

  return { hit: true, reason, priority: top.priority };
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx。
 *
 * @param {object} _ctx
 * @param {object} args 同 matchTriggers
 * @returns {{ ok: true, value: { hit: boolean, reason: string, priority: number } }}
 */
export function handle(_ctx, args) {
  return { ok: true, value: matchTriggers(args) };
}
