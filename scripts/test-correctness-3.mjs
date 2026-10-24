// 三个正确性问题的回归：
//   1. 卡片消息（json 段）解析：成功给出标题/描述/链接，失败保持占位；
//   2. qq_wait_for_messages 的 baseline：快照之后、wait 之前到达的消息也要返回；
//   3. 自己账号的回声不进 unread，markedCount / unreadCount 不计 isSelf。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { formatCardText, formatForwardResponse } from '../src/forward.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

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

// ── 1. 卡片解析 ─────────────────────────────────────────────────────────────
await test('卡片：meta.detail 优先，输出标题/描述/链接', () => {
  const text = formatCardText(JSON.stringify({
    app: 'com.tencent.miniapp',
    prompt: '[QQ小程序]示例',
    meta: { detail: { title: '一起来玩', desc: '点击加入', qqdocurl: 'https://example.com/a' } }
  }));
  assert.equal(text, '[卡片:一起来玩 - 点击加入 https://example.com/a]');

  const flat = formatCardText({ prompt: '标题A', summary: '摘要B', jumpUrl: 'https://x/y' });
  assert.equal(flat, '[卡片:标题A - 摘要B https://x/y]');
});

await test('卡片：解析失败/空对象保持占位，不抛错', () => {
  assert.equal(formatCardText('not-json'), '[卡片消息]');
  assert.equal(formatCardText('{}'), '[卡片消息]');
  assert.equal(formatCardText(null), '[卡片消息]');
  assert.equal(formatCardText({ meta: { detail: {} } }), '[卡片消息]');
});

await test('卡片：forward 内容复用同一解析', () => {
  const data = {
    messages: [{
      sender: { nickname: '张三' },
      message: [{ type: 'json', data: { data: JSON.stringify({ prompt: '群通知', meta: { detail: { desc: '戳这里', jumpUrl: 'https://e/1' } } }) } }]
    }]
  };
  const formatted = formatForwardResponse(data);
  assert.equal(formatted.messages[0].text, '[卡片:群通知 - 戳这里 https://e/1]');
});

// ── 2. wait baseline ─────────────────────────────────────────────────────────
await test('wait：快照之后、wait 之前到达的消息也会返回', async () => {
  const h = await bridgeHarness({
    config: { socialV2: { wait: { minQuietAfterNewMs: 0, minMs: 100, maxMs: 1000, defaultMs: 300 } } }
  });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const st = h.getSocialV2State('group:456');
    h.appendSocialV2Message('group:456', '张三', '第一条', '第一条', false, false, '8001', [], '9001', []);
    h.acknowledgeMessagesV2(st, st.lastUnreadSeq);
    h.appendSocialV2Message('group:456', '李四', '快照之后到达', '快照之后到达', false, false, '8002', [], '9002', []);
    const targetSeq = st.lastUnreadSeq;

    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/wait', {
        method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
        body: { key: 'group:456', purpose: 'reply', quietMs: 0, timeoutMs: 300 }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.ok, true);
      const seqs = (res.json.newMessages ?? []).map((m) => m.seq);
      assert.ok(seqs.includes(targetSeq), `newMessages 应包含 wait 之前到达的 seq ${targetSeq}，实际 ${JSON.stringify(seqs)}`);
    });
  } finally { await h.close(); }
});

// ── 3. 自身回声不计未读 ─────────────────────────────────────────────────────
await test('自身回声：只进 recentMessages，不进 unread，不唤醒', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.setSelfIdentity('小鲸鱼', '999999');
    const before = h.calls.prompts.length;
    await h.handleIncoming('group', 456, {
      user_id: 999999,
      self_id: 999999,
      message_id: 9001,
      message: [{ type: 'text', data: { text: '我自己发的' } }]
    }, h.cfg);
    const st = h.getSocialV2State('group:456');
    assert.equal(st.unread.length, 0, '自己的回声不得进 unread');
    assert.equal(st.recentMessages.at(-1).isSelf, true);
    assert.equal(h.calls.prompts.length, before, '自己的回声不得唤醒 agent');
  } finally { await h.close(); }
});

await test('markedCount 与 unreadCount 都不计 isSelf', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.setSelfIdentity('小鲸鱼', '999999');
    const st = h.getSocialV2State('private:123');
    h.appendSocialV2Message('private:123', '我', '我的回声', '我的回声', false, true, '9101', [], '999999', [], [], true);
    h.appendSocialV2Message('private:123', '对方', '你好', '你好', false, false, '9102', [], '123', []);
    h.appendSocialV2Message('private:123', '对方', '在吗', '在吗', false, false, '9103', [], '123', []);
    assert.equal(st.unread.length, 2, 'unread 只保留对方两条');
    const marked = h.acknowledgeMessagesV2(st, st.lastUnreadSeq);
    assert.equal(marked, 2, 'markedCount 必须排除自己的回声');
    assert.equal(st.unread.length, 0);
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
