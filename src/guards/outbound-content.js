// guards/outbound-content — 元信息泄漏与称呼越界的判定
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/outbound-content 行）
// deps：无                      （词表与开关由调用方按 cfg 取好后传入）
// 失败策略：fail-open            （判定本身纯字符串比较；坏了按「无命中」放行，绝不阻断发送）
// 单测：tests/outbound-content.test.mjs
//
// 为什么需要：这两段判定原来内嵌在 1.5 万行的 guardOutboundV2 里，改词表要动中枢；
// 「老爹」的替换语义（呼语拦截 vs 改写成「你」）也只有在拆分后才看得清。
//
// 边界：只做判定与一处确定性改写（「老爹」→「你」）；不读 cfg、不记日志、不发消息。
// 记账（appendActivity）由调用方按返回的 kind/word 自行完成。

export const spec = Object.freeze({
  name: 'guards/outbound-content',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze(['outbound.content']),
  // 规则本身可以开关，但默认必须开；链执行器是 locked，改不得。
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

/** 模型把内部状态/系统词汇漏到 QQ 时的默认拦词表（cfg 可覆盖）。 */
export const DEFAULT_META_BLOCK_WORDS = Object.freeze([
  '⏳', '当前任务运行中', '新消息已排队', '我选择本次不发言', '不能为空',
  '沉默规则', '家规', '权限', '提示词', '系统提示', '已思考（用时'
]);

/**
 * 「老爹」出现在句首且紧跟标点/整句很短时，是在把对方叫成老爹（呼语）——
 * 这时替换成「你」语义不通，必须拦下让模型重写。
 */
export function looksLikeVocativeAddress(text) {
  const t = String(text ?? '');
  if (!t.startsWith('老爹')) return false;
  const rest = t.slice(2);
  if (!rest || rest.length <= 4) return true;
  return /^[，,。！!？?~～\s]/.test(rest);
}

/**
 * @param {object} input
 * @param {string}  input.text             待出站文本
 * @param {boolean} input.metaEnabled      元信息过滤开关
 * @param {string[]} [input.words]         自定义拦词表（空则用默认）
 * @param {boolean} input.addressEnabled   称呼越界开关
 * @param {boolean} input.isOwnerPrivate   是否 owner 私聊
 * @param {boolean} input.isGroup          是否群聊（群友知道她有个爹）
 * @returns {{ok:true, text:string, replaced?:true} | {ok:false, kind:'meta'|'address'|'vocative', reason:string, word?:string}}
 */
export function evaluateContent({
  text,
  metaEnabled = true,
  words,
  addressEnabled = true,
  isOwnerPrivate = false,
  isGroup = false
} = {}) {
  const raw = String(text ?? '');

  if (metaEnabled) {
    const list = Array.isArray(words) && words.length
      ? words.map(String).filter(Boolean)
      : DEFAULT_META_BLOCK_WORDS;
    for (const w of list) {
      if (w && raw.includes(w)) {
        return {
          ok: false,
          kind: 'meta',
          word: w,
          reason: `outbound guard: 元信息泄漏（含「${w}」）——这是内部状态/系统词汇，不要发出去，请换成人话重写后再发`
        };
      }
    }
  }

  if (addressEnabled && raw) {
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
}
