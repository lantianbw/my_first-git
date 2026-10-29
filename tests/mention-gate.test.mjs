// 钉住 M4「点名与调度」（docs/module-ownership.md M4 / chat-trap-review.md §6-6）。
//
// 目标：@/叫名字/被引用 只保证「会看」（消息进 unread），不保证「一定接」；
//       同一人连续点名 3 次以上（期间 AI 没回过话）时，@/名字 不再单独触发唤醒。
// 落点：bridge.js `evaluateWakeTriggerV2` 一带（`MENTION_GATE_THRESHOLD` + `advanceMentionChainV2`）。
//
// 为什么分两段测：bridge.js 不可 import（import 会跑 main() 起整个桥），
// 所以行为规范用一份与 bridge.js 逐行对齐的镜像函数来锁「连续点名」判定；
// 接线是否正确则由「读源码断言」兜底（同 tests/inbound-file-risk.test.mjs 的接线检查）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BRIDGE = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');

// ── 行为规范：advanceMentionChainV2 的镜像（与 bridge.js 实现逐行一致） ──────────
// 规则：
//   · 换人点名 / AI 在链期间回过话 → 重新从 1 计；
//   · 同一人、AI 未回 → 计数 +1；
//   · 空 speaker 每次都被当成「新人」，恒为 1（等于不累计）。
function advanceChain(state, speakerId) {
  const sid = String(speakerId ?? '');
  const lastReply = Number(state.lastAiReplyAt) || 0;
  const chainReplyAt = Number(state.mentionChainLastReplyAt) || 0;
  const sameSpeaker = sid !== '' && state.mentionChainSpeakerId === sid;
  const aiReplied = lastReply > chainReplyAt;
  if (!sameSpeaker || aiReplied) {
    state.mentionChainSpeakerId = sid;
    state.mentionChainCount = 1;
    state.mentionChainLastReplyAt = lastReply;
    return 1;
  }
  const next = (Number(state.mentionChainCount) || 0) + 1;
  state.mentionChainCount = next;
  return next;
}

const freshState = () => ({ lastAiReplyAt: 0 });

test('连续点名：同一人第 1/2 次仍唤醒，第 3 次起计入闸门', () => {
  const st = freshState();
  assert.equal(advanceChain(st, '10001'), 1);
  assert.equal(advanceChain(st, '10001'), 2);
  assert.equal(advanceChain(st, '10001'), 3);
  assert.equal(advanceChain(st, '10001'), 4);
  assert.equal(st.mentionChainSpeakerId, '10001');
});

test('换人点名：连续被打破，重新从 1 计', () => {
  const st = freshState();
  advanceChain(st, '10001');
  advanceChain(st, '10001');
  assert.equal(advanceChain(st, '10002'), 1, '换人后从 1 计');
  assert.equal(advanceChain(st, '10001'), 1, '再换回 A 也从 1 计');
});

test('AI 在链期间回过话：连续被打破，重新从 1 计', () => {
  const st = freshState();
  advanceChain(st, '10001');
  advanceChain(st, '10001');
  st.lastAiReplyAt = 123456; // AI 回了一句
  assert.equal(advanceChain(st, '10001'), 1);
});

test('AI 在链开始之前回过话：不算打断，继续累加', () => {
  const st = { lastAiReplyAt: 999 };
  assert.equal(advanceChain(st, '10001'), 1, '首次点名把链快照到 999');
  assert.equal(advanceChain(st, '10001'), 2, 'lastReply 仍是 999，等于快照，不重置');
});

test('空 speaker：每次都当新链，恒为 1（不累计）', () => {
  const st = freshState();
  assert.equal(advanceChain(st, ''), 1);
  assert.equal(advanceChain(st, undefined), 1);
  assert.equal(advanceChain(st, null), 1);
});

test('阈值钉死为 3，且闸门函数与调用点各只有一处', () => {
  assert.match(BRIDGE, /const MENTION_GATE_THRESHOLD = 3;/);
  assert.match(BRIDGE, /function advanceMentionChainV2\(/);
  assert.equal((BRIDGE.match(/advanceMentionChainV2/g) || []).length, 2, '定义 1 处 + 调用 1 处');
});

test('闸门只在「点名」时推进，且在关键词/提问之前判断', () => {
  const isMention = BRIDGE.indexOf('const isMention = atSelf || quoted || byName;');
  const call = BRIDGE.indexOf('const chainCount = advanceMentionChainV2(st, speakerId)');
  const kw = BRIDGE.indexOf('if (Array.isArray(tr.keywords)');
  assert.ok(isMention > 0, '找不到 isMention 判定');
  assert.ok(call > 0, '找不到闸门调用点');
  assert.ok(kw > 0, '找不到关键词触发');
  assert.ok(isMention < call, '闸门调用必须在 isMention 判定之后（只有点名才推进）');
  assert.ok(call < kw, '点名门必须在关键词/提问等触发之前判断');
});

test('闸门依据 AI 是否回过来重置：读 lastAiReplyAt 与 mentionChainCount', () => {
  const fn = BRIDGE.slice(
    BRIDGE.indexOf('function advanceMentionChainV2'),
    BRIDGE.indexOf('function evaluateWakeTriggerV2')
  );
  assert.match(fn, /lastAiReplyAt/);
  assert.match(fn, /mentionChainCount/);
});

test('达到阈值后不再返回 atMention/nameMention，落回其余触发，并留线上观察痕迹', () => {
  const fn = BRIDGE.slice(
    BRIDGE.indexOf('function evaluateWakeTriggerV2'),
    BRIDGE.indexOf('// ── scheduler/triggers 影子')
  );
  // 只有 chainCount < 阈值 时才 return atMention/nameMention；达到阈值则落空、继续往下判断
  assert.match(fn, /if \(chainCount < MENTION_GATE_THRESHOLD\)/);
  // 闸门命中时打一条可 grep 的 activity，供线上观察「点名不再 100% 入场」
  assert.match(fn, /\[mention-gate\]/);
});
