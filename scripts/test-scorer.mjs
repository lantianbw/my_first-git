// A3 评分器（规则版）单测：六维打分、硬门 veto、复读封顶、择优与静默分支。
// 判定口径对齐 _pad/QQ/05-拟人优化/a3-scorer.py（回放 262 条、拦 56 条的同一套规则）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { countChars, evaluate, formatVerdict, pickBest } from '../src/scorer.js';

test('L 长度：≤15 满分，16~25 六折，超长非 owner 两折', () => {
  assert.equal(evaluate('刚下课').dims.L, 1);
  assert.equal(evaluate('字'.repeat(16)).dims.L, 0.6);
  assert.equal(evaluate('字'.repeat(26)).dims.L, 0.2);
  assert.equal(evaluate('字'.repeat(26), { isOwner: true }).dims.L, 0.6, 'owner 汇报类放宽');
});

test('X 机制词：硬词表一票否决，owner 软词只降分', () => {
  const hard = evaluate('这条 prompt 又挂了');
  assert.equal(hard.dims.X, 0);
  assert.deepEqual(hard.veto, ['mech']);
  assert.equal(hard.pass, false, '硬门命中必须不合格');

  const soft = evaluate('这个版本还稳定', { isOwner: true });
  assert.equal(soft.dims.X, 0.6);
  assert.deepEqual(soft.veto, []);
});

test('D 贬损真人：只对真人一票否决，对 bot 不算', () => {
  const human = evaluate('闭嘴吧你', { targetIsHuman: true });
  assert.deepEqual(human.veto, ['insult']);
  assert.equal(human.pass, false);
  const bot = evaluate('闭嘴吧你', { targetIsHuman: false });
  assert.deepEqual(bot.veto, []);
});

test('M 复读：无使用记录不扣分，24h 用过 1 次六折，≥2 次归零并封顶 0.5', () => {
  assert.equal(evaluate('罐头不过期').dims.M, 1, '账本里没记录过 = 没复读');
  const once = evaluate('罐头不过期', { memeUsed24h: { 罐头: 1 } });
  assert.equal(once.dims.M, 0.6);
  const twice = evaluate('罐头不过期', { memeUsed24h: { 罐头: 2 } });
  assert.equal(twice.dims.M, 0);
  assert.ok(twice.total <= 0.5, '非 owner 复读要封顶到发送线以下');
  const ownerTwice = evaluate('罐头不过期', { memeUsed24h: { 罐头: 2 }, isOwner: true });
  assert.ok(ownerTwice.total > 0.5, 'owner 不封顶');
});

test('B 缠斗：4~5 轮三折，≥6 轮归零', () => {
  assert.equal(evaluate('在', { botRounds: 3 }).dims.B, 1);
  assert.equal(evaluate('在', { botRounds: 4 }).dims.B, 0.3);
  assert.equal(evaluate('在', { botRounds: 6 }).dims.B, 0);
});

test('R 答到被问的事：问句时按应答词/2-gram 判定，非问句不适用', () => {
  const q = { text: '你几点下课？' };
  assert.equal(evaluate('六点下课', { questionMsg: q }).dims.R, 1, '2-gram（下课）重叠算答到');
  assert.equal(evaluate('六点', { questionMsg: q }).dims.R, 0, '只答时间、无 2-gram 重叠且不是应答词开头');
  assert.equal(evaluate('月亮真圆', { questionMsg: q }).dims.R, 0);
  assert.equal(evaluate('月亮真圆', { questionMsg: { text: '今天风大' } }).dims.R, 1, '不是问句 → 不适用');
});

test('总分为六维加权，且 pass 同时要求达线与无 veto', () => {
  const v = evaluate('刚下课，累死了');
  const expected = v.dims.L * 0.25 + v.dims.R * 0.25 + v.dims.M * 0.15 + v.dims.B * 0.15 + v.dims.X * 0.1 + v.dims.D * 0.1;
  assert.equal(v.total, Number(expected.toFixed(3)));
  assert.equal(v.pass, true);
});

test('择优：跳过占位与空白，分数接近时随机；全不合格则 silent', () => {
  const candidates = ['[图片]', '  ', '刚下课，累死了'];
  const picked = pickBest(candidates);
  assert.equal(picked.action, 'send');
  assert.equal(picked.best.text, '刚下课，累死了');

  const blocked = pickBest(['这条 prompt 又挂了', '闭嘴吧你'], { targetIsHuman: true });
  assert.equal(blocked.action, 'silent');
  assert.equal(blocked.best, null);
});

test('字数口径：占位标记算 1 字、空白不计（与 A2 一致）', () => {
  assert.equal(countChars('[表情包 猫猫]'), 1);
  assert.equal(countChars(' 刚 下 课 '), 3);
});

test('formatVerdict 输出可 grep 的一行', () => {
  const line = formatVerdict(evaluate('刚下课'));
  assert.match(line, /^total=1 pass=1 L1 R1 M1 B1 X1 D1$/);
});
