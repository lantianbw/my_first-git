// guards/outbound-content — 判定出站文本的元信息泄漏与称呼越界，并解析 guard 分节开关
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/outbound-content 行）
// deps：无                      （词表与分节开关由调用方按 cfg 取好后传入，模块不读全局 cfg）
// 失败策略：fail-open            （依据：D 表——词表/正则坏了按「无命中」，绝不阻断发送）
// 单测：tests/outbound-content.test.mjs
//
// 为什么需要：这两段判定原来内嵌在 1.6 万行的 `guardOutboundV2()` 里，改词表要动中枢；
// 分节开关 `guardSectionV2()` / `guardSectionEnabledV2()` 也一直留在中枢顶部，任何模块想读
// `socialV2.guard.<name>` 都得再写一遍「对象看 enabled、布尔看真假、缺失视为开」——三份复制
// 迟早走样（`guards/length` 里已经出现第二份）。搬出来后：开关解析、词表解析、命中判定、
// 「老爹→你」的改写都在这里，中枢只按返回的 kind/word 记账。
//
// 边界：不读 cfg（分节原样传入）、不记日志、不写 activity（只返回 kind/word/reason）、
// 不发消息、不改状态。判定在归一化副本（NFKC + 小写）上做，返回的 text 始终是原文
// （唯一例外是「老爹→你」，那是本条规则要求的确定性改写）。
//
// 与旧实现的差异（有意为之，逐条对应 D 表口径）：
//  1. 分节开关改为「分节对象入参」，不再读全局 `cfg`：`guardSection(guard, name)` 的入参
//     就是 `cfg.socialV2?.guard`，判定语义与 `guardSectionV2(name)` 逐字一致。
//  2. 词表项支持正则：`/.../<flags>` 形式的字符串按正则编译，`RegExp` 实例直接跑；
//     编译失败/执行抛错一律按「无命中」（D 表：词表、正则坏了不能挡住发送）。
//  3. 纯文字词条改为「NFKC 归一 + 小写」后比较：配置写成全角（`ＰＲＯＭＰＴ`）或大小写不一致
//     （`Prompt`）也能命中；旧实现是裸 `includes`，会漏。只补漏、不放宽。
//  4. 入参不可字符串化（toString 抛错）时返回 `{ok:true, degraded:true}` 而非抛出：
//     旧实现会把异常直接抛进发送链路，正是 `bridge.js:193-195` 那类事故的形状。

export const spec = Object.freeze({
  name: 'guards/outbound-content',
  version: '1.1.0', // 新增 guardSection / guardSectionEnabled 与正则词表：按 semver 记 minor
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze(['outbound.content']),
  // 规则本身可以开关，但默认必须开；链执行器是 locked，改不得。
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

/** 模型把内部状态/系统词汇漏到 QQ 时的默认拦词表（cfg 可覆盖）。与旧 `DEFAULT_META_BLOCK_WORDS_V2` 逐项一致。 */
export const DEFAULT_META_BLOCK_WORDS = Object.freeze([
  '⏳', '当前任务运行中', '新消息已排队', '我选择本次不发言', '不能为空',
  '沉默规则', '家规', '权限', '提示词', '系统提示', '已思考（用时'
]);

/** 只有合法 JS 正则标志才把 `/.../x` 当正则，避免把 `24/7` 这类普通词条误编译。 */
const REGEX_WORD_RE = /^\/(.+)\/([dgimsuvy]*)$/;

const isSection = (value) => Boolean(value) && typeof value === 'object';

/**
 * 取一个 guard 分节的原始配置。
 * 旧 `guardSectionV2(name)`：布尔/缺失一律当空对象（分节参数只能从对象里读）。
 * @pure
 * @param {object|undefined} guardCfg `cfg.socialV2?.guard` 原样传入
 * @param {string} name 分节名，如 'meta' / 'address'
 * @returns {object} 分节对象；缺失或写成布尔时为 `{}`
 */
export function guardSection(guardCfg, name) {
  const raw = guardCfg?.[name];
  return isSection(raw) ? raw : {};
}

/**
 * 分节是否启用。旧 `guardSectionEnabledV2(name)` 的三条分支逐字保留：
 * 对象看 `enabled !== false`；布尔看 `!== false`（所以 `0` / `'false'` 都算开）；缺失视为开。
 * @pure
 * @param {object|undefined} guardCfg `cfg.socialV2?.guard` 原样传入
 * @param {string} name 分节名
 * @returns {boolean}
 */
export function guardSectionEnabled(guardCfg, name) {
  const raw = guardCfg?.[name];
  if (isSection(raw)) return raw.enabled !== false;
  return raw !== false;
}

/**
 * 「老爹」出现在句首且紧跟标点/整句很短时，是在把对方叫成老爹（呼语）——
 * 这时替换成「你」语义不通，必须拦下让模型重写。
 * @pure
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeVocativeAddress(text) {
  try {
    const t = String(text ?? '');
    if (!t.startsWith('老爹')) return false;
    const rest = t.slice(2);
    if (!rest || rest.length <= 4) return true;
    return /^[，,。！!？?~～\s]/.test(rest);
  } catch {
    return false; // 入参不可字符串化：按「不是呼语」处理，让后面的改写路径接手
  }
}

/** 归一化：全角转半角（NFKC）+ 小写。只用于比较，不影响返回的原文。 */
function normalizeForMatch(value) {
  const s = String(value ?? '');
  try {
    return s.normalize('NFKC').toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/** 词条 → 正则；不是正则形态返回 null（该走子串比较）。编译抛错由调用方接住。 */
function compileWord(word) {
  if (word instanceof RegExp) return word;
  if (typeof word !== 'string') return null;
  const m = REGEX_WORD_RE.exec(word);
  return m ? new RegExp(m[1], m[2]) : null;
}

/**
 * 单条词条是否命中。词条可以是纯文字（归一化后子串比较）或正则（`/.../flags` 字符串、RegExp 实例）。
 * 任何异常（坏正则、会抛错的 RegExp 子类、奇怪的词条对象）一律按「无命中」返回 false —— fail open。
 * @pure
 * @param {unknown} text 待判定文本
 * @param {string|RegExp} word 词条
 * @returns {boolean}
 */
export function matchMetaWord(text, word) {
  let raw;
  try {
    raw = String(text ?? '');
  } catch {
    return false;
  }
  try {
    const pattern = compileWord(word);
    if (pattern) {
      // 带 g/y 的正则带 lastIndex 状态，连跑两遍会把第二次判成不命中；进出各复位一次。
      const stateful = pattern.global || pattern.sticky;
      if (stateful) pattern.lastIndex = 0;
      const hit = pattern.test(raw);
      if (stateful) pattern.lastIndex = 0;
      return hit === true;
    }
  } catch {
    return false; // 正则坏了按「无命中」
  }
  const needle = normalizeForMatch(word);
  if (!needle) return false;
  return normalizeForMatch(raw).includes(needle);
}

/** 解析词表：非数组/空数组 → 默认词表；逐项过滤空串，坏词条跳过（跳过即「无命中」）。 */
function resolveMetaWords(words) {
  if (!Array.isArray(words) || words.length === 0) return DEFAULT_META_BLOCK_WORDS;
  const list = [];
  for (const word of words) {
    if (word instanceof RegExp) {
      list.push(word);
      continue;
    }
    try {
      const s = typeof word === 'string' ? word : String(word ?? '');
      if (s) list.push(s);
    } catch {
      // 词条自己 toString 抛错：丢掉这一条，其余词条照常判定
    }
  }
  // 复刻现状：词表里全是空串时 list 为空 = 关掉元信息过滤（旧实现 filter(Boolean) 后同样不命中）。
  return list;
}

const messageOf = (error) => {
  try {
    return String(error?.message ?? error);
  } catch {
    return 'unknown';
  }
};

/**
 * 判定一条待出站文本。
 *
 * 开关与词表的来源优先级：显式参数 > `guard` 分节 > 默认值。所以中枢既可以像现在这样逐项传
 * `metaEnabled` / `words` / `addressEnabled`（行为完全不变），也可以只传 `guard`，由本模块
 * 自己按 `cfg.socialV2.guard.meta` / `.address` 解析开关与词表。
 *
 * @param {object} [options]
 * @param {unknown}  [options.text]            待出站文本（任何可字符串化的值）
 * @param {object}   [options.guard]           `cfg.socialV2?.guard` 原样传入
 * @param {boolean}  [options.metaEnabled]     元信息过滤开关（显式传入时优先于分节）
 * @param {Array<string|RegExp>} [options.words] 自定义拦词表（显式传入时优先于分节；空数组走默认）
 * @param {boolean}  [options.addressEnabled]  称呼越界开关（显式传入时优先于分节）
 * @param {boolean}  [options.isOwnerPrivate=false] 是否 owner 私聊
 * @param {boolean}  [options.isGroup=false]   是否群聊（群友知道她有个爹）
 * @returns {{ok:true, text:string, replaced?:true, degraded?:true, error?:string}
 *          |{ok:false, kind:'meta'|'address'|'vocative', reason:string, word?:string}}
 */
export function evaluateContent(options = {}) {
  let raw;
  try {
    raw = options?.text === undefined || options?.text === null ? '' : String(options.text);
  } catch (error) {
    // 连 toString 都坏了的入参：判定不了，但绝不打断出站（fail open）
    return { ok: true, text: '', degraded: true, error: messageOf(error) };
  }

  try {
    const guard = options?.guard;
    const metaOn = options?.metaEnabled === undefined
      ? guardSectionEnabled(guard, 'meta')
      : Boolean(options.metaEnabled);
    const addressOn = options?.addressEnabled === undefined
      ? guardSectionEnabled(guard, 'address')
      : Boolean(options.addressEnabled);
    const isOwnerPrivate = options?.isOwnerPrivate === true;
    const isGroup = options?.isGroup === true;

    if (metaOn) {
      const words = options?.words === undefined ? guardSection(guard, 'meta').words : options.words;
      for (const word of resolveMetaWords(words)) {
        if (!matchMetaWord(raw, word)) continue;
        const shown = String(word);
        return {
          ok: false,
          kind: 'meta',
          word: shown,
          reason: `outbound guard: 元信息泄漏（含「${shown}」）——这是内部状态/系统词汇，不要发出去，请换成人话重写后再发`
        };
      }
    }

    if (addressOn && raw) {
      if (raw.includes('饲养员')) {
        return {
          ok: false,
          kind: 'address',
          reason: 'outbound guard: 称呼越界——「饲养员」是主会话的称呼，不该出现在 QQ 消息里，请重写'
        };
      }
      if (raw.includes('老爹') && !isOwnerPrivate && !isGroup) {
        if (looksLikeVocativeAddress(raw)) {
          return {
            ok: false,
            kind: 'vocative',
            reason: 'outbound guard: 称呼越界——这句里的「老爹」是在称呼对方，请改用对这位联系人的合适称呼后重发'
          };
        }
        return { ok: true, text: raw.split('老爹').join('你'), replaced: true };
      }
    }

    return { ok: true, text: raw };
  } catch (error) {
    // 判定本身出了意料之外的错：放行并标记 degraded，由调用方决定是否记账
    return { ok: true, text: raw, degraded: true, error: messageOf(error) };
  }
}
