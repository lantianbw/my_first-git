// tests/scheduler-wake.test.mjs — scheduler/wake 单测（优先级查表 + 合并升级）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec, WAKE_PRIORITY, TIMER_WAKE_REASONS,
  wakeReasonBase, wakePriority, isTimerWakeReason, mergeWakeReason, handle
} from '../src/scheduler/wake.js';

test('契约：spec 冻结、名字与路径一致', () => {
  assert.equal(spec.name, 'scheduler/wake');
  assert.ok(Object.isFrozen(spec));
  assert.equal(spec.toggle.hot, true);
});

test('优先级表与旧实现逐值一致', () => {
  assert.deepEqual({ ...WAKE_PRIORITY }, {
    private: 100, atMention: 90, question: 80, speaker: 75, nameMention: 70,
    keyword: 60, anyMessage: 50, replyCheck: 40, diarySettle: 38, lifeMorning: 35,
    timeout: 30, weeklyDigest: 26, lifeDiscovery: 25, proactiveCheck: 20
  });
});

test('wakeReasonBase：只取冒号前基名', () => {
  assert.equal(wakeReasonBase('keyword:小鲸鱼'), 'keyword');
  assert.equal(wakeReasonBase('atMention'), 'atMention');
  assert.equal(wakeReasonBase(''), '');
  assert.equal(wakeReasonBase(null), '');
  assert.equal(wakeReasonBase(undefined), '');
});

test('wakePriority：已登记取表值，未登记为 0', () => {
  assert.equal(wakePriority('private'), 100);
  assert.equal(wakePriority('keyword:小鲸鱼'), 60);
  assert.equal(wakePriority('speaker:昵称'), 75);
  assert.equal(wakePriority('unknownReason'), 0);
  assert.equal(wakePriority(null), 0);
});

test('wakePriority：子类型不影响分数', () => {
  assert.equal(wakePriority('keyword:a'), wakePriority('keyword:b'));
});

test('isTimerWakeReason：定时器类命中，消息类不命中', () => {
  for (const r of TIMER_WAKE_REASONS) assert.equal(isTimerWakeReason(r), true, r);
  assert.equal(isTimerWakeReason('atMention'), false);
  assert.equal(isTimerWakeReason('keyword:猫'), false);
  assert.equal(isTimerWakeReason('diarySettle:2026-10-28'), true);
  assert.equal(isTimerWakeReason(undefined), false);
});

test('mergeWakeReason：更高优先级才升级', () => {
  assert.deepEqual(mergeWakeReason('anyMessage', 'atMention'), { reason: 'atMention', upgraded: true });
  assert.deepEqual(mergeWakeReason('atMention', 'keyword:猫'), { reason: 'atMention', upgraded: false });
});

test('mergeWakeReason：同优先级不升级', () => {
  assert.deepEqual(mergeWakeReason('keyword:a', 'keyword:b'), { reason: 'keyword:a', upgraded: false });
});

test('mergeWakeReason：未登记原因无法覆盖已登记原因', () => {
  assert.deepEqual(mergeWakeReason('timeout', 'nonsense'), { reason: 'timeout', upgraded: false });
  assert.deepEqual(mergeWakeReason('nonsense', 'timeout'), { reason: 'timeout', upgraded: true });
});

test('handle：priority / timer / merge 正常，未知 action 拒绝', () => {
  assert.equal(handle({}, { action: 'priority', reason: 'private' }).value, 100);
  assert.equal(handle({}, { action: 'timer', reason: 'timeout' }).value, true);
  assert.equal(handle({}, { action: 'merge', current: 'anyMessage', incoming: 'private' }).value.upgraded, true);
  const bad = handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
});
