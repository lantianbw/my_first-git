// guards/chain — 执行守卫链并隔离单项失败（失败计数 → 熔断 → 半开试探）
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 guards/chain 行 / H2 `guards/chain`=locked /
//       A.7 Q4·Q12：runGuard(name, fn, fallback, policy)，熔断 5 分钟后半开试探一次）
// deps：log, now                （optional：无）
// 失败策略：fail-open（默认）/ `policy:'closed'` 项 fail-closed
// 单测：tests/chain.test.mjs
//
// 为什么需要：出站链路上挂着十几个校验（词表、长度、敏感词、打分……），任一校验自己抛错
// 都会把整条发送链路打断——2026-10-26 线上就是反 AI 味词库的作用域错误 throw 到
// sendToQQ 外层，导致「活着但发不出消息」。所以每个校验必须被单独包起来：失败只跳过这一项、
// 记一条 warn，连续失败到阈值就熔断，让后续 5 分钟直接走 fallback 而不是每条消息都白等一次超时。
//
// 边界：不实现任何具体校验规则（词表/正则/阈值都不在这里）、不发消息、不写 state、不联网、
// 不读真实时钟（时间一律由调用方以 now 注入）；只负责「调不调、失败了算不算数、什么时候停止调用」。
//
// 状态机：closed ──失败达 tripAfter──▶ open ──满 halfOpenMs──▶ half-open
//   half-open 只放行一次试探：成功 → closed（计数清零）；失败 → open 并以该次失败重新计时。

const DEFAULT_TRIP_AFTER = 5;
const DEFAULT_HALF_OPEN_MS = 300_000; // Q12：5 分钟

export const spec = Object.freeze({
  name: 'guards/chain',
  version: '1.0.0',
  deps: Object.freeze(['log', 'now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // 嵌套也冻结：H5 规则 3 要求 level 永远来自代码，运行期不得被改写
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 从任意抛出物里取出可读说明（Error / 字符串 / 其它）。 */
function messageOf(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

/**
 * 创建一个守卫链执行器。
 *
 * @param {object}   opts
 * @param {Function} opts.log    必填，ctx.log 同签名 (level, msg, meta?)
 * @param {Function} opts.now    必填，单调毫秒时钟，测试注入假时钟
 * @param {number}   [opts.tripAfter=5]      连续失败多少次后熔断
 * @param {number}   [opts.halfOpenMs=300000] 熔断多久后允许一次半开试探
 * @returns {{ run: Function, status: Function, isTripped: Function }}
 */
export function createChain({ log, now, tripAfter = DEFAULT_TRIP_AFTER, halfOpenMs = DEFAULT_HALF_OPEN_MS } = {}) {
  if (typeof log !== 'function') throw new TypeError('createChain: 缺少必需依赖 log(level, msg, meta?)');
  if (typeof now !== 'function') throw new TypeError('createChain: 缺少必需依赖 now()');
  if (!Number.isInteger(tripAfter) || tripAfter < 1) throw new TypeError('createChain: tripAfter 必须是 >= 1 的整数');
  if (typeof halfOpenMs !== 'number' || !Number.isFinite(halfOpenMs) || halfOpenMs < 0) {
    throw new TypeError('createChain: halfOpenMs 必须是 >= 0 的有限数字');
  }

  /** 每个 name 一份独立状态；name 之间互不影响（单项失败不连坐）。 */
  const states = new Map();

  const blank = () => ({
    failures: 0,
    trips: 0,
    tripped: false,
    trippedAt: null,
    probing: false,
    lastFailureAt: null,
    lastError: null
  });

  const stateOf = (name) => {
    let st = states.get(name);
    if (!st) {
      st = blank();
      states.set(name, st);
    }
    return st;
  };

  // 只读查询不为未知 name 建槽
  const peek = (name) => states.get(name);

  // fail-open 时静默降级到 fallback；fail-closed 时把「被拒绝」显式回传
  const degrade = (strict, reason, fallback) => (strict ? { blocked: true, reason } : fallback);

  /**
   * 执行一次受保护调用。
   * @param {string}   name     守卫名（计数与熔断按 name 隔离）
   * @param {Function} fn       被保护的同步函数
   * @param {*}        fallback 降级返回值
   * @param {'open'|'closed'} [policy] 默认 fail-open
   */
  function run(name, fn, fallback, policy) {
    if (typeof name !== 'string' || name === '') throw new TypeError('run: name 必须是非空字符串');
    if (typeof fn !== 'function') throw new TypeError('run: fn 必须是函数');

    const strict = policy === 'closed';
    const st = stateOf(name);

    if (st.tripped) {
      const elapsed = now() - st.trippedAt;

      // 熔断窗口内：直接拒绝，绝不触碰 fn
      if (elapsed < halfOpenMs) {
        log('warn', `[guards/chain] ${name} 熔断中，跳过`, {
          name,
          elapsedMs: elapsed,
          retryInMs: halfOpenMs - elapsed
        });
        return degrade(strict, 'circuit-open', fallback);
      }

      // 半开窗口已有试探在跑：避免并发穿透（同步 fn 下主要防重入）
      if (st.probing) {
        log('warn', `[guards/chain] ${name} 半开试探进行中，跳过并发调用`, { name });
        return degrade(strict, 'probe-in-flight', fallback);
      }

      st.probing = true;
      log('info', `[guards/chain] ${name} 熔断已满 ${halfOpenMs}ms，半开试探一次`, { name });
      try {
        const value = fn();
        st.failures = 0;
        st.tripped = false;
        st.trippedAt = null;
        st.lastError = null;
        log('info', `[guards/chain] ${name} 半开试探成功，解除熔断`, { name });
        return value;
      } catch (err) {
        st.failures += 1;
        st.trippedAt = now(); // 以本次失败重新计时
        st.lastFailureAt = st.trippedAt;
        st.lastError = err;
        log('warn', `[guards/chain] ${name} 半开试探失败，重新计时 ${halfOpenMs}ms`, {
          name,
          failures: st.failures,
          error: messageOf(err)
        });
        return degrade(strict, `exec-error: ${messageOf(err)}`, fallback);
      } finally {
        st.probing = false;
      }
    }

    try {
      const value = fn();
      if (st.failures > 0 || st.lastError) {
        log('info', `[guards/chain] ${name} 恢复，失败计数清零`, { name, clearedFailures: st.failures });
      }
      st.failures = 0;
      st.lastError = null;
      return value;
    } catch (err) {
      st.failures += 1;
      st.lastFailureAt = now();
      st.lastError = err;
      log('warn', `[guards/chain] ${name} 失败（${st.failures}/${tripAfter}），跳过`, {
        name,
        failures: st.failures,
        tripAfter,
        error: messageOf(err)
      });

      if (st.failures >= tripAfter) {
        st.tripped = true;
        st.trippedAt = now();
        st.trips += 1;
        log('warn', `[guards/chain] ${name} 连续失败 ${st.failures} 次，熔断 ${halfOpenMs}ms`, {
          name,
          tripAfter,
          halfOpenMs
        });
      }

      return degrade(strict, `exec-error: ${messageOf(err)}`, fallback);
    }
  }

  /**
   * 只读快照，不改任何状态。
   * state：'closed' | 'open'（熔断窗口内）| 'half-open'（窗口已满，等待/进行试探）
   */
  function status(name) {
    const st = peek(name) || blank();
    const elapsed = st.tripped ? Math.max(0, now() - st.trippedAt) : 0;
    const halfOpen = st.tripped && elapsed >= halfOpenMs;
    return {
      name,
      state: !st.tripped ? 'closed' : halfOpen ? 'half-open' : 'open',
      tripped: st.tripped,
      halfOpen,
      probing: st.probing,
      failures: st.failures,
      trips: st.trips,
      retryInMs: st.tripped ? Math.max(0, halfOpenMs - elapsed) : 0,
      lastFailureAt: st.lastFailureAt,
      lastError: st.lastError ? messageOf(st.lastError) : null
    };
  }

  /** 熔断是否尚未解除（半开、试探中仍为 true；只有试探成功才回到 false）。 */
  function isTripped(name) {
    const st = peek(name);
    return Boolean(st && st.tripped);
  }

  return { run, status, isTripped };
}
