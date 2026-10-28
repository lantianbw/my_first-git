// 按会话（sid）拆账 + 工具调用/回执体积统计。**只读**，不写任何 state 文件。
//
// 目的：回答「钱到底花在哪个会话上」，而不是只看总数。
// 数据源：
//   state/token-usage.jsonl   逐回合计费采样（k=turn；同 (sid,turn,step,retry) 只取 seq 最大者）
//   state/tool-calls.jsonl(.1) 工具调用记录（type=call/result，含 key/sessionId/tool/args）
//   state/prompt-stats.json   唤醒提示词字符数采样（用来印证 QQ 侧上下文规模）
//
// 关于「回执体积」：tool-calls 记录里**没有**回执字节数（只有 args），所以这里用
// 「每次工具调用带来的新增 token（miss ÷ 工具调用次数）」作为可计算的间接度量。
// 要得到精确字节，需要在 writeToolCall 处补一个 size 字段（本次不改代码）。
//
// 用法：
//   node scripts/token-attribution.mjs [--days N] [--json] [--top N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceUsage, isPeakAt } from '../src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const DAYS = opt('--days', 30);
const TOP = opt('--top', 12);
const AS_JSON = flag('--json');

const now = Date.now();
const since = now - DAYS * 24 * 60 * 60 * 1000;

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return { rows: [], missing: true };
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { rows, missing: false, bad };
};

// ── 1. 计费采样：按 (sid,turn,step,retry) 折叠 ─────────────────────────────
const usage = readJsonl(path.join(STATE, 'token-usage.jsonl'));
if (usage.missing) {
  console.error('账本不存在：state/token-usage.jsonl（本脚本只读，不会创建它）');
  process.exit(1);
}
const folded = new Map();
for (const row of usage.rows) {
  if (row.k !== 'turn') continue;
  const id = `${row.sid}|${row.turn}|${row.step}|${row.retry}`;
  const prev = folded.get(id);
  if (!prev || Number(row.seq ?? 0) > Number(prev.seq ?? 0)) folded.set(id, row);
}
const turns = [...folded.values()].filter((r) => Number(r.t) >= since);

const costOf = (row) => {
  const b = row.b ?? {};
  try {
    const priced = priceUsage(
      { cacheMiss: b.cacheMiss ?? 0, cacheHit: b.cacheHit ?? 0, cacheWrite: b.cacheWrite ?? 0, output: b.output ?? 0 },
      { model: row.model, at: Number(row.t) }
    );
    return { total: priced?.cost?.total ?? 0, peak: isPeakAt(Number(row.t)) };
  } catch {
    return { total: 0, peak: false };
  }
};

const sessions = new Map();
for (const row of turns) {
  const sid = String(row.sid ?? '?');
  const s = sessions.get(sid) ?? {
    sid, key: String(row.key ?? ''), models: new Map(), providers: new Set(),
    calls: 0, turns: new Set(), miss: 0, hit: 0, out: 0, cost: 0, peakCost: 0, first: Infinity, last: 0
  };
  const b = row.b ?? {};
  const { total, peak } = costOf(row);
  s.calls += 1;
  s.turns.add(`${row.turn}`);
  s.miss += Number(b.cacheMiss ?? 0);
  s.hit += Number(b.cacheHit ?? 0);
  s.out += Number(b.output ?? 0);
  s.cost += total;
  if (peak) s.peakCost += total;
  s.providers.add(String(row.provider ?? '?'));
  const mk = String(row.model ?? '?');
  s.models.set(mk, (s.models.get(mk) ?? 0) + 1);
  s.first = Math.min(s.first, Number(row.t));
  s.last = Math.max(s.last, Number(row.t));
  sessions.set(sid, s);
}

// ── 2. 工具调用：次数 + 每次调用带来的新增 token ───────────────────────────
const toolA = readJsonl(path.join(STATE, 'tool-calls.jsonl'));
const toolB = readJsonl(path.join(STATE, 'tool-calls.jsonl.1'));
const toolRows = [...toolB.rows, ...toolA.rows]
  .filter((r) => r.type === 'call' && Date.parse(r.time) >= since);

const toolBySid = new Map();
const toolTotals = new Map();
for (const row of toolRows) {
  const sid = String(row.sessionId ?? '?');
  const cur = toolBySid.get(sid) ?? { calls: 0, tools: new Map(), failed: 0 };
  cur.calls += 1;
  if (row.ok === false) cur.failed += 1;
  cur.tools.set(row.tool, (cur.tools.get(row.tool) ?? 0) + 1);
  toolBySid.set(sid, cur);
  toolTotals.set(row.tool, (toolTotals.get(row.tool) ?? 0) + 1);
}

// ── 3. 提示词规模（QQ 侧上下文是否真的小）────────────────────────────────
let promptChars = null;
const promptFile = path.join(STATE, 'prompt-stats.json');
if (fs.existsSync(promptFile)) {
  try {
    const samples = JSON.parse(fs.readFileSync(promptFile, 'utf8'))?.samples ?? [];
    const inWindow = samples.filter((s) => Number(s.at) >= since).map((s) => Number(s.chars));
    if (inWindow.length) {
      promptChars = {
        n: inWindow.length,
        avg: Math.round(inWindow.reduce((a, b) => a + b, 0) / inWindow.length),
        max: Math.max(...inWindow)
      };
    }
  } catch { /* 坏文件就当没有 */ }
}

// ── 4. 汇总 ────────────────────────────────────────────────────────────────
const list = [...sessions.values()].sort((a, b) => b.cost - a.cost);
const totalCost = list.reduce((a, s) => a + s.cost, 0);
const isQQ = (key) => /^(private|group):\d+$/.test(key);
const qqCost = list.filter((s) => isQQ(s.key)).reduce((a, s) => a + s.cost, 0);
const otherCost = totalCost - qqCost;

const shape = (s) => ({
  key: s.key,
  sid: s.sid.slice(0, 8),
  model: [...s.models.entries()].sort((a, b) => b[1] - a[1])[0][0],
  provider: [...s.providers].join('+'),
  turns: s.turns.size,
  calls: s.calls,
  miss: s.miss,
  hit: s.hit,
  out: s.out,
  cost: Number(s.cost.toFixed(4)),
  share: totalCost ? Number(((s.cost / totalCost) * 100).toFixed(1)) : 0,
  avgMissPerCall: Math.round(s.miss / s.calls),
  avgHitPerCall: Math.round(s.hit / s.calls),
  avgOutPerCall: Math.round(s.out / s.calls),
  toolCalls: toolBySid.get(s.sid)?.calls ?? 0,
  newTokensPerToolCall: toolBySid.get(s.sid)?.calls
    ? Math.round(s.miss / toolBySid.get(s.sid).calls)
    : null,
  topTools: [...(toolBySid.get(s.sid)?.tools ?? new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t.replace('mcp__snowluma__', '')}×${n}`)
});

if (AS_JSON) {
  console.log(JSON.stringify({
    window: { days: DAYS, since, sinceText: new Date(since).toISOString() },
    ledger: { lines: usage.rows.length, badLines: usage.bad ?? 0, foldedCalls: folded.size, inWindow: turns.length },
    totals: {
      cost: Number(totalCost.toFixed(4)),
      qqCost: Number(qqCost.toFixed(4)),
      otherCost: Number(otherCost.toFixed(4)),
      sessions: list.length,
      toolCalls: toolRows.length
    },
    promptChars,
    sessions: list.slice(0, TOP).map(shape),
    tools: [...toolTotals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tool, n]) => ({ tool, calls: n }))
  }, null, 2));
  process.exit(0);
}

// ── 5. 人读输出 ────────────────────────────────────────────────────────────
const pad = (v, n) => String(v).padEnd(n);
const num = (v, n) => String(v).padStart(n);

console.log(`\n【窗口】最近 ${DAYS} 天｜折叠后 ${folded.size} 条采样，窗口内 ${turns.length} 条｜坏行 ${usage.bad ?? 0}`);
console.log(`【总量】¥${totalCost.toFixed(2)}｜会话 ${list.length} 个｜工具调用 ${toolRows.length} 次`);
console.log(`【归属】QQ 会话 ¥${qqCost.toFixed(2)}（${totalCost ? ((qqCost / totalCost) * 100).toFixed(1) : 0}%）｜其他 ¥${otherCost.toFixed(2)}`);

console.log('\n【按会话拆账（按花费降序）】');
console.log(pad('key', 22) + pad('sid', 10) + pad('模型', 22) + num('轮', 5) + num('调用', 6)
  + num('miss', 11) + num('hit', 12) + num('out', 8) + num('¥', 10) + num('占比', 7) + num('均miss/次', 11));
for (const s of list.slice(0, TOP)) {
  const sh = shape(s);
  console.log(pad(sh.key || '(none)', 22) + pad(sh.sid, 10) + pad(sh.model, 22)
    + num(sh.turns, 5) + num(sh.calls, 6) + num(sh.miss, 11) + num(sh.hit, 12) + num(sh.out, 8)
    + num(sh.cost.toFixed(4), 10) + num(`${sh.share}%`, 7) + num(sh.avgMissPerCall, 11));
}

console.log('\n【工具调用：次数 + 每次调用带来的新增 token】');
console.log(pad('key', 22) + num('工具调用', 10) + num('新增token/次', 14) + ' 主要工具');
for (const s of list.slice(0, TOP)) {
  const sh = shape(s);
  if (!sh.toolCalls) continue;
  console.log(pad(sh.key || '(none)', 22) + num(sh.toolCalls, 10)
    + num(sh.newTokensPerToolCall ?? '-', 14) + ' ' + sh.topTools.join(' '));
}

console.log('\n【工具总榜（次数）】');
for (const [tool, n] of [...toolTotals].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${pad(tool.replace('mcp__snowluma__', ''), 28)}${num(n, 6)}`);
}

if (promptChars) {
  console.log(`\n【唤醒提示词规模】样本 ${promptChars.n} 次｜平均 ${promptChars.avg} 字符｜最大 ${promptChars.max} 字符`);
}

const heavy = list.filter((s) => s.calls >= 5 && s.miss / s.calls > 20000);
console.log('\n【结论】');
console.log(`  1) 花费最大会话：${(list[0]?.key || '-')}（sid ${list[0]?.sid.slice(0, 8) || '-'}）占 ${list[0] ? ((list[0].cost / totalCost) * 100).toFixed(1) : 0}%`);
console.log(`  2) miss 占比高且平均每次 >2 万 token 的会话：${heavy.length} 个${heavy.length ? '（' + heavy.slice(0, 3).map((s) => `${s.key}:${Math.round(s.miss / s.calls)}`).join('、') + '）' : ''}`);
console.log(`  3) 工具回执字节未记账：tool-calls 只记 args，不记 result 长度；上表「新增token/次」是可算的替代指标`);
