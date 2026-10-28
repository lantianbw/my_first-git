// persist/atomic — 原子读写 JSON / 文本，并对 Windows 下的文件占用做退避重试
//
// 契约：docs/module-contract.md v1.1（B.1 spec / D 表 persist/atomic「写 fail closed、读 fail open」/ H2 locked）
// deps：log                      （optional：无）
// 失败策略：写 fail closed（失败必抛，绝不谎报成功）/ 读 fail open（坏文件返回 fallback）
// 单测：tests/atomic.test.mjs
//
// 为什么需要：state/ 与 config.json 都是「读整份 → 改一个字段 → 写回」。直接 writeFileSync 一旦
// 在写一半时被中断（断电、杀进程、Windows 上被 Defender 锁住），留下的是半截 JSON，下次启动
// 整份配置读不出来。所以一律先写临时文件再 rename：读者要么看到旧内容，要么看到新内容。
// 另外 Windows 上 rename 覆盖一个「正被打开」的目标会抛 EPERM/EBUSY，实测可复现（资源管理器
// 预览、云同步、杀软扫描都会在这个窗口里碰它），因此需要退避重试。
//
// 边界：不做任何 IO —— fs 与 log 全部由调用方注入（本文件不 import node:fs，读接口也不直接用）；
// 不决定业务语义、不校验数据结构、不建目录之外的任何副作用；纯同步，不返回 Promise。
//
// 等价性：本文件逐条复刻 src/bridge.js 的 readJsonSafe(:326) / renameWithRetry(:362) /
// atomicWriteJson(:379) / atomicWriteText(:393)：
//   · UTF-8 BOM（\uFEFF）先剥掉再 JSON.parse
//   · 只有 EPERM / EBUSY / EACCES 重试，其余错误立即抛
//   · 退避为线性递增（delayMs × 第几次），默认 attempts=4、delayMs=40，与旧实现一致
//   · 临时名 `<file>.<pid>.<12位hex>.tmp`，写入 mode 0o600，失败时删临时文件并原样抛出
//   · JSON 落盘为 2 空格缩进 + 结尾换行；文本原样落盘
//   · 读失败时 strict=true 抛 `配置文件读取/解析失败：<path>（<原因>）`，否则返回 fallback

import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_DELAY_MS = 40;
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export const spec = Object.freeze({
  name: 'persist/atomic',
  version: '1.0.0',
  deps: Object.freeze(['log']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

const noopLog = () => {};

/** 从任意抛出物里取出可读说明。 */
function messageOf(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

/** fs 全注入：缺方法就明确报出缺哪个，而不是等到写入中途才 undefined is not a function。 */
function requireFs(fsImpl, methods, who) {
  if (!fsImpl || (typeof fsImpl !== 'object' && typeof fsImpl !== 'function')) {
    throw new TypeError(`${who}: 必须注入 fsImpl（含 ${methods.join(' / ')}）`);
  }
  for (const method of methods) {
    if (typeof fsImpl[method] !== 'function') {
      throw new TypeError(`${who}: fsImpl 缺少 ${method}()`);
    }
  }
  return fsImpl;
}

/** 同步忙等：调用点都在启动/收尾路径，不值得为它改成异步。 */
function sleepSync(ms, log) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // 极端环境没有 SharedArrayBuffer：退化为立即重试，不阻断写入
    log('debug', `[persist/atomic] 无法同步等待重试间隔（${messageOf(err)}），立即重试`);
  }
}

function retryOptions(retry) {
  const attempts = Number.isInteger(retry?.attempts) && retry.attempts > 0 ? retry.attempts : DEFAULT_ATTEMPTS;
  const delayMs = Number.isFinite(retry?.delayMs) && retry.delayMs >= 0 ? retry.delayMs : DEFAULT_DELAY_MS;
  return { attempts, delayMs };
}

/**
 * 读取 JSON，容错 BOM 与坏文件。
 *
 * @param {string} filePath
 * @param {*} fallback 读失败（且非 strict）时的返回值，原样返回，不做拷贝
 * @param {{ fsImpl?: object, log?: Function, strict?: boolean }} [opts]
 * @returns {*} 解析结果；失败返回 fallback
 */
export function readJsonSafe(filePath, fallback, { fsImpl, strict = false } = {}) {
  const io = requireFs(fsImpl, ['readFileSync'], 'readJsonSafe');
  try {
    let text = io.readFileSync(filePath, 'utf8');
    // Windows 下常见 UTF-8 BOM（\uFEFF）：JSON.parse 会直接报 Unexpected token
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (strict) throw new Error(`配置文件读取/解析失败：${filePath}（${error?.message ?? error}）`);
    return fallback;
  }
}

/** 退避重试 rename：Windows 上目标被占用时抛 EPERM/EBUSY，重试几次通常就过了。 */
function renameWithRetry(io, from, to, retry, log) {
  const { attempts, delayMs } = retryOptions(retry);
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      io.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error?.code)) throw error;
      log('warn', `[persist/atomic] rename 被占用（${error.code}），重试 ${i + 1}/${attempts}：${to}`, {
        from,
        to,
        code: error.code,
        attempt: i + 1,
        attempts
      });
      sleepSync(delayMs * (i + 1), log);
    }
  }
  throw lastError;
}

/** 唯一临时文件名：不用固定名，避免并发写互相踩、也避免符号链接攻击。 */
function tmpNameOf(filePath) {
  return `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/** 写临时文件 → rename；失败删临时文件并原样抛出（旧内容因此保持完好）。 */
function writeAtomic(filePath, payload, { fsImpl, log, retry, who }) {
  const io = requireFs(fsImpl, ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync'], who);
  io.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = tmpNameOf(filePath);
  try {
    io.writeFileSync(tmp, payload(), { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(io, tmp, filePath, retry, log);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾；清理失败本身不能再盖住原始错误
    try {
      io.unlinkSync(tmp);
    } catch (cleanupError) {
      log('warn', `[persist/atomic] 临时文件清理失败：${tmp}（${messageOf(cleanupError)}）`);
    }
    throw error;
  }
}

/**
 * 原子写 JSON：2 空格缩进 + 结尾换行，与旧实现逐字节一致。
 *
 * @param {string} filePath
 * @param {*} value 支持 JSON.stringify 的值
 * @param {{ fsImpl?: object, log?: Function, retry?: { attempts?: number, delayMs?: number } }} [opts]
 */
export function writeJsonAtomic(filePath, value, { fsImpl, log = noopLog, retry } = {}) {
  // 序列化放在 payload 里、且在 mkdir 之后执行：与旧实现「先建目录、再 stringify」的出错顺序一致
  writeAtomic(filePath, () => JSON.stringify(value, null, 2) + '\n', {
    fsImpl,
    log,
    retry,
    who: 'writeJsonAtomic'
  });
}

/**
 * 原子写文本：原样落盘，不追加换行、不做编码转换。
 *
 * @param {string} filePath
 * @param {string} text
 * @param {{ fsImpl?: object, log?: Function, retry?: { attempts?: number, delayMs?: number } }} [opts]
 */
export function writeTextAtomic(filePath, text, { fsImpl, log = noopLog, retry } = {}) {
  writeAtomic(filePath, () => text, { fsImpl, log, retry, who: 'writeTextAtomic' });
}
