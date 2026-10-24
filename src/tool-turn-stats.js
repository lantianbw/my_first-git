// 工具调用日志的「单轮调用数」统计（验收口径：单轮工具 ≤2 次）。
//
// 为什么按时间窗而不是按日志里的 turn 字段分组：turn/start 在重连/会话切换时可能漏发，
// 自增兜底计数会出现「turn #1 跨 7 小时、43 次调用」的坏分组（2026-10-24 交接遗留 #2）。
// 同一会话内相邻两次工具调用间隔超过 gapMs 就视为新的一轮：一轮内的思考间隙很少
// 超过一两分钟，而两轮唤醒之间通常隔几分钟到几小时。
//
// 纯逻辑在此，CLI 在 scripts/tool-turn-stats.mjs。

export const TURN_GAP_MS_DEFAULT = 90_000;

/**
 * 结构性工具预设（子串匹配，命中即排除）：等待长轮询、已读、快照读取、记忆/心情/日记簿记。
 * 这些是 reserved2 每轮的固定开销，不是「AI 决定做的事」；评估「单轮 ≤2 次」时排除它们，
 * 只数对外动作（发消息/表情/图片/戳一戳/搜索等）。
 */
export const STRUCTURAL_TOOL_PATTERNS = Object.freeze([
  'wait_for_messages', 'mark_read', 'get_prompt', 'get_unread', 'get_recent', 'get_my_recent',
  'social_state', 'qq_brief', 'memory', 'memo_', 'mood_', 'diary_'
]);

/** 按子串列表过滤 call 行（exclude 里的子串命中工具名即剔除，大小写不敏感）。 */
export function filterToolRows(rows, { exclude = [] } = {}) {
  const patterns = (Array.isArray(exclude) ? exclude : [])
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (!patterns.length) return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object' && r.type === 'call') : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || typeof row !== 'object' || row.type !== 'call') return false;
    const tool = String(row.tool ?? '').toLowerCase();
    return !patterns.some((pattern) => tool.includes(pattern));
  });
}

/**
 * 按日志里的真实 turn 号分组（sessionId + turn）。
 * 只收 `since` 之后且 turn>0 的行：2026-10-24 15:09（本地）起 bridge 才把 DSH 真实回合号
 * 写进日志，更早的 turn 字段是自增兜底、不可信（多个真实回合会被并成同一个假 turn）。
 * 返回与 groupTurnWindows 同结构的窗口，可共用 summarizeTurnWindows。
 */
export const RELIABLE_TURN_SINCE_MS = Date.parse('2026-10-24T15:09:00+08:00');

export function groupTurnsByKey(rows, { since = RELIABLE_TURN_SINCE_MS } = {}) {
  const cutoff = Number.isFinite(Number(since)) ? Number(since) : 0;
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.type !== 'call') continue;
    const t = Date.parse(String(row.time ?? ''));
    if (!Number.isFinite(t) || t < cutoff) continue;
    const sessionId = String(row.sessionId ?? '');
    const turn = Number(row.turn);
    if (!sessionId || !Number.isFinite(turn) || turn <= 0) continue;
    const key = `${sessionId}|${turn}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { sessionId, key: String(row.key ?? ''), startAt: t, endAt: t, calls: 0, tools: {}, turns: [turn] };
      byKey.set(key, entry);
    }
    entry.endAt = Math.max(entry.endAt, t);
    entry.calls += 1;
    const tool = String(row.tool ?? '(unknown)');
    entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
  }
  return [...byKey.values()].sort((a, b) => a.startAt - b.startAt);
}

const callRowsOf = (rows) => {
  const list = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.type !== 'call') continue;
    const t = Date.parse(String(row.time ?? ''));
    if (!Number.isFinite(t)) continue;
    const sessionId = String(row.sessionId ?? '');
    if (!sessionId) continue;
    list.push({ t, sessionId, tool: String(row.tool ?? '(unknown)'), turn: Number(row.turn) || 0, key: String(row.key ?? '') });
  }
  return list;
};

/**
 * 把 call 行折成回合窗口：同一 sessionId 内，相邻两次调用间隔 ≤ gapMs 归入同一轮。
 * 返回按开始时间排序的窗口数组：
 *   { sessionId, key, startAt, endAt, calls, tools: {工具名: 次数}, turns: [日志里的 turn 号] }
 */
export function groupTurnWindows(rows, { gapMs = TURN_GAP_MS_DEFAULT } = {}) {
  const window = Math.max(1000, Math.round(Number(gapMs) || TURN_GAP_MS_DEFAULT));
  const bySession = new Map();
  for (const row of callRowsOf(rows)) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  const windows = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => a.t - b.t);
    let current = null;
    for (const row of list) {
      if (!current || row.t - current.endAt > window) {
        current = { sessionId, key: row.key, startAt: row.t, endAt: row.t, calls: 0, tools: {}, turns: new Set() };
        windows.push(current);
      }
      current.endAt = row.t;
      current.calls += 1;
      current.tools[row.tool] = (current.tools[row.tool] ?? 0) + 1;
      if (row.turn > 0) current.turns.add(row.turn);
    }
  }
  for (const w of windows) {
    w.turns = [...w.turns].sort((a, b) => a - b);
    if (!w.key) w.key = '';
  }
  windows.sort((a, b) => a.startAt - b.startAt);
  return windows;
}

/** 分布汇总：p50/p95/max、单轮均值、超过 maxCallsPerTurn 的窗口数。 */
export function summarizeTurnWindows(windows, { maxCallsPerTurn = 2 } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  const sorted = list.map((w) => w.calls).sort((a, b) => a - b);
  const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  return {
    turns: list.length,
    totalCalls: total,
    avgCalls: list.length ? Math.round((total / list.length) * 10) / 10 : 0,
    p50: pick(50),
    p95: pick(95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    maxCallsPerTurn,
    overLimit: list.filter((w) => w.calls > maxCallsPerTurn).length
  };
}
