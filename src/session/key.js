// session/key — 会话 key 的解析、规范化、脱敏
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-closed          （依据：D 表 session/router「判定不出来就不该投递」）
// 单测：tests/session-key.test.mjs
//
// 为什么需要：bridge.js 的 canonicalV2Key 是内联函数，agentTokenOk / hasSession / relay
// 各自 `canonicalV2Key(key) ?? key`；日志里又直接把 key 原文打出来。把「什么算合法 key、
// 规范成什么、日志里怎么脱敏」抽出来，避免各处各写一套判断。
// 边界：只解析字符串。不查 state、不鉴权（ownerQQ 由调用方给）、不 import bridge、不做 IO。
//
// 与 canonicalV2Key 的差异：那里用 Number.isSafeInteger 限制 id，20 位 QQ 群号会丢精度被拒；
// 这里按契约要求改成字符串级校验（1~20 位纯数字），只去前导零，不转 Number。

export const spec = Object.freeze({
  name: 'session/key',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

const MAX_ID_LENGTH = 20;

/** 去前导零：'000123' → '123'，'000' → '0'。 */
function stripZeros(id) {
  return id.replace(/^0+(?=\d)/, '');
}

/**
 * @pure 解析会话 key。只认 `group:<数字>` / `private:<数字>`；
 * 不认别名（g: / p: / qq: 全部拒绝）、不做前缀补全、大小写敏感。
 * 返回 { ok:true, kind, id, key } 或 { ok:false, error }。
 */
export function parseKey(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'key 不能为空' };

  const colon = raw.indexOf(':');
  if (colon < 0) return { ok: false, error: 'key 缺少冒号，应为 group:<数字> 或 private:<数字>' };

  const kind = raw.slice(0, colon);
  if (kind !== 'group' && kind !== 'private') {
    return { ok: false, error: `未知会话类型：${kind}（只接受 group / private）` };
  }

  const rawId = raw.slice(colon + 1);
  if (!/^\d+$/.test(rawId)) return { ok: false, error: 'id 必须是纯数字' };
  if (rawId.length > MAX_ID_LENGTH) return { ok: false, error: `id 长度超出 1~${MAX_ID_LENGTH} 位` };

  const id = stripZeros(rawId);
  if (id === '0') return { ok: false, error: 'id 必须大于 0' };
  return { ok: true, kind, id, key: `${kind}:${id}` };
}

/** @pure 这个 key 是否指向主人自己的私聊（群聊一律 false）。 */
export function isOwnerKey(text, ownerQQ) {
  const parsed = parseKey(text);
  if (!parsed.ok || parsed.kind !== 'private') return false;
  const owner = String(ownerQQ ?? '').trim();
  if (!/^\d+$/.test(owner)) return false;
  const ownerId = stripZeros(owner);
  return ownerId !== '0' && parsed.id === ownerId;
}

/** @pure 日志用脱敏：保留末 2 位，其余换成 `*`；解析不了的整条遮成 `***`。 */
export function redactKey(text) {
  const parsed = parseKey(text);
  if (!parsed.ok) return '***';
  const visible = parsed.id.slice(-2);
  const masked = '*'.repeat(Math.max(0, parsed.id.length - visible.length));
  return `${parsed.kind}:${masked}${visible}`;
}
