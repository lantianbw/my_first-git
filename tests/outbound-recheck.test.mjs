// tests/outbound-recheck.test.mjs — outbound/recheck 单测（静默判定 / 审计范围 / 分发）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  DEFAULTS,
  shouldBlockSilentReply,
  shouldAuditKey,
  handle
} from '../src/outbound/recheck.js';

const OWNER_QQ = 10001;

// ── 契约面 ──────────────────────────────────────────────────────────────────

test('契约：spec 冻结、名字与路径一致、locked、deps 为 cfg/now', () => {
  assert.equal(spec.name, 'outbound/recheck');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['cfg', 'now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
  assert.ok(Object.isFrozen(spec.deps));
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.roleMode, 'active');
  assert.equal(DEFAULTS.sessionMode, 'chat');
});

// ── 静默判定 ────────────────────────────────────────────────────────────────

test('命中静默：silent + 群聊 key → 拦下', () => {
  assert.equal(shouldBlockSilentReply({ role: '傲娇助手', mode: 'silent' }, { key: 'group:123', ownerQQ: OWNER_QQ }), true);
});

test('命中静默：silent + 非主人私聊 → 拦下', () => {
  assert.equal(shouldBlockSilentReply({ mode: 'silent' }, { key: 'private:20002', ownerQQ: OWNER_QQ }), true);
});

test('不命中静默：active / 其它模式 / mode 缺失 → 放行', () => {
  for (const state of [{ mode: 'active' }, { mode: 'reserved2' }, { role: 'x' }, {}, null, undefined]) {
    assert.equal(shouldBlockSilentReply(state, { key: 'group:123', ownerQQ: OWNER_QQ }), false);
  }
});

test('silent 下 owner 私聊放行（ownerQQ 数字/字符串/字符串键都对齐）', () => {
  const silent = { mode: 'silent' };
  assert.equal(shouldBlockSilentReply(silent, { key: 'private:10001', ownerQQ: 10001 }), false);
  assert.equal(shouldBlockSilentReply(silent, { key: 'private:10001', ownerQQ: '10001' }), false);
  // 非 owner 的数字 key 不做隐式 String 归一：与旧实现一样按全等比较
  assert.equal(shouldBlockSilentReply(silent, { key: 10001, ownerQQ: 10001 }), true);
});

test('unread 为 0 不改变静默判定（旧实现只比较角色模式与 owner 私聊键）', () => {
  const state = { mode: 'silent', unread: 0 };
  assert.equal(shouldBlockSilentReply(state, { key: 'group:123', ownerQQ: OWNER_QQ }), true);
  assert.equal(shouldBlockSilentReply(state, { key: 'private:10001', ownerQQ: OWNER_QQ }), false);
  // unread 有值也一样：不参与判定
  assert.equal(shouldBlockSilentReply({ mode: 'silent', unread: 7 }, { key: 'group:123', ownerQQ: OWNER_QQ }), true);
});

test('配置全缺省：无 options / 空 options 时按 active 放行；ownerQQ 缺失退化为 private:', () => {
  assert.equal(shouldBlockSilentReply({ mode: 'silent' }), true); // key undefined !== 'private:'
  assert.equal(shouldBlockSilentReply({ mode: 'silent' }, {}), true);
  // 旧实现 ownerQQ 缺失时规范键就是 'private:'，该键被当成主人私聊
  assert.equal(shouldBlockSilentReply({ mode: 'silent' }, { key: 'private:' }), false);
  assert.equal(shouldBlockSilentReply(), false);
});

// ── 审计范围 ────────────────────────────────────────────────────────────────

test('shouldAuditKey：closed-agent 下 owner 私聊不审计，其它会话照审', () => {
  assert.equal(shouldAuditKey('private:10001', { mode: 'closed-agent', ownerQQ: OWNER_QQ }), false);
  assert.equal(shouldAuditKey('private:20002', { mode: 'closed-agent', ownerQQ: OWNER_QQ }), true);
  assert.equal(shouldAuditKey('group:123', { mode: 'closed-agent', ownerQQ: OWNER_QQ }), true);
});

test('shouldAuditKey：非 closed-agent 模式一律审计（含模式缺失/未知模式）', () => {
  for (const mode of ['chat', 'reserved', 'reserved2', 'nope', undefined, null]) {
    assert.equal(shouldAuditKey('private:10001', { mode, ownerQQ: OWNER_QQ }), true);
  }
  assert.equal(shouldAuditKey('group:123'), true);
  assert.equal(shouldAuditKey('private:10001', {}), true);
});

test('shouldAuditKey：closed-agent 且 ownerQQ 缺失时私有前缀键不审计（旧实现逐字如此）', () => {
  assert.equal(shouldAuditKey('private:', { mode: 'closed-agent' }), false);
  assert.equal(shouldAuditKey('private:1', { mode: 'closed-agent' }), true);
});

// ── 参数违约与时间注入 ──────────────────────────────────────────────────────

test('参数 null / undefined：静默按默认角色模式放行，审计按默认模式照审', () => {
  assert.equal(shouldBlockSilentReply(null, null), false);
  assert.equal(shouldBlockSilentReply(undefined, undefined), false);
  assert.equal(shouldBlockSilentReply('silent', { key: 'group:1' }), false); // 非对象快照按默认
  assert.equal(shouldAuditKey(undefined, null), true);
  assert.equal(shouldAuditKey(null, { mode: 'closed-agent', ownerQQ: OWNER_QQ }), true);
  assert.equal(shouldAuditKey('private:10001', null), true); // options 非对象按空对象
});

test('时间由入参控制：options.now 取值不同不影响任何判定', () => {
  const state = { mode: 'silent' };
  const options = { key: 'group:123', ownerQQ: OWNER_QQ, now: 0 };
  const base = shouldBlockSilentReply(state, options);
  const auditBase = shouldAuditKey('private:10001', { mode: 'closed-agent', ownerQQ: OWNER_QQ, now: 0 });
  for (const now of [1, 1_000, 1_793_193_600_000, -5]) {
    assert.equal(shouldBlockSilentReply(state, { ...options, now }), base);
    assert.equal(shouldAuditKey('private:10001', { mode: 'closed-agent', ownerQQ: OWNER_QQ, now }), auditBase);
  }
  assert.equal(base, true);
  assert.equal(auditBase, false);
});

// ── handle 分发 ─────────────────────────────────────────────────────────────

test('handle：两个 action 正常分发', () => {
  const blocked = handle({}, {
    action: 'should-block-silent-reply',
    state: { mode: 'silent' },
    options: { key: 'group:123', ownerQQ: OWNER_QQ }
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.value, true);

  const audit = handle({}, {
    action: 'should-audit-key',
    key: 'private:10001',
    options: { mode: 'closed-agent', ownerQQ: OWNER_QQ }
  });
  assert.equal(audit.ok, true);
  assert.equal(audit.value, false);
});

test('handle：未知 action 与空参数一律 INVALID_ARGS', () => {
  for (const args of [{ action: 'nope' }, {}, { action: '' }, { action: 'silent' }, null, undefined]) {
    const bad = handle({}, args);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_ARGS');
    assert.equal(typeof bad.error, 'string');
    assert.ok(bad.error.length > 0);
  }
});

test('handle：入参 getter 抛错时拒绝（fail closed），不把异常抛给发送链路', () => {
  const hostile = {
    action: 'should-block-silent-reply',
    get state() {
      throw new Error('snapshot broken');
    }
  };
  const bad = handle({}, hostile);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UPSTREAM');
  assert.match(bad.error, /snapshot broken/);
});
