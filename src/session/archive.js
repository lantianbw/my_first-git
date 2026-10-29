// session/archive — 会话轮换时的记忆快照构造与回注文本渲染
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-open            （依据：D 表 obs/activity 同类——快照坏了不该阻断轮换）
// 单测：tests/session-archive.test.mjs
//
// 为什么搬：轮换的「归档什么」和「回注什么」原本内联在 bridge.js 的 archiveRotatedSession /
// archiveRecallPeekV2 里，与文件写入、state 读写、日志缠在一起。搬出来只留两个纯函数：
// 给会话状态 → 出快照对象；给快照对象 → 出回注文本。写文件与「是否已注入」的标记仍在中枢。
//
// 边界：不读 state、不读时钟（now 由调用方注入）、不写文件、不 import bridge。
// 快照字段只保留「她当时看到的东西」，不存原始结构的镜像。

export const spec = Object.freeze({
  name: 'session/archive',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

const DEFAULTS = Object.freeze({
  topicLimit: 20,
  topicChars: 120,
  recentLimit: 40,
  recentChars: 200,
  recallLimit: 6
});

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @pure 构造轮换快照。
 *
 * @param {object} input
 * @param {string} input.key         会话 key
 * @param {string|null} [input.sessionId] 被退役的 DSH 会话 id
 * @param {number} input.now         毫秒时间戳（必填）
 * @param {object} input.state       会话状态（activeTopics / recentMessages）
 * @param {string} [input.memoryText]   退役前实际看到的记忆块
 * @param {string} [input.relationText] 退役前实际看到的关系线
 * @param {object} [input.limits]     { topicLimit, topicChars, recentLimit, recentChars }
 * @returns {{ key: string, sessionId: string|null, rotatedAt: number, topics: Array, recent: Array, memoryText: string, relationText: string }}
 */
export function buildArchiveSnapshot({
  key,
  sessionId = null,
  now,
  state,
  memoryText = '',
  relationText = '',
  limits
} = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('buildArchiveSnapshot: now 必须是毫秒时间戳（由调用方注入）');
  }
  const tune = limits ?? {};
  const num = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback);
  const topicLimit = num(tune.topicLimit, DEFAULTS.topicLimit);
  const topicChars = num(tune.topicChars, DEFAULTS.topicChars);
  const recentLimit = num(tune.recentLimit, DEFAULTS.recentLimit);
  const recentChars = num(tune.recentChars, DEFAULTS.recentChars);

  const st = state && typeof state === 'object' ? state : {};

  const topics = (Array.isArray(st.activeTopics) ? st.activeTopics : [])
    .filter((t) => t && t.text)
    .slice(-topicLimit)
    .map((t) => ({ text: clip(t.text, topicChars), lastMentionAt: Number(t.lastMentionAt) || null }));

  const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
    .slice(-recentLimit)
    .map((m) => ({
      self: m?.isSelf === true,
      who: clip(m?.name ?? m?.uid ?? '', 40),
      text: clip(m?.tail || m?.plain || m?.text || '', recentChars),
      time: Number(m?.time) || null
    }))
    .filter((m) => m.text);

  return {
    key: String(key ?? ''),
    sessionId: sessionId ?? null,
    rotatedAt: now,
    topics,
    recent,
    memoryText: String(memoryText ?? ''),
    relationText: String(relationText ?? '')
  };
}

/**
 * @pure 渲染「上一次会话的记忆」回注文本。
 * 没有可注入内容时返回空串（调用方据此决定是否标记已注入）。
 *
 * 为什么默认只回注 recent：
 * `memoryText`（轻量记忆）与 `relationText`（关系线）都存在按会话持久化的 social 状态里，
 * 轮换不会清掉，下一次唤醒的常规段（群聊摘要 / relation）会原样再注入一遍。
 * 归档若也带这两段，同一条 prompt 里就会出现两份「你和 TA 的关系线」——实测线上确实如此，
 * 既浪费预算也干扰模型。真正会随会话退役而丢失的只有 recent 发言，所以默认只回注它。
 *
 * @param {object} snapshot buildArchiveSnapshot 的返回值
 * @param {object} [opts]
 * @param {number} [opts.recallLimit] 回注最近几条发言，缺省 6
 * @param {boolean} [opts.includeMemory] 是否附带归档时的轻量记忆块（默认 false，见上）
 * @param {boolean} [opts.includeRelation] 是否附带归档时的关系线（默认 false，见上）
 * @returns {string}
 */
export function buildRecallText(snapshot, { recallLimit, includeMemory = false, includeRelation = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const limit = Number.isFinite(recallLimit) && recallLimit > 0
    ? Math.round(recallLimit)
    : DEFAULTS.recallLimit;

  const lines = [];
  if (includeMemory) {
    const memoryText = String(snapshot.memoryText ?? '').trim();
    if (memoryText) lines.push(memoryText);
  }

  const recent = Array.isArray(snapshot.recent) ? snapshot.recent.slice(-limit) : [];
  if (recent.length) {
    lines.push('最近说过的话：');
    for (const m of recent) {
      const who = m?.self ? '你' : (String(m?.who ?? '').trim() || '对方');
      const text = String(m?.text ?? '').trim();
      if (text) lines.push(`- ${who}：${text}`);
    }
  }

  if (includeRelation) {
    const relationText = String(snapshot.relationText ?? '').trim();
    if (relationText) lines.push(relationText);
  }

  if (!lines.length) return '';
  return `【上一次会话的记忆（自动归档，仅供参考）】\n${lines.join('\n')}\n\n`;
}

/**
 * 契约门面（B.1）。两个动作：snapshot / recall。
 *
 * @param {object} _ctx
 * @param {{ action?: 'snapshot'|'recall', ... }} args
 * @returns {{ ok: true, value: any } | { ok: false, code: string, error: string }}
 */
export function handle(_ctx, args) {
  const action = args?.action ?? 'snapshot';
  if (action === 'snapshot') return { ok: true, value: buildArchiveSnapshot(args) };
  if (action === 'recall') {
    return {
      ok: true,
      value: buildRecallText(args?.snapshot, {
        recallLimit: args?.recallLimit,
        includeMemory: args?.includeMemory === true,
        includeRelation: args?.includeRelation === true
      })
    };
  }
  return { ok: false, code: 'INVALID_ARGS', error: `未知动作：${String(action)}（只支持 snapshot / recall）` };
}
