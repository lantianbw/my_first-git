import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, formatActivity, summarize } from '../src/observability/activity.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// 用本地时间构造，避免断言依赖机器时区（log 时间是本地时间，与 bridge 的 localClock 一致）。
const AT = new Date(2026, 9, 28, 12, 0, 0).getTime();

test('单行：时间 | kind | 脱敏 key | 详情（含 spec 契约）', () => {
  assert.equal(spec.name, 'observability/activity');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  const line = formatActivity({ at: AT, kind: 'info', key: 'private:10001', detail: '上线完成' });
  assert.equal(line, '2026-10-28 12:00:00 | info | private:***01 | 上线完成');
  assert.ok(!line.includes('\n'));

  // at 缺失时退回 now；kind 缺失给 info
  assert.equal(formatActivity({ now: AT, detail: '兜底' }), '2026-10-28 12:00:00 | info | 兜底');
});

test('换行替换：内部换行一律变成 ⏎，输出仍是单行', () => {
  const line = formatActivity({
    at: AT,
    kind: 'warn',
    detail: '第一行\n第二行\r\n第三行\r第四行'
  });
  assert.equal(line, '2026-10-28 12:00:00 | warn | 第一行⏎第二行⏎第三行⏎第四行');
  assert.ok(!/[\r\n]/.test(line));
  assert.equal(line.match(/⏎/g).length, 3);
});

test('脱敏：key 不出现原文，坏 key 遮成 ***，无 key 不留空段', () => {
  const line = formatActivity({ at: AT, kind: 'info', key: 'group:123456789', detail: '触发' });
  assert.equal(line, '2026-10-28 12:00:00 | info | group:*******89 | 触发');
  assert.ok(!line.includes('123456789'));

  assert.equal(formatActivity({ at: AT, key: 'bad-key' }), '2026-10-28 12:00:00 | info | ***');
  assert.equal(formatActivity({ at: AT, kind: 'info', detail: 'x' }), '2026-10-28 12:00:00 | info | x');
});

test('窗口过滤：只统计 [now-windowMs, now]，未来与过老都不算', () => {
  const entries = [
    { at: AT - 1 * HOUR, kind: 'info', detail: '刚才' },
    { at: AT - 25 * HOUR, kind: 'info', detail: '太老' },
    { at: AT, kind: 'info', detail: '恰好现在' },
    { at: AT + 1 * HOUR, kind: 'info', detail: '未来' }
  ];
  assert.equal(summarize(entries, { windowMs: 24 * HOUR, now: AT }).total, 2);
  assert.equal(summarize(entries, { windowMs: 30 * MINUTE, now: AT }).total, 1);
  // 窗口缺省为 24h：25 小时前的那条不算，1 小时前的算
  assert.equal(summarize(entries, { now: AT }).total, 2);
});

test('按 kind 计数：窗口内分组累加，缺省 kind 记 info', () => {
  const entries = [
    { at: AT - MINUTE, kind: 'info', detail: 'a' },
    { at: AT - 2 * MINUTE, kind: 'warn', detail: 'b' },
    { at: AT - 3 * MINUTE, kind: 'info', detail: 'c' },
    { at: AT - 4 * MINUTE, detail: 'd' }
  ];
  assert.deepEqual(summarize(entries, { windowMs: HOUR, now: AT }).byKind, { info: 3, warn: 1 });
});

test('按 key 计数：用脱敏后的 key 分组，无 key 的条目不计', () => {
  const entries = [
    { at: AT - MINUTE, key: 'group:123456789', kind: 'info' },
    { at: AT - 2 * MINUTE, key: 'group:123456789', kind: 'warn' },
    { at: AT - 3 * MINUTE, key: 'private:10001', kind: 'info' },
    { at: AT - 4 * MINUTE, kind: 'info' }
  ];
  assert.deepEqual(summarize(entries, { windowMs: HOUR, now: AT }).byKey, {
    'group:*******89': 2,
    'private:***01': 1
  });
});

test('latest 取最新：窗口内 at 最大的一条，且已格式化脱敏', () => {
  const entries = [
    { at: AT - 3 * HOUR, kind: 'info', key: 'group:123456789', detail: '最早' },
    { at: AT - 1 * HOUR, kind: 'warn', key: 'private:10001', detail: '最新' },
    { at: AT - 2 * HOUR, kind: 'info', key: 'private:10001', detail: '中间' }
  ];
  const result = summarize(entries, { windowMs: 24 * HOUR, now: AT });
  assert.equal(result.latest, '2026-10-28 11:00:00 | warn | private:***01 | 最新');
  assert.ok(!result.latest.includes('10001'));
});

test('空数组：total 0、两个分组为空、latest 为空串', () => {
  assert.deepEqual(summarize([], { windowMs: HOUR, now: AT }), {
    total: 0,
    byKind: {},
    byKey: {},
    latest: ''
  });
  assert.deepEqual(summarize(undefined, { now: AT }), {
    total: 0,
    byKind: {},
    byKey: {},
    latest: ''
  });
});
