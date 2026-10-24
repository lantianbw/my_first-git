// 谐音梗能力回归：拼音归一化、同音/近音匹配、变体去重、候选登记。
// 离线运行，不需要 DSH / SnowLuma / QQ。

import assert from 'node:assert/strict';
import { getPinyin, normalizePinyin, editDistance, isPinyinNear, findHomophone } from '../src/pinyin-util.js';
import { normalizeSlangEntry, buildSlangContext, buildHomophoneContext, SLANG_STATUS } from '../src/slang-learner.js';
import { normalizeMemeEntry } from '../src/meme-lib.js';
import { addCandidate, seedCandidates, candidateKey, normalizeCandidate } from '../src/slang-candidates.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. 全拼归一化
{
  assert.equal(getPinyin('飞舞'), 'feiwu');
  assert.equal(getPinyin('废物'), 'feiwu');
  assert.equal(getPinyin('蚌埠住了'), 'bengbuzhule');
  assert.equal(getPinyin('绷不住了'), 'bengbuzhule');
  assert.equal(getPinyin('Hello 世界'), 'helloshijie');
  assert.equal(normalizePinyin('Fei-Wu!'), 'feiwu');
  ok('getPinyin 只保留无声调 a-z');
}

// 2. 拆字梗不是同音（彳亍 vs 行），避免误判
{
  assert.notEqual(getPinyin('彳亍'), getPinyin('行'));
  ok('彳亍 / 行 拼音不同（拆字梗不会被当成同音）');
}

// 3. 编辑距离与近音判定
{
  assert.equal(editDistance('feiwu', 'feiwu'), 0);
  assert.equal(editDistance('feiwu', 'feiw'), 1);
  assert.equal(editDistance('feiwu', 'feiww'), 1);
  assert.equal(editDistance('feiwu', 'feiwww'), 2);
  assert.equal(isPinyinNear('feiwu', 'feiw'), true);
  assert.equal(isPinyinNear('feiwu', 'feiwww'), false);
  ok('editDistance / isPinyinNear 边界正确');
}

// 4. 同音匹配：完全相等优先
{
  const items = [
    { content: '废物', meaning: '没用', variants: [] },
    { content: '飞屋', meaning: '飞行的屋子', variants: [] },
  ];
  const hit = findHomophone('飞舞', items);
  assert.equal(hit?.item?.content, '废物');
  assert.equal(hit.exact, true);
  ok('findHomophone 精确同音命中');
}

// 5. variants 也参与匹配（查变体能回到主词条）
{
  // 变体的拼音与管理词条不同（典型 dianxing / 典 dian），只能靠 variants 命中。
  const items = [{ content: '典型', meaning: '典型/典中典', variants: ['典'] }];
  const hit = findHomophone('典', items);
  assert.equal(hit?.item?.content, '典型');
  assert.equal(hit.matched, '典');
  assert.equal(hit.exact, true);
  ok('findHomophone 能命中 variants');
}

// 6. 近音（编辑距离 1）兜底
{
  const items = [{ content: '绷不住了', meaning: '忍不住', variants: [] }];
  const hit = findHomophone('蚌埠住了啊', items);
  assert.equal(hit?.item?.content, '绷不住了');
  assert.equal(hit.exact, false);
  assert.equal(hit.distance, 1);
  ok('findHomophone 近音兜底（距离 1）');
}

// 7. 黑话条目：pinyin 自动补齐 + variants 去重/排除自身
{
  const e = normalizeSlangEntry({
    content: '废物',
    meaning: '没用',
    variants: ['飞舞', '飞舞', '  ', '废物', '飞物'],
  });
  assert.equal(e.pinyin, 'feiwu');
  assert.deepEqual(e.variants, ['飞舞', '飞物']);
  ok('normalizeSlangEntry 补 pinyin 且 variants 去重');
}

// 8. 梗库条目：同样补 pinyin / variants
{
  const m = normalizeMemeEntry({ text: '蚌埠住了', meaning: '绷不住了', variants: ['蹦不住了', '蚌埠住了'] });
  assert.equal(m.pinyin, 'bengbuzhule');
  assert.deepEqual(m.variants, ['蹦不住了']);
  ok('normalizeMemeEntry 补 pinyin 且 variants 去重');
}

// 9. 谐音对照表只吃已确认条目，且带说明
{
  const entries = [
    normalizeSlangEntry({ content: '废物', meaning: '没用、菜', status: SLANG_STATUS.CONFIRMED, variants: ['飞舞'] }),
    normalizeSlangEntry({ content: '行', meaning: '可以', status: SLANG_STATUS.CONFIRMED, variants: ['彳亍'] }),
    normalizeSlangEntry({ content: '典', meaning: '典型', status: SLANG_STATUS.CANDIDATE, variants: ['点'] }),
  ];
  const block = buildHomophoneContext(entries, 10);
  assert.match(block, /飞舞=废物（同音）/);
  assert.match(block, /彳亍=行（近音\/梗）/);
  assert.match(block, /谐音要按读音理解，不确定就问，不要硬猜/);
  assert.doesNotMatch(block, /点=典/);
  ok('buildHomophoneContext 只取已确认、标注同音/近音');
}

// 9b. 反向写法：条目自身是变体（homophoneOf），且 source=seed 被保留
{
  const e = normalizeSlangEntry({
    content: '飞舞', meaning: '废物；没用、菜', homophoneOf: '废物', status: SLANG_STATUS.CONFIRMED, source: 'seed', variants: [],
  });
  assert.equal(e.source, 'seed');
  assert.equal(e.homophoneOf, '废物');
  assert.deepEqual(e.variants, []);
  assert.match(buildHomophoneContext([e], 10), /飞舞=废物（同音）/);
  ok('homophoneOf 反向变体可生成对照表，source=seed 保留');
}

// 10. buildSlangContext 合并黑话表与谐音表
{
  const entries = [normalizeSlangEntry({ content: '废物', meaning: '没用', status: SLANG_STATUS.CONFIRMED, variants: ['飞舞'] })];
  const block = buildSlangContext(entries, 8);
  assert.match(block, /【群聊黑话表】/);
  assert.match(block, /【谐音对照】/);
  assert.match(block, /飞舞=废物（同音）/);
  ok('buildSlangContext 同时输出黑话表与谐音对照');
}

// 11. 候选登记去重：同 content→target 只保留一条并累加来源
{
  let list = [];
  const first = addCandidate(list, {
    content: '飞舞', targetContent: '废物', meaning: '没用', source: 'auto', occurrences: 2, sourceMessageIds: ['m1', 'm2'],
  });
  list = first.list;
  assert.equal(first.created, true);
  const second = addCandidate(list, {
    content: '飞舞', targetContent: '废物', source: 'auto', occurrences: 1, sourceMessageIds: ['m3'],
  });
  assert.equal(second.created, false);
  assert.equal(second.candidate.occurrences, 3);
  assert.deepEqual(second.candidate.sourceMessageIds, ['m1', 'm2', 'm3']);
  ok('addCandidate 变体去重并累加 occurrences / 来源 id');
}

// 12. 种子候选：6 条，全部 pending，重复调用幂等
{
  const first = seedCandidates([]);
  assert.equal(first.added, 6);
  assert.equal(first.list.length, 6);
  assert.ok(first.list.every((c) => c.status === 'pending'));
  assert.ok(first.list.every((c) => c.source === 'seed'));
  assert.equal(first.list.find((c) => c.content === '飞舞')?.targetContent, '废物');
  const second = seedCandidates(first.list);
  assert.equal(second.added, 0);
  assert.equal(second.list.length, 6);
  ok('seedCandidates 写入 6 条待确认且幂等');
}

// 13. 候选键与归一化
{
  assert.equal(candidateKey('飞舞', '废物'), candidateKey(' 飞舞 ', '废物'));
  const c = normalizeCandidate({ content: '飞舞', target: '废物' });
  assert.equal(c.targetContent, '废物');
  assert.equal(c.pinyin, 'feiwu');
  assert.equal(c.status, 'pending');
  ok('normalizeCandidate / candidateKey');
}

console.log(`\n总计: ${passed} 项通过`);
