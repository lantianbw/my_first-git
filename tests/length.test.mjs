import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLengthNudge, spec, DEFAULTS } from '../src/guards/length.js';

test('短消息一律放行', () => {
  assert.deepEqual(evaluateLengthNudge({ messages: ['在吗', '吃了没'] }), { ok: true });
});

test('单条超长：拦，且原因里带实际字数与上限', () => {
  const long = '啊'.repeat(41);
  const v = evaluateLengthNudge({ messages: [long] });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'single');
  assert.equal(v.length, 41);
  assert.match(v.reason, /41 字/);
  assert.match(v.reason, /上限 40 字/);
});

test('单条恰好 40 字：放行（边界）', () => {
  assert.deepEqual(evaluateLengthNudge({ messages: ['啊'.repeat(40)] }), { ok: true });
});

test('多条均超阈值 + 最近发过 + 本轮未拒过：拦一次', () => {
  const msgs = ['一'.repeat(13), '二'.repeat(14)];
  const v = evaluateLengthNudge({ messages: msgs, sentRecently: true, usedThisRound: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'multi');
  assert.equal(v.count, 2);
  assert.equal(v.threshold, 12);
});

test('多条均超阈值但本轮已拒过一次：放行（防死锁）', () => {
  const msgs = ['一'.repeat(13), '二'.repeat(14)];
  assert.deepEqual(evaluateLengthNudge({ messages: msgs, sentRecently: true, usedThisRound: 1 }), { ok: true });
});

test('多条均超阈值但最近没发过：放行', () => {
  const msgs = ['一'.repeat(13), '二'.repeat(14)];
  assert.deepEqual(evaluateLengthNudge({ messages: msgs, sentRecently: false, usedThisRound: 0 }), { ok: true });
});

test('多条里只有一条超阈值：走不到 multi 规则', () => {
  assert.deepEqual(evaluateLengthNudge({ messages: ['短', '一'.repeat(13)], sentRecently: true }), { ok: true });
});

test('自定义阈值生效', () => {
  const v = evaluateLengthNudge({ messages: ['啊'.repeat(21)], maxSingleChars: 20 });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'single');
  assert.deepEqual(evaluateLengthNudge({ messages: ['啊'.repeat(20)], maxSingleChars: 20 }), { ok: true });
});

test('单条传字符串也能处理', () => {
  assert.deepEqual(evaluateLengthNudge({ messages: '在吗' }), { ok: true });
});

test('spec 与默认值符合契约', () => {
  assert.equal(spec.name, 'guards/length');
  assert.equal(spec.toggle.level, 'owner');
  assert.equal(spec.toggle.hot, true);
  assert.equal(DEFAULTS.maxSingleChars, 40);
  assert.equal(DEFAULTS.multiThreshold, 12);
});

test('源码不碰时钟/随机/console（合约 F.7 F.8）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/guards/length.js', 'utf8');
  assert.equal(/Date\.now|Math\.random|console\./.test(src.replace(/\/\/.*$/gm, '')), false);
});
