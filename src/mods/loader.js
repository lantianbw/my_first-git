// mods/loader — 扫描、解析并按依赖顺序安全加载 mods
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：log                     （optional：无；IO 与挂点注册器由调用方注入）
// 失败策略：fail-open            （依据：mod-system-draft 第五节；少一个 mod 不影响主链路）
// 单测：tests/mod-loader.test.mjs
//
// 为什么需要：mod 的清单、依赖与 setup 都是不可信输入，加载器必须把单个 mod 的失败隔离在
// 自己的事务里，同时保证依赖先加载、环不进入主链路、失败后的挂点不残留。
//
// 边界：不 import bridge.js，不直接做文件 IO，不读 cfg/state/env，不写文件、不联网、不读时钟。
// 本模块不实现开关存储；草案第五步的开关判定由中枢在调用前完成。

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const spec = Object.freeze({
  name: 'mods/loader',
  version: '1.0.0',
  deps: Object.freeze(['log']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: false })
});

function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error ?? 'unknown error');
}

function safeLog(log, level, message, meta) {
  if (typeof log !== 'function') return;
  try {
    log(level, message, meta);
  } catch {
    // 日志自身失败不能递归记账，更不能把 fail-open 的加载流程带崩。
  }
}

function manifestError(dirName, error) {
  return { ok: false, code: 'INVALID_ARGS', error: `${dirName}: ${error}` };
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] === right[i]) continue;
    const leftNumber = /^\d+$/.test(left[i]);
    const rightNumber = /^\d+$/.test(right[i]);
    if (leftNumber && rightNumber) return Number(left[i]) < Number(right[i]) ? -1 : 1;
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function matchesComparator(version, comparator) {
  const token = comparator.trim();
  if (!token || token === '*' || token.toLowerCase() === 'x') return true;

  if (token.startsWith('^') || token.startsWith('~')) {
    const kind = token[0];
    const base = parseVersion(token.slice(1));
    if (!base || compareVersions(version, base) < 0) return false;
    const upper = { major: base.major, minor: base.minor, patch: base.patch, prerelease: [] };
    if (kind === '~') {
      upper.minor += 1;
      upper.patch = 0;
    } else if (base.major > 0) {
      upper.major += 1;
      upper.minor = 0;
      upper.patch = 0;
    } else if (base.minor > 0) {
      upper.minor += 1;
      upper.patch = 0;
    } else {
      upper.patch += 1;
    }
    return compareVersions(version, upper) < 0;
  }

  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  const target = parseVersion(match?.[2]);
  if (!target) return false;
  const comparison = compareVersions(version, target);
  switch (match[1] || '=') {
    case '>=': return comparison >= 0;
    case '<=': return comparison <= 0;
    case '>': return comparison > 0;
    case '<': return comparison < 0;
    default: return comparison === 0;
  }
}

function satisfies(versionValue, rangeValue) {
  const version = parseVersion(versionValue);
  if (!version) return false;
  const range = typeof rangeValue === 'string' && rangeValue.trim() ? rangeValue.trim() : '*';
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.every((comparator) => matchesComparator(version, comparator));
  });
}

/**
 * @pure 解析并校验一个 mod.json 文本；apiVersion/locked 留给加载器过滤，便于给出准确跳过原因。
 *
 * @param {string} raw mod.json 文本
 * @param {string} dirName 目录名，用于错误定位及清单损坏时的 skipped id
 * @returns {{ok:true, manifest:object}|{ok:false, code:string, error:string}}
 */
export function parseManifest(raw, dirName) {
  const dir = typeof dirName === 'string' && dirName ? dirName : '<unknown>';
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return manifestError(dir, messageOf(error));
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return manifestError(dir, 'manifest 必须是 JSON 对象');
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    return manifestError(dir, 'id 必须是非空字符串');
  }
  if (!parseVersion(value.version)) {
    return manifestError(dir, 'version 必须是合法 semver');
  }
  if (value.entry !== undefined && (typeof value.entry !== 'string' || !value.entry.trim())) {
    return manifestError(dir, 'entry 必须是非空字符串');
  }

  const depends = value.depends === undefined ? [] : value.depends;
  if (!Array.isArray(depends)) return manifestError(dir, 'depends 必须是数组');
  for (const dependency of depends) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      return manifestError(dir, 'depends 项必须是对象');
    }
    if (typeof dependency.id !== 'string' || !dependency.id.trim()) {
      return manifestError(dir, 'depends.id 必须是非空字符串');
    }
    if (dependency.version !== undefined && typeof dependency.version !== 'string') {
      return manifestError(dir, 'depends.version 必须是字符串');
    }
  }

  const hooks = value.hooks === undefined ? [] : value.hooks;
  if (!Array.isArray(hooks) || hooks.some((hook) => typeof hook !== 'string' || !hook.trim())) {
    return manifestError(dir, 'hooks 必须是非空字符串数组');
  }

  const manifest = {
    ...value,
    id: value.id.trim(),
    entry: value.entry === undefined ? './index.js' : value.entry.trim(),
    depends: depends.map((dependency) => ({
      id: dependency.id.trim(),
      version: dependency.version === undefined ? '*' : dependency.version
    })),
    hooks: [...new Set(hooks.map((hook) => hook.trim()))],
    dirName: dir
  };
  return { ok: true, manifest };
}

/**
 * @pure 去重、校验依赖版本并做稳定拓扑排序。环上节点单独标记，后继节点按缺依赖跳过。
 *
 * @param {object[]} manifests parseManifest 成功后的 manifest 数组
 * @returns {{ok:boolean, order:string[], skipped:Array<{id:string, reason:string}>}}
 */
export function resolveOrder(manifests) {
  if (!Array.isArray(manifests)) {
    return { ok: false, order: [], skipped: [{ id: '<mods>', reason: 'bad-manifest' }] };
  }

  const records = [];
  const byId = new Map();
  const skippedById = new Map();
  const skipped = [];

  for (const manifest of manifests) {
    const id = manifest && typeof manifest.id === 'string' ? manifest.id : '<unknown>';
    if (!manifest || typeof manifest !== 'object' || !id.trim() || id === '<unknown>') {
      skipped.push({ id, reason: 'bad-manifest' });
      continue;
    }
    if (byId.has(id)) {
      skipped.push({ id, reason: 'duplicate-id' });
      continue;
    }
    const normalized = { ...manifest, depends: Array.isArray(manifest.depends) ? manifest.depends : [] };
    byId.set(id, normalized);
    records.push(normalized);
  }

  // DFS 只标记真正位于回边上的环节点；不能把所有“排序剩余节点”都误判为环。
  const state = new Map();
  const stack = [];
  function findCycles(id) {
    const current = state.get(id) || 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      for (const cycleId of stack.slice(start)) skippedById.set(cycleId, 'dependency-cycle');
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of byId.get(id).depends) {
      if (byId.has(dependency.id)) findCycles(dependency.id);
    }
    stack.pop();
    state.set(id, 2);
  }
  for (const id of byId.keys()) findCycles(id);

  // 一个 mod 被跳过后，它的依赖者也不能加载；迭代到不动点以覆盖依赖链。
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, manifest] of byId) {
      if (skippedById.has(id)) continue;
      for (const dependency of manifest.depends) {
        const target = byId.get(dependency.id);
        let reason = null;
        if (!target || skippedById.has(dependency.id)) reason = `missing-dep:${dependency.id}`;
        else if (!satisfies(target.version, dependency.version)) reason = `version-mismatch:${dependency.id}`;
        if (reason) {
          skippedById.set(id, reason);
          changed = true;
          break;
        }
      }
    }
  }

  for (const id of byId.keys()) {
    if (skippedById.has(id)) skipped.push({ id, reason: skippedById.get(id) });
  }

  const order = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id) || skippedById.has(id)) return;
    visited.add(id);
    for (const dependency of byId.get(id).depends) visit(dependency.id);
    order.push(id);
  }
  for (const id of byId.keys()) visit(id);

  return { ok: skipped.length === 0, order, skipped };
}

function rollback(registrations, log, modId) {
  for (const dispose of registrations.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      safeLog(log, 'warn', `[mods/loader] 撤销挂点失败: ${messageOf(error)}`, { mod: modId });
    }
  }
}

function registrationContext(baseCtx, manifest, registrations, log) {
  const ctx = baseCtx && typeof baseCtx === 'object' ? baseCtx : {};
  const declared = new Set(manifest.hooks);
  const localHooks = new Set();
  const baseRegistrar = typeof ctx.registerHook === 'function'
    ? { fn: ctx.registerHook, owner: ctx }
    : (typeof ctx.hooks?.register === 'function' ? { fn: ctx.hooks.register, owner: ctx.hooks } : null);
  const baseUnregister = typeof ctx.unregisterHook === 'function'
    ? { fn: ctx.unregisterHook, owner: ctx }
    : (typeof ctx.hooks?.unregister === 'function' ? { fn: ctx.hooks.unregister, owner: ctx.hooks } : null);

  function registerHook(name, handler) {
    // 声明外的注册请求直接忽略；包括 setup 内主动注册，而不只检查入口 hooks 对象。
    if (!declared.has(name)) return () => {};
    if (typeof handler !== 'function') throw new TypeError(`hook ${name} 必须是函数`);

    let undo;
    if (baseRegistrar) {
      const result = baseRegistrar.fn.call(baseRegistrar.owner, name, handler, manifest);
      if (typeof result === 'function') undo = result;
      else if (baseUnregister) {
        undo = () => baseUnregister.fn.call(baseUnregister.owner, name, handler, manifest);
      } else {
        undo = () => {};
      }
    } else {
      localHooks.add(name);
      undo = () => localHooks.delete(name);
    }

    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      undo();
    };
    registrations.push(dispose);
    return dispose;
  }

  const modCtx = Object.create(ctx);
  modCtx.mod = manifest;
  modCtx.registerHook = registerHook;
  modCtx.hooks = Object.create(ctx.hooks && typeof ctx.hooks === 'object' ? ctx.hooks : null);
  modCtx.hooks.register = registerHook;
  modCtx.rollback = () => rollback(registrations, log, manifest.id);
  return modCtx;
}

/**
 * 构造加载器。注入签名：listDirs()、readManifest(dirName)、importEntry(entry, manifest)。
 * load(ctx) 的 ctx 可选；中枢可提供 registerHook(name, handler, manifest) => dispose。
 */
export function createModLoader({ listDirs, readManifest, importEntry, log }) {
  return {
    async load(ctx = {}) {
      const loaded = [];
      const skipped = [];
      const logger = typeof log === 'function' ? log : ctx?.log;
      const skip = (id, reason) => {
        skipped.push({ id, reason });
        safeLog(logger, 'warn', `[mods/loader] 跳过 ${id}: ${reason}`, { mod: id, reason });
      };

      let dirs;
      try {
        dirs = await listDirs();
        if (!Array.isArray(dirs)) throw new TypeError('listDirs 必须返回数组');
      } catch (error) {
        skip('<mods>', `load-failed:${messageOf(error)}`);
        return { loaded, skipped };
      }

      const manifests = [];
      for (const dirEntry of dirs) {
        const dirName = typeof dirEntry === 'string' ? dirEntry : String(dirEntry?.name ?? '<unknown>');
        let parsed;
        try {
          const raw = await readManifest(dirName);
          parsed = parseManifest(raw, dirName);
        } catch (error) {
          skip(dirName, 'bad-manifest');
          continue;
        }
        if (!parsed.ok) {
          skip(dirName, 'bad-manifest');
          continue;
        }
        const { manifest } = parsed;
        if (manifest.apiVersion !== '1') {
          skip(manifest.id, 'bad-api-version');
          continue;
        }
        if (manifest.level === 'locked') {
          skip(manifest.id, 'locked-not-allowed');
          continue;
        }
        manifests.push(manifest);
      }

      const resolved = resolveOrder(manifests);
      for (const item of resolved.skipped) skip(item.id, item.reason);
      const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));

      for (const id of resolved.order) {
        const manifest = byId.get(id);
        const registrations = [];
        try {
          const imported = await importEntry(manifest.entry, manifest);
          const entry = imported?.default ?? imported;
          if (!entry || typeof entry !== 'object') throw new TypeError('entry 默认导出必须是对象');

          const modCtx = registrationContext(ctx, manifest, registrations, logger);
          if (typeof entry.setup === 'function') await entry.setup(modCtx);

          const hooks = entry.hooks && typeof entry.hooks === 'object' ? entry.hooks : {};
          for (const name of manifest.hooks) {
            if (typeof hooks[name] === 'function') modCtx.registerHook(name, hooks[name]);
          }
          loaded.push(id);
        } catch (error) {
          rollback(registrations, logger, id);
          skip(id, `load-failed:${messageOf(error)}`);
        }
      }

      return { loaded, skipped };
    }
  };
}

/** 契约门面：args 提供三个 IO 适配器，中枢 ctx 提供日志与可选挂点注册器。 */
export async function handle(ctx, args = {}) {
  const loader = createModLoader({
    listDirs: args?.listDirs,
    readManifest: args?.readManifest,
    importEntry: args?.importEntry,
    log: args?.log ?? ctx?.log
  });
  const value = await loader.load(ctx);
  return { ok: true, value };
}
