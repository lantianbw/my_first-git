// session/lifecycle — 会话生命周期里的两条纯判定：还是不是当前会话、该不该轮换
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 session/lifecycle 行）
// deps：无                    （optional：无；时间戳、阈值、策略全部由调用方传入）
// 失败策略：fail-open          （依据：D 表 session/lifecycle「退役/重建失败只是多留一个旧会话」；
//                              入参不全时不抛错：轮换侧判"不换"，判定侧判"不是当前会话"，
//                              代价都是多建/多留一个会话，绝不阻断收发）
// 单测：tests/session-lifecycle.test.mjs
// 导出 @pure：isCurrentSession / shouldRotate（后者直接复用 session/expiry，无第二份实现）
// args：{ action: 'current-session' | 'rotate', ...判定入参 }
//
// 为什么需要：`isCurrentSession()`（bridge.js:3295）决定"这条投递还能不能落到这个会话"，
// 误判 true 会把消息投给已经换了 preset / 被移出白名单的旧会话，误判 false 会白白丢掉上下文；
// `shouldRotateSession()`（bridge.js:10912）决定"主人私聊要不要换新会话"，三闸（开关 / owner /
// 年龄 / 空闲）任何一闸写反都会造成天天换会话或永不换会话。两者原来都嵌在中枢闭包里，
// 判定与簿记（写 sessionMeta、清 6 个内存 Map、停 DSH 会话）缠在一起，只能整体起桥验证。
// 这里只搬判定：同样的入参给同样的答案，可离线断言边界值。
//
// 边界：只判定。**不搬簿记**——retireSession / reconcileSessionPolicies / stopRetiredSessionWork
// 一律留在中枢：它们跨 state 与 6 个内存 Map（reverse / collectors / sessionModels /
// modelAppliedSessions / pending / socialV2.conversations），还要停 DSH 在途 turn、轮换 agentToken，
// 属于"唯一持有状态的中枢"职责。本模块不读 state、不写 state、不读 cfg、不读时钟、不发消息、
// 不打日志、不 import bridge.js。
//
// 与中枢原实现的三处刻意差异：
//   1. 空闲边界：中枢是 `now - lastIncomingAt > 10min`（严格大于），本模块经 session/expiry
//      用 `>=`——正好到点即可轮换，省掉一个 tick 的等待。此差异由 session/expiry 头注释声明。
//   2. 会话 id：中枢 `state.sessions[key] === sessionId` 在两边都是 undefined 时会判成"同一个"；
//      这里要求两边都是**非空字符串**。缺 id 说明映射已经坏了，判 false 让调用方退役重建，
//      比"两个 undefined 相等"安全。
//   3. 策略比较：中枢直接比两个 JSON 字符串，缺一边就是 undefined !== "..."，靠类型意外得到 false；
//      这里显式把"缺失/空串/不可序列化"当作不匹配，并把数组形态也接受（按序列化比）。

import { shouldRotate } from './expiry.js';

export { shouldRotate };

export const spec = Object.freeze({
  name: 'session/lifecycle',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // 会话退役与 token 撤销绑定（H2）：关掉会留下高权限旧会话，故 locked。
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/**
 * 策略序列化口径：字符串原样（中枢 `sessionPolicy()` 就是 JSON 字符串），
 * 其他对象按 JSON 序列化；缺失 / 空串 / 序列化失败一律 null（= 不匹配）。
 * @param {unknown} policy
 * @returns {string|null}
 */
function policyKey(policy) {
  if (typeof policy === 'string') return policy ? policy : null;
  if (policy && typeof policy === 'object') {
    try {
      return JSON.stringify(policy);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @pure 这个会话映射是否仍是"当前"的：准入允许 + id 对得上 + 策略没变。
 *
 * 三处任一不满足即 false —— 调用方据此退役旧映射并重建，绝不复用不确定的会话。
 *
 * @param {object} [input]
 * @param {boolean} input.allowed 当前模式/白名单是否允许该 key（中枢 modeAllowed 的结果）
 * @param {string} input.mappedSessionId state.sessions[key] 里记的会话 id
 * @param {string} input.sessionId 调用方手上的会话 id
 * @param {string|object} input.storedPolicy state.sessionPolicies[key]（中枢存的策略串）
 * @param {string|object} input.currentPolicy 现算的策略（中枢 sessionPolicy(key)）
 * @returns {boolean}
 */
export function isCurrentSession(input = {}) {
  const {
    allowed,
    mappedSessionId,
    sessionId,
    storedPolicy,
    currentPolicy
  } = input ?? {};

  // 准入优先：白名单/模式不放行时，映射再"对"也不能投递。
  if (allowed !== true) return false;

  if (typeof mappedSessionId !== 'string' || typeof sessionId !== 'string') return false;
  if (!mappedSessionId || !sessionId) return false;
  if (mappedSessionId !== sessionId) return false;

  const stored = policyKey(storedPolicy);
  const current = policyKey(currentPolicy);
  if (stored === null || current === null) return false;
  return stored === current;
}

/**
 * 契约门面。action 必须显式给出：这是 locked 的会话判定，
 * 少一个字段就默认执行，等于让调用方的笔误直接退役会话。
 *
 * @param {object} [_ctx] 本模块不读任何 ctx 字段（deps 为空）
 * @param {object} [args]
 * @param {'current-session'|'rotate'} args.action
 * @returns {{ok: true, value: boolean|object} | {ok: false, code: string, error: string}}
 */
export function handle(_ctx, args = {}) {
  const input = args && typeof args === 'object' ? args : {};
  const action = String(input.action ?? '');
  try {
    if (action === 'current-session') return { ok: true, value: isCurrentSession(input) };
    if (action === 'rotate') return { ok: true, value: shouldRotate(input) };
    return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action || '(空)'}` };
  } catch (error) {
    // 判定函数本身不抛（入参异常已各自降级），这里只兜住极端输入，
    // 回 ok:false 让调用方按"不轮换 / 不复用"处理，而不是打断收发。
    return { ok: false, code: 'INVALID_ARGS', error: error?.message ?? String(error) };
  }
}
