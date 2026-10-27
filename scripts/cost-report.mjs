#!/usr/bin/env node
// 成本报告：用真实账本（state/token-usage.jsonl）算清钱花在哪。
//
// 只读：除了读账本和价目表，不写任何 state 文件。金额一律走 src/model-prices.js
// （含高峰×2 与模型实际单价），所以"报告里的数"和"控制台显示的账"是同一套口径。
//
// 用法：
//   node scripts/cost-report.mjs [--days N] [--json] [--file <账本路径>]
//
// 关于账本的两点语义（不然会算错一倍以上）：
//   1) `k:"base"` 是 DSH 投影的**会话累计**快照，同一 sid 会反复重写（seq 递增）。
//      它跨越多天、含桥接启动前的历史，不能按行相加，也不能摊到某一天 ——
//      所以这里只取每个 sid 最新一条，作为"历史基线"单独报数，不计入窗口花费。
//   2) `k:"turn"` 是逐回合的**最终采样**，同一 (sid,turn,step,retry) 以后到的为准
//      （重连会重放旧快照）。折叠后每条都是一次真实的计费请求，才是能按天切分的钱。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beijingParts,
  isPeakAt,
  normalizeUsage,
  priceUsage,
  DEFAULT_PRICE_TABLE
} from '../src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = path.join(ROOT, 'state', 'token-usage.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
  console.log('用法: node scripts/cost-report.mjs [--days N] [--json] [--file <账本路径>]');
  console.log('  --days N   统计最近 N 天（默认 1）');
  console.log('  --json     输出机器可读 JSON');
  console.log('  --file P   指定账本路径（默认 state/token-usage.jsonl，只读）');
}

function parseArgs(argv) {
  const opts = { days: 1, json: false, file: DEFAULT_FILE, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--days') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--days 需要一个正数，收到 ${argv[i + 1]}`);
      opts.days = n;
      i += 1;
    } else if (arg === '--file') {
      if (!argv[i + 1]) throw new Error('--file 需要一个路径');
      opts.file = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return opts;
}

/** 读账本：坏行只计数，不让整份报告挂掉。 */
function loadLedger(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error(`账本不存在：${file}\n还没有任何用量记录（桥跑起来并产生过一次模型调用后才会有）。`), { code: 'NO_LEDGER' });
    }
    throw Object.assign(new Error(`读取账本失败：${file}（${error?.message ?? error}）`), { code: 'READ_FAILED' });
  }
  const records = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object') records.push(record);
    } catch {
      badLines += 1; // 进程被杀留下的半行
    }
  }
  return { records, badLines, lines: raw.split('\n').filter((l) => l.trim()).length };
}

/** 折叠账本：turn 采样按 (sid,turn,step,retry) 取 seq 最大者；base 每 sid 只留最新。 */
function foldLedger(records) {
  const turns = new Map();
  const baselines = new Map();
  let evictedRows = 0;
  for (const record of records) {
    const sid = String(record.sid ?? '');
    if (!sid) continue;
    if (record.k === 'evict') {
      evictedRows += 1;
      continue;
    }
    if (record.k === 'base') {
      const prev = baselines.get(sid);
      const seq = Number(record.seq ?? -1);
      if (prev && prev.seq > seq) continue;
      baselines.set(sid, { ...record, seq, t: Number(record.t) || 0, buckets: normalizeUsage(record.b) });
      continue;
    }
    if (record.k !== 'turn') continue;
    const turn = Number(record.turn);
    const step = Number(record.step);
    if (!Number.isFinite(turn) || !Number.isFinite(step)) continue;
    const retry = Number.isFinite(Number(record.retry)) ? Number(record.retry) : 0;
    const key = `${sid}|${turn}|${step}|${retry}`;
    const prev = turns.get(key);
    const seq = Number(record.seq ?? -1);
    // 相等 seq 只可能是重连重放的同一事件，不能覆盖（否则新数据会被旧快照改小）。
    if (prev && prev.seq >= seq) continue;
    turns.set(key, {
      key,
      sid,
      seq,
      t: Number(record.t) || 0,
      turn,
      step,
      retry,
      provider: String(record.provider ?? 'unknown'),
      model: String(record.model ?? 'unknown'),
      buckets: normalizeUsage(record.b)
    });
  }
  return { turns: [...turns.values()], baselines: [...baselines.values()], evictedRows };
}

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtMoney = (n) => `¥${(Number(n) || 0).toFixed(4)}`;
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%');

function beijingClock(ms) {
  const p = beijingParts(ms);
  return `${p.date} ${p.clock}`;
}

function buildReport({ turns, baselines, evictedRows, badLines, file, lines, days, now }) {
  const since = now - days * DAY_MS;
  const rows = turns.filter((row) => row.t >= since && row.t <= now + DAY_MS);

  const groups = new Map();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, cost: 0, mintokens: 0 }));
  const totals = {
    calls: 0,
    cost: 0,
    costParts: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
    buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    peakCost: 0,
    offCost: 0,
    estimatedCalls: 0
  };

  for (const row of rows) {
    const priced = priceUsage(row.buckets, { model: row.model, at: row.t, table: DEFAULT_PRICE_TABLE });
    const groupKey = `${row.provider}/${row.model}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        provider: row.provider,
        model: row.model,
        label: priced.rates.label,
        calls: 0,
        buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        cost: 0,
        estimated: false
      });
    }
    const group = groups.get(groupKey);
    group.calls += 1;
    group.cost += priced.cost.total;
    group.estimated ||= priced.rates.estimated === true;
    for (const k of ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']) {
      group.buckets[k] += row.buckets[k] ?? 0;
      totals.buckets[k] += row.buckets[k] ?? 0;
      totals.costParts[k] += priced.cost[k] ?? 0;
    }
    totals.buckets.reasoning += row.buckets.reasoning ?? 0;
    totals.calls += 1;
    totals.cost += priced.cost.total;
    if (isPeakAt(row.t, DEFAULT_PRICE_TABLE)) totals.peakCost += priced.cost.total;
    else totals.offCost += priced.cost.total;
    if (priced.rates.estimated) totals.estimatedCalls += 1;

    const hour = beijingParts(row.t).hour;
    hours[hour].calls += 1;
    hours[hour].cost += priced.cost.total;
    hours[hour].mintokens += (row.buckets.cacheMiss ?? 0) + (row.buckets.cacheHit ?? 0);
  }

  const groupList = [...groups.values()]
    .map((group) => {
      const input = group.buckets.cacheMiss + group.buckets.cacheHit;
      return { ...group, hitRate: input > 0 ? group.buckets.cacheHit / input : 0 };
    })
    .sort((a, b) => b.cost - a.cost);

  const shareOf = (key) => (totals.cost > 0 ? totals.costParts[key] / totals.cost : 0);
  const shares = {
    cacheMiss: shareOf('cacheMiss'),
    cacheHit: shareOf('cacheHit'),
    cacheWrite: shareOf('cacheWrite'),
    output: shareOf('output')
  };
  const perCall = {
    cost: totals.calls ? totals.cost / totals.calls : 0,
    cacheMiss: totals.calls ? totals.buckets.cacheMiss / totals.calls : 0,
    cacheHit: totals.calls ? totals.buckets.cacheHit / totals.calls : 0,
    output: totals.calls ? totals.buckets.output / totals.calls : 0
  };
  const input = totals.buckets.cacheMiss + totals.buckets.cacheHit;
  const hitRate = input > 0 ? totals.buckets.cacheHit / input : 0;
  const hourlyTop = [...hours].sort((a, b) => b.calls - a.calls).slice(0, 3);
  const baseline = baselines.reduce(
    (acc, row) => {
      const priced = priceUsage(row.buckets, { model: String(row.model ?? 'unknown'), at: row.t, table: DEFAULT_PRICE_TABLE });
      acc.buckets.cacheMiss += row.buckets.cacheMiss;
      acc.buckets.cacheHit += row.buckets.cacheHit;
      acc.buckets.cacheWrite += row.buckets.cacheWrite;
      acc.buckets.output += row.buckets.output;
      acc.cost += priced.cost.total;
      return acc;
    },
    { sessions: baselines.length, buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }, cost: 0 }
  );

  const conclusion = buildConclusion({ totals, shares, perCall, hitRate, hours, days, groupList });

  return {
    window: { days, since, until: now, sinceText: beijingClock(since), untilText: beijingClock(now) },
    ledger: { file, lines, badLines, evictedRows, turnRows: turns.length, inWindow: rows.length, baselineSessions: baselines.length, baseline: baseline },
    groups: groupList,
    totals: { ...totals, hitRate, shares, perCall, hourlyTop },
    hours,
    conclusion
  };
}

function buildConclusion({ totals, shares, perCall, hitRate, hours, days, groupList }) {
  if (!totals.calls) {
    return {
      cause: 'none',
      lines: [
        '结论：窗口内没有可归到具体回合的计费记录（只有会话累计基线，无法按天切分）。',
        '依据：turn 采样 0 条；base 基线不含时间维度，不能摊到某一天。',
        '下一步：等桥跑一段时间再看，或用 --days 放大窗口。'
      ]
    };
  }
  const ranked = [
    { key: 'cacheMiss', label: 'miss（未命中缓存的输入）', share: shares.cacheMiss },
    { key: 'cacheHit', label: 'hit（命中缓存的输入）', share: shares.cacheHit },
    { key: 'output', label: '输出', share: shares.output }
  ].sort((a, b) => b.share - a.share);
  const top = ranked[0];

  let cause;
  let advice;
  if (top.key === 'cacheMiss') {
    cause = 'miss 多';
    advice = `主因是「miss 多」：未命中缓存的输入 token 吃掉了 ${pct(top.share, 1)} 的钱。优先压缩每轮重复的前缀（固定 system/工具清单顺序、减少上下文重建），比抠输出便宜得多。`;
  } else if (top.key === 'cacheHit') {
    cause = 'hit 单价贵';
    advice = '主因是「hit 单价贵」的替代形态：命中量是 miss 的很多倍，0.02/百万 的单价乘以巨量仍是最大开销。可从减少无效上下文（少读无用历史）和缩短会话长度入手。';
  } else {
    cause = '输出多';
    advice = '主因是输出 token：生成侧 4/百万 远贵于 hit。可从回复长度、工具返回体积、少让模型复述入手。';
  }
  if (top.share < 0.5) {
    const callsPerDay = totals.calls / Math.max(days, 1);
    cause = '调用次数多';
    advice = `没有任何单项过半，钱是被调用次数摊出来的（${fmtInt(totals.calls)} 次 / ${days} 天，单次 ${fmtMoney(perCall.cost)}）。先看重复提问、多余重试与无意义轮询，减少调用次数最有效。`;
  }
  const busiest = hours.reduce((best, h) => (h.calls > best.calls ? h : best), { hour: 0, calls: 0, cost: 0 });
  return {
    cause,
    lines: [
      `主因：${cause}（miss ${pct(shares.cacheMiss, 1)} / hit ${pct(shares.cacheHit, 1)} / 输出 ${pct(shares.output, 1)}）`,
      `依据：${fmtInt(totals.calls)} 次调用、单次均价 ${fmtMoney(perCall.cost)}；每次 miss ${fmtInt(perCall.cacheMiss)} tok、hit ${fmtInt(perCall.cacheHit)} tok、输出 ${fmtInt(perCall.output)} tok，命中率 ${pct(hitRate, 1)}；最忙时段 ${String(busiest.hour).padStart(2, '0')}:00（${fmtInt(busiest.calls)} 次，占 ${pct(busiest.calls, totals.calls)}）`,
      `建议：${advice}`
    ]
  };
}

const padEnd = (text, width) => {
  const s = String(text);
  let visual = 0;
  for (const ch of s) visual += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - visual));
};

function printText(report) {
  const { ledger, window, totals, groups, hours, conclusion } = report;
  console.log(`成本报告 · 最近 ${window.days} 天`);
  console.log(`窗口：${window.sinceText} ~ ${window.untilText}（北京时间）`);
  console.log(`账本：${ledger.file}`);
  console.log(`      共 ${fmtInt(ledger.lines)} 行 / 折叠后 ${fmtInt(ledger.turnRows)} 条回合采样，窗口内 ${fmtInt(ledger.inWindow)} 条；坏行 ${ledger.badLines}；被淘汰汇总 ${ledger.evictedRows}；历史基线 ${ledger.baselineSessions} 个会话 ${fmtMoney(ledger.baseline.cost)}（含桥启动前，未计入窗口）`);
  console.log('');

  console.log('【按 provider/model】');
  if (!groups.length) {
    console.log('  （窗口内没有记录）');
  } else {
    console.log(`${padEnd('provider/model', 38)}${padEnd('调用', 8)}${padEnd('cacheMiss', 14)}${padEnd('cacheHit', 14)}${padEnd('output', 12)}${padEnd('费用', 12)}命中率`);
    for (const row of groups) {
      const name = `${row.provider}/${row.model}`;
      const shown = name.length > 36 ? `${name.slice(0, 33)}...` : name;
      console.log(
        padEnd(shown, 38) +
        padEnd(fmtInt(row.calls), 8) +
        padEnd(fmtInt(row.buckets.cacheMiss), 14) +
        padEnd(fmtInt(row.buckets.cacheHit), 14) +
        padEnd(fmtInt(row.buckets.output), 12) +
        padEnd(fmtMoney(row.cost), 12) +
        pct(row.hitRate, 1) +
        (row.estimated ? '（估价）' : '')
      );
    }
  }
  console.log('');

  console.log('【全局】');
  console.log(`  总花费      ${fmtMoney(totals.cost)}（高峰 ${fmtMoney(totals.peakCost)} / 空闲 ${fmtMoney(totals.offCost)}）`);
  console.log(`  调用次数    ${fmtInt(totals.calls)}`);
  console.log(`  单次均价    ${fmtMoney(totals.perCall.cost)}`);
  console.log(`  平均每次    miss ${fmtInt(totals.perCall.cacheMiss)} tok / hit ${fmtInt(totals.perCall.cacheHit)} tok / 输出 ${fmtInt(totals.perCall.output)} tok`);
  console.log(`  缓存命中率  ${pct(totals.hitRate, 1)}（hit ${fmtInt(totals.buckets.cacheHit)} / miss ${fmtInt(totals.buckets.cacheMiss)}）`);
  console.log('');

  console.log('【成本结构】');
  console.log(`  miss 费   ${pct(totals.shares.cacheMiss, 1).padStart(6)}  ${fmtMoney(totals.costParts.cacheMiss)}`);
  console.log(`  hit 费    ${pct(totals.shares.cacheHit, 1).padStart(6)}  ${fmtMoney(totals.costParts.cacheHit)}`);
  if (totals.costParts.cacheWrite > 0) {
    console.log(`  write 费  ${pct(totals.shares.cacheWrite, 1).padStart(6)}  ${fmtMoney(totals.costParts.cacheWrite)}`);
  }
  console.log(`  输出费    ${pct(totals.shares.output, 1).padStart(6)}  ${fmtMoney(totals.costParts.output)}`);
  console.log('');

  console.log('【按小时（北京时间，仅显示有调用的时段）】');
  const maxCalls = Math.max(...hours.map((h) => h.calls), 1);
  for (const slot of hours) {
    if (!slot.calls) continue;
    const bar = '█'.repeat(Math.max(1, Math.round((slot.calls / maxCalls) * 24)));
    console.log(`  ${String(slot.hour).padStart(2, '0')}:00  ${bar.padEnd(24)} ${String(fmtInt(slot.calls)).padStart(5)} 次  ${fmtMoney(slot.cost)}`);
  }
  if (!hours.some((h) => h.calls)) console.log('  （窗口内没有调用）');
  console.log('');

  console.log('【结论】');
  for (const line of conclusion.lines) console.log(`  ${line}`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    usage();
    return;
  }
  let loaded;
  try {
    loaded = loadLedger(opts.file);
  } catch (error) {
    console.error(`[cost-report] ${error.message}`);
    console.error('[cost-report] 用法提示：--file 可以指向任意只读账本副本；本脚本不会写入任何 state 文件。');
    process.exitCode = 1;
    return;
  }
  const folded = foldLedger(loaded.records);
  const now = Date.now();
  const report = buildReport({
    ...folded,
    badLines: loaded.badLines,
    lines: loaded.lines,
    file: opts.file,
    days: opts.days,
    now
  });
  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      ...report,
      groups: report.groups.map((g) => ({ ...g, label: g.label, hitRate: Number(g.hitRate.toFixed(4)) })),
      conclusion: report.conclusion
    }, null, 2));
    return;
  }
  printText(report);
}

main();
