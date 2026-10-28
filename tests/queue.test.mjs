import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, mergePending } from '../src/session/queue.js';

/** 优先级表由调用方注入（本模块不认识任何 reason 的业务含义）。 */
const PRIORITY = Object.freeze({ timeout: 1, proactiveCheck: 2, message: 3, reply: 3, admin: 5 });
const priorityOf = (reason) => PRIORITY[reason] ?? 0;

const merge = (pending, incoming, fn = priorityOf) => mergePending({ pending, incoming, priorityOf: fn });

test('spec：契约字段齐备且已冻结；priorityOf 必须注入', () => {
  assert.equal(spec.name, 'session/queue');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.throws(() => mergePending({ pending: 'a' }), /priorityOf/);
  assert.throws(() => mergePending({ priorityOf: 'not-a-fn' }), TypeError);
});

test('升级：新原因优先级更高 → 换成新原因并标 upgraded', () => {
  const r = merge('timeout', 'message');
  assert.deepEqual(r, { reason: 'message', upgraded: true, dropped: ['timeout'] });

  // 更高的也照样升
  assert.deepEqual(merge('message', 'admin'), { reason: 'admin', upgraded: true, dropped: ['message'] });
});

test('不升级：新原因优先级更低 → 保留原值', () => {
  const r = merge('message', 'timeout');
  assert.deepEqual(r, { reason: 'message', upgraded: false, dropped: ['timeout'] });

  assert.deepEqual(merge('admin', 'proactiveCheck'), { reason: 'admin', upgraded: false, dropped: ['proactiveCheck'] });
});

test('同优先级：保留原值，新原因进 dropped', () => {
  const r = merge('message', 'reply');
  assert.equal(r.reason, 'message', '打平时不能把原来的换掉');
  assert.equal(r.upgraded, false);
  assert.deepEqual(r.dropped, ['reply']);

  // 顺序反过来（原值是 reply）同样保留原值
  assert.equal(merge('reply', 'message').reason, 'reply');
});

test('空 pending：新原因直接填入，但不标记为升级', () => {
  for (const empty of [null, undefined, [], '']) {
    const r = merge(empty, 'timeout');
    assert.equal(r.reason, 'timeout', String(empty));
    assert.equal(r.upgraded, false, '空槽没有"被抬高"的原值，不算升级');
    assert.deepEqual(r.dropped, []);
  }

  // 空槽 + 多原因：照样只留最高的那个
  assert.deepEqual(merge([], ['timeout', 'admin', 'message']), {
    reason: 'admin',
    upgraded: false,
    dropped: ['timeout', 'message']
  });
});

test('空 incoming：原值原样返回，dropped 为空', () => {
  for (const empty of [null, undefined, [], '']) {
    const r = merge('message', empty);
    assert.deepEqual(r, { reason: 'message', upgraded: false, dropped: [] }, String(empty));
  }

  // 两侧都空 → 没有可留的原因
  assert.deepEqual(merge(null, null), { reason: null, upgraded: false, dropped: [] });
  assert.deepEqual(merge([], []), { reason: null, upgraded: false, dropped: [] });
});

test('多原因只留最高：两侧合并后取全局最高', () => {
  const r = merge(['timeout'], ['proactiveCheck', 'admin', 'message']);
  assert.equal(r.reason, 'admin', 'admin(5) 最高');
  assert.equal(r.upgraded, true);
  assert.deepEqual(r.dropped, ['timeout', 'proactiveCheck', 'message']);

  // 原值本身就是最高的：新来的全被丢掉，且顺序是「先 pending 后 incoming」
  const keep = merge(['admin', 'timeout'], ['message', 'reply']);
  assert.equal(keep.reason, 'admin');
  assert.equal(keep.upgraded, false);
  assert.deepEqual(keep.dropped, ['timeout', 'message', 'reply']);
});

test('dropped 内容：除 winner 之外的全部候选，保序去重', () => {
  // 同名原因在两个侧都出现 → 只记一次，且因为它就是 winner 所以不出现在 dropped 里
  assert.deepEqual(merge(['message'], ['message', 'timeout']), {
    reason: 'message',
    upgraded: false,
    dropped: ['timeout']
  });

  // 被顶掉的旧值一定在 dropped 里（不是只有新来的进 dropped）
  assert.deepEqual(merge('timeout', 'message').dropped, ['timeout']);

  // 未知优先级的候选同样如实记录，不会被静默吞掉
  const throwing = (r) => {
    if (r === 'bad') throw new Error('boom');
    return PRIORITY[r] ?? 0;
  };
  assert.deepEqual(merge('message', ['bad', 'timeout'], throwing), {
    reason: 'message',
    upgraded: false,
    dropped: ['bad', 'timeout']
  });
});

test('priorityOf 抛错：降级保留原值，不让异常打断合并', () => {
  const throwing = (r) => {
    if (r === 'bad') throw new Error('boom');
    return PRIORITY[r] ?? 0;
  };

  // 新原因算不出优先级 → 不能顶掉原值
  const keep = merge('timeout', 'bad', throwing);
  assert.deepEqual(keep, { reason: 'timeout', upgraded: false, dropped: ['bad'] });

  // 原值自己算不出优先级 → 同样保住原值（"保留原值"优先于"让更好的上来"）
  const held = merge('bad', 'admin', throwing);
  assert.deepEqual(held, { reason: 'bad', upgraded: false, dropped: ['admin'] });

  // 空槽时它是唯一候选 → 仍然填入，不会因为算不出优先级就丢掉
  assert.deepEqual(merge(null, 'bad', throwing), { reason: 'bad', upgraded: false, dropped: [] });

  // 返回 NaN / Infinity 等同于算不出
  const weird = () => NaN;
  assert.equal(merge('timeout', 'message', weird).reason, 'timeout');
  assert.equal(merge(null, 'message', weird).reason, 'message');
});
