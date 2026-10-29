// 钉住 M1「可疑群文件」判定（docs/module-ownership.md M1 / 交接文档 §6-2）。
//
// 回归样本是 2026-10-29 15:22 那条 `PC电脑资源大合集打开即可下载 .txt`：桥接当时看着文件名接了话。
// 这里断言的是「这类文件名以后不再进模型」，以及「普通文档/图片、以及聊天里随口提到网盘，不受影响」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  spec,
  assessFileRisk,
  DEFAULT_SUSPICIOUS_FILE_KEYWORDS,
  handle
} from '../src/inbound/file-risk.js';

/** 线上 file 段的形状（segments.js 里 `[文件${d.name}]` 就是从 `data.name` 取的）。 */
const fileSeg = (name) => ({ type: 'file', data: { name } });

/** 断言命中，并把结果打出来（比 assert.ok 更好定位是哪个词没命中）。 */
function assertSuspicious(result, keyword) {
  assert.equal(result.suspicious, true, `期望命中，实际 ${JSON.stringify(result)}`);
  assert.ok(result.hits.includes(keyword), `期望 hits 含「${keyword}」，实际 ${JSON.stringify(result.hits)}`);
}

test('spec：契约字段齐备且已冻结（deps 空 / owner 可关）', () => {
  assert.equal(spec.name, 'inbound/file-risk');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
  assert.ok(Object.isFrozen(DEFAULT_SUSPICIOUS_FILE_KEYWORDS));
});

test('回归样本：PC电脑资源大合集打开即可下载 .txt → 命中 3 个词', () => {
  const result = assessFileRisk({
    segments: [fileSeg('PC电脑资源大合集打开即可下载 .txt')],
    text: '[文件PC电脑资源大合集打开即可下载 .txt]'
  });
  assert.equal(result.suspicious, true);
  // 文件名写的是「资源大合集」——字面「资源合集」匹配不到，内置表单列了这个变体
  assert.deepEqual(result.hits, ['资源大合集', '下载', '打开即可']);
  // 段与文本标记是同一个文件：names 只留一份，不重复记
  assert.deepEqual(result.names, ['PC电脑资源大合集打开即可下载 .txt']);
  assert.match(result.reason, /资源大合集/);
  assert.match(result.reason, /PC电脑资源大合集/);
});

test('词表逐条命中（口径：任一即可疑，允许单条变体）', () => {
  const cases = [
    ['资源合集', '2026 资源合集.docx'],
    ['资源大合集', '资源大合集.zip'],
    ['下载', '客户端下载.zip'],
    ['解压密码', '解压密码在简介.txt'],
    ['打开即可', '打开即可以及说明.pdf'],
    ['网盘', '网盘链接.txt']
  ];
  for (const [keyword, name] of cases) {
    assertSuspicious(assessFileRisk({ segments: [fileSeg(name)] }), keyword);
  }
});

test('普通群文件不受影响：文档 / 图片 / 表格一律不命中', () => {
  for (const name of ['会议纪要.docx', '合影 2026-10-29.jpg', '十月报价单.xlsx', '需求评审.pdf', '']) {
    const result = assessFileRisk({ segments: [fileSeg(name)], text: `[文件${name}]` });
    assert.equal(result.suspicious, false, `不该命中：${name}（${JSON.stringify(result)}）`);
    assert.deepEqual(result.hits, []);
    assert.equal(result.reason, '');
  }
});

test('只在群友聊天里提「网盘 / 资源合集」不算命中（这条规则只管文件）', () => {
  const result = assessFileRisk({ segments: [], text: '有人有网盘资源吗，资源合集发我一份' });
  assert.equal(result.suspicious, false);
  assert.deepEqual(result.names, []);
});

test('文本回退：网关把 file 段拍平成字符串时，靠 [文件…] 标记仍能命中', () => {
  const result = assessFileRisk({ text: '看这个[文件解压密码1234.rar]' });
  assertSuspicious(result, '解压密码');
  assert.deepEqual(result.names, ['解压密码1234.rar']);
});

test('拆字变体：全角、空格分隔、零宽字符都要能命中', () => {
  for (const name of ['资 源 合 集.txt', '资\u200b源合集.txt', 'ＷＯＲＤ下载.txt']) {
    assertSuspicious(assessFileRisk({ segments: [fileSeg(name)] }), name.includes('下载') ? '下载' : '资源合集');
  }
});

test('入参畸形不抛：null / 非数组 / 空 data / 取值器爆炸一律按无命中（fail-open）', () => {
  assert.equal(assessFileRisk().suspicious, false);
  assert.equal(assessFileRisk(null).suspicious, false);
  assert.equal(assessFileRisk({ segments: 'not-an-array', text: 12345 }).suspicious, false);
  assert.equal(assessFileRisk({ segments: [null, 42, { type: 'file' }, { type: 'file', data: null }] }).suspicious, false);
  const exploding = { type: 'file', get data() { throw new Error('boom'); } };
  const result = assessFileRisk({ segments: [exploding, fileSeg('网盘直链.txt')] });
  assertSuspicious(result, '网盘'); // 一段坏掉不影响另一段
  assert.equal(assessFileRisk({ segments: [], text: '[文件]' }).suspicious, false);
});

test('词表：非空数组整表覆盖；空数组 / 非数组回退内置表', () => {
  const custom = assessFileRisk({ segments: [fileSeg('内部资料.zip')], keywords: ['内部资料'] });
  assertSuspicious(custom, '内部资料');
  // 覆盖后内置词不再生效
  assert.equal(assessFileRisk({ segments: [fileSeg('网盘.txt')], keywords: ['内部资料'] }).suspicious, false);
  // 空数组 = 用内置表（与 config 里 `words: []` 的既有语义一致）
  assertSuspicious(assessFileRisk({ segments: [fileSeg('网盘.txt')], keywords: [] }), '网盘');
  assertSuspicious(assessFileRisk({ segments: [fileSeg('网盘.txt')], keywords: 'bad' }), '网盘');
});

test('handle：契约形状 { ok, value }，未知 action 返回 INVALID_ARGS', () => {
  const okResult = handle({}, { segments: [fileSeg('资源合集.rar')] });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.value.suspicious, true);

  const bad = handle({}, { action: 'delete' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  assert.match(bad.error, /assess/);
});

test('接线：bridge.js 只有一处调用，且在消息入库之前（否则文件名还是会进上下文）', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const calls = source.match(/assessFileRisk\(/g) ?? [];
  assert.equal(calls.length, 1, '入站文件判定只允许在 handleIncoming 里挂一处');
  assert.match(source, /\[guard\] suspicious-file/, '命中要写一条可 grep 的 activity');

  const riskAt = source.indexOf('assessFileRisk(');
  // 用调用点独有的实参（messageRef 只出现在 reserved2 的入库调用里）避开函数定义本身
  const ingestAt = source.indexOf('appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageRef');
  assert.ok(ingestAt > 0, '找不到 reserved2 的入库调用，这条接线检查需要按新代码更新');
  assert.ok(riskAt < ingestAt, '判定必须在入库之前，否则文件名仍会进模型上下文');
});
