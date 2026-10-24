// 关系线（relations）：跨每日重置保留的长期关系记忆。
//
// 结构（state/relations.json，按会话 key 分）：
//   { "private:123": {
//       profile: { 称呼, 雷点: [], 禁忌: [] },
//       events: [{ date: "YYYY-MM-DD", text }],
//       recentTopics: [{ text, lastMentionAt }]
//   } }
//
// 写入只有控制台（daily-reset 调接口）；AI 只读，避免自己往长期记忆里灌东西。

export const RELATION_LIMITS = Object.freeze({
  maxEvents: 200,
  maxTopics: 20,
  maxPromptChars: 400
});

const str = (value) => String(value ?? '').trim();

function clip(value, max) {
  const text = str(value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = (value, max = 30, limit = 20) => (Array.isArray(value) ? value : [])
    .map((item) => clip(item, max))
    .filter(Boolean)
    .slice(0, limit);
  return {
    称呼: clip(src['称呼'] ?? src.nickname ?? '', 30),
    雷点: list(src['雷点'] ?? src.landmines),
    禁忌: list(src['禁忌'] ?? src.taboos)
  };
}

/** 读取归一化：坏 key/坏条目丢弃，events 按日期倒序，上限 200；topics 上限 20。 */
export function normalizeRelations(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (!/^(group|private):\d+$/.test(key) || !value || typeof value !== 'object') continue;
    const events = (Array.isArray(value.events) ? value.events : [])
      .map((event) => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(event?.date ?? '')) ? String(event.date) : '',
        text: clip(event?.text, 60)
      }))
      .filter((event) => event.text)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, RELATION_LIMITS.maxEvents);
    const recentTopics = (Array.isArray(value.recentTopics) ? value.recentTopics : [])
      .map((topic) => ({
        text: clip(topic?.text, 60),
        lastMentionAt: Number(topic?.lastMentionAt) || 0
      }))
      .filter((topic) => topic.text)
      .sort((a, b) => b.lastMentionAt - a.lastMentionAt)
      .slice(0, RELATION_LIMITS.maxTopics);
    out[key] = { profile: normalizeProfile(value.profile), events, recentTopics };
  }
  return out;
}

/**
 * 追加一条关系线记录。
 * type="event"：按日期归档（同一天同文本去重）；
 * type="topic"：最近话题，重复文本刷新 lastMentionAt。
 */
export function appendRelationEntry(relations, key, { type = 'event', text, date, now = Date.now() } = {}) {
  const canonical = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!canonical) return { ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' };
  const canonicalKey = `${canonical[1]}:${Number(canonical[2])}`;
  const value = clip(text, 60);
  if (!value) return { ok: false, error: 'text 不能为空' };

  const all = normalizeRelations(relations);
  const entry = all[canonicalKey] || { profile: normalizeProfile({}), events: [], recentTopics: [] };

  if (type === 'topic') {
    const topics = [
      { text: value, lastMentionAt: now },
      ...entry.recentTopics.filter((topic) => topic.text !== value)
    ].slice(0, RELATION_LIMITS.maxTopics);
    entry.recentTopics = topics;
  } else {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))
      ? String(date)
      : new Date(now).toISOString().slice(0, 10);
    const events = [
      { date: day, text: value },
      ...entry.events.filter((event) => !(event.date === day && event.text === value))
    ].slice(0, RELATION_LIMITS.maxEvents);
    entry.events = events;
  }

  all[canonicalKey] = entry;
  return { ok: true, relations: all, key: canonicalKey, type: type === 'topic' ? 'topic' : 'event' };
}

function daysAgo(at, now) {
  const value = Number(at) || 0;
  if (!value) return '时间未知';
  const days = Math.max(0, Math.floor((now - value) / 86_400_000));
  if (days <= 0) return '今天';
  if (days === 1) return '1 天前';
  return `${days} 天前`;
}

/**
 * 生成唤醒提示词里的【你和 TA 的关系线】块。
 * - owner 私聊：最近 5 条 event + 3 个话题 + profile 2 条（雷点优先）
 * - 群聊：只给公共称呼/雷点，不带私事
 * - 其它私聊：不注入
 */
export function formatRelationBlock(relations, {
  key,
  kind,
  isOwner = false,
  now = Date.now(),
  maxChars = RELATION_LIMITS.maxPromptChars
} = {}) {
  const all = normalizeRelations(relations);
  const entry = all[key];
  if (!entry) return '';
  const lines = [];
  if (kind === 'group') {
    if (entry.profile['称呼']) lines.push(`- 你平时让群友叫你「${entry.profile['称呼']}」`);
    const landmines = entry.profile['雷点'].slice(0, 2);
    if (landmines.length) lines.push(`- 别踩的雷点：${landmines.join('；')}`);
  } else if (isOwner) {
    for (const event of entry.events.slice(0, 5)) {
      lines.push(`- ${event.date.slice(5)} ${event.text}`);
    }
    const topics = entry.recentTopics.slice(0, 3);
    if (topics.length) {
      lines.push(`- 最近话题：${topics.map((topic) => `${topic.text}（${daysAgo(topic.lastMentionAt, now)}）`).join('；')}`);
    }
    const bits = [];
    for (const landmine of entry.profile['雷点'].slice(0, 2)) bits.push(`雷点：${landmine}`);
    if (entry.profile['称呼']) bits.push(`称呼「${entry.profile['称呼']}」`);
    for (const taboo of entry.profile['禁忌'].slice(0, 1)) bits.push(`禁忌：${taboo}`);
    if (bits.length) lines.push(`- ${bits.slice(0, 2).join('；')}`);
  } else {
    return '';
  }
  if (!lines.length) return '';
  let block = `【你和 TA 的关系线】\n${lines.join('\n')}`;
  const limit = Math.max(80, Number(maxChars) || RELATION_LIMITS.maxPromptChars);
  if ([...block].length > limit) block = [...block].slice(0, limit - 1).join('') + '…';
  return block;
}
