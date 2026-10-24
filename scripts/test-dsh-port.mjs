// DSH 端口发现回归：指纹判据、netstat 解析、扫描器（注入桩）、repoint 热切换。
import assert from 'node:assert/strict';
import { isDshWebResponse, parseNetstatListeners, createDshPortScanner } from '../src/dsh-port.js';
import { NodeApiClient } from '../src/dsh-client.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

test('指纹：401 挑战 / boot 图 / 标题 三种判据，负例不误判', () => {
  assert.deepEqual(
    isDshWebResponse({ ok: true, statusCode: 401, body: 'dsh web authentication required; reopen the URL printed by dsh web.' }),
    { isDsh: true, evidence: 'http-401-auth-challenge' }
  );
  assert.equal(isDshWebResponse({ ok: true, statusCode: 200, body: 'xx__DSH_BOOT__yy' }).isDsh, true);
  assert.equal(isDshWebResponse({ ok: true, statusCode: 200, contentType: 'text/html; charset=utf-8', body: '<html><title>DeepSeek Harness</title>' }).isDsh, true);
  // 负例：401 但正文不是 DSH（反向代理）、200 但标题不对、网络失败
  assert.equal(isDshWebResponse({ ok: true, statusCode: 401, body: 'unauthorized' }).isDsh, false);
  assert.equal(isDshWebResponse({ ok: true, statusCode: 200, contentType: 'text/html', body: '<title>dsh-pet</title>' }).isDsh, false);
  assert.equal(isDshWebResponse({ ok: false }).isDsh, false);
});

test('netstat 解析：只收回环 LISTENING、去重优先 127.0.0.1、低端口剔除', () => {
  const text = [
    '  TCP    127.0.0.1:11883        0.0.0.0:0              LISTENING       42100',
    '  TCP    0.0.0.0:11883          0.0.0.0:0              LISTENING       42100', // 同端口双绑：去重
    '  TCP    [::1]:3001             [::]:0                 LISTENING       220',
    '  TCP    [::]:3001              [::]:0                 LISTENING       220',
    '  TCP    127.0.0.1:445          0.0.0.0:0              LISTENING       4',   // 低端口剔除
    '  TCP    192.168.1.5:9999       0.0.0.0:0              LISTENING       777', // 非回环剔除
    '  TCP    127.0.0.1:55555        127.0.0.1:1234         ESTABLISHED     88',  // 非 LISTENING
    'garbage line'
  ].join('\r\n');
  const listeners = parseNetstatListeners(text);
  assert.deepEqual(listeners.map((l) => [l.port, l.probeHost, l.pid]), [
    [3001, '[::1]', 220],
    [11883, '127.0.0.1', 42100]
  ]);
  // 双绑去重后探 127.0.0.1 的优先级验证：3001 有 [::1]+[::] 但没有 127.0.0.1 → 取 [::1]
  assert.equal(parseNetstatListeners('  TCP    0.0.0.0:9100    0.0.0.0:0    LISTENING    5\n  TCP    127.0.0.1:9100   0.0.0.0:0   LISTENING   5')[0].probeHost, '127.0.0.1');
  assert.equal(parseNetstatListeners('  TCP    0.0.0.0:9100    0.0.0.0:0    LISTENING    5\n  TCP    [::]:9100       [::]:0      LISTENING   5')[0].probeHost, '127.0.0.1', '没有 127 绑定时回落 0.0.0.0 条目也按 127.0.0.1 探');
});

test('扫描器：hint 命中走捷径；全量扫描在噪音里找到 DSH；exclude 旧端口', async () => {
  const dshBody = 'dsh web authentication required; reopen the URL printed by dsh web.';
  const fetchImpl = async (url) => {
    if (url === 'http://127.0.0.1:11883/') {
      return { status: 401, headers: { get: (k) => (k === 'content-type' ? 'text/plain' : '') }, text: async () => dshBody };
    }
    if (url === 'http://127.0.0.1:20000/') {
      return { status: 200, headers: { get: () => 'text/html' }, text: async () => '<title>dsh-pet</title>' };
    }
    throw new Error('ECONNREFUSED');
  };
  const netstat = '  TCP    127.0.0.1:20000    0.0.0.0:0    LISTENING    9\n  TCP    127.0.0.1:11883    0.0.0.0:0    LISTENING    10\n';
  const execFile = (cmd, argv, opts, cb) => cb(null, netstat);
  const scanner = createDshPortScanner({ fetchImpl, execFile, concurrency: 2 });

  // 1) 单端口探测
  assert.equal((await scanner.probePort(11883)).isDsh, true);
  assert.equal((await scanner.probePort(20000)).isDsh, false);
  // 2) hint 命中：不跑 netstat
  const hint = await scanner.discover({ hintPorts: [11883] });
  assert.equal(hint.found, true);
  assert.equal(hint.baseUrl, 'http://127.0.0.1:11883');
  assert.equal(hint.scanned, 0, 'hint 命中不应触发全量扫描');
  // 3) 全量：两个候选里挑出 DSH
  const full = await scanner.discover({});
  assert.equal(full.found, true);
  assert.equal(full.port, 11883);
  assert.equal(full.scanned, 2);
  // 4) exclude 旧端口：排除后只剩非 DSH → not found
  const excluded = await scanner.discover({ excludePorts: [11883] });
  assert.equal(excluded.found, false);
  assert.equal(excluded.evidence, 'no-dsh-listener');
});

test('扫描器：netstat 失败 / 全部不可达 → found=false 不抛异常', async () => {
  const fetchImpl = async () => { throw new Error('down'); };
  const execFile = (cmd, argv, opts, cb) => cb(new Error('netstat broken'));
  const scanner = createDshPortScanner({ fetchImpl, execFile });
  const result = await scanner.discover({});
  assert.equal(result.found, false);
  assert.equal(result.evidence, 'netstat-failed');
  const execFileOk = (cmd, argv, opts, cb) => cb(null, '  TCP    127.0.0.1:24000    0.0.0.0:0    LISTENING    1\n');
  const scanner2 = createDshPortScanner({ fetchImpl, execFile: execFileOk });
  const result2 = await scanner2.discover({});
  assert.equal(result2.found, false);
  assert.equal(result2.evidence, 'no-dsh-listener');
});

test('NodeApiClient.repoint：换地址、清 cookie、保留 desiredFollows；同地址不动作', () => {
  const client = new NodeApiClient('http://127.0.0.1:11111', 500, {});
  client.cookie = 'stale-cookie';
  client._desiredFollows.add('session-x');
  assert.equal(client.repoint('http://127.0.0.1:22222/'), true);
  assert.equal(client.baseUrl, 'http://127.0.0.1:22222');
  assert.equal(client.cookie, null, '端口变了 cookie 签名必然失效，必须清掉重铸');
  assert.ok(client._desiredFollows.has('session-x'), 'follow 集合跨重连保留（DSH 重启后要重放）');
  assert.equal(client.repoint('http://127.0.0.1:22222'), false, '同地址不得重复动作');
  assert.equal(client.repoint(''), false, '空地址拒绝');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
