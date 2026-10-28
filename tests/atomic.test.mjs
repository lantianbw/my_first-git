import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spec, readJsonSafe, writeJsonAtomic, writeTextAtomic } from '../src/persist/atomic.js';

/** 每个用例一个独立临时目录，结束后递归删除（不碰仓库里的 state/）。 */
function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 注入用的 fs 探针：默认透传真 fs，可按方法注入失败/计数。
 * 记录每次调用，便于断言「重试了几次」「临时文件有没有被清掉」。
 */
function spyFs(overrides = {}) {
  const calls = { read: [], write: [], rename: [], mkdir: [], unlink: [] };
  return {
    calls,
    readFileSync(file, enc) {
      calls.read.push(file);
      if (overrides.readFileSync) return overrides.readFileSync(file, enc);
      return fs.readFileSync(file, enc);
    },
    writeFileSync(file, data, opts) {
      calls.write.push({ file, data, opts });
      if (overrides.writeFileSync) return overrides.writeFileSync(file, data, opts);
      return fs.writeFileSync(file, data, opts);
    },
    renameSync(from, to) {
      calls.rename.push({ from, to });
      if (overrides.renameSync) return overrides.renameSync(from, to);
      return fs.renameSync(from, to);
    },
    mkdirSync(dir, opts) {
      calls.mkdir.push({ dir, opts });
      if (overrides.mkdirSync) return overrides.mkdirSync(dir, opts);
      return fs.mkdirSync(dir, opts);
    },
    unlinkSync(file) {
      calls.unlink.push(file);
      if (overrides.unlinkSync) return overrides.unlinkSync(file);
      return fs.unlinkSync(file);
    }
  };
}

const sysError = (code, message = code) => Object.assign(new Error(`${code}: ${message}`), { code });

function captureLog() {
  const lines = [];
  return { lines, log: (level, msg, meta) => lines.push({ level, msg, meta }) };
}

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'persist/atomic');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
});

test('正常读写：写入后可读回，格式为 2 空格缩进 + 结尾换行，mode 0o600', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'cfg.json');
  const value = { a: 1, b: ['x', { c: true }], 中文: '值', nested: { list: [1, 2] } };
  const io = spyFs();

  writeJsonAtomic(file, value, { fsImpl: io });

  // 落盘格式与旧实现逐字节一致
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(value, null, 2) + '\n');

  // 写入后内容与原对象深度相等
  assert.deepEqual(readJsonSafe(file, null, { fsImpl: io }), value);

  assert.equal(io.calls.mkdir.length, 1);
  assert.equal(io.calls.mkdir[0].opts.recursive, true);
  assert.equal(io.calls.write.length, 1);
  assert.equal(io.calls.write[0].opts.encoding, 'utf8');
  assert.equal(io.calls.write[0].opts.mode, 0o600);
  assert.equal(io.calls.rename.length, 1);
  assert.equal(io.calls.rename[0].to, file);
  assert.match(path.basename(io.calls.rename[0].from), /\.\d+\.[0-9a-f]{12}\.tmp$/, '临时名必须唯一');
  assert.equal(io.calls.unlink.length, 0, '成功路径不该有清理动作');
});

test('BOM：带 \\uFEFF 的文件也能解析', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'bom.json');
  fs.writeFileSync(file, '\uFEFF{"bom":true,"n":1}', 'utf8');

  assert.deepEqual(readJsonSafe(file, null, { fsImpl: spyFs() }), { bom: true, n: 1 });
  // 无 BOM 的普通文件照旧
  fs.writeFileSync(file, '{"plain":1}', 'utf8');
  assert.deepEqual(readJsonSafe(file, null, { fsImpl: spyFs() }), { plain: 1 });
});

test('目标文件被占用：EPERM 退避重试后成功', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'busy.json');
  let attempts = 0;
  const io = spyFs({
    renameSync(from, to) {
      attempts += 1;
      if (attempts <= 2) throw sysError('EPERM', 'operation not permitted');
      return fs.renameSync(from, to);
    }
  });
  const { lines, log } = captureLog();

  writeJsonAtomic(file, { ok: true }, { fsImpl: io, log, retry: { attempts: 4, delayMs: 1 } });

  assert.equal(io.calls.rename.length, 3, '前两次 EPERM，第三次成功');
  assert.deepEqual(readJsonSafe(file, null, { fsImpl: io }), { ok: true });
  assert.equal(lines.filter((l) => l.level === 'warn').length, 2, '每次重试留一条 warn');
  assert.equal(fs.existsSync(file), true);
});

test('目标文件被占用：重试用尽后抛出最后一个错误，且原内容不被覆盖', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'locked.json');
  fs.writeFileSync(file, 'ORIGINAL', 'utf8');

  const io = spyFs({
    renameSync() {
      throw sysError('EBUSY', 'resource busy');
    }
  });

  assert.throws(() => writeJsonAtomic(file, { n: 1 }, { fsImpl: io, retry: { attempts: 3, delayMs: 1 } }), /EBUSY/);

  assert.equal(io.calls.rename.length, 3, 'attempts=3 就是 3 次');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL', '旧内容必须完好');
  assert.equal(io.calls.unlink.length, 1, '临时文件要清理');
  assert.equal(fs.existsSync(io.calls.unlink[0]), false, '临时文件确实不在了');
});

test('目标文件被占用：attempts 默认 4（与旧实现一致）', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'default.json');
  const io = spyFs({
    renameSync() {
      throw sysError('EACCES', 'permission denied');
    }
  });

  assert.throws(() => writeJsonAtomic(file, { n: 1 }, { fsImpl: io, retry: { delayMs: 0 } }), /EACCES/);
  assert.equal(io.calls.rename.length, 4);
});

test('不可重试的错误：EXDEV / ENOENT 立即抛出，不做退避', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'xdev.json');
  const io = spyFs({
    renameSync() {
      throw sysError('EXDEV', 'cross-device link');
    }
  });

  assert.throws(() => writeJsonAtomic(file, { n: 1 }, { fsImpl: io, retry: { attempts: 4, delayMs: 1 } }), /EXDEV/);
  assert.equal(io.calls.rename.length, 1, '不可重试的错误一次都不该多试');
});

test('读坏 JSON / 文件缺失 → 返回 fallback，不抛', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"a": 1,,,', 'utf8');
  const io = spyFs();

  assert.equal(readJsonSafe(file, 'FB', { fsImpl: io }), 'FB');
  const fallbackObj = { d: 1 };
  assert.equal(readJsonSafe(path.join(dir, 'nope.json'), fallbackObj, { fsImpl: io }), fallbackObj, 'fallback 原样返回');

  // 空文件（JSON.parse('') 也会抛）
  fs.writeFileSync(file, '', 'utf8');
  assert.equal(readJsonSafe(file, null, { fsImpl: io }), null);
});

test('strict：读失败改抛错，消息带路径与原因', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, 'not json', 'utf8');
  const io = spyFs();

  assert.throws(
    () => readJsonSafe(file, 'FB', { fsImpl: io, strict: true }),
    (err) => {
      assert.match(err.message, /配置文件读取\/解析失败/);
      assert.ok(err.message.includes(file), '消息里必须能定位到文件');
      assert.match(err.message, /Unexpected token|JSON/i);
      return true;
    }
  );

  // 文件缺失 + strict 同样抛
  assert.throws(
    () => readJsonSafe(path.join(dir, 'missing.json'), null, { fsImpl: io, strict: true }),
    /配置文件读取\/解析失败/
  );

  // 非 strict 时同一份文件不抛
  assert.equal(readJsonSafe(file, 'FB', { fsImpl: io }), 'FB');
});

test('写坏文件不覆盖：临时文件写失败时旧内容保持完好并清理临时文件', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, 'ORIGINAL', 'utf8');

  const io = spyFs({
    writeFileSync() {
      throw sysError('ENOSPC', 'no space left on device');
    }
  });

  assert.throws(() => writeJsonAtomic(file, { n: 1 }, { fsImpl: io }), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL', '绝不能动旧文件');
  assert.equal(io.calls.unlink.length, 1, '要到临时文件上清理');
  assert.match(io.calls.unlink[0], /\.tmp$/);
});

test('写坏文件不覆盖：无法序列化（循环引用）时报错且不碰目标文件', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, 'ORIGINAL', 'utf8');

  const circular = {};
  circular.self = circular;

  assert.throws(() => writeJsonAtomic(file, circular, { fsImpl: spyFs() }), TypeError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL');
});

test('目录不存在：递归创建（与旧实现一致），父级多级缺失也行', (t) => {
  const dir = workdir(t);
  const deep = path.join(dir, 'a', 'b', 'c.json');
  const deepTxt = path.join(dir, 'x', 'y', 'z.txt');
  const io = spyFs();

  assert.equal(fs.existsSync(path.dirname(deep)), false);
  writeJsonAtomic(deep, { deep: 1 }, { fsImpl: io });
  assert.equal(fs.existsSync(deep), true);
  assert.deepEqual(readJsonSafe(deep, null, { fsImpl: io }), { deep: 1 });
  assert.equal(io.calls.mkdir[0].dir, path.dirname(deep));
  assert.equal(io.calls.mkdir[0].opts.recursive, true);

  writeTextAtomic(deepTxt, 'hi', { fsImpl: io });
  assert.equal(fs.readFileSync(deepTxt, 'utf8'), 'hi');
});

test('文本写入：原样落盘（不 JSON 化、不追换行）并可覆盖旧内容', (t) => {
  const dir = workdir(t);
  const file = path.join(dir, 'note.txt');
  const io = spyFs();

  writeTextAtomic(file, '第一行\n第二行', { fsImpl: io });
  assert.equal(fs.readFileSync(file, 'utf8'), '第一行\n第二行');

  writeTextAtomic(file, '覆盖', { fsImpl: io });
  assert.equal(fs.readFileSync(file, 'utf8'), '覆盖');
  assert.equal(io.calls.write.at(-1).opts.mode, 0o600);
});

test('fsImpl 缺失/不完整：明确报出缺哪个方法，而不是中途炸', () => {
  assert.throws(() => readJsonSafe('x.json', null), /fsImpl/);
  assert.throws(() => readJsonSafe('x.json', null, { fsImpl: {} }), /readFileSync/);
  assert.throws(() => writeJsonAtomic('x.json', 1), /fsImpl/);
  assert.throws(() => writeJsonAtomic('x.json', 1, { fsImpl: { mkdirSync() {} } }), /writeFileSync/);
  assert.throws(() => writeTextAtomic('x.txt', 't', { fsImpl: { mkdirSync() {}, writeFileSync() {} } }), /renameSync/);
});

test('禁用清单：不 import node:fs、不用 Promise/async、不碰真实时钟与 console', () => {
  const src = fs.readFileSync(new URL('../src/persist/atomic.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(/from\s+['"]node:fs['"]/.test(code), false, '不得 import node:fs');
  assert.equal(/from\s+['"]fs['"]/.test(code), false, '不得 import fs');
  assert.equal(/require\(\s*['"]node:fs['"]\s*\)|require\(\s*['"]fs['"]\s*\)/.test(code), false, '不得 require fs');
  assert.equal(/\bPromise\b/.test(code), false, '不得使用 Promise');
  assert.equal(/\basync\b|\bawait\b/.test(code), false, '必须是纯同步实现');
  assert.equal(/Date\.now\s*\(/.test(code), false, '不得使用 Date.now()');
  assert.equal(/console\s*\./.test(code), false, '不得使用 console');
});
