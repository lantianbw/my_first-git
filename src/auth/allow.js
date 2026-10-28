// auth/allow — 判断一条会话该不该放行（allowed + modeAllowed 的纯函数版）
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-closed          （依据：D 表 auth/admission「白名单/模式准入是群友不能触达的硬边界」）
// 单测：tests/allow.test.mjs
//
// 为什么需要：bridge.js 里 allowed() 读整个 cfg，modeAllowed() 又把 owner 私聊拼成字符串比较，
// 两处口径分散。抽成一个纯函数后「owner 恒通 / mode 限不限制 / 白名单空不空」可单测，
// 中枢只负责把 cfg 拆成入参。
// 边界：不读 cfg、不查 state、不 import bridge；只回答 allowed + reason。
//
// 与 bridge 的差异（有意为之）：
// - id / ownerQQ / 白名单条目都做「数字字符串 + 去前导零」归一，`10001`、'10001'、'010001'
//   视为同一个 QQ 号；bridge 里是 String 直接比，配置格式不统一时会漏判。
// - 群聊 key 的数字与 ownerQQ 相同也不算 owner —— owner 是一个人，不是群号。

export const spec = Object.freeze({
  name: 'auth/allow',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

const CLOSED_AGENT = 'closed-agent';

/** 归一成纯数字串（去前导零）；非数字 / 0 / 空 → ''，调用方按非法处理。 */
function normalizeId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  const id = text.replace(/^0+(?=\d)/, '');
  return id === '0' ? '' : id;
}

function normalizeList(value) {
  return (Array.isArray(value) ? value : []).map(normalizeId).filter(Boolean);
}

/**
 * @pure 返回 { allowed, reason }。
 * reason: 'owner' | 'whitelist' | 'mode-restricted' | 'whitelist-empty'
 *       | 'not-whitelisted' | 'bad-kind' | 'bad-id'
 * mode 只区分 bridge 的两种语义：
 *   - 'closed-agent'：仅 owner 私聊（owner 已在前面放行，其余一律拒绝）
 *   - 其余（chat / reserved / reserved2 / 未给 / 未知）：走白名单
 */
export function isAllowed({ kind, id, ownerQQ, whitelist, mode } = {}) {
  if (kind !== 'group' && kind !== 'private') return { allowed: false, reason: 'bad-kind' };

  const target = normalizeId(id);
  if (!target) return { allowed: false, reason: 'bad-id' };

  const owner = normalizeId(ownerQQ);
  if (kind === 'private' && owner && target === owner) return { allowed: true, reason: 'owner' };

  if (mode === CLOSED_AGENT) return { allowed: false, reason: 'mode-restricted' };

  // 兼容 { groups, private } 与平铺数组两种白名单写法。
  const scoped = kind === 'group'
    ? (whitelist?.groups ?? whitelist?.group)
    : (whitelist?.private ?? whitelist?.privates);
  const list = normalizeList(Array.isArray(whitelist) ? whitelist : scoped);

  if (!list.length) return { allowed: false, reason: 'whitelist-empty' };
  if (list.includes(target)) return { allowed: true, reason: 'whitelist' };
  return { allowed: false, reason: 'not-whitelisted' };
}
