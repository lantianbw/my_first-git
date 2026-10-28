import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, isAllowed } from '../src/auth/allow.js';

const OWNER = 10001;
const base = { kind: 'private', id: OWNER, ownerQQ: OWNER, mode: 'chat' };

test('owner 私聊：恒允许，reason=owner（含 spec 契约）', () => {
  assert.equal(spec.name, 'auth/allow');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(isAllowed(base), { allowed: true, reason: 'owner' });
  // 白名单为空、closed-agent 都不影响 owner
  assert.deepEqual(isAllowed({ ...base, whitelist: { private: [] }, mode: 'closed-agent' }), {
    allowed: true,
    reason: 'owner'
  });
  // 前导零 / 字符串型 ownerQQ 同样认
  assert.equal(isAllowed({ ...base, id: '010001' }).reason, 'owner');
  assert.equal(isAllowed({ ...base, ownerQQ: '10001' }).reason, 'owner');
});

test('owner 群：群号与 ownerQQ 相同也不算 owner，仍走白名单', () => {
  const result = isAllowed({ kind: 'group', id: OWNER, ownerQQ: OWNER, whitelist: { groups: [] }, mode: 'chat' });
  assert.equal(result.allowed, false);
  assert.notEqual(result.reason, 'owner');
  assert.equal(result.reason, 'whitelist-empty');
});

test('群白名单命中：允许，reason=whitelist', () => {
  const result = isAllowed({
    kind: 'group',
    id: 123456789,
    ownerQQ: OWNER,
    whitelist: { groups: [999, '123456789'] },
    mode: 'chat'
  });
  assert.deepEqual(result, { allowed: true, reason: 'whitelist' });
});

test('群白名单未命中：拒绝，reason=not-whitelisted', () => {
  const result = isAllowed({
    kind: 'group',
    id: 123456789,
    ownerQQ: OWNER,
    whitelist: { groups: ['999'] },
    mode: 'chat'
  });
  assert.deepEqual(result, { allowed: false, reason: 'not-whitelisted' });
});

test('私聊白名单：非 owner 私聊按白名单放行 / 拦截，不串用群白名单', () => {
  const allowed = isAllowed({ ...base, id: 555, whitelist: { private: ['555'], groups: ['777'] } });
  assert.deepEqual(allowed, { allowed: true, reason: 'whitelist' });

  const missing = isAllowed({ ...base, id: 556, whitelist: { private: ['555'] } });
  assert.equal(missing.reason, 'not-whitelisted');

  // 群白名单里有这个号也没用
  assert.equal(isAllowed({ ...base, id: 777, whitelist: { private: [] } }).reason, 'whitelist-empty');
});

test('mode 限制：closed-agent 只放 owner 私聊', () => {
  // 命中白名单的群也不行
  assert.deepEqual(
    isAllowed({ kind: 'group', id: 123456789, ownerQQ: OWNER, whitelist: { groups: ['123456789'] }, mode: 'closed-agent' }),
    { allowed: false, reason: 'mode-restricted' }
  );
  // 非 owner 私聊，即使白名单命中也不行
  assert.deepEqual(
    isAllowed({ kind: 'private', id: 555, ownerQQ: OWNER, whitelist: { private: ['555'] }, mode: 'closed-agent' }),
    { allowed: false, reason: 'mode-restricted' }
  );
});

test('白名单为空：拒绝，reason=whitelist-empty', () => {
  assert.equal(isAllowed({ ...base, id: 555, whitelist: { private: [] } }).reason, 'whitelist-empty');
  assert.equal(isAllowed({ ...base, id: 555, whitelist: {} }).reason, 'whitelist-empty');
  assert.equal(isAllowed({ ...base, id: 555 }).reason, 'whitelist-empty');
});

test('id 类型怪值：数字/字符串/前后空格等价，空值与对象按非法 id 拒绝', () => {
  assert.equal(isAllowed({ ...base, id: 10001 }).reason, 'owner');
  assert.equal(isAllowed({ ...base, id: '10001' }).reason, 'owner');
  assert.equal(isAllowed({ ...base, id: '  10001  ' }).reason, 'owner');
  assert.equal(isAllowed({ ...base, ownerQQ: '00010001' }).reason, 'owner');

  for (const bad of [undefined, null, '', '   ', 'abc', {}, '12a', '0']) {
    assert.deepEqual(isAllowed({ ...base, id: bad, ownerQQ: OWNER }), { allowed: false, reason: 'bad-id' }, String(bad));
  }
});

test('reason 非空：任何分支都带回可读原因', () => {
  const cases = [
    base,
    { ...base, kind: 'group' },
    { ...base, kind: 'group', whitelist: { groups: ['1'] } },
    { ...base, kind: 'group', whitelist: { groups: ['123'] }, id: 999 },
    { ...base, mode: 'closed-agent' },
    { ...base, id: 'abc' },
    { ...base, kind: 'channel' },
    { ...base, whitelist: { private: [OWNER + 1] }, id: OWNER + 1 }
  ];
  for (const input of cases) {
    const { reason } = isAllowed(input);
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 0);
  }
});

test('非法 kind：只认 group / private', () => {
  for (const kind of ['channel', 'GROUP', 'Private', '', undefined, null, 'group ']) {
    assert.deepEqual(isAllowed({ ...base, kind }), { allowed: false, reason: 'bad-kind' }, String(kind));
  }
});
