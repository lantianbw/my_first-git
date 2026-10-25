// 出站守卫（guardOutboundV2 / 长度软干预 / 节奏事实）回归：
// 称呼越界（老爹/饲养员）、元信息拦词、单条超长、多条 nudge、唤醒提示词节奏注入、语音 label。
// 走真实 bridge.js + 假 OneBot（bridgeHarness），不发真消息。
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

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// harness 默认 ownerQQ=123、allow private:['123'] groups:['456']；补一个非 owner 私聊 789。
const h = await bridgeHarness({
  config: {
    allow: { private: ['123', '789'], groups: ['456'] },
    socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } },
  },
});

await test('称呼越界 + 元信息 + 长度干预（send-message 全链路）', async () => {
  h.setMode('reserved2');
  h.setReady(true);
  const stOwner = h.getSocialV2State('private:123');
  const stOther = h.getSocialV2State('private:789');
  const stGroup = h.getSocialV2State('group:456');
  await withServer(h, async (port) => {
    const send = (key, token, messages, extra = {}) => call(port, '/api/socialV2/send-message', {
      method: 'POST',
      headers: { ...ADMIN, 'x-agent-token': token, 'x-agent-call': '1' },
      body: { key, messages, ...extra },
    });

    // owner 私聊：「老爹」原样放行（呼语也不拦，那里就是该叫的人）
    const toOwner = await send('private:123', stOwner.agentToken, '老爹早');
    assert.equal(toOwner.status, 200, toOwner.body);
    assert.equal(h.getSocialV2State('private:123').recentMessages.at(-1).text, '老爹早');

    // 群聊：「老爹」放行（群友本来就知道她有个爹）
    const toGroup = await send('group:456', stGroup.agentToken, '老爹说周末带我出去玩');
    assert.equal(toGroup.status, 200, toGroup.body);
    assert.equal(h.getSocialV2State('group:456').recentMessages.at(-1).text, '老爹说周末带我出去玩');

    // 非 owner 私聊·呼语：拦截并 403
    const vocative = await send('private:789', stOther.agentToken, '老爹早');
    assert.equal(vocative.status, 403, vocative.body);
    assert.match(vocative.json.error, /称呼越界/);

    // 非 owner 私聊·叙述句：替换 老爹→你 后发出
    const replaced = await send('private:789', stOther.agentToken, '我觉得老爹说得对');
    assert.equal(replaced.status, 200, replaced.body);
    assert.equal(h.getSocialV2State('private:789').recentMessages.at(-1).text, '我觉得你说得对');

    // 「饲养员」一律拦截（含 owner 私聊与群聊）
    const feederOwner = await send('private:123', stOwner.agentToken, '饲养员晚安');
    assert.equal(feederOwner.status, 403, feederOwner.body);
    assert.match(feederOwner.json.error, /称呼越界/);
    const feederGroup = await send('group:456', stGroup.agentToken, '问问饲养员');
    assert.equal(feederGroup.status, 403, feederGroup.body);

    // 元信息拦词：403 + 原因（不静默丢弃）
    const meta = await send('private:789', stOther.agentToken, '⏳ 当前任务运行中');
    assert.equal(meta.status, 403, meta.body);
    assert.match(meta.json.error, /元信息泄漏/);
    const metaWord = await send('private:789', stOther.agentToken, '这是权限问题');
    assert.equal(metaWord.status, 403, metaWord.body);

    // 单条超长：一律 403（默认 >40 字）
    const tooLong = '这'.repeat(41);
    const long1 = await send('private:123', stOwner.agentToken, tooLong);
    assert.equal(long1.status, 403, long1.body);
    assert.match(long1.json.error, /太长/);

    // 多条 nudge：owner 刚发过（10 分钟内），两条都 >12 字 → 403 一次；重试放行
    const nudgeMsgs = ['这条消息肯定超过十二个字啦你看', '这条消息也肯定超过十二个字了吧'];
    const nudge1 = await send('private:123', stOwner.agentToken, nudgeMsgs);
    assert.equal(nudge1.status, 403, nudge1.body);
    assert.match(nudge1.json.error, /只发一条短句/);
    const nudge2 = await send('private:123', stOwner.agentToken, nudgeMsgs);
    assert.equal(nudge2.status, 200, nudge2.body);
    assert.equal(h.getSocialV2State('private:123').recentMessages.at(-1).text, nudgeMsgs[1]);

    // 正常短消息不受影响
    const normal = await send('private:789', stOther.agentToken, '好呀');
    assert.equal(normal.status, 200, normal.body);
  });
});

await test('语音 label 过守卫：呼语拦截、叙述句替换', async () => {
  h.setMode('reserved2');
  h.setReady(true);
  const libraryDir = path.join(h.temp, 'audio');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
  await assert.rejects(
    () => h.sendVoiceForV2('private:789', path.join(libraryDir, 'inside.mp3'), { label: '老爹早', readback: false }),
    /称呼越界/,
    '呼语式 label 必须被拦截'
  );
  await h.sendVoiceForV2('private:789', path.join(libraryDir, 'inside.mp3'), { label: '给老爹的留言', readback: false });
  assert.equal(
    h.getSocialV2State('private:789').recentMessages.at(-1).text,
    '给你的留言',
    '叙述句 label 应替换后记录'
  );
});

await test('节奏事实注入：触发阈值才出现', async () => {
  const st = h.getSocialV2State('group:456');
  const now = Date.now();
  st.recentMessages = [
    { sender: '我', text: 'a', isSelf: true, time: now - 60000 },
    { sender: '我', text: 'b', isSelf: true, time: now - 30000 },
    { sender: '我', text: 'c', isSelf: true, time: now - 10000 },
  ];
  st.lastIncomingAt = now - 37 * 60000;
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【节奏事实】/);
  assert.match(prompt, /连续 3 条/);
  assert.match(prompt, /37 分钟/);
  assert.match(prompt, /本条可以不回/);

  const fresh = h.getSocialV2State('private:789');
  fresh.recentMessages = [];
  fresh.lastIncomingAt = now;
  const prompt2 = h.buildWakePromptV2('private:789', 'message');
  assert.doesNotMatch(prompt2, /【节奏事实】/, '未触发阈值时不应注入');
});

await test('主动配额参数已接线（源码静态断言）', () => {
  const src = fs.readFileSync(path.join(h.root ?? '.', 'src', 'bridge.js'), 'utf8')
    || fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /unansweredSkipMs/, '未回追加跳过参数');
  assert.match(src, /privateMaxPerDay/, '私聊每日主动配额参数');
  assert.match(src, /botOnlyFactor/, '无真人降频参数');
  assert.match(src, /proactiveWakeTimes/, '主动唤醒记账字段');
});

await test('发图 caption 过守卫：呼语拦截、meta 拦截', async () => {
  h.setMode('reserved2');
  h.setReady(true);
  const imagesDir = path.join(h.temp, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'ok.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ir0QAAAAASUVORK5CYII=', 'base64'
  ));
  const stOther = h.getSocialV2State('private:789');
  await withServer(h, async (port) => {
    const sendImage = (caption) => call(port, '/api/socialV2/send-image', {
      method: 'POST',
      headers: { ...ADMIN, 'x-agent-token': stOther.agentToken, 'x-agent-call': '1' },
      body: { key: 'private:789', file: 'ok.png', caption },
    });
    const vocative = await sendImage('老爹早');
    assert.equal(vocative.status, 403, vocative.body);
    assert.match(vocative.json.error, /称呼越界/);
    const meta = await sendImage('⏳ 权限测试');
    assert.equal(meta.status, 403, meta.body);
    assert.match(meta.json.error, /元信息泄漏|称呼越界/);
  });
});

await test('开关可单独关：address/meta/lengthNudge 全关后原内容放行', async () => {
  const h2 = await bridgeHarness({
    config: {
      allow: { private: ['123', '789'], groups: ['456'] },
      socialV2: { guard: { address: { enabled: false }, meta: { enabled: false }, lengthNudge: { enabled: false } } },
    },
  });
  try {
    h2.setMode('reserved2');
    h2.setReady(true);
    const st = h2.getSocialV2State('private:789');
    await withServer(h2, async (port) => {
      const send = (messages) => call(port, '/api/socialV2/send-message', {
        method: 'POST',
        headers: { ...ADMIN, 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
        body: { key: 'private:789', messages },
      });
      const vocative = await send('老爹早');
      assert.equal(vocative.status, 200, vocative.body);
      assert.equal(h2.getSocialV2State('private:789').recentMessages.at(-1).text, '老爹早', 'address 关闭时不替换不拦截');
      const meta = await send('⏳ 权限测试');
      assert.equal(meta.status, 200, meta.body);
      const tooLong = await send('这'.repeat(41));
      assert.equal(tooLong.status, 200, tooLong.body);
    });
  } finally { await h2.close(); }
});

await h.close();
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
