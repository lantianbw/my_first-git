import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  judgeHealth,
  resolveLimits,
  judgeSelfCheck,
  snowlumaSnapshot,
  sumTokenUsage
} from '../src/observability/health.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 28, 3, 49, 56); // 2026-10-28 11:49:56 +08

/** healthy 基线：六个信号全绿，只有 lastEventAt 给 1 秒前。 */
const BASE = Object.freeze({
  dshOk: true,
  onebotOk: true,
  snowlumaOk: true,
  lastEventAt: NOW - 1_000,
  unreadBacklog: 0,
  costToday: 0,
  now: NOW
});

const judge = (over = {}) => judgeHealth({ ...BASE, ...over });
const checkOf = (result, name) => result.checks.find((c) => c.name === name);

/** 桥自检的阈值口径：12h 陈旧 / 200 积压 / ¥15 硬停 / ¥10 预警。 */
const BRIDGE = resolveLimits();

/** 全绿的端口探测结果（端口 up/down 由调用方注入，本模块不探）。 */
const PORTS_UP = Object.freeze({ 3000: true, 3001: true, 5099: true });
const SELF_CHECK_OK = Object.freeze({
  ports: PORTS_UP,
  bridge: { up: true, port: 3100 },
  dsh: { up: true, port: 8188 },
  connected: true,
  accountOnline: true,
  usage: { newTokens: 1_000_000 },
  dailyInputTokenLimit: 20_000_000
});

const selfCheck = (over = {}) => judgeSelfCheck({ ...SELF_CHECK_OK, ...over });

test('spec：契约字段齐备且已冻结；每个判定都要求注入 now', () => {
  assert.equal(spec.name, 'observability/health');
  assert.equal(spec.version, '1.1.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  // 纯函数不读系统时钟：now 不给就报错，而不是悄悄用 Date.now()
  assert.throws(() => judgeHealth({}), /now 必须是毫秒时间戳/);
  assert.throws(() => judgeHealth({ now: '2026-10-28' }), TypeError);
  assert.throws(() => snowlumaSnapshot({}, {}), /now 必须是毫秒时间戳/);
  assert.throws(() => sumTokenUsage('', {}), /now 必须是毫秒时间戳/);
});

test('resolveLimits：搬来桥的口径 —— 12h / 200 / ¥15 硬停、¥10 预警', () => {
  assert.equal(BRIDGE.staleMs, 12 * HOUR);
  assert.equal(BRIDGE.backlogMax, 200);
  assert.equal(BRIDGE.costDailyLimit, 15);
  assert.ok(Math.abs(BRIDGE.costDailyLimit * BRIDGE.costWarnRatio - 10) < 1e-9, '预警线必须落在 ¥10');

  // 配置改了（A.12 的 Q3 口径 ¥30 预警 / ¥50 硬停）→ 比例跟着走
  const q3 = resolveLimits({ costGate: { warn: 30, stop: 50 } });
  assert.equal(q3.costDailyLimit, 50);
  assert.ok(Math.abs(q3.costDailyLimit * q3.costWarnRatio - 30) < 1e-9);

  // 非正数按缺省；warn > stop 时夹到 1，避免「预警比硬停还晚」
  assert.deepEqual(resolveLimits({ costGate: { warn: -1, stop: 0 } }), BRIDGE);
  assert.deepEqual(resolveLimits({ costGate: null }), BRIDGE);
  assert.equal(resolveLimits({ costGate: { warn: 20, stop: 10 } }).costWarnRatio, 1);
});

test('healthy 基线：全绿时 level=healthy，reasons 给固定文案，六项检查都在', () => {
  const r = judge();

  assert.equal(r.level, 'healthy');
  assert.deepEqual(r.reasons, ['all checks passed']);
  assert.deepEqual(r.checks.map((c) => c.name), ['dsh', 'onebot', 'snowluma', 'events', 'backlog', 'cost']);
  assert.ok(r.checks.every((c) => c.ok), '全绿时每项 ok 都应为 true');

  // 缺省输入也不该抛（未提供的信号不参与判定）
  assert.equal(judgeHealth({ now: NOW }).level, 'healthy');
});

test('硬故障：dsh / onebot 任一为 false 就是 unhealthy，其它项仍如实反映', () => {
  const noDsh = judge({ dshOk: false });
  assert.equal(noDsh.level, 'unhealthy');
  assert.equal(checkOf(noDsh, 'dsh').ok, false);
  assert.equal(checkOf(noDsh, 'onebot').ok, true);
  assert.match(noDsh.reasons.join('|'), /dsh/);

  const noOnebot = judge({ onebotOk: false });
  assert.equal(noOnebot.level, 'unhealthy');
  assert.equal(checkOf(noOnebot, 'onebot').ok, false);
  assert.match(noOnebot.reasons.join('|'), /onebot/);
});

test('事件陈旧 12h 边界：11h59m 不报、恰好 12h 不报、12h01m 报', () => {
  const staleAt = (ms) => judge({ lastEventAt: NOW - ms, limits: BRIDGE });

  assert.equal(staleAt(11 * HOUR + 59 * MIN).level, 'healthy');
  assert.equal(staleAt(12 * HOUR).level, 'healthy', '恰好 12h 不算超（规则是 >）');

  const justOver = staleAt(12 * HOUR + 1);
  assert.equal(justOver.level, 'degraded');
  assert.equal(checkOf(justOver, 'events').ok, false);

  const r = staleAt(12 * HOUR + MIN);
  assert.equal(r.level, 'degraded');
  assert.match(r.reasons[0], /事件静默 43260000ms/);
  assert.match(r.reasons[0], /阈值 43200000ms/);
});

test('未读积压 200 边界：200 不降级、201 降级', () => {
  assert.equal(judge({ unreadBacklog: 200 }).level, 'healthy');
  assert.equal(judge({ unreadBacklog: 201 }).level, 'degraded');

  const r = judge({ unreadBacklog: 500 });
  assert.equal(checkOf(r, 'backlog').ok, false);
  assert.match(r.reasons[0], /积压 500/);
  assert.match(r.reasons[0], /200/);
});

test('成本 ¥10 预警：9.99 不报、10 就报（¥15 硬停时比例 2/3）', () => {
  const costAt = (n) => judge({ costToday: n, limits: BRIDGE });

  assert.equal(costAt(9.99).level, 'healthy');
  assert.equal(costAt(10).level, 'degraded', '¥10 是预警线（含等于）');

  const r = costAt(12.5);
  assert.equal(checkOf(r, 'cost').ok, false);
  assert.match(r.reasons[0], /今日成本 12\.5\/15/);
  assert.match(r.reasons[0], /67%/);
});

test('时间回绕：lastEventAt 在未来（时钟回绕）不算静默，不误报', () => {
  const r = judge({ lastEventAt: NOW + 5 * MIN, limits: BRIDGE });

  assert.equal(r.level, 'healthy');
  assert.equal(checkOf(r, 'events').ok, true);
});

test('缺数据：没给 lastEventAt / 脏数值一律不参与判定，不抛', () => {
  assert.equal(judge({ lastEventAt: null }).level, 'healthy');
  assert.equal(judge({ lastEventAt: 0 }).level, 'healthy');
  assert.equal(judge({ lastEventAt: undefined, unreadBacklog: NaN, costToday: undefined }).level, 'healthy');
  assert.equal(judge({ unreadBacklog: -5 }).level, 'healthy', '负数积压按 0 处理');
});

test('多因叠加：硬故障压过软故障，reasons 逐条列出且都标 ok:false', () => {
  const r = judge({
    dshOk: false,
    snowlumaOk: false,
    lastEventAt: NOW - 13 * HOUR,
    unreadBacklog: 999,
    costToday: 50
  });

  assert.equal(r.level, 'unhealthy', '有硬故障就是 unhealthy');
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.name),
    ['dsh', 'snowluma', 'events', 'backlog', 'cost']
  );
  assert.equal(checkOf(r, 'onebot').ok, true, '唯一正常的那项不能被误标');

  const soft = judge({ snowlumaOk: false, unreadBacklog: 300 });
  assert.equal(soft.level, 'degraded');
  assert.equal(soft.reasons.length, 2);
});

test('judgeHealth 自身缺省（30min / 200 / ¥42.5）≠ 桥的口径，所以自检必须传 resolveLimits()', () => {
  // 模块缺省：夜里 2 小时没消息不报
  assert.equal(judge({ lastEventAt: NOW - 30 * MIN }).level, 'healthy');
  assert.equal(judge({ lastEventAt: NOW - 30 * MIN - 1 }).level, 'degraded');
  assert.equal(judge({ costToday: 42.49 }).level, 'healthy');
  assert.equal(judge({ costToday: 42.5 }).level, 'degraded', '缺省 ¥50 × 85% = 42.5');

  // 桥的口径把同样的输入判成 degraded（12h 内、¥10 就报）
  assert.equal(judge({ lastEventAt: NOW - 2 * HOUR, limits: BRIDGE }).level, 'healthy');
  assert.equal(judge({ costToday: 10, limits: BRIDGE }).level, 'degraded');

  // 非法 limits 回落缺省，而不是把判定搞崩
  assert.equal(judge({ unreadBacklog: 201, limits: { backlogMax: -5 } }).level, 'degraded');
  assert.equal(judge({ unreadBacklog: 201, limits: null }).level, 'degraded');
});

test('自检全绿：五个端口 up + 小号在线 + 用量在上限内 → OK 且没有原因', () => {
  assert.deepEqual(selfCheck(), { status: 'OK', reasons: [] });
});

test('自检单端口 down：只报那一个端口；bridge/dsh 的文案带端口号', () => {
  const one = selfCheck({ ports: { 3000: true, 3001: false, 5099: true } });
  assert.equal(one.status, 'WARN');
  assert.deepEqual(one.reasons, ['3001']);

  const both = selfCheck({ bridge: { up: false, port: 3100 }, dsh: { up: false, port: 0 } });
  assert.deepEqual(both.reasons, ['bridge 3100', 'dsh ?']);
});

test('自检在线=false：WS 没连上、账号被明确标离线都算「小号离线」，未知不算', () => {
  assert.deepEqual(selfCheck({ connected: true, accountOnline: false }).reasons, ['小号离线']);
  assert.deepEqual(selfCheck({ connected: false }).reasons, ['小号离线']);
  assert.deepEqual(selfCheck({ connected: true, accountOnline: null }).reasons, [], '还没问到 ≠ 离线');
});

test('自检 token 超限：严格大于才算，缺省上限 2000 万', () => {
  assert.deepEqual(selfCheck({ usage: { newTokens: 20_000_000 } }).reasons, []);
  assert.deepEqual(selfCheck({ usage: { newTokens: 20_000_001 } }).reasons, ['新输入token 20000001/20000000']);
  assert.deepEqual(selfCheck({ dailyInputTokenLimit: 500, usage: { newTokens: 501 } }).reasons, ['新输入token 501/500']);
  assert.deepEqual(
    selfCheck({ dailyInputTokenLimit: undefined, usage: { newTokens: 20_000_001 } }).reasons,
    ['新输入token 20000001/20000000'],
    '不配就用缺省'
  );
});

test('自检缺数据：什么都没探到 → WARN（不能假装 OK），原因按原顺序列全', () => {
  const r = judgeSelfCheck();

  assert.equal(r.status, 'WARN');
  assert.deepEqual(r.reasons, ['3000', '3001', '5099', 'bridge ?', 'dsh ?', '小号离线']);
});

test('fail open：垃圾入参不抛（now 契约除外），判不出来的按缺省/零值走', () => {
  // 未知不等于坏：非布尔/非数值信号不参与判定
  assert.equal(judgeHealth({ now: NOW, dshOk: 'yes', unreadBacklog: 'x', costToday: {} }).level, 'healthy');

  // 自检拿到 null 也要能判，且不会假装健康
  assert.equal(judgeSelfCheck(null).status, 'WARN');
  assert.deepEqual(judgeSelfCheck(null).reasons, ['3000', '3001', '5099', 'bridge ?', 'dsh ?', '小号离线']);

  // 快照 / 用量：脏数据回落成空快照与全 0
  assert.equal(snowlumaSnapshot(null, { now: NOW }).degraded, false);
  const zeros = { newTokens: 0, allTokens: 0, output: 0 };
  assert.deepEqual(sumTokenUsage(null, { now: NOW }), zeros);
  assert.deepEqual(
    sumTokenUsage([null, 42, 'x', { k: 'turn', b: null }], { now: NOW, dayStart: NOW - HOUR }),
    zeros
  );
});

test('空快照：从没收到过事件包 → 全 null、不告警、不猜故障面', () => {
  const s = snowlumaSnapshot({}, { now: NOW });

  assert.equal(s.lastPacketAgoMs, null);
  assert.equal(s.connected, undefined);
  assert.equal(s.accountOnline, null);
  assert.equal(s.good, null);
  assert.equal(s.goodSource, null);
  assert.equal(s.goodError, null);
  assert.equal(s.lastPacketKind, null);
  assert.equal(s.silent, false);
  assert.equal(s.degraded, false);
  assert.equal(s.hint, null);
});

test('快照 good=false：优先判「SnowLuma 自报接收链路坏」，与静默分开', () => {
  const s = snowlumaSnapshot(
    { connected: true, accountOnline: true, good: false, goodSource: 'heartbeat', lastPacketAt: NOW - 1_000 },
    { now: NOW }
  );

  assert.equal(s.degraded, true);
  assert.equal(s.silent, false, 'good=false 与「静默」是两个故障面');
  assert.equal(s.lastPacketAgoMs, 1_000);
  assert.equal(s.goodSource, 'heartbeat');
  assert.match(s.hint, /good=false/);
  assert.match(s.hint, /\[Hook\]/);
  assert.match(s.hint, /不是桥接的问题/);
});

test('快照静默：10 分钟阈值边界（含等于不算）、文案带分钟数、阈值下限 60s', () => {
  const silentAt = (ago, silenceWarnMs) => snowlumaSnapshot(
    { good: true, lastPacketAt: NOW - ago },
    { now: NOW, silenceWarnMs }
  );

  assert.equal(silentAt(10 * MIN).silent, false, '恰好 10 分钟不算（规则是 >）');

  const over = silentAt(10 * MIN + 1);
  assert.equal(over.silent, true);
  assert.equal(over.degraded, true);
  assert.match(over.hint, /10 分钟没有收到任何事件包/);

  assert.match(silentAt(12 * MIN).hint, /12 分钟没有收到任何事件包/);

  // 配置写得太小也不许低于 60s（心跳 30s 一次，否则天天报）
  assert.equal(silentAt(30_000, 1).silent, false);
  assert.equal(silentAt(61_000, 1).silent, true);
  assert.equal(silentAt(11 * MIN, 'x').silent, true, '非法阈值回落 10 分钟');
});

test('快照时间回绕：lastPacketAt 在 now 之后 → ago 夹到 0，不报静默', () => {
  const s = snowlumaSnapshot({ good: true, lastPacketAt: NOW + 5 * MIN }, { now: NOW });

  assert.equal(s.lastPacketAgoMs, 0, '不返回负数（原实现会给负值）');
  assert.equal(s.silent, false);
  assert.equal(s.degraded, false);
  assert.equal(s.hint, null);
});

test('token 用量口径：只算 k=turn，new=cacheMiss、all=miss+hit+write、output 单独', () => {
  const rows = [
    // k=base 是整条会话的累计快照（含历史、彼此重复），加进来会虚高两个数量级
    { k: 'base', t: NOW - 1_000, b: { cacheMiss: 9e6, cacheHit: 9e6, cacheWrite: 9e6, output: 9e6 } },
    { k: 'turn', t: NOW - 2_000, b: { cacheMiss: 1_000, cacheHit: 200, cacheWrite: 30, output: 7, reasoning: 5 } },
    { k: 'turn', t: NOW - 1_000, b: { cacheMiss: 5, cacheHit: 0, cacheWrite: 0, output: 1 } }
  ];

  assert.deepEqual(
    sumTokenUsage(rows, { now: NOW, dayStart: NOW - HOUR }),
    { newTokens: 1_005, allTokens: 1_235, output: 8 }
  );
});

test('token 用量窗口：坏行跳过、窗口外不算、未来 60s 容差内仍算', () => {
  const text = [
    `{"k":"turn","t":${NOW - 1_000},"b":{"cacheMiss":10}}`,
    '',
    '   ',
    'not json',
    '{"k":"turn"}',
    `{"k":"turn","t":${NOW - 2 * HOUR},"b":{"cacheMiss":999}}`,
    `{"k":"turn","t":${NOW + 30_000},"b":{"cacheMiss":7}}`,
    `{"k":"turn","t":${NOW + 61_000},"b":{"cacheMiss":1_000}}`
  ].join('\n');

  assert.deepEqual(
    sumTokenUsage(text, { now: NOW, dayStart: NOW - HOUR }),
    { newTokens: 17, allTokens: 17, output: 0 },
    '只统计 [起点, now+60s] 内的 k=turn 行'
  );
});

test('token 用量起点：dayStart 含等于、前 1ms 不算；不传则取 now 的本地零点', () => {
  const dayStart = NOW - HOUR;
  const line = (t) => [{ k: 'turn', t, b: { cacheMiss: 1 } }];

  assert.equal(sumTokenUsage(line(dayStart), { now: NOW, dayStart }).newTokens, 1);
  assert.equal(sumTokenUsage(line(dayStart - 1), { now: NOW, dayStart }).newTokens, 0);

  // 缺省零点：用「本地零点」本身验证，避免把测试绑死在某个时区
  const midnight = (() => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  assert.equal(sumTokenUsage(line(midnight), { now: NOW }).newTokens, 1, '零点那一毫秒算今天');
  assert.equal(sumTokenUsage(line(midnight - 1), { now: NOW }).newTokens, 0, '零点前 1ms 算昨天');
});
