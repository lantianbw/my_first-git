import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, parseKey, isOwnerKey, redactKey } from '../src/session/key.js';

test('合法 group：解析并规范化（含 spec 契约）', () => {
  assert.equal(spec.name, 'session/key');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(parseKey('group:123456789'), {
    ok: true,
    kind: 'group',
    id: '123456789',
    key: 'group:123456789'
  });
  // 前导零 / 首尾空白按规范化处理，不算别名
  assert.equal(parseKey('  group:000123  ').key, 'group:123');
});

test('合法 private：id 支持 1~20 位纯数字（不转 Number，20 位不丢精度）', () => {
  assert.deepEqual(parseKey('private:10001'), {
    ok: true,
    kind: 'private',
    id: '10001',
    key: 'private:10001'
  });

  const long = '9'.repeat(20);
  const parsed = parseKey(`private:${long}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, long);

  const single = parseKey('private:7');
  assert.equal(single.ok, true);
  assert.equal(single.key, 'private:7');
});

test('空串：空文本 / 纯空白 / 非字符串一律拒绝', () => {
  for (const input of ['', '   ', '\n', undefined, null]) {
    const parsed = parseKey(input);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'key 不能为空');
  }
});

test('缺冒号：只有类型没有 id 的拒绝', () => {
  for (const input of ['group123', 'group', 'private', 'group-123', 'g:123']) {
    const parsed = parseKey(input);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error);
  }
  assert.equal(parseKey('group123').error, 'key 缺少冒号，应为 group:<数字> 或 private:<数字>');
  // 别名不认，报的是未知会话类型
  assert.match(parseKey('g:123').error, /未知会话类型/);
});

test('非数字 id：纯数字校验（含空 id、多冒号、内部空格）', () => {
  for (const input of ['group:abc', 'group:12a', 'group:', 'group:1:2', 'group: 123', 'private:１２３']) {
    assert.equal(parseKey(input).ok, false, input);
  }
  assert.equal(parseKey('group:abc').error, 'id 必须是纯数字');
  assert.equal(parseKey('group:').error, 'id 必须是纯数字');
  // 0 不是合法 id（与 canonicalV2Key 的 id > 0 一致）
  assert.equal(parseKey('group:0').ok, false);
  assert.equal(parseKey('group:000').error, 'id 必须大于 0');
});

test('超长 id：21 位拒绝', () => {
  const parsed = parseKey(`group:${'9'.repeat(21)}`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'id 长度超出 1~20 位');

  assert.equal(parseKey(`private:${'9'.repeat(20)}`).ok, true, '20 位是上限内的合法值');
});

test('owner 判定：只认主人自己的私聊，正反都要准', () => {
  assert.equal(isOwnerKey('private:10001', 10001), true);
  assert.equal(isOwnerKey('private:10001', '10001'), true);
  assert.equal(isOwnerKey('private:010001', 10001), true, '前导零不影响判定');

  assert.equal(isOwnerKey('private:10002', 10001), false);
  assert.equal(isOwnerKey('group:10001', 10001), false, '群聊 key 永远不是 owner');
  assert.equal(isOwnerKey('private:10001', ''), false);
  assert.equal(isOwnerKey('private:10001', 'abc'), false);
  assert.equal(isOwnerKey('private:10001', null), false);
  assert.equal(isOwnerKey('bad-key', 10001), false);
});

test('redactKey：保留末 2 位，其余替换为 *', () => {
  assert.equal(redactKey('group:123456789'), 'group:*******89');
  assert.equal(redactKey('private:10001'), 'private:***01');
  assert.equal(redactKey('private:7'), 'private:7');       // 不足 2 位时没有可遮的
  assert.equal(redactKey('group:000123'), 'group:*23');    // 先规范化再去前导零
  assert.equal(redactKey('not-a-key'), '***');             // 解析不了一律全遮
  assert.equal(redactKey(''), '***');
});

test('大小写敏感：类型名必须全小写', () => {
  for (const input of ['GROUP:123', 'Group:123', 'Private:10001', 'private :10001']) {
    assert.equal(parseKey(input).ok, false, input);
  }
  assert.match(parseKey('GROUP:123').error, /未知会话类型/);
  assert.equal(isOwnerKey('Private:10001', 10001), false);
  assert.equal(redactKey('GROUP:123'), '***');
});

// 这一组是给 bridge 里 canonicalV2Key 的回归保护：它已改为委托 parseKey，
// 但自身无法单独测试（在 bridge.js 内部）。这里锁住「桥实际会遇到的输入」，
// 将来谁改 parseKey，桥的 key 行为一旦偏离就会在这里报出来。
test('桥实际会遇到的 key：真实群号 / QQ 号与常见脏输入', () => {
  assert.equal(parseKey('group:1057896469').key, 'group:1057896469');
  assert.equal(parseKey('private:1843979560').key, 'private:1843979560');
  assert.equal(parseKey('private:2453753245').key, 'private:2453753245');

  // 以下都应返回 ok:false，对应 canonicalV2Key 拿到 null
  for (const input of ['group:1.5', 'group:-1', 'group:1e3', 'group: 1', 'group:+1', 'group:١٢٣']) {
    assert.equal(parseKey(input).ok, false, input);
  }

  // 首尾空白会被 trim，属于合法输入（与旧实现在进入正则前先 trim 的行为一致）
  assert.equal(parseKey(' private:1 ').key, 'private:1');
});
