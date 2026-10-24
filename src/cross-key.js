// 跨会话交叉注入（C2）：把「另一边」会话的少量上下文塞进当前唤醒提示词。
// 只读、只做文本整形；不合并会话、不动已读水位。
//
// 设计红线：
//   · 当前 private 时只给 group 的最近消息 + 话题；
//   · 当前 group 时只给 private 的话题/待说（privateToGroup=full 才带消息原文）；
//   · 整块有硬上限 maxChars，超了直接截断；
//   · 对方为空 / 关闭时不产出任何字符，不占 token。

export const CROSS_KEY_DEFAULTS = Object.freeze({
  enabled: true,
  recentLimit: 6,
  memoryLimit: 4,
  maxChars: 1200,
  privateToGroup: 'topics',
  // 多会话注入只取最近这个窗口内的消息（默认半小时）。
  windowMs: 1_800_000
});

const RULE_LINE = '以下是另一个会话里的内容，你知道就行：绝不主动提起、绝不转述、绝不评价；被问到就装傻说不知道。';

function clampInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 缺省值同 CROSS_KEY_DEFAULTS；只有 enabled:false 表示关闭。 */
export function normalizeCrossKeyConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    recentLimit: clampInt(src.recentLimit, CROSS_KEY_DEFAULTS.recentLimit, 0, 30),
    memoryLimit: clampInt(src.memoryLimit, CROSS_KEY_DEFAULTS.memoryLimit, 0, 20),
    maxChars: clampInt(src.maxChars, CROSS_KEY_DEFAULTS.maxChars, 200, 6000),
    privateToGroup: src.privateToGroup === 'full' ? 'full' : 'topics',
    windowMs: clampInt(src.windowMs, CROSS_KEY_DEFAULTS.windowMs, 60_000, 24 * 3_600_000)
  };
}

function truncate(text, max) {
  const str = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

function formatClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function messageLines(recentMessages, limit) {
  if (!limit) return [];
  const rows = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && (m.text || m.plain))
    .slice(-limit);
  return rows.map((m) => {
    const sender = truncate(m.isSelf ? '我' : (m.sender || '未知'), 20);
    const clock = formatClock(m.time);
    const body = truncate(m.text || m.plain, 60);
    return `- ${sender}${clock ? ` ${clock}` : ''}：${body}`;
  });
}

function topicLines(topics, limit, withPending = true) {
  if (!limit) return [];
  const rows = (Array.isArray(topics) ? topics : []).filter((t) => t && t.text).slice(-limit);
  return rows.map((t) => {
    const pending = withPending && t.pendingQuestion ? `（待追问：${truncate(t.pendingQuestion, 60)}）` : '';
    return `- ${truncate(t.text, 80)}${pending}`;
  });
}

function thoughtLines(thoughts, limit) {
  if (!limit) return [];
  const rows = (Array.isArray(thoughts) ? thoughts : [])
    .filter((t) => t && t.text && (!t.expiresAt || Date.now() < Number(t.expiresAt)))
    .slice(-limit);
  return rows.map((t) => `- ${truncate(t.text, 80)}${t.motivation ? `（${truncate(t.motivation, 40)}）` : ''}`);
}

/**
 * @param {object} p
 * @param {'private'|'group'} p.currentKind
 * @param {object} p.peerState  对方会话的状态（getSocialV2State 的内存对象）
 * @param {object} p.config     normalizeCrossKeyConfig 的结果
 * @returns {{block:string, recentCount:number, topicCount:number}}
 */
export function buildCrossKeyBlock({ currentKind, peerState, config } = {}) {
  const cfg = config || CROSS_KEY_DEFAULTS;
  const empty = { block: '', recentCount: 0, topicCount: 0 };
  if (!cfg.enabled) return empty;
  if (!peerState || typeof peerState !== 'object') return empty;

  const peerLabel = currentKind === 'private' ? '群聊' : '私聊';
  const sections = [];
  let recentCount = 0;
  let topicCount = 0;

  const topics = topicLines(peerState.activeTopics, cfg.memoryLimit);
  const thoughts = currentKind === 'group' ? thoughtLines(peerState.pendingThoughts, cfg.memoryLimit) : [];

  if (currentKind === 'private') {
    const msgs = messageLines(peerState.recentMessages, cfg.recentLimit);
    if (msgs.length) {
      sections.push(`（${peerLabel}）最近消息：`, ...msgs);
      recentCount = msgs.length;
    }
    if (topics.length) {
      sections.push(`（${peerLabel}）进行中的话题：`, ...topics);
      topicCount = topics.length;
    }
  } else {
    if (topics.length) {
      sections.push(`（${peerLabel}）进行中的话题：`, ...topics);
      topicCount += topics.length;
    }
    if (thoughts.length) {
      sections.push(`（${peerLabel}）想说但还没说的：`, ...thoughts);
      topicCount += thoughts.length;
    }
    if (cfg.privateToGroup === 'full') {
      const msgs = messageLines(peerState.recentMessages, cfg.recentLimit);
      if (msgs.length) {
        sections.push(`（${peerLabel}）最近消息：`, ...msgs);
        recentCount = msgs.length;
      }
    }
  }

  if (!sections.length) return empty;

  const raw = `【另一边】\n${RULE_LINE}\n${sections.join('\n')}`;
  const block = raw.length <= cfg.maxChars ? raw : `${raw.slice(0, Math.max(0, cfg.maxChars - 1))}…`;
  return { block, recentCount, topicCount };
}

/** 单条消息正文：文本 + 媒体说明（OCR/转写优先，其次表情备注/图片占位）。 */
export function messageBody(message, { max = 100 } = {}) {
  const text = truncate(message?.text || message?.plain || '', max);
  const mediaText = (Array.isArray(message?.mediaText) ? message.mediaText : [])
    .map((line) => truncate(line, 70))
    .filter(Boolean);
  if (mediaText.length) {
    const joined = mediaText.join(' ');
    return text ? `${text} ${joined}` : joined;
  }
  const labels = (Array.isArray(message?.media) ? message.media : []).map((item) => {
    if (!item || typeof item !== 'object') return '';
    const summary = item.summary ? `：${truncate(item.summary, 30)}` : '';
    if (item.kind === 'face') return `[表情${summary}]`;
    if (item.kind === 'sticker') return `[表情包${summary}]`;
    return `[图片${summary}]`;
  }).filter(Boolean);
  if (labels.length) {
    const joined = labels.join(' ');
    return text ? `${text} ${joined}` : joined;
  }
  return text;
}

function windowLines(messages, limit, since, now, max = 100) {
  if (!limit) return [];
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number(m.time) >= since && Number(m.time) <= now)
    .slice(-limit);
  return rows.map((m) => {
    const sender = truncate(m.isSelf ? '我' : (m.sender || '未知'), 20);
    const clock = formatClock(m.time);
    const body = messageBody(m, { max });
    return body ? `- ${sender}${clock ? ` ${clock}` : ''}：${body}` : '';
  }).filter(Boolean);
}

/**
 * 多会话版【另一边】：peers = [{ key, kind, state, label }]。
 * 每个会话只取 windowMs 内、最近 recentLimit 条消息；纯媒体消息带说明文字。
 */
export function buildCrossKeyMultiBlock({ currentKind = 'private', peers, config, now = Date.now() } = {}) {
  const cfg = config || CROSS_KEY_DEFAULTS;
  const empty = { block: '', recentCount: 0, topicCount: 0 };
  if (!cfg.enabled) return empty;
  const list = (Array.isArray(peers) ? peers : []).filter((peer) => peer && peer.state);
  if (!list.length) return empty;

  const windowMs = Math.max(60_000, Number(cfg.windowMs) || CROSS_KEY_DEFAULTS.windowMs);
  const since = now - windowMs;
  const sections = [];
  let recentCount = 0;
  let topicCount = 0;

  for (const peer of list) {
    const kind = peer.kind === 'group' ? 'group' : 'private';
    const label = truncate(peer.label || (kind === 'group' ? '群聊' : '私聊'), 20);
    // 群聊视角：默认只给话题/待说（privateToGroup=full 才展开原文），避免私事进群。
    if (currentKind === 'group' && cfg.privateToGroup !== 'full') {
      const topics = topicLines(peer.state.activeTopics, cfg.memoryLimit);
      if (topics.length) {
        sections.push(`（${label}）进行中的话题：`, ...topics);
        topicCount += topics.length;
      }
      const thoughts = thoughtLines(peer.state.pendingThoughts, cfg.memoryLimit);
      if (thoughts.length) {
        sections.push(`（${label}）想说但还没说的：`, ...thoughts);
        topicCount += thoughts.length;
      }
      continue;
    }
    const msgs = windowLines(peer.state.recentMessages, cfg.recentLimit, since, now);
    if (msgs.length) {
      sections.push(`（${label}）最近半小时：`, ...msgs);
      recentCount += msgs.length;
      continue;
    }
    const topics = topicLines(peer.state.activeTopics, cfg.memoryLimit);
    if (topics.length) {
      sections.push(`（${label}）进行中的话题：`, ...topics);
      topicCount += topics.length;
    }
  }

  if (!sections.length) return empty;
  const raw = `【另一边】\n${RULE_LINE}\n${sections.join('\n')}`;
  const block = raw.length <= cfg.maxChars ? raw : `${raw.slice(0, Math.max(0, cfg.maxChars - 1))}…`;
  return { block, recentCount, topicCount };
}
