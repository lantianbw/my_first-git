// 跨会话带话（relay）：双向但单向收口。
//
// 为什么需要：朋友私聊里说的话，老爷爷想转达给别人（或群里）；但反过来不行 ——
// 除了 owner 私聊，任何人只能把话带回 owner 本人，防止被当成群发/骚扰通道。
//
// 本文件是纯逻辑（校验顺序、方向规则、频率窗口），不碰网络也不读全局配置：
// 发送函数、会话存在性、令牌校验、敏感词判定全部由 bridge.js 注入，因而可单测。

export const RELAY_TO_RE = /^(group|private):\d+$/;
export const RELAY_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_PER_HOUR = 5;

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const fail = (status, error) => ({ status, body: { ok: false, error } });

/** 归一化 socialV2.relay 配置：只认 enabled === true；maxPerHour 非法时回落到默认值。 */
export function normalizeRelayConfig(raw, fallback = DEFAULT_MAX_PER_HOUR) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = Math.floor(Number(r.maxPerHour));
  return {
    enabled: r.enabled === true,
    maxPerHour: Number.isFinite(n) && n > 0 ? n : fallback
  };
}

/** owner 私聊可以带去的目标集合：allow.private → private:N，allow.groups → group:N。 */
export function relayAllowedTargets(allow) {
  const set = new Set();
  const add = (prefix, list) => {
    for (const raw of Array.isArray(list) ? list : []) {
      const id = Number(raw);
      if (Number.isSafeInteger(id) && id > 0) set.add(`${prefix}:${id}`);
    }
  };
  add('private', allow?.private);
  add('group', allow?.groups);
  return set;
}

/**
 * 建一个 relay 处理器。
 *
 * 校验顺序（与需求一致，顺序本身是安全设计：先门禁，再身份，再会话，再格式，
 * 再方向，再频率，最后才是文本与发送 —— 越靠后的检查越可能触碰用户数据）：
 *   1) relay.enabled          → 403
 *   2) agentTokenOk(key, t)   → 403
 *   3) key 是已存在会话        → 403
 *   4) to 格式                → 400
 *   5) 方向规则               → 403（两种文案分开写，模型才知道该怎么改）
 *   6) 频率窗口               → 429
 *   7) 文本长度 / 敏感 / 长度守卫
 *   8) 发送
 *
 * 注：`to === key`（带给自己）按请求格式错误处理（400），先于方向规则判定 ——
 * 两组验收里它都要求 400，而不是「不在白名单」的 403。
 */
export function createRelay({
  cfg,
  ownerQQ,
  hasSession,
  agentTokenOk,
  maxChars = 500,
  isSensitive = () => false,
  guardLength = () => ({ ok: true, reason: '' }),
  send,
  now = () => Date.now(),
  log = () => {},
  appendActivity = () => {}
} = {}) {
  const relayCfg = normalizeRelayConfig(cfg?.socialV2?.relay);
  const allowed = relayAllowedTargets(cfg?.allow);
  const ownerKey = Number(ownerQQ) > 0 ? `private:${Number(ownerQQ)}` : '';
  const charLimit = Math.max(1, Number(maxChars) || 500);
  const timesByFrom = new Map(); // fromKey -> 最近 1 小时的发送时间戳

  async function handle({ key, token, to, text } = {}) {
    // 1) 开关
    if (!relayCfg.enabled) return fail(403, '跨会话带话未开启（socialV2.relay.enabled=false）');

    const from = String(key ?? '').trim();
    const target = String(to ?? '').trim();
    const content = typeof text === 'string' ? text.trim() : '';

    // 2) 令牌
    if (!from || !agentTokenOk(from, token)) return fail(403, 'agent token 无效');

    // 3) 会话必须真实存在（否则任何人都能凭空构造一个 key 来冒用 owner 身份）
    if (!hasSession(from)) return fail(403, '会话不存在或已失效');

    // 4) 目标格式
    if (!RELAY_TO_RE.test(target)) return fail(400, 'to 格式应为 group:群号 或 private:QQ号');

    // 带给自己既没意义也会造成回环，按格式错误拦掉
    if (target === from) return fail(400, '不能把话带给自己所在的会话');

    // 5) 方向规则
    if (ownerKey && from === ownerKey) {
      // owner 私聊发起：只能带给白名单里的人/群
      if (!allowed.has(target)) return fail(403, '只有 owner 私聊可以把话带给别人（目标不在白名单内）');
    } else if (target !== ownerKey) {
      // 朋友私聊 / 群聊发起：只能往回带给 owner
      return fail(403, '其他人只能把话带给 owner');
    }

    // 6) 频率：按发起来源计窗口内次数
    const at = now();
    const recent = (timesByFrom.get(from) ?? []).filter((t) => at - t < RELAY_WINDOW_MS);
    if (recent.length >= relayCfg.maxPerHour) {
      timesByFrom.set(from, recent);
      return fail(429, `带话太频繁了（1 小时最多 ${relayCfg.maxPerHour} 次），晚点再说`);
    }

    // 7) 文本
    if (!content) return fail(400, 'text 不能为空');
    if (content.length > charLimit) return fail(400, `单条消息不能超过 ${charLimit} 字`);
    if (isSensitive(content)) return fail(403, '消息含敏感信息，已阻止发送');
    const guarded = guardLength(target, content);
    if (!guarded?.ok) return fail(403, guarded?.reason || '出站守卫拦截');

    // 8) 发送：先预占额度再发，失败也不退还 —— 否则报错瞬间就能被反复重试绕过限频。
    recent.push(at);
    timesByFrom.set(from, recent);
    let sent = 0;
    try {
      sent = await send(target, content);
    } catch (error) {
      log(`[relay] ${from} -> ${target} 发送失败：${error?.message ?? error}`);
      return fail(502, `带话发送失败：${error?.message ?? error}`);
    }

    // 审计
    const line = `[relay] ${from} -> ${target} ${content.length} 字`;
    log(line);
    appendActivity(line);
    return ok({ from, to: target, sent: Number(sent) || 1 });
  }

  return { handle, config: relayCfg };
}
