// tools/module-switch — 模块开关的读取、变更、限频与自动恢复
//
// 契约：docs/module-contract.md v1.1（H1 分级 / H2 清单 / H3 状态 / H4 工具 / H5 防呆 / H6 审计 / H7 热生效）
// deps：log, now                 （optional：state —— 本模块用注入的 readState/writeState 代替）
// 失败策略：fail closed           （依据：D 表 `tools/module-switch`「开关工具自身异常时必须拒绝一切变更」）
// 单测：tests/module-switch.test.mjs
//
// 为什么需要：QQ 侧 AI 需要自己开关一部分增强模块，但「允许它关」和「它能不能关掉地基」必须是两道
// 不同的门。这个模块把分级（locked/owner/free）、精确键查找、仅主人可改、owner 确认码、限频与
// 24h 自动恢复收在一处实现，而不是散在提示词里靠劝。三条防呆（H5）任一条单独失效都还能拦住越权。
//
// 边界：不做 IO —— 状态由调用方以 readState/writeState 注入，审计由 audit 注入；不读系统时间（只用 now）；
// 不生成/校验确认码（NEED_CONFIRM 的判定依赖中枢注入的 ctx.ownerConfirmed，码的分发在 forward-approval）；
// 不发消息、不联网、不 import bridge.js、不持有任何模块级状态。
//
// 安全不变量（改代码前先读）：
//   1. level 只来自 registry（代码），状态文件里的 level 只是诊断快照，永不参与鉴权；
//   2. 精确键查找失败即 UNKNOWN_MODULE，无别名、无大小写折叠、无前缀补全；
//   3. locked 一律拒绝（不分 on/off），且文件里被写成 on:false 时强制回 true 并留审计；
//   4. isOn 每次读内存缓存，toggle 后立即生效，不需要重启（H7）。

const LEVELS = Object.freeze(['free', 'owner', 'locked']);
const AUDIT_SRC = Object.freeze(['qq_module_toggle', 'console', 'boot-sweep', 'tick-sweep']);
const REASON_MAX = 200;
const TOGGLE_TIMES_MAX = 10;

export const spec = Object.freeze({
  name: 'tools/module-switch',
  version: '1.0.0',
  deps: Object.freeze(['log', 'now']),
  optionalDeps: Object.freeze(['state']),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

export const LIMITS = Object.freeze({ windowMs: 600_000, maxInWindow: 2, autoRestoreMs: 86_400_000 });

/** 从任意抛出物里取出可读说明。 */
function messageOf(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' ? v : null);

/**
 * 本地时间 + 时区偏移（H6 明确不用 toISOString 的 UTC）。
 * 只把注入的 now() 格式化，不读系统时钟。
 */
function localIso(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/**
 * 创建模块开关工具。
 *
 * @param {object}   opts
 * @param {Function} opts.log        必填，(level, msg, meta?) => void
 * @param {Function} opts.now        必填，() => number（毫秒）
 * @param {object}   opts.registry   必填，{ get(name), list() }，只读清单
 * @param {Function} opts.readState  必填，() => unknown（读不到返回 undefined/null，不得抛）
 * @param {Function} opts.writeState 必填，(state) => void，落盘由调用方负责（原子写/去抖）
 * @param {Function} [opts.audit]    可选，(entry) => void，审计失败不影响开关结果
 * @param {object}   [opts.limits]   可选，覆盖 LIMITS 中的窗口/次数/自动恢复时长
 */
export function createModuleSwitch({
  log,
  now,
  registry,
  readState,
  writeState,
  audit,
  limits
} = {}) {
  if (typeof log !== 'function') throw new TypeError('createModuleSwitch: 缺少必需依赖 log(level, msg, meta?)');
  if (typeof now !== 'function') throw new TypeError('createModuleSwitch: 缺少必需依赖 now()');
  if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
    throw new TypeError('createModuleSwitch: registry 必须提供 get(name) 与 list()');
  }
  if (typeof readState !== 'function') throw new TypeError('createModuleSwitch: 缺少必需依赖 readState()');
  if (typeof writeState !== 'function') throw new TypeError('createModuleSwitch: 缺少必需依赖 writeState(state)');

  const windowMs = Number.isFinite(limits?.windowMs) ? limits.windowMs : LIMITS.windowMs;
  const maxInWindow = Number.isFinite(limits?.maxInWindow) ? limits.maxInWindow : LIMITS.maxInWindow;
  const autoRestoreMs = Number.isFinite(limits?.autoRestoreMs) ? limits.autoRestoreMs : LIMITS.autoRestoreMs;

  // H3 的内存缓存：唯一真相（读 O(1)，写先改内存再交给 writeState）
  const state = { version: 1, updatedAt: 0, switches: {}, stats: {} };
  let dirty = false;

  const reportedLevels = new Set();

  /** level 只认三种；非法值按 H1 的安全默认降级为 owner，并只告警一次。 */
  function levelOf(entry) {
    const level = entry?.level;
    if (LEVELS.includes(level)) return level;
    if (!reportedLevels.has(entry?.name)) {
      reportedLevels.add(entry?.name);
      log('warn', `[tools/module-switch] ${entry?.name} 的 level 非法（${String(level)}），按 owner 处理`);
    }
    return 'owner';
  }

  /** H6 审计：字段顺序固定，失败只 warn，绝不阻断开关操作。 */
  function emitAudit({ actor, actorKind, name, from, to, level, reason, result, src }) {
    if (typeof audit !== 'function') return;
    const entry = {
      ts: localIso(now()),
      actor,
      actorKind,
      module: name,
      from,
      to,
      level,
      reason: reason && reason.length > 0 ? reason : '(no reason)',
      result,
      src: AUDIT_SRC.includes(src) ? src : 'qq_module_toggle'
    };
    try {
      audit(entry);
    } catch (err) {
      log('warn', `[tools/module-switch] 审计写入失败（${entry.module}）：${messageOf(err)}`);
    }
  }

  /** H3：写盘失败保留内存状态并记 error，绝不向上抛。 */
  function flush() {
    try {
      writeState(state);
      dirty = false;
    } catch (err) {
      dirty = true;
      log('error', `[tools/module-switch] 开关状态写盘失败，已保留内存状态待重试：${messageOf(err)}`);
    }
  }

  // ---------- 启动加载（H3 降级表） ----------

  function load() {
    let raw;
    try {
      raw = readState();
    } catch (err) {
      // IO 失败不是"损坏"：不覆盖、不抛，全部先用默认值，记 dirty 让调用方重试
      log('error', `[tools/module-switch] 开关状态读取失败，全部按默认值：${messageOf(err)}`);
      dirty = true;
      return;
    }

    if (raw === undefined || raw === null) {
      // 文件不存在（首次运行）：全部 default，置 dirty，由调用方决定是否立刻写基线
      dirty = true;
      return;
    }

    if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.switches)) {
      // JSON 损坏 / 结构不对 / 版本更高：全部回默认，绝不抛；原文件由调用方留证不覆盖
      log('error', '[tools/module-switch] 开关状态结构异常（version/switches 不合法），全部回默认值，未覆盖原文件');
      return;
    }

    for (const [name, rec] of Object.entries(raw.switches)) {
      const entry = registry.get(name);
      if (!entry) {
        // 代码里已不存在的模块：忽略该条（不加载、不删除），便于回滚旧版本
        log('warn', `[tools/module-switch] 状态里有未知模块 ${name}，已忽略`);
        continue;
      }
      if (!isPlainObject(rec)) {
        log('warn', `[tools/module-switch] 状态里 ${name} 的条目不是对象，已忽略`);
        continue;
      }

      const level = levelOf(entry);
      let on = typeof rec.on === 'boolean' ? rec.on : entry.default === true;

      // 防手改提权：locked 不允许被文件关掉
      if (level === 'locked' && on === false) {
        log('error', `[tools/module-switch] ${name} 在状态文件里被写成 false，locked 模块强制恢复 true`);
        emitAudit({
          actor: 'system',
          actorKind: 'system',
          name,
          from: false,
          to: true,
          level,
          reason: 'reject-locked-override',
          result: 'rejected',
          src: 'boot-sweep'
        });
        on = true;
      }

      state.switches[name] = {
        on,
        level,
        changedAt: numOrNull(rec.changedAt),
        changedBy: strOrNull(rec.changedBy),
        reason: strOrNull(rec.reason) ?? '(no reason)'
      };
    }

    if (isPlainObject(raw.stats)) {
      for (const [name, st] of Object.entries(raw.stats)) {
        if (!registry.get(name) || !isPlainObject(st)) continue;
        state.stats[name] = {
          toggleTimes: Array.isArray(st.toggleTimes)
            ? st.toggleTimes.filter((t) => Number.isFinite(t)).slice(-TOGGLE_TIMES_MAX)
            : [],
          offSince: Number.isFinite(st.offSince) ? st.offSince : null
        };
      }
    }

    state.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  }

  // ---------- 查询 ----------

  /** 热生效：每次读内存缓存；未记录用 registry default；registry 里没有 → false。 */
  function isOn(name) {
    const entry = registry.get(name);
    if (!entry) return false;
    const level = levelOf(entry);
    if (level === 'locked') return true; // locked 恒为开（H2/H3）
    const rec = state.switches[name];
    return rec ? rec.on === true : entry.default === true;
  }

  /** offReason 没有独立字段（H3 schema 不含它），从最近变更理由推导。 */
  function offReasonOf(rec) {
    if (!rec) return null;
    if (typeof rec.reason === 'string' && rec.reason.startsWith('missing-dep:')) return rec.reason;
    if (rec.reason === 'auto-restore-24h') return 'auto-restore';
    return null;
  }

  /** toggleable 必须与 toggle() 的门禁一致，否则 AI 会反复撞同一堵墙。 */
  function canToggle(session, level) {
    if (level === 'locked') return false;
    if (session?.kind !== 'private') return false;
    if (level === 'owner') return session?.isOwner === true;
    return true;
  }

  /** H4 qq_module_list：locked 也要列出来（带 toggleable:false），让 AI 知道地基不可动。 */
  function list(ctx) {
    const session = ctx?.session ?? {};
    const modules = registry.list().map((entry) => {
      const level = levelOf(entry);
      const rec = state.switches[entry.name];
      return {
        name: entry.name,
        level,
        on: isOn(entry.name),
        default: entry.default === true,
        hot: entry.hot !== false,
        toggleable: canToggle(session, level),
        lastChangedAt: rec?.changedAt ?? null,
        lastChangedBy: rec?.changedBy ?? null,
        offReason: offReasonOf(rec)
      };
    });
    return { ok: true, modules };
  }

  // ---------- 变更 ----------

  function actorOf(ctx) {
    const s = ctx?.session ?? {};
    if (s.kind === 'console' || s.isConsole === true) return 'console';
    if (s.kind === 'group') return `qq:group:${s.id ?? ''}${s.uid != null ? `:${s.uid}` : ''}`;
    if (s.kind === 'private') return `qq:private:${s.id ?? ''}`;
    return 'system';
  }

  const actorKindOf = (ctx) => {
    const s = ctx?.session ?? {};
    if (s.kind === 'console' || s.isConsole === true) return 'owner';
    return s.isOwner === true ? 'owner' : 'agent';
  };

  /**
   * H4 qq_module_toggle。校验顺序锁死（H5 + 任务书）：
   * 精确键查找 → locked → 调用者鉴权 → owner 确认码 → 参数合法性 → 同值 noop → 限频 → 写入。
   */
  function toggle(ctx, args) {
    const input = isPlainObject(args) ? args : {};
    const nowMs = now();
    const actor = actorOf(ctx);
    const actorKind = actorKindOf(ctx);

    // 1. 精确键查找：只 trim()，不做别名/大小写折叠/前缀补全
    const name = String(input.name ?? '').trim();
    const entry = registry.get(name);
    if (!entry) {
      return { ok: false, code: 'UNKNOWN_MODULE', error: `没有名为 ${name} 的模块` };
    }
    const level = levelOf(entry);
    const from = isOn(name);
    const attemptedTo = typeof input.on === 'boolean' ? input.on : from;

    // 2. locked 一律拒绝（不区分 on/off）
    if (level === 'locked') {
      emitAudit({ actor, actorKind, name, from, to: attemptedTo, level, reason: input.reason, result: 'rejected', src: input.src });
      return { ok: false, code: 'LOCKED', error: '该模块不可关闭' };
    }

    // 3. 调用者鉴权：群聊一律拒；owner 级只给主人
    if (ctx?.session?.kind !== 'private') {
      emitAudit({ actor, actorKind, name, from, to: attemptedTo, level, reason: input.reason, result: 'rejected', src: input.src });
      return { ok: false, code: 'FORBIDDEN', error: '群聊不可修改模块开关' };
    }
    if (level === 'owner' && ctx?.session?.isOwner !== true) {
      emitAudit({ actor, actorKind, name, from, to: attemptedTo, level, reason: input.reason, result: 'rejected', src: input.src });
      return { ok: false, code: 'FORBIDDEN', error: '该模块仅主人可改' };
    }

    // 4. owner 级需要一次性确认码（码的分发与校验在中枢/forward-approval）
    if (level === 'owner' && ctx?.ownerConfirmed !== true) {
      return { ok: false, code: 'NEED_CONFIRM', error: `请回复确认码以修改 ${name}` };
    }

    // 5. 参数合法性
    if (typeof input.on !== 'boolean') {
      return { ok: false, code: 'INVALID_ARGS', error: '字段 on 必须是布尔值' };
    }
    const reason = String(input.reason ?? '').trim();
    if (reason.length > REASON_MAX) {
      return { ok: false, code: 'INVALID_ARGS', error: `字段 reason 超过 ${REASON_MAX} 字` };
    }

    // 6. 同值 noop：不写审计、不计频次、不落盘
    if (input.on === from) {
      return { ok: true, noop: true };
    }

    // 7. 限频：窗口按模块独立计，只统计真正生效的变更
    const prevStats = state.stats[name] ?? { toggleTimes: [], offSince: null };
    const times = (prevStats.toggleTimes ?? []).filter((t) => nowMs - t < windowMs);
    if (times.length >= maxInWindow) {
      const nextAllowedAt = times[0] + windowMs;
      emitAudit({ actor, actorKind, name, from, to: input.on, level, reason, result: 'rejected', src: input.src });
      return {
        ok: false,
        code: 'RATE_LIMITED',
        error: `该模块 ${Math.round(windowMs / 60_000)} 分钟内已改 ${maxInWindow} 次，请稍后再试`,
        nextAllowedAt
      };
    }

    // 8. 写入：先改内存 → 立即回包（落盘交给 writeState）
    state.switches[name] = {
      on: input.on,
      level,
      changedAt: nowMs,
      changedBy: actor,
      reason: reason.length > 0 ? reason : '(no reason)'
    };
    state.stats[name] = {
      toggleTimes: [...times, nowMs].slice(-TOGGLE_TIMES_MAX),
      offSince: input.on ? null : nowMs
    };
    state.updatedAt = nowMs;
    flush();

    emitAudit({
      actor,
      actorKind,
      name,
      from,
      to: input.on,
      level,
      reason: reason.length > 0 ? reason : '(no reason)',
      result: 'applied',
      src: input.src
    });

    return { ok: true, name, from, to: input.on, level, changedAt: nowMs };
  }

  /**
   * 自动恢复（H5 规则 3）：只对 free 级、已关闭且超过 autoRestoreMs 的项恢复默认。
   * 幂等：恢复后清 offSince，重复调用不会重复计数。
   * @param {number} [nowMs] 判定时刻，默认取注入的 now()
   * @param {string} [src]   'tick-sweep'（默认）或 'boot-sweep'
   * @returns {number} 被恢复的条数
   */
  function sweep(nowMs = now(), src = 'tick-sweep') {
    const atMs = Number.isFinite(nowMs) ? nowMs : now();
    let restored = 0;

    for (const entry of registry.list()) {
      const level = levelOf(entry);
      if (level !== 'free') continue; // owner / locked 永不自动恢复

      const rec = state.switches[entry.name];
      if (!rec || rec.on !== false) continue;

      const st = state.stats[entry.name];
      if (!st || !Number.isFinite(st.offSince)) continue;
      if (atMs - st.offSince <= autoRestoreMs) continue;

      const to = entry.default === true;
      state.switches[entry.name] = {
        on: to,
        level,
        changedAt: atMs,
        changedBy: 'system',
        reason: 'auto-restore-24h'
      };
      st.offSince = null;
      state.updatedAt = atMs;
      restored += 1;

      emitAudit({
        actor: 'system',
        actorKind: 'system',
        name: entry.name,
        from: false,
        to,
        level,
        reason: 'auto-restore-24h',
        result: 'auto-restore',
        src
      });
    }

    if (restored > 0) flush();
    return restored;
  }

  /** 是否有未落盘的变更（H3：文件不存在 / 写盘失败时为 true，由调用方决定何时写）。 */
  function isDirty() {
    return dirty;
  }

  load();

  return { isOn, list, toggle, sweep, isDirty };
}
