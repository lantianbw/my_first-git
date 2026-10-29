import test from 'node:test';
import assert from 'node:assert/strict';

import { HOOKS, LIMITS, createModHost, spec } from '../src/mods/host.js';

const manifest = (id) => ({ id, name: id, version: '1.0.0' });

function harness(limits) {
  const logs = [];
  const audit = [];
  const host = createModHost({
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => 1_793_000_000_000,
    audit: (line) => audit.push(line),
    limits
  });
  return { host, logs, audit };
}

test('spec / LIMITS：契约冻结，四个 v1 挂点固定', () => {
  assert.equal(spec.name, 'mods/host');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log', 'now']);
  assert.ok(Object.isFrozen(spec));
  assert.deepEqual(HOOKS, ['inbound.observe', 'outbound.observe', 'wake.before', 'tick.daily']);
  assert.deepEqual(LIMITS, { wakeAppendChars: 200, tickTimeoutMs: 200 });
  assert.ok(Object.isFrozen(LIMITS));
});

test('observe：只读、异常隔离、note 写审计，未开放挂点不注册', async () => {
  const { host, logs, audit } = harness();
  host.register('unknown.hook', () => { throw new Error('must not run'); }, manifest('bad'));

  host.register('inbound.observe', () => ({ note: '收到一条\n消息' }), manifest('a'));
  host.register('inbound.observe', () => { throw new Error('boom'); }, manifest('b'));
  host.register('inbound.observe', async () => ({ note: '异步也记' }), manifest('c'));

  host.observe('inbound.observe', { key: 'group:1', text: 'hello' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(audit, ['[mod:a] 收到一条 消息', '[mod:c] 异步也记']);
  assert.ok(logs.some((item) => item.level === 'warn' && item.message.includes('mod=b')));
  assert.ok(logs.some((item) => item.message.includes('未开放挂点')));
  assert.equal(host.status().hooks['inbound.observe'].length, 3);
});

test('observe：payload 被冻结，mod 不能改主链路对象', () => {
  const { host } = harness();
  let seen;
  host.register('outbound.observe', (_ctx, payload) => { seen = payload; }, manifest('freeze'));
  host.observe('outbound.observe', { key: 'private:1', ok: true, nested: { a: 1 } });
  assert.equal(Object.isFrozen(seen), true);
  assert.equal(Object.isFrozen(seen.nested), true);
  assert.throws(() => { 'use strict'; seen.ok = false; }, TypeError);
});

test('wake.before：合计 200 字上限，异步与抛错被忽略且不打断后续', () => {
  const { host, logs } = harness();
  host.register('wake.before', () => ({ append: '一'.repeat(100) }), manifest('one'));
  host.register('wake.before', () => ({ append: '二'.repeat(80) }), manifest('two'));
  host.register('wake.before', () => { throw new Error('boom'); }, manifest('bad'));
  host.register('wake.before', () => ({ append: '三'.repeat(20) }), manifest('three'));

  const append = host.wakeAppend({ key: 'group:1', reason: 'question' });
  assert.equal([...append.replace(/\n/g, '')].length, 200);
  assert.ok(append.startsWith('一'.repeat(100)));
  assert.ok(append.endsWith('三'.repeat(20)));
  assert.ok(logs.some((item) => item.message.includes('wake.before 失败')));
  assert.equal(logs.some((item) => item.message.includes('不允许异步')), false);

  const asyncHost = harness().host;
  asyncHost.register('wake.before', async () => ({ append: '迟到' }), manifest('async'));
  assert.equal(asyncHost.wakeAppend({ key: 'group:1' }), '');
});

test('tick.daily：逐 mod 执行，超时与异常不影响其它 mod', async () => {
  const { host, logs } = harness({ tickTimeoutMs: 20 });
  const called = [];
  host.register('tick.daily', async () => { called.push('slow'); await new Promise((r) => setTimeout(r, 80)); }, manifest('slow'));
  host.register('tick.daily', () => { called.push('fast'); }, manifest('fast'));
  host.register('tick.daily', () => { throw new Error('broken'); }, manifest('broken'));
  host.register('tick.daily', () => { called.push('last'); }, manifest('last'));

  const result = await host.runDaily({ date: '2026-10-29' });
  assert.deepEqual(called, ['slow', 'fast', 'last']);
  assert.deepEqual({ ran: result.ran, failed: result.failed }, { ran: 2, failed: 2 });
  assert.equal(result.at, 1_793_000_000_000);
  assert.ok(logs.some((item) => item.message.includes('timeout 20ms')));
  assert.ok(logs.some((item) => item.message.includes('broken')));
});

test('dispose：注销后不再收到调用；status 按挂点列出 mod', () => {
  const { host } = harness();
  let count = 0;
  const dispose = host.register('inbound.observe', () => { count += 1; }, manifest('temp'));
  host.observe('inbound.observe', { key: 'group:1' });
  dispose();
  dispose();
  host.observe('inbound.observe', { key: 'group:1' });
  assert.equal(count, 1);
  assert.deepEqual(host.status().hooks['inbound.observe'], []);
});
