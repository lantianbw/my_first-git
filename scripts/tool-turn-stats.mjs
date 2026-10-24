#!/usr/bin/env node
// 单轮工具调用统计：把 state/tool-calls.jsonl 折成回合，评估「单轮工具 ≤2 次」。
//
// 三个口径（2026-10-24 交接已知问题 #2 的口径重定）：
//   ① 全部 · 时间窗：sessionId + 时间窗（间隔 > gapMs 算新一轮）——历史数据可用的唯一口径；
//   ② 对外动作 · 时间窗：排除结构性工具（wait/mark_read/快照/记忆簿记）后按时间窗；
//   ③ 真实 turn：按日志里的 DSH 回合号分组，只有 2026-10-24 15:09 之后的行可信。
//
// 用法：
//   node scripts/tool-turn-stats.mjs                                   # 最近 7 天
//   node scripts/tool-turn-stats.mjs --days 3 --gap-ms 60000 --max 2
//   node scripts/tool-turn-stats.mjs --exclude send_message,reply     # 自定义排除（子串）
//   node scripts/tool-turn-stats.mjs --out E:\DSH\_pad\tool-turn-stats.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupTurnWindows,
  groupTurnsByKey,
  filterToolRows,
  summarizeTurnWindows,
  STRUCTURAL_TOOL_PATTERNS,
  TURN_GAP_MS_DEFAULT
} from '../src/tool-turn-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const [key, inline] = item.slice(2).split('=');
    if (inline !== undefined) args.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.set(key, argv[++i]);
    else args.set(key, true);
  }
  return args;
}

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (t) => {
  const d = new Date(Number(t));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const args = parseArgs(process.argv.slice(2));
const days = Math.max(1, Math.min(90, Number(args.get('days')) || 7));
const gapMs = Math.max(1000, Number(args.get('gap-ms')) || TURN_GAP_MS_DEFAULT);
const maxCalls = Math.max(1, Number(args.get('max')) || 2);
const file = path.resolve(ROOT, String(args.get('file') || 'state/tool-calls.jsonl'));
const outPath = args.get('out') ? path.resolve(String(args.get('out'))) : null;
const customExclude = String(args.get('exclude') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const exclude = customExclude.length ? customExclude : STRUCTURAL_TOOL_PATTERNS;
const excludeLabel = customExclude.length ? `自定义（${customExclude.join(', ')}）` : '结构性工具预设';

const rows = [];
try {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch {}
  }
} catch (error) {
  console.error(`读取 ${file} 失败：${error?.message ?? error}`);
  process.exit(1);
}

const cutoff = Date.now() - days * DAY;
const recent = rows.filter((row) => Date.parse(String(row?.time ?? '')) >= cutoff);
const callTotal = recent.filter((r) => r.type === 'call').length;
const actionRows = filterToolRows(recent, { exclude });
const excludedCount = callTotal - actionRows.length;

function section(title, windows) {
  const summary = summarizeTurnWindows(windows, { maxCallsPerTurn: maxCalls });
  const lines = [
    `## ${title}`,
    '',
    `- 回合数 ${summary.turns}，总调用 ${summary.totalCalls}，均值 ${summary.avgCalls}/轮，p50 ${summary.p50}，p95 ${summary.p95}，max ${summary.max}`,
    `- 超标（>${maxCalls}）回合：${summary.overLimit}${summary.turns ? `（${Math.round((summary.overLimit / summary.turns) * 100)}%）` : ''}`
  ];
  const offenders = windows.filter((w) => w.calls > maxCalls).sort((a, b) => b.calls - a.calls).slice(0, 10);
  if (offenders.length) {
    lines.push('', '| 开始时间 | 会话 | 调用数 | 主要工具 |', '| --- | --- | --- | --- |');
    for (const w of offenders) {
      const tools = Object.entries(w.tools).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([name, n]) => `${name}×${n}`).join(' ');
      lines.push(`| ${stamp(w.startAt)} | ${w.key || w.sessionId.slice(0, 13)} | ${w.calls} | ${tools} |`);
    }
  } else {
    lines.push('', '没有超标回合。');
  }
  return lines;
}

const lines = [
  `# 单轮工具调用统计 ${stamp(Date.now())}`,
  '',
  `- 数据：${file}（最近 ${days} 天，${callTotal} 次 call）`,
  `- 上限口径：${maxCalls} 次/轮；时间窗分组间隔 > ${Math.round(gapMs / 1000)}s`,
  `- 排除口径（第②节用）：${excludeLabel}，剔除 ${excludedCount} 次`,
  ''
];
lines.push(...section(`① 全部 · 时间窗（gap ${Math.round(gapMs / 1000)}s）`, groupTurnWindows(recent, { gapMs })), '');
lines.push(...section(`② 排除后 · 时间窗（剩 ${actionRows.length} 次 call）`, groupTurnWindows(actionRows, { gapMs })), '');
const turnWindows = groupTurnsByKey(recent);
lines.push(...section(`③ 真实 turn 分组（仅 2026-10-24 15:09 后可信的行，共 ${turnWindows.reduce((n, w) => n + w.calls, 0)} 次 call）`, turnWindows), '');
const actionTurnWindows = groupTurnsByKey(actionRows);
lines.push(...section(`④ 真实 turn + 排除结构性（最终口径，剩 ${actionTurnWindows.reduce((n, w) => n + w.calls, 0)} 次 call）`, actionTurnWindows));

const report = lines.join('\n') + '\n';
console.log(report);
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(`已写入 ${outPath}`);
}
