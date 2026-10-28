// obs/log — 组装日志行并按行数上限轮转，含截断与本地时间戳
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：log, now        （optional：none）
// 失败策略：fail-open         （依据：D 表 `obs/log` 行）
// 单测：tests/obs-log.test.mjs
//
// 为什么需要：日志行的四条规则（脱敏、换行折叠、超长截断、按行数轮转）原本全内嵌在中枢，
// 任一条改错都会让事故复盘失效；抽出后可单测，中枢只留"写 stdout + 写文件"这两个 IO。
// 边界：不决定日志路径（file 由调用方给）；不做脱敏（redact 由中枢注入）；不 console.log；
//       不读系统时钟（时间由调用方传入），否则单测不可复现。

import fs from 'node:fs';
import path from 'node:path';

export const spec = Object.freeze({
  name: 'obs/log',
  version: '1.0.0',
  deps: ['log', 'now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
export const LOG_LINE_MAX = 1000;

/**
 * 本地时间 HH:MM:SS。
 *
 * 为什么不用 toISOString()：那是 UTC，写进日志会和本地时间差 8 小时，
 * 排查时"23:04 的告警"实际是"次日 07:04 的告警"。
 */
export function localClock(atMs) {
  const d = new Date(Number(atMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把 log(...args) 的参数组装成一行日志。
 *
 * @param {unknown[]} args            log 的原始参数
 * @param {object}    options
 * @param {(s:string)=>string} [options.redact] 脱敏函数（由中枢注入 redactSensitiveText）
 * @param {number}    options.at      时间戳（毫秒），必传，模块不读系统时钟
 * @param {number}    [options.max]   单条上限，默认 LOG_LINE_MAX
 * @param {string}    [options.tag]   方括号标签，默认 bridge
 * @returns {string}
 */
export function formatLine(args, options = {}) {
  const { redact, at, max = LOG_LINE_MAX, tag = 'bridge' } = options;
  try {
    const body = (Array.isArray(args) ? args : [args])
      .map((a) => {
        const text = typeof a === 'string' ? a : JSON.stringify(a);
        return redact ? redact(text) : text;
      })
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    const clipped = body.length > max ? `${body.slice(0, max)}…[截断]` : body;
    return `${localClock(at)} [${tag}] ${clipped}`;
  } catch {
    return `${localClock(at)} [${tag}] (日志参数无法序列化)`;
  }
}

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，单次 log()
 * 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的事件循环。
 * 这里改成**内存计数器**：只在首次调用时数一次，之后 O(1) 追加，到上限才轮转，
 * 轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 *
 * 空 catch 是本仓唯一允许的例外（F.5）：日志系统自身失败不能递归失败，
 * 更不能把调用方（socket 回调）带走。
 *
 * @param {string} file      日志文件绝对路径
 * @param {number} maxLines  行数上限，超过即轮转
 * @param {object} [deps]    { fsImpl } 便于测试注入
 * @returns {(text:string)=>void}
 */
export function createCappedLogger(file, maxLines, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      if (lines < 0) {
        try {
          lines = fsImpl.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fsImpl.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        try {
          fsImpl.renameSync(file, `${file}.1`);
        } catch {
          fsImpl.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {
      // fail-open：日志写不进去也不能影响主链路（见 D 表 obs/log）。
    }
  };
}

/**
 * 契约门面。中枢按需调用；现有调用点仍直接用上面的纯函数。
 *
 * @param {object} ctx  { now }
 * @param {object} args { action, args, redact, at, file, maxLines }
 */
export function handle(ctx, args = {}) {
  const action = String(args.action ?? 'format');
  const at = Number(args.at ?? (typeof ctx?.now === 'function' ? ctx.now() : 0));
  if (action === 'format') {
    return {
      ok: true,
      value: formatLine(args.args ?? [], { redact: args.redact, at, max: args.max, tag: args.tag })
    };
  }
  if (action === 'clock') return { ok: true, value: localClock(at) };
  return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
}
