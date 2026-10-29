import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

const HOUR = 60 * 60 * 1000;

test('owner 新消息触发唤醒时，轮换 idle 闸使用入库前的 lastIncomingAt', async () => {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        sessionRotation: { enabled: true, maxAgeHours: 12 }
      }
    }
  });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const presetDir = path.join(h.temp, 'dsh', 'agent-presets', 'qq-chat-v2');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: |-\n      测试用仿真提示词。\n');
    const key = 'private:123';
    const oldSession = await h.ensureSession(key);
    h.state.sessionMeta[key].createdAt = Date.now() - 13 * HOUR;

    const st = h.getSocialV2State(key);
    st.lastIncomingAt = Date.now() - HOUR;
    st.bootstrapSent = true;
    st.wakeConfig.batchWindowMs = 1000;
    const promptsBefore = h.calls.prompts.length;

    await h.handleIncoming('private', 123, {
      user_id: 123,
      self_id: 999,
      message_id: 9101,
      message: [{ type: 'text', data: { text: '这条消息应落到新会话' } }],
      raw_message: '这条消息应落到新会话',
      sender: { nickname: '饲养员' }
    }, h.cfg);

    for (let i = 0; i < 100 && h.calls.prompts.length === promptsBefore; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(h.calls.prompts.length, promptsBefore + 1, '私聊消息应触发一次唤醒');
    assert.notEqual(h.state.sessions[key], oldSession, '超龄且此前已空闲的会话应在本次唤醒前轮换');
    assert.ok(h.calls.archived.includes(oldSession), '旧会话应归档');
    assert.equal(h.calls.prompts.at(-1).sessionId, h.state.sessions[key], '当前消息必须投递到轮换后的新会话');
  } finally {
    await h.close();
  }
});
