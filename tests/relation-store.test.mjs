import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelationStore } from '../src/content/relation-store.js';

const DAY = 86_400_000;
// 固定假时钟：本模块约定不读 Date.now()，时间全部由注入的 now 提供。
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const OWNER_OPTS = { key: 'private:10001', kind: 'private', isOwner: true };

/** 内存版注入：read/write 共享一个变量，peek 只看不写。 */
function memoryState(initial = null) {
  let value = initial;
  return {
    read: () => value,
    write: (next) => { value = next; },
    peek: () => value
  };
}

function relationsWith({ key = 'private:10001', events = [], topics = [] } = {}) {
  return {
    [key]: {
      profile: { 称呼: '', 雷点: [], 禁忌: [] },
      events,
      recentTopics: topics
    }
  };
}

const bulletCount = (block) => block.split('\n').filter((line) => line.startsWith('- ')).length;

test('空状态：list / formatForPrompt 为空，append 能建立结构', () => {
  const io = memoryState(null);
  const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });

  assert.deepEqual(store.list(), []);
  assert.equal(store.formatForPrompt(), '');
  assert.equal(store.formatForPrompt(8, OWNER_OPTS), '');

  assert.deepEqual(store.append({ key: 'private:10001', type: 'topic', text: '在准备考研' }), {
    ok: true,
    key: 'private:10001',
    type: 'topic'
  });
  assert.deepEqual(io.peek(), {
    'private:10001': {
      profile: { 称呼: '', 雷点: [], 禁忌: [] },
      events: [],
      recentTopics: [{ text: '在准备考研', lastMentionAt: NOW }]
    }
  });
});

test('坏结构降级：null / 非对象 / 非法 key / 坏条目一律返回 []，不抛', () => {
  const bads = [
    undefined,
    null,
    'oops',
    42,
    [],
    { bad: {} },
    { 'private:x': { events: [] } },
    { 'private:1': 'nope' },
    { 'private:1': { events: 'nope', recentTopics: null } }
  ];
  for (const bad of bads) {
    const io = memoryState(bad);
    const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });
    assert.deepEqual(store.list(), [], `坏结构应降级为空数组：${String(bad)}`);
    assert.equal(store.formatForPrompt(5, { key: 'private:1', kind: 'private', isOwner: true }), '');
  }

  // read 缺省同样不炸；write 缺省则明确降级，不谎报成功
  assert.deepEqual(createRelationStore({ now: () => NOW }).list(), []);
  const readOnly = createRelationStore({ read: () => null, now: () => NOW });
  const denied = readOnly.append({ key: 'private:1', type: 'event', text: 'x' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DEP_MISSING');
});

test('append 去重：topic 按文本刷新时间，event 按同日同文去重', () => {
  let clock = NOW;
  const io = memoryState(null);
  const store = createRelationStore({ read: io.read, write: io.write, now: () => clock });

  store.append({ key: 'private:10001', type: 'topic', text: '在准备考研' });
  clock = NOW + DAY;
  store.append({ key: 'private:10001', type: 'topic', text: '在准备考研' });
  const topics = io.peek()['private:10001'].recentTopics;
  assert.equal(topics.length, 1);
  assert.equal(topics[0].lastMentionAt, NOW + DAY);

  store.append({ key: 'private:10001', type: 'event', text: '一起去吃了火锅', date: '2026-10-20' });
  store.append({ key: 'private:10001', type: 'event', text: '一起去吃了火锅', date: '2026-10-20' });
  assert.equal(io.peek()['private:10001'].events.length, 1);

  // 同日不同文、同文不同日都不算重复
  store.append({ key: 'private:10001', type: 'event', text: '一起去吃了火锅', date: '2026-10-21' });
  store.append({ key: 'private:10001', type: 'event', text: '换了新工作', date: '2026-10-20' });
  assert.equal(io.peek()['private:10001'].events.length, 3);

  // 非法入参不写盘
  const before = io.peek();
  assert.equal(store.append({ key: 'bad-key', text: 'x' }).ok, false);
  assert.equal(io.peek(), before);
});

test('append 后 list 立即可见（读走注入的 read）', () => {
  const io = memoryState(null);
  const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });
  assert.deepEqual(store.list(), []);

  store.append({ key: 'group:200', type: 'event', text: '群友约了周末爬山', date: '2026-10-25' });
  const rows = store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'group:200');
  assert.equal(rows[0].type, 'event');
  assert.equal(rows[0].kind, 'event');
  assert.equal(rows[0].text, '群友约了周末爬山');
  assert.equal(rows[0].lastMentionAt, Date.UTC(2026, 9, 25));
});

test('formatForPrompt 按衰减排序：越旧越先被挤出，topic 比 event 抗衰减', () => {
  const io = memoryState(relationsWith({
    topics: [
      { text: '很久以前聊过的旧话题', lastMentionAt: NOW - 60 * DAY },
      { text: '昨天刚聊的新话题', lastMentionAt: NOW - DAY }
    ]
  }));
  const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });

  const one = store.formatForPrompt(1, OWNER_OPTS);
  assert.match(one, /昨天刚聊的新话题/);
  assert.doesNotMatch(one, /很久以前聊过的旧话题/);

  const all = store.formatForPrompt(8, OWNER_OPTS);
  assert.match(all, /昨天刚聊的新话题/);
  assert.match(all, /很久以前聊过的旧话题/);
  assert.ok(all.indexOf('昨天刚聊的新话题') < all.indexOf('很久以前聊过的旧话题'));

  // 同样 20 天前：topic（30 天半衰期）比 event（7 天半衰期）分高
  const mixed = memoryState(relationsWith({
    events: [{ date: '2026-10-07', text: '二十天前的一件旧事' }],
    topics: [{ text: '二十天前聊的话题', lastMentionAt: NOW - 20 * DAY }]
  }));
  const mixedStore = createRelationStore({ read: mixed.read, write: mixed.write, now: () => NOW });
  const block = mixedStore.formatForPrompt(1, OWNER_OPTS);
  assert.match(block, /二十天前聊的话题/);
  assert.doesNotMatch(block, /二十天前的一件旧事/);
});

test('limit 生效：按条数截断，0 / 负数给空串', () => {
  const events = ['01', '03', '05', '07', '09', '11', '13', '15', '17']
    .map((day) => ({ date: `2026-10-${day}`, text: `第 ${day} 天的旧事` }));
  const io = memoryState(relationsWith({ events }));
  const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });

  assert.equal(bulletCount(store.formatForPrompt(2, OWNER_OPTS)), 2);
  assert.equal(bulletCount(store.formatForPrompt(5, OWNER_OPTS)), 5);
  // limit 缺省为 8：与显式传 8 等价（formatRelationBlock 自身最多渲染 5 条 event）
  assert.equal(store.formatForPrompt(undefined, OWNER_OPTS), store.formatForPrompt(8, OWNER_OPTS));
  assert.equal(store.formatForPrompt(0, OWNER_OPTS), '');
  assert.equal(store.formatForPrompt(-1, OWNER_OPTS), '');
});

test('超限条目被挤出注入文本，但存储与 list 一条不少', () => {
  const events = ['01', '02', '03', '04', '05', '06']
    .map((day) => ({ date: `2026-10-${day}`, text: `事件${day}` }));
  const io = memoryState(relationsWith({ events }));
  const store = createRelationStore({ read: io.read, write: io.write, now: () => NOW });

  const block = store.formatForPrompt(2, OWNER_OPTS);
  assert.equal(bulletCount(block), 2);

  assert.equal(store.list().length, 6);
  const kept = io.peek()['private:10001'].events;
  assert.equal(kept.length, 6);
  assert.deepEqual(kept.map((event) => event.text).sort(), ['事件01', '事件02', '事件03', '事件04', '事件05', '事件06']);
});
