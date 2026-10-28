import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, parseCommand } from '../src/inbound/command.js';

test('/role：命中规范名，spec 契约为 owner 级', () => {
  assert.equal(spec.name, 'inbound/command');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(parseCommand('/role'), { isCommand: true, cmd: 'role', args: [] });
});

test('/silent：命中（/quiet 为等价别名）', () => {
  assert.deepEqual(parseCommand('/silent'), { isCommand: true, cmd: 'silent', args: [] });
  assert.deepEqual(parseCommand('/quiet'), { isCommand: true, cmd: 'silent', args: [] });
});

test('/active：命中（/speak 为等价别名）', () => {
  assert.deepEqual(parseCommand('/active'), { isCommand: true, cmd: 'active', args: [] });
  assert.deepEqual(parseCommand('/speak'), { isCommand: true, cmd: 'active', args: [] });
});

test('/reset：命中（/new 为等价别名）', () => {
  assert.deepEqual(parseCommand('/reset'), { isCommand: true, cmd: 'reset', args: [] });
  assert.deepEqual(parseCommand('/new'), { isCommand: true, cmd: 'reset', args: [] });
});

test('/status：命中，且不接受参数语义差别的干扰', () => {
  assert.deepEqual(parseCommand('/status'), { isCommand: true, cmd: 'status', args: [] });
  assert.deepEqual(parseCommand('/status   '), { isCommand: true, cmd: 'status', args: [] });
});

test('非命令：不以 / 开头的一律 isCommand:false', () => {
  assert.deepEqual(parseCommand('今天天气不错'), { isCommand: false });
  assert.deepEqual(parseCommand('hello /role'), { isCommand: false });
  assert.deepEqual(parseCommand(' /role'), { isCommand: false });
  assert.deepEqual(parseCommand('「/role」'), { isCommand: false });
  assert.deepEqual(parseCommand('你发 /reset 干嘛'), { isCommand: false });
});

test('带参数：多余参数原样保留、顺序不变', () => {
  assert.deepEqual(parseCommand('/role 学姐 副社长'), {
    isCommand: true,
    cmd: 'role',
    args: ['学姐', '副社长']
  });
  assert.deepEqual(parseCommand('/role   学姐   副社长  '), {
    isCommand: true,
    cmd: 'role',
    args: ['学姐', '副社长']
  });
  assert.deepEqual(parseCommand('/status 看看'), { isCommand: true, cmd: 'status', args: ['看看'] });
  // 参数里的斜杠不当成新命令
  assert.deepEqual(parseCommand('/role off'), { isCommand: true, cmd: 'role', args: ['off'] });
  assert.deepEqual(parseCommand('/role 角色/别名'), { isCommand: true, cmd: 'role', args: ['角色/别名'] });
});

test('未知命令：大小写敏感、不做前缀匹配', () => {
  const unknown = parseCommand('/model');
  assert.equal(unknown.isCommand, true);
  assert.equal(unknown.cmd, 'model');
  assert.match(unknown.error, /未知命令/);

  // 大小写敏感
  const upper = parseCommand('/ROLE');
  assert.equal(upper.isCommand, true);
  assert.equal(upper.error, '未知命令：/ROLE');

  // 不做前缀/模糊匹配
  assert.match(parseCommand('/rol').error, /未知命令/);
  assert.match(parseCommand('/roles').error, /未知命令/);
});

test('空字符串与只有斜杠：不当作可用命令', () => {
  assert.deepEqual(parseCommand(''), { isCommand: false });
  assert.deepEqual(parseCommand('   '), { isCommand: false });
  assert.deepEqual(parseCommand(null), { isCommand: false });
  assert.deepEqual(parseCommand(undefined), { isCommand: false });

  assert.deepEqual(parseCommand('/'), { isCommand: true, cmd: '', args: [], error: '缺少命令名' });
  assert.deepEqual(parseCommand('/   role'), { isCommand: true, cmd: '', args: ['role'], error: '缺少命令名' });
});
