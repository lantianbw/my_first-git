import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, judgeLock } from '../src/lifecycle/lock.js';

const NOW = Date.UTC(2026, 9, 28, 4, 12, 0);
const WINDOW = 120_000;

const alive = (pid) => pid === 4242;
const dead = () => false;

const judge = (holder, extra = {}) => judgeLock({ holder, now: NOW, pidAlive: alive, ...extra });

test('spec：契约字段齐备且已冻结；now 与 pidAlive 必填', () => {
  assert.equal(spec.name, 'lifecycle/lock');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.throws(() => judgeLock({ holder: null, pidAlive: alive }), /now 必须是毫秒时间戳/);
  assert.throws(() => judgeLock({ holder: null, now: NOW }), /pidAlive/);
  assert.throws(() => judgeLock({ holder: null, now: '昨天', pidAlive: alive }), TypeError);
});

test('空锁：没有持有者，直接接管', () => {
  for (const holder of [null, undefined, '', '   ', {}, []]) {
    const r = judge(holder);
    assert.equal(r.adopt, true, JSON.stringify(holder));
    assert.equal(r.reason, 'empty', JSON.stringify(holder));
    assert.equal(r.remainingMs, 0);
  }
});

test('同一 pid：自己拿回自己的锁，不探活', () => {
  let calls = 0;
  const pidAlive = () => {
    calls += 1;
    return true;
  };

  const r = judgeLock({ holder: { pid: 4242, at: NOW - 10 * WINDOW }, now: NOW, selfPid: 4242, pidAlive });
  assert.deepEqual(r, { adopt: true, reason: 'self', remainingMs: 0 });
  assert.equal(calls, 0, '同 pid 不必探活');

  // 旧格式（裸 PID 字符串）同样认得出自己
  assert.equal(judgeLock({ holder: '4242', now: NOW, selfPid: 4242, pidAlive }).reason, 'self');
});

test('死进程：PID 不在 → 接管（现有实现按过期锁处理）', () => {
  const r = judgeLock({ holder: { pid: 4242, at: NOW - 1_000 }, now: NOW, pidAlive: dead });
  assert.deepEqual(r, { adopt: true, reason: 'pid-dead', remainingMs: 0 });
  assert.equal(judge('4242', { pidAlive: dead }).adopt, true);

  // 内容不是合法 PID 时也按过期处理（旧实现 !Number.isInteger(pid) || pid <= 0 → stale）
  for (const holder of ['abc', '12abc', { pid: -5 }, { pid: 0 }, { pid: 3.5 }]) {
    const r2 = judge(holder);
    assert.equal(r2.adopt, true, JSON.stringify(holder));
    assert.equal(r2.reason, 'invalid-pid', JSON.stringify(holder));
  }
});

test('活进程未超时：不接管，并回传剩余时间', () => {
  const r = judge({ pid: 4242, at: NOW - 30_000 });
  assert.deepEqual(r, { adopt: false, reason: 'alive', remainingMs: 90_000 });

  // 刚写入的锁：整窗可用
  assert.equal(judge({ pid: 4242, at: NOW }, { staleMs: WINDOW }).remainingMs, WINDOW);

  // 旧格式只有裸 PID、没有时间戳 → 时间维度不生效，仍按"活着"处理
  assert.deepEqual(judge('4242'), { adopt: false, reason: 'alive', remainingMs: WINDOW });
});

test('活进程但超时：接管；恰好到点算超时，差 1ms 不算', () => {
  assert.equal(judge({ pid: 4242, at: NOW - WINDOW }).adopt, true, '恰好满窗 → 接管');
  assert.equal(judge({ pid: 4242, at: NOW - WINDOW }).reason, 'stale');

  const justBefore = judge({ pid: 4242, at: NOW - (WINDOW - 1) });
  assert.equal(justBefore.adopt, false, '差 1ms 还没到期');
  assert.equal(justBefore.remainingMs, 1);

  assert.equal(judge({ pid: 4242, at: NOW - 10 * WINDOW }).adopt, true);

  // 自定义窗口同样生效
  assert.equal(judge({ pid: 4242, at: NOW - 5_000 }, { staleMs: 3_000 }).adopt, true);
  assert.equal(judge({ pid: 4242, at: NOW - 5_000 }, { staleMs: 10_000 }).adopt, false);

  // 锁时间戳"在未来"（时钟回拨）时不判过期
  const future = judge({ pid: 4242, at: NOW + 10_000 });
  assert.equal(future.adopt, false);
  assert.equal(future.remainingMs, WINDOW);
});

test('now 非法：直接报错，不用系统时间兜底', () => {
  for (const now of [undefined, null, NaN, Infinity, '2026-10-28', {}]) {
    assert.throws(() => judgeLock({ holder: null, now, pidAlive: alive }), /now 必须是毫秒时间戳/, String(now));
  }
});

test('pidAlive 抛错：保守拒绝接管（fail closed），不冒双实例风险', () => {
  const boom = () => {
    throw new Error('EPERM: 权限不足');
  };

  const r = judgeLock({ holder: { pid: 4242, at: NOW - 30_000 }, now: NOW, pidAlive: boom });
  assert.equal(r.adopt, false, '探不出来就当有人在跑');
  assert.equal(r.reason, 'probe-failed');
  assert.equal(r.remainingMs, 90_000, '已知锁龄时仍按窗口算剩余');

  // 无锁龄信息时给整窗
  assert.equal(judgeLock({ holder: '4242', now: NOW, pidAlive: boom }).remainingMs, WINDOW);
});

test('remainingMs：随锁龄线性减少，接管时归零', () => {
  const cases = [
    [0, 120_000],
    [1, 119_999],
    [60_000, 60_000],
    [119_999, 1]
  ];
  for (const [age, expected] of cases) {
    const r = judge({ pid: 4242, at: NOW - age });
    assert.equal(r.remainingMs, expected, `age=${age}`);
    assert.equal(r.adopt, false);
  }

  // 已到点 / 已接管的情形一律 0
  assert.equal(judge({ pid: 4242, at: NOW - WINDOW }).remainingMs, 0);
  assert.equal(judge(null).remainingMs, 0);
  assert.equal(judge('4242', { pidAlive: dead }).remainingMs, 0);
  assert.equal(judge({ pid: 4242, at: NOW - 1 }, { selfPid: 4242 }).remainingMs, 0);
});
