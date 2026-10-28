// cost/report — 把 token-ledger 的 summary() 摘要渲染成人读的纯文本表格
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：无                    （optional：无）
// 失败策略：fail-open          （依据：D 表 `cost/ledger` 行——报表坏了只丢可读性，不影响记账与熔断）
// 单测：tests/report.test.mjs
//
// 为什么需要：summary() 返回的是给机器看的嵌套对象（totals / conversations / buckets），
// 控制台和 CLI 各自写一遍拼字符串，就会出现「控制台 ¥12.5、日志 ¥12.50、日报 ¥1.25e1」
// 三种口径。这里把「数字怎么显示」收敛成一处：钱永远是 ¥ + 两位小数 + 千分位，
// token 数一律 K/M 缩写，占比一律一位小数且**合计必须正好 100.0%**。
//
// 边界：只做字符串拼装。不读文件、不调 API、不读时钟、不 import token-ledger。
// 入参结构按 src/token-ledger.js summary() 的返回形状定义，缺字段一律降级成 0 / 「—」，
// 绝不让 undefined / NaN 漏进输出。
//
// 两处口径说明：
//   1. **钱不缩写**。¥1.23K 会藏掉三分钱，而熔断按元比对，报表与判定口径必须一致，
//      所以金额再大也只加千分位（¥1,234,567.89）；K/M 只用在 token 数上。
//   2. **token 总数沿用 totalTokensOf**（cacheMiss + cacheHit + cacheWrite + output），
//      reasoning 不计入——与 src/model-prices.js:totalTokensOf 保持一致，
//      否则同一份数据在账本和报表里会对不上。

export const spec = Object.freeze({
  name: 'cost/report',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

const YUAN = '¥';
const RULE = '─';
const BAR = '█';
const BAR_MAX = 12;
const FALLBACK_KEY = '未命名会话';
const FALLBACK_DATE = '—';

/** 金额：负值 / 非数字 / Infinity 一律当 0，避免把脏数据画成「-¥5」。 */
function amountOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 计数：取整后同 amountOf 的容错口径。 */
function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** ¥ + 两位小数 + 千分位。钱不缩写，理由见文件头。 */
function money(value) {
  const [int, dec] = amountOf(value).toFixed(2).split('.');
  return `${YUAN}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

/** token 数缩写：<1000 原样，再往上 K / M，统一一位小数。 */
function compact(value) {
  const n = countOf(value);
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/**
 * token 总数：优先显式 totalTokens / tokens（日表的行由调用方聚合，只有标量），
 * 都没有时按账本口径累加四个桶。
 */
function tokensOf(entry) {
  for (const key of ['totalTokens', 'tokens']) {
    const explicit = Number(entry?.[key]);
    if (Number.isFinite(explicit) && explicit >= 0) return countOf(explicit);
  }
  const b = entry?.buckets;
  if (b && typeof b === 'object') {
    return countOf(b.cacheMiss) + countOf(b.cacheHit) + countOf(b.cacheWrite) + countOf(b.output);
  }
  return 0;
}

/**
 * 占比：最大余数法。逐项四舍五入到 0.1% 会让三均分变成 33.3×3=99.9%，
 * 报表里「合计不是 100%」会被当成算错。这里先取整到 0.1%，把剩下的份额
 * 按小数部分从大到小补回去，保证合计恒等于 100.0%。
 */
function sharesOf(values, total) {
  if (!(total > 0)) return values.map(() => 0);
  const tenths = values.map((v) => (v / total) * 1000);
  const floors = tenths.map((x) => Math.floor(x));
  let rest = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = tenths
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < order.length && rest > 0; k += 1) {
    out[order[k].i] += 1;
    rest -= 1;
  }
  return out.map((t) => t / 10);
}

/** 东亚宽字符按 2 列算，否则中文表头会把整张表顶歪。 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function widthOf(text) {
  let w = 0;
  for (const ch of String(text)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

const padRight = (text, width) => String(text) + ' '.repeat(Math.max(0, width - widthOf(text)));
const padLeft = (text, width) => ' '.repeat(Math.max(0, width - widthOf(text))) + String(text);

/** 渲染一张定宽表：首列左对齐，其余右对齐。 */
function tableOf(header, body, totalRow, aligns) {
  const all = [header, ...body, totalRow];
  const widths = header.map((_, col) => Math.max(...all.map((row) => widthOf(row[col]))));
  const render = (row) =>
    row
      .map((cell, col) => (aligns[col] === 'right' ? padLeft(cell, widths[col]) : padRight(cell, widths[col])))
      .join('  ');
  const rule = RULE.repeat(widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1));
  // trimEnd：末列补齐的空格对肉眼无意义，日志里却是尾随空白。
  return [render(header), rule, ...body.map(render), rule, render(totalRow)].map((line) => line.trimEnd());
}

/**
 * @pure 会话成本摘要表。
 *
 * @param {object} summary token-ledger 的 summary() 返回对象（允许缺字段）
 * @returns {string} 纯文本表格
 */
export function renderSummary(summary) {
  const src = summary && typeof summary === 'object' ? summary : {};
  const list = Array.isArray(src.conversations) ? src.conversations : [];

  const rows = list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      key: typeof item.key === 'string' && item.key.trim() ? item.key.trim() : FALLBACK_KEY,
      cost: amountOf(item.cost),
      tokens: tokensOf(item),
      turns: countOf(item.turns)
    }));

  if (!rows.length) return '会话成本摘要 · 暂无数据';

  rows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key));

  const totalCost = Math.round(rows.reduce((sum, r) => sum + r.cost, 0) * 100) / 100;
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const totalTurns = rows.reduce((sum, r) => sum + r.turns, 0);
  const shares = sharesOf(rows.map((r) => r.cost), totalCost);

  const body = rows.map((r, i) => [
    r.key,
    money(r.cost),
    `${shares[i].toFixed(1)}%`,
    String(r.turns),
    compact(r.tokens)
  ]);

  // 口径提醒：本表的「合计」是账本累计（可能跨天），而 costGate 判的是「今日」。
  // 调用方若带上 todayCost，就在标题里并列显示，避免把累计当成今日而误判是否已超熔断线。
  const todayCost = Number(src.todayCost);
  const todayText = Number.isFinite(todayCost) && todayCost >= 0 ? ` · 今日 ${money(todayCost)}` : '';

  const lines = [
    `会话成本摘要 · ${rows.length} 个会话 · 合计 ${money(totalCost)}${todayText}`,
    ...tableOf(
      ['会话', '花费', '占比', '轮次', 'tokens'],
      body,
      ['合计', money(totalCost), totalCost > 0 ? '100.0%' : '—', String(totalTurns), compact(totalTokens)],
      ['left', 'right', 'right', 'right', 'right']
    )
  ];

  // summary() 默认只给前 200 个会话，被截断时表内合计会小于账本总额，必须写明。
  const ledgerCost = amountOf(src?.totals?.cost);
  if (ledgerCost > 0 && Math.abs(ledgerCost - totalCost) >= 0.005) {
    lines.push(`（账本总额 ${money(ledgerCost)}，本表仅列 ${rows.length} 个会话，差额 ${money(Math.abs(ledgerCost - totalCost))} 未列入）`);
  }

  return lines.join('\n');
}

/**
 * @pure 每日成本趋势表：一天一行，末列用方块长度表示相对高低。
 *
 * @param {Array<{date?: string, cost?: number, tokens?: number, totalTokens?: number, turns?: number, buckets?: object}>} rows
 * @returns {string} 纯文本表格
 */
export function renderDaily(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!list.length) return '每日成本趋势 · 暂无数据';

  const items = list.map((row) => ({
    date: typeof row.date === 'string' && row.date.trim() ? row.date.trim() : FALLBACK_DATE,
    cost: amountOf(row.cost),
    tokens: tokensOf(row),
    turns: countOf(row.turns)
  }));

  // 日期升序；缺日期的排最后，不参与排序（否则 '—' 会插在中间）。
  const dated = items.filter((i) => i.date !== FALLBACK_DATE).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const undated = items.filter((i) => i.date === FALLBACK_DATE);
  const ordered = [...dated, ...undated];

  const maxCost = ordered.reduce((max, i) => Math.max(max, i.cost), 0);
  const barOf = (cost) => {
    if (!(maxCost > 0) || cost <= 0) return '';
    const len = Math.max(1, Math.round((cost / maxCost) * BAR_MAX));
    return BAR.repeat(len);
  };

  const totalCost = Math.round(ordered.reduce((sum, i) => sum + i.cost, 0) * 100) / 100;
  const body = ordered.map((i) => [i.date, money(i.cost), compact(i.tokens), String(i.turns), barOf(i.cost)]);

  return [
    `每日成本趋势 · ${ordered.length} 天 · 合计 ${money(totalCost)}`,
    ...tableOf(
      ['日期', '花费', 'tokens', '轮次', '趋势'],
      body,
      [
        '合计',
        money(totalCost),
        compact(ordered.reduce((sum, i) => sum + i.tokens, 0)),
        String(ordered.reduce((sum, i) => sum + i.turns, 0)),
        ''
      ],
      ['left', 'right', 'right', 'right', 'left']
    )
  ].join('\n');
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx；动作名区分两张表。
 * 未知动作返回 ok:false + INVALID_ARGS，不抛错（B.2）。
 *
 * @param {object} _ctx
 * @param {{ action?: 'summary'|'daily', summary?: object, rows?: Array }} args
 * @returns {{ ok: true, value: string } | { ok: false, code: string, error: string }}
 */
export function handle(_ctx, args) {
  const action = args?.action ?? 'summary';
  if (action === 'summary') return { ok: true, value: renderSummary(args?.summary) };
  if (action === 'daily') return { ok: true, value: renderDaily(args?.rows) };
  return { ok: false, code: 'INVALID_ARGS', error: `未知动作：${String(action)}（只支持 summary / daily）` };
}
