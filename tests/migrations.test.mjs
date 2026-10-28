import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { spec, needsPinyinBackfill, normalizeState, handle } from '../src/persist/migrations.js';

/**
 * 旧实现（bridge.js `fileNeedsPinyinBackfill` 里的判定那一行）原样抄来做差分。
 * 去掉的只有 fs.readFileSync / JSON.parse / try-catch —— 那三样属于文件 IO，按任务要求留在桥接。
 */
function legacyNeedsBackfill(raw) {
  return Array.isArray(raw) && raw.some((e) => !e
    || typeof e.pinyin !== 'string' || !Array.isArray(e.variants));
}

const OK_ENTRY = { content: '绷不住了', pinyin: 'beng bu zhu le', variants: ['绷不住'] };

// ── 一、needsPinyinBackfill ────────────────────────────────────────────────

test('缺 pinyin 的条目 → true（整库需要补齐）', () => {
  assert.equal(needsPinyinBackfill([OK_ENTRY, { content: '绝了', variants: [] }]), true);
});

test('缺 variants 的条目 → true', () => {
  assert.equal(needsPinyinBackfill([OK_ENTRY, { content: '绝了', pinyin: 'jue le' }]), true);
});

test('variants 不是数组 → true（字符串/对象/null 都不算）', () => {
  assert.equal(needsPinyinBackfill([{ pinyin: 'a', variants: 'a' }]), true);
  assert.equal(needsPinyinBackfill([{ pinyin: 'a', variants: {} }]), true);
  assert.equal(needsPinyinBackfill([{ pinyin: 'a', variants: null }]), true);
});

test('pinyin 为空串要放行 → false（纯数字/符号词条没有拼音）', () => {
  assert.equal(needsPinyinBackfill([{ content: '2333', pinyin: '', variants: [] }]), false);
  assert.equal(needsPinyinBackfill([{ content: 'www', pinyin: '', variants: ['wwww'] }]), false);
});

test('pinyin 是字符串以外的类型 → true（空串是唯一允许的"空"）', () => {
  assert.equal(needsPinyinBackfill([{ pinyin: null, variants: [] }]), true);
  assert.equal(needsPinyinBackfill([{ pinyin: 0, variants: [] }]), true);
  assert.equal(needsPinyinBackfill([{ pinyin: undefined, variants: [] }]), true);
});

test('非数组入参 → false（读坏了不补齐，绝不动磁盘）', () => {
  for (const bad of [null, undefined, {}, '[]', 0, 42, true, { entries: [OK_ENTRY] }]) {
    assert.equal(needsPinyinBackfill(bad), false, `入参 ${JSON.stringify(bad)} 应返回 false`);
  }
});

test('数组里有 null / undefined / falsy 条目 → true（不跳过坏条目）', () => {
  assert.equal(needsPinyinBackfill([OK_ENTRY, null]), true);
  assert.equal(needsPinyinBackfill([undefined]), true);
  assert.equal(needsPinyinBackfill([OK_ENTRY, 0]), true);
  // 坏条目在后面也要被抓到：some 不能因为前面合规就短路成 false
  assert.equal(needsPinyinBackfill([OK_ENTRY, OK_ENTRY, null]), true);
});

test('全部合规时 false（含空数组：没有要补的东西）', () => {
  assert.equal(needsPinyinBackfill([]), false);
  assert.equal(needsPinyinBackfill([OK_ENTRY]), false);
  assert.equal(needsPinyinBackfill([OK_ENTRY, { content: '2333', pinyin: '', variants: [] }]), false);
});

test('差分：与旧实现（bridge.js:287 的谓词）在样本表上逐条一致', () => {
  const samples = [
    [], [OK_ENTRY], [null], [OK_ENTRY, null], [undefined], [{ pinyin: '', variants: [] }],
    [{ pinyin: '', variants: null }], [{ pinyin: 'x' }], [{ variants: [] }], [{}], ['str'],
    [{ pinyin: 'x', variants: ['y'] }], [{ pinyin: '', variants: [], extra: 1 }],
    null, undefined, {}, 'nope', 0, true
  ];
  for (const sample of samples) {
    assert.equal(
      needsPinyinBackfill(sample),
      legacyNeedsBackfill(sample),
      `样本 ${JSON.stringify(sample) ?? String(sample)} 与旧实现不一致`
    );
  }
});

// ── 二、normalizeState ────────────────────────────────────────────────────

test('补齐缺失字段：sessionPolicies / sessionMeta 缺失时补空表，sessions 原样保留', () => {
  const out = normalizeState({ sessions: { group_1: { dshSessionId: 'abc' } } });
  assert.deepEqual(out, {
    sessions: { group_1: { dshSessionId: 'abc' } },
    sessionPolicies: {},
    sessionMeta: {}
  });
});

test('补齐缺失字段：非对象 / 数组的字段一律补空表（旧实现同一判定）', () => {
  const out = normalizeState({
    sessions: {},
    sessionPolicies: [],
    sessionMeta: 'oops'
  });
  assert.deepEqual(out.sessionPolicies, {});
  assert.deepEqual(out.sessionMeta, {});
});

test('已存在的字段不被覆盖：sessionPolicies / sessionMeta 有内容时原样透传', () => {
  const policies = { group_1: { mode: 'reserved2' } };
  const meta = { group_1: { createdAt: 1700000000000 } };
  const parsed = { sessions: {}, sessionPolicies: policies, sessionMeta: meta };
  const out = normalizeState(parsed);
  assert.deepEqual(out.sessionPolicies, policies);
  assert.deepEqual(out.sessionMeta, meta);
  assert.notEqual(out, parsed, '顶层必须是新对象');
  // 浅拷贝的边界：已存在的表按引用透传（不复制整份 state，启动路径上不做无谓的深拷贝），
  // 但模块自己**不往里写** —— 见下一条「不修改入参」。
  assert.equal(out.sessionPolicies, policies);
});

test('不修改入参：原对象前后逐字节相等，且顶层是新对象', () => {
  const parsed = { sessions: { group_1: { dshSessionId: 'abc' } } };
  const snapshot = JSON.stringify(parsed);
  const out = normalizeState(parsed);

  assert.equal(JSON.stringify(parsed), snapshot, '入参被改动了');
  assert.equal('sessionPolicies' in parsed, false, '不得往入参上补字段');
  assert.equal('sessionMeta' in parsed, false, '不得往入参上补字段');
  assert.notEqual(out, parsed, '必须返回新对象');
  // 补齐出来的空表挂在**新对象**上，不是写回入参
  assert.notEqual(out.sessionPolicies, parsed.sessionPolicies);
  // 改新对象的顶层键，入参不受影响
  out.sessionPolicies = { dirty: true };
  assert.equal('sessionPolicies' in parsed, false);

  // 入参里已有的嵌套内容一个字节都没动
  assert.deepEqual(parsed, { sessions: { group_1: { dshSessionId: 'abc' } } });

  // 坏值场景同样不写入参：数组 / 字符串的字段都不能被"就地修正"
  const bad = { sessions: [], sessionPolicies: [], sessionMeta: 'x' };
  const badSnapshot = JSON.stringify(bad);
  normalizeState(bad);
  assert.equal(JSON.stringify(bad), badSnapshot, '坏值入参被就地修正了');
});

test('幂等：跑两遍结果相同（深相等）', () => {
  for (const input of [
    { sessions: {} },
    { sessions: { a: 1 }, sessionPolicies: null, sessionMeta: [] },
    { sessions: {}, sessionPolicies: { a: 1 }, sessionMeta: { b: 2 } },
    null
  ]) {
    const once = normalizeState(input);
    const twice = normalizeState(once);
    assert.deepEqual(twice, once, `入参 ${JSON.stringify(input)} 不幂等`);
    assert.deepEqual(normalizeState(twice), once);
  }
});

test('入参为 null / 非对象 / 数组 → 一份全新可用的空 state', () => {
  for (const bad of [null, undefined, 42, 'x', true, [], [1, 2]]) {
    const out = normalizeState(bad);
    assert.deepEqual(out, { sessions: {}, sessionPolicies: {}, sessionMeta: {} }, `入参 ${String(bad)}`);
    // 必须是**可写**的新对象（中枢接下来会往里塞会话，冻结/共享单例会炸）
    out.sessions.k = 1;
    assert.equal(out.sessions.k, 1);
    assert.notEqual(normalizeState(bad), out);
  }
});

test('sessions 不是普通对象时补空表（数组也算坏值：旧实现留着它会在落盘时丢条目）', () => {
  for (const bad of [null, 'str', 7, [], [1, 2]]) {
    assert.deepEqual(normalizeState({ sessions: bad }).sessions, {}, `sessions=${JSON.stringify(bad)}`);
  }
  // 未知字段原样保留，不清洗业务数据
  assert.equal(normalizeState({ sessions: {}, extra: 'keep' }).extra, 'keep');
  assert.equal(normalizeState({ sessions: null, extra: 'keep' }).extra, 'keep');
});

// ── 三、spec 与门面 ───────────────────────────────────────────────────────

test('spec 冻结，且 name 与文件路径一致', () => {
  assert.equal(Object.isFrozen(spec), true, 'spec 必须冻结');
  assert.equal(Object.isFrozen(spec.toggle), true, 'toggle 必须冻结');
  assert.equal(Object.isFrozen(spec.deps), true, 'deps 必须冻结');
  assert.equal(spec.name, 'persist/migrations');
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.hot, true);
  assert.equal(spec.toggle.default, true);

  const file = fileURLToPath(new URL('../src/persist/migrations.js', import.meta.url));
  const derived = file.replace(/\\/g, '/').split('/src/')[1].replace(/\.js$/, '');
  assert.equal(spec.name, derived, 'spec.name 必须与 src 下的相对路径一致');
  assert.equal(new URL('../src/persist/migrations.js', import.meta.url).pathname.endsWith(`src/${spec.name}.js`), true);
});

test('handle 按 action 分发；未知 action 返回 INVALID_ARGS', () => {
  assert.deepEqual(handle(null, { action: 'needs-pinyin-backfill', entries: [OK_ENTRY] }), { ok: true, value: false });
  assert.deepEqual(handle(null, { action: 'needs-pinyin-backfill', entries: [{}] }), { ok: true, value: true });

  const normalized = handle(null, { action: 'normalize-state', state: { sessions: {} } });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.value, { sessions: {}, sessionPolicies: {}, sessionMeta: {} });

  for (const bad of [undefined, '', 'nope', 'needsPinyinBackfill', '__proto__']) {
    const r = handle(null, { action: bad });
    assert.equal(r.ok, false, `action=${String(bad)} 应失败`);
    assert.equal(r.code, 'INVALID_ARGS');
  }
  const noArgs = handle(null, undefined);
  assert.equal(noArgs.ok, false, '缺 args 也算未知动作');
  assert.equal(noArgs.code, 'INVALID_ARGS');
  assert.equal(typeof noArgs.error, 'string');
});

// ── 四、边界：模块本身不许碰 IO / 时钟 / 随机 / 日志 ─────────────────────

test('源文件禁用清单：不 import fs / bridge、不写文件、不读时钟与随机数、不 console', () => {
  const src = fs.readFileSync(new URL('../src/persist/migrations.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(/from\s+['"]node:fs['"]/.test(code), false, '不得 import node:fs');
  assert.equal(/from\s+['"]fs['"]/.test(code), false, '不得 import fs');
  assert.equal(/require\(\s*['"](?:node:)?fs['"]\s*\)/.test(code), false, '不得 require fs');
  assert.equal(/from\s+['"][^'"]*bridge\.js['"]/.test(code), false, '不得 import bridge.js');
  assert.equal(/\bwriteFileSync\b|\bappendFileSync\b|\breadFileSync\b|\bmkdirSync\b/.test(code), false, '不得做文件 IO');
  assert.equal(/Date\.now\s*\(/.test(code), false, '不得使用 Date.now()');
  assert.equal(/new\s+Date\s*\(/.test(code), false, '不得构造 Date');
  assert.equal(/Math\.random\s*\(/.test(code), false, '不得使用 Math.random()');
  assert.equal(/console\s*\./.test(code), false, '不得使用 console');
  assert.equal(/\basync\b|\bawait\b|\bPromise\b/.test(code), false, '必须是纯同步实现');
});
