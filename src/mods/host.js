// mods/host — 挂点注册与安全分发
//
// 契约：docs/mod-system-draft.md 第四~六节（v1 四个挂点）
// deps：log, now
// 失败策略：fail open —— 单个 mod 异常/超时只影响该次调用，绝不打断桥主链路。
//
// 边界：不 import bridge.js，不读 cfg/state/env，不写文件、不联网、不起常驻定时器。
// 文件/状态/审计全部由中枢注入；本模块只持有一次启动期注册的内存表。

export const spec = Object.freeze({
  name: 'mods/host',
  version: '1.0.0',
  deps: Object.freeze(['log', 'now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: false })
});

export const HOOKS = Object.freeze([
  'inbound.observe',
  'outbound.observe',
  'wake.before',
  'tick.daily'
]);

export const LIMITS = Object.freeze({
  wakeAppendChars: 200,
  tickTimeoutMs: 200
});

function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error ?? 'unknown error');
}

function clip(value, max) {
  const chars = [...String(value ?? '')];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function freezePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.isFrozen(value)) Object.freeze(value);
  }
  return Object.freeze(payload);
}

/**
 * @param {object} opts
 * @param {(level:string,message:string,meta?:object)=>void} opts.log
 * @param {()=>number} opts.now
 * @param {(line:string)=>void} [opts.audit] 写审计（中枢注入 appendActivity）
 * @param {object} [opts.limits] 覆盖 wakeAppendChars / tickTimeoutMs
 */
export function createModHost({ log, now, audit, limits } = {}) {
  if (typeof log !== 'function') throw new TypeError('createModHost: 缺少必需依赖 log');
  if (typeof now !== 'function') throw new TypeError('createModHost: 缺少必需依赖 now');

  const wakeAppendChars = Number.isFinite(limits?.wakeAppendChars) && limits.wakeAppendChars >= 0
    ? Math.floor(limits.wakeAppendChars)
    : LIMITS.wakeAppendChars;
  const tickTimeoutMs = Number.isFinite(limits?.tickTimeoutMs) && limits.tickTimeoutMs > 0
    ? Math.floor(limits.tickTimeoutMs)
    : LIMITS.tickTimeoutMs;

  const registered = new Map(HOOKS.map((name) => [name, []]));
  const stats = { dispatched: 0, failed: 0 };

  function safeAudit(line) {
    if (typeof audit !== 'function') return;
    try {
      audit(String(line ?? ''));
    } catch (error) {
      log('warn', `[mods/host] 审计写入失败: ${messageOf(error)}`);
    }
  }

  function note(record, result) {
    if (result == null) return;
    const text = typeof result === 'string' ? result : (typeof result?.note === 'string' ? result.note : '');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) safeAudit(`[mod:${record.modId}] ${clip(clean, 500)}`);
  }

  function register(name, handler, manifest) {
    if (!HOOKS.includes(name)) {
      log('warn', `[mods/host] 忽略未开放挂点 ${String(name)}（mod=${String(manifest?.id ?? '?')}）`);
      return () => {};
    }
    if (typeof handler !== 'function') throw new TypeError(`hook ${name} 必须是函数`);
    const modId = String(manifest?.id ?? '<unknown>');
    const context = Object.freeze({
      mod: Object.freeze({
        id: modId,
        name: String(manifest?.name ?? modId),
        version: String(manifest?.version ?? '')
      }),
      log: (level, message) => log(String(level ?? 'info'), `[mod:${modId}] ${String(message ?? '')}`),
      audit: (message) => safeAudit(`[mod:${modId}] ${String(message ?? '')}`)
    });
    const record = { modId, name, handler, context };
    registered.get(name).push(record);
    return () => {
      const list = registered.get(name);
      const index = list.indexOf(record);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** 只读观察：同步异常与异步拒绝都被吞掉；返回的 note 写审计。 */
  function observe(name, payload) {
    const list = registered.get(name);
    if (!list || !list.length) return;
    const frozen = freezePayload({ ...payload });
    for (const record of list.slice()) {
      stats.dispatched += 1;
      try {
        const result = record.handler(record.context, frozen);
        if (result && typeof result.then === 'function') {
          result.then((value) => note(record, value)).catch((error) => {
            stats.failed += 1;
            log('warn', `[mods/host] ${name} 异步失败（mod=${record.modId}）: ${messageOf(error)}`);
          });
        } else {
          note(record, result);
        }
      } catch (error) {
        stats.failed += 1;
        log('warn', `[mods/host] ${name} 失败（mod=${record.modId}）: ${messageOf(error)}`);
      }
    }
  }

  /** wake.before 同步执行，多个 mod 合计最多 200 字；异步返回值一律忽略。 */
  function wakeAppend(payload = {}) {
    const list = registered.get('wake.before');
    if (!list || !list.length) return '';
    const frozen = freezePayload({ ...payload });
    let remaining = wakeAppendChars;
    const parts = [];
    for (const record of list.slice()) {
      if (remaining <= 0) break;
      stats.dispatched += 1;
      try {
        const result = record.handler(record.context, frozen);
        if (result && typeof result.then === 'function') {
          log('warn', `[mods/host] wake.before 不允许异步，已忽略（mod=${record.modId}）`);
          continue;
        }
        if (!result || typeof result.append !== 'string') continue;
        const text = result.append.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const clipped = clip(text, remaining);
        remaining -= [...clipped].length;
        if (clipped) parts.push(clipped);
      } catch (error) {
        stats.failed += 1;
        log('warn', `[mods/host] wake.before 失败（mod=${record.modId}）: ${messageOf(error)}`);
      }
    }
    return parts.join('\n');
  }

  /** 每日 tick：逐 mod 执行，单个超时/异常只记账，不影响后续 mod。 */
  async function runDaily(payload = {}) {
    const list = registered.get('tick.daily');
    const frozen = freezePayload({ ...payload });
    let ran = 0;
    let failed = 0;
    for (const record of list.slice()) {
      stats.dispatched += 1;
      let timer = null;
      try {
        const call = Promise.resolve().then(() => record.handler(record.context, frozen));
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout ${tickTimeoutMs}ms`)), tickTimeoutMs);
          timer.unref?.();
        });
        await Promise.race([call, timeout]);
        ran += 1;
      } catch (error) {
        failed += 1;
        stats.failed += 1;
        log('warn', `[mods/host] tick.daily 失败（mod=${record.modId}）: ${messageOf(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { ran, failed, at: now() };
  }

  function status() {
    const hooks = {};
    for (const name of HOOKS) hooks[name] = registered.get(name).map((record) => record.modId);
    return { hooks, stats: { ...stats }, limits: { wakeAppendChars, tickTimeoutMs } };
  }

  return { register, observe, wakeAppend, runDaily, status };
}
