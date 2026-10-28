// tests/lock.test.mjs — lifecycle/lock 单测（锁判定 / 过期边界 / 分发）
import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, DEFAULT_STALE_MS, decideLock, isStale, handle } from '../src/lifecycle/lock.js';

const NOW = Date.UTC(2026, 9, 28, 4, 12, 0);
const WINDOW = 120_000;
const SELF = 9999;

const alive = () => true;
const dead = () => false;

/** 默认：该 pid 存活、时间不过期；各用例按需覆盖。 */
const decide = (input = {}) => decideLock({ now: NOW, aliveCheck: alive, ...input });

test('契约：spec 冻结、名字与路径一致、deps 为 log+now、locked', () => {
  assert.equal(spec.name, 'lifecycle/lock');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log', 'now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.deps));
  assert.ok(Object.isFrozen(spec.toggle));
  assert.equal(DEFAULT_STALE_MS, WINDOW);
});

test('无锁文件：create（旧实现 tryCreate 的 wx 建锁即成功）', () => {
  let probes = 0;
  const probe = () => {
    probes += 1;
    return true;
  };
  for (const info of [undefined, null]) {
    assert.deepEqual(decideLock({ info, now: NOW, aliveCheck: probe }), { action: 'create', reason: 'no-lock' });
  }
  assert.equal(probes, 0, '没有锁文件不必探活');
});

test('锁文件指向存活进程：refuse（旧实现 exit 2）', () => {
  assert.deepEqual(decide({ info: '4242' }), { action: 'refuse', reason: 'alive' });
  // 探活结论也可以直接给布尔值（中枢已把端口探测并进去）
  assert.deepEqual(decide({ info: { pid: 4242, at: NOW - 1_000 }, aliveCheck: true }), { action: 'refuse', reason: 'alive' });
  // 回调用真实 pid 调用一次
  const seen = [];
  decideLock({ info: '4242', now: NOW, aliveCheck: (pid) => (seen.push(pid), true) });
  assert.deepEqual(seen, [4242]);
});

test('锁文件指向已死进程：takeover（旧实现 ESRCH → unlink 后重建）', () => {
  assert.deepEqual(decide({ info: '4242', aliveCheck: dead }), { action: 'takeover', reason: 'pid-dead' });
  assert.deepEqual(decide({ info: { pid: 4242, at: NOW }, aliveCheck: dead }), { action: 'takeover', reason: 'pid-dead' });
});

test('锁已过期且进程已死：takeover（reason 记为 stale）', () => {
  const r = decide({ info: { pid: 4242, at: NOW - 10 * WINDOW }, aliveCheck: dead, staleMs: WINDOW });
  assert.deepEqual(r, { action: 'takeover', reason: 'stale' });
});

test('锁已过期但进程仍活：仍 refuse —— 旧实现没有时间维度，只看 PID，照旧 exit 2', () => {
  // 旧 acquireLock 里没有任何"锁龄"概念：process.kill(pid,0) 成功 + 端口被占即 exit 2。
  // 时间过期只写进 reason（'alive-stale'）供中枢告警，绝不改变"放弃启动"的结论，
  // 否则就会接管一个仍活着的桥、出现双实例抢消息。
  const r = decide({ info: { pid: 4242, at: NOW - 10 * WINDOW }, aliveCheck: alive, staleMs: WINDOW });
  assert.deepEqual(r, { action: 'refuse', reason: 'alive-stale' });
  // 旧格式（裸 PID，无 at）连锁龄都没有，时间维度不生效
  assert.deepEqual(decide({ info: '4242', staleMs: 1 }), { action: 'refuse', reason: 'alive' });
});

test('空内容 / 非法 PID：takeover（旧实现同样按过期锁处理）', () => {
  for (const info of ['', '   ', {}, [], { pid: null }, { pid: '' }]) {
    assert.equal(decide({ info }).action, 'takeover', JSON.stringify(info));
    assert.equal(decide({ info }).reason, 'empty', JSON.stringify(info));
  }
  for (const info of ['abc', '12abc', 0, -5, 3.5, { pid: -5 }, { pid: 0 }, { pid: 3.5 }, { pid: 'abc' }]) {
    assert.equal(decide({ info }).action, 'takeover', JSON.stringify(info));
    assert.equal(decide({ info }).reason, 'invalid-pid', JSON.stringify(info));
  }
});

test('锁里的 PID 就是自己：reuse（旧实现删掉重建，结果等同于自己持有）', () => {
  let probes = 0;
  const probe = () => {
    probes += 1;
    return true;
  };
  assert.deepEqual(decideLock({ info: '9999', pid: SELF, now: NOW, aliveCheck: probe }), { action: 'reuse', reason: 'self' });
  assert.deepEqual(
    decideLock({ info: { pid: 9999, at: NOW - 10 * WINDOW }, pid: SELF, now: NOW, aliveCheck: probe, staleMs: WINDOW }),
    { action: 'reuse', reason: 'self' }
  );
  assert.equal(probes, 0, '同 pid 不必探活');
});

test('参数缺失 / 非法：抛 TypeError（由 handle 转成 INVALID_ARGS）', () => {
  for (const now of [undefined, null, NaN, Infinity, '2026-10-28', {}]) {
    assert.throws(() => decideLock({ info: '4242', now, aliveCheck: alive }), /now 必须是毫秒时间戳/, String(now));
  }
  for (const aliveCheck of [undefined, null, 'yes', 1, {}]) {
    assert.throws(() => decideLock({ info: '4242', now: NOW, aliveCheck }), /aliveCheck/, String(aliveCheck));
  }
});

test('探活给不出布尔结论 / 抛错：refuse，绝不冒险接管（旧"其它错误"分支 exit 2）', () => {
  for (const aliveCheck of [() => undefined, () => 'ok', () => 1]) {
    assert.deepEqual(decide({ info: '4242', aliveCheck }), { action: 'refuse', reason: 'probe-failed' });
  }
  const boom = () => {
    throw new Error('EPERM: 权限不足');
  };
  assert.deepEqual(decide({ info: '4242', aliveCheck: boom }), { action: 'refuse', reason: 'probe-failed' });
});

test('isStale：边界正好等于 staleMs 算过期，差 1ms 不算', () => {
  assert.equal(isStale({ pid: 4242, at: NOW - WINDOW }, NOW, WINDOW), true, '正好满窗 → 过期');
  assert.equal(isStale({ pid: 4242, at: NOW - (WINDOW - 1) }, NOW, WINDOW), false, '差 1ms → 未过期');
  assert.equal(isStale({ pid: 4242, at: NOW }, NOW, WINDOW), false);
  // 时间戳在将来（时钟回拨）不算过期
  assert.equal(isStale({ pid: 4242, at: NOW + 10_000 }, NOW, WINDOW), false);
  // 旧格式（裸 PID）没有锁龄，时间维度不生效
  assert.equal(isStale('4242', NOW, WINDOW), false);
  assert.equal(isStale(null, NOW, WINDOW), false);
  // 非法 now 直接报错，不用系统时间兜底
  for (const now of [undefined, null, NaN, '昨天']) {
    assert.throws(() => isStale({ pid: 4242, at: NOW }, now, WINDOW), /now 必须是毫秒时间戳/, String(now));
  }
  // 窗口非法（非正数 / 非有限值）回落默认值
  assert.equal(isStale({ pid: 4242, at: NOW - WINDOW }, NOW, 0), true);
  assert.equal(isStale({ pid: 4242, at: NOW - WINDOW }, NOW, -1), true);
  assert.equal(isStale({ pid: 4242, at: NOW - WINDOW }, NOW, NaN), true);
});

test('handle：按 action 分发 decide / is-stale，时间可由 ctx.now 补', () => {
  const ctx = { now: () => NOW, log: () => {} };
  assert.deepEqual(handle(ctx, { info: '4242', aliveCheck: dead }), { ok: true, value: { action: 'takeover', reason: 'pid-dead' } });
  assert.deepEqual(handle(ctx, { action: 'decide', info: null }), { ok: true, value: { action: 'create', reason: 'no-lock' } });
  assert.deepEqual(handle(ctx, { action: 'is-stale', info: { pid: 4242, at: NOW - WINDOW } }), { ok: true, value: true });
  // 显式 now 优先于 ctx.now
  assert.deepEqual(
    handle(ctx, { action: 'is-stale', info: { pid: 4242, at: NOW - WINDOW }, now: NOW - WINDOW }),
    { ok: true, value: false }
  );
});

test('handle：未知 action 与参数违约一律 INVALID_ARGS，并带上可读原因', () => {
  const ctx = { now: () => NOW, log: () => {} };
  for (const action of ['', 'judge', 'ACQUIRE', 'lock-nope']) {
    const r = handle(ctx, { action });
    assert.equal(r.ok, false, action);
    assert.equal(r.code, 'INVALID_ARGS', action);
    assert.match(r.error, /未知 action/, action);
  }
  // 缺 aliveCheck
  const noProbe = handle(ctx, { info: '4242' });
  assert.equal(noProbe.ok, false);
  assert.equal(noProbe.code, 'INVALID_ARGS');
  assert.match(noProbe.error, /aliveCheck/);
  // ctx 没有 now 且参数里也没给
  const noNow = handle({ log: () => {} }, { info: '4242', aliveCheck: dead });
  assert.equal(noNow.ok, false);
  assert.equal(noNow.code, 'INVALID_ARGS');
  assert.match(noNow.error, /now 必须是毫秒时间戳/);
});
