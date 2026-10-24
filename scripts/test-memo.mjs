// 记忆三件套回归：增删改查、机械衰减、pending 生成、注入截断与隐私分支。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  addAgenda,
  addProfile,
  updateAgenda,
  updateProfile,
  removeMemo,
  settleMemos,
  formatMemoBlock,
  formatPendingBlock,
  normalizeSelfview
} from '../src/memo.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const now = Date.parse('2026-10-23T20:00:00+08:00');
const DAY = 86_400_000;

test('日程：新增默认 7 天、延长、删除', () => {
  const added = addAgenda([], { text: '明天要交实验报告', note: '有作业要交', now });
  assert.equal(added.list.length, 1);
  assert.equal(added.entry.expiresAt, now + 7 * DAY);
  assert.equal(added.entry.blurred, '有作业要交');

  const extended = updateAgenda(added.list, added.entry.id, { extendDays: 3, now });
  assert.ok(extended.entry.expiresAt >= now + 3 * DAY);

  const removed = removeMemo(extended.list, added.entry.id);
  assert.equal(removed.removed, true);
  assert.equal(removed.list.length, 0);
});

test('日程：到期条目在结算时删除', () => {
  const list = [
    { id: 'a1', text: '过期了', createdAt: now - 10 * DAY, expiresAt: now - DAY, strength: 1, source: 'ai' },
    { id: 'a2', text: '还没到期', createdAt: now - DAY, expiresAt: now + 5 * DAY, strength: 1, source: 'ai' }
  ];
  const settled = settleMemos({ agenda: list, profile: [], now });
  assert.equal(settled.agenda.length, 1);
  assert.equal(settled.agenda[0].text, '还没到期');
});

test('画像：同文本再次记入 = 加固，不新增', () => {
  const first = addProfile([], { text: '在减肥', note: '他说在控制饮食', now });
  assert.equal(first.created, true);
  assert.equal(first.entry.strength, 1);
  const second = addProfile(first.list, { text: '在减肥', now: now + 1000 });
  assert.equal(second.created, false);
  assert.equal(second.list.length, 1);
  assert.equal(second.entry.strength, 2);
  assert.equal(second.entry.lastConfirmedAt, now + 1000);
});

test('画像：14 天未确认且 strength<=2 → faded；strength>=3 保持 active 并进 pending', () => {
  const profile = [
    { id: 'p1', text: '在减肥', status: 'active', strength: 2, lastConfirmedAt: now - 15 * DAY, createdAt: now - 30 * DAY },
    { id: 'p2', text: '常熬夜', status: 'active', strength: 3, lastConfirmedAt: now - 15 * DAY, createdAt: now - 30 * DAY },
    { id: 'p3', text: '最近在学日语', status: 'active', strength: 1, lastConfirmedAt: now - 2 * DAY, createdAt: now - 5 * DAY }
  ];
  const settled = settleMemos({ agenda: [], profile, now });
  const byId = Object.fromEntries(settled.profile.map((item) => [item.id, item]));
  assert.equal(byId.p1.status, 'faded');
  assert.equal(byId.p2.status, 'active');
  assert.equal(byId.p3.status, 'active');
  assert.ok(settled.pending.some((item) => item.id === 'p2' && item.type === 'profile'));
});

test('结算 pending：3 天内到期才问，普通日程不问', () => {
  const agenda = [
    { id: 'a1', text: '两天后到期', createdAt: now, expiresAt: now + 2 * DAY, strength: 1, source: 'ai' },
    { id: 'a2', text: '六天后到期', createdAt: now, expiresAt: now + 6 * DAY, strength: 1, source: 'ai' }
  ];
  const settled = settleMemos({ agenda, profile: [], now });
  assert.equal(settled.pending.length, 1);
  assert.equal(settled.pending[0].id, 'a1');
  assert.equal(settled.pending[0].daysLeft, 2);
});

test('注入：【记忆】最多 3 日程 + 3 画像 + 1 句关系，且 ≤300 字', () => {
  const agenda = [
    { id: 'a1', text: '实验报告周五交', createdAt: now, expiresAt: now + 2 * DAY, strength: 1, source: 'ai' },
    { id: 'a2', text: '明天上午有课', createdAt: now, expiresAt: now + 1 * DAY, strength: 1, source: 'ai' },
    { id: 'a3', text: '周末回家', createdAt: now, expiresAt: now + 3 * DAY, strength: 1, source: 'ai' },
    { id: 'a4', text: '不该出现', createdAt: now, expiresAt: now + 6 * DAY, strength: 1, source: 'ai' }
  ];
  const profile = [
    { id: 'p1', text: '在减肥', status: 'active', strength: 3, lastConfirmedAt: now, createdAt: now },
    { id: 'p2', text: '常熬夜到两三点', status: 'active', strength: 2, lastConfirmedAt: now, createdAt: now },
    { id: 'p3', text: '在学日语', status: 'active', strength: 1, lastConfirmedAt: now, createdAt: now },
    { id: 'p4', text: '淡出的不该出现', status: 'faded', strength: 5, lastConfirmedAt: now, createdAt: now }
  ];
  const block = formatMemoBlock({
    agenda,
    profile,
    selfview: normalizeSelfview({ text: '跟他在一起踏实，但有时候觉得他太会哄人。' }),
    now
  });
  assert.ok(block.startsWith('【记忆】'));
  assert.ok(block.includes('明天上午有课'));
  assert.ok(block.includes('实验报告周五交'));
  assert.ok(!block.includes('不该出现'));
  assert.ok(!block.includes('淡出的不该出现'));
  assert.ok(block.includes('关系：跟他在一起踏实'));
  assert.ok([...block].length <= 300);

  const huge = formatMemoBlock({
    agenda: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, text: '很长的一条日程描述'.repeat(5), createdAt: now, expiresAt: now + DAY, strength: 1 })),
    profile: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, text: '很长的一条画像描述'.repeat(5), status: 'active', strength: 1, lastConfirmedAt: now, createdAt: now })),
    selfview: { text: '很长的一句关系描述'.repeat(10) },
    now
  });
  assert.ok([...huge].length <= 300, '必须截断到 300 字');
});

test('待结算块：只列事实，最多 5 条', () => {
  const block = formatPendingBlock([
    { type: 'agenda', id: 'a1', text: '实验报告', daysLeft: 2 },
    { type: 'profile', id: 'p1', text: '在减肥', strength: 3 }
  ]);
  assert.ok(block.startsWith('【待结算】'));
  assert.ok(block.includes('还剩 2 天：延长 3 天 / 模糊化 / 删除？'));
  assert.ok(block.includes('强度 3：记进日记 / 继续保留 / 淡出？'));
  assert.ok(!block.includes('你应该'));
  assert.equal(formatPendingBlock(Array.from({ length: 9 }, () => ({ type: 'agenda', text: 'x', daysLeft: 1 }))).split('\n').length, 6);
});

await test('隐私：owner 私聊注入【记忆】，群友私聊不注入', async () => {
  const h = await bridgeHarness({
    files: {
      'state/agenda.json': [{ id: 'a1', text: '明天要交实验报告', createdAt: Date.now(), expiresAt: Date.now() + 2 * DAY, strength: 1, source: 'ai' }],
      'state/profile.json': [{ id: 'p1', text: '在减肥', status: 'active', strength: 2, lastConfirmedAt: Date.now(), createdAt: Date.now() }],
      'state/selfview.json': { text: '跟他在一起踏实', updatedAt: Date.now() },
      'state/memo-settle-pending.json': { items: [{ type: 'agenda', id: 'a1', text: '明天要交实验报告', daysLeft: 2 }], updatedAt: Date.now() }
    }
  });
  try {
    h.setMode('reserved2');
    const owner = h.buildWakePromptV2('private:123', 'bootstrap');
    assert.ok(owner.includes('【记忆】'));
    assert.ok(owner.includes('明天要交实验报告'));
    assert.ok(owner.includes('在减肥'));
    assert.ok(owner.includes('【待结算】'));

    const friend = h.buildWakePromptV2('private:9271', 'bootstrap');
    assert.ok(!friend.includes('【记忆】'), '群友私聊不得注入');
    assert.ok(!friend.includes('明天要交实验报告'));
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
