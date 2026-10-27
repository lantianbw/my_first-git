// 回归：跨会话带话的方向规则、校验顺序、限频（src/relay.js）。
//
// 核心是「双向但单向收口」：
//   · owner 私聊 → 白名单内任何人/群      允许
//   · 朋友私聊 / 群 → 只能是 owner 本人    允许
//   · 朋友私聊 → 另一个朋友               拒绝（文案必须是"其他人只能把话带给 owner"）
// 另外锁住校验顺序：先开关/令牌/会话/格式，再方向，再限频，最后才碰文本与发送。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelay, normalizeRelayConfig, relayAllowedTargets } from '../src/relay.js';

const OWNER = 10001;
const OWNER_KEY = `private:${OWNER}`;
const FRIEND = 'private:20002';
const OTHER_FRIEND = 'private:30003';
const GROUP = 'group:40004';
const STRANGER = 'private:99999';
const OTHER_GROUP = 'group:50005';

/** 造一个 relay：所有依赖都注入，不碰网络与磁盘。 */
function makeRelay(overrides = {}) {
  const sent = [];
  const logs = [];
  const activity = [];
  const sessions = new Set([OWNER_KEY, FRIEND, OTHER_FRIEND, STRANGER, GROUP, OTHER_GROUP]);
  const state = { clock: Date.UTC(2026, 9, 27, 4, 0, 0) };
  const relay = createRelay({
    cfg: {
      socialV2: { relay: { enabled: true, maxPerHour: 5 }, send: { maxMessageChars: 500 } },
      allow: { private: [Number(FRIEND.split(':')[1]), Number(OTHER_FRIEND.split(':')[1])], groups: [Number(GROUP.split(':')[1])] }
    },
    ownerQQ: OWNER,
    hasSession: (key) => sessions.has(key),
    agentTokenOk: (key, token) => token === `tok:${key}`,
    maxChars: 500,
    isSensitive: (text) => text.includes('身份证'),
    guardLength: () => ({ ok: true, reason: '' }),
    send: async (to, text) => {
      sent.push({ to, text });
      return 1;
    },
    now: () => state.clock,
    log: (line) => logs.push(line),
    appendActivity: (line) => activity.push(line),
    ...overrides
  });
  return { relay, sent, logs, activity, state, sessions };
}

const call = (relay, key, to, text = '帮我跟他说一声，明天见') =>
  relay.handle({ key, to, text, token: `tok:${key}` });

test('1) owner 私聊 → 白名单朋友私聊：通过', async () => {
  const { relay, sent } = makeRelay();
  const r = await call(relay, OWNER_KEY, FRIEND);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, from: OWNER_KEY, to: FRIEND, sent: 1 });
  assert.equal(sent.length, 1);
});

test('2) owner 私聊 → 白名单群：通过', async () => {
  const { relay } = makeRelay();
  const r = await call(relay, OWNER_KEY, GROUP);
  assert.equal(r.status, 200);
  assert.equal(r.body.to, GROUP);
});

test('3) owner 私聊 → 不在白名单的号：拒绝（403）', async () => {
  const { relay, sent } = makeRelay();
  const r = await call(relay, OWNER_KEY, STRANGER);
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /只有 owner 私聊可以把话带给别人/);
  assert.equal(sent.length, 0, '被拒绝时不能真的发出去');
});

test('4) 朋友私聊 → owner：通过', async () => {
  const { relay, sent } = makeRelay();
  const r = await call(relay, FRIEND, OWNER_KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, from: FRIEND, to: OWNER_KEY, sent: 1 });
  assert.equal(sent[0].to, OWNER_KEY);
});

test('5) 朋友私聊 → 另一个朋友：拒绝，文案是「只能带给 owner」', async () => {
  const { relay, sent } = makeRelay();
  const r = await call(relay, FRIEND, OTHER_FRIEND);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, '其他人只能把话带给 owner');
  assert.equal(sent.length, 0);
});

test('6) 群 → owner：通过', async () => {
  const { relay } = makeRelay();
  const r = await call(relay, GROUP, OWNER_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.from, GROUP);
  assert.equal(r.body.to, OWNER_KEY);
});

test('7) 群 → 朋友私聊：拒绝（403）', async () => {
  const { relay } = makeRelay();
  const r = await call(relay, GROUP, FRIEND);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, '其他人只能把话带给 owner');
});

test('8) 目标等于当前会话：400', async () => {
  const { relay, sent } = makeRelay();
  const sameSession = await call(relay, OWNER_KEY, OWNER_KEY);
  assert.equal(sameSession.status, 400);
  assert.match(sameSession.body.error, /不能把话带给自己/);

  const sameFriend = await call(relay, FRIEND, FRIEND);
  assert.equal(sameFriend.status, 400, '非 owner 会话也不能带给自己');
  assert.equal(sent.length, 0);
});

test('9) 超过 maxPerHour：429，且窗口滑动后恢复', async () => {
  const { relay, sent, state } = makeRelay();
  assert.equal((await call(relay, OWNER_KEY, FRIEND)).status, 200);
  assert.equal((await call(relay, OWNER_KEY, GROUP)).status, 200);
  assert.equal((await call(relay, OWNER_KEY, OTHER_FRIEND)).status, 200);
  assert.equal((await call(relay, OWNER_KEY, FRIEND)).status, 200);
  assert.equal((await call(relay, OWNER_KEY, GROUP)).status, 200);
  const blocked = await call(relay, OWNER_KEY, FRIEND);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /1 小时最多 5 次/);
  assert.equal(sent.length, 5, '第 6 次必须被挡在发送之前');

  // 另一路来源不受 owner 的额度影响（按 fromKey 分别计数）
  assert.equal((await call(relay, FRIEND, OWNER_KEY)).status, 200);

  // 一小时后再试，窗口滑过去就放行
  state.clock += 60 * 60 * 1000 + 1;
  assert.equal((await call(relay, OWNER_KEY, FRIEND)).status, 200);
});

test('10) 正常路径：发送函数被调用一次，目标与文本都正确', async () => {
  const { relay, sent, logs, activity } = makeRelay();
  const r = await relay.handle({ key: FRIEND, to: OWNER_KEY, text: '  替我说句谢谢  ', token: `tok:${FRIEND}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, from: FRIEND, to: OWNER_KEY, sent: 1 });
  assert.equal(sent.length, 1, '只能发一次（禁止群发）');
  assert.equal(sent[0].to, OWNER_KEY);
  assert.equal(sent[0].text, '替我说句谢谢');
  // '替我说句谢谢' = 6 字（trim 之后的长度）
  assert.deepEqual(logs, [`[relay] ${FRIEND} -> ${OWNER_KEY} 6 字`]);
  assert.deepEqual(activity, [`[relay] ${FRIEND} -> ${OWNER_KEY} 6 字`], '审计要落一行');
});

test('校验顺序：未开启 → 403（连令牌都不看）', async () => {
  const { relay } = makeRelay({
    cfg: { socialV2: { relay: { enabled: false, maxPerHour: 5 } }, allow: { private: [], groups: [] } }
  });
  const r = await relay.handle({ key: OWNER_KEY, to: FRIEND, text: 'hi', token: `tok:${OWNER_KEY}` });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /未开启/);
});

test('校验顺序：令牌错 → 403；会话不存在 → 403', async () => {
  const { relay } = makeRelay();
  assert.equal((await relay.handle({ key: OWNER_KEY, to: FRIEND, text: 'hi', token: 'bad' })).status, 403);
  assert.equal((await relay.handle({ key: 'private:12345', to: OWNER_KEY, text: 'hi', token: 'tok:private:12345' })).status, 403);
});

test('校验顺序：to 格式错 → 400', async () => {
  const { relay } = makeRelay();
  for (const bad of ['owner', 'private:', 'private:abc', 'group:-1', '']) {
    const r = await call(relay, OWNER_KEY, bad);
    assert.equal(r.status, 400, `to=${JSON.stringify(bad)} 应为 400`);
  }
});

test('文本校验：空 / 超长 / 敏感 / 出站守卫 都挡在发送之前', async () => {
  const { relay, sent } = makeRelay();
  assert.equal((await call(relay, OWNER_KEY, FRIEND, '   ')).status, 400);
  assert.equal((await call(relay, OWNER_KEY, FRIEND, '字'.repeat(501))).status, 400);
  assert.equal((await call(relay, OWNER_KEY, FRIEND, '他的身份证号是 xxx')).status, 403);

  const guarded = makeRelay({ guardLength: () => ({ ok: false, reason: '出站守卫：像在写小说' }) });
  const r = await call(guarded.relay, OWNER_KEY, FRIEND);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /出站守卫/);
  assert.equal(sent.length, 0);
});

test('发送失败 → 502，且不写审计', async () => {
  const { relay, logs, activity } = makeRelay({ send: async () => { throw new Error('OneBot 断线'); } });
  const r = await call(relay, OWNER_KEY, FRIEND);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /OneBot 断线/);
  assert.equal(activity.length, 0);
  assert.ok(logs.some((line) => line.includes('发送失败')));
});

test('配置归一化与白名单解析', () => {
  assert.deepEqual(normalizeRelayConfig({ enabled: true, maxPerHour: 5 }), { enabled: true, maxPerHour: 5 });
  assert.deepEqual(normalizeRelayConfig({ enabled: 'true', maxPerHour: 'abc' }), { enabled: false, maxPerHour: 5 }, '只有严格 true 才算开启');
  assert.deepEqual(normalizeRelayConfig(undefined), { enabled: false, maxPerHour: 5 });
  assert.deepEqual(
    [...relayAllowedTargets({ private: [20002, '30003'], groups: [40004] })].sort(),
    [FRIEND, OTHER_FRIEND, GROUP].sort()
  );
  assert.equal(relayAllowedTargets(undefined).size, 0);
});
