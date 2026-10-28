// cost/gate — 判定本次调用是否越过日预算，并给出放行 / 预警 / 硬停
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：log, now             （optional：无）
// 失败策略：fail-closed       （依据：D 表 `cost/gate` 行——熔断命中必须拒绝）
// 单测：tests/cost-gate.test.mjs
//
// 为什么需要：Q3 定了日预算 ¥30 预警 / ¥50 硬停，但仓里此前只有 voiceBudgetCheck
// （bridge.js:2313）这类按「条数 / 分钟」的局部限流，没有任何跨会话的日成本闸门。
// 钱烧穿了没人拦，事后只能从 cost/ledger 的流水里倒推。这里把「今天还能不能开新轮次」
// 收敛成一次纯计算，让中枢在装配期就能问一句。
//
// 边界：只做判断。不写账本、不扣额度、不发消息、不读 state、不联网、不 import 任何模块。
// 花费由调用方（cost/ledger）以 spentToday 传入；本模块不持有任何跨调用状态，
// 同一入参永远得到同一结论。判定之外唯一的动作是 handle 里的一条 ctx.log 记账。
//
// 口径（人民币）：
//   spentToday + estimatedCost <  30          → ok    放行
//   >= 30 且 < 50                             → warn  放行（只记账，不拦）
//   >= 50 且 isNewTurn === true               → stop  拒绝（新会话 / 新轮次）
//   >= 50 且 isNewTurn === false              → warn  放行（进行中的对话不打断）
//   spentToday 不可用（账本读坏了）            → 按硬停处理：新轮次拒绝、进行中放行
//
// 最后一条是 D 表 fail-closed 的落地：账本读不出来时若当成「今天花了 0 元」，
// 熔断就等于没有。所以「无法确认花费」与「已超预算」走同一条拒绝分支，
// 但 reason 会写明是账本缺失，方便排查。进行中的对话例外，因为 Q3 的硬约束是
// 「不出现半句话被砍」。

const OK = 'ok';
const WARN = 'warn';
const STOP = 'stop';

/** 默认日预算（元）。可由 limits 覆盖；不导出，避免被当配置源改跑口径。 */
const DAY_LIMITS = Object.freeze({ warn: 30, stop: 50 });

export const spec = Object.freeze({
  name: 'cost/gate',
  version: '1.0.0',
  deps: ['log', 'now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

/**
 * 金额归一。不可用返回 null，与 0 严格区分——0 是「确实没花钱」，null 是「不知道」。
 * 两个方向的取舍不对称：
 *   - 花费（事实）：负数 / 非数字说明账本坏了，按 null 处理 → 走 fail-closed。
 *   - 预估（猜测）：不可用时按 0，因为「把预估压小」只会让判定更保守，不会放过超支。
 */
function amountOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 阈值取值：未提供才回落默认；显式传 0 视为调用方自己的选择，不顶替。 */
function limitOf(value, fallback) {
  const n = amountOf(value);
  return n === null ? fallback : n;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const yuan = (n) => `¥${round2(n).toFixed(2)}`;

/**
 * @pure 判定本次调用。无 IO、无状态、不读 Date.now()、不改入参。
 *
 * @param {object}  context
 * @param {number}  context.estimatedCost 本次预估成本（缺省按 0）
 * @param {number}  context.spentToday    今日已花费，由 cost/ledger 提供
 * @param {object}  [context.limits]      { warn, stop }，缺省 30 / 50
 * @param {boolean} [context.isNewTurn]   true 新会话 / 新轮次；false 进行中的对话
 * @param {number}  [context.now]         时间戳，仅透传留审计，不参与判定
 * @returns {{ allow: boolean, level: 'ok'|'warn'|'stop', reason: string, remaining: number }}
 */
export function judge(context = {}) {
  const { estimatedCost, spentToday, limits, isNewTurn } = context ?? {};

  const warnAt = limitOf(limits?.warn, DAY_LIMITS.warn);
  const stopAt = limitOf(limits?.stop, DAY_LIMITS.stop);

  const spend = amountOf(spentToday);
  const estimate = amountOf(estimatedCost) ?? 0;

  // Q3 的硬约束优先于一切：进行中的对话不打断，哪怕账本坏了、哪怕已超线。
  const inTurn = isNewTurn === false;

  // 账本不可用 → 无法确认花费 → 按硬停处理（fail-closed）
  if (spend === null) {
    if (inTurn) {
      return {
        allow: true,
        level: WARN,
        reason: '今日花费不可用（账本缺失），进行中的对话不打断，仅记账',
        remaining: 0
      };
    }
    return {
      allow: false,
      level: STOP,
      reason: '今日花费不可用（账本缺失），按 fail-closed 拒绝新会话/新轮次',
      remaining: 0
    };
  }

  const total = round2(spend + estimate);
  const remaining = round2(Math.max(0, stopAt - total));

  if (total >= stopAt) {
    if (inTurn) {
      return {
        allow: true,
        level: WARN,
        reason: `成本 ${yuan(total)} 已达硬停线 ${yuan(stopAt)}，进行中的对话不打断，仅记账`,
        remaining
      };
    }
    return {
      allow: false,
      level: STOP,
      reason: `成本 ${yuan(total)} 已达硬停线 ${yuan(stopAt)}，拒绝新会话/新轮次`,
      remaining
    };
  }

  if (total >= warnAt) {
    return {
      allow: true,
      level: WARN,
      reason: `成本 ${yuan(total)} 已达预警线 ${yuan(warnAt)}，仅记账不拦截`,
      remaining
    };
  }

  return {
    allow: true,
    level: OK,
    reason: `成本 ${yuan(total)} 低于预警线 ${yuan(warnAt)}，正常放行`,
    remaining
  };
}

/**
 * 契约门面（B.1）。把 judge 包成 { ok, value } 的形状，并在非 ok 档位记一条
 * ctx.log；不记的话，事后没人能从日志里还原「为什么这轮被拒」。
 *
 * 缺 log / now 属于「必填依赖缺失」，按 B.3 由中枢判为不装配；但单测与脚本会直接
 * 调 handle，所以这里对二者做降级：没有 log 就跳过记账，没有 now 就留 undefined，
 * 判定本身照常返回，不抛错。
 *
 * @param {{ log?: Function, now?: () => number }} ctx
 * @param {object} args 同 judge 的入参
 * @returns {{ ok: true, value: ReturnType<typeof judge> }}
 */
export function handle(ctx, args) {
  const c = ctx ?? {};
  const a = args ?? {};
  const now = a.now !== undefined ? a.now : (typeof c.now === 'function' ? c.now() : undefined);

  const verdict = judge({ ...a, now });

  if (verdict.level !== OK && typeof c.log === 'function') {
    c.log(verdict.level === STOP ? 'warn' : 'info', `[cost/gate] ${verdict.level}: ${verdict.reason}`, {
      level: verdict.level,
      allow: verdict.allow,
      remaining: verdict.remaining
    });
  }

  return { ok: true, value: verdict };
}
