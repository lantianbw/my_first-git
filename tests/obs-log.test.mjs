// tests/obs-log.test.mjs — obs/log 单测（纯函数 + 受注入的追加写）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spec, LOG_LINE_MAX, localClock, formatLine, createCappedLogger, handle } from '../src/obs/log.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obs-log-'));

test('契约：spec 冻结、名字与路径一致、locked', () => {
  assert.equal(spec.name, 'obs/log');
  assert.ok(Object.isFrozen(spec));
  assert.equal(spec.toggle.level, 'locked');
  assert.equal(spec.toggle.hot, true);
});

test('localClock：两位补零，且是本地时间', () => {
  const at = new Date(2026, 9, 28, 3, 4, 5).getTime();
  assert.equal(localClock(at), '03:04:05');
});

test('formatLine：多参数用单空格拼接，带标签与时间', () => {
  const at = new Date(2026, 9, 28, 22, 17, 54).getTime();
  const line = formatLine(['桥接已启动', { a: 1 }], { at });
  assert.equal(line, '22:17:54 [bridge] 桥接已启动 {"a":1}');
});

test('formatLine：CR/LF 折叠成空格，一条日志只占一行', () => {
  const at = 0;
  const line = formatLine(['a\r\nb\nc'], { at });
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /a b c$/);
});

test('formatLine：超过上限截断并加标记（不截断时无标记）', () => {
  const at = 0;
  const long = 'x'.repeat(LOG_LINE_MAX + 50);
  const clipped = formatLine([long], { at });
  assert.ok(clipped.endsWith('…[截断]'));
  // 前缀 = 时间 + 标签 + 空格
  assert.equal(clipped.length, 8 + ' [bridge] '.length + LOG_LINE_MAX + '…[截断]'.length);
  assert.ok(!formatLine(['short'], { at }).includes('[截断]'));
});

test('formatLine：参数无法序列化时返回占位，不抛', () => {
  const at = 0;
  const circular = {};
  circular.self = circular;
  const line = formatLine([circular], { at });
  assert.match(line, /日志参数无法序列化/);
});

test('formatLine：redact 由中枢注入，逐参数生效', () => {
  const at = 0;
  const redact = (s) => s.replace(/secret/g, '***');
  const line = formatLine(['token=secret'], { at, redact });
  assert.match(line, /token=\*\*\*/);
  assert.ok(!line.includes('secret'));
});

test('formatLine：自定义 tag 与 max', () => {
  const line = formatLine(['abcdef'], { at: 0, tag: 'audit', max: 3 });
  assert.equal(line, `${localClock(0)} [audit] abc…[截断]`);
});

test('createCappedLogger：父目录不存在时自动创建并追加', () => {
  const dir = tmp();
  const file = path.join(dir, 'deep', 'nested', 'bridge.log');
  const append = createCappedLogger(file, 10);
  append('line1\n');
  append('line2\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nline2\n');
});

test('createCappedLogger：超过上限时轮转到 .1，新文件由下一次写建立', () => {
  const dir = tmp();
  const file = path.join(dir, 'bridge.log');
  const append = createCappedLogger(file, 2);
  append('a\n');
  append('b\n');
  append('c\n'); // 第 3 行触发轮转：当前文件整体改名为 .1
  assert.ok(fs.existsSync(`${file}.1`));
  // 旧实现的语义：改名成功后不立刻建空文件，下一次 append 才建（这里必须保持一致）
  assert.equal(fs.existsSync(file), false);
  append('d\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'd\n');
  // 计数已从 0 重新开始：再写两行才再次触发
  append('e\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'd\ne\n');
});

test('createCappedLogger：已有文件时续算行数，不从头计', () => {
  const dir = tmp();
  const file = path.join(dir, 'bridge.log');
  fs.writeFileSync(file, 'a\nb\n', 'utf8');
  const append = createCappedLogger(file, 2);
  append('c\n'); // 已有 2 行，加这行超限 → 轮转
  assert.ok(fs.existsSync(`${file}.1`));
});

test('createCappedLogger：写失败不抛（父路径是文件）', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const append = createCappedLogger(path.join(blocker, 'bridge.log'), 10);
  assert.doesNotThrow(() => append('x\n'));
});

test('handle：format / clock 正常，未知 action 拒绝', () => {
  const ctx = { now: () => 0 };
  const formatted = handle(ctx, { action: 'format', args: ['hi'] });
  assert.equal(formatted.ok, true);
  // 时间戳 0 的本地时间不是 00:00:00（东八区是 08:00:00），用同一函数算期望值
  assert.equal(formatted.value, `${localClock(0)} [bridge] hi`);

  const clock = handle(ctx, { action: 'clock' });
  assert.equal(clock.value, localClock(0));

  const bad = handle(ctx, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
});
