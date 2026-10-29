import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  AFFECTION_MIN,
  AFFECTION_MAX,
  AFFECTION_TAGS_LIMIT,
  AFFECTION_TAG_MAX_CHARS,
  KINSHIP_COOLING_DELTA,
  normalizeAffection,
  hasAffection,
  describeAffection,
  getAffection,
  setAffection,
  adjustAffection,
  addAffectionTag
} from '../src/memory/affection-profile.js';
import { renderMemory } from '../src/content/memory-render.js';

const NOW = 1_800_000_000_000;

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'memory/affection-profile');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('normalizeAffection：数字 / 数值字符串 / 对象 / 脏数据 都归一成 {score,tags}', () => {
  assert.deepEqual(normalizeAffection(42), { score: 42, tags: [] });
  assert.deepEqual(normalizeAffection('42'), { score: 42, tags: [] });
  assert.deepEqual(normalizeAffection({ score: 30, tags: ['投缘'] }), { score: 30, tags: ['投缘'] });
  assert.deepEqual(normalizeAffection(undefined), { score: 0, tags: [] });
  assert.deepEqual(normalizeAffection(null), { score: 0, tags: [] });
  assert.deepEqual(normalizeAffection({}), { score: 0, tags: [] });
  assert.deepEqual(normalizeAffection('不是数字'), { score: 0, tags: [] });
});

test('clampScore：分数夹在 -100~100 且四舍五入', () => {
  assert.equal(normalizeAffection(999).score, AFFECTION_MAX);
  assert.equal(normalizeAffection(-999).score, AFFECTION_MIN);
  assert.equal(normalizeAffection(42.6).score, 43);
  assert.equal(normalizeAffection(42.4).score, 42);
  assert.equal(normalizeAffection(Number.NaN).score, 0);
});

test('describeAffection：分数映射到温度档位', () => {
  assert.equal(describeAffection(80), '亲近');
  assert.equal(describeAffection(60), '亲近');
  assert.equal(describeAffection(30), '聊得来');
  assert.equal(describeAffection(0), '一般');
  assert.equal(describeAffection(-30), '有点疏远');
  assert.equal(describeAffection(-80), '冷淡');
  assert.equal(describeAffection(-100), '冷淡');
});

test('hasAffection：只有真写过好感度才返回 true', () => {
  assert.equal(hasAffection({ affection: { score: 10 } }), true);
  assert.equal(hasAffection({ affection: 10 }), true);
  assert.equal(hasAffection({ affection: '10' }), true);
  assert.equal(hasAffection({ affection: 0 }), true);
  assert.equal(hasAffection({ affection: '不是数字' }), false);
  assert.equal(hasAffection({}), false);
  assert.equal(hasAffection(undefined), false);
});

test('adjustAffection：增减正常、越界夹住、保留已有标签', () => {
  // 从 0 加 20
  let r = adjustAffection({}, '雪月', 20);
  assert.equal(r['雪月'].affection.score, 20);
  // 再加 10
  r = adjustAffection(r, '雪月', 10);
  assert.equal(r['雪月'].affection.score, 30);
  // 减 10（冷却）
  r = adjustAffection(r, '雪月', KINSHIP_COOLING_DELTA);
  assert.equal(r['雪月'].affection.score, 20);
  // 越界夹住
  r = adjustAffection({}, '雪月', 9999);
  assert.equal(r['雪月'].affection.score, AFFECTION_MAX);
  r = adjustAffection({}, '雪月', -9999);
  assert.equal(r['雪月'].affection.score, AFFECTION_MIN);
  // 保留已有标签
  const withTags = { 雪月: { affection: { score: 10, tags: ['投缘'] } } };
  r = adjustAffection(withTags, '雪月', 5);
  assert.deepEqual(r['雪月'].affection, { score: 15, tags: ['投缘'] });
});

test('setAffection：设值、越界夹住、保留已有标签', () => {
  let r = setAffection({}, '雪月', 70);
  assert.equal(r['雪月'].affection.score, 70);
  r = setAffection({}, '雪月', 999);
  assert.equal(r['雪月'].affection.score, AFFECTION_MAX);
  const withTags = { 雪月: { affection: { score: 0, tags: ['聊猫'] } } };
  r = setAffection(withTags, '雪月', 50);
  assert.deepEqual(r['雪月'].affection, { score: 50, tags: ['聊猫'] });
});

test('addAffectionTag：去重、截断、上限 5 条、不动分数', () => {
  let r = addAffectionTag({}, '雪月', '投缘');
  assert.deepEqual(r['雪月'].affection.tags, ['投缘']);
  // 去重
  r = addAffectionTag(r, '雪月', '投缘');
  assert.equal(r['雪月'].affection.tags.length, 1);
  // 截断到 20 字
  const longTag = 'a'.repeat(50);
  r = addAffectionTag({}, '雪月', longTag);
  assert.equal(r['雪月'].affection.tags[0].length, AFFECTION_TAG_MAX_CHARS);
  // 上限 5 条
  let many = {};
  for (const t of ['一', '二', '三', '四', '五', '六']) many = addAffectionTag(many, '雪月', t);
  assert.equal(many['雪月'].affection.tags.length, AFFECTION_TAGS_LIMIT);
  // 不动分数
  const withScore = { 雪月: { affection: { score: 40, tags: [] } } };
  r = addAffectionTag(withScore, '雪月', '投缘');
  assert.deepEqual(r['雪月'].affection, { score: 40, tags: ['投缘'] });
});

test('getAffection：缺记录读回 0 / 无标签', () => {
  assert.deepEqual(getAffection({}, '雪月'), { score: 0, tags: [] });
  assert.deepEqual(getAffection({ 雪月: { affection: { score: 30, tags: ['投缘'] } } }, '雪月'), { score: 30, tags: ['投缘'] });
});

test('原型污染键名：set/adjust/addTag 都不写入', () => {
  const r1 = setAffection({}, '__proto__', 50);
  assert.equal(Object.prototype.affection, undefined);
  assert.deepEqual(r1, {});
  const r2 = adjustAffection({}, 'constructor', 10);
  assert.deepEqual(r2, {});
  const r3 = addAffectionTag({}, 'prototype', '投缘');
  assert.deepEqual(r3, {});
});

test('纯函数：不改传入的 memberImpressions', () => {
  const base = { 王江: { affection: { score: 10, tags: ['话少'] } } };
  const snapshot = JSON.stringify(base);
  adjustAffection(base, '王江', 5);
  setAffection(base, '王江', 99);
  addAffectionTag(base, '王江', '新标签');
  assert.equal(JSON.stringify(base), snapshot);
});

test('渲染：好感度出现在印象行，没写过好感度的老数据不渲染', () => {
  const withAffection = {
    memberImpressions: {
      雪月: { traits: ['话多'], interactionCount: 5, affection: { score: 70, tags: ['投缘'] } }
    }
  };
  const out1 = renderMemory(withAffection, { now: NOW });
  assert.match(out1, /【对群友的印象】/);
  assert.match(out1, /好感度 70·亲近/);
  assert.match(out1, /关系标签：投缘/);

  // 只有 risk 没有 affection 的老数据：渲染边界，但不渲染好感度（不凭空补「一般」）
  const legacy = {
    memberImpressions: {
      雪月: { traits: ['要过亲属称呼，已拒绝'], interactionCount: 3, noKinshipTitle: true }
    }
  };
  const out2 = renderMemory(legacy, { now: NOW });
  assert.doesNotMatch(out2, /好感度/);
  assert.match(out2, /边界：不叫亲属称呼/);
});
