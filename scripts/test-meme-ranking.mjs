// 梗库注入排序回归：自学条目（ai）不被手工批量条目（manual）挤掉。
import assert from 'node:assert/strict';
import { buildMemeContext, memeScore } from '../src/meme-lib.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const now = Date.now();

test('score：来源权重 + 最近使用加成 + 使用次数', () => {
  assert.equal(memeScore({ source: 'ai' }, { now }), 2);
  assert.equal(memeScore({ source: 'manual' }, { now }), 1);
  assert.equal(memeScore({ source: 'ai', lastUsedAt: now - 1000 }, { now }), 5);
  assert.equal(memeScore({ source: 'manual', lastUsedAt: now - 10 * 86_400_000 }, { now }), 2);
  assert.equal(memeScore({ source: 'manual', usedCount: 3 }, { now }), 4);
  assert.equal(memeScore({ source: 'manual', usedCount: 99 }, { now }), 6);
  assert.equal(memeScore({ source: 'manual' }, { now, sourceWeight: { ai: 2, manual: 1 } }), 1);
});

test('12 条手工 + 3 条自学：注入 12 条里自学全部保留', () => {
  const manual = Array.from({ length: 12 }, (_, i) => ({
    text: `手${i}`,
    source: 'manual',
    meaning: '手工条目',
    createdAt: new Date(now - (12 - i) * 86_400_000).toISOString()
  }));
  const ai = [
    { text: '自学甲', source: 'ai', meaning: '自学', lastUsedAt: now - 1000, usedCount: 2 },
    { text: '自学乙', source: 'ai', meaning: '自学' },
    { text: '自学丙', source: 'ai', meaning: '自学' }
  ];
  const block = buildMemeContext([...manual, ...ai], 12);
  for (const text of ['自学甲', '自学乙', '自学丙']) {
    assert.ok(block.includes(text), `自学条目「${text}」必须被注入`);
  }
  const lineCount = block.split('\n').filter((line) => line.startsWith('- ')).length;
  assert.equal(lineCount, 12, '默认注入 12 条');
  assert.ok(!block.includes('手0'), '最旧的手工条目应被挤出');
});

test('不传 max 时默认 12 条', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({ text: `条${i}`, source: 'manual' }));
  const block = buildMemeContext(entries);
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 12);
});

test('空库返回空串', () => {
  assert.equal(buildMemeContext([]), '');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
