// 第四期回归：注入预算裁剪优先级、qq_brief、健康检查与 token 预算、快照 8 条。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const DAY = 86_400_000;
const KEY = 'private:123';

test('注入预算：超 maxPromptChars 按 群聊摘要 → 日记 → 梗库 → 表情 依次裁，安全块不裁', async () => {
  const now = Date.now();
  const logs = [];
  const conversations = {
    [KEY]: {
      agentToken: 'fixture-token-123',
      bootstrapSent: true,
      wakeConfig: {},
      recentMessages: [],
      unread: [],
      activeTopics: Array.from({ length: 8 }, (_, i) => ({ text: `群聊摘要标记${i}${'长'.repeat(180)}`, lastMentionAt: now }))
    }
  };
  const h = await bridgeHarness({
    config: {
      socialV2: {
        sticker: { enabled: true, includeInPrompt: true },
        memes: { enabled: true },
        context: { maxPromptChars: 6000 }
      }
    },
    globals: { console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) } },
    files: {
      'state/social-v2.json': { conversations },
      'state/diary.json': [{
        id: 'd1', level: 'etched', text: `日记模糊视图标记${'日'.repeat(120)}`, mood: '平静', unsaid: '',
        createdAt: now - DAY, expiresAt: now + 89 * DAY, warnedAt: 0, viewCount: 0,
        shelveReason: '', status: 'active', deletedAt: 0
      }],
      'state/memes.json': Array.from({ length: 8 }, (_, i) => ({
        id: `m${i}`, text: `梗库标记${i}`, meaning: `意思${'解'.repeat(30)}`, usage: `用法${'用'.repeat(30)}`,
        tags: [], source: 'ai', createdAt: now - i * 1000, usedCount: i
      })),
      'state/stickers.json': Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`, resId: `r${i}`, url: `https://public.invalid/${i}.png`, md5: `m${i}`,
        desc: `表情标记${i}`, localNote: `备注${'注'.repeat(20)}`, tags: [], usedCount: i, lastUsedAt: now - i * 1000
      }))
    }
  });
  try {
    h.setMode('reserved2');
    const build = () => h.buildWakePromptV2(KEY, 'test');
    // 生产预算 6000：连续采样 10 次都必须 <=6000。
    for (let i = 0; i < 10; i += 1) {
      const sample = build();
      assert.ok([...sample].length <= 6000, `第 ${i + 1} 次 prompt ${[...sample].length} 字，超过 6000`);
    }
    // 人为压低预算，验证裁剪日志会写出来。
    h.cfg.socialV2.context.maxPromptChars = 3500;
    build();
    assert.ok(logs.some((line) => line.includes('prompt 裁剪：')), '裁剪必须写日志');
    h.cfg.socialV2.context.maxPromptChars = 20000;
    const p0 = build();
    for (const marker of ['群聊摘要标记', '日记模糊视图标记', '梗库标记', '表情标记']) {
      assert.ok(p0.includes(marker), `全量预算时应包含 ${marker}`);
    }
    assert.ok(p0.includes('【会话令牌】') && p0.includes('【反AI味】') && p0.includes('【此刻状态】') && p0.includes('【沉睡前强制等待】'));
    const total = [...p0].length;

    h.cfg.socialV2.context.maxPromptChars = Math.max(500, total - 100);
    const p1 = build();
    assert.ok(!p1.includes('群聊摘要标记'), '第一个被裁的应是群聊摘要');
    for (const marker of ['日记模糊视图标记', '梗库标记', '表情标记']) {
      assert.ok(p1.includes(marker), `第一阶段不应裁 ${marker}`);
    }
    assert.ok(p1.includes('【会话令牌】') && p1.includes('【反AI味】') && p1.includes('【此刻状态】'));

    const len1 = [...p1].length;
    h.cfg.socialV2.context.maxPromptChars = Math.max(500, len1 - 50);
    const p2 = build();
    if (Math.max(500, len1 - 50) < len1) {
      assert.ok(!p2.includes('日记模糊视图标记'), '第二个被裁的应是日记模糊视图');
      assert.ok(p2.includes('梗库标记'));
    }

    const len2 = [...p2].length;
    h.cfg.socialV2.context.maxPromptChars = Math.max(500, len2 - 50);
    const p3 = build();
    if (Math.max(500, len2 - 50) < len2) {
      assert.ok(!p3.includes('梗库标记'), '第三个被裁的应是梗库');
      assert.ok(p3.includes('表情标记'));
    }

    h.cfg.socialV2.context.maxPromptChars = 500;
    const p4 = build();
    for (const marker of ['群聊摘要标记', '日记模糊视图标记', '梗库标记', '表情标记']) {
      assert.ok(!p4.includes(marker), `预算 500 时 ${marker} 应被裁掉`);
    }
    for (const marker of ['【会话令牌】', '【反AI味】', '【此刻状态】', '【沉睡前强制等待】']) {
      assert.ok(p4.includes(marker), `安全块 ${marker} 不得被裁`);
    }
  } finally { await h.close(); }
});

test('snapshot：wakeRecentLimit=8，注入最近消息只给 8 条', async () => {
  const h = await bridgeHarness({ config: { socialV2: { context: { wakeRecentLimit: 8 } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    for (let i = 0; i < 12; i += 1) {
      h.appendSocialV2Message(KEY, '我', `第${i}条`, `第${i}条`, false, true, String(1000 + i), [], null, [], [], true);
    }
    const snap = h.buildWakeSnapshotV2(KEY);
    assert.ok(snap);
    assert.ok(snap.recent.length <= 8, `最近消息应 <= 8，实际 ${snap.recent.length}`);
    assert.equal(snap.messages.length, 0);
    assert.ok(st.recentMessages.length >= 12);
  } finally { await h.close(); }
});

await test('qq_brief：owner 私聊一次返回未读/最近5条/记忆/心情/日记；群聊不泄露', async () => {
  const now = Date.now();
  const h = await bridgeHarness({
    files: {
      'state/agenda.json': [{ id: 'a1', text: '明天交报告', createdAt: now, expiresAt: now + 2 * DAY, strength: 1, source: 'ai' }],
      'state/profile.json': [{ id: 'p1', text: '在减肥', status: 'active', strength: 3, evidence: '', createdAt: now, lastConfirmedAt: now }],
      'state/moods.json': {
        handnotes: [{ id: 'n1', text: '他今天话少', tag: '被冷落', createdAt: now, expiresAt: now + DAY }],
        baseMood: { word: '有点闷', reason: '他今天话很少', since: new Date(now).toISOString(), settledAt: new Date(now).toISOString() },
        dynamicMood: null
      },
      'state/diary.json': [{
        id: 'd1', level: 'important', text: '海边那天', mood: '平静', unsaid: '',
        createdAt: now - DAY, expiresAt: now + 20 * DAY, warnedAt: 0, viewCount: 1,
        shelveReason: '', status: 'active', deletedAt: 0
      }]
    }
  });
  h.setMode('reserved2');
  const owner = h.getSocialV2State(KEY);
  h.appendSocialV2Message(KEY, '饲养员', '你在吗', '你在吗', false, true, '9001', [], null, [], [], false);
  for (let i = 0; i < 5; i += 1) {
    h.appendSocialV2Message(KEY, '饲养员', `消息${i}`, `消息${i}`, false, true, String(9100 + i), [], null, [], [], false);
  }
  h.appendSocialV2Message(KEY, '我', '在', '在', false, true, '9002', [], null, [], [], true);
  const group = h.getSocialV2State('group:456');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (key, token, extra = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token', 'x-agent-token': token };
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/socialV2/brief?key=${encodeURIComponent(key)}`, method: 'GET', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('brief timeout')));
    req.end();
  });
  try {
    const ownerBrief = await call(KEY, owner.agentToken);
    assert.equal(ownerBrief.status, 200);
    assert.ok(ownerBrief.data.unreadCount >= 6);
    assert.ok(ownerBrief.data.recent.length <= 5);
    assert.ok(ownerBrief.data.recent.some((message) => message.isSelf === true), '最近摘要要含 isSelf');
    assert.ok(ownerBrief.data.agenda.length >= 1);
    assert.ok(ownerBrief.data.profile.length >= 1);
    assert.equal(ownerBrief.data.mood.current.word, '有点闷');
    assert.equal(ownerBrief.data.diary.length, 1);
    assert.equal('text' in ownerBrief.data.diary[0], false, '日记只给模糊视图');
    assert.ok(ownerBrief.data.wakeConfig);

    const groupBrief = await call('group:456', group.agentToken);
    assert.equal(groupBrief.status, 200);
    assert.equal(groupBrief.data.agenda, undefined);
    assert.equal(groupBrief.data.profile, undefined);
    assert.equal(groupBrief.data.mood, undefined);
    assert.equal(groupBrief.data.diary, undefined);

    h.cfg.socialV2.tools.brief = false;
    const blocked = await call(KEY, owner.agentToken);
    assert.equal(blocked.status, 403, 'tools.brief=false 必须挡住端点');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

await test('健康检查：token 只累计 k:turn，新输入(cacheMiss)超阈值 → WARN，k:base 快照不计入', async () => {
  const now = Date.now();
  const h = await bridgeHarness({
    config: { socialV2: { health: { enabled: true, time: '09:00', dailyInputTokenLimit: 300000, alertOwner: false } } },
    files: {
      'state/token-usage.jsonl': [
        // k:"base" 是整条会话日志的累计快照（历史上曾把这种行也加进去，虚高两个数量级），必须忽略。
        JSON.stringify({ k: 'base', t: now, b: { cacheMiss: 250000000, cacheHit: 540000000, cacheWrite: 0, output: 1000000 } }),
        JSON.stringify({ k: 'turn', t: now, b: { cacheMiss: 400000, cacheHit: 200000, cacheWrite: 0, output: 10 } })
      ].join('\n'),
      'state/prompt-stats.json': { samples: [{ at: now - 1000, chars: 1500 }, { at: now, chars: 1500 }], updatedAt: now }
    }
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/socialV2/health/run', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(6000, () => req.destroy(new Error('health timeout')));
      req.end('{}');
    });
    assert.equal(result.status, 'WARN');
    assert.ok(result.line.includes('inputMiss=400000/300000'), `新输入口径：${result.line}`);
    assert.ok(result.line.includes('inputAll=600000'), `总处理量口径：${result.line}`);
    assert.ok(!result.line.includes('250000000'), 'k:base 快照不得计入');
    assert.ok(result.reasons.some((reason) => reason.includes('新输入token')));
    assert.equal(result.checks.promptAvg, 1500);
    assert.equal(result.checks.inputMiss, 400000);
    assert.equal(result.checks.inputAll, 600000);
    const log = fs.readFileSync(path.join(h.temp, 'state/health.log'), 'utf8');
    assert.ok(log.includes('WARN'));
    assert.ok(log.includes('inputMiss=400000/300000'));
    const last = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/health-last.json'), 'utf8'));
    assert.ok(last.date);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

await test('健康检查：k:turn 全部在窗口内但未超阈值 → OK 不误报', async () => {
  const now = Date.now();
  const h = await bridgeHarness({
    config: { socialV2: { health: { enabled: true, time: '09:00', dailyInputTokenLimit: 20000000, alertOwner: false } } },
    files: {
      'state/token-usage.jsonl': [
        JSON.stringify({ k: 'base', t: now, b: { cacheMiss: 999999999, cacheHit: 999999999, cacheWrite: 0, output: 0 } }),
        JSON.stringify({ k: 'turn', t: now, b: { cacheMiss: 5000000, cacheHit: 15000000, cacheWrite: 0, output: 60000 } })
      ].join('\n'),
      'state/prompt-stats.json': { samples: [{ at: now, chars: 3113 }], updatedAt: now }
    }
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/health/run', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(6000, () => req.destroy(new Error('health timeout')));
      req.end('{}');
    });
    // 测试环境里 DSH/小号端口本来就不在线，整体可能 WARN；这里只断言 token 不误报。
    assert.ok(!result.reasons.some((reason) => reason.includes('新输入token')), `典型日量级不得误报：${result.line}`);
    assert.ok(result.line.includes('inputMiss=5000000/20000000'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
