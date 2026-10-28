import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  normalizeState,
  decideWritable,
  createSessionStore,
  handle
} from '../src/session/store.js';

const noop = () => {};
const EMPTY = { sessions: {}, sessionPolicies: {}, sessionMeta: {} };

/** 深冻结：用来证明 normalizeState 只读入参，不会偷偷改它。 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * 测试台：read / write 都是注入的内存实现，不碰真实 state/ 目录。
 * write 内部先 JSON.stringify —— 与 persist/atomic 的 atomicWriteJson 一致：
 * 序列化失败必须抛，而不是写出半截文件。
 */
function harness({ raw = null, readThrows = null, writeThrows = null, dirWritable } = {}) {
  const logs = [];
  const writes = [];
  let file = raw;
  const store = createSessionStore({
    read: () => {
      if (readThrows) throw readThrows;
      return file;
    },
    write: (value) => {
      if (writeThrows) throw writeThrows;
      const text = JSON.stringify(value);
      writes.push(text);
      file = text;
    },
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    ...(dirWritable === undefined ? {} : { dirWritable })
  });
  return {
    store,
    logs,
    writes,
    file: () => file,
    warns: () => logs.filter((l) => l.level === 'warn'),
    errors: () => logs.filter((l) => l.level === 'error')
  };
}

// ── spec ────────────────────────────────────────────────────────────────────

test('spec：字段齐备、逐层冻结，会话映射属不可关闭的状态持久化', () => {
  assert.deepEqual(spec, {
    name: 'session/store',
    version: '1.0.0',
    deps: ['log'],
    optionalDeps: [],
    guards: [],
    toggle: { level: 'locked', default: true, hot: true }
  });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.deps), 'deps 不冻结的话调用方 push 一下就能改依赖声明');
  assert.ok(Object.isFrozen(spec.optionalDeps));
  assert.ok(Object.isFrozen(spec.guards));
  assert.ok(Object.isFrozen(spec.toggle));
});

// ── normalizeState：补字段 ──────────────────────────────────────────────────

test('normalizeState 补字段：缺表补空表，缺字段补齐，已有值不动', () => {
  assert.deepEqual(normalizeState(null), EMPTY);
  assert.deepEqual(normalizeState({}), EMPTY);
  assert.deepEqual(normalizeState({ sessions: { 'group:1': 's1' } }), {
    sessions: { 'group:1': 's1' },
    sessionPolicies: {},
    sessionMeta: {}
  });
  // 只缺一张表时，另外两张不许被清掉
  assert.deepEqual(
    normalizeState({ sessionPolicies: { 'group:1': '["chat","",null]' }, sessionMeta: { 'group:1': { createdAt: 7 } } }),
    {
      sessions: {},
      sessionPolicies: { 'group:1': '["chat","",null]' },
      sessionMeta: { 'group:1': { createdAt: 7 } }
    }
  );
  // 未知顶层字段原样带回去（friends 这类不许因为归一而丢）
  assert.deepEqual(normalizeState({ friends: { 3: { name: '小明' } }, sessions: {} }).friends, { 3: { name: '小明' } });
});

// ── normalizeState：去脏数据 ────────────────────────────────────────────────

test('normalizeState 去脏数据：会话/策略只留非空字符串，元数据只留对象，危险键一律丢弃', () => {
  const dirty = JSON.parse(`{
    "__proto__": { "polluted": 1 },
    "keep": 2,
    "sessions": {
      "group:1": "sess-1",
      "obj": { "sessionId": "x" },
      "num": 42,
      "nil": null,
      "empty": "",
      "blank": "   ",
      "__proto__": { "evil": 1 }
    },
    "sessionPolicies": { "group:1": "[\\"chat\\",\\"\\",null]", "bad": 1, "nil": null },
    "sessionMeta": { "group:1": { "createdAt": 1700000000000 }, "bad": "x", "arr": [1] }
  }`);

  const out = normalizeState(dirty);
  assert.deepEqual(out.sessions, { 'group:1': 'sess-1' }, '会话表只存 sessionId 字符串');
  assert.deepEqual(out.sessionPolicies, { 'group:1': '["chat","",null]' });
  assert.deepEqual(out.sessionMeta, { 'group:1': { createdAt: 1700000000000 } });
  assert.equal(out.keep, 2);
  assert.equal(Object.hasOwn(out, '__proto__'), false);
  assert.equal(Object.prototype.polluted, undefined, '丢弃 __proto__ 不能变成原型链污染');
  assert.equal(Object.prototype.evil, undefined);
});

// ── normalizeState：不改入参 / 幂等 / 异常入参 ──────────────────────────────

test('normalizeState 不改入参：入参深冻结也不抛，返回的是新对象', () => {
  const input = deepFreeze({
    sessions: { 'group:1': 's1', dirty: 42 },
    sessionPolicies: {},
    extra: { deep: true }
  });
  const before = JSON.stringify(input);

  const out = normalizeState(input); // 冻结对象上任何原地写都会抛 TypeError
  assert.equal(JSON.stringify(input), before, '归一不许动调用方的数据');
  assert.notEqual(out, input);
  assert.notEqual(out.sessions, input.sessions, '表也要新建，否则 set 会写回入参');
  assert.deepEqual(out.sessions, { 'group:1': 's1' });
  assert.equal(out.extra, input.extra, '不认识的字段按引用带走即可（只读）');
});

test('normalizeState 幂等：归一两次与一次完全相同；null / 非对象入参一律回空表', () => {
  const once = normalizeState({
    sessions: { 'group:1': 's1', bad: 1 },
    sessionPolicies: { 'group:1': '[]' },
    sessionMeta: { 'group:1': { createdAt: 1 }, bad: 'x' }
  });
  assert.deepEqual(normalizeState(once), once);
  assert.deepEqual(normalizeState(normalizeState(once)), once);

  for (const value of [undefined, null, [], ['x'], 'string', 42, true]) {
    assert.deepEqual(normalizeState(value), EMPTY, JSON.stringify(value));
  }
});

// ── decideWritable：四路判定 ────────────────────────────────────────────────

test('decideWritable 文件不存在：ENOENT 与 fileExists:false 都算首次运行，可写', () => {
  assert.deepEqual(decideWritable({ fileExists: false, dirWritable: true, readOk: false, error: { code: 'ENOENT' } }), {
    writable: true,
    reason: 'missing-file'
  });
  assert.deepEqual(decideWritable({ fileExists: false, dirWritable: true, readOk: true }), {
    writable: true,
    reason: 'missing-file'
  });
  // 没有 stat 只有 ENOENT 也能判
  assert.deepEqual(decideWritable({ readOk: false, error: { code: 'ENOENT' } }), {
    writable: true,
    reason: 'missing-file'
  });
});

test('decideWritable 读失败：非 ENOENT 一律只读（这是「绝不回写覆盖」的判定源）', () => {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EIO', undefined]) {
    assert.deepEqual(
      decideWritable({ fileExists: true, dirWritable: true, readOk: false, error: { code } }),
      { writable: false, reason: 'read-error' },
      String(code)
    );
  }
  // 内容损坏走同一条路：fileExists 为真、readOk 为假 ⇒ 只读
  assert.deepEqual(
    decideWritable({ fileExists: true, dirWritable: true, readOk: false, error: { code: 'CORRUPT' } }),
    { writable: false, reason: 'read-error' }
  );
});

test('decideWritable 目录不可写：即使文件不存在/读成功也必须只读（写下去也只会失败）', () => {
  assert.deepEqual(decideWritable({ fileExists: true, dirWritable: false, readOk: true }), {
    writable: false,
    reason: 'dir-not-writable'
  });
  assert.deepEqual(decideWritable({ fileExists: false, dirWritable: false, readOk: false, error: { code: 'ENOENT' } }), {
    writable: false,
    reason: 'dir-not-writable'
  });
  // dirWritable 未知（undefined）不该凭空拦写：桥里根本没有这个探针
  assert.deepEqual(decideWritable({ fileExists: true, readOk: true }), { writable: true, reason: 'ok' });
});

test('decideWritable 输入缺字段：判不出来就按不可写兜底（fail closed），且不改入参', () => {
  assert.deepEqual(decideWritable(), { writable: false, reason: 'read-error' });
  assert.deepEqual(decideWritable({}), { writable: false, reason: 'read-error' });
  // 读成功但没给 fileExists：当成「文件在，读到了」的正常情况
  assert.deepEqual(decideWritable({ readOk: true }), { writable: true, reason: 'ok' });

  const input = deepFreeze({ fileExists: true, dirWritable: true, readOk: false, error: { code: 'EBUSY' } });
  decideWritable(input);
  assert.equal(input.readOk, false);
});

// ── 装配 ────────────────────────────────────────────────────────────────────

test('装配：缺 log / read / write 时抛可读 TypeError（缺依赖不装配）', () => {
  assert.throws(() => createSessionStore({ read: () => null, write: noop }), /log/);
  assert.throws(() => createSessionStore({ log: noop, write: noop }), /read/);
  assert.throws(() => createSessionStore({ log: noop, read: () => null }), /write/);
});

// ── store：读 ───────────────────────────────────────────────────────────────

test('首次运行与空文件：空结构 + 可写 + 不报警', () => {
  for (const raw of [null, undefined]) {
    const h = harness({ raw });
    assert.deepEqual(h.store.getState(), EMPTY, String(raw));
    assert.equal(h.store.isWritable(), true, '没有原文件可保护，当然可写');
    assert.deepEqual(h.store.load(), { ok: true, readOnly: false, reason: 'missing' });
    assert.equal(h.warns().length, 0);
  }

  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const h = harness({ readThrows: enoent });
  assert.equal(h.store.isWritable(), true, 'ENOENT 是首次运行，不是读失败');
  assert.equal(h.warns().length, 0);

  const empty = harness({ raw: '  \n\t ' });
  assert.deepEqual(empty.store.load(), { ok: true, readOnly: false, reason: 'empty' });
  assert.equal(empty.store.isWritable(), true, '空文件没有信息可丢');
});

test('正常读取：会话是 sessionId 字符串，未知顶层字段保留，脏条目当场清掉', () => {
  const raw = JSON.stringify({
    sessions: { 'group:1': 'sess-1', 'private:2': 'sess-2', 'bad:3': { sessionId: 'oops' } },
    sessionPolicies: { 'group:1': '["chat","",null]' },
    sessionMeta: { 'group:1': { createdAt: 1700000000000 } },
    friends: { 3: { name: '小明' } }
  });
  const h = harness({ raw });

  assert.deepEqual(h.store.load(), { ok: true, readOnly: false, reason: 'ok' });
  assert.equal(h.store.get('group:1'), 'sess-1');
  assert.equal(h.store.get('bad:3'), null, '对象形态的会话是脏数据，不许它污染映射');
  assert.equal(h.store.getPolicy('group:1'), '["chat","",null]');
  assert.deepEqual(h.store.getMeta('group:1'), { createdAt: 1700000000000 });
  assert.deepEqual(h.store.getState().friends, { 3: { name: '小明' } });
  assert.deepEqual(h.store.keys(), ['group:1', 'private:2']);
  assert.equal(h.warns().length, 0);
});

test('关键：读失败 → 只读不写，save 一律拒绝，write 一次都不许发生（绝不回写覆盖）', () => {
  const busy = Object.assign(new Error('EBUSY: 文件被占用'), { code: 'EBUSY' });
  const h = harness({ readThrows: busy });

  assert.equal(h.store.isWritable(), false, '读不动就必须只读，否则空映射会覆盖原文件');
  assert.deepEqual(h.store.load(), { ok: true, readOnly: true, reason: 'io-error' });
  assert.equal(h.warns().length, 1);
  assert.match(h.warns()[0].msg, /只读不写/);
  assert.match(h.warns()[0].msg, /EBUSY/, '日志要带上真实原因，否则运维只能猜');

  // 内存里照常可改：中枢得继续跑，只是不再落盘
  assert.deepEqual(h.store.set('group:1', 'sess-1'), { ok: true, key: 'group:1' });

  // 就算中枢忽略返回值反复调用，也绝不覆盖原文件
  for (let i = 0; i < 5; i += 1) {
    const r = h.store.save();
    assert.equal(r.ok, false, '写 fail closed：绝不能谎报成功');
    assert.equal(r.code, 'READ_ONLY');
    assert.match(r.error, /只读不写/);
  }
  assert.equal(h.writes.length, 0, '降级后一次 write 都不许发生 —— 一次占用不能变成永久丢会话');
  assert.equal(h.warns().length, 2, '读失败一条 + 首次拒绝回写一条，不许刷屏');
});

test('关键：内容损坏 → 同样只读，原文件留证不覆盖', () => {
  for (const raw of ['{"sessions":', '[1,2,3]', '"文本"', '42', 'true']) {
    const h = harness({ raw });
    assert.deepEqual(h.store.load(), { ok: true, readOnly: true, reason: 'corrupt' }, raw);
    assert.equal(h.store.isWritable(), false, raw);
    assert.match(h.warns()[0].msg, /只读不写/, raw);

    assert.equal(h.store.save().code, 'READ_ONLY', raw);
    assert.equal(h.writes.length, 0, raw);
  }
});

test('目录不可写：读得到也不许声称可写，save 拒绝且不调 write', () => {
  const h = harness({ raw: JSON.stringify({ sessions: { 'group:1': 's1' } }), dirWritable: false });

  assert.deepEqual(h.store.load(), { ok: true, readOnly: true, reason: 'dir-not-writable' });
  assert.equal(h.store.isWritable(), false);
  assert.equal(h.store.get('group:1'), 's1', '读还是能读的');
  assert.equal(h.store.save().code, 'READ_ONLY');
  assert.equal(h.writes.length, 0);

  // dirWritable 也可以给函数（中枢现场探测），抛错按「未知」处理，不拦写
  const probe = createSessionStore({
    read: () => null,
    write: () => { throw new Error('不该被调用'); },
    log: noop,
    dirWritable: () => { throw new Error('探测失败'); }
  });
  assert.equal(probe.isWritable(), true, '探针自身出错时按未知处理（桥里没有该探针的兜底路径）');
});

// ── store：写 ───────────────────────────────────────────────────────────────

test('写失败不报成功：write 抛错 → UPSTREAM + error 日志，绝不返回 ok', () => {
  const h = harness({ raw: null, writeThrows: new Error('EPERM: 杀软占住 .tmp') });
  h.store.set('group:1', 'sess-1');

  const r = h.store.save();
  assert.equal(r.ok, false, '写没成功就不能说成功');
  assert.equal(r.code, 'UPSTREAM');
  assert.match(r.error, /EPERM/);
  assert.equal(h.errors().length, 1, '写失败必须记账，不许静默');

  // 循环引用：序列化抛错也必须以失败收场，绝不写出半截。
  // 会话表只收字符串，所以把环塞进元数据（唯一存对象的那张表）。
  const cyclic = harness({ raw: null });
  const value = {};
  value.self = value;
  cyclic.store.setMeta('group:1', value);
  const cr = cyclic.store.save();
  assert.equal(cr.ok, false);
  assert.equal(cr.code, 'UPSTREAM');
  assert.equal(cyclic.writes.length, 0);
});

test('保存时机与内容：变更不自动落盘，save 才写，写出的就是归一后的三张表', () => {
  const h = harness({ raw: null });
  h.store.set('group:1', 'sess-1');
  h.store.setPolicy('group:1', '["chat","",null]');
  h.store.setMeta('group:1', { createdAt: 1700000000000 });
  assert.equal(h.writes.length, 0, '何时落盘是中枢的调度权，模块不许自己写');

  assert.deepEqual(h.store.save(), { ok: true });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(h.writes[0]), {
    sessions: { 'group:1': 'sess-1' },
    sessionPolicies: { 'group:1': '["chat","",null]' },
    sessionMeta: { 'group:1': { createdAt: 1700000000000 } }
  });
  // 写出去的内容再读回来必须一致（自洽，不产生脏数据）
  const again = harness({ raw: h.file() });
  assert.deepEqual(again.store.getState(), JSON.parse(h.file()));
});

// ── store：键与取值 ─────────────────────────────────────────────────────────

test('键与取值：危险键/空键/非字符串值一律 INVALID_ARGS，会话表只收字符串', () => {
  const h = harness({ raw: null });
  for (const key of ['__proto__', 'constructor', 'prototype', '', '   ', 42, null, undefined]) {
    assert.equal(h.store.set(key, 'sess-1').code, 'INVALID_ARGS', String(key));
    assert.equal(h.store.setPolicy(key, '[]').code, 'INVALID_ARGS', String(key));
    assert.equal(h.store.setMeta(key, { createdAt: 1 }).code, 'INVALID_ARGS', String(key));
    assert.equal(h.store.get(key), null, String(key));
  }
  assert.deepEqual(h.store.keys(), []);
  assert.equal(Object.prototype.sess, undefined, '拒绝写入不能顺手污染原型');

  for (const value of [42, null, '', '   ', { sessionId: 'x' }, ['s']]) {
    assert.equal(h.store.set('group:1', value).code, 'INVALID_ARGS', JSON.stringify(value));
  }
  assert.equal(h.store.setMeta('group:1', 'not-an-object').code, 'INVALID_ARGS');
  assert.equal(h.store.setPolicy('group:1', 1).code, 'INVALID_ARGS');

  // 键两端空白按 trim 归一（中枢的 canonical key 本就不含空格）
  assert.deepEqual(h.store.set('  group:1  ', 's'), { ok: true, key: 'group:1' });
  assert.deepEqual(h.store.remove('group:1'), { ok: true, key: 'group:1', removed: true });
  assert.deepEqual(h.store.remove('group:1'), { ok: true, key: 'group:1', removed: false });
});

test('ensure：已存在绝不覆盖（重复入站不能把上下文换掉），不存在才建', () => {
  const h = harness({ raw: JSON.stringify({ sessions: { 'group:1': 'old' } }) });

  assert.deepEqual(h.store.ensure('group:1', 'new'), { ok: true, key: 'group:1', value: 'old', created: false });
  assert.deepEqual(h.store.ensure('private:9', 'p9'), { ok: true, key: 'private:9', value: 'p9', created: true });
  assert.equal(h.store.get('group:1'), 'old');
  assert.equal(h.store.get('private:9'), 'p9');
  assert.equal(h.store.ensure('private:9', 'other').value, 'p9', '第二次 ensure 是 noop');
  assert.equal(h.store.ensure('private:9', 42).ok, true, '已存在时新值非法也不影响结果');
  assert.equal(h.store.ensure('private:8', 42).code, 'INVALID_ARGS');
});

// ── handle ──────────────────────────────────────────────────────────────────

test('handle：纯动作免注入，状态动作要 store 或 read/write，未知 action 回 INVALID_ARGS', () => {
  const ctx = { log: noop };
  const { store } = harness({ raw: JSON.stringify({ sessions: { 'group:1': 's1' } }) });

  assert.deepEqual(handle(ctx, { action: 'decide', readOk: false, error: { code: 'EBUSY' } }), {
    ok: true,
    value: { writable: false, reason: 'read-error' }
  });
  assert.deepEqual(handle({}, { action: 'normalize', value: { sessions: { a: 's1', b: 1 } } }).value, {
    sessions: { a: 's1' },
    sessionPolicies: {},
    sessionMeta: {}
  });

  assert.deepEqual(handle(ctx, { action: 'get', store, key: 'group:1' }), { ok: true, value: 's1' });
  assert.deepEqual(handle(ctx, { action: 'writable', store }), { ok: true, value: true });
  assert.equal(handle(ctx, { action: 'save', store }).ok, true);
  assert.equal(handle(ctx, { action: 'load', store }).value.reason, 'ok');

  // 没有实例但给了 read/write：一次性实例可用
  assert.deepEqual(handle(ctx, { action: 'save', read: () => null, write: noop }), { ok: true });

  // 什么都没有：DEP_MISSING（缺注入不是崩溃）
  const missing = handle(ctx, { action: 'get', key: 'group:1' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DEP_MISSING');
  assert.match(missing.error, /store|read/);

  const noLog = handle({}, { action: 'save', read: () => null, write: noop });
  assert.equal(noLog.code, 'DEP_MISSING');
  assert.match(noLog.error, /log/);

  const unknown = handle(ctx, { store, action: 'flush' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'INVALID_ARGS');
  assert.match(unknown.error, /未知动作/);
});
