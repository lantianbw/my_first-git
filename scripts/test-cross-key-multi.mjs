// 多会话【另一边】回归：半小时窗口、多私聊、媒体说明、群聊隐私。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { buildCrossKeyMultiBlock, messageBody, CROSS_KEY_DEFAULTS } from '../src/cross-key.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const now = Date.now();
const config = { ...CROSS_KEY_DEFAULTS, windowMs: 1_800_000, maxChars: 1200 };

test('多会话：只取最近半小时，各会话分段', () => {
  const peers = [
    {
      key: 'group:1',
      kind: 'group',
      label: '群聊',
      state: {
        recentMessages: [
          { sender: '张三', text: '刚说的', time: now - 60_000 },
          { sender: '李四', text: '两小时前的', time: now - 2 * 3_600_000 }
        ]
      }
    },
    {
      key: 'private:9271',
      kind: 'private',
      label: '私聊9271',
      state: {
        recentMessages: [
          { sender: '热破', text: '私聊刚说的', time: now - 120_000 },
          { sender: '热破', text: '很久以前', time: now - 3 * 3_600_000 }
        ]
      }
    }
  ];
  const built = buildCrossKeyMultiBlock({ currentKind: 'private', peers, config, now });
  assert.ok(built.block.includes('（群聊）最近半小时'));
  assert.ok(built.block.includes('（私聊9271）最近半小时'));
  assert.ok(built.block.includes('刚说的'));
  assert.ok(built.block.includes('私聊刚说的'));
  assert.ok(!built.block.includes('两小时前的'), '超出半小时窗口不得注入');
  assert.ok(!built.block.includes('很久以前'));
});

test('媒体说明：mediaText 优先，其次表情备注', () => {
  assert.equal(messageBody({ text: '', mediaText: ['[图片] 文字：群友在打游戏'] }), '[图片] 文字：群友在打游戏');
  assert.equal(messageBody({ text: '看这个', mediaText: ['[图片] 文字：笑死'] }), '看这个 [图片] 文字：笑死');
  assert.equal(messageBody({ text: '', media: [{ kind: 'face', summary: '笑' }] }), '[表情：笑]');
  assert.equal(messageBody({ text: '', media: [{ kind: 'sticker', summary: '猫猫点头' }] }), '[表情包：猫猫点头]');
  assert.equal(messageBody({ text: '', media: [{ kind: 'image' }] }), '[图片]');
  assert.equal(messageBody({ text: '' }), '');
});

test('纯媒体消息也能进【另一边】', () => {
  const peers = [{
    key: 'private:9271',
    kind: 'private',
    label: '私聊9271',
    state: {
      recentMessages: [
        { sender: '热破', text: '', mediaText: ['[图片] 文字：群友在打游戏'], time: now - 60_000 },
        { sender: '热破', text: '', media: [{ kind: 'face', summary: '笑' }], time: now - 90_000 }
      ]
    }
  }];
  const built = buildCrossKeyMultiBlock({ currentKind: 'private', peers, config, now });
  assert.ok(built.block.includes('[图片] 文字：群友在打游戏'));
  assert.ok(built.block.includes('[表情：笑]'));
  assert.equal(built.recentCount, 2);
});

test('群聊视角：topics 模式不给私聊原文', () => {
  const peers = [{
    key: 'private:123',
    kind: 'private',
    label: '私聊',
    state: {
      recentMessages: [{ sender: '饲养员', text: '私密内容', time: now - 60_000 }],
      activeTopics: [{ text: '周末实验', lastMentionAt: now }]
    }
  }];
  const topics = buildCrossKeyMultiBlock({ currentKind: 'group', peers, config, now });
  assert.ok(!topics.block.includes('私密内容'), '群里不得出现私聊原文');
  assert.ok(topics.block.includes('周末实验'));

  const full = buildCrossKeyMultiBlock({ currentKind: 'group', peers, config: { ...config, privateToGroup: 'full' }, now });
  assert.ok(full.block.includes('私密内容'), 'full 模式才允许原文');
});

test('窗口内没有消息时回退到话题', () => {
  const peers = [{
    key: 'group:1',
    kind: 'group',
    label: '群聊',
    state: {
      recentMessages: [{ sender: '张三', text: '老消息', time: now - 2 * 3_600_000 }],
      activeTopics: [{ text: '进行中的话题', lastMentionAt: now }]
    }
  }];
  const built = buildCrossKeyMultiBlock({ currentKind: 'private', peers, config, now });
  assert.ok(!built.block.includes('老消息'));
  assert.ok(built.block.includes('进行中的话题'));
});

await test('bridge：owner 私聊带群+其他私聊；群友私聊只看群；群聊不带私聊原文', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.appendSocialV2Message('group:456', '张三', '群里刚说的', '群里刚说的', false, false, '9001', [], '9001', []);
    h.appendSocialV2Message('private:9271', '热破', '群友私聊里说的', '群友私聊里说的', false, false, '9002', [], '9271', []);
    h.appendSocialV2Message('private:123', '饲养员', 'owner 私聊里说的', 'owner 私聊里说的', false, true, '9003', [], '123', []);

    const owner = h.buildWakePromptV2('private:123', 'bootstrap');
    assert.ok(owner.includes('（群聊）最近半小时'));
    assert.ok(owner.includes('群里刚说的'));
    assert.ok(owner.includes('（私聊9271）最近半小时'), '其他私聊应带标签');
    assert.ok(owner.includes('群友私聊里说的'));

    const friend = h.buildWakePromptV2('private:9271', 'bootstrap');
    assert.ok(friend.includes('群里刚说的'));
    assert.ok(!friend.includes('owner 私聊里说的'), '群友私聊不得看到 owner 私聊内容');

    const group = h.buildWakePromptV2('group:456', 'bootstrap');
    assert.ok(!group.includes('owner 私聊里说的'), '群聊不得出现私聊原文');
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
