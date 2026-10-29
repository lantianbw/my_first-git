import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, renderMemory, handle } from '../src/content/memory-render.js';

const NOW = 1_800_000_000_000;

test('spec 契约形状', () => {
  assert.equal(spec.name, 'content/memory-render');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('空状态：返回空串，不产生任何标题', () => {
  assert.equal(renderMemory({}, { now: NOW }), '');
  assert.equal(renderMemory(null, { now: NOW }), '');
  assert.equal(renderMemory({ activeTopics: [], pendingThoughts: [], memberImpressions: {} }, { now: NOW }), '');
});

test('now 缺失或非数字：抛 TypeError（不静默读系统时钟）', () => {
  assert.throws(() => renderMemory({}, {}), TypeError);
  assert.throws(() => renderMemory({}, { now: '123' }), TypeError);
  assert.throws(() => renderMemory({}, { now: NaN }), TypeError);
});

test('话题：渲染标题、条目与「分钟前」，超过 2 小时标已搁置', () => {
  const st = {
    activeTopics: [
      { text: '搬家的事', lastMentionAt: NOW - 5 * 60 * 1000 },
      { text: '罐头账', lastMentionAt: NOW - 3 * 60 * 60 * 1000 },
      { text: '', lastMentionAt: NOW }   // 空文本应被过滤
    ]
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /【进行中的话题】/);
  assert.match(out, /搬家的事（5分钟前）/);
  assert.match(out, /罐头账（已搁置）/);
});

test('待追问与「想说没说」：过期的想法不渲染', () => {
  const st = {
    activeTopics: [{ text: '比赛', lastMentionAt: NOW, pendingQuestion: '他到底去不去' }],
    pendingThoughts: [
      { text: '想问他票买了没', motivation: '关心', expiresAt: NOW + 60_000 },
      { text: '这条已过期', expiresAt: NOW - 1 }
    ]
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /待追问：他到底去不去/);
  assert.match(out, /【你想说但还没说的】/);
  assert.match(out, /想问他票买了没（关心）/);
  assert.doesNotMatch(out, /这条已过期/);
});

test('群友印象：无 traits 给「暂无记录」，有 traits 用顿号连接', () => {
  const st = {
    memberImpressions: {
      王江: { traits: ['爱发表情包', '话少'], interactionCount: 12 },
      雪月: {}
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /【对群友的印象】/);
  assert.match(out, /王江：爱发表情包、话少（互动 12 次）/);
  assert.match(out, /雪月：暂无记录（互动 0 次）/);
});

test('群友印象：noKinshipTitle 追加边界提示，没这个字段的不加', () => {
  const st = {
    memberImpressions: {
      雪月: { traits: ['要过亲属称呼，已拒绝'], interactionCount: 3, noKinshipTitle: true },
      王江: { traits: ['话少'], interactionCount: 2 }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /雪月：要过亲属称呼，已拒绝（互动 3 次）（边界：不叫亲属称呼，用名字或「你」）/);
  assert.match(out, /王江：话少（互动 2 次）$/m, '没有边界的人不追加任何东西');
});

test('limits 可截断三类条目', () => {
  const st = {
    activeTopics: [
      { text: 'A', lastMentionAt: NOW },
      { text: 'B', lastMentionAt: NOW },
      { text: 'C', lastMentionAt: NOW }
    ],
    pendingThoughts: [{ text: 'x', expiresAt: NOW + 1 }, { text: 'y', expiresAt: NOW + 1 }],
    memberImpressions: { p1: { traits: ['t'] }, p2: { traits: ['t'] }, p3: { traits: ['t'] } }
  };
  const out = renderMemory(st, { now: NOW, limits: { topicLimit: 1, thoughtLimit: 1, impressionLimit: 1 } });
  assert.equal((out.match(/^- /gm) || []).length, 3, '三类各留 1 条');
});

test('纯函数：同输入同 now 输出稳定，不改入参', () => {
  const st = { activeTopics: [{ text: 'A', lastMentionAt: NOW - 1000 }] };
  const before = JSON.stringify(st);
  const a = renderMemory(st, { now: NOW });
  const b = renderMemory(st, { now: NOW });
  assert.equal(a, b);
  assert.equal(JSON.stringify(st), before);
});

test('handle：契约形状 { ok, value }，与 renderMemory 一致', () => {
  const st = { activeTopics: [{ text: 'A', lastMentionAt: NOW }] };
  const result = handle({}, { state: st, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.value, renderMemory(st, { now: NOW }));
});
