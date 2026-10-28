// lifecycle/lock — 判定「锁文件里的那个持有者还算不算数」（纯函数，不做系统调用）
//
// 契约：docs/module-contract.md v1.1（A.1 lifecycle/lock / B.1 spec / D 表 lifecycle/lock「fail closed」/ H2 locked）
// deps：now                      （optional：无）
// 失败策略：fail-closed           （依据：D 表 lifecycle/lock「双例会抢消息、互相覆盖会话映射」）
// 单测：tests/lock.test.mjs
//
// 为什么需要：acquireLock()（bridge.js:1365）把三件事焊在一起——读锁文件、探 PID 存活、
// 探控制台端口占用，中间还夹着 process.exit(2)。于是「这个锁到底该不该接管」只能靠真起两个进程
// 去试。这里把判据抽出来：给锁内容、当前时间、自己 PID、以及一个"该 PID 还活着吗"的结论
// （由调用方注入，可内含端口探测），得到该不该接管 + 为什么 + 还要等多久。
//
// 边界：不读文件、不 kill 进程、不探端口、不 exit、不删锁。只做判定。
//
// 与现有实现的差异（重要）：
//   · 现有代码没有"超时"概念：锁只有一个 PID，PID 活着就认为锁有效（再加端口探测兜底）。
//     本模块新增 staleMs 时间维度，用于「PID 被系统回收给别的进程」这类误判。
//     锁内容里没有时间戳时（旧格式只有裸 PID），时间维度不生效，退化为纯 PID 判定。
//   · 现有代码的 EPERM / 端口占用分支属于"探活"细节，由调用方在 pidAlive 里自行吸收；
//     本模块只消费一个布尔结论，不重复实现进程探测。
//   · pidAlive 抛错时**保守拒绝接管**（adopt:false）：宁可让用户手动删锁，
//     也不要冒双实例抢消息的风险 —— 与 consolePortInUse() 探测失败时 return true 同一取舍。

const REASON = Object.freeze({
  EMPTY: 'empty',
  INVALID_PID: 'invalid-pid',
  SELF: 'self',
  PID_DEAD: 'pid-dead',
  STALE: 'stale',
  ALIVE: 'alive',
  PROBE_FAILED: 'probe-failed'
});

export const spec = Object.freeze({
  name: 'lifecycle/lock',
  version: '1.0.0',
  deps: Object.freeze(['now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 把 holder 归一成 { pid, at }：既接受裸 PID（现有锁文件内容），也接受 { pid, at }。 */
function readHolder(holder) {
  if (holder === null || holder === undefined) return { empty: true, pid: null, at: null };

  if (typeof holder === 'object') {
    const rawPid = holder.pid;
    if (rawPid === undefined || rawPid === null || rawPid === '') return { empty: true, pid: null, at: null };
    return { empty: false, pid: Number(rawPid), at: Number.isFinite(holder.at) ? holder.at : null };
  }

  const text = String(holder).trim();
  if (text === '') return { empty: true, pid: null, at: null };
  return { empty: false, pid: Number(text), at: null };
}

/**
 * 判定是否接管锁。
 *
 * @param {object}   input
 * @param {*}        input.holder    锁内容：裸 PID / '12345' / { pid, at } / null
 * @param {number}   input.now       毫秒时间戳（必填，本模块不读系统时钟）
 * @param {number}   [input.staleMs=120000] 多久没刷新即视为过期
 * @param {number}   [input.selfPid] 本进程 PID；相同则直接接管
 * @param {Function} input.pidAlive  (pid) => boolean，由调用方注入（内含端口探测等）
 * @returns {{ adopt: boolean, reason: string, remainingMs: number }}
 */
export function judgeLock({ holder, now, staleMs = 120_000, selfPid, pidAlive } = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('judgeLock: now 必须是毫秒时间戳（由调用方注入，本模块不读系统时钟）');
  }
  if (typeof pidAlive !== 'function') {
    throw new TypeError('judgeLock: 必须注入 pidAlive(pid)（本模块不做系统调用）');
  }
  const window = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 120_000;

  const { empty, pid, at } = readHolder(holder);

  // 1. 空锁：没人持有，直接接管
  if (empty) return { adopt: true, reason: REASON.EMPTY, remainingMs: 0 };

  // 2. 内容不是正整数 PID：现有实现同样按过期锁处理
  if (!Number.isInteger(pid) || pid <= 0) {
    return { adopt: true, reason: REASON.INVALID_PID, remainingMs: 0 };
  }

  // 3. 就是自己：重启流程里自己拿回自己的锁
  if (Number.isFinite(selfPid) && pid === Number(selfPid)) {
    return { adopt: true, reason: REASON.SELF, remainingMs: 0 };
  }

  // 4. 探活。抛错 → 保守拒绝（fail closed），不冒双实例风险
  let alive;
  try {
    alive = Boolean(pidAlive(pid));
  } catch {
    return { adopt: false, reason: REASON.PROBE_FAILED, remainingMs: ageWindow(at, now, window) };
  }
  if (!alive) return { adopt: true, reason: REASON.PID_DEAD, remainingMs: 0 };

  // 5. 活着：再看时间。锁里没有时间戳（旧格式）时时间维度不生效
  if (at === null) {
    return { adopt: false, reason: REASON.ALIVE, remainingMs: window };
  }
  const age = Math.max(0, now - at);
  if (age >= window) return { adopt: true, reason: REASON.STALE, remainingMs: 0 };

  return { adopt: false, reason: REASON.ALIVE, remainingMs: Math.max(0, window - age) };
}

/** 只有"不知道锁龄"或"探活失败"时才用：保守给出整窗等待。 */
function ageWindow(at, now, window) {
  if (at === null) return window;
  return Math.max(0, window - Math.max(0, now - at));
}
