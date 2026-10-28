import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, judgeHealth } from '../src/observability/health.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 28, 3, 49, 56);

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

test('spec：契约字段齐备且已冻结；now 必填', () => {
  assert.equal(spec.name, 'observability/health');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  // 纯函数不读系统时钟：now 不给就报错，而不是悄悄用 Date.now()
  assert.throws(() => judgeHealth({}), /now 必须是毫秒时间戳/);
  assert.throws(() => judgeHealth({ now: '2026-10-28' }), TypeError);
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

test('dsh 不通 → unhealthy（硬故障）', () => {
  const r = judge({ dshOk: false });

  assert.equal(r.level, 'unhealthy');
  assert.equal(checkOf(r, 'dsh').ok, false);
  assert.equal(r.reasons.some((s) => s.includes('dsh')), true);
  // 硬故障时其它项仍要如实反映
  assert.equal(checkOf(r, 'onebot').ok, true);
});

test('onebot 断开 → unhealthy（硬故障）', () => {
  const r = judge({ onebotOk: false });

  assert.equal(r.level, 'unhealthy');
  assert.equal(checkOf(r, 'onebot').ok, false);
  assert.match(r.reasons.join('|'), /onebot/);
});

test('snowluma 离线 → degraded，不升级成 unhealthy', () => {
  const r = judge({ snowlumaOk: false });

  assert.equal(r.level, 'degraded');
  assert.equal(checkOf(r, 'snowluma').ok, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /snowluma/);
});

test('事件静默：超过 30 分钟降级；恰好 30 分钟不算超', () => {
  // 边界：恰好等于阈值不降级（规则是 `>`）
  assert.equal(judge({ lastEventAt: NOW - 30 * MIN }).level, 'healthy');
  assert.equal(judge({ lastEventAt: NOW - 30 * MIN - 1 }).level, 'degraded');

  const r = judge({ lastEventAt: NOW - 45 * MIN });
  assert.equal(r.level, 'degraded');
  assert.equal(checkOf(r, 'events').ok, false);
  assert.match(r.reasons[0], /事件静默/);
  assert.match(r.reasons[0], new RegExp(String(45 * MIN)), '原因里要带出静默时长');

  // 没有 lastEventAt（刚起进程还没收到事件）→ 不判新鲜度
  assert.equal(judge({ lastEventAt: null }).level, 'healthy');
  assert.equal(judge({ lastEventAt: undefined }).level, 'healthy');
});

test('未读积压：200 不降级，201 降级', () => {
  assert.equal(judge({ unreadBacklog: 200 }).level, 'healthy');
  assert.equal(judge({ unreadBacklog: 201 }).level, 'degraded');

  const r = judge({ unreadBacklog: 500 });
  assert.equal(checkOf(r, 'backlog').ok, false);
  assert.match(r.reasons[0], /积压 500/);
  assert.match(r.reasons[0], /200/);
});

test('成本：达 85% 边界即降级（含等于），84.99% 不降级', () => {
  const limits = { costDailyLimit: 100 };

  assert.equal(judge({ costToday: 84.99, limits }).level, 'healthy');
  assert.equal(judge({ costToday: 85, limits }).level, 'degraded', '恰好 85% 就该降级（规则是 ≥）');

  const r = judge({ costToday: 120, limits });
  assert.equal(checkOf(r, 'cost').ok, false);
  assert.match(r.reasons[0], /120\/100/);
  assert.match(r.reasons[0], /85%/);
});

test('多因叠加：硬故障压过软故障，reasons 逐条列出且都标 ok:false', () => {
  const r = judge({
    dshOk: false,
    snowlumaOk: false,
    lastEventAt: NOW - 2 * 60 * MIN,
    unreadBacklog: 999,
    costToday: 50
  });

  assert.equal(r.level, 'unhealthy', '有硬故障就是 unhealthy');
  assert.equal(r.reasons.length, 5, '四个降级原因 + dsh 共 5 条');
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.name),
    ['dsh', 'snowluma', 'events', 'backlog', 'cost']
  );
  assert.equal(checkOf(r, 'onebot').ok, true, '唯一正常的那项不能被误标');

  // 只有软故障时，级别必须停在 degraded
  const soft = judge({ snowlumaOk: false, unreadBacklog: 300 });
  assert.equal(soft.level, 'degraded');
  assert.equal(soft.reasons.length, 2);
});

test('limits 缺省：30 分钟 / 200 条 / ¥50 的 85%，且可整体覆盖', () => {
  // 缺省阈值生效
  assert.equal(judge({ lastEventAt: NOW - 30 * MIN - 1 }).level, 'degraded');
  assert.equal(judge({ unreadBacklog: 201 }).level, 'degraded');
  assert.equal(judge({ costToday: 42.5 }).level, 'degraded', '默认日上限 50 × 85% = 42.5');

  // 自定义阈值：同样的输入在新阈值下不再降级
  const tight = { staleMs: 1_000, backlogMax: 5, costDailyLimit: 10, costWarnRatio: 0.5 };
  assert.equal(judge({ lastEventAt: NOW - 2_000, limits: tight }).level, 'degraded');
  assert.equal(judge({ unreadBacklog: 6, limits: tight }).level, 'degraded');
  assert.equal(judge({ costToday: 5, limits: tight }).level, 'degraded');

  const loose = { staleMs: 24 * 60 * MIN, backlogMax: 1_000, costDailyLimit: 1_000 };
  assert.equal(judge({ lastEventAt: NOW - 60 * MIN, unreadBacklog: 900, costToday: 100, limits: loose }).level, 'healthy');

  // 非法 limits 回落到缺省，而不是把判定搞崩
  assert.equal(judge({ unreadBacklog: 201, limits: { backlogMax: -5 } }).level, 'degraded');
  assert.equal(judge({ unreadBacklog: 201, limits: null }).level, 'degraded');
});
