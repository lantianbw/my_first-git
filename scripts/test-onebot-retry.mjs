// 回归：OneBot 未就绪时必须一直退避重试（2026-10-26 实测「活着但完全不收发 6h44m」）。
//
// 只测纯逻辑（src/onebot-retry.js）：bridge.js 一 import 就会起服务，不能进单测。
// 用假计时器驱动状态机，断言退避序列、计数清零，以及多路 close/error 连打不会跳档。

import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDelay, createRetryState, createOnebotRetry, RETRY_DELAYS_MS } from '../src/onebot-retry.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    advance(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms <= ms) {
          timers.delete(id);
          t.fn();
        }
      }
    }
  };
}

test('退避序列：5s / 15s / 60s / 300s，之后固定 300s', () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [5000, 15000, 60000, 300000]);
  assert.equal(nextDelay(1), 5000);
  assert.equal(nextDelay(2), 15000);
  assert.equal(nextDelay(3), 60000);
  assert.equal(nextDelay(4), 300000);
  assert.equal(nextDelay(5), 300000);
  assert.equal(nextDelay(7), 300000);
  assert.equal(nextDelay(99), 300000);
  // 非法输入退回第一档，而不是返回 NaN 让定时器立刻空转。
  assert.equal(nextDelay(0), 5000);
  assert.equal(nextDelay(undefined), 5000);
  assert.equal(nextDelay('abc'), 5000);
});

test('状态机：每次失败推进一档，成功清零并回到 5s', () => {
  const state = createRetryState();
  assert.equal(state.attempt, 0);

  const steps = [];
  for (let i = 0; i < 5; i += 1) {
    steps.push(state.fail());
    state.beginAttempt();
  }
  assert.deepEqual(steps.map((s) => s.delayMs), [5000, 15000, 60000, 300000, 300000]);
  assert.deepEqual(steps.map((s) => s.attempt), [1, 2, 3, 4, 5]);

  assert.equal(state.succeed(), 0);
  assert.equal(state.attempt, 0);
  assert.equal(state.fail().delayMs, 5000, '成功一次后延迟必须回到 5000');
});

test('状态机：已排定等待时重复 fail 不重复计数（多路 close/error 不会跳档）', () => {
  const state = createRetryState();
  assert.deepEqual(state.fail(), { attempt: 1, delayMs: 5000 });
  assert.equal(state.fail(), null);
  assert.equal(state.fail(), null);
  assert.equal(state.attempt, 1);
  assert.equal(state.pending, true);

  state.beginAttempt();
  assert.equal(state.fail().attempt, 2);
});

test('调度器：用假计时器跑满一轮，日志文案与退避档位都对得上', async () => {
  const timers = fakeTimers();
  const logs = [];
  const attempts = [];
  let scheduler = null;
  scheduler = createOnebotRetry({
    run: async () => {
      attempts.push(scheduler.attempt);
      scheduler.fail(); // 模拟「这次也没连上」
    },
    log: (message) => logs.push(message),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  scheduler.fail();
  assert.deepEqual(logs, ['OneBot 未就绪，5 秒后重试（第 1 次）']);

  for (const ms of [5000, 15000, 60000, 300000]) {
    timers.advance(ms);
    await flush();
  }

  assert.deepEqual(logs, [
    'OneBot 未就绪，5 秒后重试（第 1 次）',
    'OneBot 未就绪，15 秒后重试（第 2 次）',
    'OneBot 未就绪，60 秒后重试（第 3 次）',
    'OneBot 未就绪，300 秒后重试（第 4 次）',
    'OneBot 未就绪，300 秒后重试（第 5 次）'
  ]);
  // 5 次失败 = 5 条「N 秒后重试」日志；run 只在前面 4 个等待到点时跑过（第 5 次刚排上）。
  assert.deepEqual(attempts, [1, 2, 3, 4]);

  // 连上了：计数清零、待执行的定时器被取消、退避回到第一档。
  scheduler.succeed();
  assert.equal(scheduler.attempt, 0);
  assert.equal(scheduler.pending, false);
  assert.equal(timers.pending, 0);
  scheduler.fail();
  assert.equal(logs.at(-1), 'OneBot 未就绪，5 秒后重试（第 1 次）');
});

test('调度器：run 抛异常时也继续排下一次，不会停手', async () => {
  const timers = fakeTimers();
  const logs = [];
  const scheduler = createOnebotRetry({
    run: async () => { throw new Error('boom'); },
    log: (message) => logs.push(message),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  scheduler.fail();
  timers.advance(5000);
  await flush();

  assert.equal(logs.length, 3);
  assert.match(logs[0], /OneBot 未就绪，5 秒后重试（第 1 次）/);
  assert.match(logs[1], /OneBot 重试异常：boom/);
  assert.match(logs[2], /OneBot 未就绪，15 秒后重试（第 2 次）/);
  assert.equal(scheduler.attempt, 2);
  assert.equal(scheduler.pending, true);
});
