// observability/health — 把健康信号判成级别 / 自检结论（纯函数，无 IO、无时钟）
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
// 五个出口，全部 @pure（副作用一律留在中枢）：
//   judgeHealth()       六项信号 → healthy / degraded / unhealthy（当前以影子模式接入）
//   resolveLimits()     桥自检的阈值口径：12h 陈旧 / 200 积压 / costGate 的 ¥10 预警·¥15 硬停
//   judgeSelfCheck()    runHealthCheckV2 的判定：注入端口 up/down、在线、当日用量 → OK/WARN + reasons
//   snowlumaSnapshot()  snowlumaHealthSnapshot 的判定：注入 now → 快照（silent / degraded / hint）
//   sumTokenUsage()     todayTokenUsage 的口径：吃 jsonl 文本或行 → 当日 new/all/output
//
// 后三个是按契约 A.10「obs/health 需合并」从 bridge.js 搬出来的（:12305 runHealthCheckV2、
// :3755 snowlumaHealthSnapshot、:12260 todayTokenUsage）。阈值、文案、判定顺序都照原实现，
// 与原文的差异逐条写在各自函数的注释里。
//
// 边界：不探端口、不读 state、不读文件、不读时钟（now 必须注入）、不发提醒、不写 health.log。
// 不判断「该不该告警」——那是调用方根据 level / status 的边沿决定的（snowlumaHealth.degraded 位）。
//
// 命名注：A.10 / E.1 把该模块记为 `obs/health`（`src/obs/health.js`）。本次按任务要求落在
// `src/observability/health.js` 且 spec.name='observability/health'，与自身路径一致、但与 A 节的
// 域名不一致；装配前必须与中枢 registry 里的键对齐，否则会被 E.1 的 name==<domain>/<basename>
// 校验拒装（调用方拿到 DEP_MISSING 而不是这份判定）。
//
// judgeHealth 的判定顺序（先硬后软）：
//   dshOk / onebotOk === false        → unhealthy（收发本身断了）
//   snowlumaOk === false              → degraded（链路可降级，不影响收发）
//   lastEventAt 距今 > staleMs         → degraded（缺省 30 分钟）
//   unreadBacklog > backlogMax         → degraded（缺省 200）
//   costToday ≥ costDailyLimit×ratio   → degraded（缺省 50 的 85%）
//   其余                               → healthy（reasons 固定给 'all checks passed'）

/** judgeHealth 的通用缺省。注意：**这不是桥的口径**——桥自检走 resolveLimits()（12h / 200 / ¥15）。 */
const DEFAULTS = Object.freeze({
  staleMs: 30 * 60 * 1000,
  backlogMax: 200,
  costDailyLimit: 50,
  costWarnRatio: 0.85
});

export const spec = Object.freeze({
  name: 'observability/health',
  version: '1.1.0',
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

/** 只有正数才认（与 bridge 里 `Number(x) > 0 ? Number(x) : 缺省` 的写法一致）。 */
const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 端口文案：0 / 缺失 / 非数字一律显示 `?`（原实现 dsh 就是这么显示的）。 */
const portLabel = (port) => (Number(port) > 0 ? String(Number(port)) : '?');

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
export function judgeHealth(input = {}) {
  const { dshOk, onebotOk, snowlumaOk, lastEventAt, unreadBacklog, costToday, now, limits } = input ?? {};
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

  // 3. 事件新鲜度：没有 lastEventAt 说明还没有事件（刚起进程），不做判定。
  //    `Math.max(0, ...)` 同时挡住时钟回绕：lastEventAt 在未来 → 静默 0，不误报。
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

  // 5. 成本：到预警比例就该降级，别等到硬停那一刻
  const cost = constant(costToday, 0, { min: 0 });
  const warnAt = costDailyLimit * costWarnRatio;
  const costBad = cost >= warnAt;
  checks.push({ name: 'cost', ok: !costBad });
  if (costBad) reasons.push(`今日成本 ${cost}/${costDailyLimit} 已达 ${Math.round(costWarnRatio * 100)}%`);

  if (hardDown) return { level: 'unhealthy', reasons, checks };
  if (reasons.length > 0) return { level: 'degraded', reasons, checks };
  return { level: 'healthy', reasons: ['all checks passed'], checks };
}

// ─────────────────────────────────────────────────────────────────────────────
// 以下三段：把 bridge.js 里「判定」与「副作用」拆开的搬运结果（契约 A.10「需合并」）。
//   runHealthCheckV2()       → resolveLimits() + judgeSelfCheck()   （端口探测留在中枢）
//   snowlumaHealthSnapshot() → snowlumaSnapshot()                    （Date.now 改为注入）
//   todayTokenUsage()        → sumTokenUsage()                       （读文件留在中枢）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @pure 桥自检的阈值口径（原 runHealthCheckV2 里的 shadowLimits，逐字段搬出）。
 *
 * - 陈旧放宽到 12 小时：自检固定在 09:00 跑，按 judgeHealth 缺省的 30 分钟会把「夜里没人说话」
 *   天天误报成 degraded；12h 只抓「整个白天一条消息都没进」。
 * - 成本必须与桥自己的闸门（socialV2.costGate，缺省 ¥10 预警 / ¥15 硬停）对齐：模块缺省是
 *   ¥50 的 85%（¥42.5），而桥在 ¥15 就硬停——不对齐的话这个维度永远判不到 degraded。
 * - warn > stop 时比例夹到 1，避免「预警线比硬停还晚」。
 *
 * @param {{costGate?: {warn?: number, stop?: number}}} [input]
 * @returns {{staleMs: number, backlogMax: number, costDailyLimit: number, costWarnRatio: number}}
 */
export function resolveLimits({ costGate } = {}) {
  const gate = costGate && typeof costGate === 'object' && !Array.isArray(costGate) ? costGate : {};
  const stop = positive(gate.stop, 15);
  const warn = positive(gate.warn, 10);
  return {
    staleMs: 12 * 3600 * 1000,
    backlogMax: DEFAULTS.backlogMax,
    costDailyLimit: stop,
    costWarnRatio: Math.min(1, warn / stop)
  };
}

/** healthSettings 缺省的单日新输入上限（2000 万 ≈ 最忙一天的 2 倍）。 */
const DEFAULT_DAILY_INPUT_LIMIT = 20_000_000;

/**
 * @pure 每日自检的判定：注入「端口探测结果 + 在线状态 + 当日用量」，得到 OK/WARN 与原因列表。
 *
 * 原实现（runHealthCheckV2）在这里之前先 probePort() 五个端口、读 token-usage.jsonl、
 * 读会话算积压；这些都不搬——端口 up/down 由调用方探测后注入，本函数只负责「怎么判」。
 * reasons 的顺序与文案照原实现（`3000` / `3001` / `5099` / `bridge <port>` / `dsh <port|?>` /
 * 小号离线 / `新输入token n/limit`），status 仍是「reasons 非空即 WARN」。
 *
 * 与原文的差异：bridge 端口缺失时显示 `?`（原实现由调用方兜底成 3100，不会缺）。
 *
 * @param {object} [input]
 * @param {Record<string|number, boolean>} [input.ports] 3000 / 3001 / 5099 的探测结果；缺省按 down 计
 * @param {{up?: boolean, port?: number}} [input.bridge] 控制台端口
 * @param {{up?: boolean, port?: number}} [input.dsh]    DSH 端口（0 / 未知 → 文案显示 ?）
 * @param {boolean} [input.connected]      snowlumaHealth.connected（WS 是否连着）
 * @param {boolean|null} [input.accountOnline] snowlumaHealth.accountOnline（null=未知，不算离线）
 * @param {{newTokens?: number}} [input.usage] todayTokenUsage() 的结果（这里只用到 newTokens）
 * @param {number} [input.dailyInputTokenLimit] 缺省 2000 万
 * @returns {{status: 'OK'|'WARN', reasons: string[]}}
 */
export function judgeSelfCheck(input = {}) {
  const { ports, bridge, dsh, connected, accountOnline, usage, dailyInputTokenLimit } = input ?? {};
  const probed = ports && typeof ports === 'object' ? ports : {};
  const reasons = [];

  // 1. SnowLuma 的三个端口（原实现固定探 3000 / 3001 / 5099）
  for (const port of [3000, 3001, 5099]) {
    if (!probed[port]) reasons.push(String(port));
  }

  // 2. 桥自己与 DSH 的端口
  const bridgeInfo = bridge && typeof bridge === 'object' ? bridge : {};
  if (!bridgeInfo.up) reasons.push(`bridge ${portLabel(bridgeInfo.port)}`);
  const dshInfo = dsh && typeof dsh === 'object' ? dsh : {};
  if (!dshInfo.up) reasons.push(`dsh ${portLabel(dshInfo.port)}`);

  // 3. 小号在线 = WS 连着 且 没被明确标成离线（null/undefined 是「还没问到」，不当离线）
  const online = Boolean(connected) && accountOnline !== false;
  if (!online) reasons.push('小号离线');

  // 4. 当日新输入 token 超限（严格大于；口径按 cacheMiss，不含命中/写入）
  const limit = Math.round(positive(dailyInputTokenLimit, DEFAULT_DAILY_INPUT_LIMIT));
  const used = Number(usage?.newTokens);
  const newTokens = Number.isFinite(used) ? used : 0;
  if (newTokens > limit) reasons.push(`新输入token ${newTokens}/${limit}`);

  return { status: reasons.length ? 'WARN' : 'OK', reasons };
}

/** 事件包静默的缺省 / 下限：配置可调，但不得低于 60s（心跳 30s 一次，太敏感会天天报）。 */
const DEFAULT_SILENCE_WARN_MS = 10 * 60 * 1000;
const MIN_SILENCE_WARN_MS = 60 * 1000;

const SNOWLUMA_CONFIRMED_HINT = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
  + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
  + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';

const snowlumaSilentHint = (minutes) => `已连接但 ${minutes} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
  + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
  + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';

/**
 * @pure SnowLuma 上游健康快照（原 snowlumaHealthSnapshot，字段与文案逐条搬出）。
 *
 * 两种故障面必须分开：`good === false` 是 SnowLuma **自报**接收链路坏了（它的 [Hook] 收不到
 * QQ 数据，桥这边一切正常）；「静默」只说明连它的进程/WS 都没动静了。前者优先。
 *
 * 与原文的差异：now 改为注入（原文 Date.now()）；时钟回绕（lastPacketAt 在 now 之后）时
 * lastPacketAgoMs 夹到 0，原文会返回负数——负数会让看板显示「-5 分钟前」。
 *
 * @param {object} [state] snowlumaHealth 的只读副本
 * @param {object} opts
 * @param {number} opts.now 毫秒时间戳（必填）
 * @param {number} [opts.silenceWarnMs] 静默阈值；缺省 10 分钟，最低 60 秒
 * @returns {{connected: boolean|undefined, accountOnline: boolean|null|undefined, good: boolean|null,
 *   goodSource: string|null, goodError: string|null, lastPacketAgoMs: number|null,
 *   lastPacketKind: string|null, silent: boolean, degraded: boolean, hint: string|null}}
 */
export function snowlumaSnapshot(state = {}, opts = {}) {
  const { now, silenceWarnMs } = opts ?? {};
  if (!Number.isFinite(now)) {
    throw new TypeError('snowlumaSnapshot: now 必须是毫秒时间戳（由调用方注入，本模块不读系统时钟）');
  }

  const s = state && typeof state === 'object' ? state : {};
  const lastPacketAt = positive(s.lastPacketAt, 0);
  const rawAgo = lastPacketAt ? now - lastPacketAt : null;
  const agoMs = rawAgo === null ? null : Math.max(0, rawAgo);
  const warnMs = Math.max(MIN_SILENCE_WARN_MS, positive(silenceWarnMs, DEFAULT_SILENCE_WARN_MS));

  const silent = lastPacketAt > 0 && agoMs > warnMs;
  // 只有 SnowLuma **明确自报** good=false 才算「确认坏了」（接收链路）。
  const confirmed = s.good === false;

  let hint = null;
  if (confirmed) hint = SNOWLUMA_CONFIRMED_HINT;
  else if (silent) hint = snowlumaSilentHint(Math.round(agoMs / 60000));

  return {
    // 只透传状态，不在这里推导「在线」——那是 judgeSelfCheck 的事（connected && accountOnline !== false）。
    connected: s.connected,
    accountOnline: s.accountOnline ?? null,
    good: s.good ?? null,
    goodSource: s.goodSource || null,
    goodError: s.goodError || null,
    lastPacketAgoMs: agoMs,
    lastPacketKind: s.lastPacketKind || null,
    silent,
    degraded: confirmed || silent,
    hint
  };
}

/**
 * @pure 当日 token 用量（原 todayTokenUsage 的口径，读文件留在中枢）。
 *
 * 只累计 `k:"turn"` 的逐轮采样行 —— `k:"base"` 是整条会话日志的累计快照（含历史、彼此重复），
 * 加进来会把当天用量虚高两个数量级（实测 2.5 亿 vs 真实 400 万）。
 * 口径：new = cacheMiss（真正的新输入，计费大头，阈值按它设）；all = miss+hit+write（总处理量）。
 *
 * 与原文的差异：吃 jsonl 文本（或已解析的行数组）而不是文件路径；now / dayStart 注入
 * （原文 new Date() + 本地零点）。`now` 缺失时报错，其余输入一律容错为 0（fail open）。
 *
 * @param {string|object[]} [input] token-usage.jsonl 的文本，或解析后的行数组
 * @param {object} opts
 * @param {number} opts.now 毫秒时间戳（必填）
 * @param {number} [opts.dayStart] 统计窗口起点（毫秒）；缺省取 now 的**本地**零点
 * @returns {{newTokens: number, allTokens: number, output: number}}
 */
export function sumTokenUsage(input, opts = {}) {
  const { now, dayStart } = opts ?? {};
  if (!Number.isFinite(now)) {
    throw new TypeError('sumTokenUsage: now 必须是毫秒时间戳（由调用方注入，本模块不读系统时钟）');
  }

  const empty = { newTokens: 0, allTokens: 0, output: 0 };
  const startMs = Number.isFinite(dayStart)
    ? dayStart
    : (() => {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    })();

  const items = typeof input === 'string' ? input.split(/\r?\n/) : (Array.isArray(input) ? input : []);
  const sum = { ...empty };

  for (const item of items) {
    let row = item;
    if (typeof item === 'string') {
      if (!item.trim()) continue;
      try { row = JSON.parse(item); } catch { continue; }
    }
    if (!row || typeof row !== 'object') continue;
    if (row.k !== 'turn') continue;

    // 窗口：[本地零点, now+60s]。上界留 60s 是给时钟抖动/回绕的容差。
    const at = Number(row.t);
    if (!Number.isFinite(at) || at < startMs || at > now + 60_000) continue;

    const buckets = row.b ?? {};
    const miss = Number(buckets.cacheMiss) || 0;
    sum.newTokens += miss;
    sum.allTokens += miss + (Number(buckets.cacheHit) || 0) + (Number(buckets.cacheWrite) || 0);
    sum.output += Number(buckets.output) || 0;
  }

  return sum;
}
