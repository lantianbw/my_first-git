// persist/migrations — 历史数据的「判定 / 归一」：拼音字段补齐检测 + sessions.json 字段补齐
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 persist/migrations / H2 locked）
// deps：无                      （optional：无）
// 失败策略：fail open            （依据：D 表 persist/migrations「历史补齐失败不影响启动」）
// 单测：tests/migrations.test.mjs
//
// 为什么搬：这两段原本内联在 bridge.js —— 判定夹在 fs.readFileSync 与 JSON.parse 之间
// （fileNeedsPinyinBackfill），补齐是 loadState() 里对 state 的三次就地赋值。想验「一条
// pinyin 为空串的老词条该不该触发写回」得先造一个 state 目录、再起半个桥；而补齐直接改的
// 是模块级的 state，入参被就地污染，「幂等」这件事在旧写法里根本无法断言。
//
// 边界：**只搬判定与归一，文件 IO 留在桥接**。入参是已解析的值（数组 / state 对象），
// 本模块不读文件、不写文件、不拼 state/ 路径、不 import bridge、不读时钟与随机数、不打印。
//
// 等价性（逐条对照 src/bridge.js，行号按搬出时的现状；契约文档里记的是它搬走前的 247 / 1336）：
//   · needsPinyinBackfill 复刻 :287 `fileNeedsPinyinBackfill` 的谓词，一字未改：
//     不是数组 → false；任一条目 falsy、pinyin 不是 string、variants 不是数组 → true；
//     **pinyin 允许空串**（纯数字/符号词条没有拼音），只要求字段存在。
//     旧实现里 try 内那两行 IO（readFileSync + JSON.parse）留在桥接：解析失败原本就落到
//     `catch { return false }`（读坏了不补齐），这条语义由调用方的「解析不出来就别问」承接。
//   · normalizeState 复刻 :1334-1338 的补齐段。与旧写法有**两处刻意差异**：
//       1. 返回新对象，不改入参 —— 旧写法 `state = loaded` 是**别名**，后面三次赋值直接改在
//          刚从磁盘读出来的那个对象上；「跑两遍结果相同」在旧写法里没法断言（第一遍就变了）。
//       2. sessions 必须是**普通对象**（数组算坏值，补空表）。旧写法只判 `typeof === 'object'`，
//          数组会被放行；而数组上的字符串键在 JSON.stringify 时被丢掉 —— 落盘一次就把所有
//          会话映射静默清空。这条收严了，其余判定（缺失 / 非对象 / 数组 → 空表）逐字照搬。

export const spec = Object.freeze({
  name: 'persist/migrations',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：状态持久化的历史补齐，关掉等于老词条永远缺 pinyin、老 sessions.json 永远缺空表
  // （契约 H2 / A.4：locked 模块不给 running 态热关，改动只能走重启）。
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

const fail = (code, error) => ({ ok: false, code, error });

/** 普通对象判定：null / 数组 / 标量 都算「不是一张表」。 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 一份全新、**可写**的空 state：每次都给新对象，绝不共享冻结单例（中枢接下来要往里塞会话）。 */
function emptyState() {
  return { sessions: {}, sessionPolicies: {}, sessionMeta: {} };
}

/**
 * 黑话库 / 梗库是否需要写回一次拼音字段。
 *
 * @pure 入参是**已解析**的数组，本模块不读文件。
 * @param {unknown} entries slang.json / memes.json 解析后的值
 * @returns {boolean} 任一条目缺 pinyin（或不是字符串）或 variants（或不是数组）→ true
 */
export function needsPinyinBackfill(entries) {
  // 非数组（读坏了 / 文件是对象 / undefined）：不补齐。与旧实现同一取舍 ——
  // 判定结果是「要不要写回磁盘」的依据，读不懂就必须是 false，绝不能反手写坏原文件。
  if (!Array.isArray(entries)) return false;
  // `!e` 同时覆盖 null / undefined / 0 / '' / false 这类坏条目：它们同样「缺字段」。
  // 注意不能写成 `e?.pinyin`，那样 `0` 会被当成合规条目放过去。
  return entries.some((e) => !e
    || typeof e.pinyin !== 'string' || !Array.isArray(e.variants));
}

/**
 * 补齐 sessions.json 的缺省字段（旧 loadState() 的「字段补齐」段）。
 *
 * @pure 入参是**已解析**的 state 对象，本模块不读文件；返回新对象，入参一个字段都不改。
 * @param {unknown} parsed JSON.parse 的结果（可能是 null / 数组 / 标量）
 * @returns {{ sessions: object, sessionPolicies: object, sessionMeta: object }} 补齐后的新 state
 */
export function normalizeState(parsed) {
  // 非普通对象：与旧实现「loaded 无效就整份回落」一致，给一份全新空 state。
  if (!isRecord(parsed)) return emptyState();

  // 浅拷贝：补齐只作用在新对象上，调用方手里那份（它还要继续用）保持原样。
  const out = { ...parsed };

  // sessions：旧实现要求它是对象，否则整份回落成空表；这里同样不接受数组（见文件头差异 2）。
  if (!isRecord(out.sessions)) out.sessions = {};

  // 字段补齐：缺失 / 非对象 / 数组 → 补空表。判定与旧实现逐字一致（:1336 / :1338）。
  // 会话轮换用的元数据（createdAt）：老文件没有该字段时补空表，不影响已有映射。
  if (!out.sessionPolicies || typeof out.sessionPolicies !== 'object' || Array.isArray(out.sessionPolicies)) out.sessionPolicies = {};
  if (!out.sessionMeta || typeof out.sessionMeta !== 'object' || Array.isArray(out.sessionMeta)) out.sessionMeta = {};

  // 未知字段原样保留：模块只管这三张表，不替业务清洗其它数据（清了就是静默丢字段）。
  return out;
}

/**
 * 契约门面（B.1）。deps 为空，不读 ctx；文件 IO 由调用方在拿到结果后自己做。
 *   needs-pinyin-backfill — 入参 entries（已解析数组）→ { ok:true, value:boolean }
 *   normalize-state       — 入参 state（已解析对象）→ { ok:true, value:补齐后的新对象 }
 *
 * @param {object} _ctx
 * @param {{ action?: 'needs-pinyin-backfill'|'normalize-state', entries?: unknown, state?: unknown }} [args]
 */
export function handle(_ctx, args) {
  const action = args?.action;
  if (action === 'needs-pinyin-backfill') return { ok: true, value: needsPinyinBackfill(args?.entries) };
  if (action === 'normalize-state') return { ok: true, value: normalizeState(args?.state) };
  return fail('INVALID_ARGS', `未知动作：${String(action)}（只支持 needs-pinyin-backfill / normalize-state）`);
}
