import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, planShutdown } from '../src/lifecycle/shutdown.js';

const task = (name, phase, timeoutMs) => ({ name, phase, timeoutMs });

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'lifecycle/shutdown');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.throws(() => planShutdown('not-an-array'), TypeError);
  assert.throws(() => planShutdown(null), TypeError);
});

test('单任务：原样返回，不因长度 1 出怪结果', () => {
  const r = planShutdown([task('stopWs', 1, 3_000)]);
  assert.deepEqual(r, { order: ['stopWs'], totalTimeoutMs: 3_000, inverted: false });

  // 单任务永远谈不上正序/逆序
  assert.equal(planShutdown([task('only', 4, 0)]).inverted, false);
});

test('多 phase：按 网络 → 会话 → 落盘 → 退出码 排序', () => {
  const r = planShutdown([
    task('exitCode', 4, 0),
    task('stopWs', 1, 5_000),
    task('saveState', 3, 2_000),
    task('drainSession', 2, 8_000)
  ]);
  assert.deepEqual(r.order, ['stopWs', 'drainSession', 'saveState', 'exitCode']);
  assert.equal(r.totalTimeoutMs, 15_000);
});

test('同 phase 稳定：保持入参顺序，不按名字排', () => {
  const r = planShutdown([
    task('zFirst', 2, 1_000),
    task('aSecond', 2, 1_000),
    task('mThird', 2, 1_000)
  ]);
  assert.deepEqual(r.order, ['zFirst', 'aSecond', 'mThird'], '同 phase 必须保序，不能变字典序');

  // 夹在其它 phase 之间也稳定
  const mixed = planShutdown([
    task('netA', 1, 0),
    task('b', 2, 0),
    task('a', 2, 0),
    task('persist', 3, 0)
  ]);
  assert.deepEqual(mixed.order, ['netA', 'b', 'a', 'persist']);
});

test('phase 缺失走默认（最后执行），越界夹紧到 1~4', () => {
  // 缺失 / 非数字 → 默认 4（不抢在落盘前面）
  const missing = planShutdown([task('noPhase'), task('net', 1, 0), task('alsoNoPhase', 'abc', 0)]);
  assert.deepEqual(missing.order, ['net', 'noPhase', 'alsoNoPhase']);

  // 越界夹紧，而不是丢弃
  const clamped = planShutdown([
    task('tooBig', 99, 0),
    task('negative', -7, 0),
    task('normal', 3, 0),
    task('zero', 0, 0)
  ]);
  assert.deepEqual(clamped.order, ['negative', 'zero', 'normal', 'tooBig'], 'phase<=1 都归到第一档');
  assert.equal(clamped.order.length, 4, '越界的任务绝不能丢');

  // 小数四舍五入
  assert.deepEqual(planShutdown([task('x', 2.6, 0), task('y', 2, 0)]).order, ['y', 'x']);
});

test('总超时：逐项求和，非法值按 0 计', () => {
  assert.equal(planShutdown([task('a', 1, 1_000), task('b', 2, 2_500)]).totalTimeoutMs, 3_500);
  assert.equal(planShutdown([task('a', 1, 1_000), task('b', 2)]).totalTimeoutMs, 1_000, '缺 timeoutMs 按 0');
  assert.equal(
    planShutdown([task('a', 1, 100), task('b', 2, -50), task('c', 3, NaN), task('d', 4, 'x')]).totalTimeoutMs,
    100,
    '负数/NaN/非数字都不参与求和（否则总预算会变 NaN）'
  );
  assert.equal(planShutdown([task('a', 1, 0.5)]).totalTimeoutMs, 0.5);
});

test('空数组：空计划，不是 undefined', () => {
  assert.deepEqual(planShutdown([]), { order: [], totalTimeoutMs: 0, inverted: false });

  // 全是坏条目也等价于空计划
  assert.deepEqual(planShutdown([null, undefined, 'x', 42]), { order: [], totalTimeoutMs: 0, inverted: false });
});

test('inverted：入参恰好是执行顺序的倒序时置 true', () => {
  // 按「注册即入栈」的 LIFO 习惯传：exit → persist → session → network
  const lifo = planShutdown([
    task('exitCode', 4, 0),
    task('saveState', 3, 0),
    task('drainSession', 2, 0),
    task('stopWs', 1, 0)
  ]);
  assert.deepEqual(lifo.order, ['stopWs', 'drainSession', 'saveState', 'exitCode']);
  assert.equal(lifo.inverted, true, '入参正好是倒序');

  // 正序传入：无需反转
  const fifo = planShutdown([
    task('stopWs', 1, 0),
    task('drainSession', 2, 0),
    task('saveState', 3, 0),
    task('exitCode', 4, 0)
  ]);
  assert.equal(fifo.inverted, false);

  // 同 phase 的两项即便刚好反着排，也不算 inverted（稳定排序不会反转它们）
  assert.equal(planShutdown([task('b', 2, 0), task('a', 2, 0)]).inverted, false);

  // 只反了一部分（不是完整倒序）也不算
  const partial = planShutdown([task('exitCode', 4, 0), task('stopWs', 1, 0), task('saveState', 3, 0)]);
  assert.deepEqual(partial.order, ['stopWs', 'saveState', 'exitCode']);
  assert.equal(partial.inverted, false);
});
