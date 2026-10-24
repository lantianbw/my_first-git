// 合并转发（合并聊天记录）的纯逻辑层：节点构造、预览摘要、图片降级、
// 审批记录归一化与限流判断。无 IO、无网络，方便离线回归。
//
// 设计要点：
// - 节点只从**当前会话**的消息对象构造，调用方必须先做可见范围校验；
// - 图片用 media.url 作为 OneBot image 段的 file（SnowLuma 接受 URL）；
// - 语音/文件/表情降级成文字标记，绝不把不可转发的资源硬塞进节点；
// - 审批码只用于「私聊内容转群」这一条隐私边界，其余方向免审。

export const FORWARD_DEFAULTS = Object.freeze({
  maxMessages: 20,
  cooldownMs: 300000,
  approvalTtlMs: 600000,
  approvalsPerHour: 3
});

const CODE_RE = /^\d{6}$/;

const int = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const str = (value) => String(value ?? '').trim();

/** 把用户手改过的 socialV2.forward 收敛到安全区间。 */
export function normalizeForwardConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    maxMessages: int(src.maxMessages, FORWARD_DEFAULTS.maxMessages, 1, 20),
    cooldownMs: int(src.cooldownMs, FORWARD_DEFAULTS.cooldownMs, 0, 86_400_000),
    approvalTtlMs: int(src.approvalTtlMs, FORWARD_DEFAULTS.approvalTtlMs, 60_000, 3_600_000),
    approvalsPerHour: int(src.approvalsPerHour, FORWARD_DEFAULTS.approvalsPerHour, 1, 20)
  };
}

function textSegment(text) {
  return { type: 'text', data: { text } };
}

/** media 数组 → OneBot 消息段（图片保留 url，表情降级）。 */
function mediaSegments(media) {
  const out = [];
  for (const item of Array.isArray(media) ? media : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'image') {
      const url = str(item.url) || str(item.file);
      out.push(url ? { type: 'image', data: { file: url } } : textSegment('[图片]'));
    } else if (item.kind === 'face') {
      out.push(textSegment('[表情]'));
    }
  }
  return out;
}

/**
 * 把会话消息对象数组构造成合并转发节点。
 * @returns {{nodes:Array, used:number, dropped:number, imageCount:number}}
 */
export function buildForwardNodes(messages, { maxMessages = FORWARD_DEFAULTS.maxMessages } = {}) {
  const limit = int(maxMessages, FORWARD_DEFAULTS.maxMessages, 1, 20);
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  const picked = list.slice(0, limit);
  const nodes = [];
  let imageCount = 0;
  for (const message of picked) {
    const content = [];
    const text = str(message.text ?? message.plain);
    if (text) content.push(textSegment(text));
    // 消息文本里可能已经有 [语音]/[文件] 标记；这里再按 media 补图片/表情。
    for (const seg of mediaSegments(message.media)) {
      if (seg.type === 'image') imageCount += 1;
      content.push(seg);
    }
    if (!content.length) content.push(textSegment('[消息]'));
    nodes.push({
      type: 'node',
      data: {
        name: str(message.sender) || '未知',
        uin: str(message.userId) || '0',
        content
      }
    });
  }
  return { nodes, used: picked.length, dropped: Math.max(0, list.length - picked.length), imageCount };
}

/** 图片节点全部降级为文字标记（URL 过期时的重试形态）。 */
export function degradeImagesToText(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const data = node?.data && typeof node.data === 'object' ? node.data : {};
    const content = (Array.isArray(data.content) ? data.content : []).map((seg) => (
      seg?.type === 'image' ? textSegment('[图片]') : seg
    ));
    return { ...node, data: { ...data, content } };
  });
}

/** 给 owner 的预览：前 100 字 + 图片数量。 */
export function summarizeForward(nodes, { maxChars = 100 } = {}) {
  const parts = [];
  let images = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const seg of node?.data?.content ?? []) {
      if (seg?.type === 'text') parts.push(str(seg.data?.text));
      if (seg?.type === 'image') images += 1;
    }
  }
  const text = parts.filter(Boolean).join(' ');
  const limit = Math.max(1, Number(maxChars) || 100);
  const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return `${clipped || '（无文字）'}（图片 x${images}）`;
}

/** OneBot 报「图片 URL 过期/取不到」的常见措辞。 */
export function isExpiredUrlError(error) {
  const raw = String(error?.message ?? error ?? '');
  return /expire|过期|失效|invalid\s*(url|file)|url\s*(invalid|expired)|file\s*not\s*found|找不到(文件|图片)|下载失败|https?[^\n]*\b(400|403|404|410)\b/i.test(raw);
}

/** state/forward-approvals.json 归一化：坏记录直接丢，不让整个文件作废。 */
export function normalizeApprovals(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const items = {};
  for (const [code, value] of Object.entries(src.items && typeof src.items === 'object' ? src.items : {})) {
    if (!CODE_RE.test(code) || !value || typeof value !== 'object') continue;
    // 兼容两种历史形状：扁平（code/key/messageIds 同级）与嵌套 payload。
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : value;
    const target = payload.target === 'group' || payload.target === 'same' ? payload.target : 'group';
    const messageIds = (Array.isArray(payload.messageIds) ? payload.messageIds : [])
      .map((id) => str(id))
      .filter(Boolean)
      .slice(0, FORWARD_DEFAULTS.maxMessages);
    items[code] = {
      code,
      key: str(value.key),
      target,
      messageIds,
      preview: str(value.preview),
      createdAt: int(value.createdAt, 0, 0, Number.MAX_SAFE_INTEGER),
      expiresAt: int(value.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER),
      status: ['pending', 'approved', 'rejected', 'expired'].includes(value.status) ? value.status : 'pending',
      resolvedAt: int(value.resolvedAt, 0, 0, Number.MAX_SAFE_INTEGER)
    };
  }
  return { items };
}

/** 清掉过期/已处理且超过保留期的记录，返回新对象与删除数。 */
export function pruneApprovals(approvals, { now = Date.now(), ttlMs = FORWARD_DEFAULTS.approvalTtlMs } = {}) {
  const safe = normalizeApprovals(approvals);
  const keepAfter = now - Math.max(60_000, Number(ttlMs) || FORWARD_DEFAULTS.approvalTtlMs) * 2;
  const items = {};
  let removed = 0;
  for (const [code, item] of Object.entries(safe.items)) {
    const expired = item.expiresAt > 0 && item.expiresAt <= now;
    if (item.status === 'pending' && expired) {
      items[code] = { ...item, status: 'expired' };
      continue;
    }
    if (item.status !== 'pending' && item.resolvedAt > 0 && item.resolvedAt < keepAfter) {
      removed += 1;
      continue;
    }
    items[code] = item;
  }
  return { approvals: { items }, removed };
}

/** 生成未被占用的 6 位码（无前导零，方便在 QQ 里口述/输入）。 */
export function generateApprovalCode(existingCodes = []) {
  const used = new Set((Array.isArray(existingCodes) ? existingCodes : []).map(String));
  for (let i = 0; i < 200; i += 1) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    if (!used.has(code)) return code;
  }
  return String(100000 + (Date.now() % 900000));
}

/** 同一会话 5 分钟冷却；times 是历史发送时间戳数组。 */
export function checkForwardCooldown(times, { cooldownMs = FORWARD_DEFAULTS.cooldownMs, now = Date.now() } = {}) {
  const window = Math.max(0, Number(cooldownMs) || 0);
  if (window <= 0) return { allowed: true, retryAfterMs: 0, times: [] };
  const fresh = (Array.isArray(times) ? times : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0 && now - t < window)
    .slice(-50);
  if (fresh.length > 0) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, window - (now - fresh[fresh.length - 1])),
      times: fresh
    };
  }
  return { allowed: true, retryAfterMs: 0, times: fresh };
}

/** 每小时审批通过次数（滑动窗口）。 */
export function checkApprovalQuota(times, { limit = FORWARD_DEFAULTS.approvalsPerHour, now = Date.now() } = {}) {
  const max = Math.max(1, Number(limit) || FORWARD_DEFAULTS.approvalsPerHour);
  const window = 3_600_000;
  const fresh = (Array.isArray(times) ? times : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0 && now - t < window)
    .slice(-100);
  if (fresh.length >= max) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, window - (now - fresh[0])),
      times: fresh,
      reason: `最近一小时审批通过已达上限（${max} 次）`
    };
  }
  return { allowed: true, retryAfterMs: 0, times: fresh };
}
