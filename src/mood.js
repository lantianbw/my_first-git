// 心情系统（第三期）：手札（3 天流水账）、底色、动态心情、结算清单。
//
// 纯逻辑在此：归一化、手札过期、同标签计数、动态覆盖底色、结算、注入格式化。
// 文件读写与 HTTP/MCP 接线在 bridge.js；daily-reset 只调用 settle 端点。
//
// 设计约束：
// - 手札只活 3 天，过期自动清；不强化、不消除，就是流水账；
// - dynamicMood 存在时覆盖 baseMood；每次结算后清空 dynamicMood；
// - 注入只给计数与最近一条（不给手札全文），总长 <=120 字；
// - 结算只给事实（手札计数 + 当前底色），不做平均、不替她判断。

export const MOOD_TAGS = Object.freeze(['被冷落', '被夸', '不安', '吃醋', '其他']);

export const MOOD_LIMITS = Object.freeze({
  handnoteDays: 3,
  maxHandnotes: 100,
  maxText: 40,
  maxWord: 8,
  maxReason: 30,
  maxPromptChars: 120,
  settleNotes: 6,
  settlePromptChars: 200
});

const DAY = 86_400_000;

const str = (value) => String(value ?? '').trim();

function clipChars(value, max) {
  const list = [...str(value)];
  return list.length > max ? list.slice(0, max).join('') : list.join('');
}

function createId(now) {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isoOf(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : (fallback ? new Date(fallback).toISOString() : '');
}

export function normalizeTag(tag) {
  const value = str(tag);
  return MOOD_TAGS.includes(value) ? value : '其他';
}

function normalizeMoodWord(raw, fallbackAt) {
  if (!raw || typeof raw !== 'object') return null;
  const word = clipChars(raw.word, MOOD_LIMITS.maxWord);
  if (!word) return null;
  return {
    word,
    reason: clipChars(raw.reason, MOOD_LIMITS.maxReason),
    since: isoOf(raw.since, fallbackAt),
    settledAt: isoOf(raw.settledAt, fallbackAt)
  };
}

/** moods.json 归一化：过期手札在这里就丢掉（不等结算），动态/底色保留结构。 */
export function normalizeMoods(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const handnotes = (Array.isArray(src.handnotes) ? src.handnotes : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = clipChars(item.text, MOOD_LIMITS.maxText);
      if (!text) return null;
      const createdAt = Number(item.createdAt) || now;
      const expiresAt = Number(item.expiresAt) || createdAt + MOOD_LIMITS.handnoteDays * DAY;
      return {
        id: str(item.id) || createId(createdAt),
        text,
        tag: normalizeTag(item.tag),
        createdAt,
        expiresAt
      };
    })
    .filter(Boolean)
    .filter((item) => item.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MOOD_LIMITS.maxHandnotes);

  const dynamicSrc = src.dynamicMood && typeof src.dynamicMood === 'object' ? src.dynamicMood : null;
  const dynamicMood = dynamicSrc?.word
    ? {
      word: clipChars(dynamicSrc.word, MOOD_LIMITS.maxWord),
      reason: clipChars(dynamicSrc.reason, MOOD_LIMITS.maxReason),
      at: isoOf(dynamicSrc.at, now)
    }
    : null;

  const baseMood = normalizeMoodWord(src.baseMood, now);

  return {
    handnotes,
    baseMood,
    dynamicMood: dynamicMood?.word ? dynamicMood : null
  };
}

export function addHandnote(moods, { text, tag, now = Date.now() } = {}) {
  const body = clipChars(text, MOOD_LIMITS.maxText);
  const normalized = normalizeMoods(moods, now);
  if (!body) return { moods: normalized, note: null };
  const note = {
    id: createId(now),
    text: body,
    tag: normalizeTag(tag),
    createdAt: now,
    expiresAt: now + MOOD_LIMITS.handnoteDays * DAY
  };
  return { moods: normalizeMoods({ ...normalized, handnotes: [...normalized.handnotes, note] }, now), note };
}

export function setDynamicMood(moods, { word, reason, now = Date.now() } = {}) {
  const value = clipChars(word, MOOD_LIMITS.maxWord);
  if (!value) return { moods: normalizeMoods(moods, now), mood: null };
  const mood = { word: value, reason: clipChars(reason, MOOD_LIMITS.maxReason), at: new Date(now).toISOString() };
  return { moods: normalizeMoods({ ...normalizeMoods(moods, now), dynamicMood: mood }, now), mood };
}

export function setBaseMood(moods, { word, reason, now = Date.now() } = {}) {
  const value = clipChars(word, MOOD_LIMITS.maxWord);
  if (!value) return { moods: normalizeMoods(moods, now), mood: null };
  const stamp = new Date(now).toISOString();
  const baseMood = { word: value, reason: clipChars(reason, MOOD_LIMITS.maxReason), since: stamp, settledAt: stamp };
  return { moods: normalizeMoods({ ...normalizeMoods(moods, now), baseMood }, now), mood: baseMood };
}

/** 当前心情：动态优先，否则底色；都没有就是 null。 */
export function currentMood(moods, now = Date.now()) {
  const normalized = normalizeMoods(moods, now);
  if (normalized.dynamicMood) {
    return {
      word: normalized.dynamicMood.word,
      reason: normalized.dynamicMood.reason,
      since: normalized.dynamicMood.at,
      source: 'dynamic'
    };
  }
  if (normalized.baseMood) {
    return {
      word: normalized.baseMood.word,
      reason: normalized.baseMood.reason,
      since: normalized.baseMood.since,
      source: 'base'
    };
  }
  return null;
}

/** 三天内的手札按标签计数（同标签累加），返回按次数降序。 */
export function moodTagCounts(moods, now = Date.now()) {
  const counts = new Map();
  for (const note of normalizeMoods(moods, now).handnotes) {
    counts.set(note.tag, (counts.get(note.tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || MOOD_TAGS.indexOf(a.tag) - MOOD_TAGS.indexOf(b.tag));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function hhmm(timestamp) {
  const d = new Date(timestamp);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sinceText(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t) || t <= 0) return '';
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const startOfThat = new Date(t); startOfThat.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startOfToday.getTime() - startOfThat.getTime()) / DAY);
  const hour = new Date(t).getHours();
  if (diffDays <= 0) return `今天 ${hhmm(t)}`;
  if (diffDays === 1) return `${hour >= 18 || hour < 4 ? '昨晚' : '昨天'} ${hhmm(t)}`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(t)}`;
}

/**
 * 【心情】块：仅 owner 私聊注入；<=120 字。
 * 只给计数和最近一条的标签，不给手札全文。
 */
export function formatMoodBlock(moods, { now = Date.now(), maxChars = MOOD_LIMITS.maxPromptChars } = {}) {
  const normalized = normalizeMoods(moods, now);
  const current = currentMood(normalized, now);
  const counts = moodTagCounts(normalized, now);
  if (!current && !counts.length) return '';
  const lines = ['【心情】'];
  if (current) {
    const since = sinceText(current.since, now);
    lines.push(`心情：${current.word}${current.reason ? `（${current.reason}）` : ''}${since ? `；从${since} 开始` : ''}`);
  }
  if (counts.length) {
    const parts = counts.slice(0, 2).map(({ tag, count }) => `${tag} ×${count}`);
    const latest = normalized.handnotes.at(-1);
    const latestNote = latest && !counts.slice(0, 2).some((item) => item.tag === latest.tag)
      ? `，最近一条：${latest.tag}`
      : '';
    lines.push(`最近：${parts.join('、')}（三天内${latestNote}）`);
  }
  let block = lines.join('\n');
  const limit = Math.max(40, Number(maxChars) || MOOD_LIMITS.maxPromptChars);
  if ([...block].length > limit) block = `${[...block].slice(0, limit - 1).join('')}…`;
  return block;
}

/** 机械结算：清过期手札（normalize 已做）+ 作废动态心情；生成给 AI 的清单。 */
export function settleMood({ moods, now = Date.now() } = {}) {
  const normalized = normalizeMoods(moods, now);
  const pendingNotes = normalized.handnotes.slice(-MOOD_LIMITS.settleNotes);
  return {
    moods: { handnotes: normalized.handnotes, baseMood: normalized.baseMood, dynamicMood: null },
    pending: { notes: pendingNotes, baseMood: normalized.baseMood, updatedAt: now },
    clearedDynamic: Boolean(normalized.dynamicMood)
  };
}

/** 【心情结算】块：只给事实与动作，不做平均、不替她判断。 */
export function formatMoodSettleBlock(pending, { maxChars = MOOD_LIMITS.settlePromptChars } = {}) {
  if (!pending || typeof pending !== 'object') return '';
  const notes = Array.isArray(pending.notes) ? pending.notes : [];
  if (!notes.length && !pending.baseMood) return '';
  const counts = new Map();
  for (const note of notes) counts.set(note.tag, (counts.get(note.tag) || 0) + 1);
  const parts = [...counts.entries()].map(([tag, count]) => `${tag} ×${count}`).join('、');
  const base = pending.baseMood?.word ? `当前底色：${pending.baseMood.word}` : '当前没有底色';
  const lines = [
    '【心情结算】',
    '翻一下这三天的情绪，定明天的心情底色（不用平均，写你真实的感觉）。',
    `手札：${parts || '这三天没有手札'}；${base}`,
    '手札全文用 qq_mood_state 看；写完用 qq_mood_settle 写入，清单会自动清空。'
  ];
  let block = lines.join('\n');
  const limit = Math.max(60, Number(maxChars) || MOOD_LIMITS.settlePromptChars);
  if ([...block].length > limit) block = `${[...block].slice(0, limit - 1).join('')}…`;
  return block;
}
