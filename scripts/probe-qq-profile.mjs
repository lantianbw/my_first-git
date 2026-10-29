// 只读探针：SnowLuma / OneBot v11 到底支不支持「改机器人自己的全局 QQ 资料」
// （昵称 / 个性签名 / 头像 / 在线状态 / 自定义在线状态），以及能不能读回来。
//
// 读（安全）：GET / 健康、get_login_info、get_status、get_version_info、
//            get_stranger_info（对自己）——只取数据，不改任何东西。
//
// 写（只看「动作存不存在」，绝不真的改资料）：向每个写动作发一份**类型非法**的参数
// （该字段声明是 string / int，这里塞对象或 0）。SnowLuma 的参数解析在 `defineAction`
// 的 `parse()` 里、**早于** `run()` 执行，非法类型会直接返回 retcode 1400，
// 业务代码根本不会被调用（见 config-ClrCrmAk.js 的 defineAction / stringCore）。
// 因此本探针发出去的值永远不会落盘成昵称/签名/头像。
//
// 判定口径：
//   retcode 1400 + 字段名错误  → 动作**存在**且参数校验生效 = 网关支持该动作
//   retcode 1404 "unknown action" → 动作**不存在**（这一条用来证伪 set_self_profile 之类的名字）
//   其它（401/超时/连接失败）      → 无法判定
//
// 本探针**不**启动、**不**停止 SnowLuma（项目设计不变量 L6：只探测、不部署；
// 见 src/mcp-host-server.js 顶部注释）。网关没开时按「请自行启动 SnowLuma」退出。
//
// 用法：
//   node scripts/probe-qq-profile.mjs                       # 读本仓库 config.json
//   node scripts/probe-qq-profile.mjs --config ../qq-bridge/config.json
//   node scripts/probe-qq-profile.mjs --home E:\SnowLuma
//   node scripts/probe-qq-profile.mjs --timeout 10
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { config: null, home: null, timeoutSec: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i]) || 15;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (/^\d+$/.test(a)) out.timeoutSec = Number(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node scripts/probe-qq-profile.mjs [--config <config.json>] [--home <SnowLuma目录>] [--timeout 秒]');
  process.exit(0);
}

// ── 1. 配置 & 端点发现（与桥接生产代码同一套自发现：config/env → per-account token 文件）
let cfg = {};
const cfgPath = args.config
  ? path.resolve(args.config)
  : (fs.existsSync(path.join(ROOT, 'config.json')) ? path.join(ROOT, 'config.json') : null);
if (cfgPath) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { console.log(`⚠️ 读取 ${cfgPath} 失败（按空配置继续）：${error?.message ?? error}`); }
}
const homeDirs = args.home
  ? [path.resolve(args.home)]
  : (process.env.SNOWLUMA_HOME ? [process.env.SNOWLUMA_HOME] : null);

const disc = await discoverSnowLumaConnection({ cfg, homeDirs, timeoutMs: 6000 });
if (!disc.ok) {
  console.log(`❌ 连不上 SnowLuma 的 OneBot HTTP API：${disc.error}`);
  for (const t of disc.tried ?? []) {
    const why = t.error ?? (t.status ? `http=${t.status} ${t.wording ?? ''}` : '无响应');
    console.log(`   试过 ${t.url}（token ${t.token}，来源 ${t.source}）→ ${why}`);
  }
  console.log('\n本探针不会替你启动 SnowLuma（L6 不变量：只探测、不部署）。');
  console.log('→ 请自行启动 SnowLuma（launcher.bat / 它的桌面入口）并确认 OneBot HTTP 服务可用，然后重跑本脚本。');
  process.exit(2);
}
console.log(`已发现端点 ${disc.baseUrl}（token ${String(disc.token || '').slice(0, 4)}…，来源 ${disc.source}）\n`);

// ── 2. 直连调用（与 src/bridge.js 的 oneBotHttp 同形：POST JSON + Bearer，返回整个 body）
const base = disc.baseUrl.replace(/\/+$/, '');
async function call(action, params = {}, timeoutMs = 15000) {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(disc.token ? { authorization: `Bearer ${disc.token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, ...body };
}

async function callGet(route, timeoutMs = 8000) {
  const res = await fetch(`${base}${route}`, {
    headers: disc.token ? { authorization: `Bearer ${disc.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
}

const rows = [];
const record = (kind, name, verdict, detail) => rows.push({ kind, name, verdict, detail });

// ── 3. 只读：网关基本信息（顺带证明鉴权与端点可用）
const health = await callGet('/').catch((e) => ({ http: 0, wording: e?.message ?? String(e) }));
record('读', 'GET /（健康）', health.status === 'ok' ? '✅' : '❌', `http=${health.http} ${health.wording ?? ''}`);

const login = await call('get_login_info');
record('读', 'get_login_info', login.status === 'ok' ? '✅' : '❌',
  login.status === 'ok' ? `user_id=${login.data?.user_id} nickname=${login.data?.nickname}` : `retcode=${login.retcode} ${login.wording ?? ''}`);

const status = await call('get_status');
record('读', 'get_status', status.status === 'ok' ? '✅' : '❌',
  status.status === 'ok' ? `online=${status.data?.online} good=${status.data?.good}` : `retcode=${status.retcode} ${status.wording ?? ''}`);

const ver = await call('get_version_info');
record('读', 'get_version_info', ver.status === 'ok' ? '✅' : '❌',
  ver.status === 'ok' ? `${ver.data?.app_name} ${ver.data?.app_version} / ${ver.data?.protocol_version}` : `retcode=${ver.retcode} ${ver.wording ?? ''}`);

// 读回自己现在的资料（昵称 / 个性签名 / 性别）——「改完怎么确认生效」的替代路径。
const selfId = login.data?.user_id;
let stranger = null;
if (selfId != null) {
  stranger = await call('get_stranger_info', { user_id: Number(selfId) });
  record('读', 'get_stranger_info(自己)', stranger.status === 'ok' ? '✅' : '❌',
    stranger.status === 'ok'
      ? `nickname=${JSON.stringify(stranger.data?.nickname)} long_nick=${JSON.stringify(stranger.data?.long_nick)} sex=${JSON.stringify(stranger.data?.sex)}`
      : `retcode=${stranger.retcode} ${stranger.wording ?? ''}`);
} else {
  record('读', 'get_stranger_info(自己)', '⏭️', '拿不到 get_login_info 的 user_id，跳过');
}

// ── 4. 写动作「存在性」探测：只发类型非法的参数，参数解析阶段就被 1400 驳回，业务代码不会执行
const WRITE_PROBES = [
  { action: 'set_qq_profile', params: { nickname: { __probe__: 'invalid-type' } }, fields: 'nickname / personal_note / sex', label: '改昵称（+个人说明/性别）' },
  { action: 'set_self_longnick', params: { longNick: { __probe__: 'invalid-type' } }, fields: 'longNick | long_nick（严格 string）', label: '改个性签名' },
  { action: 'set_qq_avatar', params: { file: { __probe__: 'invalid-type' } }, fields: 'file（图片 URL/路径/base64）', label: '改全局头像' },
  { action: 'set_online_status', params: { status: 0 }, fields: 'status(≠0) / ext_status / battery_status', label: '改在线状态' },
  { action: 'set_diy_online_status', params: { face_id: { __probe__: 'invalid-type' } }, fields: 'face_id / face_type / wording', label: '改自定义在线状态' },
  // 题目里提到的另一个名字，用来证明「名字不存在 ≠ 网关不支持」这条判定确实有效
  { action: 'set_self_profile', params: { nickname: { __probe__: 'invalid-type' } }, fields: '（OneBot v11 无此动作）', label: '对照组：set_self_profile', control: true }
];

console.log('写动作探测（只发类型非法参数，参数解析先于业务执行，不会改资料）：');
for (const p of WRITE_PROBES) {
  const r = await call(p.action, p.params).catch((e) => ({ http: 0, wording: e?.message ?? String(e) }));
  let verdict;
  let detail;
  if (r.retcode === 1400) {
    verdict = '✅ 支持';
    detail = `1400 ${r.wording ?? ''}（动作已注册，参数校验生效）`;
  } else if (r.retcode === 1404) {
    verdict = p.control ? '✅ 判定有效' : '❌ 不支持';
    detail = '1404 unknown action（动作未注册）';
  } else if (r.status === 'ok' && r.retcode === 0) {
    verdict = '⚠️ 意外';
    detail = '返回成功——参数没有被拦下，请人工复核（本探针本不该发出可执行参数）';
  } else {
    verdict = '❓ 无法判定';
    detail = `http=${r.http} retcode=${r.retcode} ${r.wording ?? ''}`;
  }
  record('写', `${p.action}（${p.label}）`, verdict, `${detail}；声明字段：${p.fields}`);
}

// ── 5. 汇总
const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 255 ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(1, n - w));
};
console.log('\n=== 探测结果 ===');
for (const r of rows) console.log(`${pad(r.kind, 4)}${pad(r.name, 34)}${pad(r.verdict, 12)}${r.detail}`);

const supported = WRITE_PROBES.filter((p) => !p.control && rows.find((r) => r.name.startsWith(p.action))?.verdict === '✅ 支持');
const missing = WRITE_PROBES.filter((p) => !p.control && rows.find((r) => r.name.startsWith(p.action))?.verdict === '❌ 不支持');
console.log('\n=== 结论 ===');
console.log(`可用的写动作：${supported.length ? supported.map((p) => p.action).join(' / ') : '（无）'}`);
if (missing.length) console.log(`不可用：${missing.map((p) => p.action).join(' / ')}`);
console.log('可读回：昵称 / 个性签名 / 性别（get_stranger_info 对自己）；头像没有读回接口。');
console.log('注：本探针没有发出任何一条「合法」的写参数，机器人资料未发生任何变化。');

process.exit(0);
