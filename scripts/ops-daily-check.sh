#!/usr/bin/env bash
# 每日只读巡检：只采集事实写一份报告，绝不重启服务、不写业务状态、不改配置。
# 由 crontab 每天 09:05 调用；报告落在 /root/dsh-run/daily-check-YYYYMMDD.log，保留最近 14 份。
#
# 2026-10-29（M5 / 待办 §6-7）新增三项审计指标，都在本文件末尾的 node 段里算：
#   -- guard-hits ---------- entity-blocked / kinship-blocked / preset-echo 各自次数
#   -- kinship-recurrence -- 称呼被拦后是否在同一会话复发 + 已落地的边界档案数
#   -- group-share --------- 近 24h 模型发言的群聊占比
# 口径与限制写在 node 段的注释里；三段都只读文件，不写 state、不 restart。
set -u

# 路径可覆盖只为「演练/回放」：生产 cron 不要设置这三个变量。
OUT_DIR="${OPS_OUT_DIR:-/root/dsh-run}"
STATE="${OPS_STATE_DIR:-/opt/qq-bridge/state}"
LOG="${OPS_LOG:-/root/dsh-run/bridge.log}"
OUT="$OUT_DIR/daily-check-$(date +%Y%m%d).log"

mkdir -p "$OUT_DIR"

{
  echo "== $(date '+%F %T %Z') =="

  echo "-- service --"
  systemctl is-active qq-bridge
  systemctl show qq-bridge -p ActiveEnterTimestamp --value

  echo "-- health --"
  grep '\[health\]' "$LOG" | tail -3

  # ---- 审计指标（M5）----
  # 为什么用 node 而不是 grep/awk：group-share 要按毫秒时间戳筛 24h、还要对 JSONL 去重；
  # kinship 复发要按会话聚合并读 social-v2.json。这些用 shell 拼会出「看起来对、边界错」的数。
  # node 缺失时只跳过这三段，其余巡检照常（巡检脚本本身不能因为一个指标挂掉）。
  if command -v node >/dev/null 2>&1; then
    node - "$STATE" <<'OPS_AUDIT_NODE'
'use strict';
// 只读：读 qq-activity.log[+.1] / token-usage.jsonl / social-v2.json，不做任何写入。
const fs = require('node:fs');
const path = require('node:path');

const STATE = process.argv[2] || '/opt/qq-bridge/state';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const readText = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
};
const readMtime = (p) => {
  try { return fs.statSync(p).mtime; } catch { return null; }
};
const pad = (n) => String(n).padStart(2, '0');
const md = (d) => (d ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '?');

// ---------- 1) 三类守卫命中次数 ----------
// activity 行格式：`[HH:MM:SS] [guard] entity-blocked (group:…): 词`
// 关键限制：行内只有时分秒、没有日期。所以这里报「窗口」而不是「今天」——
// 日界只能靠 500 行轮转（.log / .log.1）近似，给一个假的「日增」比不给更糟。
const ACT_FILES = [path.join(STATE, 'qq-activity.log'), path.join(STATE, 'qq-activity.log.1')];
const actAll = ACT_FILES.map(readText).join('\n');
const actCur = readText(ACT_FILES[0]);
const hits = (re) => (actAll.match(re) || []).length;
const stamps = (actCur.match(/^\[\d{2}:\d{2}:\d{2}\]/gm) || []).map((s) => s.slice(1, 9));
const winFrom = stamps.length ? stamps[0] : '--:--:--';
const winTo = stamps.length ? stamps[stamps.length - 1] : '--:--:--';
const winFromDate = md(readMtime(ACT_FILES[1]) ?? readMtime(ACT_FILES[0]));
const winToDate = md(readMtime(ACT_FILES[0]));

console.log('-- guard-hits --');
console.log(
  `entity-blocked=${hits(/\[guard\] entity-blocked/g)} ` +
  `kinship-blocked=${hits(/\[guard\] kinship-blocked/g)} ` +
  `preset-echo=${hits(/\[guard\] preset-echo/g)}` +
  `  (窗口 ${winFromDate} ${winFrom}→${winToDate} ${winTo}，qq-activity.log[+.1]，行内无日期)`
);

// ---------- 2) 称呼复发 ----------
// 「复发」= 同一会话被拦第 2 次起：第 1 次是首次施压，第 2 次说明上一轮写的边界没拦住。
// 边界档案 = 拦过一次后写进 memberImpressions 的 noKinshipTitle（5.3：不会自动过期）。
const perKey = new Map();
for (const m of actAll.matchAll(/\[guard\] kinship-blocked \(([^)]+)\)/g)) {
  perKey.set(m[1], (perKey.get(m[1]) || 0) + 1);
}
const kinTotal = [...perKey.values()].reduce((a, n) => a + n, 0);
const repeatConv = [...perKey.entries()].filter(([, n]) => n > 1);
const repeatExtra = repeatConv.reduce((a, [, n]) => a + (n - 1), 0);

let boundaryPeople = 0;
let boundaryConv = 0;
let convTotal = 0;
let socialReadable = true;
try {
  const social = JSON.parse(readText(path.join(STATE, 'social-v2.json')) || '{}');
  const convs = social.conversations && typeof social.conversations === 'object' ? social.conversations : {};
  convTotal = Object.keys(convs).length;
  for (const conv of Object.values(convs)) {
    const mi = (conv && conv.memberImpressions) || {};
    const n = Object.keys(mi).filter((name) => mi[name] && mi[name].noKinshipTitle === true).length;
    if (n > 0) {
      boundaryPeople += n;
      boundaryConv += 1;
    }
  }
} catch {
  socialReadable = false; // 读不到就显式报错，不要拿 0 冒充「没有边界档案」
}
const boundaryText = socialReadable
  ? `边界档案 noKinshipTitle=${boundaryPeople} 人/${boundaryConv} 会话（共 ${convTotal} 会话）`
  : '边界档案 读取失败（social-v2.json 解析不了）';

console.log('-- kinship-recurrence --');
console.log(
  `命中会话=${perKey.size} 次数=${kinTotal} ` +
  `复发(同会话≥2次)=${repeatExtra} 次/${repeatConv.length} 会话  ${boundaryText}`
);

// ---------- 3) 群发言占比 ----------
// 口径：token-usage.jsonl 的 k=turn 行，按 sid|turn 去重（一次发言会跨多个 step，
// 不去重会把「工具多的大回合」算成多次发言），取近 24h（t 是毫秒时间戳，唯一带日期的时间源）。
// group: 前缀算群，其余（private:）算私聊。base 行是累计基线，不是发言，排除。
const seenTurn = new Set();
const perConvTurn = new Map();
let turnTotal = 0;
let turnGroup = 0;
for (const line of readText(path.join(STATE, 'token-usage.jsonl')).split('\n')) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  if (!rec || rec.k !== 'turn') continue;
  if (!(Number(rec.t) >= NOW - DAY)) continue;
  const id = `${rec.sid}|${rec.turn}`;
  if (seenTurn.has(id)) continue;
  seenTurn.add(id);
  turnTotal += 1;
  const key = String(rec.key || '(unknown)');
  perConvTurn.set(key, (perConvTurn.get(key) || 0) + 1);
  if (key.startsWith('group:')) turnGroup += 1;
}
const share = turnTotal ? ((turnGroup * 100) / turnTotal).toFixed(1) : '0.0';
const mix = [...perConvTurn.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k}=${n}`)
  .join(' ');

console.log('-- group-share --');
console.log(
  `近24h 发言=${turnTotal} 群=${turnGroup} (${share}%) 私聊=${turnTotal - turnGroup}` +
  (mix ? `  按会话 ${mix}` : '  按会话 -')
);
OPS_AUDIT_NODE
  else
    echo "-- guard-hits --"
    echo "node 不存在，跳过审计指标（guard-hits / kinship-recurrence / group-share）"
  fi

  echo "-- rotation-count --"
  grep -c '\[rotation\]' "$LOG"

  echo "-- warn-count --"
  grep -c '⚠️' "$LOG"

  echo "-- fatal-errors --"
  grep -cE 'ERR_MODULE_NOT_FOUND|ReferenceError|SyntaxError' "$LOG"

  echo "-- slang --"
  grep -i 'slang' "$LOG" | tail -3

  echo "-- shadows --"
  grep -E 'inbound/message|\[router\]|\[triggers\]|影子不一致' "$LOG" | tail -6

  echo "-- owner-last-turn --"
  grep 'private:1843979560' "$STATE/token-usage.jsonl" | tail -1

  echo "-- archive --"
  ls -1 "$STATE/session-archive" 2>/dev/null | tail -3

  echo "-- disk --"
  df -h / | tail -1

  echo "-- tail --"
  tail -5 "$LOG"
} > "$OUT" 2>&1

# 只保留最近 14 份报告
ls -1t "$OUT_DIR"/daily-check-*.log 2>/dev/null | tail -n +15 | xargs -r rm -f
