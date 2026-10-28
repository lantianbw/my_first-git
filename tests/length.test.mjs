import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLengthNudge, guardLengthNudge, spec, DEFAULTS } from '../src/guards/length.js';

const NOW = 1_800_000_000_000;
// 与 config.json 的 socialV2.guard.lengthNudge 同形
const SECTION = { enabled: true, maxSingleChars: 40, multiThreshold: 12, recentWindowMs: 600000 };
const LONG_MULTI = ['一'.repeat(13), '二'.repeat(14)];

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
  // 先剥块注释再剥行注释：注释里可以提「原来是 Date.now()」，可执行代码里不行。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/Date\.now|Math\.random|console\./.test(code), false);
  assert.equal(/process\.env|bridge\.js/.test(code), false, '不读 env、不 import 中枢（F.1 F.2）');
});

// ── 以下覆盖 guardLengthNudge：从 bridge.js 搬来的「取配置 + 记账」外壳 ──────────

test('守卫入口：短文本放行，返回形状与旧实现一致', () => {
  const v = guardLengthNudge({
    key: 'private:1', messages: ['在吗', '吃了没'], section: SECTION, sendTimes: [], now: NOW, retries: 0
  });
  assert.equal(v.ok, true);
  assert.equal(v.reason, '');
  assert.equal(v.retries, 0, '放行不改计数');
});

test('守卫入口：单条超长拦下，且不消耗本轮重试计数', () => {
  const v = guardLengthNudge({
    key: 'group:1', messages: ['啊'.repeat(41)], section: SECTION, sendTimes: [], now: NOW, retries: 0
  });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'single');
  assert.equal(v.length, 41);
  assert.equal(v.retries, 0, '单条超长是硬拦，不占用 multi 的重试额度');
  assert.equal(v.activity, '[guard] length-nudge·单条超长 (group:1): 41 字', 'activity 文案与旧实现逐字一致');
});

test('守卫入口：超长触发一次重试（multi 拦下，计数 +1）', () => {
  const v = guardLengthNudge({
    key: 'group:1', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 1000], now: NOW, retries: 0
  });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'multi');
  assert.equal(v.count, 2);
  assert.equal(v.threshold, 12);
  assert.equal(v.retries, 1);
  assert.match(v.reason, /重试一次仍偏长会放行/);
  assert.equal(v.activity, '[guard] length-nudge (group:1): 2 条均超 12 字');
});

test('守卫入口：第二次仍超长则放行（防死锁）', () => {
  const v = guardLengthNudge({
    key: 'group:1', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 1000], now: NOW, retries: 1
  });
  assert.equal(v.ok, true);
  assert.equal(v.reason, '');
  assert.equal(v.retries, 1, '不再累加');
});

test('阈值边界：0 视为未配置 → 回落默认 40 / 12', () => {
  const single = guardLengthNudge({
    key: 'g', messages: ['啊'.repeat(41)], section: { ...SECTION, maxSingleChars: 0 }, sendTimes: [], now: NOW
  });
  assert.equal(single.ok, false);
  assert.match(single.reason, /上限 40 字/);

  const multi = guardLengthNudge({
    key: 'g', messages: LONG_MULTI, section: { ...SECTION, multiThreshold: 0 }, sendTimes: [NOW - 1], now: NOW
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.threshold, 12);
});

test('阈值边界：Infinity → 永不拦', () => {
  const single = guardLengthNudge({
    key: 'g', messages: ['啊'.repeat(100000)], section: { ...SECTION, maxSingleChars: Infinity }, sendTimes: [], now: NOW
  });
  assert.equal(single.ok, true);

  const multi = guardLengthNudge({
    key: 'g', messages: LONG_MULTI, section: { ...SECTION, multiThreshold: Infinity }, sendTimes: [NOW - 1], now: NOW
  });
  assert.equal(multi.ok, true);
});

test('计数按 key 隔离（调用方持有 Map，模块只读入参）', () => {
  const counters = new Map();
  const drive = (key) => {
    const v = guardLengthNudge({
      key, messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 1000], now: NOW,
      retries: counters.get(key) || 0
    });
    if (v.kind === 'multi') counters.set(key, v.retries);
    return v;
  };

  assert.equal(drive('group:1').ok, false, 'g:1 第一次拦');
  assert.equal(drive('group:1').ok, true, 'g:1 第二次放行');
  assert.equal(drive('group:2').ok, false, 'g:2 不受 g:1 计数影响');
  assert.equal(counters.get('group:1'), 1);
  assert.equal(counters.get('group:2'), 1);
});

test('计数可清零（新一轮唤醒删 key 后重新生效）', () => {
  const counters = new Map([['group:1', 1]]);
  const drive = () => guardLengthNudge({
    key: 'group:1', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 1000], now: NOW,
    retries: counters.get('group:1') || 0
  });

  assert.equal(drive().ok, true, '计数为 1 时放行');
  counters.delete('group:1');
  const again = drive();
  assert.equal(again.ok, false, '清零后重新拦一次');
  assert.equal(again.retries, 1);
});

test('缺 cfg 时按默认阈值；分节为 false 时整体放行', () => {
  const noSection = guardLengthNudge({ key: 'g', messages: ['啊'.repeat(41)], sendTimes: [], now: NOW });
  assert.equal(noSection.ok, false);
  assert.match(noSection.reason, /上限 40 字/);

  const noSectionMulti = guardLengthNudge({ key: 'g', messages: LONG_MULTI, sendTimes: [NOW - 1], now: NOW });
  assert.equal(noSectionMulti.ok, false, '缺 cfg 时窗口默认 10 分钟，仍判「最近发过」');
  assert.equal(noSectionMulti.threshold, 12);

  const off = guardLengthNudge({ key: 'g', messages: ['啊'.repeat(41)], section: false, sendTimes: [], now: NOW });
  assert.equal(off.ok, true, 'section:false 等价旧 guardSectionEnabledV2 关闭');
});

test('最近发送窗口边界：恰好 10 分钟前不算「最近发过」', () => {
  const exactly = guardLengthNudge({
    key: 'g', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 600000], now: NOW
  });
  assert.equal(exactly.ok, true, 'now - t === windowMs 不满足 < windowMs');

  const inside = guardLengthNudge({
    key: 'g', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 599999], now: NOW
  });
  assert.equal(inside.ok, false);
});

test('抛错时放行（fail open）：缺 now、sendTimes 非数组、配置分节为 null', () => {
  const noNow = guardLengthNudge({ key: 'g', messages: ['在吗'], section: SECTION, sendTimes: [] });
  assert.equal(noNow.ok, true, '缺时钟 → 放行');
  assert.equal(noNow.degraded, true);
  assert.match(noNow.error, /now/);

  const badTimes = guardLengthNudge({ key: 'g', messages: ['在吗'], section: SECTION, sendTimes: 'oops', now: NOW });
  assert.equal(badTimes.ok, true, 'sendTimes 非数组 → 放行');
  assert.equal(badTimes.degraded, true);

  const nullTimes = guardLengthNudge({ key: 'g', messages: ['在吗'], section: SECTION, sendTimes: null, now: NOW });
  assert.equal(nullTimes.ok, true, 'sendTimes 为 null 等价空数组（沿用旧实现 st?.sendTimes || []）');
  assert.equal(nullTimes.degraded, undefined, 'null 不算异常');

  const nullSection = guardLengthNudge({ key: 'g', messages: ['啊'.repeat(41)], section: null, sendTimes: [], now: NOW });
  assert.equal(nullSection.ok, false, 'null 分节按「未配置」处理，不是异常');
});

test('模块自身不留状态（F.2）：同样入参两次调用结果完全相同', () => {
  const args = { key: 'g', messages: LONG_MULTI, section: SECTION, sendTimes: [NOW - 1000], now: NOW, retries: 0 };
  const first = guardLengthNudge(args);
  const second = guardLengthNudge(args);
  assert.deepEqual(second, first, '第二次没有因为「上次拦过」而变化');
  assert.equal(second.retries, 1, '计数只由入参/返回值流转，模块内不累加');
});
