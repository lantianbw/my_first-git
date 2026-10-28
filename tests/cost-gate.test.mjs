import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, judge, handle } from '../src/cost/gate.js';

// 固定假时钟：本模块约定不读 Date.now()，now 只透传，不参与判定。
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'cost/gate');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log', 'now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('正常路径：低于预警线 → ok 且放行', () => {
  const out = judge({ estimatedCost: 5, spentToday: 10, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'ok');
  assert.equal(out.allow, true);
  assert.equal(out.remaining, 35);
  assert.match(out.reason, /低于预警线/);
});

test('规则 1：合计 < 30 → ok', () => {
  const out = judge({ estimatedCost: 9.99, spentToday: 19.99, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'ok');
  assert.equal(out.allow, true);
});

test('规则 2：达到 30 但未到 50 → warn 且放行（只记账不拦）', () => {
  const out = judge({ estimatedCost: 10, spentToday: 25, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.allow, true);
  assert.equal(out.remaining, 15);
});

test('规则 3：>= 50 且 isNewTurn === true → stop 且拒绝', () => {
  const out = judge({ estimatedCost: 10, spentToday: 45, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'stop');
  assert.equal(out.allow, false);
  assert.equal(out.remaining, 0);
  assert.match(out.reason, /拒绝新会话/);
});

test('规则 4：>= 50 但 isNewTurn === false → warn 且放行（进行中不打断）', () => {
  const out = judge({ estimatedCost: 10, spentToday: 45, isNewTurn: false, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.allow, true);
  assert.equal(out.remaining, 0);
  assert.match(out.reason, /不打断/);
});

test('边界：恰好 30 归入 warn，不归入 ok', () => {
  const out = judge({ estimatedCost: 10, spentToday: 20, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.allow, true);
  assert.equal(out.remaining, 20);
});

test('边界：恰好 50 且新轮次 → stop', () => {
  const out = judge({ estimatedCost: 10, spentToday: 40, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'stop');
  assert.equal(out.allow, false);
  assert.equal(out.remaining, 0);
});

test('边界：恰好 50 且进行中 → warn 且放行', () => {
  const out = judge({ estimatedCost: 10, spentToday: 40, isNewTurn: false, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.allow, true);
});

test('边界：49.99 仍放行，50.01 已硬停', () => {
  const below = judge({ estimatedCost: 9.99, spentToday: 40, isNewTurn: true, now: NOW });
  const above = judge({ estimatedCost: 10.01, spentToday: 40, isNewTurn: true, now: NOW });
  assert.equal(below.level, 'warn');
  assert.equal(below.allow, true);
  assert.equal(above.level, 'stop');
  assert.equal(above.allow, false);
});

test('自定义 limits：warn 10 / stop 20 全量覆盖默认口径', () => {
  const limits = { warn: 10, stop: 20 };

  const warned = judge({ estimatedCost: 5, spentToday: 10, limits, isNewTurn: true, now: NOW });
  assert.equal(warned.level, 'warn');
  assert.equal(warned.allow, true);
  assert.equal(warned.remaining, 5);

  const stopped = judge({ estimatedCost: 5, spentToday: 15, limits, isNewTurn: true, now: NOW });
  assert.equal(stopped.level, 'stop');
  assert.equal(stopped.allow, false);
  assert.equal(stopped.remaining, 0);

  const fine = judge({ estimatedCost: 2, spentToday: 2, limits, isNewTurn: true, now: NOW });
  assert.equal(fine.level, 'ok');
});

test('自定义 limits：只覆盖 stop，warn 回落到默认 30', () => {
  const out = judge({ estimatedCost: 10, spentToday: 10, limits: { stop: 100 }, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'ok');
  assert.equal(out.remaining, 80);
});

test('自定义 limits：只覆盖 warn，stop 回落到默认 50', () => {
  const out = judge({ estimatedCost: 2, spentToday: 9, limits: { warn: 10 }, isNewTurn: true, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.remaining, 39);
});

test('未传 limits 与显式传 30 / 50 结论一致', () => {
  const implicit = judge({ estimatedCost: 20, spentToday: 20, isNewTurn: true, now: NOW });
  const explicit = judge({
    estimatedCost: 20,
    spentToday: 20,
    limits: { warn: 30, stop: 50 },
    isNewTurn: true,
    now: NOW
  });
  assert.deepEqual(implicit, explicit);
});

test('remaining 收敛到 0，不出现负数', () => {
  const out = judge({ estimatedCost: 500, spentToday: 500, isNewTurn: true, now: NOW });
  assert.equal(out.remaining, 0);
  assert.ok(out.remaining >= 0);
});

test('fail-closed：spentToday 不可用且新轮次 → 拒绝', () => {
  const cases = [
    { estimatedCost: 1 },
    { estimatedCost: 1, spentToday: null },
    { estimatedCost: 1, spentToday: 'not-a-number' },
    { estimatedCost: 1, spentToday: -5 }
  ];
  for (const c of cases) {
    const out = judge({ ...c, isNewTurn: true, now: NOW });
    assert.equal(out.level, 'stop', JSON.stringify(c));
    assert.equal(out.allow, false, JSON.stringify(c));
    assert.match(out.reason, /账本缺失/);
  }
});

test('fail-closed：spentToday 不可用但进行中 → 仍然不打断', () => {
  const out = judge({ estimatedCost: 1, isNewTurn: false, now: NOW });
  assert.equal(out.level, 'warn');
  assert.equal(out.allow, true);
});

test('estimatedCost 不可用按 0 处理（只会更保守，不会放过超支）', () => {
  const missing = judge({ spentToday: 31, isNewTurn: true, now: NOW });
  const broken = judge({ estimatedCost: 'abc', spentToday: 31, isNewTurn: true, now: NOW });
  assert.equal(missing.level, 'warn');
  assert.equal(broken.level, 'warn');
});

test('浮点金额不漂移', () => {
  const out = judge({ estimatedCost: 0.005, spentToday: 10.005, isNewTurn: true, now: NOW });
  assert.equal(out.remaining, 39.99);
});

test('纯函数：不改入参、可重复、结论不随 now 变化', () => {
  const ctx = {
    estimatedCost: 12,
    spentToday: 41,
    limits: { warn: 30, stop: 50 },
    isNewTurn: true,
    now: NOW
  };
  const snapshot = JSON.parse(JSON.stringify(ctx));
  const first = judge(ctx);
  const second = judge(ctx);
  const later = judge({ ...ctx, now: NOW + 86_400_000 });

  assert.deepEqual(ctx, snapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(first, later);
  assert.equal(first.level, 'stop');
});

test('handle：返回 { ok, value } 契约形状，并在 stop 时记一条 warn 日志', () => {
  const logs = [];
  const ctx = { log: (level, msg, meta) => logs.push({ level, msg, meta }), now: () => NOW };

  const out = handle(ctx, { estimatedCost: 10, spentToday: 45, isNewTurn: true });

  assert.equal(out.ok, true);
  assert.equal(out.value.allow, false);
  assert.equal(out.value.level, 'stop');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].msg, /^\[cost\/gate\] stop: /);
  assert.equal(logs[0].meta.allow, false);
});

test('handle：ok 档位不写日志，避免每轮刷屏', () => {
  const logs = [];
  const ctx = { log: (level, msg) => logs.push({ level, msg }) };
  const out = handle(ctx, { estimatedCost: 1, spentToday: 1, isNewTurn: true });
  assert.equal(out.value.level, 'ok');
  assert.equal(logs.length, 0);
});

test('handle：缺 log / 缺 now 时降级返回，不抛错', () => {
  assert.doesNotThrow(() => handle(undefined, { estimatedCost: 60, spentToday: 0, isNewTurn: true }));
  const out = handle({}, { estimatedCost: 60, spentToday: 0, isNewTurn: true });
  assert.equal(out.ok, true);
  assert.equal(out.value.level, 'stop');
});

test('handle：args.now 优先于 ctx.now，且空参数按 fail-closed 处理', () => {
  let called = 0;
  const ctx = { now: () => { called += 1; return NOW; } };

  handle(ctx, { estimatedCost: 1, spentToday: 1, isNewTurn: false, now: NOW });
  assert.equal(called, 0, 'args.now 存在时不应再调 ctx.now');

  const empty = handle({ now: () => NOW }, {});
  assert.equal(empty.value.allow, false);
  assert.equal(empty.value.level, 'stop');
});
