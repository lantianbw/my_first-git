// observability/health — 把各项健康信号判成一个健康级别（纯函数，无 IO、无时钟）
//
// 契约：docs/module-contract.md v1.1（A.10 观测 / B.1 spec / D 表 obs/health「fail open」）
// deps：now                      （optional：无）
// 失败策略：fail-open            （依据：D 表 obs/health「自检失败只影响看板数字」）
// 单测：tests/health.test.mjs
//
// 为什么需要：现在「桥到底好不好」是 runHealthCheckV2 里一边探端口、一边读 token 用量、
// 一边拼日志行、一边决定要不要喊主人——判据和副作用缠在一起，想验证「积压 200 和 201 的差别」
// 就得把 OneBot 和 DSH 都拉起来。这里只留判据：给一组布尔/数值，得到级别、原因列表、逐项结果。
// 端口探测、token 统计、发提醒都留在中枢，由它把结果喂进来。
//
// 边界：不探端口、不读 state、不读时钟（now 必须注入）、不发提醒、不写 health.log。
// 不判断「该不该告警」——那是调用方根据 level 的边沿决定的（snowlumaHealthSnapshot 的 degraded 位）。
//
// 命名注：A.10 / E.1 把该模块记为 `obs/health`（`src/obs/health.js`）。本次按任务要求落在
// `src/observability/health.js` 且 spec.name='observability/health'，与自身路径一致、但与 A 节的
// 域名不一致；装配前必须与中枢 registry 里的键对齐，否则会被 E.1 的 name==<domain>/<basename>
// 校验拒装（调用方拿到 DEP_MISSING 而不是这份判定）。
//
// 判定顺序（先硬后软）：
//   dshOk / onebotOk === false        → unhealthy（收发本身断了）
//   snowlumaOk === false              → degraded（链路可降级，不影响收发）
//   lastEventAt 距今 > staleMs         → degraded（默认 30 分钟）
//   unreadBacklog > backlogMax         → degraded（默认 200）
//   costToday ≥ costDailyLimit×ratio   → degraded（默认 50 的 85%）
//   其余                               → healthy（reasons 固定给 'all checks passed'）

/** 缺省阈值：与 bridge.js 的 30 分钟静默告警、200 积压、¥50 日硬停（Q3）对齐。 */
const DEFAULTS = Object.freeze({
  staleMs: 30 * 60 * 1000,
  backlogMax: 200,
  costDailyLimit: 50,
  costWarnRatio: 0.85
});

export const spec = Object.freeze({
  name: 'observability/health',
  version: '1.0.0',
  deps: Object.freeze(['now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

const constant = (value, fallback, { min = 0, max = Infinity } = {}) => {
  if (!Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
};

/**
 * 判定一次健康级别。
 *
 * @param {object}  input
 * @param {boolean} [input.dshOk]        DSH 可达；只有显式 false 才算坏（缺省=未知，不参与判定）
 * @param {boolean} [input.onebotOk]     OneBot 连接
 * @param {boolean} [input.snowlumaOk]   SnowLuma 小号在线（false 只降级，因为收发还有别的路径）
 * @param {number}  [input.lastEventAt]  最近一次收到事件的时间戳；缺省则不判新鲜度
 * @param {number}  [input.unreadBacklog] 未读积压条数，缺省 0
 * @param {number}  [input.costToday]    今日成本（与 costDailyLimit 同币种），缺省 0
 * @param {number}  input.now            毫秒时间戳（必填，本模块不读系统时钟）
 * @param {object}  [input.limits]       { staleMs, backlogMax, costDailyLimit, costWarnRatio }
 * @returns {{ level: 'healthy'|'degraded'|'unhealthy', reasons: string[], checks: {name: string, ok: boolean}[] }}
 */
export function judgeHealth({ dshOk, onebotOk, snowlumaOk, lastEventAt, unreadBacklog, costToday, now, limits } = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('judgeHealth: now 必须是毫秒时间戳（由调用方注入，本模块不读系统时钟）');
  }

  const tune = limits ?? {};
  const staleMs = constant(tune.staleMs, DEFAULTS.staleMs, { min: 1 });
  const backlogMax = constant(tune.backlogMax, DEFAULTS.backlogMax, { min: 0 });
  const costDailyLimit = constant(tune.costDailyLimit, DEFAULTS.costDailyLimit, { min: 1 });
  const costWarnRatio = constant(tune.costWarnRatio, DEFAULTS.costWarnRatio, { min: 0.01, max: 1 });

  const checks = [];
  const reasons = [];
  let hardDown = false;

  // 1. 硬故障：收发断了，任何降级都救不回来
  const dshBad = dshOk === false;
  checks.push({ name: 'dsh', ok: !dshBad });
  if (dshBad) {
    hardDown = true;
    reasons.push('dsh 不可达');
  }

  const onebotBad = onebotOk === false;
  checks.push({ name: 'onebot', ok: !onebotBad });
  if (onebotBad) {
    hardDown = true;
    reasons.push('onebot 未连接');
  }

  // 2. 软故障：小号离线只是降级，消息还能走
  const snowlumaBad = snowlumaOk === false;
  checks.push({ name: 'snowluma', ok: !snowlumaBad });
  if (snowlumaBad) reasons.push('snowluma 离线（可降级，不影响收发）');

  // 3. 事件新鲜度：没有 lastEventAt 说明还没有事件（刚起进程），不做判定
  const hasEventAt = Number.isFinite(lastEventAt) && lastEventAt > 0;
  const silentMs = hasEventAt ? Math.max(0, now - lastEventAt) : null;
  const stale = hasEventAt && silentMs > staleMs;
  checks.push({ name: 'events', ok: !stale });
  if (stale) reasons.push(`事件静默 ${silentMs}ms（阈值 ${staleMs}ms）`);

  // 4. 积压：超过上限说明消费端跟不上
  const backlog = constant(unreadBacklog, 0, { min: 0 });
  const backlogBad = backlog > backlogMax;
  checks.push({ name: 'backlog', ok: !backlogBad });
  if (backlogBad) reasons.push(`未读积压 ${backlog}（上限 ${backlogMax}）`);

  // 5. 成本：到 85% 就该降级，别等到硬停那一刻
  const cost = constant(costToday, 0, { min: 0 });
  const warnAt = costDailyLimit * costWarnRatio;
  const costBad = cost >= warnAt;
  checks.push({ name: 'cost', ok: !costBad });
  if (costBad) reasons.push(`今日成本 ${cost}/${costDailyLimit} 已达 ${Math.round(costWarnRatio * 100)}%`);

  if (hardDown) return { level: 'unhealthy', reasons, checks };
  if (reasons.length > 0) return { level: 'degraded', reasons, checks };
  return { level: 'healthy', reasons: ['all checks passed'], checks };
}
