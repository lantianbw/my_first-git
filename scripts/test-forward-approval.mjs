// 合并转发（B）与审批流回归。
//
// 覆盖的硬边界：
//   1. 节点只从当前会话可见消息构造，图片保留 URL，语音/文件保持文字标记；
//   2. 群→owner / same 免审；私聊→群必须 6 位码审批；
//   3. 批准后按存档 payload 执行，重复批准/拒绝/过期都被挡；
//   4. 同会话 5 分钟冷却、每小时审批上限；
//   5. 图片 URL 过期自动降级为文字重试一次；
//   6. owner 在私聊回「同意 码」由桥接直接处理，不唤醒 agent。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  buildForwardNodes,
  degradeImagesToText,
  summarizeForward,
  isExpiredUrlError,
  checkForwardCooldown,
  checkApprovalQuota,
  normalizeApprovals,
  pruneApprovals,
  generateApprovalCode,
  normalizeForwardConfig
} from '../src/forward-approval.js';

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
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

/** 记录型 fetch：可让第一次转发返回「图片过期」。 */
function makeFetch({ failForwardOnce = false } = {}) {
  const log = [];
  let failed = false;
  const fetchImpl = async (url, init = {}) => {
    const action = String(url).split('/').pop();
    let body = init.body;
    try { body = JSON.parse(init.body ?? '{}'); } catch {}
    log.push({ action, body });
    const isForward = action === 'send_private_forward_msg' || action === 'send_group_forward_msg';
    if (isForward && failForwardOnce && !failed) {
      failed = true;
      return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, wording: '图片 URL 已过期' }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  };
  return { fetchImpl, log };
}

function seedMessages(h, key, entries) {
  for (const entry of entries) {
    h.appendSocialV2Message(
      key,
      entry.sender,
      entry.text,
      entry.text,
      false,
      !!entry.isOwner,
      String(entry.messageId),
      entry.media ?? [],
      entry.userId ?? '9001',
      []
    );
  }
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────
await test('节点构造：昵称+文本+图片，语音/文件保文字标记，最多 20 条', () => {
  const messages = [
    { sender: '张三', userId: '9001', text: '看这个图', media: [{ kind: 'image', url: 'https://cdn/a.png', file: 'a' }] },
    { sender: '李四', userId: '9002', text: '[语音]', media: [] },
    { sender: '王五', userId: '9003', text: '[文件报告.pdf]', media: [] }
  ];
  const built = buildForwardNodes(messages);
  assert.equal(built.nodes.length, 3);
  assert.equal(built.imageCount, 1);
  assert.deepEqual(built.nodes[0], {
    type: 'node',
    data: {
      name: '张三',
      uin: '9001',
      content: [
        { type: 'text', data: { text: '看这个图' } },
        { type: 'image', data: { file: 'https://cdn/a.png' } }
      ]
    }
  });
  assert.deepEqual(built.nodes[1].data.content, [{ type: 'text', data: { text: '[语音]' } }]);
  assert.deepEqual(built.nodes[2].data.content, [{ type: 'text', data: { text: '[文件报告.pdf]' } }]);

  const many = buildForwardNodes(Array.from({ length: 25 }, (_, i) => ({ sender: 's', text: `m${i}` })), { maxMessages: 20 });
  assert.equal(many.nodes.length, 20);
  assert.equal(many.dropped, 5);
});

await test('图片降级与预览摘要', () => {
  const built = buildForwardNodes([{ sender: '张三', text: '好图', media: [{ kind: 'image', url: 'https://cdn/a.png' }] }]);
  const degraded = degradeImagesToText(built.nodes);
  assert.deepEqual(degraded[0].data.content[1], { type: 'text', data: { text: '[图片]' } });
  assert.equal(summarizeForward(built.nodes), '好图（图片 x1）');
  assert.equal(summarizeForward(buildForwardNodes([{ sender: 's', text: 'x'.repeat(200) }]).nodes).length, 100 + 1 + '（图片 x0）'.length);
  assert.equal(isExpiredUrlError(new Error('图片 URL 已过期')), true);
  assert.equal(isExpiredUrlError(new Error('权限不足')), false);
});

await test('冷却与审批配额窗口', () => {
  const now = Date.now();
  assert.equal(checkForwardCooldown([], { cooldownMs: 300000, now }).allowed, true);
  const blocked = checkForwardCooldown([now - 1000], { cooldownMs: 300000, now });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(checkForwardCooldown([now - 400000], { cooldownMs: 300000, now }).allowed, true);

  const three = [now - 1000, now - 2000, now - 3000];
  assert.equal(checkApprovalQuota(three, { limit: 3, now }).allowed, false);
  assert.equal(checkApprovalQuota(three.slice(0, 2), { limit: 3, now }).allowed, true);
  assert.equal(checkApprovalQuota([now - 4_000_000, now - 4_000_001, now - 4_000_002], { limit: 3, now }).allowed, true);
});

await test('审批记录归一化：坏 key 丢弃，过期 pending 标 expired', () => {
  const now = Date.now();
  const normalized = normalizeApprovals({
    items: {
      123456: { key: 'private:123', target: 'group', messageIds: ['1', '2'], status: 'pending', createdAt: now, expiresAt: now + 1000 },
      abcdef: { key: 'private:123' },
      '000001': { key: 'private:123', target: 'group', messageIds: [], status: 'weird' }
    }
  });
  assert.deepEqual(Object.keys(normalized.items), ['123456', '000001']);
  assert.equal(normalized.items['000001'].status, 'pending');
  const expired = pruneApprovals({ items: { 123456: { ...normalized.items['123456'], expiresAt: now - 1 } } }, { now });
  assert.equal(expired.approvals.items['123456'].status, 'expired');
  assert.equal(normalizeForwardConfig({ maxMessages: 999 }).maxMessages, 20);
  assert.match(generateApprovalCode([]), /^\d{6}$/);
});

// ── 集成 ─────────────────────────────────────────────────────────────────────
await test('群→owner 免审：节点带昵称与图片', async () => {
  const { fetchImpl, log } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'group:456', [
      { sender: '张三', text: '看这个图', messageId: 1001, media: [{ kind: 'image', url: 'https://cdn/a.png', file: 'a' }] },
      { sender: '李四', text: '笑死', messageId: 1002 }
    ]);
    const result = await h.requestForwardV2({ key: 'group:456', messageIds: ['1001', '1002'], target: 'owner' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'sent');
    assert.equal(result.count, 2);
    assert.equal(result.imageCount, 1);
    const sent = log.find((entry) => entry.action === 'send_private_forward_msg');
    assert.ok(sent, '必须调用 send_private_forward_msg');
    assert.equal(sent.body.user_id, 123);
    assert.equal(sent.body.messages[0].data.name, '张三');
    assert.equal(sent.body.messages[0].data.content[1].data.file, 'https://cdn/a.png');
  } finally { await h.close(); }
});

await test('私聊→群：生成审批码并通知 owner，批准后发出', async () => {
  const { fetchImpl, log } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '私聊里的两条', messageId: 2001, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['2001'], target: 'group' });
    assert.equal(pending.status, 'pending_approval', JSON.stringify(pending));
    assert.match(pending.approvalId, /^\d{6}$/);
    assert.equal(log.some((entry) => entry.action === 'send_group_forward_msg'), false, '未批准前不得发群');

    const notice = h.calls.sent.find((entry) => entry.kind === 'private' && entry.text.includes(pending.approvalId));
    assert.ok(notice, 'owner 必须收到含审批码的预览');
    assert.match(notice.text, /同意/);

    const approved = await h.decideForwardApprovalV2(pending.approvalId, true);
    assert.equal(approved.status, 'sent', JSON.stringify(approved));
    const sent = log.find((entry) => entry.action === 'send_group_forward_msg');
    assert.ok(sent);
    assert.equal(sent.body.group_id, 456);
    assert.equal(sent.body.messages.length, 1);
  } finally { await h.close(); }
});

await test('拒绝：不发送且标记 rejected', async () => {
  const { fetchImpl, log } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '别转', messageId: 2101, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['2101'], target: 'group' });
    const rejected = await h.decideForwardApprovalV2(pending.approvalId, false);
    assert.equal(rejected.rejected, true);
    assert.equal(log.some((entry) => entry.action === 'send_group_forward_msg'), false);
    const again = await h.decideForwardApprovalV2(pending.approvalId, true);
    assert.equal(again.status, 409, '已拒绝的码不能再用');
  } finally { await h.close(); }
});

await test('过期：410 且不再可批准', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '过期测试', messageId: 2201, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['2201'], target: 'group' });
    const file = path.join(h.temp, 'state', 'forward-approvals.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.items[pending.approvalId].expiresAt = Date.now() - 1000;
    fs.writeFileSync(file, JSON.stringify(data));
    const result = await h.decideForwardApprovalV2(pending.approvalId, true);
    assert.equal(result.status, 410, JSON.stringify(result));
  } finally { await h.close(); }
});

await test('重复批准：409', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '重复批准', messageId: 2301, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['2301'], target: 'group' });
    assert.equal((await h.decideForwardApprovalV2(pending.approvalId, true)).status, 'sent');
    const again = await h.decideForwardApprovalV2(pending.approvalId, true);
    assert.equal(again.status, 409, JSON.stringify(again));
  } finally { await h.close(); }
});

await test('超条数截断为 20', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const entries = Array.from({ length: 25 }, (_, i) => ({ sender: 's', text: `m${i}`, messageId: 3000 + i }));
    seedMessages(h, 'group:456', entries);
    const result = await h.requestForwardV2({
      key: 'group:456',
      messageIds: entries.map((entry) => String(entry.messageId)),
      target: 'same'
    });
    assert.equal(result.status, 'sent');
    assert.equal(result.count, 20);
  } finally { await h.close(); }
});

await test('不可见 messageId 被拒', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const result = await h.requestForwardV2({ key: 'group:456', messageIds: ['999999'], target: 'owner' });
    assert.equal(result.status, 400);
    assert.match(result.error, /可见范围/);
  } finally { await h.close(); }
});

await test('图片 URL 过期：降级为文字重试一次', async () => {
  const { fetchImpl, log } = makeFetch({ failForwardOnce: true });
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'group:456', [
      { sender: '张三', text: '图', messageId: 4001, media: [{ kind: 'image', url: 'https://cdn/expired.png' }] }
    ]);
    const result = await h.requestForwardV2({ key: 'group:456', messageIds: ['4001'], target: 'owner' });
    assert.equal(result.status, 'sent', JSON.stringify(result));
    assert.equal(result.degraded, true);
    const calls = log.filter((entry) => entry.action === 'send_private_forward_msg');
    assert.equal(calls.length, 2, '必须重试一次');
    assert.equal(calls[1].body.messages[0].data.content.some((seg) => seg.type === 'image'), false);
    assert.equal(calls[1].body.messages[0].data.content.some((seg) => seg.type === 'text' && seg.data.text === '[图片]'), true);
  } finally { await h.close(); }
});

await test('同会话 5 分钟冷却', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'group:456', [{ sender: 'a', text: '一', messageId: 5001 }, { sender: 'b', text: '二', messageId: 5002 }]);
    assert.equal((await h.requestForwardV2({ key: 'group:456', messageIds: ['5001'], target: 'owner' })).status, 'sent');
    const second = await h.requestForwardV2({ key: 'group:456', messageIds: ['5002'], target: 'owner' });
    assert.equal(second.status, 429, JSON.stringify(second));
  } finally { await h.close(); }
});

await test('owner 私聊「同意 码」：桥接直接执行且不唤醒 agent', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '走审批', messageId: 6001, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['6001'], target: 'group' });
    const before = h.calls.prompts.length;
    await h.handleIncoming('private', 123, {
      user_id: 123,
      self_id: 999,
      message_id: 6002,
      message: [{ type: 'text', data: { text: `同意 ${pending.approvalId}` } }]
    }, h.cfg);
    assert.equal(h.calls.prompts.length, before, '审批回复不得唤醒 agent');
    assert.ok(h.calls.sent.some((entry) => entry.kind === 'private' && entry.text.includes('已转发')), '必须回「已转发」');
  } finally { await h.close(); }
});

await test('控制台审批接口：admin 200 / agent 403 / 非法 400', async () => {
  const { fetchImpl } = makeFetch();
  const h = await bridgeHarness({ globals: { fetch: fetchImpl } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    seedMessages(h, 'private:123', [{ sender: '我', text: '控制台批', messageId: 7001, isOwner: true }]);
    const pending = await h.requestForwardV2({ key: 'private:123', messageIds: ['7001'], target: 'group' });
    await withServer(h, async (port) => {
      const bad = await call(port, '/api/socialV2/forward/approve', {
        method: 'POST', headers: ADMIN, body: { approvalId: 'abc', allow: true }
      });
      assert.equal(bad.status, 400);
      const asAgent = await call(port, '/api/socialV2/forward/approve', {
        method: 'POST', headers: { ...ADMIN, 'x-agent-token': 'fixture-agent', 'x-agent-call': '1' },
        body: { approvalId: pending.approvalId, allow: true }
      });
      assert.equal(asAgent.status, 403);
      const ok = await call(port, '/api/socialV2/forward/approve', {
        method: 'POST', headers: ADMIN, body: { approvalId: pending.approvalId, allow: true }
      });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json.status, 'sent');
    });
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
