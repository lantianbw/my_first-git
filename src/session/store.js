// session/store — 会话映射的读取降级、形状归一与「写失败不谎报」的落盘门禁
//
// 契约：docs/module-contract.md v1.1（B.1 spec / C 节 ctx / D 表 session/store）
// deps：log                      （optional：dirWritable —— 目录可写性探针，缺省按未知处理）
// 失败策略：读 fail-open / 写 fail-closed
//   依据：D 表 session/store「读失败降级'只读不写'、绝不回写覆盖；写失败不能谎报成功」
// 单测：tests/session-store.test.mjs
//
// 为什么需要：sessions.json 一旦读不动或被截断，旧代码会把它当成「没有会话」，然后在
// 下一条消息到达时把这份空映射原子写回磁盘 —— 一次占用/写满就变成永久丢掉所有上下文
// （bridge.js:1311-1347 的注释记的就是这个场景）。所以这里有两个必须分开的不变量：
//   ① 读失败 → 降级「只读不写」，原文件一个字都不动，等人来修；
//   ② 写失败 → 必须返回失败，绝不返回成功 —— 中枢据此决定要不要重试。
// 判定只走 decideWritable 一处：{fileExists, dirWritable, readOk, error} → {writable, reason}。
// 以后要加新的降级条件（比如磁盘满）就改那张表，别再在各个分支里散着写 if。
//
// 数据形状（照 bridge.js 的真实用法，别按「直觉」改）：
//   sessions[key]        = sessionId **字符串**（bridge.js:11040 `state.sessions[key] = sessionId`）
//   sessionPolicies[key] = 策略 **字符串**（bridge.js:3291 `JSON.stringify([...])`）
//   sessionMeta[key]     = { createdAt: number } **对象**（bridge.js:10923）
// 归一时按这个口径清脏：会话/策略只留非空字符串，元数据只留对象。
//
// 边界：不做 IO（read / write 由中枢注入）、不拼路径、不实现原子写（走 persist/atomic）、
// 不做落盘去抖（那是中枢的调度权）、不读时钟、不读 process.env、不 import bridge.js、
// 不写日志文件（只用注入的 log）、不校验会话键格式（key 的生成与规范归 session/key）。
//
// 与搬出前的四处刻意差异（都是为了让「不覆盖原文件」真的成立）：
//   1. 顶层不是对象（数组 / 数字 / 字符串 / true）由「静默重置后照常写回」改为
//      「只读降级 + warn」。可解析但形状根本不是状态文件 ⇒ 数据不可用，保留原文件
//      比覆盖它更有价值（覆盖会把「可疑」变成「确定丢失」）。
//   2. sessions 形状不对时仍可写（与旧行为一致，只重置这一张表、保留其余顶层
//      字段），但补一条 warn —— 旧实现这里完全静默，用户永远不知道映射被清空过。
//   3. 归一丢弃四类脏数据：非字符串的会话/策略、非对象的元数据、空白键，以及
//      __proto__ / constructor / prototype（JSON.parse 会把它们落成**自有属性**，
//      直接展开进状态对象就等着原型链污染）。
//   4. 同一次故障只告警一次（warnedReason 去重）：load 会被反复调用，saveState 又是
//      每消息的热路径，逐次告警会把 bridge.log 刷满，反而看不到真正的原因。

/** 出现的键一律跳过：JSON.parse 出来的自有 __proto__ 是原型链污染的入口。 */
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const UNSAFE = new Set(UNSAFE_KEYS);

/** 三张表的字段名，同时也是 state 上的命名空间。 */
const TABLES = Object.freeze(['sessions', 'sessionPolicies', 'sessionMeta']);

/** decideWritable 的 reason 取值域（日志与单测都按它断言）。 */
export const WRITABLE_REASONS = Object.freeze(['ok', 'missing-file', 'read-error', 'dir-not-writable']);

export const spec = Object.freeze({
  name: 'session/store',
  version: '1.0.0',
  deps: Object.freeze(['log']),
  // dirWritable 是工厂选项（中枢自己探测后传进来），不是 ctx 能力，所以不记在这里
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  // locked：会话映射是状态持久化的地基（H2），关掉等于每次入站都新建 DSH 会话
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 从任意抛出物里取出可读说明。 */
function messageOf(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** 只用于错误文案：把非法值说成人话。 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `字符串 "${value.length > 20 ? `${value.slice(0, 20)}…` : value}"`;
  return typeof value;
}

const fail = (code, error) => ({ ok: false, code, error });

/**
 * 复制一层「键 → 值」表，顺手丢掉空白键、危险键与不合形状的值。
 * 值不深拷（会话 id 与策略都是字符串），元数据浅拷一层，避免中枢手里的引用失效。
 *
 * @pure
 */
function cleanTable(value, keep, shallowCopy = false) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE.has(k) || k.trim() === '') continue;
    if (!keep(v)) continue;
    out[k] = shallowCopy ? { ...v } : v;
  }
  return out;
}

/**
 * @pure 把 sessions.json 解析出来的东西归一成固定形状：
 *   { ...未知顶层字段原样保留, sessions, sessionPolicies, sessionMeta }
 * 三张表缺失/形状不对时补成空表；表内脏条目按数据形状清掉；**入参不被修改**。
 *
 * @param {unknown} parsed JSON.parse 的结果（或任意值）
 * @returns {{ sessions: object, sessionPolicies: object, sessionMeta: object }}
 */
export function normalizeState(parsed) {
  const src = isPlainObject(parsed) ? parsed : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (UNSAFE.has(k)) continue;
    out[k] = v;
  }
  out.sessions = cleanTable(src.sessions, isNonEmptyString);
  out.sessionPolicies = cleanTable(src.sessionPolicies, isNonEmptyString);
  out.sessionMeta = cleanTable(src.sessionMeta, isPlainObject, true);
  return out;
}

/**
 * @pure 解析 sessions.json 的原文。
 *
 * `empty` 与 `missing` 都不算损坏：空文件没有信息可丢，按「暂无数据」处理即可；
 * 只有**解析失败**才是损坏（此时由调用方降级只读，原文件留证）。
 *
 * @param {string|object|null|undefined} raw 文件原文，或中枢已解析好的对象
 * @returns {{ ok: true, value: unknown, reason: 'missing'|'empty'|'parsed'|'object' }
 *   | { ok: false, code: 'UPSTREAM', reason: 'corrupt', error: string }}
 */
export function parseStateText(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null, reason: 'missing' };

  if (typeof raw === 'string') {
    // Windows 编辑器很爱写 BOM；带 BOM 时 JSON.parse 会直接抛，别把它误判成损坏
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (text.trim() === '') return { ok: true, value: null, reason: 'empty' };
    try {
      return { ok: true, value: JSON.parse(text), reason: 'parsed' };
    } catch (error) {
      return {
        ok: false,
        code: 'UPSTREAM',
        reason: 'corrupt',
        error: `sessions.json 内容损坏：${messageOf(error)}`
      };
    }
  }

  // 中枢也可以把已经解析好的对象直接递进来（省一次 stringify → parse 往返）
  return { ok: true, value: raw, reason: 'object' };
}

/**
 * @pure 决定「这次到底能不能落盘」。旧实现里散在 loadState 各分支的那几个 if 收敛到这里。
 *
 * 判定顺序（顺序本身就是安全语义，改之前先想清楚）：
 *   ① 读成功 + 目录不可写 → 只读（读得到不等于写得进去）
 *   ② 读成功 → 可写（fileExists 为 false 说明是内存里的首次默认值）
 *   ③ 读失败但文件本来就不存在（ENOENT / fileExists:false）→ 可写（首次运行不是故障）
 *   ④ 其余读失败（含内容损坏）→ 只读（**绝不回写覆盖**）
 * `dirWritable` 只有显式 false 才算不可写：桥里根本没有这个探针，未知不该凭空拦写。
 *
 * @param {{ fileExists?: boolean, dirWritable?: boolean, readOk?: boolean, error?: unknown }} input
 * @returns {{ writable: boolean, reason: 'ok'|'missing-file'|'read-error'|'dir-not-writable' }}
 */
export function decideWritable({ fileExists, dirWritable, readOk, error } = {}) {
  const dirBlocked = dirWritable === false;

  if (readOk === true) {
    if (dirBlocked) return { writable: false, reason: 'dir-not-writable' };
    return { writable: true, reason: fileExists === false ? 'missing-file' : 'ok' };
  }

  const missing = error?.code === 'ENOENT' || fileExists === false;
  if (missing) {
    if (dirBlocked) return { writable: false, reason: 'dir-not-writable' };
    return { writable: true, reason: 'missing-file' };
  }

  // 判不出来也走这里：宁可只读，也不要拿一份可能是空的内存覆盖掉原文件
  return { writable: false, reason: 'read-error' };
}

/**
 * 创建会话状态仓库。
 *
 * 构造时自动 load 一次（与 tools/module-switch 一致）：中枢拿到实例时就已经知道
 * 当前是「可写」还是「只读降级」，不必再多写一次判断。
 *
 * @param {object}   opts
 * @param {Function} opts.read        必填，() => string|object|null；文件不存在返回 null；
 *                                    IO 失败**必须抛**（带 code，ENOENT 视为首次运行）
 * @param {Function} opts.write       必填，(state) => void；失败**必须抛**（原子写在中枢）
 * @param {Function} opts.log         必填，(level, msg, meta?) => void
 * @param {boolean|Function} [opts.dirWritable] 目录是否可写；函数形式现场探测，抛错按未知处理
 */
export function createSessionStore({ read, write, log, dirWritable } = {}) {
  if (typeof log !== 'function') throw new TypeError('createSessionStore: 缺少必需依赖 log(level, msg, meta?)');
  if (typeof read !== 'function') throw new TypeError('createSessionStore: 缺少必需依赖 read()（文件不存在返回 null，IO 失败请抛）');
  if (typeof write !== 'function') throw new TypeError('createSessionStore: 缺少必需依赖 write(state)（失败请抛，落盘由中枢负责）');

  let state = normalizeState(null);
  let readOnly = false;
  let readOnlyWarned = false;
  let warnedReason = null;

  /** 同一次故障只告警一次（见头注释差异 4）；换原因会重新告警。 */
  function warnOnce(reason, msg) {
    if (warnedReason === reason) return;
    warnedReason = reason;
    log('warn', msg);
  }

  function dirWritableNow() {
    if (typeof dirWritable !== 'function') return dirWritable;
    try {
      return dirWritable();
    } catch (error) {
      log('warn', `[session/store] 目录可写性探测失败，按未知处理：${messageOf(error)}`);
      return undefined;
    }
  }

  // ---------- 读（fail open） ----------

  /**
   * 读并归一。**永不抛**：读不动就降级只读，中枢照常跑，只是不再落盘。
   *
   * @returns {{ ok: true, readOnly: boolean, reason: 'missing'|'empty'|'ok'|'shape'|'io-error'|'corrupt'|'dir-not-writable' }}
   */
  function load() {
    let raw;
    let readOk = false;
    let error = null;
    try {
      raw = read();
      readOk = true;
    } catch (caught) {
      error = caught;
    }

    // ① 读这一步就失败了
    if (!readOk) {
      const verdict = decideWritable({
        // 只有 ENOENT 才能证明文件不在；其它错误一律当作「文件在、但读不出来」
        fileExists: error?.code === 'ENOENT' ? false : undefined,
        dirWritable: dirWritableNow(),
        readOk: false,
        error
      });
      state = normalizeState(null);
      readOnly = !verdict.writable;
      readOnlyWarned = false;
      if (verdict.writable) {
        warnedReason = null;
        return { ok: true, readOnly: false, reason: 'missing' };
      }
      warnOnce('io-error', `[session/store] sessions.json 读取失败，已降级为只读不写（不会覆盖原文件）：${messageOf(error)}`);
      return { ok: true, readOnly: true, reason: 'io-error' };
    }

    const parsed = parseStateText(raw);

    // ② 文件不存在 / 空文件：没有信息可丢，按「暂无数据」处理
    if (parsed.ok && parsed.value === null) {
      const verdict = decideWritable({ fileExists: false, dirWritable: dirWritableNow(), readOk: true });
      state = normalizeState(null);
      readOnly = !verdict.writable;
      readOnlyWarned = false;
      if (!verdict.writable) {
        warnOnce('dir-not-writable', '[session/store] state 目录不可写，已按只读运行（写下去也只会失败）');
        return { ok: true, readOnly: true, reason: 'dir-not-writable' };
      }
      warnedReason = null;
      return { ok: true, readOnly: false, reason: parsed.reason };
    }

    // ③ 内容坏 / 顶层不是对象 → 同样降级（原文件留证，不许覆盖）
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      const detail = parsed.ok
        ? `sessions.json 顶层不是对象（${describe(parsed.value)}）`
        : parsed.error;
      const verdict = decideWritable({
        fileExists: true,
        dirWritable: dirWritableNow(),
        readOk: false,
        error: { code: 'CORRUPT', message: detail }
      });
      state = normalizeState(null);
      readOnly = !verdict.writable;
      readOnlyWarned = false;
      warnOnce('corrupt', `[session/store] ${detail}，已降级为只读不写（不会覆盖原文件，请先备份再修复）`);
      return { ok: true, readOnly: true, reason: 'corrupt' };
    }

    // ④ 文件可用：其余顶层字段原样保留，只修三张表
    const verdict = decideWritable({ fileExists: true, dirWritable: dirWritableNow(), readOk: true });
    const sessionsOk = isPlainObject(parsed.value.sessions);
    state = normalizeState(parsed.value);
    readOnly = !verdict.writable;
    readOnlyWarned = false;

    if (!verdict.writable) {
      warnOnce('dir-not-writable', '[session/store] state 目录不可写，已按只读运行（写下去也只会失败）');
      return { ok: true, readOnly: true, reason: 'dir-not-writable' };
    }
    if (!sessionsOk) {
      warnOnce('shape', '[session/store] sessions.json 的 sessions 字段形状不对，已重置为空表（其余顶层字段保留）');
      return { ok: true, readOnly: false, reason: 'shape' };
    }
    warnedReason = null;
    return { ok: true, readOnly: false, reason: 'ok' };
  }

  // ---------- 写（fail closed） ----------

  /**
   * 落盘。**只有真的写成功才返回 ok:true**。
   *
   * @returns {{ ok: true } | { ok: false, code: 'READ_ONLY'|'UPSTREAM', error: string }}
   */
  function save() {
    if (readOnly) {
      if (!readOnlyWarned) {
        readOnlyWarned = true;
        log('warn', '[session/store] 当前为只读降级状态，已拒绝回写 sessions.json（否则会把一次读取故障变成永久丢映射）');
      }
      return fail('READ_ONLY', 'sessions.json 已降级为只读不写，拒绝覆盖原文件');
    }

    // 调用方可能绕过方法直接改 getState()：落盘前就地把三张表修正回来，
    // 但**保留对象身份**，否则中枢手里的引用会指向旧对象。
    for (const table of TABLES) {
      if (!isPlainObject(state[table])) state[table] = {};
    }

    try {
      write(state);
    } catch (error) {
      // 写 fail closed：不吞错、不谎报（契约 F.5 / D 表）
      log('error', `[session/store] sessions.json 写入失败，本次保存未生效：${messageOf(error)}`);
      return fail('UPSTREAM', `写入 sessions.json 失败：${messageOf(error)}`);
    }
    return { ok: true };
  }

  // ---------- 键校验 ----------

  /** 只做「能不能安全地当对象键用」的检查；key 的格式归 session/key。 */
  function checkKey(key) {
    if (typeof key !== 'string') return fail('INVALID_ARGS', `会话键必须是字符串（收到 ${describe(key)}）`);
    const k = key.trim();
    if (k === '') return fail('INVALID_ARGS', '会话键不能为空');
    if (UNSAFE.has(k)) return fail('INVALID_ARGS', `会话键 ${k} 是保留字，拒绝写入`);
    return { ok: true, key: k };
  }

  /**
   * 三张表共用同一套 get/set/remove 语义，避免某一张表漏了键校验或形状校验。
   * @param {string} name 表名
   * @param {(v: unknown) => boolean} isValid 该表的合法值形状
   * @param {string} label 错误文案用的值称呼
   * @param {boolean} [copy] 写入时是否浅拷一份
   */
  function tableApi(name, isValid, label, copy = false) {
    const table = () => state[name];
    return {
      get(key) {
        const k = checkKey(key);
        if (!k.ok) return null;
        const value = table()[k.key];
        return value === undefined ? null : value;
      },
      set(key, value) {
        const k = checkKey(key);
        if (!k.ok) return k;
        if (!isValid(value)) return fail('INVALID_ARGS', `${name} 的值${label}（收到 ${describe(value)}）`);
        table()[k.key] = copy ? { ...value } : value;
        return { ok: true, key: k.key };
      },
      remove(key) {
        const k = checkKey(key);
        if (!k.ok) return k;
        const removed = Object.hasOwn(table(), k.key);
        if (removed) delete table()[k.key];
        return { ok: true, key: k.key, removed };
      }
    };
  }

  const sessions = tableApi('sessions', isNonEmptyString, '必须是 sessionId 字符串');
  const policies = tableApi('sessionPolicies', isNonEmptyString, '必须是策略字符串');
  const meta = tableApi('sessionMeta', isPlainObject, '必须是对象', true);

  /**
   * 取或建：已存在的会话**绝不覆盖**（重复入站不能把上下文换掉）。
   * 先看已存在再看新值，所以「已存在 + 新值非法」也是成功的 noop。
   */
  function ensure(key, sessionId) {
    const k = checkKey(key);
    if (!k.ok) return k;
    const existing = state.sessions[k.key];
    if (isNonEmptyString(existing)) return { ok: true, key: k.key, value: existing, created: false };
    if (!isNonEmptyString(sessionId)) {
      return fail('INVALID_ARGS', `sessionId 必须是非空字符串（收到 ${describe(sessionId)}）`);
    }
    state.sessions[k.key] = sessionId;
    return { ok: true, key: k.key, value: sessionId, created: true };
  }

  /** 状态对象本体。约定：只读；改动请走 set / ensure / remove / save。 */
  const getState = () => state;

  const stats = () => ({
    sessions: Object.keys(state.sessions).length,
    policies: Object.keys(state.sessionPolicies).length,
    meta: Object.keys(state.sessionMeta).length,
    readOnly
  });

  load();

  return {
    load,
    save,
    isWritable: () => !readOnly,
    getState,
    keys: () => Object.keys(state.sessions),
    get: sessions.get,
    set: sessions.set,
    ensure,
    remove: sessions.remove,
    getPolicy: policies.get,
    setPolicy: policies.set,
    removePolicy: policies.remove,
    getMeta: meta.get,
    setMeta: meta.set,
    removeMeta: meta.remove,
    stats
  };
}

/**
 * 门面用的一次性实例：没有 store 时按注入的 read/write 现场装配。
 * 不抛给调用方 —— 依赖形状不对属于「缺依赖」，统一按 B.3 返回 DEP_MISSING。
 */
function ephemeralStore(ctx, args) {
  if (typeof args?.read !== 'function' || typeof args?.write !== 'function') {
    return { error: '缺少注入：需要 args.store 实例，或 read() 与 write() 两个函数' };
  }
  if (typeof ctx?.log !== 'function') return { error: '缺少注入：ctx.log（模块不许自己往控制台打日志）' };
  try {
    return {
      store: createSessionStore({
        read: args.read,
        write: args.write,
        log: ctx.log,
        dirWritable: args.dirWritable
      })
    };
  } catch (error) {
    return { error: `装配失败：${messageOf(error)}` };
  }
}

/**
 * 契约门面（B.1）。
 *
 * 无状态动作（decide / normalize / parse）不需要任何注入；其余动作要么传 store 实例
 * （中枢的常规用法：自己持有实例、自己决定何时 save），要么传 read/write 现场装配。
 *
 * @param {{ log?: Function }} ctx
 * @param {{ action?: string, store?: object, read?: Function, write?: Function, dirWritable?: boolean|Function,
 *   key?: string, value?: any, raw?: any, fileExists?: boolean, readOk?: boolean, error?: unknown }} args
 */
export function handle(ctx, args = {}) {
  const action = String(args?.action ?? 'load');

  // 纯函数动作：连 store 都不需要，测试与诊断脚本可以直接用
  if (action === 'decide') {
    return {
      ok: true,
      value: decideWritable({
        fileExists: args?.fileExists,
        dirWritable: args?.dirWritable,
        readOk: args?.readOk,
        error: args?.error
      })
    };
  }
  if (action === 'normalize') return { ok: true, value: normalizeState(args?.value) };
  if (action === 'parse') return parseStateText(args?.raw);

  const injected = args?.store ? { store: args.store } : ephemeralStore(ctx, args);
  if (!injected.store) return fail('DEP_MISSING', injected.error);

  const store = injected.store;
  if (action === 'load') return { ok: true, value: store.load() };
  if (action === 'save') return store.save();
  if (action === 'writable') return { ok: true, value: store.isWritable() };
  if (action === 'stats') return { ok: true, value: store.stats() };
  if (action === 'keys') return { ok: true, value: store.keys() };
  if (action === 'get') return { ok: true, value: store.get(args?.key) };
  if (action === 'set') return store.set(args?.key, args?.value);
  if (action === 'ensure') return store.ensure(args?.key, args?.value);
  if (action === 'remove') return store.remove(args?.key);
  return fail('INVALID_ARGS', `未知动作：${action}（只支持 load / save / get / set / ensure / remove / keys / stats / writable / decide / normalize / parse）`);
}
