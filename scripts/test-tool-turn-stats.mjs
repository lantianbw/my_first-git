// 单轮工具调用统计回归：时间窗分组、分布汇总、坏 turn 号不影响分组、排除过滤、真实 turn 分组。
import assert from 'node:assert/strict';
import {
  groupTurnWindows,
  groupTurnsByKey,
  filterToolRows,
  summarizeTurnWindows,
  STRUCTURAL_TOOL_PATTERNS,
  RELIABLE_TURN_SINCE_MS,
  TURN_GAP_MS_DEFAULT
} from '../src/tool-turn-stats.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const call = (t, tool = 'memory', turn = 0, sessionId = 's1', key = 'private:1') =>
  ({ type: 'call', time: iso(t), tool, turn, sessionId, key });
const result = (t, tool = 'memory', turn = 0, sessionId = 's1') =>
  ({ type: 'result', time: iso(t), tool, turn, sessionId, ok: true });

test('分组：间隔 ≤ gapMs 归同一轮，超过则开新轮，result 行不计数', () => {
  const rows = [
    call(T0, 'memory', 3), result(T0 + 400, 'memory', 3),
    call(T0 + 30_000, 'qq_mark_read', 3), result(T0 + 30_500, 'qq_mark_read', 3),
    // 距上一条 10 分钟：新一轮
    call(T0 + 600_000, 'reply', 4), result(T0 + 600_400, 'reply', 4),
    // 另一个会话独立分组
    call(T0 + 1000, 'web_search', 1, 's2', 'group:9')
  ];
  const windows = groupTurnWindows(rows, { gapMs: 90_000 });
  assert.equal(windows.length, 3, `应为 3 个窗口：${JSON.stringify(windows.map((w) => w.calls))}`);
  const [w1, w2, w3] = windows; // 按开始时间排序：s1@T0, s2@T0+1s, s1@T0+10min
  assert.equal(w1.sessionId, 's1');
  assert.equal(w1.calls, 2);
  assert.deepEqual(w1.turns, [3]);
  assert.equal(w2.sessionId, 's2');
  assert.equal(w2.calls, 1);
  assert.equal(w3.sessionId, 's1');
  assert.equal(w3.calls, 1);
  assert.equal(w3.turns[0], 4);
  // 边界：正好等于 gapMs 仍算同一轮
  const edge = groupTurnWindows([call(T0), call(T0 + 90_000)]);
  assert.equal(edge.length, 1);
  // 超过 1 秒的下限保护：gap 传非法值回退默认
  assert.equal(groupTurnWindows([call(T0), call(T0 + TURN_GAP_MS_DEFAULT + 1)], { gapMs: 0 }).length, 2);
});

test('坏数据：坏 turn 号 / 缺时间 / result-only 都不影响分组', () => {
  const rows = [
    { type: 'call', time: 'not-a-time', sessionId: 's1' },
    { type: 'result', time: iso(T0), sessionId: 's1' },
    { type: 'call', time: iso(T0 + 1000), turn: 'x', sessionId: 's1' },
    call(T0 + 2000, 'memory', 7),
    null,
    'garbage'
  ];
  const windows = groupTurnWindows(rows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].calls, 2);
  assert.deepEqual(windows[0].turns, [7], '坏 turn 号被忽略，好 turn 号保留');
});

test('汇总：p50/p95/max/超标数', () => {
  const rows = [];
  // 5 轮：1、1、2、3、6 次调用（间隔 10 分钟）
  const sizes = [1, 1, 2, 3, 6];
  let t = T0;
  for (const size of sizes) {
    for (let i = 0; i < size; i += 1) rows.push(call(t + i * 20_000, 'memory', 0));
    t += 600_000;
  }
  const windows = groupTurnWindows(rows);
  const summary = summarizeTurnWindows(windows, { maxCallsPerTurn: 2 });
  assert.equal(summary.turns, 5);
  assert.equal(summary.totalCalls, 13);
  assert.equal(summary.max, 6);
  assert.equal(summary.p50, 2);
  assert.equal(summary.p95, 6);
  assert.equal(summary.overLimit, 2, '>2 次的是 3 和 6 两轮');
  assert.equal(summarizeTurnWindows([]).turns, 0);
  assert.equal(summarizeTurnWindows([]).max, 0);
});

test('排除过滤：结构性预设命中子串、大小写不敏感，非 call 行不进结果', () => {
  const rows = [
    call(T0, 'mcp__snowluma__qq_wait_for_messages', 1),
    call(T0 + 1000, 'mcp__snowluma__qq_mark_read', 1),
    call(T0 + 2000, 'mcp__snowluma__qq_send_message', 1),
    call(T0 + 3000, 'MEMORY', 1), // 大小写不敏感
    call(T0 + 4000, 'mcp__snowluma__qq_memo_update', 1),
    call(T0 + 5000, 'mcp__web-search-safe__web_search', 1),
    result(T0 + 6000)
  ];
  const kept = filterToolRows(rows, { exclude: STRUCTURAL_TOOL_PATTERNS });
  assert.deepEqual(kept.map((r) => r.tool), [
    'mcp__snowluma__qq_send_message',
    'mcp__web-search-safe__web_search'
  ]);
  // 自定义排除
  assert.equal(filterToolRows(rows, { exclude: ['web_search'] }).length, 5);
  // 排除后的分组：send 与 search 间隔 3s，同一窗
  const windows = groupTurnWindows(kept, { gapMs: 90_000 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].calls, 2);
});

test('真实 turn 分组：since 之后的可信行按 sessionId+turn 折，旧行/坏行剔除', () => {
  const since = RELIABLE_TURN_SINCE_MS;
  const rows = [
    // since 之前的行（老数据 turn 不可信）：不进分组
    call(since - 10_000, 'memory', 9),
    // since 之后：两个会话各两个 turn
    call(since + 60_000, 'qq_send_message', 7, 's1'),
    call(since + 90_000, 'qq_send_sticker', 7, 's1'),
    call(since + 10 * 60_000, 'qq_send_message', 8, 's1'), // 同会话新 turn
    call(since + 120_000, 'web_search', 3, 's2'),
    // 坏 turn（0 / 非数字）：剔除
    call(since + 130_000, 'qq_send_message', 0, 's2')
  ];
  const windows = groupTurnsByKey(rows);
  assert.equal(windows.length, 3);
  const byTurn = new Map(windows.map((w) => [`${w.sessionId}#${w.turns[0]}`, w.calls]));
  assert.equal(byTurn.get('s1#7'), 2);
  assert.equal(byTurn.get('s1#8'), 1);
  assert.equal(byTurn.get('s2#3'), 1);
  assert.ok(!byTurn.has('s2#0'));
  // summarize 兼容
  const summary = summarizeTurnWindows(windows, { maxCallsPerTurn: 2 });
  assert.equal(summary.turns, 3);
  assert.equal(summary.overLimit, 0);
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
