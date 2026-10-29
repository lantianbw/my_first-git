import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  spec,
  CAPABILITIES,
  ALERT_COOLDOWN_MS,
  ALERT_COOLDOWN_MAX_ENTRIES,
  readGates,
  buildCapabilities,
  describeKeyHuman,
  renderFeedbackAlert,
  createAlertCooldown
} from '../src/tools/capabilities.js';

const ENTRY_KEYS = ['name', 'desc', 'enabled', 'why'];
const ALLOWED_KEYS = new Set(ENTRY_KEYS);

function entryOf(list, name) {
  const found = list.find((item) => item.name === name);
  assert.ok(found, `能力表里应有「${name}」`);
  return found;
}

// ── 契约 ────────────────────────────────────────────────────────────────
test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'tools/capabilities');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('能力表：名字唯一、文案非空、绝不出现 qq_ 工具名', () => {
  assert.ok(Array.isArray(CAPABILITIES) && CAPABILITIES.length >= 15, '能力表条数应当覆盖主要功能面');
  const names = new Set();
  for (const item of CAPABILITIES) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.desc, 'string');
    assert.ok(item.name.trim().length > 0, `${item.name} 的名字不能为空`);
    assert.ok(item.desc.trim().length > 0, `${item.name} 的说明不能为空`);
    assert.ok(!names.has(item.name), `能力名重复：${item.name}`);
    names.add(item.name);
    assert.doesNotMatch(item.name, /qq_/, `能力名不该出现工具名：${item.name}`);
    assert.doesNotMatch(item.desc, /qq_/, `能力说明不该出现工具名：${item.desc}`);
    // 说明是「人话」：不描述实现（函数名/文件名/接口路径）
    assert.doesNotMatch(item.desc, /\.js|src\/|\/api\/|function|接口 /, `能力说明不该提实现：${item.desc}`);
    assert.ok(item.flags.length > 0, `${item.name} 至少要挂一个工具开关`);
  }
});

// ── 能力表生成：开 / 关 / 为什么关 ───────────────────────────────────────
test('buildCapabilities：没写开关 = 开（与 v2ToolEnabled 同口径）', () => {
  const list = buildCapabilities({});
  assert.equal(list.length, CAPABILITIES.length);
  for (const item of list) {
    assert.equal(item.enabled, true, `${item.name} 默认应当是开的`);
    assert.equal('why' in item, false, `${item.name} 开着就不该有 why`);
  }
});

test('buildCapabilities：单项工具关掉 → 只有那一项变灰，并给出人话原因', () => {
  const list = buildCapabilities({ socialV2: { tools: { sendVoice: false } } });
  const voice = entryOf(list, '发语音');
  assert.equal(voice.enabled, false);
  assert.equal(voice.why, '语音发送没开');
  // 别的项不受影响（尤其「直接开口说」是另一个开关）
  assert.equal(entryOf(list, '直接开口说').enabled, true);
  assert.equal(entryOf(list, '说话').enabled, true);
});

test('buildCapabilities：一项能力挂多个开关时，全开才算可用', () => {
  const partial = buildCapabilities({ socialV2: { tools: { sendBurst: false } } });
  assert.equal(entryOf(partial, '说话').enabled, false, '拆条发关掉后「说话」整体不可用');
  assert.equal(entryOf(partial, '说话').why, '发消息被关掉了');

  const clean = buildCapabilities({ socialV2: { tools: { sendBurst: true } } });
  assert.equal(entryOf(clean, '说话').enabled, true);
});

test('buildCapabilities：体系总闸关掉 → 该体系全灰，原因说的是整套（优先于单项）', () => {
  const list = buildCapabilities({ socialV2: { voice: { enabled: false } } });
  assert.equal(entryOf(list, '发语音').enabled, false);
  assert.equal(entryOf(list, '发语音').why, '语音功能整个关着');
  assert.equal(entryOf(list, '直接开口说').enabled, false);
  assert.equal(entryOf(list, '直接开口说').why, '语音功能整个关着');
  // 文字聊天不受语音总闸影响
  assert.equal(entryOf(list, '说话').enabled, true);
});

test('buildCapabilities：表情包 / 梗库总闸各自独立', () => {
  const noSticker = buildCapabilities({ socialV2: { sticker: { enabled: false } } });
  assert.equal(entryOf(noSticker, '发表情包').enabled, false);
  assert.equal(entryOf(noSticker, '发表情包').why, '表情包体系已关闭');
  assert.equal(entryOf(noSticker, '攒梗').enabled, true, '关表情包不该连累梗库');
  assert.equal(entryOf(noSticker, '小动作').enabled, true, '戳一戳/点赞不是表情包体系');

  const noMeme = buildCapabilities({ socialV2: { memes: { enabled: false } } });
  assert.equal(entryOf(noMeme, '攒梗').enabled, false);
  assert.equal(entryOf(noMeme, '攒梗').why, '梗库已关闭');
  assert.equal(entryOf(noMeme, '发表情包').enabled, true);
});

test('buildCapabilities：返回形状钉死 { name, desc, enabled, why? }，不泄漏内部开关名', () => {
  const list = buildCapabilities({
    socialV2: { tools: { speak: false, memory: false }, voice: { enabled: false } }
  });
  for (const item of list) {
    for (const key of Object.keys(item)) {
      assert.ok(ALLOWED_KEYS.has(key), `多余的字段：${key}`);
    }
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.desc, 'string');
    assert.equal(typeof item.enabled, 'boolean');
    if (item.enabled === false) assert.equal(typeof item.why, 'string');
    else assert.equal('why' in item, false);
  }
  // 挂的 flags / gate 是实现细节，不能出现在返回里
  assert.equal(JSON.stringify(list).includes('"flags"'), false);
  assert.equal(JSON.stringify(list).includes('"gate"'), false);
});

test('readGates：只读三个体系总闸，缺配置一律按开', () => {
  assert.deepEqual(readGates({}), { voice: true, sticker: true, meme: true });
  assert.deepEqual(readGates({ socialV2: {} }), { voice: true, sticker: true, meme: true });
  assert.deepEqual(
    readGates({ socialV2: { voice: { enabled: false }, sticker: { enabled: false }, memes: { enabled: false } } }),
    { voice: false, sticker: false, meme: false }
  );
});

test('纯函数：不改入参、每次返回新对象', () => {
  const config = { socialV2: { tools: { sendVoice: false }, voice: { enabled: true } } };
  const snapshot = JSON.stringify(config);
  const a = buildCapabilities(config);
  const b = buildCapabilities(config);
  assert.equal(JSON.stringify(config), snapshot, '不该改动传入的 cfg');
  assert.notEqual(a, b, '每次都要新数组');
  assert.notEqual(a[0], b[0], '每一项也要新对象');
  // 调用方改返回值不影响下一次生成
  a[0].name = '被改了';
  a[0].enabled = false;
  assert.equal(buildCapabilities(config)[0].name, b[0].name);
});

// ── 告警文案 ────────────────────────────────────────────────────────────
test('describeKeyHuman：群/私聊转人话，怪 key 原样返回', () => {
  assert.equal(describeKeyHuman('group:123456'), '群 123456');
  assert.equal(describeKeyHuman('private:10001'), '私聊 10001');
  assert.equal(describeKeyHuman('  group:42  '), '群 42');
  assert.equal(describeKeyHuman('something-else'), 'something-else');
  assert.equal(describeKeyHuman(''), '未知会话');
  assert.equal(describeKeyHuman(null), '未知会话');
});

test('renderFeedbackAlert：固定格式 【她的报告】<会话>：<内容>', () => {
  assert.equal(
    renderFeedbackAlert('group:123456', '语音发不出去'),
    '【她的报告】群 123456：语音发不出去'
  );
  assert.equal(
    renderFeedbackAlert('private:10001', '  表情库读不出来  '),
    '【她的报告】私聊 10001：表情库读不出来'
  );
  // 空内容不能发出「没说完」的半句话
  assert.equal(renderFeedbackAlert('group:1', ''), '【她的报告】群 1：（她没写具体是什么坏了）');
  assert.equal(renderFeedbackAlert('group:1', undefined), '【她的报告】群 1：（她没写具体是什么坏了）');
});

// ── 10 分钟冷却 ─────────────────────────────────────────────────────────
test('冷却：同内容 10 分钟内只放行一次，过了窗口再放行', () => {
  let now = 1_000_000;
  const cooldown = createAlertCooldown({ now: () => now });
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), true);
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), false);

  now += ALERT_COOLDOWN_MS - 1;
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), false, '差 1ms 仍在冷却里');

  now += 1;
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), true, '窗口一到就重新放行');
  assert.equal(cooldown.size(), 1, '同一内容只占一条');
});

test('冷却：不同内容 / 不同会话互不影响', () => {
  let now = 1_000_000;
  const cooldown = createAlertCooldown({ now: () => now });
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), true);
  assert.equal(cooldown.shouldSend('group:1\n表情没了'), true, '同会话不同内容要发');
  assert.equal(cooldown.shouldSend('group:2\n语音坏了'), true, '不同会话同样内容要发');
  assert.equal(cooldown.size(), 3);
  now += 60_000;
  assert.equal(cooldown.shouldSend('group:1\n语音坏了'), false);
});

test('冷却：空 id 一律不发', () => {
  const cooldown = createAlertCooldown({ now: () => 1 });
  assert.equal(cooldown.shouldSend(''), false);
  assert.equal(cooldown.shouldSend(null), false);
  assert.equal(cooldown.shouldSend(undefined), false);
  assert.equal(cooldown.size(), 0);
});

test('冷却：表有上限，超出按插入顺序淘汰最旧的（不会无限增长）', () => {
  let now = 1_000_000;
  const cooldown = createAlertCooldown({ now: () => now, maxEntries: 2 });
  assert.equal(cooldown.shouldSend('a'), true);
  assert.equal(cooldown.shouldSend('b'), true);
  assert.equal(cooldown.shouldSend('c'), true);
  assert.equal(cooldown.size(), 2);
  assert.equal(cooldown.shouldSend('a'), true, 'a 已被淘汰，可以再发');
  assert.equal(cooldown.size(), 2);

  // 默认上限是 200
  const defaults = createAlertCooldown({ now: () => now });
  for (let i = 0; i < ALERT_COOLDOWN_MAX_ENTRIES + 50; i += 1) defaults.shouldSend(`id-${i}`);
  assert.equal(defaults.size(), ALERT_COOLDOWN_MAX_ENTRIES);
});

test('冷却：系统时间被往回调时按「刚发过」处理，宁可少发不刷屏', () => {
  let now = 1_000_000;
  const cooldown = createAlertCooldown({ now: () => now });
  assert.equal(cooldown.shouldSend('x'), true);
  now -= 5_000;
  assert.equal(cooldown.shouldSend('x'), false);
});

test('冷却：windowMs=0 时不做限制；reset 清空', () => {
  const cooldown = createAlertCooldown({ now: () => 1_000_000, windowMs: 0 });
  assert.equal(cooldown.shouldSend('x'), true);
  assert.equal(cooldown.shouldSend('x'), true);

  const normal = createAlertCooldown({ now: () => 1_000_000 });
  normal.shouldSend('x');
  assert.equal(normal.size(), 1);
  normal.reset();
  assert.equal(normal.size(), 0);
  assert.equal(normal.shouldSend('x'), true);
});

// ── 桥接接线（防止只写模块不接线）────────────────────────────────────────
test('bridge.js：qq_get_prompt 真的带上了 capabilities', () => {
  const src = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/tools\/capabilities\.js'/, '必须从能力模块导入');
  assert.match(src, /capabilities: buildCapabilities\(cfg\)/, 'prompt 返回里必须有 capabilities 字段');
  // 位置约束：紧跟在 enabledTools 后面，别飘到别的响应里去
  assert.match(src, /enabledTools,\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*capabilities: buildCapabilities\(cfg\),/);
});

test('bridge.js：level=error 真的私聊 owner，并带 10 分钟冷却', () => {
  const src = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /const feedbackAlertCooldown = createAlertCooldown\(\)/);
  assert.match(src, /if \(level === 'error' && cfg\.ownerQQ\)/);
  assert.match(src, /feedbackAlertCooldown\.shouldSend\(alertId\)/);
  assert.match(src, /sendToQQ\(`private:\$\{cfg\.ownerQQ\}`, renderFeedbackAlert\(key, message\)\)/);
  // 旧的「只记日志」实现必须消失
  assert.doesNotMatch(src, /当前仅记录日志/);
});
