// OneBot（SnowLuma）未就绪时的退避重试策略 —— 纯逻辑，可单测。
//
// 为什么单独成文件：src/bridge.js 一 import 就会起服务，无法被单测 import；而
// 「断开后必须一直重试」是可回归的行为。实测（2026-10-26）：整机重启后桥比 QQ 先起，
// OneBot 的 3000/3001 端口还不存在，healTokenIfStale 打一条「token 自愈失败」后就不再
// 尝试；约 5 分钟后端口恢复监听，桥却一直没重连，最终「活着但完全不收发」持续 6 小时 44 分。
//
// 本文件不 import 任何东西、不碰网络/配置/日志设施：定时器与 log 都由调用方注入。

/** 退避序列（毫秒）：5s → 15s → 60s → 300s，之后固定 300s。 */
export const RETRY_DELAYS_MS = Object.freeze([5000, 15000, 60000, 300000]);

/** 第 n 次失败后应等待的毫秒数（n 从 1 开始；超出序列后固定最后一档，永不放弃）。 */
export function nextDelay(attemptNumber) {
  const n = Math.floor(Number(attemptNumber));
  if (!Number.isFinite(n) || n < 1) return RETRY_DELAYS_MS[0];
  return RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length) - 1];
}

/**
 * 退避计数状态机（不含定时器，由外部驱动）。
 *
 * 为什么需要 `pending` 这个标记：close / error / 重连失败三条路径都会调 fail()，
 * 同一次断线可能连打三枪。没有该标记时，三枪会把次数从 1 冲到 3、等待从 5s 跳到 60s
 * （退避被多路事件打乱）；有了它，只有第一次真正排定等待时次数才 +1，其余调用返回 null。
 */
export function createRetryState() {
  let attempt = 0;
  let pending = false;
  return {
    get attempt() { return attempt; },
    get pending() { return pending; },
    /** 记一次失败：返回 { attempt, delayMs }；已有等待在排时返回 null（不重复计数）。 */
    fail() {
      if (pending) return null;
      pending = true;
      attempt += 1;
      return { attempt, delayMs: nextDelay(attempt) };
    },
    /** 等待到点、开始尝试：清掉「已排定」但保留次数（失败要接着往上退）。 */
    beginAttempt() {
      pending = false;
      return attempt;
    },
    /** 连上了：次数清零，退避回到第一档。 */
    succeed() {
      pending = false;
      attempt = 0;
      return attempt;
    }
  };
}

/**
 * 定时器版调度器：把状态机与 setTimeout 绑起来，到点执行一次 run()。
 * `run` 由调用方提供（通常是「自愈 token + 重连」）；它失败时应再调一次 `fail()`，
 * 没接住抛出的异常也会被这里兜成一次 fail()，保证「永不放弃」。
 */
export function createOnebotRetry({ run, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const state = createRetryState();
  let timer = null;
  let api = null;

  const cancel = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  api = {
    get attempt() { return state.attempt; },
    get pending() { return timer !== null; },
    /** 安排下一次重试：返回本次的 { attempt, delayMs }；已有等待在排时返回 null。 */
    fail() {
      const step = state.fail();
      if (!step) return null;
      // 文案固定；行首的 `[bridge]` 由桥接的 log() 统一加，避免出现两个前缀。
      log(`OneBot 未就绪，${Math.round(step.delayMs / 1000)} 秒后重试（第 ${step.attempt} 次）`);
      timer = setTimer(() => {
        timer = null;
        state.beginAttempt();
        Promise.resolve()
          .then(() => run?.())
          .catch((error) => {
            log(`OneBot 重试异常：${error?.message ?? error}`);
            api.fail();
          });
      }, step.delayMs);
      if (typeof timer?.unref === 'function') timer.unref();
      return step;
    },
    /** 连上了：取消等待、次数清零。 */
    succeed() {
      cancel();
      state.succeed();
    },
    /** 退出/收尾用（进程退出时清掉挂着的定时器）。 */
    cancel
  };
  return api;
}
