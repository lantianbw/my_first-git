import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, formatLine, redact } from '../src/obs/log-format.js';

// 固定输入时刻（秒对齐）：本模块不读 Date.now，时间一律由 at 传入。
const AT = Date.UTC(2026, 9, 27, 16, 10, 28, 0);
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})$/;

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'obs/log-format');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
});

test('基本格式：本地时间带时区 + [level] + [scope] + 正文', () => {
  const line = formatLine({ at: AT, level: 'info', scope: 'bridge', message: '发送成功' });

  const m = line.match(/^(\S+) \[info\] \[bridge\] 发送成功$/);
  assert.ok(m, `格式不符：${line}`);
  assert.match(m[1], STAMP, '时间戳必须是本地时间带 +/-HH:MM 偏移');
  // 带时区偏移 ⇒ 能精确还原到同一毫秒（换成 toISOString 的 UTC 也成立，但 hh:mm 会差 8 小时）
  assert.equal(Date.parse(m[1]), AT);
  assert.equal(new Date(m[1]).getHours(), new Date(AT).getHours(), '小时必须是本地小时');

  // level 大小写归一；缺省 info
  assert.match(formatLine({ at: AT, level: 'WARN', scope: 'x', message: 'm' }), /\[warn\] \[x\] m$/);
  assert.match(formatLine({ at: AT, message: 'm' }), /\[info\] m$/, '默认级别 info、无 scope 时不输出该段');

  // at 是必需项：缺了应立刻报错，而不是悄悄用系统时间
  assert.throws(() => formatLine({ message: 'm' }), /at 必须是毫秒时间戳/);
  assert.throws(() => formatLine({ at: 'now', message: 'm' }), TypeError);
});

test('换行：内部所有换行折成 ⏎，整行仍是单行', () => {
  const line = formatLine({ at: AT, level: 'warn', scope: 'bridge', message: '第一行\n第二行\r\n第三行' });

  assert.equal(line.includes('\n'), false, '不得留下真实换行');
  assert.equal(line.includes('\r'), false, '不得留下回车');
  assert.ok(line.endsWith('第一行⏎第二行⏎第三行'), line);
  assert.equal(line.match(/⏎/g).length, 2, '\\r\\n 只算一次换行');

  // meta 里的换行同样被折掉（JSON.stringify 本身会转义，这里兜底）
  const withMeta = formatLine({ at: AT, message: 'm', meta: { note: 'a\nb' } });
  assert.equal(withMeta.includes('\n'), false);
});

test('截断：正文超 1000 字截断并追加 …[截断]', () => {
  const line = formatLine({ at: AT, level: 'error', scope: 'bridge', message: 'x'.repeat(1500) });

  assert.ok(line.endsWith('…[截断]'), '必须有截断标记');
  assert.ok(line.includes('x'.repeat(1000) + '…[截断]'), '保留前 1000 字');
  assert.equal(line.includes('x'.repeat(1001)), false, '第 1001 个字必须被切掉');

  // 边界：正好 1000 字不截断，1001 字才截断
  assert.equal(formatLine({ at: AT, message: 'y'.repeat(1000) }).endsWith('…[截断]'), false);
  assert.equal(formatLine({ at: AT, message: 'y'.repeat(1001) }).endsWith('…[截断]'), true);

  // 前缀不计入预算：时间戳与级别始终完整
  const long = formatLine({ at: AT, level: 'info', scope: 'bridge', message: 'z'.repeat(1200) });
  assert.match(long, new RegExp(`^\\S+ \\[info\\] \\[bridge\\] z{1000}…\\[截断\\]$`));
});

test('meta：有值时以 JSON 追加在正文之后', () => {
  const line = formatLine({ at: AT, level: 'warn', scope: 'bridge', message: '失败', meta: { code: 'EPIPE', retry: 2 } });
  assert.ok(line.endsWith(' 失败 {"code":"EPIPE","retry":2}'), line);

  // 对象之外的类型也按 JSON 处理
  assert.ok(formatLine({ at: AT, message: 'm', meta: 0 }).endsWith(' m 0'));
  assert.ok(formatLine({ at: AT, message: 'm', meta: false }).endsWith(' m false'));

  // 无法序列化的 meta 不能把日志带崩
  const circular = {};
  circular.self = circular;
  assert.ok(formatLine({ at: AT, message: 'm', meta: circular }).endsWith(' m [meta 无法序列化]'));
});

test('空 meta：null / undefined / {} / [] / 空串都不追加', () => {
  const base = formatLine({ at: AT, level: 'info', scope: 'bridge', message: '只有正文' });

  for (const meta of [undefined, null, {}, [], '']) {
    const line = formatLine({ at: AT, level: 'info', scope: 'bridge', message: '只有正文', meta });
    assert.equal(line, base, `meta=${JSON.stringify(meta)} 不应追加任何内容`);
    assert.equal(line.endsWith(' '), false, '不能留下尾随空格');
  }

  // 只有 meta、没有 message 时也要能成立
  assert.ok(formatLine({ at: AT, message: '', meta: { a: 1 } }).endsWith('{"a":1}'));
});

test('脱敏路径：本机路径 / UNC / 家目录一律打码', () => {
  const win = redact('打开 E:\\DSH\\qq-bridge\\config.json 看看');
  assert.ok(win.includes('***'), win);
  assert.equal(win.includes('qq-bridge'), false, '路径主体必须被抹掉');

  assert.ok(redact('读一下 /home/ubuntu/.config/qq-bridge/state.json').includes('***'));
  assert.ok(redact('见 /Users/xing/secret.txt').includes('***'));
  assert.ok(redact('备份在 \\\\NAS\\share\\qq-bridge.rar').includes('***'));

  // 不像路径的不该被误伤（表情 md5、普通 URL）
  const md5 = '表情 md5=0123456789abcdef0123456789abcdef';
  assert.equal(redact(md5), md5);
  assert.equal(redact('https://example.com/a.png'), 'https://example.com/a.png');
});

test('脱敏令牌：token= 赋值与精确名单两种都要拦', () => {
  // 与 SENSITIVE_RE 的语义一致：凭据关键词必须带赋值关系
  const assign = redact('curl -H "x-agent-token: abc123def456"');
  assert.ok(assign.includes('***'), assign);
  assert.equal(assign.includes('abc123def456'), false);

  assert.ok(redact('password = hunter2hunter2').includes('***'));
  assert.ok(redact('密钥：sk-live-9f8e7d6c5b4a').includes('***'));

  // 裸 32-hex 令牌不匹配正则（表情 md5 同形），只能靠精确名单
  const bare = '会话令牌 0123456789abcdef0123456789abcdef 请勿外传';
  assert.equal(redact(bare).includes('0123456789abcdef0123456789abcdef'), true, '正则不该误伤裸 hex');
  const masked = redact(bare, ['0123456789abcdef0123456789abcdef']);
  assert.equal(masked.includes('0123456789abcdef0123456789abcdef'), false);
  assert.ok(masked.includes('***'));

  // 自定义正则 + 大小写不敏感 + 全局替换（调用方传的正则不带 g 也照样全替换）
  assert.equal(redact('AA bb AA', /aa/i), '*** bb ***');
  // 原正则不该被污染成有状态
  const g = /x/g;
  assert.equal(redact('x x x', g), '*** *** ***');
  assert.equal(redact('x x x', g), '*** *** ***');

  // 脱敏后的文本再进 formatLine，仍是单行
  const line = formatLine({ at: AT, message: redact('失败：E:\\DSH\\qq-bridge\\config.json') });
  assert.equal(line.includes('\n'), false);
  assert.ok(line.includes('***'));
});
