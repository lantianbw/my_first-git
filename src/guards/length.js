// guards/length — 长度软干预的判定（只决定「拦不拦、说什么」，不改写内容）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/length 行）
// deps：无                      （时间与发送历史由调用方取好后传入）
// 失败策略：fail-open            （纯软干预，最多放宽一次，绝不阻断发送链路）
// 单测：tests/length.test.mjs
//
// 为什么需要：这段判定原来内嵌在 guardOutboundV2 旁边，改阈值要动 1.5 万行的中枢。
// 抽成纯函数后，阈值行为可单测，也不会因为一次改错而打断发送链路。
//
// 边界：只返回判定与可读原因；不读 cfg、不读时钟、不记状态、不发消息、不改写文本。
// 「本轮已拒过一次」由调用方记账后以 usedThisRound 传入，模块自己无状态。

export const spec = Object.freeze({
  name: 'guards/length',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze(['outbound.length']),
  // 阈值属体验参数，只有主人该调；AI 自调等于可以无限刷屏。
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

export const DEFAULTS = Object.freeze({
  maxSingleChars: 40,
  multiThreshold: 12,
  recentWindowMs: 600_000
});

const toList = (messages) => (Array.isArray(messages) ? messages : [messages]).map((m) => String(m ?? ''));

/**
 * @param {object} input
 * @param {string|string[]} input.messages        待发的一条或多条文本
 * @param {number} [input.maxSingleChars=40]      单条上限
 * @param {number} [input.multiThreshold=12]      多条模式下每条的最小长度阈值
 * @param {boolean} [input.sentRecently=false]    窗口期内是否已经发过
 * @param {number} [input.usedThisRound=0]        本轮唤醒内已拒绝过几次
 * @returns {{ok:true} | {ok:false, kind:'single'|'multi', reason:string, length?:number, count?:number, threshold?:number}}
 */
export function evaluateLengthNudge({
  messages,
  maxSingleChars = DEFAULTS.maxSingleChars,
  multiThreshold = DEFAULTS.multiThreshold,
  sentRecently = false,
  usedThisRound = 0
} = {}) {
  const maxSingle = Number(maxSingleChars) > 0 ? Number(maxSingleChars) : DEFAULTS.maxSingleChars;
  const threshold = Number(multiThreshold) > 0 ? Number(multiThreshold) : DEFAULTS.multiThreshold;
  const list = toList(messages);

  for (const msg of list) {
    if (msg.length > maxSingle) {
      return {
        ok: false,
        kind: 'single',
        length: msg.length,
        reason: `outbound guard: 这条 ${msg.length} 字太长了（上限 ${maxSingle} 字），请拆成几条自然的短句或精简后重发`
      };
    }
  }

  if (list.length >= 2 && list.every((m) => m.length > threshold) && sentRecently && Number(usedThisRound) < 1) {
    return {
      ok: false,
      kind: 'multi',
      count: list.length,
      threshold,
      reason: `outbound guard: 本轮建议只发一条短句——10 分钟内已发过且这次每条都超过 ${threshold} 字；请合并成一条短句再发（重试一次仍偏长会放行）`
    };
  }

  return { ok: true };
}
