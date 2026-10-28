// outbound/recheck — 发送前的静默判定与审计范围判定
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 outbound/recheck 行）
// deps：cfg, now               （两个判定都不读它们；ownerQQ / 模式 / 角色状态全部由入参传入，
//                               本文件没有时间判定，now 仅为与 A.8 其余出站模块保持同一能力声明）
// 失败策略：fail-closed         （依据：D 表 `outbound/recheck` 行——复核失败即取消发送；
//                               本模块的判定函数本身不抛，抛错由 handle 转成 INVALID_ARGS 拒绝）
// 单测：tests/outbound-recheck.test.mjs
//
// 为什么需要：这两段判定原来内嵌在 bridge.js 的 `shouldBlockSilentReply(key)` 与
// `shouldAuditKey(key)` 里，前者每次调用都要 `readRoleState()` 读一次 role 状态文件，
// 后者直接读闭包里的 `let currentMode`。想验证「静默模式下 owner 私聊仍可发」只能起桥、
// 改 state 文件、再发一条真消息。搬出来后：状态快照与 ownerQQ 由调用方按当前时刻取好传入，
// 模块只剩「比较」这一件事，可以离线断言。
//
// 边界：不读 cfg / state / 文件 / process.env、不读中枢全局、不写文件、不联网、不打日志、
// 不用 Date.now() / Math.random()、不 import bridge.js、不改写入参、不发消息。
// 「什么时候取快照」「快照过期怎么办」仍归调用方——这里只回答「按这份快照该不该静默/该不该审计」。
//
// 与旧实现逐项对齐（没有新增语义）：
//   · 静默：`roleState.mode === 'silent'` 且 key 不是 owner 私聊规范键 → 拦；
//     owner 私聊键恒为 `private:${String(ownerQQ ?? '')}`，ownerQQ 缺失时退化为 `'private:'`。
//     旧 `readRoleState()` 在文件缺失时给默认 `{ role: null, mode: 'active' }`，故 state 缺失按 active。
//   · 审计：仅 `currentMode === 'closed-agent'` 时对 owner 私聊跳过，其余模式/会话一律审计；
//     currentMode 缺省值是 `'chat'`，即缺失时同样审计。
//   · 两个判定都**不**看 unread / 最近交互 / 静默配置分节——旧实现里它们不参与这两个函数
//     （静默只看角色模式，群友消息的「静默期不投递」在入站侧另有一处判定）。

export const spec = Object.freeze({
  name: 'outbound/recheck',
  version: '1.0.0',
  deps: Object.freeze(['cfg', 'now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：发送前的权限复核与静默闸门，关掉等于静默模式/审计范围失效（契约 H2）
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 全部缺省值，逐项抄自 bridge.js 的 `readRoleState()` / `currentMode` 初值。 */
export const DEFAULTS = Object.freeze({
  roleMode: 'active',   // readRoleState() 文件缺失时的默认 mode
  sessionMode: 'chat'   // `let currentMode = 'chat'`
});

const isObject = (value) => value !== null && typeof value === 'object';

/** options 传 null / 非对象时按空对象处理（旧实现读的是必存在的问题闭包参数）。 */
const optionsOf = (value) => (isObject(value) ? value : {});

/** owner 私聊的规范键：与旧实现 `private:${String(cfg.ownerQQ ?? '')}` 逐字一致（含 ownerQQ 缺失→'private:'）。 */
function ownerPrivateKey(ownerQQ) {
  return `private:${String(ownerQQ ?? '')}`;
}

/**
 * @pure 这条回复是否应被静默（不发送）。
 *
 * 旧 `shouldBlockSilentReply(key)` 的三段合成：
 *   const roleState = readRoleState();
 *   return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
 *
 * @param {object|null|undefined} state 角色/模式快照（同 `readRoleState()` 的返回：`{ role, mode }`）；
 *                                      缺失或非对象按默认 `{ mode: 'active' }`
 * @param {object} [options]
 * @param {string} [options.key]         会话规范键，如 `private:10001` / `group:123`
 * @param {number|string} [options.ownerQQ] 主人 QQ（`cfg.ownerQQ` 原样传入）
 * @returns {boolean} true = 拦下不发
 */
export function shouldBlockSilentReply(state, options = {}) {
  const opts = optionsOf(options);
  const snapshot = isObject(state) ? state : {};
  const mode = snapshot.mode ?? DEFAULTS.roleMode;
  return mode === 'silent' && opts.key !== ownerPrivateKey(opts.ownerQQ);
}

/**
 * @pure 这个会话是否需要写审计。
 *
 * 旧 `shouldAuditKey(key)`：
 *   if (currentMode === 'closed-agent') return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
 *   return true;
 *
 * @param {unknown} key 会话规范键
 * @param {object} [options]
 * @param {string} [options.mode]         当前模式（`currentMode` 原样传入，缺省 `'chat'`）
 * @param {number|string} [options.ownerQQ] 主人 QQ（`cfg.ownerQQ` 原样传入）
 * @returns {boolean} true = 要审计
 */
export function shouldAuditKey(key, options = {}) {
  const opts = optionsOf(options);
  const mode = opts.mode ?? DEFAULTS.sessionMode;
  if (mode === 'closed-agent') return key !== ownerPrivateKey(opts.ownerQQ);
  return true;
}

/**
 * 契约门面（B.1）。
 *
 * args：
 *   `{ action: 'should-block-silent-reply', state, options }`
 *   `{ action: 'should-audit-key', key, options }`
 *
 * 两个判定都是纯比较，不抛错；这里的 try/catch 只兜「活代理/带副作用的 getter 读取时抛错」
 * 这类入参违约——按 D 表 fail-closed 转成拒绝，而不是放行。
 *
 * @param {object} _ctx deps 声明的 cfg / now 本文件都不用
 * @param {object} [args]
 * @returns {{ok:true, value:boolean} | {ok:false, code:'INVALID_ARGS'|'UPSTREAM', error:string}}
 */
export function handle(_ctx, args = {}) {
  const action = String(args?.action ?? '');
  try {
    if (action === 'should-block-silent-reply') {
      return { ok: true, value: shouldBlockSilentReply(args.state, args.options) };
    }
    if (action === 'should-audit-key') {
      return { ok: true, value: shouldAuditKey(args.key, args.options) };
    }
    return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
  } catch (error) {
    return { ok: false, code: 'UPSTREAM', error: `recheck 判定异常：${error?.message ?? error}` };
  }
}
