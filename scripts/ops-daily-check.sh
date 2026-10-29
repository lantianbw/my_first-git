#!/usr/bin/env bash
# 每日只读巡检：只采集事实写一份报告，绝不重启服务、不写业务状态、不改配置。
# 由 crontab 每天 09:05 调用；报告落在 /root/dsh-run/daily-check-YYYYMMDD.log，保留最近 14 份。
set -u

OUT_DIR=/root/dsh-run
LOG=/root/dsh-run/bridge.log
STATE=/opt/qq-bridge/state
OUT="$OUT_DIR/daily-check-$(date +%Y%m%d).log"

{
  echo "== $(date '+%F %T %Z') =="

  echo "-- service --"
  systemctl is-active qq-bridge
  systemctl show qq-bridge -p ActiveEnterTimestamp --value

  echo "-- health --"
  grep '\[health\]' "$LOG" | tail -3

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
