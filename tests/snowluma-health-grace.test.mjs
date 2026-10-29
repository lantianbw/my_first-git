import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

const MINUTE = 60 * 1000;

test('桥接：good=false 先 suspect，连续满 10 分钟才告警，恢复后清零', async () => {
  const h = await bridgeHarness({ config: { snowluma: { goodFalseGraceMs: 10 * MINUTE } } });
  try {
    h.noteReceiveHealth(false, 'heartbeat');
    assert.ok(h.snowlumaHealth.goodFalseSince > 0, '第一段 false 必须记录起始时间');
    let snap = h.snowlumaHealthSnapshot();
    assert.equal(snap.good, false);
    assert.equal(snap.suspect, true);
    assert.equal(snap.degraded, false, '短抖动不能进入 degraded');

    h.reportSnowlumaHealth();
    const logFile = path.join(h.temp, 'state', 'bridge.log');
    assert.equal(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').includes('上游不健康') : false, false);

    h.snowlumaHealth.goodFalseSince = Date.now() - 11 * MINUTE;
    snap = h.snowlumaHealthSnapshot();
    assert.equal(snap.degraded, true, '连续超过 grace 才升级');
    assert.ok(snap.goodFalseForMs >= 10 * MINUTE);
    h.reportSnowlumaHealth();
    assert.match(fs.readFileSync(logFile, 'utf8'), /SnowLuma 上游不健康/);

    h.noteReceiveHealth(true, 'heartbeat');
    assert.equal(h.snowlumaHealth.goodFalseSince, 0, '恢复时计时必须清零');
    snap = h.snowlumaHealthSnapshot();
    assert.equal(snap.suspect, false);
    assert.equal(snap.degraded, false);
    h.reportSnowlumaHealth();
    assert.match(fs.readFileSync(logFile, 'utf8'), /SnowLuma 上游已恢复正常/);
  } finally {
    await h.close();
  }
});
