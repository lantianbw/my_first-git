// 桥接侧的接线验证（M11）：真起一份桥接（假网关），不走真实 QQ / DSH。
// 单纯测纯函数不够——上一版的坑就是「函数写好了但没人调」，所以这里直接打 HTTP 路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';
import { CAPABILITIES, ALERT_COOLDOWN_MS } from '../src/tools/capabilities.js';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  if (token) h['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request hung')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

/** 凡是发给 owner（fixture 里是 123）的私聊，按文本过滤。 */
function ownerPrivateSends(h, needle) {
  return h.calls.sent.filter((c) => c.kind === 'private' && c.id === 123 && String(c.text ?? '').includes(needle));
}

test('qq_get_prompt 的返回里带 capabilities，形状与能力表一致', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/prompt?key=group%3A456', { token: st.agentToken });
      assert.equal(res.status, 200, `prompt 应当 200，实际 ${res.status} ${res.body}`);
      const caps = res.json?.capabilities;
      assert.ok(Array.isArray(caps), 'capabilities 必须是数组');
      assert.equal(caps.length, CAPABILITIES.length, '能力表每一项都要出现');
      // 已钉死的形状：name / desc / enabled，可选 why
      for (const item of caps) {
        assert.deepEqual(
          Object.keys(item).filter((k) => k !== 'why').sort(),
          ['desc', 'enabled', 'name']
        );
        assert.equal(typeof item.enabled, 'boolean');
        assert.doesNotMatch(`${item.name} ${item.desc}`, /qq_/, '给模型看的文案里不能出现工具名');
      }
      // 关掉的功能必须带上原因，否则模型没法解释「为什么不行」
      for (const item of caps.filter((c) => c.enabled === false)) {
        assert.ok(item.why && item.why.length > 0, `${item.name} 关着就得说明原因`);
      }
    });
  } finally { await h.close(); }
});

test('capabilities 跟着真实开关走（关掉语音 → 发语音变灰，并说明原因）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/prompt?key=group%3A456', { token: st.agentToken });
      assert.equal(res.status, 200);
      const voice = res.json.capabilities.find((c) => c.name === '发语音');
      assert.equal(voice.enabled, false);
      assert.equal(voice.why, '语音功能整个关着');
      const text = res.json.capabilities.find((c) => c.name === '说话');
      assert.equal(text.enabled, true, '关语音不能连累文字');
    });
  } finally { await h.close(); }
});

test('level=error 真的私聊 owner，同内容 10 分钟内只发一次', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    const body = { key: 'group:456', level: 'error', message: '语音发不出去' };
    await withServer(h, async (port) => {
      const first = await call(port, '/api/socialV2/feedback', { method: 'POST', token: st.agentToken, body });
      assert.equal(first.status, 200, `反馈接口应当 200，实际 ${first.status} ${first.body}`);
      await sleep(150); // 告警是 fire-and-forget，给它一点时间进发送队列

      const alerts = ownerPrivateSends(h, '【她的报告】');
      assert.equal(alerts.length, 1, `应当私聊主人一条告警，实际 ${alerts.length} 条`);
      assert.equal(alerts[0].text, '【她的报告】群 456：语音发不出去');
      assert.ok(!alerts[0].text.includes('group:456'), '给主人看的是人话，不是裸 key');

      // 同一条错误再报一次：10 分钟冷却内不再打扰主人
      const second = await call(port, '/api/socialV2/feedback', { method: 'POST', token: st.agentToken, body });
      assert.equal(second.status, 200, '重复反馈本身仍然要成功（只是不再发告警）');
      await sleep(150);
      assert.equal(ownerPrivateSends(h, '【她的报告】').length, 1, '冷却期内不得重复私聊');

      // 换了内容就是新问题，照发
      const third = await call(port, '/api/socialV2/feedback', {
        method: 'POST', token: st.agentToken, body: { ...body, message: '表情库读不出来' }
      });
      assert.equal(third.status, 200);
      await sleep(150);
      assert.equal(ownerPrivateSends(h, '【她的报告】').length, 2, '不同内容应当另发一条');
    });
  } finally { await h.close(); }
});

test('非 error 级别不打扰 owner（info/warning 只记账）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      for (const level of ['info', 'warning']) {
        const res = await call(port, '/api/socialV2/feedback', {
          method: 'POST', token: st.agentToken, body: { key: 'group:456', level, message: `${level} 测试` }
        });
        assert.equal(res.status, 200);
      }
      await sleep(150);
      assert.equal(ownerPrivateSends(h, '【她的报告】').length, 0, 'info/warning 不该发告警');
    });
  } finally { await h.close(); }
});

test('冷却窗口常量就是 10 分钟（写死在这里，防止有人悄悄改小）', () => {
  assert.equal(ALERT_COOLDOWN_MS, 10 * 60 * 1000);
});
