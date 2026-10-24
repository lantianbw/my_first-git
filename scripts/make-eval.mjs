#!/usr/bin/env node
// 把最近 N 天的对话样本合成为人工评估表。
//
// 用法：
//   node scripts/make-eval.mjs                     # 最近 3 天 → E:\DSH\_pad\eval-<今天>.md
//   node scripts/make-eval.mjs --days 5 --out D:\x.md
//
// 每条留「像人？/接错？/太会接话？」三列空位，供人工或 AI 逐条标注。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function sampleDirFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const dir = String(cfg?.socialV2?.samples?.dir ?? '').trim();
    if (dir) return dir;
  } catch {}
  return path.join(ROOT, 'samples');
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

function parseSample(content) {
  const rows = [];
  let key = '';
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const header = /^##\s+(.+)$/.exec(line.trim());
    if (header) { key = header[1].trim(); continue; }
    const msg = /^(\d{2}:\d{2})\s+([^：]+)：(.*)$/.exec(line);
    if (!msg) continue;
    rows.push({ key, time: msg[1], sender: msg[2].trim(), text: msg[3].trim() });
  }
  return rows;
}

const args = parseArgs(process.argv.slice(2));
const days = Math.max(1, Math.min(30, Number(args.get('days')) || 3));
const today = new Date();
const cutoff = new Date(today.getTime() - (days - 1) * DAY);
cutoff.setHours(0, 0, 0, 0);
const cutoffKey = dateKey(cutoff);
const dir = path.resolve(String(args.get('dir') || sampleDirFromConfig()));
const outPath = path.resolve(String(args.get('out') || path.join('E:\\DSH\\_pad', `eval-${dateKey(today)}.md`)));

let files = [];
try {
  files = fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}_\d{4}\.md$/.test(name))
    .filter((name) => name.slice(0, 10) >= cutoffKey)
    .sort();
} catch (error) {
  console.error(`读取样本目录失败：${dir}（${error?.message ?? error}）`);
  process.exit(1);
}

const allRows = [];
for (const name of files) {
  const date = name.slice(0, 10);
  for (const row of parseSample(fs.readFileSync(path.join(dir, name), 'utf8'))) {
    allRows.push({ date, ...row });
  }
}

const lines = [
  `# 对话评估 ${dateKey(today)}`,
  '',
  `- 样本目录：${dir}`,
  `- 范围：${cutoffKey} ~ ${dateKey(today)}（最近 ${days} 天），文件 ${files.length} 个，消息 ${allRows.length} 条`,
  '- 标注：每列留空，人工或 AI 填「是/否 + 一句原因」；重点看「像人？/接错？/太会接话？」。',
  '',
  '| 日期 | 时间 | 会话 | 发送者 | 正文 | 像人？ | 接错？ | 太会接话？ |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |'
];
for (const row of allRows) {
  lines.push(`| ${escapeCell(row.date)} | ${escapeCell(row.time)} | ${escapeCell(row.key)} | ${escapeCell(row.sender)} | ${escapeCell(row.text)} |  |  |  |`);
}
if (!allRows.length) lines.push('| - | - | - | - | 这三天没有可评估的样本 |  |  |  |');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`已生成 ${outPath}（${files.length} 个样本文件，${allRows.length} 条消息）`);
