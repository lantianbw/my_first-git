import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { spec, LIMITS, createModuleSwitch } from '../src/tools/module-switch.js';

// 固定假时钟：本模块不读 Date.now()，所有时间都由 now 注入。
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 注入用只读清单：精确键查找，大小写/前缀变体一律查不到。 */
const ENTRIES = [
  { name: 'guards/chain', level: 'locked', default: true, hot: true },
  { name: 'guards/scorer', level: 'free', default: true, hot: true },
  { name: 'tools/mcp-websearch', level: 'owner', default: true, hot: false }
];

function makeRegistry(entries = ENTRIES) {
  const map = new Map(entries.map((e) => [e.name, { ...e }]));
  return { get: (name) => map.get(name), list: () => [...map.values()] };
}

/** 调用方上下文：session 与确认码都由中枢注入，模块不自算。 */
const OWNER = { session: { kind: 'private', id: '10001', isOwner: true }, ownerConfirmed: true };
const OWNER_NO_CODE = { session: { kind: 'private', id: '10001', isOwner: true } };
const GUEST = { session: { kind: 'private', id: '20002', isOwner: false } };
const GROUP = { session: { kind: 'group', id: '88888', isOwner: false } };

/**
 * 测试台：内存状态（不碰真实 state 目录）+ 假时钟 + 审计探针。
 * state 传 undefined 表示"文件不存在"。
 */
function harness({ state, entries = ENTRIES, limits, failWrite = false } = {}) {
  let t = NOW;
  let file = state === undefined ? undefined : structuredClone(state);
  const logs = [];
  const audits = [];
  const writes = [];

  const ms = createModuleSwitch({
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    now: () => t,
    registry: makeRegistry(entries),
    readState: () => (file === undefined ? undefined : structuredClone(file)),
    writeState: (v) => {
      if (failWrite) throw new Error('disk full');
      writes.push(structuredClone(v));
      file = structuredClone(v);
    },
    audit: (entry) => audits.push(entry),
    limits
  });

  return {
    ms,
    logs,
    audits,
    writes,
    file: () => file,
    nowMs: () => t,
    advance: (delta) => {
      t += delta;
      return t;
    },
    warns: () => logs.filter((l) => l.level === 'warn'),
    errors: () => logs.filter((l) => l.level === 'error')
  };
}

const byName = (result) => Object.fromEntries(result.modules.map((m) => [m.name, m]));

test('spec / LIMITS：与契约逐字段一致且已冻结', () => {
  assert.equal(spec.name, 'tools/module-switch');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log', 'now']);
  assert.deepEqual(spec.optionalDeps, ['state']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(LIMITS, { windowMs: 600_000, maxInWindow: 2, autoRestoreMs: 86_400_000 });
  assert.ok(Object.isFrozen(LIMITS));
});

test('① locked 拒绝：LOCKED 且留审计；大小写变体一律 UNKNOWN_MODULE', () => {
  const h = harness();

  const denied = h.ms.toggle(OWNER, { name: 'guards/chain', on: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'LOCKED');
  assert.equal(denied.error, '该模块不可关闭');
  assert.equal(h.ms.isOn('guards/chain'), true, 'locked 不能被关');

  // 不做大小写折叠、不做别名、不做前缀补全
  for (const variant of ['Guards/Chain', 'GUARDS/CHAIN', 'guards/Chain', 'guards', 'guards/chain.js']) {
    const r = h.ms.toggle(OWNER, { name: variant, on: false });
    assert.equal(r.ok, false, variant);
    assert.equal(r.code, 'UNKNOWN_MODULE', variant);
  }

  const rejected = h.audits.filter((a) => a.result === 'rejected');
  assert.equal(rejected.length, 1, '只有 LOCKED 那次留审计（UNKNOWN 无模块名可记）');
  assert.equal(rejected[0].module, 'guards/chain');
  assert.equal(rejected[0].level, 'locked');
  assert.equal(rejected[0].from, true);
  assert.equal(rejected[0].to, false);
});

test('② 群聊调用 → FORBIDDEN（即使目标是 free 级）', () => {
  const h = harness();

  const r = h.ms.toggle(GROUP, { name: 'guards/scorer', on: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN');
  assert.match(r.error, /群聊/);
  assert.equal(h.ms.isOn('guards/scorer'), true, '被拒绝的变更不得生效');

  const audit = h.audits.at(-1);
  assert.equal(audit.result, 'rejected');
  assert.equal(audit.actor, 'qq:group:88888');
  assert.equal(audit.actorKind, 'agent');
});

test('③ 非 owner 私聊改 owner 级 → FORBIDDEN；改 free 级则允许', () => {
  const h = harness();

  const denied = h.ms.toggle(GUEST, { name: 'tools/mcp-websearch', on: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.match(denied.error, /仅主人/);
  assert.equal(h.ms.isOn('tools/mcp-websearch'), true);

  const audit = h.audits.at(-1);
  assert.equal(audit.actor, 'qq:private:20002');
  assert.equal(audit.actorKind, 'agent');

  // free 级 AI 自己能关：非 owner 私聊放行
  const allowed = h.ms.toggle(GUEST, { name: 'guards/scorer', on: false });
  assert.equal(allowed.ok, true);
  assert.equal(h.ms.isOn('guards/scorer'), false);
});

test('④ owner 缺确认码 → NEED_CONFIRM（不生效、不留 applied 审计）；带码后成功', () => {
  const h = harness();

  const denied = h.ms.toggle(OWNER_NO_CODE, { name: 'tools/mcp-websearch', on: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'NEED_CONFIRM');
  assert.match(denied.error, /确认码/);
  assert.equal(h.ms.isOn('tools/mcp-websearch'), true);
  assert.equal(h.audits.length, 0, 'NEED_CONFIRM 不是越权试探，不写审计');

  const ok = h.ms.toggle(OWNER, { name: 'tools/mcp-websearch', on: false, reason: '省点钱' });
  assert.deepEqual(ok, {
    ok: true,
    name: 'tools/mcp-websearch',
    from: true,
    to: false,
    level: 'owner',
    changedAt: NOW
  });
  assert.equal(h.ms.isOn('tools/mcp-websearch'), false);
});

test('⑤ 同值 → noop，不写审计、不增加 toggleTimes', () => {
  const h = harness();

  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false, reason: '太吵' }).ok, true);
  const timesAfterFirst = h.file().stats['guards/scorer'].toggleTimes.length;
  const auditsAfterFirst = h.audits.length;
  assert.equal(timesAfterFirst, 1);

  const noop = h.ms.toggle(OWNER, { name: 'guards/scorer', on: false, reason: '再点一次' });
  assert.deepEqual(noop, { ok: true, noop: true });
  assert.equal(h.file().stats['guards/scorer'].toggleTimes.length, timesAfterFirst, 'noop 不计频次');
  assert.equal(h.audits.length, auditsAfterFirst, 'noop 不写审计');

  // noop 不占限频额度：连续 5 次 noop 之后，第 2 次真实变更仍被允许
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false }), { ok: true, noop: true });
  }
  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: true }).ok, true, '第 2 次真实变更应被允许');
  // 直到第 3 次真实变更才触发限频
  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false }).code, 'RATE_LIMITED');
});

test('⑥ 10 分钟内第 3 次 → RATE_LIMITED，并带 nextAllowedAt', () => {
  const h = harness();
  const t0 = h.nowMs();

  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false }).ok, true);
  h.advance(1_000);
  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: true }).ok, true);
  h.advance(1_000);

  const third = h.ms.toggle(OWNER, { name: 'guards/scorer', on: false });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'RATE_LIMITED');
  assert.equal(third.nextAllowedAt, t0 + LIMITS.windowMs, '最早可改时刻 = times[0] + windowMs');
  assert.equal(h.ms.isOn('guards/scorer'), true, '被限频的变更不得生效');

  const audit = h.audits.at(-1);
  assert.equal(audit.result, 'rejected');
  assert.equal(audit.module, 'guards/scorer');

  // 窗口按模块独立：别的模块不受牵连
  assert.equal(h.ms.toggle(OWNER, { name: 'tools/mcp-websearch', on: false }).ok, true);

  // 窗口滑过之后同一模块可以再改
  h.advance(LIMITS.windowMs);
  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false }).ok, true);
});

test('⑦ 自动恢复：free 关闭超 24h 恢复为 default，owner 关闭超 24h 不恢复', () => {
  const h = harness();

  assert.equal(h.ms.toggle(OWNER, { name: 'guards/scorer', on: false }).ok, true);
  assert.equal(h.ms.toggle(OWNER, { name: 'tools/mcp-websearch', on: false }).ok, true);

  h.advance(DAY);
  assert.equal(h.ms.sweep(h.nowMs()), 0, '恰好 24h 不恢复（要求严格超过）');

  h.advance(1);
  assert.equal(h.ms.sweep(h.nowMs()), 1, '只有 free 级被恢复');
  assert.equal(h.ms.isOn('guards/scorer'), true, '恢复为 registry default');
  assert.equal(h.ms.isOn('tools/mcp-websearch'), false, 'owner 的关闭是主人的明确决定，永不自动恢复');

  const audit = h.audits.at(-1);
  assert.equal(audit.result, 'auto-restore');
  assert.equal(audit.module, 'guards/scorer');
  assert.equal(audit.reason, 'auto-restore-24h');
  assert.equal(audit.actor, 'system');

  // 幂等：offSince 已清，重复扫描不再计数
  assert.equal(h.ms.sweep(h.nowMs() + 999 * DAY), 0);

  // list 能看到"它为什么又开着"
  assert.equal(byName(h.ms.list(OWNER))['guards/scorer'].offReason, 'auto-restore');
});

test('⑧ 状态文件里 locked 被写成 false → 视为 true，并写 reject-locked-override 审计', () => {
  const h = harness({
    state: {
      version: 1,
      updatedAt: NOW,
      switches: {
        'guards/chain': {
          on: false,
          level: 'free', // 手改提权尝试：文件里的 level 只是诊断快照
          changedAt: NOW,
          changedBy: 'qq:private:99999',
          reason: '手改试试'
        }
      },
      stats: {}
    }
  });

  assert.equal(h.ms.isOn('guards/chain'), true, 'locked 强制为开');
  assert.equal(h.errors().length, 1);

  const override = h.audits.find((a) => a.reason === 'reject-locked-override');
  assert.ok(override, '必须留审计');
  assert.equal(override.module, 'guards/chain');
  assert.equal(override.from, false);
  assert.equal(override.to, true);
  assert.equal(override.level, 'locked');
  assert.equal(override.result, 'rejected');

  // 判定一律以 registry 为准
  const chain = byName(h.ms.list(OWNER))['guards/chain'];
  assert.equal(chain.level, 'locked');
  assert.equal(chain.on, true);
  assert.equal(chain.toggleable, false);
});

test('⑨ isOn 热生效：toggle 后同一实例立刻读到新值，不需要重建', () => {
  const h = harness();

  assert.equal(h.ms.isOn('guards/scorer'), true);
  h.ms.toggle(OWNER, { name: 'guards/scorer', on: false });
  assert.equal(h.ms.isOn('guards/scorer'), false, '不重启即生效');
  assert.equal(byName(h.ms.list(OWNER))['guards/scorer'].on, false);

  h.ms.toggle(OWNER, { name: 'guards/scorer', on: true });
  assert.equal(h.ms.isOn('guards/scorer'), true, '反向同样即时生效');
});

test('list：字段齐备、locked 也返回、toggleable 随调用者变化', () => {
  const h = harness();

  const ownerView = h.ms.list(OWNER);
  assert.equal(ownerView.ok, true);
  assert.equal(ownerView.modules.length, ENTRIES.length);
  assert.deepEqual(Object.keys(byName(ownerView)['guards/scorer']), [
    'name',
    'level',
    'on',
    'default',
    'hot',
    'toggleable',
    'lastChangedAt',
    'lastChangedBy',
    'offReason'
  ]);

  const owner = byName(ownerView);
  assert.equal(owner['guards/chain'].toggleable, false, 'locked 不可动');
  assert.equal(owner['guards/chain'].on, true);
  assert.equal(owner['tools/mcp-websearch'].toggleable, true);
  assert.equal(owner['tools/mcp-websearch'].hot, false);
  assert.equal(owner['guards/scorer'].lastChangedAt, null);
  assert.equal(owner['guards/scorer'].lastChangedBy, null);

  const guest = byName(h.ms.list(GUEST));
  assert.equal(guest['tools/mcp-websearch'].toggleable, false, 'owner 级在非主人眼里不可动');
  assert.equal(guest['guards/scorer'].toggleable, true);

  const group = byName(h.ms.list(GROUP));
  assert.equal(group['guards/scorer'].toggleable, false, '群聊里一律不可改');
  assert.equal(group['guards/chain'].level, 'locked', 'locked 项也要列出来给 AI 看');
});

test('状态损坏 / 版本过高 → 全部默认 + log(error)，绝不抛', () => {
  const bads = ['{"version":1,', { version: 2, switches: {} }, { version: 1 }, [], 42];
  for (const bad of bads) {
    const h = harness({ state: bad });
    assert.equal(h.ms.isOn('guards/scorer'), true, String(bad));
    assert.equal(h.ms.isOn('guards/chain'), true);
    assert.ok(h.errors().length >= 1, `应记 error：${JSON.stringify(bad)}`);
  }
});

test('状态里的未知模块名 → 忽略该条 + log(warn)，不影响其它项', () => {
  const h = harness({
    state: {
      version: 1,
      updatedAt: NOW,
      switches: {
        'legacy/gone': { on: false, level: 'free', changedAt: NOW },
        'guards/scorer': { on: false, level: 'free', changedAt: NOW, changedBy: 'console', reason: '关掉' }
      },
      stats: { 'legacy/gone': { toggleTimes: [NOW], offSince: NOW } }
    }
  });

  assert.equal(h.ms.isOn('legacy/gone'), false, 'registry 里没有 → false');
  assert.equal(h.ms.isOn('guards/scorer'), false, '合法条目照常加载');
  assert.equal(h.warns().length, 1);
  assert.match(h.warns()[0].msg, /legacy\/gone/);
  assert.equal(h.ms.list(OWNER).modules.length, ENTRIES.length, '未知模块不进列表');
});

test('参数合法性：on 非布尔 / reason 超 200 字 → INVALID_ARGS', () => {
  const h = harness();

  const badOn = h.ms.toggle(OWNER, { name: 'guards/scorer', on: 'false' });
  assert.equal(badOn.code, 'INVALID_ARGS');
  assert.match(badOn.error, /on/);

  const badReason = h.ms.toggle(OWNER, { name: 'guards/scorer', on: false, reason: 'x'.repeat(201) });
  assert.equal(badReason.code, 'INVALID_ARGS');
  assert.match(badReason.error, /reason/);

  assert.equal(h.ms.isOn('guards/scorer'), true, '两次都没生效');
  assert.equal(h.audits.length, 0);
});

test('缺依赖 / 非法注入 → 直接不装配（抛 TypeError）', () => {
  const ok = () => {};
  const base = {
    log: ok,
    now: ok,
    registry: makeRegistry(),
    readState: () => undefined,
    writeState: ok
  };
  assert.throws(() => createModuleSwitch({ ...base, log: undefined }), /log/);
  assert.throws(() => createModuleSwitch({ ...base, now: undefined }), /now/);
  assert.throws(() => createModuleSwitch({ ...base, registry: {} }), /registry/);
  assert.throws(() => createModuleSwitch({ ...base, readState: undefined }), /readState/);
  assert.throws(() => createModuleSwitch({ ...base, writeState: undefined }), /writeState/);
});

test('写盘失败：不抛、记 error、保留内存状态并置 dirty', () => {
  const h = harness({ failWrite: true });
  assert.equal(h.ms.isDirty(), true, '文件不存在 → 初始 dirty');

  const r = h.ms.toggle(OWNER, { name: 'guards/scorer', on: false });
  assert.equal(r.ok, true, '写盘失败不影响回包（H3：不抛出）');
  assert.equal(h.ms.isOn('guards/scorer'), false, '内存状态保留');
  assert.equal(h.ms.isDirty(), true);
  assert.match(h.errors().at(-1).msg, /写盘失败/);
});

test('禁用清单：源码不碰 fs / Date.now / console / 进程环境（F.1 F.2 F.7 F.8）', () => {
  const src = readFileSync(new URL('../src/tools/module-switch.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(/from\s+['"]node:fs['"]/.test(code), false, '不得 import fs');
  assert.equal(/require\(\s*['"]fs['"]\s*\)/.test(code), false, '不得 require fs');
  assert.equal(/Date\.now\s*\(/.test(code), false, '不得使用 Date.now()');
  assert.equal(/Math\.random\s*\(/.test(code), false, '不得使用 Math.random()');
  assert.equal(/console\s*\./.test(code), false, '不得使用 console');
  assert.equal(/process\.env/.test(code), false, '不得读 process.env');
  assert.equal(/from\s+['"][^'"]*bridge\.js['"]/.test(code), false, '不得 import bridge.js');
  assert.equal(/writeFile|readFile|appendFile|mkdir|readdir/.test(code), false, '不得做文件 IO');
});
