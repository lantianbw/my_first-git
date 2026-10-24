// 心情系统回归：手札过期、同标签计数、动态覆盖底色、结算清空、状态偏差阈值、仅 owner 注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  MOOD_TAGS,
  addHandnote,
  normalizeMoods,
  setDynamicMood,
  setBaseMood,
  currentMood,
  moodTagCounts,
  settleMood,
  formatMoodBlock,
  formatMoodSettleBlock
} from '../src/mood.js';
import {
  normalizeOwnerStats,
  recordOwnerMessage,
  ownerDeviationText
} from '../src/owner-stats.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const DAY = 86_400_000;
const now = Date.parse('2026-10-23T20:00:00+08:00');
const KEY = 'private:123';

test('手札：只活 3 天，过期自动清；tag 归一化', () => {
  const fresh = addHandnote({}, { text: '他今天又没回我', tag: '被冷落', now });
  assert.equal(fresh.note.expiresAt, now + 3 * DAY);
  const twoDays = addHandnote(fresh.moods, { text: '他说我可爱', tag: '被夸', now: now - 2 * DAY });
  const fourDays = addHandnote(twoDays.moods, { text: '很久以前的手札', tag: '被冷落', now: now - 4 * DAY });
  const live = normalizeMoods(fourDays.moods, now);
  assert.equal(live.handnotes.length, 2, '超过 3 天的手札必须自动清掉');
  assert.ok(!live.handnotes.some((item) => item.text.includes('很久以前')));
  const unknown = addHandnote({}, { text: '不知道归哪类', tag: '不存在', now });
  assert.equal(unknown.note.tag, '其他', '未知 tag 归一为其他');
  const later = normalizeMoods(fourDays.moods, now + 4 * DAY);
  assert.equal(later.handnotes.length, 0, '3 天后全部过期');
});

test('同标签计数：三天内同标签累加，按次数降序', () => {
  let moods = {};
  for (let i = 0; i < 3; i += 1) {
    moods = addHandnote(moods, { text: `第${i + 1}次被冷落`, tag: '被冷落', now: now - i * 3_600_000 }).moods;
  }
  moods = addHandnote(moods, { text: '被夸了一句', tag: '被夸', now }).moods;
  const counts = moodTagCounts(moods, now);
  assert.deepEqual(counts, [{ tag: '被冷落', count: 3 }, { tag: '被夸', count: 1 }]);
  assert.ok(MOOD_TAGS.includes('被冷落'));
});

test('动态心情覆盖底色；结算后动态清空、底色保留', () => {
  const base = setBaseMood({}, { word: '有点闷', reason: '他今天话很少', now: now - DAY }).moods;
  const withDynamic = setDynamicMood(base, { word: '软下来', reason: '他逗我笑了', now }).moods;
  assert.equal(currentMood(withDynamic, now).word, '软下来');
  assert.equal(currentMood(withDynamic, now).source, 'dynamic');
  const settled = settleMood({ moods: withDynamic, now });
  assert.equal(settled.clearedDynamic, true);
  assert.equal(settled.moods.dynamicMood, null);
  assert.equal(currentMood(settled.moods, now).word, '有点闷');
  assert.equal(settled.moods.baseMood.settledAt !== '', true);
});

test('结算清单：最近 3 天手札最多 6 条 + 当前底色；注入只给动作与计数', () => {
  let moods = setBaseMood({}, { word: '有点闷', reason: '他今天话很少', now: now - DAY }).moods;
  for (let i = 0; i < 6; i += 1) {
    moods = addHandnote(moods, { text: `手札内容第${i + 1}条`, tag: i < 3 ? '被冷落' : '不安', now: now - i * 3_600_000 }).moods;
  }
  const settled = settleMood({ moods, now });
  assert.equal(settled.pending.notes.length, 6, '清单最多 6 条');
  const block = formatMoodSettleBlock(settled.pending);
  assert.ok(block.startsWith('【心情结算】'));
  assert.ok(block.includes('不用平均'));
  assert.ok(block.includes('被冷落 ×3'));
  assert.ok(block.includes('不安 ×3'));
  assert.ok(block.includes('有点闷'));
  assert.ok(!block.includes('手札内容第1条'), '注入不给手札全文');
  assert.ok([...block].length <= 200);
});

test('【心情】块：动态优先，只给计数与最近一条标签，不给全文，<=120 字', () => {
  let moods = setBaseMood({}, { word: '有点闷', reason: '他今天话很少', now: now - DAY }).moods;
  moods = setDynamicMood(moods, { word: '软下来', reason: '他逗我笑了', now }).moods;
  for (let i = 0; i < 3; i += 1) {
    moods = addHandnote(moods, { text: '他半天没回我，我盯着屏幕看了很久', tag: '被冷落', now: now - i * 3_600_000 }).moods;
  }
  moods = addHandnote(moods, { text: '后来他夸我可爱', tag: '被夸', now }).moods;
  const block = formatMoodBlock(moods, { now });
  assert.ok(block.startsWith('【心情】'));
  assert.ok(block.includes('软下来'));
  assert.ok(!block.includes('有点闷'), '动态存在时底色不写');
  assert.ok(block.includes('被冷落 ×3'));
  assert.ok(!block.includes('盯着屏幕'), '手札全文不得进入注入');
  assert.ok([...block].length <= 120);
  const noMood = formatMoodBlock({}, { now });
  assert.equal(noMood, '', '没有心情也没有手札时不注入');
});

test('状态偏差：字数少/回复慢超过 40% 才提示，且只给事实', () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({ at: now - (i + 1) * DAY, chars: 20, gapMs: 60_000 }));
  const seed = { samples, latest: null, updatedAt: now };
  const short = recordOwnerMessage(seed, { at: now, chars: 5, gapMs: 0, now });
  const text = ownerDeviationText(short.stats, { now });
  assert.ok(text.includes('话比平时少（约少 75%）'), text);
  assert.ok(!/心情不好|不开心|生气/.test(text), '不得替她判断原因');

  const slow = recordOwnerMessage(seed, { at: now, chars: 19, gapMs: 120_000, now });
  const slowText = ownerDeviationText(slow.stats, { now });
  assert.ok(slowText.includes('回得比平时慢'), slowText);
  assert.ok(!slowText.includes('话比平时少'), '字数只差 5% 不提示');

  const normal = recordOwnerMessage(seed, { at: now, chars: 14, gapMs: 70_000, now });
  assert.equal(ownerDeviationText(normal.stats, { now }), '', '不到 40% 不提示');
  assert.equal(ownerDeviationText(normal.stats, { now: now + 2 * 3_600_000 }), '', '过期样本不提示');
  assert.equal(normalizeOwnerStats({ samples: [] }, now).samples.length, 0);
});

test('bridge：owner 私聊注入【心情】【心情结算】与偏差句，群聊/群友私聊不注入', async () => {
  const stamp = new Date().toISOString();
  const h = await bridgeHarness({
    files: {
      'state/moods.json': {
        handnotes: [1, 2, 3].map((i) => ({
          id: `n${i}`, text: '他半天没回我，我盯着屏幕看了很久', tag: '被冷落',
          createdAt: Date.now() - i * 3_600_000, expiresAt: Date.now() + DAY
        })),
        baseMood: { word: '有点闷', reason: '他今天话很少', since: stamp, settledAt: stamp },
        dynamicMood: { word: '软下来', reason: '他逗我笑了', at: stamp }
      },
      'state/mood-settle.json': {
        notes: [{ id: 'n1', text: '他半天没回我', tag: '被冷落', createdAt: Date.now() - 3_600_000, expiresAt: Date.now() + DAY }],
        baseMood: { word: '有点闷', reason: '他今天话很少', since: stamp, settledAt: stamp },
        updatedAt: Date.now()
      },
      'state/owner-stats.json': {
        samples: Array.from({ length: 5 }, (_, i) => ({ at: Date.now() - (i + 1) * DAY, chars: 20, gapMs: 60_000 })),
        latest: { at: Date.now(), chars: 5, gapMs: 0, avgChars: 20, avgGap: 60_000 },
        updatedAt: Date.now()
      }
    }
  });
  try {
    h.setMode('reserved2');
    const owner = h.buildWakePromptV2(KEY, 'test');
    assert.ok(owner.includes('【心情】'));
    assert.ok(owner.includes('软下来'));
    assert.ok(owner.includes('被冷落 ×3'));
    assert.ok(!owner.includes('盯着屏幕'), '注入不得带手札全文');
    assert.ok(owner.includes('【心情结算】'));
    assert.ok(owner.includes('话比平时少'), '偏差句应进【此刻状态】');
    const friend = h.buildWakePromptV2('private:9271', 'test');
    assert.ok(!friend.includes('【心情】'), '群友私聊不得注入');
    assert.ok(!friend.includes('话比平时少'));
    const group = h.buildWakePromptV2('group:456', 'test');
    assert.ok(!group.includes('【心情】'), '群聊不得注入');
    assert.ok(!group.includes('【心情结算】'));
  } finally { await h.close(); }
});

test('bridge 端点：记手札/看状态/改动态/结算与写底色/开关', async () => {
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
    const note = await call('/api/socialV2/mood/note', { body: { text: '他今天话少，我有点闷', tag: '被冷落' } });
    assert.equal(note.status, 200);
    assert.equal(note.data.note.tag, '被冷落');
    const bad = await call('/api/socialV2/mood/note', { body: { text: '这条太长了'.repeat(10), tag: '被冷落' } });
    assert.equal(bad.status, 400);

    const state = await call('/api/socialV2/mood/state', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(state.status, 200);
    assert.equal(state.data.handnotes.length, 1);
    assert.equal(state.data.counts[0].tag, '被冷落');

    const set = await call('/api/socialV2/mood/set', { body: { word: '软下来', reason: '他逗我笑了' } });
    assert.equal(set.status, 200);
    assert.equal(set.data.current.word, '软下来');

    const consoleSettle = await call('/api/socialV2/mood/settle', { admin: true, body: {} });
    assert.equal(consoleSettle.status, 200);
    assert.equal(consoleSettle.data.clearedDynamic, true);
    assert.equal(consoleSettle.data.pending, 1);
    assert.ok(fs.existsSync(path.join(h.temp, 'state/mood-settle.json')));

    const pendingBefore = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/mood-settle.json'), 'utf8'));
    assert.equal(pendingBefore.notes.length, 1, '手札进入结算清单');

    const writeBase = await call('/api/socialV2/mood/settle', { body: { word: '其实没那么闷', reason: '他后来一直逗我' } });
    assert.equal(writeBase.status, 200);
    assert.equal(writeBase.data.baseMood.word, '其实没那么闷');
    const pendingAfter = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/mood-settle.json'), 'utf8'));
    assert.equal(pendingAfter.notes.length, 0, '写完底色后清单清空');
    assert.equal(pendingAfter.baseMood, null, '清单里的底色也要一起清空');

    const moods = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/moods.json'), 'utf8'));
    assert.equal(moods.dynamicMood, null);
    assert.equal(moods.baseMood.word, '其实没那么闷');

    h.cfg.socialV2.tools.mood = false;
    const blocked = await call('/api/socialV2/mood/state', { method: 'GET', query: `?key=${encodeURIComponent(KEY)}` });
    assert.equal(blocked.status, 403, 'tools.mood=false 必须挡住工具端点');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
