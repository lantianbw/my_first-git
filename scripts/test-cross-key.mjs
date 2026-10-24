// 跨会话交叉注入（C2）回归：方向、截断、空对方、关闭、topics 模式不含原文。
import assert from 'node:assert/strict';
import { buildCrossKeyBlock, normalizeCrossKeyConfig, CROSS_KEY_DEFAULTS } from '../src/cross-key.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };

const groupState = {
  recentMessages: [
    { sender: '张三', text: '今晚开黑吗', time: Date.parse('2026-10-22T20:00:00') },
    { sender: '我', text: '来', isSelf: true, time: Date.parse('2026-10-22T20:01:00') }
  ],
  activeTopics: [
    { text: '周末团建', pendingQuestion: '去哪', lastMentionAt: Date.now() },
    { text: '新出的显卡', lastMentionAt: Date.now() }
  ],
  pendingThoughts: [{ text: '想推荐那家烧烤', motivation: '上次去过' }]
};

const privateState = {
  recentMessages: [{ sender: '管理员', text: '私聊里的秘密内容', time: Date.parse('2026-10-22T21:00:00') }],
  activeTopics: [{ text: '私聊话题A' }, { text: '私聊话题B' }],
  pendingThoughts: [{ text: '想问他吃了吗', motivation: '关心' }]
};

// 1. 缺省值
{
  const d = normalizeCrossKeyConfig(undefined);
  assert.deepEqual(d, CROSS_KEY_DEFAULTS);
  assert.equal(normalizeCrossKeyConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeCrossKeyConfig({ privateToGroup: 'full' }).privateToGroup, 'full');
  assert.equal(normalizeCrossKeyConfig({ maxChars: 1 }).maxChars, 200);
  ok('缺省值与边界归一化');
}

// 2. private → group：最近消息 + 话题
{
  const r = buildCrossKeyBlock({ currentKind: 'private', peerState: groupState, config: normalizeCrossKeyConfig({}) });
  assert.match(r.block, /^【另一边】/);
  assert.match(r.block, /绝不主动提起/);
  assert.match(r.block, /张三/);
  assert.match(r.block, /今晚开黑吗/);
  assert.match(r.block, /周末团建/);
  assert.equal(r.recentCount, 2);
  assert.equal(r.topicCount, 2);
  ok('private 时注入 group 的消息与话题');
}

// 3. group → private（topics 模式）：只有话题/待说，不含消息原文
{
  const r = buildCrossKeyBlock({ currentKind: 'group', peerState: privateState, config: normalizeCrossKeyConfig({}) });
  assert.match(r.block, /私聊话题A/);
  assert.match(r.block, /想问他吃了吗/);
  assert.doesNotMatch(r.block, /私聊里的秘密内容/);
  assert.equal(r.recentCount, 0);
  ok('privateToGroup=topics 时不带私聊原文');
}

// 4. group → private（full 模式）：带消息原文
{
  const r = buildCrossKeyBlock({ currentKind: 'group', peerState: privateState, config: normalizeCrossKeyConfig({ privateToGroup: 'full' }) });
  assert.match(r.block, /私聊里的秘密内容/);
  assert.equal(r.recentCount, 1);
  ok('privateToGroup=full 时带私聊原文');
}

// 5. 空对方 / 关闭
{
  const empty = buildCrossKeyBlock({ currentKind: 'private', peerState: { recentMessages: [], activeTopics: [] }, config: normalizeCrossKeyConfig({}) });
  assert.equal(empty.block, '');
  const off = buildCrossKeyBlock({ currentKind: 'private', peerState: groupState, config: normalizeCrossKeyConfig({ enabled: false }) });
  assert.equal(off.block, '');
  ok('对方为空或关闭时不出现');
}

// 6. 条数上限
{
  const state = {
    recentMessages: Array.from({ length: 10 }, (_, i) => ({ sender: `人${i}`, text: `消息${i}`, time: Date.now() })),
    activeTopics: Array.from({ length: 8 }, (_, i) => ({ text: `话题${i}` }))
  };
  const r = buildCrossKeyBlock({ currentKind: 'private', peerState: state, config: normalizeCrossKeyConfig({ recentLimit: 2, memoryLimit: 1 }) });
  assert.equal(r.recentCount, 2);
  assert.equal(r.topicCount, 1);
  assert.doesNotMatch(r.block, /消息7/);
  assert.match(r.block, /话题7/);
  ok('recentLimit / memoryLimit 生效');
}

// 7. maxChars 硬截断
{
  const state = {
    recentMessages: Array.from({ length: 6 }, (_, i) => ({ sender: `发送者${i}`, text: '很长的内容'.repeat(20), time: Date.now() })),
    activeTopics: [{ text: '话题' }]
  };
  const r = buildCrossKeyBlock({ currentKind: 'private', peerState: state, config: normalizeCrossKeyConfig({ maxChars: 200 }) });
  assert.ok(r.block.length <= 200, `len=${r.block.length}`);
  assert.ok(r.block.endsWith('…'));
  ok('整块按 maxChars 截断');
}

// 8. 单条正文截断 60 字
{
  const longText = '字'.repeat(120);
  const r = buildCrossKeyBlock({
    currentKind: 'private',
    peerState: { recentMessages: [{ sender: '张三', text: longText, time: Date.now() }], activeTopics: [] },
    config: normalizeCrossKeyConfig({})
  });
  const line = r.block.split('\n').find((l) => l.includes('张三'));
  const body = line.split('：').pop();
  assert.ok(body.length <= 60, `body=${body.length}`);
  ok('单条消息正文截断 60 字');
}

console.log(`\n总计: ${passed} 项通过`);
