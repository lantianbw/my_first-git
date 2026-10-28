import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { spec, normalizeSocialState, mergeSocialPatch, handle } from '../src/session/social-state.js';

// ── 夹具 ──────────────────────────────────────────────────────────────────
// 本模块是纯函数：不读文件、不碰时钟与随机数，所以夹具只有普通对象。
const nums = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ seq: from + i }));

/** normalizeSocialState({}) 的完整形状＝线上 getSocialV2State() 新建会话那一份（去掉随机 token）。 */
function expectedDefaults() {
  return {
    // 旧实现在加载后**总是**给 speakerIds 赋数组（缺失即 []），下游可以无脑读。
    wakeConfig: { triggers: { speakerIds: [] } },
    recentMessages: [],
    unread: [],
    lastWakeReason: '',
    lastAiReplyAt: 0,
    lastActionAt: 0,
    agentToken: '',
    bootstrapSent: false,
    wakeTimes: [],
    sendTimes: [],
    proactiveWakeTimes: [],
    stickerCollectTimes: [],
    pendingWakeTimer: null,
    sleepTimer: null,
    replyCheckTimer: null,
    proactiveTimer: null,
    lastIncomingAt: 0,
    preSleepWaitSatisfiedAt: 0,
    preSleepWaitObservedAt: 0,
    preSleepWaitAccumMs: 0,
    lastUnreadSeq: 0,
    lastReadThroughSeq: 0,
    modelSeenSeqs: new Set(),
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {}
  };
}

// ── 一、spec ──────────────────────────────────────────────────────────────

test('spec 冻结，name 与 src 路径一致，level 为 locked', () => {
  assert.equal(Object.isFrozen(spec), true, 'spec 必须冻结');
  assert.equal(Object.isFrozen(spec.deps), true);
  assert.equal(Object.isFrozen(spec.optionalDeps), true);
  assert.equal(Object.isFrozen(spec.guards), true);
  assert.equal(Object.isFrozen(spec.toggle), true);

  assert.equal(spec.name, 'session/social-state');
  // 契约 H2：仿真状态属于「状态持久化」，关掉会让 AI 反复发言/丢上下文。
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.default, true);
  assert.equal(spec.toggle.hot, true);

  assert.deepEqual([...spec.deps], [], '纯计算模块不向中枢要任何能力');
  assert.deepEqual([...spec.optionalDeps], []);
  assert.match(spec.version, /^\d+\.\d+\.\d+$/);

  const file = fileURLToPath(new URL('../src/session/social-state.js', import.meta.url));
  const derived = file.replace(/\\/g, '/').split('/src/')[1].replace(/\.js$/, '');
  assert.equal(spec.name, derived);
});

// ── 二、normalizeSocialState：空值 / 缺字段 ───────────────────────────────

test('空对象 → 完整默认形状（26 个字段一个不少）', () => {
  const out = normalizeSocialState({});
  assert.deepEqual(out, expectedDefaults());
});

test('null / undefined / 非对象入参 → 同一份默认形状，且每次都是新对象', () => {
  for (const bad of [null, undefined, 42, 'x', true, [], [1, 2]]) {
    assert.deepEqual(normalizeSocialState(bad), expectedDefaults(), `入参 ${String(bad)}`);
  }
  const a = normalizeSocialState(null);
  const b = normalizeSocialState(null);
  assert.notEqual(a, b);
  assert.notEqual(a.recentMessages, b.recentMessages, '数组不能共享单例');
  a.recentMessages.push({ seq: 1 });
  assert.deepEqual(b.recentMessages, []);
});

test('activeTopics 保持空数组：线上就是 0 条，不做任何"顺手修"', () => {
  // 昨晚归档里 topics=0 —— 归一不得凭空造话题、也不得把它替换成别的字段名。
  assert.deepEqual(normalizeSocialState({ activeTopics: [] }).activeTopics, []);
  assert.deepEqual(normalizeSocialState({}).activeTopics, []);
});

// ── 三、字段类型错 ────────────────────────────────────────────────────────

test('字符串当数组用 → 归一成空数组（不是把字符串塞进去）', () => {
  const out = normalizeSocialState({
    recentMessages: 'oops',
    unread: 'oops',
    activeTopics: 'oops',
    pendingThoughts: 'oops',
    wakeTimes: 'oops',
    sendTimes: 'oops',
    proactiveWakeTimes: 'oops',
    stickerCollectTimes: 'oops'
  });
  for (const field of ['recentMessages', 'unread', 'activeTopics', 'pendingThoughts', 'wakeTimes', 'sendTimes', 'proactiveWakeTimes', 'stickerCollectTimes']) {
    assert.ok(Array.isArray(out[field]), `${field} 必须是数组`);
    assert.deepEqual(out[field], [], `${field} 必须是空数组`);
  }
  // 对象 / 数字 / null 同样归空
  assert.deepEqual(normalizeSocialState({ recentMessages: {} }).recentMessages, []);
  assert.deepEqual(normalizeSocialState({ recentMessages: 7 }).recentMessages, []);
  assert.deepEqual(normalizeSocialState({ recentMessages: null }).recentMessages, []);
});

test('数字字段：可转数字的字符串照转，转不动的一律 0（含 NaN / Infinity 之外的脏值）', () => {
  const out = normalizeSocialState({
    lastIncomingAt: '1700000000000',
    lastAiReplyAt: '12',
    preSleepWaitAccumMs: 'x',
    lastUnreadSeq: null
  });
  assert.equal(out.lastIncomingAt, 1700000000000);
  assert.equal(out.lastAiReplyAt, 12);
  assert.equal(out.preSleepWaitAccumMs, 0);
  assert.equal(out.lastUnreadSeq, 0);
});

test('lastReadThroughSeq：必须是安全非负整数，且不得超过 lastUnreadSeq', () => {
  assert.equal(normalizeSocialState({ lastReadThroughSeq: 500, lastUnreadSeq: 300 }).lastReadThroughSeq, 300);
  assert.equal(normalizeSocialState({ lastReadThroughSeq: 300, lastUnreadSeq: 300 }).lastReadThroughSeq, 300);
  // 旧实现的既有口径：lastUnreadSeq 缺省 0 时，任何正数都被夹成 0（照搬，不"修"）
  assert.equal(normalizeSocialState({ lastReadThroughSeq: 10 }).lastReadThroughSeq, 0);
  for (const bad of [-5, 1.5, 'abc', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(normalizeSocialState({ lastReadThroughSeq: bad, lastUnreadSeq: 99 }).lastReadThroughSeq, 0, `值 ${String(bad)}`);
  }
});

test('布尔与字符串字段：bootstrapSent 强制布尔，lastWakeReason 缺省空串', () => {
  assert.equal(normalizeSocialState({ bootstrapSent: 1 }).bootstrapSent, true);
  assert.equal(normalizeSocialState({ bootstrapSent: '' }).bootstrapSent, false);
  assert.equal(normalizeSocialState({ lastWakeReason: null }).lastWakeReason, '');
  assert.equal(normalizeSocialState({ lastWakeReason: 'at-mention' }).lastWakeReason, 'at-mention');
});

// ── 四、wakeConfig：默认值由中枢注入，triggers 走白名单 ────────────────────

test('wakeConfig 用注入的 wakeDefaults 合并；未注入时只做结构归一，不发明默认值', () => {
  const wakeDefaults = { mode: 'diving', infinite: true, triggers: { atMention: true, question: true }, wakeCount: 0 };
  const out = normalizeSocialState({ wakeConfig: { mode: 'active' } }, { wakeDefaults });

  assert.equal(out.wakeConfig.mode, 'active', '状态里的值优先');
  assert.equal(out.wakeConfig.infinite, true, '缺失字段用注入的默认值补齐');
  assert.deepEqual(out.wakeConfig.triggers, { atMention: true, question: true, speakerIds: [] }, 'triggers 缺失时回落到默认 triggers');

  // 不注入时不得凭空造出 mode —— 那些默认值来自 cfg，读 cfg 不是本模块的事。
  const bare = normalizeSocialState({ wakeConfig: { mode: 'active' } });
  assert.equal(bare.wakeConfig.mode, 'active');
  assert.deepEqual(bare.wakeConfig, { mode: 'active', triggers: { speakerIds: [] } });
});

test('triggers 只保留白名单键：模型传来的垃圾键不得进入状态', () => {
  const out = normalizeSocialState({
    wakeConfig: { triggers: { atMention: false, junk: 'x', '': 1, probability: 0.3, keywords: ['a'] } }
  });
  assert.deepEqual(out.wakeConfig.triggers, { atMention: false, keywords: ['a'], probability: 0.3, speakerIds: [] });
  assert.equal('junk' in out.wakeConfig.triggers, false);
});

test('speakerIds 归一：只留正整数、去重、上限 20；私聊会话清空', () => {
  const out = normalizeSocialState({
    wakeConfig: { triggers: { speakerIds: ['001', '123', '123', 'abc', '', null, ' 456 '] } }
  });
  assert.deepEqual(out.wakeConfig.triggers.speakerIds, ['123', '456']);

  const many = Array.from({ length: 30 }, (_, i) => String(1000 + i));
  assert.equal(normalizeSocialState({ wakeConfig: { triggers: { speakerIds: many } } }).wakeConfig.triggers.speakerIds.length, 20);

  const priv = normalizeSocialState({ wakeConfig: { triggers: { speakerIds: ['123'] } } }, { key: 'private:10001' });
  assert.deepEqual(priv.wakeConfig.triggers.speakerIds, [], '私聊里"指定群友唤醒"没有意义');
  const group = normalizeSocialState({ wakeConfig: { triggers: { speakerIds: ['123'] } } }, { key: 'group:555' });
  assert.deepEqual(group.wakeConfig.triggers.speakerIds, ['123']);
});

// ── 五、memberImpressions / agentToken ────────────────────────────────────

test('memberImpressions 丢掉 __proto__ / constructor / prototype（原型链污染入口）', () => {
  const dirty = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":1,"10086":{"tag":"话痨"}}');
  const out = normalizeSocialState({ memberImpressions: dirty });
  assert.deepEqual(Object.keys(out.memberImpressions), ['10086']);
  assert.equal({}.polluted, undefined, '原型链不得被污染');
  assert.deepEqual(normalizeSocialState({ memberImpressions: 'nope' }).memberImpressions, {});
  assert.deepEqual(normalizeSocialState({ memberImpressions: [] }).memberImpressions, {});
});

test('agentToken 原样保留；缺失时给空串 —— 模块不产随机数（生成归中枢）', () => {
  assert.equal(normalizeSocialState({ agentToken: 'abc123' }).agentToken, 'abc123');
  assert.equal(normalizeSocialState({ agentToken: 123 }).agentToken, '123');
  assert.equal(normalizeSocialState({}).agentToken, '', '旧实现这里会 crypto.randomBytes —— 已上移中枢');
});

test('运行期句柄（timer / Set）在归一后保留，不被重置（否则中枢手里的定时器会失联）', () => {
  const timer = { id: 'timer-1' };
  const seen = new Set([1, 2]);
  const out = normalizeSocialState({ pendingWakeTimer: timer, sleepTimer: timer, modelSeenSeqs: seen });
  assert.equal(out.pendingWakeTimer, timer);
  assert.equal(out.sleepTimer, timer);
  assert.deepEqual(out.modelSeenSeqs, new Set([1, 2]));
});

// ── 六、正常路径不裁剪（读侧不动数据） ───────────────────────────────────

test('normalize 不裁剪：250 条 recentMessages 原样保留（裁剪是写盘前的事）', () => {
  const out = normalizeSocialState({ recentMessages: nums(250), unread: nums(150), activeTopics: nums(80) });
  assert.equal(out.recentMessages.length, 250);
  assert.equal(out.unread.length, 150);
  assert.equal(out.activeTopics.length, 80);
});

// ── 七、mergeSocialPatch：写盘前的合并 + 上限裁剪 ─────────────────────────

test('合并时未提供的字段不丢', () => {
  const current = {
    lastIncomingAt: 1000,
    lastWakeReason: 'at-mention',
    lastActionAt: 7,
    activeTopics: [{ text: '聊装修' }],
    memberImpressions: { 10086: { tag: '话痨' } }
  };
  const out = mergeSocialPatch(current, { lastIncomingAt: 2000 });

  assert.equal(out.lastIncomingAt, 2000, '提供的字段被覆盖');
  assert.equal(out.lastWakeReason, 'at-mention', '未提供的字段必须保留');
  assert.equal(out.lastActionAt, 7);
  assert.deepEqual(out.activeTopics, [{ text: '聊装修' }]);
  assert.deepEqual(out.memberImpressions, { 10086: { tag: '话痨' } });
});

test('patch 里显式的 undefined 视为"未提供"，不得把字段抹成空', () => {
  const out = mergeSocialPatch({ lastWakeReason: 'x', lastIncomingAt: 9 }, { lastWakeReason: undefined });
  assert.equal(out.lastWakeReason, 'x');
  assert.equal(out.lastIncomingAt, 9);
});

test('wakeConfig 只合并一层：patch 只给 mode 时 triggers 不被抹掉', () => {
  const current = { wakeConfig: { mode: 'diving', triggers: { atMention: false, speakerIds: ['123'] }, wakeCount: 3 } };
  const out = mergeSocialPatch(current, { wakeConfig: { mode: 'active' } });

  assert.equal(out.wakeConfig.mode, 'active');
  assert.equal(out.wakeConfig.wakeCount, 3, '未提到的配置项保留');
  assert.deepEqual(out.wakeConfig.triggers, { atMention: false, speakerIds: ['123'] });
});

test('写盘前上限裁剪：recentMessages 200 / unread 100 / wakeTimes 200 / sendTimes 500 / proactive 50 / sticker 500 / topics 50 / thoughts 50', () => {
  const out = mergeSocialPatch({
    recentMessages: nums(250),
    unread: nums(150),
    wakeTimes: nums(250),
    sendTimes: nums(600),
    proactiveWakeTimes: nums(60),
    stickerCollectTimes: nums(600),
    activeTopics: nums(80),
    pendingThoughts: nums(60)
  }, {});

  assert.equal(out.recentMessages.length, 200);
  assert.equal(out.recentMessages[0].seq, 50, '裁剪保留的是最后 200 条');
  assert.equal(out.recentMessages.at(-1).seq, 249);

  assert.equal(out.unread.length, 100);
  assert.equal(out.wakeTimes.length, 200);
  assert.equal(out.sendTimes.length, 500);
  assert.equal(out.proactiveWakeTimes.length, 50);
  assert.equal(out.stickerCollectTimes.length, 500);
  assert.equal(out.activeTopics.length, 50);
  assert.equal(out.pendingThoughts.length, 50);
});

test('merge 也会兜住 patch 里的类型错误（字符串当数组 → 空数组，再按上限裁剪）', () => {
  const out = mergeSocialPatch({ recentMessages: nums(3) }, { recentMessages: 'oops' });
  assert.deepEqual(out.recentMessages, []);
});

// ── 八、幂等 / 不修改入参 / 循环引用 ─────────────────────────────────────

test('幂等：normalize 两遍结果相同；merge 后再 merge 空 patch 不变', () => {
  const inputs = [
    {},
    { recentMessages: nums(3), lastIncomingAt: '5', activeTopics: 'bad' },
    { wakeConfig: { mode: 'active', triggers: { speakerIds: ['123'], junk: 1 } }, memberImpressions: { a: 1 } }
  ];
  for (const input of inputs) {
    const once = normalizeSocialState(input);
    assert.deepEqual(normalizeSocialState(once), once, `归一不幂等：${JSON.stringify(input)}`);

    const merged = mergeSocialPatch(input, { lastIncomingAt: 42 });
    assert.deepEqual(mergeSocialPatch(merged, {}), merged, '合并空 patch 不得改变结果');
  }
});

test('不修改入参：normalize 与 merge 前后逐字节相等', () => {
  const input = {
    recentMessages: [{ seq: 1 }],
    activeTopics: [{ text: 't' }],
    wakeConfig: { mode: 'diving', triggers: { atMention: true } },
    memberImpressions: { a: { b: 1 } },
    lastIncomingAt: 1
  };
  const snapshot = JSON.stringify(input);
  normalizeSocialState(input);
  mergeSocialPatch(input, { lastIncomingAt: 2, wakeConfig: { mode: 'active' } });
  assert.equal(JSON.stringify(input), snapshot, '入参被就地改写了');
});

test('循环引用的入参不递归、不栈溢出：未知键被丢弃，已知数组原样持有引用', () => {
  const cyclic = { lastIncomingAt: 5 };
  cyclic.self = cyclic;
  cyclic.recentMessages = [cyclic];

  const out = normalizeSocialState(cyclic);
  assert.equal(out.lastIncomingAt, 5);
  assert.equal('self' in out, false, '未知键不进状态，所以不会把环带进去');
  assert.equal(out.recentMessages.length, 1);
  assert.equal(out.recentMessages[0], cyclic, '只搬引用，不深拷贝');

  const merged = mergeSocialPatch(cyclic, { lastWakeReason: 'x' });
  assert.equal(merged.lastWakeReason, 'x');
  assert.equal(merged.recentMessages[0], cyclic);
});

// ── 九、门面 ──────────────────────────────────────────────────────────────

test('handle 按 action 分发，未知动作返回 INVALID_ARGS，永不返回 undefined', () => {
  const normalized = handle(null, { action: 'normalize', state: { lastIncomingAt: 9 } });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.lastIncomingAt, 9);

  const merged = handle(null, { action: 'merge', current: { lastIncomingAt: 1 }, patch: { lastIncomingAt: 2 } });
  assert.equal(merged.ok, true);
  assert.equal(merged.value.lastIncomingAt, 2);

  for (const bad of [undefined, null, {}, { action: '' }, { action: 'Normalize' }, { action: '__proto__' }]) {
    const r = handle(null, bad);
    assert.equal(typeof r, 'object');
    assert.notEqual(r, null);
    assert.equal(r.ok, false, `args=${JSON.stringify(bad)} 应失败`);
    assert.equal(r.code, 'INVALID_ARGS');
    assert.equal(typeof r.error, 'string');
  }
});

test('handle 不依赖 ctx：传 null 也能工作（纯计算模块，无 deps）', () => {
  assert.equal(handle(null, { action: 'normalize', state: {} }).ok, true);
  assert.equal(handle(undefined, { action: 'merge', current: {}, patch: {} }).ok, true);
});

// ── 十、边界：模块本身不许碰 IO / 时钟 / 随机 / 日志 ─────────────────────

test('源文件禁用清单：不 import 任何东西、不写文件、不读时钟与随机数、不 console', () => {
  const src = fs.readFileSync(new URL('../src/session/social-state.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(/from\s+['"]node:fs['"]/.test(code), false, '不得 import node:fs');
  assert.equal(/from\s+['"][^'"]*bridge\.js['"]/.test(code), false, '不得 import bridge.js');
  assert.equal(/import\s*\(/.test(code), false, '不得动态 import');
  assert.equal(/\bwriteFileSync\b|\bappendFileSync\b|\breadFileSync\b|\bmkdirSync\b/.test(code), false, '不得做文件 IO');
  assert.equal(/Date\.now\s*\(/.test(code), false, '不得使用 Date.now()');
  assert.equal(/new\s+Date\s*\(/.test(code), false, '不得构造 Date');
  assert.equal(/Math\.random\s*\(/.test(code), false, '不得使用 Math.random()');
  assert.equal(/crypto\s*\./.test(code), false, '不得生成令牌（那是中枢的事）');
  assert.equal(/console\s*\./.test(code), false, '不得使用 console');
  assert.equal(/process\s*\.\s*env/.test(code), false, '不得读 process.env');
  assert.equal(/globalThis/.test(code), false, '不得读全局对象');
  assert.equal(/\basync\b|\bawait\b|\bPromise\b/.test(code), false, '必须是纯同步实现');

  const froms = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(froms, [], `纯函数模块不得有任何 import，实际：${froms.join(', ')}`);
});
