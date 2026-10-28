// C6 离线验收：好友申请处理（白名单匹配 / allow.private 落盘 / owner 通知文案）。
// 不连 QQ、不发网络请求：只验证纯函数与 config 写盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import {
  normalizeFriendWhitelist,
  findFriendWhitelistEntry,
  persistAllowPrivate,
  cleanRequestComment,
  buildFriendRequestNotice
} from '../src/friend-request.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL  ${name}\n      ${error?.message ?? error}`); }
}

// ── 1. 预设名单规范化 ──────────────────────────────────────────────────────
check('名单：对象/数字/字符串三种写法都能认', () => {
  const list = normalizeFriendWhitelist([
    { qq: 2453753245, name: '風花雪月' },
    2966799271,
    '123456'
  ]);
  assert.deepStrictEqual(list, [
    { qq: '2453753245', name: '風花雪月' },
    { qq: '2966799271', name: '' },
    { qq: '123456', name: '' }
  ]);
});
check('名单：非法值与非数组直接丢弃', () => {
  assert.deepStrictEqual(normalizeFriendWhitelist(null), []);
  assert.deepStrictEqual(normalizeFriendWhitelist([{ qq: 'abc' }, '', {}, null]), []);
});
check('名单：重复 QQ 去重', () => {
  const list = normalizeFriendWhitelist([{ qq: '2453753245' }, { qq: 2453753245, name: 'dup' }]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '');
});
check('名单：命中風花雪月 2453753245', () => {
  const list = normalizeFriendWhitelist([{ qq: 2453753245, name: '風花雪月' }]);
  const hit = findFriendWhitelistEntry(list, '2453753245');
  assert.ok(hit);
  assert.strictEqual(hit.name, '風花雪月');
});
check('名单：数字/字符串 QQ 混用也能命中', () => {
  const list = normalizeFriendWhitelist([{ qq: '2453753245', name: '風花雪月' }]);
  assert.ok(findFriendWhitelistEntry(list, 2453753245));
});
check('名单：名单外返回 null', () => {
  const list = normalizeFriendWhitelist([{ qq: 2453753245, name: '風花雪月' }]);
  assert.strictEqual(findFriendWhitelistEntry(list, '999999'), null);
  assert.strictEqual(findFriendWhitelistEntry(list, 'not-a-qq'), null);
});

// ── 2. 写 allow.private ────────────────────────────────────────────────────
function makeCfgFile(content, { bom = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-friend-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + content, 'utf8');
  return file;
}
const baseCfg = {
  ownerQQ: 1843979560,
  allow: { private: [1843979560, 2966799271], groups: [1057896469] },
  social: { enabled: true }
};

check('落盘：命中后 QQ 补进 allow.private，其余字段原样', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n');
  const r = persistAllowPrivate(file, '2453753245');
  assert.strictEqual(r.updated, true);
  assert.strictEqual(r.added, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved.allow.private, [1843979560, 2966799271, 2453753245]);
  assert.deepStrictEqual(saved.allow.groups, [1057896469]);
  assert.strictEqual(saved.ownerQQ, 1843979560);
  assert.deepStrictEqual(saved.social, { enabled: true });
});
check('落盘：已存在时不重复写（幂等）', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n');
  persistAllowPrivate(file, '2453753245');
  const before = fs.statSync(file).mtimeMs;
  const r2 = persistAllowPrivate(file, 2453753245);
  assert.strictEqual(r2.updated, false);
  assert.strictEqual(r2.added, false);
  assert.strictEqual(fs.statSync(file).mtimeMs, before);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allow.private,
    [1843979560, 2966799271, 2453753245]);
});
check('落盘：保留 UTF-8 BOM 与两空格缩进', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n', { bom: true });
  persistAllowPrivate(file, '2453753245');
  const raw = fs.readFileSync(file, 'utf8');
  assert.strictEqual(raw.charCodeAt(0), 0xFEFF);
  assert.ok(raw.includes('\n  "ownerQQ"'));
});
check('落盘：allow 缺失时自动补齐', () => {
  const file = makeCfgFile(JSON.stringify({ ownerQQ: 1 }, null, 2) + '\n');
  const r = persistAllowPrivate(file, '2453753245');
  assert.strictEqual(r.added, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allow.private, [2453753245]);
});
check('落盘：非法 QQ 直接抛错，文件不动', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => persistAllowPrivate(file, 'abc'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

// ── 3. owner 通知文案 ─────────────────────────────────────────────────────
check('通知：名单内通过文案', () => {
  assert.strictEqual(
    buildFriendRequestNotice({ approved: true, qq: '2453753245', name: '風花雪月' }),
    '風花雪月（2453753245）加我好友，已通过'
  );
});
check('通知：名单外只提示未自动通过（带验证消息）', () => {
  assert.strictEqual(
    buildFriendRequestNotice({ qq: '999999', comment: '你好\n我是群友' }),
    '999999 加我好友（验证消息：你好 我是群友），不在预设名单，未自动通过'
  );
});
check('通知：名单外无验证消息', () => {
  assert.strictEqual(
    buildFriendRequestNotice({ qq: '999999' }),
    '999999 加我好友，不在预设名单，未自动通过'
  );
});
check('通知：同意失败时带原因', () => {
  assert.strictEqual(
    buildFriendRequestNotice({ qq: '2453753245', name: '風花雪月', error: 'API 超时' }),
    '風花雪月（2453753245）加我好友，自动通过失败：API 超时'
  );
});
check('验证消息：压成一行且截断', () => {
  assert.strictEqual(cleanRequestComment('  a\n\n b  '), 'a b');
  assert.strictEqual(cleanRequestComment('x'.repeat(80)).endsWith('…'), true);
  assert.strictEqual(cleanRequestComment('x'.repeat(80)).length, 61);
});

// ── 4. 端到端：事件 → 判定 → 落盘 / 不落盘 ─────────────────────────────────
check('流程：名单内事件会落盘并生成已通过文案', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n');
  const whitelist = normalizeFriendWhitelist([{ qq: 2453753245, name: '風花雪月' }]);
  const event = { post_type: 'request', request_type: 'friend', user_id: 2453753245, flag: 'flag-1', comment: '加一下' };
  const entry = findFriendWhitelistEntry(whitelist, event.user_id);
  assert.ok(entry);
  persistAllowPrivate(file, event.user_id);
  assert.strictEqual(buildFriendRequestNotice({ approved: true, qq: event.user_id, name: entry.name }),
    '風花雪月（2453753245）加我好友，已通过');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).allow.private.includes(2453753245));
});
check('流程：名单外事件不落盘，只出通知', () => {
  const file = makeCfgFile(JSON.stringify(baseCfg, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  const whitelist = normalizeFriendWhitelist([{ qq: 2453753245, name: '風花雪月' }]);
  const event = { post_type: 'request', request_type: 'friend', user_id: 777777, flag: 'flag-2' };
  const entry = findFriendWhitelistEntry(whitelist, event.user_id);
  assert.strictEqual(entry, null);
  assert.strictEqual(buildFriendRequestNotice({ qq: event.user_id }),
    '777777 加我好友，不在预设名单，未自动通过');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

console.log(`\nC6 好友申请验收：${pass} pass / ${fail} fail —— ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
