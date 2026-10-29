import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateContent,
  looksLikeVocativeAddress,
  matchMetaWord,
  matchSensitiveEntity,
  matchKinshipTitle,
  matchPresetEcho,
  guardSection,
  guardSectionEnabled,
  spec,
  DEFAULT_META_BLOCK_WORDS,
  DEFAULT_SENSITIVE_ENTITIES,
  DEFAULT_KINSHIP_TITLES,
  DEFAULT_PRESET_ECHO_LINES
} from '../src/guards/outbound-content.js';

// 与 config.json 的 socialV2.guard 同形
const GUARD_ON = { meta: { enabled: true }, address: { enabled: true } };

// 把「中枢 → 守卫 → 发送」压成两行，用来断言 fail open 时主链路仍然走到底
function sendLike(text, options = {}) {
  const verdict = evaluateContent({ text, ...options });
  if (!verdict.ok) return { blocked: verdict.kind };
  return { sent: verdict.text };
}

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('正常文本原样放行', () => {
  const v = evaluateContent({ text: '在，怎么了' });
  assert.equal(v.ok, true);
  assert.equal(v.text, '在，怎么了');
  assert.equal(v.reason, undefined);
});

test('空文本与空入参放行（旧实现 String(undefined ?? "")）', () => {
  for (const text of ['', undefined, null]) {
    const v = evaluateContent({ text });
    assert.equal(v.ok, true);
    assert.equal(v.text, '');
  }
});

// ── 元信息块命中 ───────────────────────────────────────────────────────────

test('元信息块命中：默认词表，拦下并带命中词', () => {
  const v = evaluateContent({ text: '我选择本次不发言' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
  assert.equal(v.word, '我选择本次不发言');
  assert.match(v.reason, /元信息泄漏/);
});

test('元信息块命中：句子中间出现也拦', () => {
  const v = evaluateContent({ text: '队列里还有三条，新消息已排队，等下再说' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
  assert.equal(v.word, '新消息已排队');
});

test('自定义词表覆盖默认词表', () => {
  const hit = evaluateContent({ text: '内部口令XYZ', words: ['内部口令XYZ'] });
  assert.equal(hit.ok, false);
  assert.equal(hit.word, '内部口令XYZ');
  // 覆盖之后默认词表不再生效（旧实现同口径）
  const pass = evaluateContent({ text: '我选择本次不发言', words: ['内部口令XYZ'] });
  assert.equal(pass.ok, true);
});

test('词表为空数组：回落默认词表，仍然拦', () => {
  const v = evaluateContent({ text: '我选择本次不发言', words: [] });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
});

test('词表全是空串：复刻现状——等于关掉元信息过滤', () => {
  const v = evaluateContent({ text: '我选择本次不发言', words: ['', ''] });
  assert.equal(v.ok, true, '旧实现 filter(Boolean) 后词表为空，不命中任何词');
});

test('只传 guard 分节时，词表从 socialV2.guard.meta.words 读', () => {
  const v = evaluateContent({ text: '内部口令ABC', guard: { meta: { words: ['内部口令ABC'] } } });
  assert.equal(v.ok, false);
  assert.equal(v.word, '内部口令ABC');
});

// ── 大小写与全角 ───────────────────────────────────────────────────────────

test('大小写：词条小写也能命中大写文本', () => {
  assert.equal(matchMetaWord('PROMPT LEAK', 'prompt'), true);
  assert.equal(evaluateContent({ text: 'SYSTEM PROMPT 泄漏了', words: ['prompt'] }).ok, false);
});

test('全角：词条写成全角也能命中半角文本，反之亦然', () => {
  assert.equal(matchMetaWord('prompt now', 'ＰＲＯＭＰＴ'), true);
  assert.equal(matchMetaWord('ＰＲＯＭＰＴ now', 'prompt'), true);
  // 默认词条「已思考（用时」里的全角括号不该成为漏拦点
  assert.equal(evaluateContent({ text: '已思考(用时 3 秒)' }).ok, false);
});

// ── 正则词条 ───────────────────────────────────────────────────────────────

test('正则词条命中：/.../flags 字符串与 RegExp 实例都支持', () => {
  const fromString = evaluateContent({ text: '提 示 词 别发', words: ['/提\\s*示\\s*词/'] });
  assert.equal(fromString.ok, false);
  assert.equal(fromString.word, '/提\\s*示\\s*词/');

  const fromRegExp = evaluateContent({ text: 'abc-123', words: [/^abc-\d+$/] });
  assert.equal(fromRegExp.ok, false);
});

test('正则异常时按无命中（坏 pattern 不抛、不拦）', () => {
  const v = evaluateContent({ text: '/([/ 这句话原样发', words: ['/([/'] });
  assert.equal(v.ok, true);
  assert.equal(v.text, '/([/ 这句话原样发');
  assert.equal(matchMetaWord('任意文本', '/([/'), false);
});

test('正则异常时按无命中（test 抛错的 RegExp 子类）', () => {
  class Exploding extends RegExp {
    test() {
      throw new Error('regex boom');
    }
  }
  const v = evaluateContent({ text: '随便一句话', words: [new Exploding('x')] });
  assert.equal(v.ok, true);
  assert.equal(v.text, '随便一句话');
});

test('带 g 标志的正则重复调用不因 lastIndex 失灵', () => {
  const word = /提示词/g;
  assert.equal(matchMetaWord('提示词', word), true);
  assert.equal(matchMetaWord('提示词', word), true, '第二次仍应命中');
});

// ── 表情 / 长度 ────────────────────────────────────────────────────────────

test('纯表情放行', () => {
  const v = evaluateContent({ text: '😂😂😂😭' });
  assert.equal(v.ok, true);
  assert.equal(v.text, '😂😂😂😭');
});

test('⏳ 属于默认拦词：表情不是一律放行', () => {
  const v = evaluateContent({ text: '⏳' });
  assert.equal(v.ok, false);
  assert.equal(v.word, '⏳');
});

test('超长文本：不抛、不截断、原文返回', () => {
  const long = '好'.repeat(100_000);
  const v = evaluateContent({ text: long });
  assert.equal(v.ok, true);
  assert.equal(v.text.length, 100_000);
});

test('超长文本末尾带拦词：仍然命中', () => {
  const v = evaluateContent({ text: `${'好'.repeat(100_000)}我选择本次不发言` });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
});

// ── 敏感人物名（E1：被借嘴复述） ────────────────────────────────────────────

test('敏感实体：直接说、复述别人的话、拆字变体都拦', () => {
  const samples = [
    '汪精卫',
    '那不就是汪精卫，这题我会',
    '汪精卫，这题早答完了',
    '汪 精 卫',
    '汪-精卫',
    '汪·精卫',
    '汪*精卫',
    '汪精衛',
    'Wang Jingwei'
  ];
  for (const text of samples) {
    const v = evaluateContent({ text });
    assert.equal(v.ok, false, `应拦：${text}`);
    assert.equal(v.kind, 'entity', `应记为 entity：${text}`);
  }
});

test('敏感实体：reason 不回显原词，word 只留给调用方记账', () => {
  const v = evaluateContent({ text: '汪精卫，这题早答完了' });
  assert.equal(v.ok, false);
  assert.equal(v.word, '汪精卫');
  assert.doesNotMatch(v.reason, /汪精卫/, 'reason 会回到模型，带原词等于教它再写一遍');
  assert.match(v.reason, /不能发/);
});

test('敏感实体：不点名的拒绝与正常历史话题不误伤', () => {
  for (const text of ['这题我不接', '换一个吧，这题超纲', '那段历史我不熟', '别问我人名']) {
    assert.equal(evaluateContent({ text }).ok, true, text);
  }
});

test('敏感实体：分节可关，词表可整表覆盖', () => {
  assert.equal(evaluateContent({ text: '汪精卫', guard: { sensitiveEntities: false } }).ok, true);
  assert.equal(evaluateContent({ text: '汪精卫', guard: { sensitiveEntities: { enabled: false } } }).ok, true);

  const custom = evaluateContent({ text: '某甲来了', guard: { sensitiveEntities: { words: ['某甲'] } } });
  assert.equal(custom.ok, false);
  assert.equal(custom.kind, 'entity');

  // 覆盖之后内置表不再生效（与 meta 同口径：整表替换，不是追加）
  assert.equal(evaluateContent({ text: '汪精卫', guard: { sensitiveEntities: { words: ['某甲'] } } }).ok, true);
});

test('敏感实体：坏词条只丢自己，不拖累其余词条也不抛', () => {
  const bad = {
    toString() {
      throw new Error('word boom');
    }
  };
  const v = evaluateContent({ text: '汪精卫', entityWords: [bad, '汪精卫'] });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'entity');
});

test('matchSensitiveEntity：默认表覆盖本次事故词，未收录词不命中', () => {
  assert.ok(DEFAULT_SENSITIVE_ENTITIES.includes('汪精卫'));
  assert.equal(matchSensitiveEntity('汪精卫'), '汪精卫');
  assert.equal(matchSensitiveEntity('完全无关的一句话'), null);
  assert.equal(matchSensitiveEntity(''), null);
  assert.equal(matchSensitiveEntity(null), null);
});

// ── 亲属称呼边界（E2：雪月爷爷） ────────────────────────────────────────────

test('亲属称呼：群聊与他人私聊一律拦', () => {
  const inGroup = evaluateContent({ text: '行吧，晚安雪月爷爷', isGroup: true });
  assert.equal(inGroup.ok, false);
  assert.equal(inGroup.kind, 'kinship');

  const inPrivate = evaluateContent({ text: '雪月爷爷，行了吧' });
  assert.equal(inPrivate.ok, false);
  assert.equal(inPrivate.kind, 'kinship');
  assert.match(inPrivate.reason, /非主人会话/);
});

test('亲属称呼：owner 私聊放行', () => {
  const v = evaluateContent({ text: '爷爷给你留了罐头', isOwnerPrivate: true });
  assert.equal(v.ok, true);
  assert.equal(v.text, '爷爷给你留了罐头');
});

test('亲属称呼：既定称呼「叔叔/老爹」与正常说法不误伤', () => {
  for (const text of ['王江叔叔今天没来', '我爹在忙', '老爹，我饿了', '我妈喊我吃饭']) {
    assert.equal(evaluateContent({ text, isGroup: true }).ok, true, text);
  }
});

test('亲属称呼：address 分节关掉后一并放行', () => {
  assert.equal(evaluateContent({ text: '爷爷', guard: { address: false } }).ok, true);
  assert.equal(evaluateContent({ text: '爷爷', addressEnabled: false }).ok, true);
});

test('matchKinshipTitle：命中返回称呼，空文本与不相关文本返回 null', () => {
  assert.ok(DEFAULT_KINSHIP_TITLES.includes('爷爷'));
  assert.equal(matchKinshipTitle('雪月爷爷'), '爷爷');
  assert.equal(matchKinshipTitle('在吗'), null);
  assert.equal(matchKinshipTitle(''), null);
  assert.equal(matchKinshipTitle(null), null);
});

// ── 分区开关 ───────────────────────────────────────────────────────────────

test('分区开关关闭时放行：meta 写布尔 false', () => {
  const v = evaluateContent({ text: '我选择本次不发言', guard: { meta: false } });
  assert.equal(v.ok, true);
});

test('分区开关关闭时放行：meta 写 {enabled:false}', () => {
  const v = evaluateContent({ text: '我选择本次不发言', guard: { meta: { enabled: false } } });
  assert.equal(v.ok, true);
});

test('分区开关关闭时放行：address 关闭后「饲养员」也放行', () => {
  const v = evaluateContent({ text: '饲养员吃饭了', guard: { address: { enabled: false } } });
  assert.equal(v.ok, true);
});

test('显式参数优先于分节：metaEnabled 覆盖 guard.meta.enabled=false', () => {
  const v = evaluateContent({
    text: '我选择本次不发言',
    guard: { meta: { enabled: false } },
    metaEnabled: true
  });
  assert.equal(v.ok, false);
});

test('分节缺失视为开：只给空对象时默认拦', () => {
  assert.equal(evaluateContent({ text: '我选择本次不发言', guard: {} }).ok, false);
  assert.equal(evaluateContent({ text: '老爹，我饿了', guard: GUARD_ON }).kind, 'vocative');
});

test('guardSectionEnabled：三条分支与边界值', () => {
  assert.equal(guardSectionEnabled(undefined, 'meta'), true, '缺失视为开');
  assert.equal(guardSectionEnabled({}, 'meta'), true);
  assert.equal(guardSectionEnabled({ meta: null }, 'meta'), true);
  assert.equal(guardSectionEnabled({ meta: true }, 'meta'), true);
  assert.equal(guardSectionEnabled({ meta: false }, 'meta'), false);
  assert.equal(guardSectionEnabled({ meta: {} }, 'meta'), true);
  assert.equal(guardSectionEnabled({ meta: { enabled: false } }, 'meta'), false);
  assert.equal(guardSectionEnabled({ meta: { enabled: 0 } }, 'meta'), true, '0 !== false');
  assert.equal(guardSectionEnabled({ meta: 'false' }, 'meta'), true, '字符串不是布尔 false');
});

test('guardSection：只有对象才算分节', () => {
  assert.deepEqual(guardSection(undefined, 'meta'), {});
  assert.deepEqual(guardSection({ meta: true }, 'meta'), {});
  assert.deepEqual(guardSection({ meta: null }, 'meta'), {});
  const section = { enabled: true, words: ['x'] };
  assert.equal(guardSection({ meta: section }, 'meta'), section, '对象原样返回，不复制');
});

// ── 称呼越界 ───────────────────────────────────────────────────────────────

test('称呼式命中：「老爹，我饿了」在非 owner 私聊、非群聊时拦', () => {
  const v = evaluateContent({ text: '老爹，我饿了' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'vocative');
  assert.match(v.reason, /称呼越界/);
});

test('「老爹」非呼语：改写成「你」并标记 replaced', () => {
  const v = evaluateContent({ text: '今天老爹给我买了个蛋糕' });
  assert.equal(v.ok, true);
  assert.equal(v.replaced, true);
  assert.equal(v.text, '今天你给我买了个蛋糕');
});

test('群聊里「老爹」不改写也不拦；owner 私聊同理', () => {
  const inGroup = evaluateContent({ text: '老爹，我饿了', isGroup: true });
  assert.equal(inGroup.ok, true);
  assert.equal(inGroup.text, '老爹，我饿了');
  assert.equal(inGroup.replaced, undefined);

  const toOwner = evaluateContent({ text: '老爹，我饿了', isOwnerPrivate: true });
  assert.equal(toOwner.ok, true);
  assert.equal(toOwner.text, '老爹，我饿了');
});

test('「饲养员」一律拦，含 owner 私聊', () => {
  for (const isOwnerPrivate of [true, false]) {
    const v = evaluateContent({ text: '饲养员吃饭了', isOwnerPrivate });
    assert.equal(v.ok, false);
    assert.equal(v.kind, 'address');
  }
});

test('阈值边界：呼语判定在「剩余 4 字 / 5 字」处翻转', () => {
  assert.equal(looksLikeVocativeAddress('老爹'), true, '整句就是称呼');
  assert.equal(looksLikeVocativeAddress('老爹，'), true, '紧跟标点');
  assert.equal(looksLikeVocativeAddress('老爹！你在吗'), true);
  assert.equal(looksLikeVocativeAddress('老爹 你在吗'), true, '紧跟空白');
  assert.equal(looksLikeVocativeAddress('老爹1234'), true, '剩余恰好 4 字');
  assert.equal(looksLikeVocativeAddress('老爹12345'), false, '剩余 5 字且非标点开头');
  assert.equal(looksLikeVocativeAddress('老爹今天又加班到很晚'), false);
  assert.equal(looksLikeVocativeAddress('我爸'), false, '不是句首');
  assert.equal(looksLikeVocativeAddress(' 老爹'), false, '句首空白不认');
  assert.equal(looksLikeVocativeAddress(''), false);
  assert.equal(looksLikeVocativeAddress(null), false);
});

// ── fail open：异常不得打断主链路 ──────────────────────────────────────────

test('fail open：文本 toString 抛错时放行且主链路继续', () => {
  const evil = {
    toString() {
      throw new Error('evil toString');
    }
  };
  const v = evaluateContent({ text: evil });
  assert.equal(v.ok, true);
  assert.equal(v.degraded, true);
  assert.match(v.error, /evil toString/);

  const out = sendLike(evil);
  assert.equal(out.sent, '', '主链路照常走到「发送」，没有被判定挡住');
});

test('fail open：读 guard 分节时就抛错，也放行', () => {
  const options = {
    text: '在吗',
    get guard() {
      throw new Error('guard getter boom');
    }
  };
  const v = evaluateContent(options);
  assert.equal(v.ok, true);
  assert.equal(v.text, '在吗');
  assert.equal(v.degraded, true);
  assert.match(v.error, /guard getter boom/);

  // 主链路继续：判定放行后调用方照原样把这条发出去
  const sent = [];
  const outbox = (text) => {
    const verdict = evaluateContent({
      text,
      get guard() {
        throw new Error('guard getter boom');
      }
    });
    if (verdict.ok) sent.push(verdict.text);
  };
  outbox('在吗');
  assert.deepEqual(sent, ['在吗']);
});

test('fail open：词条自己 toString 抛错时只丢这一条，其余词条照常拦', () => {
  const bad = {
    toString() {
      throw new Error('word boom');
    }
  };
  const v = evaluateContent({ text: '我选择本次不发言', words: [bad, '我选择本次不发言'] });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'meta');
});

// ── R1：preset 例句原句 ─────────────────────────────────────────────────────

test('R1：8 句 preset 例句原句全部拦截', () => {
  assert.equal(DEFAULT_PRESET_ECHO_LINES.length, 8);
  for (const line of DEFAULT_PRESET_ECHO_LINES) {
    const v = evaluateContent({ text: line });
    assert.equal(v.ok, false, `应拦截：${line}`);
    assert.equal(v.kind, 'presetEcho');
  }
});

test('R1：带标点、拆空格、嵌在长句里也能命中', () => {
  for (const text of ['床以外都是远方。', '床以外 都是远方', '行吧，床以外都是远方，睡', '无聊到 数 藤壶！']) {
    const v = evaluateContent({ text });
    assert.equal(v.ok, false, `应拦截：${text}`);
    assert.equal(v.kind, 'presetEcho');
  }
});

test('R1：reason 不带原句（避免把台词喂回去）', () => {
  const v = evaluateContent({ text: '床以外都是远方' });
  assert.equal(v.ok, false);
  assert.equal(v.word, '床以外都是远方');
  assert.ok(!v.reason.includes('床以外都是远方'));
});

test('R1：正常句子不误伤（只说「运动量」「藤壶」不算）', () => {
  for (const text of ['今天的运动量还行', '藤壶是什么梗', '电量还剩百分之五', '这季番停更了？']) {
    const v = evaluateContent({ text });
    assert.equal(v.ok, true, `不该拦：${text}`);
  }
});

test('R1：owner 私聊同样拦（AI 味不分会话）', () => {
  const v = evaluateContent({ text: '被子外面好危险', isOwnerPrivate: true });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'presetEcho');
});

test('R1：自定义 lines 整表覆盖；空数组回落到内置表', () => {
  const custom = evaluateContent({ text: '床以外都是远方', presetEchoLines: ['临时台词'] });
  assert.equal(custom.ok, true, '整表覆盖后旧句不再拦');
  const hit = evaluateContent({ text: '临时台词', presetEchoLines: ['临时台词'] });
  assert.equal(hit.kind, 'presetEcho');
  const fallback = evaluateContent({ text: '床以外都是远方', presetEchoLines: [] });
  assert.equal(fallback.kind, 'presetEcho', '空数组走默认表');
});

test('R1：分节 enabled=false 时关闭；section lines 生效', () => {
  const off = evaluateContent({ guard: { presetEcho: { enabled: false } }, text: '床以外都是远方' });
  assert.equal(off.ok, true);
  const viaSection = evaluateContent({ guard: { presetEcho: { lines: ['自定义'] } }, text: '自定义' });
  assert.equal(viaSection.kind, 'presetEcho');
  assert.equal(matchPresetEcho('没这句'), null);
});

// ── 契约 ───────────────────────────────────────────────────────────────────

test('spec 与默认词表符合契约', () => {
  assert.equal(spec.name, 'guards/outbound-content');
  assert.equal(spec.version, '1.3.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, ['outbound.content']);
  assert.equal(spec.toggle.level, 'owner');
  assert.equal(spec.toggle.default, true);
  assert.ok(DEFAULT_META_BLOCK_WORDS.length >= 10);
  assert.ok(DEFAULT_META_BLOCK_WORDS.includes('我选择本次不发言'));
  assert.equal(Object.isFrozen(DEFAULT_META_BLOCK_WORDS), true);
  assert.equal(Object.isFrozen(DEFAULT_SENSITIVE_ENTITIES), true);
  assert.equal(Object.isFrozen(DEFAULT_KINSHIP_TITLES), true);
});

test('返回形状：命中不带 text，放行不带 reason/word', () => {
  const blocked = evaluateContent({ text: '我选择本次不发言' });
  assert.equal('text' in blocked, false);
  const passed = evaluateContent({ text: '在的' });
  assert.deepEqual(passed, { ok: true, text: '在的' });
});
