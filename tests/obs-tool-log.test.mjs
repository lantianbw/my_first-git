// tests/obs-tool-log.test.mjs — obs/tool-log 单测（脱敏 / JSON 展开 / 截断）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec, SENSITIVE_ARG_KEYS, unwrapJsonLayers, redactSensitive,
  sanitizeToolArgs, prepareToolLogEntry, prepareFeedbackEntry, handle
} from '../src/obs/tool-log.js';

const redact = (s) => String(s).replace(/secret-token/g, '***');

test('契约：spec 冻结、名字与路径一致、locked', () => {
  assert.equal(spec.name, 'obs/tool-log');
  assert.ok(Object.isFrozen(spec));
  assert.equal(spec.toggle.level, 'locked');
});

test('敏感键覆盖：token / authorization / cookie 等都在表里且小写', () => {
  for (const k of ['token', 'authorization', 'cookie', 'private_key', 'x-agent-token']) {
    assert.ok(SENSITIVE_ARG_KEYS.includes(k), k);
  }
  for (const k of SENSITIVE_ARG_KEYS) assert.equal(k, k.toLowerCase());
});

test('redactSensitive：敏感键整体替换为 ***', () => {
  const out = redactSensitive({ token: 'abc', name: 'ok' }, { redact });
  assert.equal(out.token, '***');
  assert.equal(out.name, 'ok');
});

test('redactSensitive：大小写不敏感', () => {
  const out = redactSensitive({ Authorization: 'Bearer x' }, { redact });
  assert.equal(out.Authorization, '***');
});

test('redactSensitive：嵌套对象与数组都递归', () => {
  const out = redactSensitive({ a: { token: 'x' }, list: [{ secret: 'y' }] }, { redact });
  assert.equal(out.a.token, '***');
  assert.equal(out.list[0].secret, '***');
});

test('redactSensitive：丢弃 __proto__ / constructor / prototype 键', () => {
  const out = redactSensitive(JSON.parse('{"__proto__":{"x":1},"constructor":1,"prototype":1,"keep":2}'), { redact });
  assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'prototype'), false);
  assert.equal(out.keep, 2);
});

test('redactSensitive：字符串走注入的文本脱敏', () => {
  assert.equal(redactSensitive('value=secret-token', { redact }), 'value=***');
});

test('unwrapJsonLayers：逐层解开双层转义，最多 4 层', () => {
  const inner = JSON.stringify({ token: 'x' });
  const double = JSON.stringify(inner);
  assert.deepEqual(unwrapJsonLayers(double), { token: 'x' });
  // 解不开的普通字符串保持原样
  assert.equal(unwrapJsonLayers('plain text'), 'plain text');
});

test('sanitizeToolArgs：null / undefined 返回 null', () => {
  assert.equal(sanitizeToolArgs(undefined), null);
  assert.equal(sanitizeToolArgs(null), null);
});

test('sanitizeToolArgs：双层转义里的 token 不落明文', () => {
  const double = JSON.stringify(JSON.stringify({ token: 'abc', q: 'hi' }));
  const text = sanitizeToolArgs(double, { redact });
  assert.ok(!text.includes('abc'));
  assert.match(text, /\*\*\*/);
});

test('sanitizeToolArgs：超长截断带标记，且使用注入的 truncate', () => {
  const long = { a: 'x'.repeat(50) };
  const text = sanitizeToolArgs(long, { redact, maxLength: 10, truncate: (s, n) => s.slice(0, n) });
  assert.ok(text.endsWith('…(truncated)'));
});

test('prepareToolLogEntry：error 脱敏、args 走 sanitize、其余字段原样', () => {
  const entry = { type: 'call', tool: 'echo', error: 'boom secret-token', args: '{"token":"abc"}' };
  const out = prepareToolLogEntry(entry, { redact });
  assert.match(out.error, /\*\*\*/);
  assert.ok(!String(out.args).includes('abc'));
  assert.equal(out.tool, 'echo');
  assert.equal(out.type, 'call');
});

test('prepareFeedbackEntry：只脱敏 message', () => {
  const out = prepareFeedbackEntry({ id: 1, message: 'oops secret-token' }, { redact });
  assert.match(out.message, /\*\*\*/);
  assert.equal(out.id, 1);
});

test('handle：三个 action 正常，未知 action 拒绝', () => {
  assert.equal(handle({}, { action: 'args', args: null }).value, null);
  assert.equal(handle({}, { action: 'tool-entry', entry: { tool: 'x' } }).value.tool, 'x');
  assert.equal(handle({}, { action: 'feedback-entry', entry: { id: 2 } }).value.id, 2);
  const bad = handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
});
