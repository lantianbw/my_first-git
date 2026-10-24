// 谐音候选管理接口回归：
// A. 纯逻辑（list / confirm / reject）
// B. HTTP 契约（401 缺令牌 / 403 Host 不对 / 200 正常，语义与桥接控制台一致）
//
// B 用一个本地临时 server 复刻桥接的鉴权顺序（Host 白名单 → x-console-token），
// 路由直接调用生产模块 slang-admin.js，避免为了测试去拉起整个桥接。

import assert from 'node:assert/strict';
import http from 'node:http';
import { listCandidates, confirmCandidate, rejectCandidate } from '../src/slang-admin.js';
import { normalizeSlangEntry, buildSlangContext, SLANG_STATUS } from '../src/slang-learner.js';
import { normalizeCandidate } from '../src/slang-candidates.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

function makeCandidate(text, target, extra = {}) {
  return normalizeCandidate({
    content: text,
    targetContent: target,
    meaning: extra.meaning ?? '',
    occurrences: extra.occurrences ?? 2,
    sourceMessageIds: extra.ids ?? ['m1'],
    status: 'pending',
    source: 'auto',
  });
}

// ── A1. 列表形状 ───────────────────────────────────────────────────────────
{
  const list = [makeCandidate('飞舞', '废物', { occurrences: 3, ids: ['m9', 'm10'] })];
  const view = listCandidates(list, { limit: 50 });
  assert.equal(view.total, 1);
  assert.deepEqual(Object.keys(view.candidates[0]).sort(), [
    'count', 'firstSeen', 'pinyin', 'sampleMessageId', 'suggestedFrom', 'text',
  ].sort());
  assert.equal(view.candidates[0].text, '飞舞');
  assert.equal(view.candidates[0].suggestedFrom, '废物');
  assert.equal(view.candidates[0].pinyin, 'feiwu');
  assert.equal(view.candidates[0].count, 3);
  assert.equal(view.candidates[0].sampleMessageId, 'm9');
  ok('listCandidates 输出约定字段');
}

// ── A2. 确认：写 confirmed、补 pinyin / homophoneOf、删候选 ────────────────
{
  let candidates = [makeCandidate('飞舞', '废物', { meaning: '' })];
  let slangEntries = [];
  const result = confirmCandidate({
    slangEntries, candidates, text: '飞舞', realText: '废物', meaning: '废物；没用、菜',
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(result.candidates.length, 0);
  const entry = result.slangEntries.find((e) => e.content === '飞舞');
  assert.ok(entry, '应写入 slang 词条');
  assert.equal(entry.status, SLANG_STATUS.CONFIRMED);
  assert.equal(entry.homophoneOf, '废物');
  assert.equal(entry.pinyin, 'feiwu');
  assert.deepEqual(entry.variants, []);
  assert.match(buildSlangContext(result.slangEntries, 8), /飞舞=废物（同音）/);
  ok('confirmCandidate 写库 + 删候选 + 对照表生效');
}

// ── A3. 只给 text：用候选自带的 suggestedFrom 兜底 ────────────────────────
{
  const result = confirmCandidate({
    slangEntries: [], candidates: [makeCandidate('难绷', '难受得绷不住', { meaning: '' })], text: '难绷',
  });
  assert.equal(result.ok, true);
  const entry = result.slangEntries.find((e) => e.content === '难绷');
  assert.equal(entry.homophoneOf, '难受得绷不住');
  assert.match(entry.meaning, /难受得绷不住/);
  ok('confirmCandidate 仅 text 时用候选 suggestedFrom 兜底');
  const empty = confirmCandidate({ slangEntries: [], candidates: [], text: '' });
  assert.equal(empty.ok, false);
  ok('confirmCandidate 缺 text 时拒绝');
}

// ── A4. 拒绝：删除候选 ────────────────────────────────────────────────────
{
  const result = rejectCandidate({ candidates: [makeCandidate('唐', '装唐')], text: '唐' });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(result.candidates.length, 0);
  const missing = rejectCandidate({ candidates: [], text: '唐' });
  assert.equal(missing.ok, false);
  ok('rejectCandidate 删除候选，重复拒绝返回不存在');
}

// ── B. HTTP 契约 ──────────────────────────────────────────────────────────
const TOKEN = 'test-console-token-0123456789';
let candidates = [
  makeCandidate('飞舞', '废物', { occurrences: 3, ids: ['m1', 'm2'] }),
  makeCandidate('蚌埠住了', '绷不住了', { occurrences: 2, ids: ['m3'] }),
];
let slangEntries = [
  normalizeSlangEntry({ content: '绷不住了', meaning: '忍不住', status: SLANG_STATUS.CONFIRMED }),
];

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const port = server.address().port;
  const host = String(req.headers.host ?? '').toLowerCase();
  // 与桥接一致：Host 只允许回环，且必须在令牌校验之前。
  if (host !== `127.0.0.1:${port}`) { send(403, { ok: false, error: 'Host 头不被允许' }); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const supplied = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
  if (supplied !== TOKEN) { send(401, { ok: false, error: '未授权：请提供控制台访问令牌' }); return; }
  const readBody = () => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
  if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/candidates') {
    send(200, { ok: true, ...listCandidates(candidates, { limit: Number(url.searchParams.get('limit')) || 50 }) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/candidates/confirm') {
    const body = await readBody();
    const result = confirmCandidate({ slangEntries, candidates, ...body });
    if (!result.ok) { send(400, { ok: false, error: result.error }); return; }
    slangEntries = result.slangEntries;
    candidates = result.candidates;
    send(200, { ok: true, entry: result.entry, removed: result.removed });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/candidates/reject') {
    const body = await readBody();
    const result = rejectCandidate({ candidates, ...body });
    if (!result.ok) { send(404, { ok: false, error: result.error }); return; }
    candidates = result.candidates;
    send(200, { ok: true, removed: result.removed });
    return;
  }
  send(404, { ok: false, error: 'not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function rawRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// B1. 无令牌 → 401
{
  const r = await rawRequest('/api/socialV2/slang/candidates');
  assert.equal(r.status, 401);
  ok('GET candidates 无令牌 → 401');
}

// B2. Host 不对 → 403（带正确令牌也一样）
{
  const r = await rawRequest('/api/socialV2/slang/candidates', {
    headers: { Host: 'evil.example:80', 'x-console-token': TOKEN },
  });
  assert.equal(r.status, 403);
  ok('GET candidates Host 非回环 → 403');
}

// B3. 正常 GET → 200 + 约定字段
{
  const r = await rawRequest('/api/socialV2/slang/candidates?limit=50', { headers: { 'x-console-token': TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.total, 2);
  assert.equal(r.json.candidates[0].text, '飞舞');
  assert.equal(r.json.candidates[0].suggestedFrom, '废物');
  ok('GET candidates 带令牌 → 200');
}

// B4. 确认 → 200，写库并删候选
{
  const r = await rawRequest('/api/socialV2/slang/candidates/confirm', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: { text: '飞舞', realText: '废物', meaning: '废物；没用、菜' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 1);
  assert.equal(candidates.some((c) => c.content === '飞舞'), false);
  const entry = slangEntries.find((e) => e.content === '飞舞');
  assert.equal(entry.status, SLANG_STATUS.CONFIRMED);
  assert.equal(entry.homophoneOf, '废物');
  assert.match(buildSlangContext(slangEntries, 8), /飞舞=废物（同音）/);
  ok('POST confirm → 200 且写库/删候选');
}

// B5. 拒绝 → 200
{
  const r = await rawRequest('/api/socialV2/slang/candidates/reject', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: { text: '蚌埠住了' },
  });
  assert.equal(r.status, 200);
  assert.equal(candidates.length, 0);
  ok('POST reject → 200 且删候选');
}

// B6. 确认缺 text → 400
{
  const r = await rawRequest('/api/socialV2/slang/candidates/confirm', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: {},
  });
  assert.equal(r.status, 400);
  ok('POST confirm 缺 text → 400');
}

server.close();
console.log(`\n总计: ${passed} 项通过`);
