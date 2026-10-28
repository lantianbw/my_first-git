// guards/sensitive — 出站敏感信息审计（路径/凭据特征 + 已知会话令牌精确名单）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/sensitive 行）
// deps：无                      （已知令牌名单与「是否审计该会话」由调用方传入）
// 失败策略：fail-closed          （凭据/路径外发不可放行；判定本身是纯字符串比较，不会抛）
// 单测：tests/sensitive.test.mjs
//
// 为什么需要：两道闸门原来分散在 bridge（SENSITIVE_RE 与 KNOWN_AGENT_TOKENS 各一处），
// 抽取后「哪条路径该审计、命中后怎么记账」由中枢决定，规则本身可单测。
//
// 边界：只做判定；不发消息、不读取令牌文件、不记日志、不做脱敏替换。

import { SENSITIVE_RE } from '../sensitive.js';

export const spec = Object.freeze({
  name: 'guards/sensitive',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze(['outbound.sensitive']),
  // 凭据/路径外发是硬拦截，任何人不可关（契约 H2）。
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

const REASON_SENSITIVE = 'outbound guard: 内容疑似包含本机路径或凭据（路径/密钥/口令等），已拦截并记录';
const REASON_TOKEN = 'outbound guard: 内容包含已知会话令牌原文，已拦截并记录';

/**
 * @param {object}   input
 * @param {string}   input.text            待出站文本
 * @param {boolean}  [input.isAuditKey=true] 该会话是否需要审计（由中枢按 key 判定）
 * @param {string[]} [input.knownTokens]   已知会话令牌名单（精确匹配，覆盖裸 32-hex）
 * @returns {{ok:true} | {ok:false, kind:'sensitive'|'token', reason:string, matched?:string}}
 */
export function evaluateSensitive({ text, isAuditKey = true, knownTokens } = {}) {
  const raw = String(text ?? '');
  if (!isAuditKey) return { ok: true };

  if (Array.isArray(knownTokens)) {
    for (const token of knownTokens) {
      const t = String(token ?? '');
      if (t && raw.includes(t)) return { ok: false, kind: 'token', reason: REASON_TOKEN };
    }
  }

  if (SENSITIVE_RE.test(raw)) return { ok: false, kind: 'sensitive', reason: REASON_SENSITIVE };

  return { ok: true };
}
