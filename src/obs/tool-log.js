// obs/tool-log — 工具调用日志与反馈条目的脱敏、JSON 展开、截断
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：log        （optional：none）
// 失败策略：fail-open         （依据：D 表 `obs/tool-log` 行）
// 单测：tests/obs-tool-log.test.mjs
//
// 为什么需要：工具参数里混着 token / cookie / 私钥，落盘前必须脱敏；DSH 的
// tool/call arguments 常是 JSON 字符串甚至双层转义，解开顺序错一层 token 就明文落盘。
// 这几条规则原本内嵌在中枢，没有单测兜着；抽出后可离线验证。
// 边界：不写文件（路径与原子写留中枢）、不打日志、不读 state。

export const spec = Object.freeze({
  name: 'obs/tool-log',
  version: '1.0.0',
  deps: ['log'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

/** 命中即整体替换为 *** 的参数键（全部小写比对）。 */
export const SENSITIVE_ARG_KEYS = Object.freeze([
  'token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key',
  'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session',
  'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken',
  'refresh_token', 'x-agent-token', 'x_agent_token'
]);

const SENSITIVE_SET = new Set(SENSITIVE_ARG_KEYS);

/** 逐层解开 JSON 字符串（最多 4 层）；解不开就保留原值。 */
export function unwrapJsonLayers(value, maxLayers = 4) {
  let parsed = value;
  for (let i = 0; i < maxLayers; i++) {
    if (typeof parsed !== 'string') break;
    try {
      const next = JSON.parse(parsed);
      parsed = next;
      if (typeof next !== 'string') break;
    } catch {
      break;
    }
  }
  return parsed;
}

/**
 * 递归脱敏。
 *
 * @param {unknown} obj
 * @param {object} deps { redact } —— redact 是纯文本脱敏函数（由中枢注入）
 */
export function redactSensitive(obj, deps = {}) {
  const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
  if (Array.isArray(obj)) return obj.map((v) => redactSensitive(v, deps));
  if (obj && typeof obj === 'object') {
    // 用无原型对象承接：日志脱敏不能被 __proto__ 等键触发原型链污染。
    const out = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[k] = SENSITIVE_SET.has(key) ? '***' : redactSensitive(v, deps);
    }
    return out;
  }
  if (typeof obj === 'string') return redact(obj);
  return obj;
}

/**
 * 把一次工具调用的 args 规整成"可落盘的一行文本"。
 * 先逐层解 JSON，再递归脱敏，最后序列化并截断。
 */
export function sanitizeToolArgs(args, deps = {}) {
  const { truncate, maxLength = 2000 } = deps;
  if (args === undefined || args === null) return null;
  const safe = redactSensitive(unwrapJsonLayers(args), deps);
  let text;
  try { text = JSON.stringify(safe); } catch { text = String(safe); }
  if (text.length > maxLength) {
    const head = typeof truncate === 'function' ? truncate(text, maxLength) : text.slice(0, maxLength);
    text = `${head}…(truncated)`;
  }
  return text;
}

/**
 * 组装可落盘的工具调用条目：error 与 args 都脱敏，其余字段原样。
 */
export function prepareToolLogEntry(entry, deps = {}) {
  const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
  const safeEntry = { ...entry };
  if (typeof safeEntry.error === 'string') safeEntry.error = redact(safeEntry.error);
  if (typeof safeEntry.args === 'string') safeEntry.args = sanitizeToolArgs(safeEntry.args, deps);
  return safeEntry;
}

/** 组装可落盘的反馈条目：只脱敏 message，其余字段原样。 */
export function prepareFeedbackEntry(entry, deps = {}) {
  const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
  return {
    ...entry,
    ...(typeof entry?.message === 'string' ? { message: redact(entry.message) } : {})
  };
}

/** 契约门面。 */
export function handle(ctx, args = {}) {
  const action = String(args.action ?? 'tool-entry');
  const redact = typeof args.redact === 'function' ? args.redact : undefined;
  if (action === 'tool-entry') return { ok: true, value: prepareToolLogEntry(args.entry ?? {}, { redact }) };
  if (action === 'feedback-entry') return { ok: true, value: prepareFeedbackEntry(args.entry ?? {}, { redact }) };
  if (action === 'args') return { ok: true, value: sanitizeToolArgs(args.args, { redact, truncate: args.truncate }) };
  return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
}
