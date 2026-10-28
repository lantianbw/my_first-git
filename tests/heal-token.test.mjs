import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, createTokenHeal } from '../src/heal/token.js';

// ── 夹具：全部内存实现，不碰 fs / 网络 / 真时钟 ───────────────────────────────
// 这个模块的价值全在「出错了怎么办」上（写盘失败、上游 401、令牌为空、close 连发），
// 所以夹具的重点是**能精确计数与注入故障**，而不是模拟真实 SnowLuma。

/** 中枢配置：只带本模块会碰的那几个字段。 */
function makeCfg(over = {}) {
  return { snowluma: { accessToken: 'http-old-123456', wsUrl: 'ws://127.0.0.1:3001', ...over } };
}

/** SDK 客户端替身：只记 close / connect，不真的建连。 */
function makeBot({ accessToken = null, url = 'ws://127.0.0.1:3001' } = {}) {
  const calls = { close: [], connect: 0 };
  const bot = {
    accessToken,
    url,
    close(code, reason) { calls.close.push([code, reason]); },
    connect() { calls.connect += 1; return Promise.resolve(); }
  };
  return { bot, calls };
}

/** 日志替身：攒成数组，方便断言「记了什么」与「没记什么」。 */
function makeLog() {
  const lines = [];
  const log = (message) => { lines.push(String(message)); };
  log.lines = lines;
  log.has = (needle) => lines.some((line) => line.includes(needle));
  log.count = (needle) => lines.filter((line) => line.includes(needle)).length;
  return log;
}

/** 内存版 config.json：语义与 snowluma-conn 的 persistToken / persistSnowLumaEndpoint 对齐（幂等）。 */
function makeFile(initial = {}) {
  const file = { accessToken: '', wsUrl: '', httpUrl: '', ...initial };
  const calls = [];
  return {
    file,
    calls,
    persist(cfgPath, token) {
      calls.push({ kind: 'token', cfgPath, token });
      const from = file.accessToken;
      const updated = String(from ?? '') !== String(token ?? '');
      if (updated) file.accessToken = token;
      return { updated, from, to: token };
    },
    persistEndpoint(cfgPath, patch = {}) {
      calls.push({ kind: 'endpoint', cfgPath, patch });
      const changed = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === '') continue;
        if (String(file[key] ?? '') === String(value)) continue;
        changed[key] = { from: file[key] ?? null, to: value };
        file[key] = value;
      }
      return { updated: Object.keys(changed).length > 0, changed };
    }
  };
}

/** 假时钟：`Date.now()` 在测试里不可复现，节流窗口只能靠推进它来验证。 */
function makeClock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; }, set: (value) => { at = value; } };
}

/** 发现器替身：按队列返回结果；返回 Error 实例就当作「抛了」。 */
function makeDiscover(plan) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const step = typeof plan === 'function' ? plan(calls.length - 1) : plan[Math.min(calls.length - 1, plan.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = calls;
  return fn;
}

const OK_RESULT = Object.freeze({
  ok: true,
  token: 'http-new-abcdef',
  wsToken: 'ws-new-777888',
  wsUrl: 'ws://127.0.0.1:3002',
  baseUrl: 'http://127.0.0.1:3000',
  source: 'onebot_10001.json',
  self: { user_id: 10001 }
});

// ── 契约 ─────────────────────────────────────────────────────────────────────

test('spec：契约字段齐备且已冻结（locked，令牌自愈不可关）', () => {
  assert.equal(spec.name, 'heal/token');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['cfg', 'log', 'now', 'discover']);
  assert.deepEqual(spec.optionalDeps, ['bot', 'persist', 'persistEndpoint']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  // 必需依赖缺了就装配不起来：宁可没有实例，也不要在运行期才发现 cfg 是 undefined
  assert.throws(() => createTokenHeal(), /cfg 必填/);
  assert.throws(() => createTokenHeal({ cfg: makeCfg(), discover: null }), /discover 必填/);
});

// ── 1. 令牌仍然可用（与当前一致）→ 不重连、不改写 ────────────────────────────

test('令牌未变：不重连、不改写 config.json（只判一次「已是最新」）', async () => {
  const cfg = makeCfg({ accessToken: 'http-token-aaaa' });
  const { bot, calls } = makeBot({ accessToken: 'ws-token-bbbb', url: 'ws://127.0.0.1:3001' });
  const log = makeLog();
  const store = makeFile({ accessToken: 'http-token-aaaa', wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' });
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  const changed = await heal.applyHealedTokens({
    ok: true,
    token: 'http-token-aaaa',
    wsToken: 'ws-token-bbbb',
    wsUrl: 'ws://127.0.0.1:3001',
    baseUrl: 'http://127.0.0.1:3000',
    source: 'config/env'
  });

  assert.equal(changed, false, '参数没变就不该报告「重连过」');
  assert.deepEqual(calls.close, [], '不能把好好的连接掐断');
  assert.equal(calls.connect, 0);
  assert.equal(store.file.accessToken, 'http-token-aaaa', '文件内容不变');
  assert.ok(log.has('config.json 端点已是最新'), '要留一条「判过、无需写」的痕迹');
  assert.equal(log.has('已写回 config.json'), false);
});

// ── 2. 令牌过期（换账号）→ 自愈生效 ──────────────────────────────────────────

test('令牌过期触发自愈：WS/HTTP 两套令牌、端点、config.json 一起对齐', async () => {
  const cfg = makeCfg({ accessToken: 'http-old-123456' });
  const { bot, calls } = makeBot({ accessToken: 'ws-old-999', url: 'ws://127.0.0.1:3001' });
  const log = makeLog();
  const store = makeFile({ accessToken: 'http-old-123456', wsUrl: 'ws://127.0.0.1:3001' });
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  const changed = await heal.applyHealedTokens(OK_RESULT);

  assert.equal(changed, true);
  // WS 用 wsToken + 新端口；HTTP 用 token
  assert.equal(bot.accessToken, 'ws-new-777888', 'WS 的令牌是 wsToken，不是 token');
  assert.equal(bot.url, 'ws://127.0.0.1:3002', '端口也是 per-account 的，必须跟着换');
  assert.deepEqual(calls.close, [[1000, 'token-refresh']], '要让 SDK 立刻用新参数重连');
  assert.equal(calls.connect, 1);

  assert.equal(cfg.snowluma.accessToken, 'http-new-abcdef');
  assert.equal(cfg.snowluma.wsUrl, 'ws://127.0.0.1:3002');
  assert.equal(store.file.accessToken, 'http-new-abcdef');
  assert.equal(store.file.wsUrl, 'ws://127.0.0.1:3002');
  assert.equal(store.file.httpUrl, 'http://127.0.0.1:3000', '发现的 HTTP 端点也一并写回');

  const patch = store.calls.find((c) => c.kind === 'endpoint').patch;
  assert.deepEqual(patch, { accessToken: 'http-new-abcdef', wsUrl: 'ws://127.0.0.1:3002', httpUrl: 'http://127.0.0.1:3000' });

  assert.ok(log.has('SnowLuma WS 连接已更新'));
  assert.ok(log.has('SnowLuma HTTP token 已更新'));
  assert.ok(log.has('已写回 config.json'));
});

// ── 3. 端点跟随可关：只自愈令牌，绝不动 URL ──────────────────────────────────

test('followDiscoveredEndpoint=false：只换令牌，不覆盖也不写回端点', async () => {
  const cfg = makeCfg({ accessToken: 'http-old-123456', wsUrl: 'ws://mine:3001', followDiscoveredEndpoint: false });
  const { bot } = makeBot({ accessToken: 'ws-old-999', url: 'ws://mine:3001' });
  const log = makeLog();
  const store = makeFile({ accessToken: 'http-old-123456', wsUrl: 'ws://mine:3001' });
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  const changed = await heal.applyHealedTokens(OK_RESULT);

  assert.equal(changed, true, '令牌换了，仍然要重连');
  assert.equal(bot.url, 'ws://mine:3001', '用户手设的端点必须原样保留');
  assert.equal(cfg.snowluma.wsUrl, 'ws://mine:3001');
  assert.equal(store.file.wsUrl, 'ws://mine:3001');
  assert.equal(store.file.httpUrl, '', 'HTTP 端点同样不许被自愈改掉');
  assert.deepEqual(store.calls.find((c) => c.kind === 'endpoint').patch, { accessToken: 'http-new-abcdef' });
  assert.ok(log.has('followDiscoveredEndpoint=false'), '要说明为什么忽略发现到的端点');
});

// ── 4. 写盘失败：只记日志，不抛、不影响连接 ──────────────────────────────────

test('同步到文件失败：只记日志、不抛，连接照常更新', async () => {
  const cfg = makeCfg({ accessToken: 'http-new-abcdef' });
  const { bot } = makeBot({ accessToken: 'ws-old-999', url: 'ws://127.0.0.1:3001' });
  const log = makeLog();
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: () => { throw new Error('EACCES: 拒绝访问'); },
    persistEndpoint: () => { throw new Error('EACCES: 拒绝访问'); },
    discover: makeDiscover([OK_RESULT])
  });

  // open 事件里调用的就是它：绝不能因为写不进磁盘把连接搞崩
  await assert.doesNotReject(() => heal.syncTokenToFile());
  assert.equal(await heal.syncTokenToFile(), false);
  assert.ok(log.has('写回 config.json 失败（不影响连接）'));
  assert.ok(log.has('EACCES'));

  // 自愈路径同理：写盘失败只影响「下次启动要不要再自愈一遍」
  const changed = await heal.applyHealedTokens(OK_RESULT);
  assert.equal(changed, true);
  assert.equal(bot.accessToken, 'ws-new-777888');
  assert.ok(log.has('⚠️ 写回 config.json 失败'));
  assert.equal(log.has('⚠️ token 自愈异常'), false, '写盘失败不能被当成自愈异常');
});

// ── 5. 令牌为空：不覆盖、不写盘 ──────────────────────────────────────────────

test('令牌为空：跳过写回，且自愈结果为空时不覆盖现有凭据', async () => {
  const log = makeLog();
  const store = makeFile({ accessToken: '' });
  const emptyCfg = makeCfg({ accessToken: '' });
  const heal = createTokenHeal({
    cfg: emptyCfg,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  // ① 连接成功但配置里没令牌（首次运行 / 手删）：不写空值进文件
  assert.equal(await heal.syncTokenToFile(), false);
  assert.equal(store.calls.length, 0, '空令牌不能落盘');
  assert.ok(log.has('没有可写回的 token'));

  // ② 上游返回空结果：绝不能用 undefined 把能用的令牌抹掉
  const cfg = makeCfg({ accessToken: 'http-keep-9999' });
  const log2 = makeLog();
  const heal2 = createTokenHeal({
    cfg,
    log: log2,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([{ ok: true, token: '', wsToken: '' }])
  });
  assert.equal(await heal2.applyHealedTokens({ ok: true, token: '' }), false);
  assert.equal(cfg.snowluma.accessToken, 'http-keep-9999', '原值必须原样留着');
  assert.ok(log2.has('token 自愈结果为空'));
  assert.equal(store.calls.filter((c) => c.kind === 'endpoint').length, 0);
});

// ── 6. 上游异常：失败返回、异常也返回，绝不把异常抛给事件回调 ────────────────

test('上游返回异常 / 抛错：一律 false + 一条日志，不让 close 回调炸掉', async () => {
  const log = makeLog();
  const heal = createTokenHeal({
    cfg: makeCfg(),
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: () => ({ updated: false }),
    persistEndpoint: () => ({ updated: false, changed: {} }),
    discover: makeDiscover([
      { ok: false, error: '所有候选 token 都被拒绝（401）' },
      new Error('ECONNREFUSED 127.0.0.1:3000')
    ])
  });

  assert.equal(await heal.healTokenIfStale('close code=1006'), false);
  assert.ok(log.has('token 自愈失败（close code=1006）'));
  assert.ok(log.has('401'));

  heal.resetThrottle();   // 节流账要在这一条里独立验证，别让窗口挡住第二次
  await assert.doesNotReject(() => heal.healTokenIfStale('error 401'));
  assert.equal(log.has('token 自愈异常'), true);
  assert.ok(log.has('ECONNREFUSED'));
});

// ── 7. 幂等：同一个结果重复应用只生效一次 ────────────────────────────────────

test('重复调用幂等：第二次应用同一结果不重连、不重复改写', async () => {
  const cfg = makeCfg({ accessToken: 'http-old-123456' });
  const { bot, calls } = makeBot({ accessToken: 'ws-old-999', url: 'ws://127.0.0.1:3001' });
  const log = makeLog();
  const store = makeFile({ accessToken: 'http-old-123456', wsUrl: 'ws://127.0.0.1:3001' });
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  assert.equal(await heal.applyHealedTokens(OK_RESULT), true);
  assert.equal(await heal.applyHealedTokens(OK_RESULT), false, '第二次什么都没变');
  assert.equal(await heal.applyHealedTokens(OK_RESULT), false);

  assert.equal(calls.connect, 1, '只重连一次');
  assert.deepEqual(calls.close, [[1000, 'token-refresh']]);
  assert.equal(store.file.accessToken, 'http-new-abcdef');
  assert.equal(log.count('已写回 config.json'), 1);
  assert.ok(log.count('已是最新') >= 2);
});

// ── 8. 假时钟：10s 节流的边界 ───────────────────────────────────────────────

test('注入假时钟：10s 内第二次自愈被节流，到期后放行，resetThrottle 立即放行', async () => {
  const clock = makeClock(5_000);
  const discover = makeDiscover([OK_RESULT]);
  const heal = createTokenHeal({
    cfg: makeCfg({ accessToken: 'http-old-123456' }),
    log: makeLog(),
    now: clock.now,
    configPath: '/tmp/qq-bridge/config.json',
    persist: () => ({ updated: false }),
    persistEndpoint: () => ({ updated: false, changed: {} }),
    discover
  });

  assert.equal(await heal.healTokenIfStale('first'), true);
  assert.equal(discover.calls.length, 1);
  assert.equal(discover.calls[0].timeoutMs, 4000, '发现超时固定 4s，别拖长启动');

  clock.advance(9_999);
  assert.equal(await heal.healTokenIfStale('still-throttled'), false, '差 1ms 也还在窗口内');
  assert.equal(discover.calls.length, 1);

  clock.advance(1);
  assert.equal(await heal.healTokenIfStale('just-expired'), true, '满 10s 必须放行');
  assert.equal(discover.calls.length, 2);

  heal.resetThrottle();   // bridge 的 retryOnebot 用它对冲到点重试
  assert.equal(await heal.healTokenIfStale('forced-retry'), true);
  assert.equal(discover.calls.length, 3);
});

// ── 9. 缺可选依赖：降级而不是报错 ───────────────────────────────────────────

test('缺可选依赖时降级：没有 bot / 写盘能力也能自愈 cfg，且不抛', async () => {
  const cfg = makeCfg({ accessToken: 'http-old-123456' });
  const log = makeLog();
  const heal = createTokenHeal({
    cfg,
    log,
    now: () => 0,                       // 假时钟从 0 开始：节流初值必须是 -Infinity 才不吞第一次
    discover: makeDiscover([OK_RESULT])  // 只注入必需能力
  });

  const changed = await heal.applyHealedTokens(OK_RESULT);
  assert.equal(changed, false, '没有 bot 就没有「重连」这回事');
  assert.equal(cfg.snowluma.accessToken, 'http-new-abcdef', 'cfg 仍然要跟上');
  assert.equal(cfg.snowluma.wsUrl, 'ws://127.0.0.1:3002');
  assert.ok(log.has('未注入 bot'));
  assert.ok(log.has('未注入写回能力'));

  assert.equal(await heal.syncTokenToFile(), false, '没有 persist 就静默跳过');
  assert.equal(log.has('未注入写回能力'), true);

  assert.equal(await heal.healTokenIfStale('no-optional-deps'), true, '自愈本身仍然可用');
});

// ── 10. 契约门面 ────────────────────────────────────────────────────────────

test('handle 门面：四个动作都有显式返回，未知动作给 INVALID_ARGS', async () => {
  const clock = makeClock(1_000);
  const heal = createTokenHeal({
    cfg: makeCfg({ accessToken: 'http-old-123456' }),
    log: makeLog(),
    now: clock.now,
    configPath: '/tmp/qq-bridge/config.json',
    persist: () => ({ updated: true }),
    persistEndpoint: () => ({ updated: false, changed: {} }),
    discover: makeDiscover([OK_RESULT])
  });

  // 没有 bot：apply 只更新 cfg，返回值（是否重连）必须是 false
  assert.deepEqual(await heal.handle({}, { action: 'apply', result: OK_RESULT }), { ok: true, value: false });
  assert.deepEqual(await heal.handle({}, { action: 'sync' }), { ok: true, value: true });
  assert.deepEqual(await heal.handle({}, { action: 'heal', reason: 'handle' }), { ok: true, value: true });
  assert.deepEqual(await heal.handle({}, { action: 'reset' }), { ok: true, value: true });

  const bad = await heal.handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  assert.match(bad.error, /只支持 apply \/ sync \/ heal \/ reset/);
});

// ── 11. 日志不泄凭据（CWE-532 回归）────────────────────────────────────────

test('日志只出现令牌前 4 位：绝不打印完整令牌', async () => {
  const cfg = makeCfg({ accessToken: 'http-old-123456' });
  const { bot } = makeBot({ accessToken: 'ws-old-999', url: 'ws://127.0.0.1:3001' });
  const log = makeLog();
  const store = makeFile({ accessToken: 'http-old-123456', wsUrl: 'ws://127.0.0.1:3001' });
  const heal = createTokenHeal({
    cfg,
    bot,
    log,
    configPath: '/tmp/qq-bridge/config.json',
    persist: store.persist,
    persistEndpoint: store.persistEndpoint,
    discover: makeDiscover([OK_RESULT])
  });

  await heal.applyHealedTokens(OK_RESULT);
  await heal.syncTokenToFile();

  assert.ok(log.lines.length > 0);
  for (const line of log.lines) {
    assert.equal(line.includes('http-old-123456'), false, `日志泄漏了旧 HTTP 令牌：${line}`);
    assert.equal(line.includes('http-new-abcdef'), false, `日志泄漏了新 HTTP 令牌：${line}`);
    assert.equal(line.includes('ws-new-777888'), false, `日志泄漏了 WS 令牌：${line}`);
  }
  // 但也不是什么都不记：前 4 位 + 省略号足够定位「换了哪一把」
  assert.ok(log.has('http…'), '旧 HTTP 令牌应显示为 http…');
  assert.ok(log.has('http… → http…'), '新旧对照只保留 4 位前缀');
});
