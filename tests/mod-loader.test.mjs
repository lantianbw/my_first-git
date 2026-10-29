import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  spec,
  parseManifest,
  resolveOrder,
  createModLoader,
  handle
} from '../src/mods/loader.js';

function manifest(id, overrides = {}) {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1',
    entry: './index.js',
    depends: [],
    hooks: ['tick.daily'],
    level: 'owner',
    default: true,
    ...overrides
  };
}

/** 每个用例都有独立临时 mods 目录；加载器拿到的仍是三个假 IO 注入。 */
function harness(t, definitions) {
  const root = mkdtempSync(join(tmpdir(), 'qq-bridge-mod-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const raws = new Map();
  const byId = new Map();
  const calls = { imports: [], setups: [], registrations: [], logs: [] };
  const active = new Map();
  let registrationId = 0;

  for (const [index, definition] of definitions.entries()) {
    const dirName = definition.dirName ?? definition.manifest?.id ?? `broken-${index}`;
    const raw = definition.raw ?? JSON.stringify(definition.manifest);
    raws.set(dirName, raw);
    mkdirSync(join(root, dirName), { recursive: true });
    writeFileSync(join(root, dirName, 'mod.json'), raw, 'utf8');
    if (definition.manifest?.id && !byId.has(definition.manifest.id)) {
      byId.set(definition.manifest.id, definition);
    }
  }

  const ctx = {
    log: (level, msg, meta) => calls.logs.push({ level, msg, meta }),
    registerHook(name, handler, owner) {
      const key = `${owner.id}:${name}:${registrationId++}`;
      active.set(key, { id: owner.id, name, handler });
      calls.registrations.push({ id: owner.id, name });
      return () => active.delete(key);
    }
  };

  const injections = {
    listDirs: async () => definitions.map((definition, index) => (
      definition.dirName ?? definition.manifest?.id ?? `broken-${index}`
    )),
    readManifest: async (dirName) => {
      const definition = definitions.find((item, index) => (
        (item.dirName ?? item.manifest?.id ?? `broken-${index}`) === dirName
      ));
      if (definition?.readError) throw definition.readError;
      return raws.get(dirName);
    },
    importEntry: async (entry, owner) => {
      calls.imports.push({ entry, id: owner.id });
      const definition = byId.get(owner.id);
      if (definition?.importError) throw definition.importError;
      const value = definition?.module ?? { hooks: { 'tick.daily': () => {} } };
      return definition?.directModule ? value : { default: value };
    },
    log: ctx.log
  };

  return {
    root,
    ctx,
    injections,
    calls,
    loader: createModLoader(injections),
    activeHooks: () => [...active.values()].map(({ id, name }) => `${id}:${name}`).sort()
  };
}

test('spec：模块契约完整且冻结', () => {
  assert.equal(spec.name, 'mods/loader');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: false });
  assert.ok(Object.isFrozen(spec));
});

test('parseManifest：解析标准清单并补默认 entry/depends/hooks', () => {
  const out = parseManifest(JSON.stringify({
    id: 'alpha', version: '1.2.3', apiVersion: '1'
  }), 'alpha-dir');
  assert.equal(out.ok, true);
  assert.equal(out.manifest.id, 'alpha');
  assert.equal(out.manifest.entry, './index.js');
  assert.deepEqual(out.manifest.depends, []);
  assert.deepEqual(out.manifest.hooks, []);
  assert.equal(out.manifest.dirName, 'alpha-dir');
});

test('parseManifest：坏 JSON 返回契约错误，不抛异常', () => {
  const out = parseManifest('{bad json', 'broken-dir');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_ARGS');
  assert.match(out.error, /^broken-dir: /);
});

test('parseManifest：缺 id 或坏 semver 均视为坏清单', () => {
  assert.equal(parseManifest('{"version":"1.0.0"}', 'x').ok, false);
  assert.equal(parseManifest('{"id":"x","version":"1"}', 'x').ok, false);
});

test('正常单 mod：导入、setup、注册声明挂点并返回 loaded id', async (t) => {
  const h = harness(t, [{
    manifest: manifest('alpha'),
    module: {
      setup(ctx) {
        h.calls.setups.push('alpha');
        assert.equal(ctx.mod.id, 'alpha');
      },
      hooks: { 'tick.daily': () => {} }
    }
  }]);

  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: ['alpha'], skipped: [] });
  assert.deepEqual(h.calls.imports, [{ entry: './index.js', id: 'alpha' }]);
  assert.deepEqual(h.calls.setups, ['alpha']);
  assert.deepEqual(h.activeHooks(), ['alpha:tick.daily']);
});

test('多 mod 依赖：输入乱序仍按拓扑顺序加载', async (t) => {
  const h = harness(t, [
    { manifest: manifest('charlie', { depends: [{ id: 'bravo', version: '>=1.0.0' }] }) },
    { manifest: manifest('alpha') },
    { manifest: manifest('bravo', { depends: [{ id: 'alpha', version: '^1.0.0' }] }) }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['alpha', 'bravo', 'charlie']);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(h.calls.imports.map((item) => item.id), ['alpha', 'bravo', 'charlie']);
});

test('缺依赖：原因精确，独立 mod 仍继续加载', async (t) => {
  const h = harness(t, [
    { manifest: manifest('alpha', { depends: [{ id: 'ghost', version: '*' }] }) },
    { manifest: manifest('independent') }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['independent']);
  assert.deepEqual(out.skipped, [{ id: 'alpha', reason: 'missing-dep:ghost' }]);
});

test('成环：环上所有节点都是 dependency-cycle，环外 mod 不受影响', async (t) => {
  const h = harness(t, [
    { manifest: manifest('alpha', { depends: [{ id: 'bravo' }] }) },
    { manifest: manifest('bravo', { depends: [{ id: 'alpha' }] }) },
    { manifest: manifest('independent') }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['independent']);
  assert.deepEqual(out.skipped, [
    { id: 'alpha', reason: 'dependency-cycle' },
    { id: 'bravo', reason: 'dependency-cycle' }
  ]);
});

test('环的后继：按 missing-dep 跳过，不误报为环上节点', () => {
  const out = resolveOrder([
    manifest('alpha', { depends: [{ id: 'bravo' }] }),
    manifest('bravo', { depends: [{ id: 'alpha' }] }),
    manifest('charlie', { depends: [{ id: 'alpha' }] })
  ]);
  assert.deepEqual(out.order, []);
  assert.deepEqual(out.skipped, [
    { id: 'alpha', reason: 'dependency-cycle' },
    { id: 'bravo', reason: 'dependency-cycle' },
    { id: 'charlie', reason: 'missing-dep:alpha' }
  ]);
});

test('apiVersion 不对：准确返回 bad-api-version 且不导入', async (t) => {
  const h = harness(t, [{ manifest: manifest('old-mod', { apiVersion: '2' }) }]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: [], skipped: [{ id: 'old-mod', reason: 'bad-api-version' }] });
  assert.deepEqual(h.calls.imports, []);
});

test('locked mod：准确返回 locked-not-allowed 且不导入', async (t) => {
  const h = harness(t, [{ manifest: manifest('intruder', { level: 'locked' }) }]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: [], skipped: [{ id: 'intruder', reason: 'locked-not-allowed' }] });
  assert.deepEqual(h.calls.imports, []);
});

test('清单 JSON 坏：用目录名记 bad-manifest，主流程不抛', async (t) => {
  const h = harness(t, [
    { dirName: 'broken-dir', raw: '{ definitely not json' },
    { manifest: manifest('good') }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['good']);
  assert.deepEqual(out.skipped, [{ id: 'broken-dir', reason: 'bad-manifest' }]);
});

test('readManifest 抛错：按 bad-manifest fail open', async (t) => {
  const h = harness(t, [{
    manifest: manifest('unreadable'),
    readError: new Error('permission denied')
  }]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: [], skipped: [{ id: 'unreadable', reason: 'bad-manifest' }] });
});

test('entry 导入抛错：返回精确 load-failed:<msg>', async (t) => {
  const h = harness(t, [{
    manifest: manifest('bad-entry'),
    importError: new Error('entry exploded')
  }]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, {
    loaded: [],
    skipped: [{ id: 'bad-entry', reason: 'load-failed:entry exploded' }]
  });
});

test('setup 抛错：已注册挂点全部撤销，后续 mod 继续', async (t) => {
  const h = harness(t, [
    {
      manifest: manifest('bad-setup'),
      module: {
        setup(ctx) {
          ctx.registerHook('tick.daily', () => {});
          assert.deepEqual(h.activeHooks(), ['bad-setup:tick.daily']);
          throw new Error('setup exploded');
        },
        hooks: {}
      }
    },
    { manifest: manifest('good') }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['good']);
  assert.deepEqual(out.skipped, [{ id: 'bad-setup', reason: 'load-failed:setup exploded' }]);
  assert.deepEqual(h.activeHooks(), ['good:tick.daily']);
});

test('hooks 未声明：入口额外挂点及 setup 主动注册都忽略', async (t) => {
  const h = harness(t, [{
    manifest: manifest('limited', { hooks: [] }),
    module: {
      setup(ctx) {
        ctx.registerHook('wake.before', () => {});
      },
      hooks: {
        'tick.daily': () => {},
        'wake.before': () => {}
      }
    }
  }]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: ['limited'], skipped: [] });
  assert.deepEqual(h.calls.registrations, []);
  assert.deepEqual(h.activeHooks(), []);
});

test('空 mods 目录：返回两个空数组，不调用导入', async (t) => {
  const h = harness(t, []);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: [], skipped: [] });
  assert.deepEqual(h.calls.imports, []);
});

test('重复 id：保留首个、跳过后者，reason 为 duplicate-id', async (t) => {
  const h = harness(t, [
    { dirName: 'first', manifest: manifest('same-id') },
    { dirName: 'second', manifest: manifest('same-id') }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, {
    loaded: ['same-id'],
    skipped: [{ id: 'same-id', reason: 'duplicate-id' }]
  });
  assert.equal(h.calls.imports.length, 1);
});

test('版本区间不满足：跳过依赖者并给出准确依赖 id', async (t) => {
  const h = harness(t, [
    { manifest: manifest('library', { version: '1.2.3' }) },
    { manifest: manifest('application', { depends: [{ id: 'library', version: '>=2.0.0' }] }) }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out.loaded, ['library']);
  assert.deepEqual(out.skipped, [{ id: 'application', reason: 'version-mismatch:library' }]);
  assert.deepEqual(h.calls.imports.map((item) => item.id), ['library']);
});

test('版本区间满足：支持 AND 比较符并先加载依赖', async (t) => {
  const h = harness(t, [
    { manifest: manifest('application', { depends: [{ id: 'library', version: '>=2.0.0 <3.0.0' }] }) },
    { manifest: manifest('library', { version: '2.5.0' }) }
  ]);
  const out = await h.loader.load(h.ctx);
  assert.deepEqual(out, { loaded: ['library', 'application'], skipped: [] });
});

test('缺依赖向后传播：依赖者的依赖者也必须跳过', () => {
  const out = resolveOrder([
    manifest('alpha', { depends: [{ id: 'ghost' }] }),
    manifest('bravo', { depends: [{ id: 'alpha' }] })
  ]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.skipped, [
    { id: 'alpha', reason: 'missing-dep:ghost' },
    { id: 'bravo', reason: 'missing-dep:alpha' }
  ]);
});

test('handle 门面：返回 {ok:true,value}，值与 load 一致', async (t) => {
  const h = harness(t, [{ manifest: manifest('alpha') }]);
  const out = await handle(h.ctx, h.injections);
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { loaded: ['alpha'], skipped: [] });
});

test('扫描失败：listDirs 抛错也不向上抛，只返回 skipped', async () => {
  const loader = createModLoader({
    listDirs: async () => { throw new Error('scan failed'); },
    readManifest: async () => '{}',
    importEntry: async () => ({}),
    log: () => {}
  });
  const out = await loader.load();
  assert.deepEqual(out, {
    loaded: [],
    skipped: [{ id: '<mods>', reason: 'load-failed:scan failed' }]
  });
});

test('日志失败：仍不阻断正常加载（fail open）', async (t) => {
  const h = harness(t, [{ manifest: manifest('alpha') }]);
  const loader = createModLoader({ ...h.injections, log: () => { throw new Error('log failed'); } });
  const out = await loader.load(h.ctx);
  assert.deepEqual(out, { loaded: ['alpha'], skipped: [] });
});
