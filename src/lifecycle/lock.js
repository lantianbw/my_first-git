// lifecycle/lock — 判定单实例锁该新建、该沿用、该接管还是该放弃（纯决策）
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：log, now                （optional：none）
// 失败策略：fail-closed          （依据：D 表 `lifecycle/lock` 行——双例会抢消息、互相覆盖会话映射）
// 单测：tests/lock.test.mjs
//
// 为什么需要：`acquireLock()`（bridge.js）把四件事焊在一个函数里——原子建锁（`flag:'wx'`）、
// 读锁内容、探 PID 存活（还夹一道控制台端口探测）、然后 `process.exit(2)`。于是
// 「这个锁到底该不该接管」只能靠真起两个进程去试，四条分支（空锁 / 非法 PID / 进程已死 /
// 进程仍活）没有一条能离线断言。抽出来后中枢只剩 IO（建锁、删锁、端口探测、退出），判定全在这里。
//
// 边界：不读写文件、不 `process.kill`、不探端口、不 exit、不读 cfg / state / process.env、
// 不写文件、不打日志（不 console.log）、不联网、不用 Date.now()（时间由 now 注入）、不 import 项目内其它文件。
//
// 与 bridge.js 原实现的对应关系（逐条对齐，不新增语义）：
//   · 锁文件不存在（旧 tryCreate 直接成功）            → create   / 'no-lock'
//   · 内容为空（旧注释称"旧版本遗留"，按过期锁处理）    → takeover / 'empty'
//   · 内容不是正整数 PID（旧 `!Number.isInteger(pid) || pid <= 0`）→ takeover / 'invalid-pid'
//   · 锁里的 PID 就是自己                              → reuse    / 'self'
//   · 该 PID 仍存活（旧 `process.kill(pid,0)` 成功且控制台端口被占）→ refuse / 'alive'（旧 exit 2）
//   · 该 PID 已死（旧 ESRCH，或 kill 成功但端口空闲判陈旧）→ takeover / 'pid-dead'（旧 unlink 后重建）
//   · 探活抛错 / 返回非布尔（旧"其它错误"分支）          → refuse   / 'probe-failed'（旧 exit 2）
//
// 两处必须说清的对应（照抄旧行为，不发明新语义）：
//   1. 时间维度（now + staleMs）是旧实现**没有**的：旧锁文件只存裸 PID，锁龄无从得知。
//      所以时间过期只影响 reason，不影响 action——"进程仍活"依旧 refuse（reason='alive-stale'），
//      与旧实现 exit(2) 一致；只有进程已死时才把 reason 记成 'stale'（action 仍是 takeover）。
//      锁内容带 `at` 时才算锁龄；旧格式（裸 PID）时间维度不生效。
//   2. 旧实现对"锁里就是自己"会先 unlink 再重建（启动期控制台端口必然空闲 → 判为陈旧锁），
//      最终状态等同于自己继续持有；这里给 reuse，中枢可跳过删/建两步。
//
// 接线时中枢仍要做的事（都留在 bridge.js）：读锁文件（读失败 → 旧实现 exit 1，本模块不管）、
// 端口探测（结论并进 aliveCheck）、takeover 时的 unlink + 'wx' 重建（重建再撞 EEXIST 说明真撞上
// 双实例，仍按 refuse / exit 2 处理）、以及只在 create / takeover 时才写盘。

export const spec = Object.freeze({
  name: 'lifecycle/lock',
  version: '1.0.0',
  deps: Object.freeze(['log', 'now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：单实例保护；关掉 = 双实例抢消息（契约 H2）
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/**
 * 默认过期窗口。旧实现没有时间维度，本默认值只在调用方显式传 staleMs 时才有意义；
 * 又因为"进程仍活"不会被时间推翻，这个值不会改变接管结论，只用于把锁老化写进 reason。
 */
export const DEFAULT_STALE_MS = 120_000;

/**
 * 把锁内容归一成 { present, emptyContent, pid, at }。
 *
 * 接受：undefined / null（没有锁文件）、裸文本（旧格式，`'12345'` / `'  '`）、
 * 数字、以及 `{ pid, at }`（at = 锁文件 mtime，可选）。对象缺 pid 视为空内容。
 */
function readLock(info) {
  if (info === undefined || info === null) {
    return { present: false, emptyContent: false, pid: null, at: null };
  }
  if (typeof info === 'object') {
    const rawPid = info.pid;
    if (rawPid === undefined || rawPid === null || rawPid === '') {
      return { present: true, emptyContent: true, pid: null, at: null };
    }
    const at = Number(info.at);
    return {
      present: true,
      emptyContent: false,
      pid: Number(rawPid),
      at: Number.isFinite(at) && info.at !== null && info.at !== '' ? at : null
    };
  }
  const text = String(info).trim();
  if (text === '') return { present: true, emptyContent: true, pid: null, at: null };
  return { present: true, emptyContent: false, pid: Number(text), at: null };
}

/**
 * @pure 锁是否已经超过 staleMs 未刷新。
 *
 * 旧格式（裸 PID，没有 `at`）一律返回 false——时间维度不生效，判定退化为纯 PID 判定。
 * 边界取"大于等于"：`now - at === staleMs` 算过期（与旧实现"判陈旧即接管"的取舍一致）。
 * 时间戳在将来（时钟回拨）不算过期。
 *
 * @param {*} info 锁内容（同 decideLock 的 info）
 * @param {number} now 毫秒时间戳（必填，本模块不读系统时钟）
 * @param {number} [staleMs=DEFAULT_STALE_MS] 过期窗口；非正数 / 非有限值回落默认
 * @returns {boolean}
 */
export function isStale(info, now, staleMs = DEFAULT_STALE_MS) {
  if (!Number.isFinite(now)) {
    throw new TypeError('isStale: now 必须是毫秒时间戳（由中枢注入 ctx.now()，本模块不读系统时钟）');
  }
  const lock = readLock(info);
  if (lock.at === null) return false;
  const window = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : DEFAULT_STALE_MS;
  return now - lock.at >= window;
}

/**
 * @pure 单实例锁的决策：给定锁文件内容与「该 pid 是否存活」的结论，返回该做什么。
 *
 * @param {object} input
 * @param {*}      input.info      锁内容：undefined / null（无锁文件）、`'12345'`、`{ pid, at }`
 * @param {number} input.now       毫秒时间戳（必填）
 * @param {Function|boolean} input.aliveCheck 「该 pid 是否存活」的结论，或 `(pid) => boolean`
 *                                 由中枢注入（可内含"kill 成功但端口空闲 → 不算存活"这层探测）。
 *                                 只在需要"这个 PID 还活着吗"的分支（锁存在且内容合法、又不是自己）才必填；
 *                                 无锁 / 空锁 / 非法内容 / 自己这四条分支与旧实现一样，从不探活。
 * @param {number} [input.pid]     本进程 PID；与锁内 PID 相同则 reuse（不探活）
 * @param {number} [input.staleMs=DEFAULT_STALE_MS] 过期窗口（只影响 reason，见文件头）
 * @returns {{action:'create'|'reuse'|'takeover'|'refuse', reason:string}}
 */
export function decideLock({ pid, info, aliveCheck, now, staleMs } = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('decideLock: now 必须是毫秒时间戳（由中枢注入 ctx.now()，本模块不读系统时钟）');
  }

  const lock = readLock(info);
  // 1. 没有锁文件：旧实现第一把 'wx' 建锁即成功
  if (!lock.present) return { action: 'create', reason: 'no-lock' };
  // 2. 空内容：旧实现按过期锁处理（unlink 后重建）
  if (lock.emptyContent) return { action: 'takeover', reason: 'empty' };
  // 3. 内容不是正整数 PID：同上，旧实现也按过期锁处理
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return { action: 'takeover', reason: 'invalid-pid' };
  // 4. 就是自己：旧实现删掉重建，结果等同于自己继续持有
  if (Number.isFinite(pid) && Number(pid) === lock.pid) return { action: 'reuse', reason: 'self' };

  // 5. 探活（只有走到这里才需要）。抛错或给不出布尔结论 → 保守拒绝接管（旧"其它错误"分支 exit 2）
  if (typeof aliveCheck !== 'function' && typeof aliveCheck !== 'boolean') {
    throw new TypeError('decideLock: 必须注入 aliveCheck(pid) 或布尔结论（本模块不做进程探测）');
  }
  let alive;
  try {
    alive = typeof aliveCheck === 'function' ? aliveCheck(lock.pid) : aliveCheck;
  } catch {
    return { action: 'refuse', reason: 'probe-failed' };
  }
  if (typeof alive !== 'boolean') return { action: 'refuse', reason: 'probe-failed' };

  const stale = isStale(lock, now, staleMs);
  // 6. 已死：接管（旧 ESRCH / 端口空闲 → 过期锁）
  if (!alive) return { action: 'takeover', reason: stale ? 'stale' : 'pid-dead' };
  // 7. 仍活：放弃（旧 exit 2）。时间过期不改结论，只把锁老化记进 reason
  return { action: 'refuse', reason: stale ? 'alive-stale' : 'alive' };
}

/** 取 now：优先调用方显式传入，其次 ctx.now（deps 声明的能力）。 */
function nowOf(ctx, args) {
  if (Number.isFinite(args?.now)) return args.now;
  return typeof ctx?.now === 'function' ? ctx.now() : undefined;
}

/**
 * 契约门面。
 *
 * args：`{ action:'decide', info, aliveCheck, pid, now?, staleMs? }` /
 *       `{ action:'is-stale', info, now?, staleMs? }`；action 缺省为 'decide'。
 * 参数违约（缺 now、缺 aliveCheck、未知 action）返回 `INVALID_ARGS`，不吞原因。
 *
 * @param {object} ctx deps 声明的 log 本文件不用；now 用于补默认时间
 * @param {object} [args]
 * @returns {{ok:true, value:*}|{ok:false, code:string, error:string}}
 */
export function handle(ctx, args = {}) {
  const action = String(args?.action ?? 'decide');
  if (action !== 'decide' && action !== 'is-stale') {
    return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
  }
  try {
    const now = nowOf(ctx, args);
    if (action === 'is-stale') return { ok: true, value: isStale(args.info, now, args.staleMs) };
    return {
      ok: true,
      value: decideLock({
        pid: args.pid,
        info: args.info,
        aliveCheck: args.aliveCheck,
        now,
        staleMs: args.staleMs
      })
    };
  } catch (error) {
    return { ok: false, code: 'INVALID_ARGS', error: `锁判定失败：${error?.message ?? error}` };
  }
}
