import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_LIMIT,
  EVIDENCE_QUOTE_MAX_CHARS,
  normalizeEvidence,
  normalizeEvidenceQuote,
  appendEvidence,
  latestEvidenceQuote,
  markKinshipRefusal
} from '../src/memory/risk-profile.js';
import { adjustAffection } from '../src/memory/affection-profile.js';
import { renderMemory } from '../src/content/memory-render.js';

const NOW = 1_800_000_000_000;
const PRIVATE_KEY = 'private:1843979560';

/** 造一条「对方刚刚说了 text」的最近消息（最后一条是对方）。 */
function withQuote(text, at = 0) {
  return [
    { isSelf: true, sender: '我', text: '早上好', time: at - 1 },
    { isSelf: false, sender: '雪月', userId: 'u-雪月', text, time: at }
  ];
}

test('normalizeEvidenceQuote：压掉换行/连续空白，截断 40 字', () => {
  assert.equal(normalizeEvidenceQuote('  叫声\n爷爷\t听听  '), '叫声 爷爷 听听');
  assert.equal(normalizeEvidenceQuote('a'.repeat(50)).length, EVIDENCE_QUOTE_MAX_CHARS);
  assert.equal(normalizeEvidenceQuote(''), '');
  assert.equal(normalizeEvidenceQuote(null), '');
  assert.equal(normalizeEvidenceQuote(undefined), '');
});

test('normalizeEvidence：形状钉死 { quote, at, key, kind }，坏数据返回 null', () => {
  assert.deepEqual(
    normalizeEvidence({ quote: ' 叫声爷爷听听 ', at: '123', key: PRIVATE_KEY, kind: 'kinship' }),
    { quote: '叫声爷爷听听', at: 123, key: PRIVATE_KEY, kind: 'kinship' }
  );
  assert.deepEqual(
    normalizeEvidence({ quote: 'x' }),
    { quote: 'x', at: 0, key: '', kind: '' }
  );
  assert.equal(normalizeEvidence({ quote: '   ' }), null);
  assert.equal(normalizeEvidence(null), null);
  assert.equal(normalizeEvidence('x'), null);
});

test('appendEvidence：新的在前、同句去重、最多 3 条（淘汰最旧）', () => {
  let list = [];
  for (const [quote, at] of [['A', 1], ['B', 2], ['C', 3], ['D', 4]]) {
    list = appendEvidence(list, { quote, at, key: PRIVATE_KEY, kind: 'kinship' });
  }
  assert.equal(list.length, EVIDENCE_LIMIT);
  assert.deepEqual(list.map((e) => e.quote), ['D', 'C', 'B'], '新的在前，最旧的 A 被淘汰');
  assert.deepEqual(list.map((e) => e.at), [4, 3, 2]);

  // 同句再次出现：不新增第二条，把它提到最前并更新时间
  list = appendEvidence(list, { quote: 'B', at: 5, key: PRIVATE_KEY, kind: 'kinship' });
  assert.deepEqual(list.map((e) => e.quote), ['B', 'D', 'C']);
  assert.equal(list[0].at, 5);
  assert.equal(list.filter((e) => e.quote === 'B').length, 1);
});

test('写入时存原话：markKinshipRefusal 把触发它的那条存成 kind:kinship', () => {
  const result = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: withQuote('叫声爷爷听听', 1_700_000_000_000),
    memberImpressions: {}
  });
  assert.ok(result);
  const im = result.memberImpressions['雪月'];
  assert.deepEqual(im.evidence, [{
    quote: '叫声爷爷听听',
    at: 1_700_000_000_000,
    key: PRIVATE_KEY,
    kind: 'kinship'
  }]);
  // 原有结论字段不受影响
  assert.equal(im.noKinshipTitle, true);
  assert.deepEqual(im.risk.refusedTitles, ['亲属称呼']);
});

test('原话超过 40 字 / 带换行：写进去的是压缩截断后的版本', () => {
  const long = `  叫声\n爷爷\t听听 ${'啊'.repeat(60)}  `;
  const result = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: withQuote(long, 1),
    memberImpressions: {}
  });
  const quote = result.memberImpressions['雪月'].evidence[0].quote;
  assert.equal(quote.length, EVIDENCE_QUOTE_MAX_CHARS);
  assert.ok(quote.startsWith('叫声 爷爷 听听'));
  assert.doesNotMatch(quote, /\n/);
});

test('消息没有 time 时：用调用方注入的 now 兜底（模块自己不读时钟）', () => {
  const msgs = [{ isSelf: false, sender: '雪月', text: '叫声爷爷听听' }];
  const result = markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: msgs, memberImpressions: {}, now: NOW });
  assert.equal(result.memberImpressions['雪月'].evidence[0].at, NOW);

  const noNow = markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: msgs, memberImpressions: {} });
  assert.equal(noNow.memberImpressions['雪月'].evidence[0].at, 0, '没有时间就写 0，不读系统时钟');
});

test('消息原话为空：只记边界，不写 evidence、不补空数组', () => {
  const result = markKinshipRefusal({
    key: PRIVATE_KEY,
    recentMessages: [{ isSelf: false, sender: '雪月', text: '' }],
    memberImpressions: {}
  });
  assert.ok(result);
  assert.equal('evidence' in result.memberImpressions['雪月'], false);
});

test('adjustAffection 带语境：存 kind:affection；不带语境则行为不变', () => {
  const withContext = adjustAffection({}, '雪月', -10, {
    quote: '你怎么这么冷淡',
    at: 123456,
    key: PRIVATE_KEY
  });
  assert.deepEqual(withContext['雪月'].evidence, [{
    quote: '你怎么这么冷淡',
    at: 123456,
    key: PRIVATE_KEY,
    kind: 'affection'
  }]);
  assert.deepEqual(withContext['雪月'].affection, { score: -10, tags: [] });

  // 字符串语境也认
  const strContext = adjustAffection({}, '雪月', 5, '聊得挺开心');
  assert.equal(strContext['雪月'].evidence[0].kind, 'affection');
  assert.equal(strContext['雪月'].evidence[0].quote, '聊得挺开心');

  // 不带语境：不写 evidence（与 M8 行为一致）
  const noContext = adjustAffection({}, '雪月', 5);
  assert.equal('evidence' in noContext['雪月'], false);
});

test('adjustAffection 带语境时保留已有 evidence，并遵守 3 条上限', () => {
  let im = {};
  for (const q of ['一', '二', '三', '四']) {
    im = adjustAffection(im, '雪月', 1, q);
  }
  assert.deepEqual(im['雪月'].evidence.map((e) => e.quote), ['四', '三', '二']);
});

test('纯函数：不改传入的 memberImpressions / 已有 evidence', () => {
  const evidence = [{ quote: '旧原话', at: 1, key: PRIVATE_KEY, kind: 'kinship' }];
  const base = { 雪月: { traits: ['话多'], evidence } };
  const snapshot = JSON.stringify(base);

  markKinshipRefusal({ key: PRIVATE_KEY, recentMessages: withQuote('叫声爷爷听听', 2), memberImpressions: base });
  adjustAffection(base, '雪月', -10, { quote: '新原话', at: 3, key: PRIVATE_KEY });

  assert.equal(JSON.stringify(base), snapshot, '入参完全没被改写');
});

test('渲染只出最近 1 条原话：更早的两条不出现', () => {
  const st = {
    memberImpressions: {
      雪月: {
        traits: ['话多'],
        interactionCount: 5,
        noKinshipTitle: true,
        risk: { refusedTitles: ['亲属称呼'] },
        evidence: [
          { quote: '最新一句', at: 3, key: PRIVATE_KEY, kind: 'kinship' },
          { quote: '上一句', at: 2, key: PRIVATE_KEY, kind: 'kinship' },
          { quote: '更早一句', at: 1, key: PRIVATE_KEY, kind: 'kinship' }
        ]
      }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /（已拒绝的称呼：亲属称呼）（原话：「最新一句」）/);
  assert.doesNotMatch(out, /上一句/);
  assert.doesNotMatch(out, /更早一句/);
  assert.equal((out.match(/原话：/g) || []).length, 1, '整条印象只给一句原话');
});

test('渲染按 kind 归属：最新一条是 affection 就只挂到好感度，不重复挂在边界上', () => {
  const st = {
    memberImpressions: {
      雪月: {
        traits: ['话多'],
        noKinshipTitle: true,
        risk: { refusedTitles: ['亲属称呼'] },
        affection: { score: -10, tags: [] },
        evidence: [
          { quote: '最近一句是关系变化', at: 2, key: PRIVATE_KEY, kind: 'affection' },
          { quote: '更早的称呼施压', at: 1, key: PRIVATE_KEY, kind: 'kinship' }
        ]
      }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.match(out, /好感度 -10·一般）（原话：「最近一句是关系变化」）/);
  assert.match(out, /（已拒绝的称呼：亲属称呼）(?!（原话)/);
  assert.doesNotMatch(out, /更早的称呼施压/);
  assert.equal((out.match(/原话：/g) || []).length, 1);
});

test('无 evidence 的老数据照旧渲染：不报错、不补默认值、不出现「原话」', () => {
  const st = {
    memberImpressions: {
      雪月: { traits: ['要过亲属称呼，已拒绝'], interactionCount: 3, noKinshipTitle: true }
    }
  };
  const out = renderMemory(st, { now: NOW });
  assert.equal(out, '【对群友的印象】\n- 雪月：要过亲属称呼，已拒绝（互动 3 次）（边界：不叫亲属称呼，用名字或「你」）');
  assert.doesNotMatch(out, /原话/);
});

test('evidence 是脏数据（非数组 / 空原话 / null）：渲染照旧，不报错', () => {
  const dirty = {
    memberImpressions: {
      雪月: {
        traits: ['话多'],
        noKinshipTitle: true,
        evidence: [null, { quote: '   ' }, '不是对象', { quote: '' }]
      }
    }
  };
  const out = renderMemory(dirty, { now: NOW });
  assert.match(out, /（边界：不叫亲属称呼，用名字或「你」）/);
  assert.doesNotMatch(out, /原话/);
});

test('latestEvidenceQuote：只看最新一条，kind 不匹配返回空串', () => {
  const evidence = [
    { quote: 'A', at: 3, key: 'k', kind: 'kinship' },
    { quote: 'B', at: 2, key: 'k', kind: 'affection' }
  ];
  assert.equal(latestEvidenceQuote(evidence, ['kinship', 'trap', 'topic']), 'A');
  assert.equal(latestEvidenceQuote(evidence, ['affection']), '', '最新一条不是 affection，就不给好感度挂旧原话');
  assert.equal(latestEvidenceQuote(evidence), 'A');
  assert.equal(latestEvidenceQuote([]), '');
  assert.equal(latestEvidenceQuote(undefined), '');
});
