// 关系线回归：归一化/追加/注入格式/隐私分支。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { normalizeRelations, appendRelationEntry, formatRelationBlock, RELATION_LIMITS } from '../src/relations.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const now = Date.now();

test('归一化：坏 key 丢弃、events 日期倒序、条数上限', () => {
  const normalized = normalizeRelations({
    'private:123': {
      profile: { 称呼: '饲养员', 雷点: ['别叫他大肥鱼'], 禁忌: ['聊家人'] },
      events: [
        { date: '2026-10-21', text: '旧事件' },
        { date: '2026-10-23', text: '新事件' },
        { date: 'bad-date', text: '坏日期' }
      ],
      recentTopics: [{ text: '周末实验', lastMentionAt: now }]
    },
    'wechat:1': { events: [] },
    'private:456': { events: Array.from({ length: 230 }, (_, i) => ({ date: '2026-10-01', text: `e${i}` })) }
  });
  assert.deepEqual(Object.keys(normalized).sort(), ['private:123', 'private:456']);
  assert.equal(normalized['private:123'].events[0].text, '新事件');
  assert.equal(normalized['private:456'].events.length, RELATION_LIMITS.maxEvents);
  assert.equal(normalized['private:123'].profile['称呼'], '饲养员');
});

test('追加 event：同一天同文本去重，超长截断 60', () => {
  const long = 'x'.repeat(100);
  const first = appendRelationEntry({}, 'private:123', { type: 'event', text: long, date: '2026-10-23', now });
  assert.equal(first.ok, true);
  assert.equal(first.relations['private:123'].events[0].text.length, 60);
  const second = appendRelationEntry(first.relations, 'private:123', { type: 'event', text: long, date: '2026-10-23', now });
  assert.equal(second.relations['private:123'].events.length, 1, '同日同文本不重复');
  const third = appendRelationEntry(second.relations, 'private:123', { type: 'event', text: '另一件事', date: '2026-10-23', now });
  assert.equal(third.relations['private:123'].events.length, 2);
  assert.equal(third.relations['private:123'].events[0].text, '另一件事', '最新的在前');
});

test('追加 topic：重复文本刷新时间，上限 20', () => {
  let relations = {};
  for (let i = 0; i < 25; i += 1) {
    relations = appendRelationEntry(relations, 'group:456', { type: 'topic', text: `话题${i}`, now: now + i }).relations;
  }
  assert.equal(relations['group:456'].recentTopics.length, RELATION_LIMITS.maxTopics);
  const refreshed = appendRelationEntry(relations, 'group:456', { type: 'topic', text: '话题24', now: now + 999 }).relations;
  assert.equal(refreshed['group:456'].recentTopics[0].text, '话题24');
  assert.equal(refreshed['group:456'].recentTopics.filter((t) => t.text === '话题24').length, 1);
});

test('非法 key / 空 text 被拒', () => {
  assert.equal(appendRelationEntry({}, 'wechat:1', { text: 'x' }).ok, false);
  assert.equal(appendRelationEntry({}, 'private:123', { text: '  ' }).ok, false);
});

test('注入：owner 私聊含事件/话题/雷点，群聊只含公共信息，其他私聊为空', () => {
  const relations = {
    'private:123': {
      profile: { 称呼: '饲养员', 雷点: ['别叫他大肥鱼'], 禁忌: ['聊家人'] },
      events: [
        { date: '2026-10-23', text: '说周末两天实验，抱怨' },
        { date: '2026-10-22', text: '改配置到凌晨' }
      ],
      recentTopics: [{ text: '周末实验', lastMentionAt: now - 2 * 86_400_000 }]
    },
    'group:456': {
      profile: { 称呼: '小鲸鱼', 雷点: ['被叫蓝色大肥鱼'], 禁忌: ['聊家人'] },
      events: [{ date: '2026-10-23', text: '私事不该出现在群里' }],
      recentTopics: [{ text: '私聊话题', lastMentionAt: now }]
    }
  };

  const owner = formatRelationBlock(relations, { key: 'private:123', kind: 'private', isOwner: true, now });
  assert.ok(owner.includes('【你和 TA 的关系线】'));
  assert.ok(owner.includes('周末两天实验'));
  assert.ok(owner.includes('最近话题：周末实验（2 天前）'));
  assert.ok(owner.includes('雷点'));

  const group = formatRelationBlock(relations, { key: 'group:456', kind: 'group', isOwner: false, now });
  assert.ok(group.includes('【你和 TA 的关系线】'));
  assert.ok(group.includes('小鲸鱼'));
  assert.ok(!group.includes('私事'), '群聊不得出现私事 events');
  assert.ok(!group.includes('私聊话题'), '群聊不得出现私聊话题');

  const other = formatRelationBlock(relations, { key: 'private:789', kind: 'private', isOwner: false, now });
  assert.equal(other, '');

  const longBlock = formatRelationBlock({
    'private:123': {
      profile: { 称呼: '饲养员', 雷点: [], 禁忌: [] },
      events: Array.from({ length: 5 }, (_, i) => ({ date: '2026-10-23', text: '很长的事件描述'.repeat(8) + i })),
      recentTopics: []
    }
  }, { key: 'private:123', kind: 'private', isOwner: true, now, maxChars: 120 });
  assert.ok([...longBlock].length <= 120, '必须截断到 maxChars');
});

await test('唤醒提示词：owner 有块、群聊有公共块、群友私聊没有', async () => {
  const h = await bridgeHarness({
    files: {
      'state/relations.json': {
        'private:123': {
          profile: { 称呼: '饲养员', 雷点: ['别叫他大肥鱼'], 禁忌: ['聊家人'] },
          events: [{ date: '2026-10-23', text: '说周末两天实验，抱怨' }],
          recentTopics: [{ text: '周末实验', lastMentionAt: Date.now() - 86_400_000 }]
        },
        'group:456': {
          profile: { 称呼: '小鲸鱼', 雷点: ['被叫蓝色大肥鱼'], 禁忌: [] },
          events: [{ date: '2026-10-23', text: '私事' }],
          recentTopics: []
        }
      }
    }
  });
  try {
    h.setMode('reserved2');
    const owner = h.buildWakePromptV2('private:123', 'bootstrap');
    assert.ok(owner.includes('【你和 TA 的关系线】'));
    assert.ok(owner.includes('周末两天实验'));

    const group = h.buildWakePromptV2('group:456', 'bootstrap');
    assert.ok(group.includes('【你和 TA 的关系线】'));
    assert.ok(group.includes('小鲸鱼'));
    assert.ok(!group.includes('私事'), '群聊不得带私事');

    const other = h.buildWakePromptV2('private:456', 'bootstrap');
    assert.ok(!other.includes('【你和 TA 的关系线】'));
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
