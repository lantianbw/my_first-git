// 日记三档回归：寿命、翻看、延长、升降档、搁着、软删、模糊视图、结算与注入隐私。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  DIARY_LEVELS,
  addDiary,
  openDiary,
  updateDiary,
  deleteDiary,
  normalizeDiary,
  fuzzyDiary,
  settleDiary,
  formatDiaryBlock,
  formatDiaryPendingBlock,
  diaryRemainingMs
} from '../src/diary.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const DAY = 86_400_000;
const now = Date.parse('2026-10-23T20:00:00+08:00');
const KEY = 'private:123';

test('三档初始寿命：normal 7 天 / important 21 天 / etched 90 天', () => {
  for (const [level, days] of [['normal', 7], ['important', 21], ['etched', 90]]) {
    const { entry } = addDiary([], { text: '值得记住的事', level, now });
    assert.equal(entry.level, level);
    assert.equal(entry.expiresAt, now + days * DAY, `${level} 初始寿命应为 ${days} 天`);
    assert.equal(entry.expiresAt - entry.createdAt, days * DAY);
  }
});

test('延长：只有明确 extendDays 才加天数，且从 createdAt 算绝对时长', () => {
  const { list, entry } = addDiary([], { text: '一件重要的事', level: 'normal', now });
  const atDay3 = updateDiary(list, entry.id, { extendDays: 3, now: now + 3 * DAY });
  assert.equal(atDay3.entry.expiresAt, now + 10 * DAY, '延长应加在 createdAt 的绝对寿命上，而不是从现在起算');

  const important = addDiary([], { text: '重要的事', level: 'important', now }).entry;
  const impExtended = updateDiary([important], important.id, { extendDays: 7, now: now + 10 * DAY });
  assert.equal(impExtended.entry.expiresAt, now + 28 * DAY);

  const etched = addDiary([], { text: '刻骨铭心的事', level: 'etched', now }).entry;
  const etchExtended = updateDiary([etched], etched.id, { extendDays: 30, now: now + 30 * DAY });
  assert.equal(etchExtended.entry.expiresAt, now + 120 * DAY);
});

test('翻看不续命：连看多次（含同一天）都不改变到期时间', () => {
  const { list, entry } = addDiary([], { text: '那天的事', level: 'normal', now });
  let state = list;
  for (let i = 0; i < 3; i += 1) state = openDiary(state, entry.id, { now: now + DAY + i * 3_600_000 }).list;
  const opened = openDiary(state, entry.id, { now: now + DAY + 4 * 3_600_000 });
  assert.equal(opened.entry.viewCount, 4);
  assert.equal(opened.entry.expiresAt, now + 7 * DAY, '翻看不得续命');
});

test('升降档：按新档初始寿命重算，不在旧寿命上叠加', () => {
  const { list, entry } = addDiary([], { text: '本来只是日常', level: 'normal', now });
  const upgradedAt = now + 2 * DAY;
  const upgraded = updateDiary(list, entry.id, { level: 'important', now: upgradedAt });
  assert.equal(upgraded.entry.level, 'important');
  assert.equal(upgraded.entry.expiresAt, upgradedAt + 21 * DAY, '升档应重算为 21 天，而不是旧寿命 7 天 + 21 天');

  const etched = addDiary([], { text: '刻骨铭心', level: 'etched', now }).entry;
  const downgradeAt = now + 70 * DAY;
  const downgraded = updateDiary([etched], etched.id, { level: 'important', now: downgradeAt });
  assert.equal(downgraded.entry.expiresAt, downgradeAt + 21 * DAY, '降档必须重算，老条目不能直接算成已过期');
});

test('搁着：afraid 冻结计时，bored 照常扣，理由可改', () => {
  const { list, entry } = addDiary([], { text: '不敢看的事', level: 'normal', now });
  // 第 2 天搁成 afraid：剩余 5 天被冻结
  const afraidAt = now + 2 * DAY;
  const afraid = updateDiary(list, entry.id, { shelve: 'afraid', now: afraidAt });
  assert.equal(afraid.entry.status, 'shelved');
  assert.equal(afraid.entry.shelveReason, 'afraid');
  assert.equal(afraid.entry.expiresAt, now + 7 * DAY, 'afraid 不改变到期时间');
  // 第 6 天再看：剩余仍是 5 天（没有扣）
  const later = normalizeDiary(afraid.list).find((item) => item.id === entry.id);
  assert.equal(diaryRemainingMs(later, now + 6 * DAY), 5 * DAY);
  // 取回：被冻结的 4 天补回到期时间，剩余仍是 5 天
  const unshelved = updateDiary(afraid.list, entry.id, { unshelve: true, now: now + 6 * DAY });
  assert.equal(unshelved.entry.status, 'active');
  assert.equal(unshelved.entry.expiresAt, now + 11 * DAY);

  // bored 照常扣
  const bored = updateDiary(list, entry.id, { shelve: 'bored', now: now + 2 * DAY });
  const boredEntry = normalizeDiary(bored.list).find((item) => item.id === entry.id);
  assert.equal(diaryRemainingMs(boredEntry, now + 6 * DAY), DAY);
  // afraid → bored：结算冻结区间后继续扣
  const switched = updateDiary(bored.list, entry.id, { shelve: 'afraid', now: now + 3 * DAY });
  const backToBored = updateDiary(switched.list, entry.id, { shelve: 'bored', now: now + 5 * DAY });
  const switchedEntry = normalizeDiary(backToBored.list).find((item) => item.id === entry.id);
  assert.equal(switchedEntry.status, 'shelved');
  assert.equal(switchedEntry.shelveReason, 'bored');
  assert.equal(switchedEntry.expiresAt, now + 9 * DAY, 'afraid 的冻结区间要先补回');
  assert.equal(diaryRemainingMs(switchedEntry, now + 6 * DAY), 3 * DAY, '改回 bored 后继续按原时间扣');

  // afraid 期间到期也不算过期
  const frozen = updateDiary(list, entry.id, { shelve: 'afraid', now: now + 2 * DAY });
  const settled = settleDiary({ diary: frozen.list, profile: [], now: now + 30 * DAY });
  assert.equal(settled.diary.find((item) => item.id === entry.id).status, 'shelved');
});

test('软删：只标 deletedAt，注入与结算过滤，回收站仍保留', () => {
  const { list, entry } = addDiary([], { text: '删掉的事', level: 'important', mood: '难受', now });
  const removed = deleteDiary(list, entry.id, { now: now + DAY });
  assert.equal(removed.entry.status, 'deleted');
  assert.equal(removed.entry.deletedAt, now + DAY);
  const kept = normalizeDiary(removed.list).find((item) => item.id === entry.id);
  assert.ok(kept, '回收站条目必须还在 state/diary.json 里');
  assert.equal(kept.status, 'deleted');
  assert.equal(formatDiaryBlock(removed.list, { now: now + DAY }), '', '删除后不得注入');
  const settled = settleDiary({ diary: removed.list, now: now + DAY });
  assert.equal(settled.pending.length, 0, '删除后不得进待结算');
  assert.equal(formatDiaryPendingBlock(settled.pending), '');
  const again = deleteDiary(removed.list, entry.id, { now: now + 2 * DAY });
  assert.equal(again.entry.deletedAt, now + DAY, '重复删除是幂等的');
});

test('模糊视图：按剩余比例给标题/心情，超长截断，最多 3 条按紧急度排序', () => {
  const longText = '那天在旧书店门口等了很久，雨停之后才把那句话说完，后来我们都没有再提。';
  const fresh = addDiary([], { text: longText, level: 'normal', mood: '平静', now }).entry;
  const mid = addDiary([], { text: longText, level: 'normal', mood: '慌', now: now - 4 * DAY }).entry;
  const late = addDiary([], { text: longText, level: 'normal', now: now - 6.5 * DAY }).entry;
  const block = formatDiaryBlock([late, mid, fresh], { now });
  assert.ok(block.startsWith('【日记】'));
  assert.ok(block.includes('平静') && block.includes('慌'));
  assert.ok(block.includes('｜'), '剩余 >50% 应带短标题');
  const title = [...longText].slice(0, 16).join('');
  assert.ok(block.includes(`${title}…`));
  assert.ok(!block.includes('后来我们都没有再提'), '不得把正文全部塞进注入');
  assert.ok(block.indexOf('慌') < block.indexOf('平静'), '剩余越少越靠前');
  // 海量条目 + 超长标题也必须压到 300 字以内，且最多 3 条
  const many = Array.from({ length: 8 }, (_, i) => addDiary([], {
    text: `${i}${'很长很长的日记正文'.repeat(40)}`, level: 'etched', mood: '混在一起的心情', now: now - i * DAY
  }).entry);
  const huge = formatDiaryBlock(many, { now });
  assert.ok([...huge].length <= 300);
  assert.ok(huge.split('\n').filter((line) => line.startsWith('- ')).length <= 3);
  // 没有心情就不写心情段
  const noMood = formatDiaryBlock([late], { now });
  assert.ok(!noMood.includes('心情：'));
});

test('模糊视图字段：不含正文全文与没说出口的话', () => {
  const { entry } = addDiary([], { text: '一篇很长的正文'.repeat(10), level: 'important', mood: '平静', unsaid: '其实想说别走', now });
  const view = fuzzyDiary(entry, now);
  assert.ok(view.id && view.level === 'important' && view.levelName === '重要');
  assert.ok(view.title.length <= 17);
  assert.equal('text' in view, false);
  assert.equal('unsaid' in view, false);
  assert.equal(view.hasUnsaid, true);
  assert.ok(view.remainingRatio > 0.9);
});

test('结算：到期标 expired；清单按档给到期/升降档/画像提示，warnedAt 防重复', () => {
  const expiredItem = addDiary([], { text: '已经过期的', level: 'normal', now: now - 10 * DAY }).entry;
  const activeItem = addDiary([], { text: '还在的日记', level: 'normal', mood: '安稳', now }).entry;
  const up = {
    id: 'up1', level: 'important', text: '值得升档的事', mood: '', unsaid: '', createdAt: now - 100 * DAY,
    expiresAt: now + 65 * DAY, warnedAt: now, viewCount: 0, shelveReason: '', status: 'active', deletedAt: 0
  };
  const down = {
    id: 'down1', level: 'important', text: '该降档的事', mood: '', unsaid: '', createdAt: now - 16 * DAY,
    expiresAt: now + 5 * DAY, warnedAt: now, viewCount: 0, shelveReason: '', status: 'active', deletedAt: 0
  };
  const settled = settleDiary({
    diary: [expiredItem, activeItem, up, down],
    profile: [{ id: 'p1', text: '在减肥', status: 'active', strength: 3 }, { id: 'p2', text: '常熬夜', status: 'active', strength: 2 }],
    now
  });
  assert.equal(settled.expired, 1);
  assert.equal(settled.diary.find((item) => item.id === expiredItem.id).status, 'expired');
  const types = settled.pending.map((item) => item.type);
  assert.ok(types.includes('dueSoon'));
  assert.ok(types.includes('upgrade'));
  assert.ok(types.includes('downgrade'));
  assert.ok(types.includes('profile'));
  assert.equal(settled.pending.filter((item) => item.type === 'profile').length, 1, 'strength<3 不提示');
  assert.equal(settled.diary.find((item) => item.id === activeItem.id).warnedAt, now, 'warnedAt 应按档更新');
  assert.ok(!formatDiaryBlock(settled.diary, { now }).includes('已经过期的'), '到期条目不得注入');
  const block = formatDiaryPendingBlock(settled.pending);
  assert.ok(block.startsWith('【日记待结算】'));
  assert.ok(block.includes('可以考虑记进日记'));
  assert.ok(block.split('\n').length <= 6);
  assert.ok(!/你应该|别难过|开心点/.test(block), '只列事实，不引导情绪');

  // 同一天再结算：normal 1 天一次，不应重复提醒
  const second = settleDiary({ diary: settled.diary, profile: [], now: now + 1000 });
  assert.equal(second.pending.filter((item) => item.type === 'dueSoon').length, 0);
});

await test('bridge：owner 私聊注入【日记】与【日记待结算】，群聊/群友私聊不注入', async () => {
  const active = {
    id: 'd1', level: 'etched', text: '那天在海边坐到很晚，风的咸味一直记得。', mood: '平静', unsaid: '其实想让你留下',
    createdAt: Date.now() - DAY, expiresAt: Date.now() + 89 * DAY, warnedAt: 0, viewCount: 2,
    shelveReason: '', status: 'active', deletedAt: 0
  };
  const deleted = {
    id: 'd2', level: 'normal', text: '回收站里的内容不该出现', mood: '', unsaid: '',
    createdAt: Date.now(), expiresAt: Date.now() + 7 * DAY, warnedAt: 0, viewCount: 0,
    shelveReason: '', status: 'deleted', deletedAt: Date.now()
  };
  const h = await bridgeHarness({
    files: {
      'state/diary.json': [active, deleted],
      'state/diary-settle.json': { items: [{ type: 'dueSoon', id: 'd1', level: 'etched', text: '那天在海边…', daysLeft: 89 }], updatedAt: Date.now() }
    }
  });
  try {
    h.setMode('reserved2');
    const owner = h.buildWakePromptV2(KEY, 'bootstrap');
    assert.ok(owner.includes('【日记】'));
    assert.ok(owner.includes('刻骨铭心'));
    assert.ok(owner.includes('平静'));
    assert.ok(owner.includes('那天在海边坐到很晚，风的咸味')); // 前 16 字
    assert.ok(!owner.includes('其实想让你留下'), '注入不得带没说出口的话');
    assert.ok(!owner.includes('回收站里的内容不该出现'), '删除条目不得注入');
    assert.ok(owner.includes('【日记待结算】'));

    const friend = h.buildWakePromptV2('private:9271', 'bootstrap');
    assert.ok(!friend.includes('【日记】'), '群友私聊不得注入日记');
    assert.ok(!friend.includes('那天在海边'), '群友私聊不得看到日记内容');
    const group = h.buildWakePromptV2('group:456', 'bootstrap');
    assert.ok(!group.includes('【日记】'), '群聊不得注入日记');
  } finally { await h.close(); }
});

await test('bridge 端点：写/列/看/改/删/回收站/结算', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (route, { method = 'POST', body, token = st.agentToken, admin = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, path: `${route}${query}`, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key: KEY, ...body }));
  });
  try {
    const written = await call('/api/socialV2/diary/write', {
      body: { text: '写进日记的一整天，从早到晚都没停下来。', level: 'etched', mood: '疲惫', unsaid: '其实想被问一句' }
    });
    assert.equal(written.status, 200);
    const id = written.data.entry.id;
    const createdAt = written.data.entry.createdAt;

    const listed = await call('/api/socialV2/diary/list', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.items.length, 1);
    assert.equal('text' in listed.data.items[0], false, '列表只给模糊视图');
    assert.ok(listed.data.items[0].title.includes('写进日记'));
    assert.equal(listed.data.items[0].hasUnsaid, true);

    for (let i = 0; i < 3; i += 1) {
      const opened = await call('/api/socialV2/diary/open', { body: { id } });
      assert.equal(opened.status, 200);
      assert.ok(opened.data.entry.text.includes('从早到晚'));
    }
    const afterViews = await call('/api/socialV2/diary/list', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(afterViews.data.items[0].viewCount, 3, '翻看次数应累加');
    assert.equal(normalizeDiary([written.data.entry])[0].expiresAt, createdAt + 90 * DAY, '翻看不续命');
    const reread = await call('/api/socialV2/diary/open', { body: { id } });
    assert.equal(reread.data.entry.expiresAt, createdAt + 90 * DAY, '翻看后到期时间不变');

    const extended = await call('/api/socialV2/diary/update', { body: { id, extendDays: 30 } });
    assert.equal(extended.status, 200);
    assert.equal(extended.data.entry.expiresAt, createdAt + 120 * DAY, '延长从 createdAt 算绝对时长');

    const deleted = await call('/api/socialV2/diary/delete', { body: { id } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.entry.status, 'deleted');
    const afterDelete = await call('/api/socialV2/diary/list', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(afterDelete.data.items.length, 0, '删除后工具列表应过滤');
    const bin = await call('/api/socialV2/diary?status=deleted', { method: 'GET', admin: true });
    assert.equal(bin.status, 200);
    assert.equal(bin.data.items.length, 1, '控制台回收站应能查到');
    assert.ok(bin.data.items[0].deletedAt > 0);
    const binAsAgent = await call('/api/socialV2/diary?status=deleted', { method: 'GET' });
    assert.equal(binAsAgent.status, 403, '回收站仅控制台可用');

    const second = await call('/api/socialV2/diary/write', { body: { text: '还留在册的一篇日记', level: 'normal', mood: '安稳' } });
    assert.equal(second.status, 200);
    const settle = await call('/api/socialV2/diary/settle', { body: {}, admin: true });
    assert.equal(settle.status, 200);
    assert.ok(settle.data.pending >= 1, '结算应生成待办');
    assert.ok(fs.existsSync(path.join(h.temp, 'state/diary-settle.json')), '清单写入 state/diary-settle.json');
    const settleAsAgent = await call('/api/socialV2/diary/settle', { body: {} });
    assert.equal(settleAsAgent.status, 403, '结算仅控制台可用');

    const disabled = await call('/api/socialV2/diary/list', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(disabled.status, 200, '默认开关下日记可用');
    h.cfg.socialV2.tools.diary = false;
    const blocked = await call('/api/socialV2/diary/list', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(blocked.status, 403, 'tools.diary=false 必须挡住工具端点');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
