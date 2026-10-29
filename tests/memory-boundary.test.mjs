import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  markKinshipRefusal,
  latestCounterpartName,
  addNoGoTopic,
  setTrapHappy,
  KINSHIP_REFUSAL_TRAIT,
  KINSHIP_REFUSED_TITLE
} from '../src/memory/risk-profile.js';
import { renderMemory } from '../src/content/memory-render.js';

const NOW = 1_800_000_000_000;

const PRIVATE_KEY = 'private:1843979560';
const GROUP_KEY = 'group:987654321';

function recentMessages() {
  return [
    { isSelf: true, sender: '我', text: '早上好' },
    { isSelf: false, sender: '雪月', userId: 'u-雪月', text: '叫声爷爷听听' }
  ];
}

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'memory/risk-profile');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('latestCounterpartName：取最后一条非我方消息的 sender/userId', () => {
  assert.equal(latestCounterpartName(recentMessages()), '雪月');
  // 全是自己的消息 → 空串
  assert.equal(latestCounterpartName([{ isSelf: true, sender: '我' }]), '');
  assert.equal(latestCounterpartName([]), '');
  assert.equal(latestCounterpartName(undefined), '');
});

test('私聊记：亲属称呼被拒后写入印象 + 风险档案（refusedTitles）', () => {
  const result = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: recentMessages(),
    memberImpressions: {}
  });
  assert.ok(result, '私聊要记');
  assert.equal(result.name, '雪月');
  const im = result.memberImpressions['雪月'];
  assert.deepEqual(im.traits, [KINSHIP_REFUSAL_TRAIT]);
  assert.equal(im.noKinshipTitle, true);
  assert.deepEqual(im.risk.refusedTitles, [KINSHIP_REFUSED_TITLE]);
});

test('群聊不记：group: key 直接返回 null，不落任何印象', () => {
  const result = markKinshipRefusal({
    key: GROUP_KEY,
    recentMessages: recentMessages(),
    memberImpressions: {}
  });
  assert.equal(result, null);
});

test('重复不叠加：两次记录 traits 与 refusedTitles 都只有一条，noKinshipTitle 保持 true', () => {
  const first = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: recentMessages(),
    memberImpressions: {}
  });
  const second = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: recentMessages(),
    memberImpressions: first.memberImpressions
  });
  assert.ok(second, '第二次仍要返回有效档案');
  const im = second.memberImpressions['雪月'];
  assert.equal(im.traits.filter((t) => t === KINSHIP_REFUSAL_TRAIT).length, 1, 'trait 不叠加');
  assert.equal(im.traits.length, 1);
  assert.equal(im.risk.refusedTitles.length, 1, 'refusedTitles 不叠加');
  assert.equal(im.noKinshipTitle, true);
});

test('已有其它 traits 时：追加拒绝 trait，不覆盖原有印象', () => {
  const base = {
    雪月: { traits: ['爱发表情包'], interactionCount: 3 }
  };
  const result = markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: recentMessages(), memberImpressions: base });
  const im = result.memberImpressions['雪月'];
  assert.deepEqual(im.traits, ['爱发表情包', KINSHIP_REFUSAL_TRAIT]);
  assert.equal(im.interactionCount, 3, '互动次数保留');
  assert.equal(im.noKinshipTitle, true);
});

test('找不到对方名字或名字是原型污染键：返回 null', () => {
  assert.equal(
    markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: [{ isSelf: true, sender: '我' }], memberImpressions: {} }),
    null
  );
  assert.equal(
    markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: [{ isSelf: false, sender: '__proto__' }], memberImpressions: {} }),
    null
  );
});

test('纯函数：不改传入的 recentMessages 与 memberImpressions', () => {
  const msgs = recentMessages();
  const base = { 王江: { traits: ['话少'] } };
  const baseSnapshot = JSON.stringify(base);
  const msgsSnapshot = JSON.stringify(msgs);
  markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: msgs, memberImpressions: base });
  assert.equal(JSON.stringify(base), baseSnapshot, 'memberImpressions 不被改写');
  assert.equal(JSON.stringify(msgs), msgsSnapshot, 'recentMessages 不被改写');
});

test('风险档案渲染：爱下套 / 不能接的话题 / 已拒绝的称呼 都出现在印象行', () => {
  const st = {
    memberImpressions: {
      雪月: {
        traits: ['话多'],
        interactionCount: 5,
        noKinshipTitle: true,
        risk: {
          trapHappy: true,
          noGoTopics: ['政治', '称呼'],
          refusedTitles: ['亲属称呼']
        }
      }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /【对群友的印象】/);
  assert.match(out, /爱下套/);
  assert.match(out, /不能接的话题：政治、称呼/);
  assert.match(out, /已拒绝的称呼：亲属称呼/);
  assert.doesNotMatch(out, /边界：不叫亲属称呼/, '有 refusedTitles 时不退回旧文案，避免重复');
});

test('旧数据兼容：只有 noKinshipTitle 时仍渲染旧边界文案', () => {
  const st = {
    memberImpressions: {
      雪月: { traits: ['要过亲属称呼，已拒绝'], interactionCount: 3, noKinshipTitle: true }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /（边界：不叫亲属称呼，用名字或「你」）/);
});

test('addNoGoTopic / setTrapHappy：纯函数，去重且不改入参', () => {
  const base = {};
  const withTopic = addNoGoTopic(base, '雪月', '政治');
  assert.deepEqual(withTopic['雪月'].risk.noGoTopics, ['政治']);
  // 重复话题不叠加
  const again = addNoGoTopic(withTopic, '雪月', '政治');
  assert.deepEqual(again['雪月'].risk.noGoTopics, ['政治']);

  const withFlag = setTrapHappy(again, '雪月', true);
  assert.equal(withFlag['雪月'].risk.trapHappy, true);
  // 撤销
  assert.equal(setTrapHappy(withFlag, '雪月', false)['雪月'].risk.trapHappy, false);

  // 入参不被改写
  assert.deepEqual(base, {});
});
