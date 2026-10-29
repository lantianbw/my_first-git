import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

function createMod() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-mods-'));
  const dir = path.join(root, 'observer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'observer',
    name: '观察器',
    version: '1.0.0',
    apiVersion: '1',
    entry: './index.js',
    hooks: ['inbound.observe', 'outbound.observe', 'wake.before', 'tick.daily'],
    level: 'owner',
    default: true
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `
export default {
  setup(ctx) {
    ctx.audit('setup-ok');
  },
  hooks: {
    'inbound.observe': (ctx, payload) => {
      ctx.audit('inbound:' + payload.text);
      return { note: 'inbound-note' };
    },
    'outbound.observe': (ctx, payload) => {
      ctx.audit('outbound:' + payload.ok);
    },
    'wake.before': (ctx, payload) => ({ append: 'MOD-WAKE:' + payload.reason }),
    'tick.daily': (ctx, payload) => {
      ctx.audit('daily:' + payload.date);
    }
  }
};
`);
  return { root, dir };
}

test('桥接启动加载 mod，并接通入站/出站/wake/tick 四个挂点', async () => {
  const { root } = createMod();
  const h = await bridgeHarness({ config: { mods: { enabled: true, dir: root } } });
  try {
    assert.equal(h.cfg.mods.enabled, true);
    assert.equal(h.cfg.mods.dir, root);
    const status = h.modHost?.status();
    assert.ok(status, '桥接应暴露 modHost');
    assert.deepEqual(status.hooks['inbound.observe'], ['observer']);
    assert.deepEqual(status.hooks['outbound.observe'], ['observer']);
    assert.deepEqual(status.hooks['wake.before'], ['observer']);
    assert.deepEqual(status.hooks['tick.daily'], ['observer']);

    const prompt = h.buildWakePromptV2('group:456', 'question');
    assert.ok(prompt.includes('MOD-WAKE:question'), 'wake.before 的 append 必须进入最终 prompt');

    await h.sendToQQ('group:456', 'hello outbound');
    await h.handleIncoming('group', '456', {
      user_id: 789,
      self_id: 999,
      message_id: 7001,
      message: [{ type: 'text', data: { text: 'hello inbound' } }],
      raw_message: 'hello inbound',
      sender: { nickname: '测试群友', card: '测试群友' }
    }, h.cfg);
    const daily = await h.modHost.runDaily({ date: '2026-10-29' });
    assert.deepEqual({ ran: daily.ran, failed: daily.failed }, { ran: 1, failed: 0 });

    const activity = fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8');
    assert.ok(activity.includes('[mod:observer] setup-ok'));
    assert.ok(activity.includes('[mod:observer] inbound:hello inbound'));
    assert.ok(activity.includes('[mod:observer] inbound-note'));
    assert.ok(activity.includes('[mod:observer] outbound:true'));
    assert.ok(activity.includes('[mod:observer] daily:2026-10-29'));
  } finally {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mod 目录为空时启动不受影响；default=false 的 mod 不加载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-mods-off-'));
  const dir = path.join(root, 'disabled');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'disabled', version: '1.0.0', apiVersion: '1', entry: './index.js',
    hooks: ['tick.daily'], level: 'owner', default: false
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'throw new Error("should not import");');
  const h = await bridgeHarness({ config: { mods: { enabled: true, dir: root } } });
  try {
    assert.deepEqual(h.modHost.status().hooks['tick.daily'], [], 'default=false 的 mod 不得加载');
  } finally {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
