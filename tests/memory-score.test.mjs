import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, score, rank, halfLifeFor } from '../src/content/memory-score.js';

const DAY = 86_400_000;
// 固定假时钟：本模块约定不读 Date.now()，所有时间都从 now 传入。
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'content/memory-score');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('halfLifeFor：四类半衰期分档，未知 kind 回退 event', () => {
  assert.equal(halfLifeFor('identity'), 180 * DAY);
  assert.equal(halfLifeFor('months'), 30 * DAY);
  assert.equal(halfLifeFor('event'), 7 * DAY);
  assert.equal(halfLifeFor('state'), 1 * DAY);

  assert.ok(halfLifeFor('identity') > halfLifeFor('months'));
  assert.ok(halfLifeFor('months') > halfLifeFor('event'));
  assert.ok(halfLifeFor('event') > halfLifeFor('state'));

  assert.equal(halfLifeFor('unknown-kind'), halfLifeFor('event'));
  assert.equal(halfLifeFor(undefined), halfLifeFor('event'));
  assert.equal(halfLifeFor(null), halfLifeFor('event'));
});

test('score：reviewCount 按 1+ln(1+n) 增强', () => {
  const item = { createdAt: NOW, lastMentionAt: NOW, importance: 2, reviewCount: 0 };
  assert.equal(score(item, { now: NOW }), 2);

  const three = { ...item, reviewCount: 3 };
  const expected = 2 * (1 + Math.log(4));
  assert.ok(Math.abs(score(three, { now: NOW, halfLifeMs: 7 * DAY }) - expected) < 1e-12);

  const once = score({ ...item, reviewCount: 1 }, { now: NOW });
  const five = score({ ...item, reviewCount: 5 }, { now: NOW });
  assert.ok(score(item, { now: NOW }) < once);
  assert.ok(once < five);
});

test('score：跨天按半衰期指数衰减', () => {
  const item = { createdAt: NOW, lastMentionAt: NOW, importance: 1 };
  const halfLife = 7 * DAY;

  assert.ok(Math.abs(score(item, { now: NOW + halfLife, halfLifeMs: halfLife }) - Math.exp(-1)) < 1e-12);
  assert.ok(Math.abs(score(item, { now: NOW + 2 * halfLife, halfLifeMs: halfLife }) - Math.exp(-2)) < 1e-12);

  const twoDays = score(item, { now: NOW + 2 * DAY, halfLifeMs: halfLife });
  const fiveDays = score(item, { now: NOW + 5 * DAY, halfLifeMs: halfLife });
  assert.ok(twoDays > fiveDays, '越久分数越低');

  // 计时基准优先 lastMentionAt：很久前创建、刚被提及 → 不衰减
  const recalled = { createdAt: NOW - 300 * DAY, lastMentionAt: NOW, importance: 1 };
  assert.equal(score(recalled, { now: NOW, halfLifeMs: halfLife }), 1);

  // now 早于基准时间时不放大分数（Δ 取 0）
  assert.equal(score(item, { now: NOW - 10 * DAY, halfLifeMs: halfLife }), 1);
});

test('score：halfLifeMs 缺省时按 item.kind 取半衰期', () => {
  const shared = { createdAt: NOW - 30 * DAY, lastMentionAt: NOW - 30 * DAY, importance: 1 };
  assert.ok(
    Math.abs(score({ ...shared, kind: 'months' }, { now: NOW }) - Math.exp(-1)) < 1e-12
  );
  assert.ok(score({ ...shared, kind: 'identity' }, { now: NOW }) > score({ ...shared, kind: 'event' }, { now: NOW }));
});

test('rank：降序、同分保持插入顺序、limit 生效', () => {
  const items = [
    { id: 'a', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 7 * DAY, importance: 1 },
    { id: 'b', kind: 'event', createdAt: NOW, lastMentionAt: NOW, importance: 1 },
    { id: 'c', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 7 * DAY, importance: 1 },
    { id: 'd', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 14 * DAY, importance: 1 }
  ];

  const ranked = rank(items, { now: NOW });
  assert.deepEqual(ranked.map((entry) => entry.item.id), ['b', 'a', 'c', 'd']);
  assert.equal(ranked[1].score, ranked[2].score, 'a 与 c 同分');

  assert.deepEqual(rank(ranked.map((entry) => entry.item), { now: NOW }, 2).map((entry) => entry.item.id), ['b', 'a']);
  assert.deepEqual(rank(items, { now: NOW }, 0), []);
  assert.equal(rank(items, { now: NOW }, -3).length, 0);

  // 入参不被改写、不被裁剪
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(new Set(ranked.map((entry) => entry.item)).size, 4);
});

test('rank：半衰期按 kind 分档决定先后', () => {
  const old = (kind) => ({ kind, createdAt: NOW - 30 * DAY, lastMentionAt: NOW - 30 * DAY, importance: 1 });
  const ranked = rank([old('state'), old('identity'), old('months'), old('event')], { now: NOW });
  assert.deepEqual(ranked.map((entry) => entry.item.kind), ['identity', 'months', 'event', 'state']);
});

test('rank：archiveThreshold 只打标记，不删除任何记忆', () => {
  const items = [
    { id: 'a', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 7 * DAY, importance: 1 },
    { id: 'b', kind: 'event', createdAt: NOW, lastMentionAt: NOW, importance: 1 },
    { id: 'c', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 7 * DAY, importance: 1 },
    { id: 'd', kind: 'event', createdAt: NOW, lastMentionAt: NOW - 14 * DAY, importance: 1 }
  ];

  const ranked = rank(items, { now: NOW, archiveThreshold: 0.5 });
  assert.equal(ranked.length, 4, '一条都不能少');
  assert.deepEqual(ranked.map((entry) => entry.item.id), ['b', 'a', 'c', 'd']);
  // b=1 保留；a/c≈0.368、d≈0.135 低于阈值 → 仅标记
  assert.deepEqual(ranked.map((entry) => entry.archived), [false, true, true, true]);
  assert.equal(items.length, 4);

  // 不传阈值时一律不标记
  assert.deepEqual(rank(items, { now: NOW }).map((entry) => entry.archived), [false, false, false, false]);
});

test('rank：坏条目被跳过，空输入返回空数组', () => {
  const items = [null, undefined, 'x', 42, { id: 'ok', createdAt: NOW, lastMentionAt: NOW, importance: 1 }];
  const ranked = rank(items, { now: NOW });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].item.id, 'ok');

  assert.deepEqual(rank([], { now: NOW }), []);
  assert.deepEqual(rank(undefined, { now: NOW }), []);
});
