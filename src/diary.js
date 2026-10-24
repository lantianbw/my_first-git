// 日记三档（第二期下）：重要事件 + 当时心情 + 想说没说出口的话。
//
// 与已有三件的分工：日程管短期小事（7 天）、画像管长期印象（按成立度淡）、
// 日记只放值得长期记的。纯逻辑在此：归一化、增删改查、寿命计算、搁着、模糊视图、结算清单。
// 文件读写与 HTTP/MCP 接线在 bridge.js；daily-reset 只调用 settle 端点。
//
// 四条硬规则（写死）：
// 1. 寿命从 createdAt 算绝对时长，不跟「最后一次想起」
// 2. 翻看不续命；只有明确 extend 才加天数
// 3. 同一天内多次查看只算一次延长（翻看本身不延长，故多次翻看不会改变到期时间）
// 4. 升降档按新档初始寿命重算，不在旧寿命上叠加

export const DIARY_LIMITS = Object.freeze({
  maxText: 500,
  maxMood: 20,
  maxUnsaid: 60,
  maxPromptChars: 300,
  maxInject: 3,
  maxPending: 5,
  maxTitle: 16
});

export const DIARY_LEVELS = Object.freeze({
  normal: Object.freeze({
    key: 'normal', name: '日常', initialDays: 7, extendDays: 3,
    upgradeAboveDays: 13, downgradeBelowDays: null, warnEveryDays: 1
  }),
  important: Object.freeze({
    key: 'important', name: '重要', initialDays: 21, extendDays: 7,
    upgradeAboveDays: 60, downgradeBelowDays: 10, warnEveryDays: 3
  }),
  etched: Object.freeze({
    key: 'etched', name: '刻骨铭心', initialDays: 90, extendDays: 30,
    upgradeAboveDays: null, downgradeBelowDays: 30, warnEveryDays: 7
  })
});

const DAY = 86_400_000;
const LEVEL_KEYS = Object.keys(DIARY_LEVELS);
const STATUSES = new Set(['active', 'shelved', 'deleted', 'expired']);

const str = (value) => String(value ?? '').trim();

function clip(value, max) {
  const text = str(value);
  return text.length > max ? text.slice(0, max) : text;
}

function chars(value) {
  return [...str(value)];
}

function clipChars(value, max) {
  const list = chars(value);
  return list.length > max ? list.slice(0, max).join('') : list.join('');
}

function createId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function normalizeLevel(level) {
  const key = str(level);
  return LEVEL_KEYS.includes(key) ? key : 'normal';
}

/** 日记列表归一化：坏条目丢弃，按到期时间排序；deleted 保留（回收站）。 */
export function normalizeDiary(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = clipChars(item.text, DIARY_LIMITS.maxText);
      if (!text) return null;
      const level = normalizeLevel(item.level);
      const createdAt = Number(item.createdAt) || Date.now();
      const expiresAt = Number(item.expiresAt) || createdAt + DIARY_LEVELS[level].initialDays * DAY;
      const status = STATUSES.has(item.status) ? item.status : 'active';
      const shelveReason = item.shelveReason === 'afraid' || item.shelveReason === 'bored' ? item.shelveReason : '';
      return {
        id: str(item.id) || createId(),
        level,
        text,
        mood: clipChars(item.mood, DIARY_LIMITS.maxMood),
        unsaid: clipChars(item.unsaid, DIARY_LIMITS.maxUnsaid),
        createdAt,
        expiresAt,
        warnedAt: Number(item.warnedAt) || 0,
        viewCount: clampInt(item.viewCount, 0, 0, 1_000_000),
        shelveReason,
        status,
        deletedAt: Number(item.deletedAt) || 0,
        // 内部字段：afraid 搁着时冻结计时的起点；bored 不使用。
        shelvedAt: Number(item.shelvedAt) || 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** 无障碍的剩余毫秒：afraid 冻结在搁着那一刻，bored 照常扣。 */
export function diaryRemainingMs(entry, now = Date.now()) {
  if (!entry) return 0;
  if (entry.status === 'shelved' && entry.shelveReason === 'afraid' && entry.shelvedAt) {
    return Number(entry.expiresAt) - Number(entry.shelvedAt);
  }
  return Number(entry.expiresAt) - now;
}

export function addDiary(list, { text, level = 'normal', mood = '', unsaid = '', now = Date.now() } = {}) {
  const body = clipChars(text, DIARY_LIMITS.maxText);
  if (!body) return { list: normalizeDiary(list), entry: null };
  const key = normalizeLevel(level);
  const entry = {
    id: createId(),
    level: key,
    text: body,
    mood: clipChars(mood, DIARY_LIMITS.maxMood),
    unsaid: clipChars(unsaid, DIARY_LIMITS.maxUnsaid),
    createdAt: now,
    expiresAt: now + DIARY_LEVELS[key].initialDays * DAY,
    warnedAt: 0,
    viewCount: 0,
    shelveReason: '',
    status: 'active',
    deletedAt: 0,
    shelvedAt: 0
  };
  return { list: normalizeDiary([...normalizeDiary(list), entry]), entry };
}

/**
 * 展开全文：只记 viewCount，绝不改 expiresAt（硬规则 2/3）。
 * deleted 条目不可打开；其余状态（含 shelved / expired）允许显式查看。
 */
export function openDiary(list, id, { now = Date.now() } = {}) {
  let entry = null;
  const next = normalizeDiary(list).map((item) => {
    if (item.id !== str(id)) return item;
    if (item.status === 'deleted') return item;
    const updated = { ...item, viewCount: item.viewCount + 1, lastViewedAt: now };
    entry = updated;
    return updated;
  });
  return { list: next, entry };
}

export function updateDiary(list, id, {
  text, mood, unsaid, extendDays, level, shelve, unshelve, now = Date.now()
} = {}) {
  let entry = null;
  const next = normalizeDiary(list).map((item) => {
    if (item.id !== str(id)) return item;
    if (item.status === 'deleted') return item;
    const updated = { ...item };
    if (text !== undefined) {
      const body = clipChars(text, DIARY_LIMITS.maxText);
      if (body) updated.text = body;
    }
    if (mood !== undefined) updated.mood = clipChars(mood, DIARY_LIMITS.maxMood);
    if (unsaid !== undefined) updated.unsaid = clipChars(unsaid, DIARY_LIMITS.maxUnsaid);

    // 搁着 / 取回：afraid 冻结计时，bored 照常扣；理由可改。
    if (unshelve === true && updated.status === 'shelved') {
      if (updated.shelveReason === 'afraid' && updated.shelvedAt) {
        updated.expiresAt += Math.max(0, now - updated.shelvedAt);
      }
      updated.status = 'active';
      updated.shelveReason = '';
      updated.shelvedAt = 0;
    }
    if (shelve === 'afraid' || shelve === 'bored') {
      if (updated.status !== 'shelved') {
        updated.shelvedAt = shelve === 'afraid' ? now : 0;
      } else if (updated.shelveReason !== shelve) {
        // 理由变更时结算旧的冻结区间，避免把 afraid 的静默期算进新理由。
        if (updated.shelveReason === 'afraid' && updated.shelvedAt) {
          updated.expiresAt += Math.max(0, now - updated.shelvedAt);
        }
        updated.shelvedAt = shelve === 'afraid' ? now : 0;
      }
      updated.status = 'shelved';
      updated.shelveReason = shelve;
    }

    // 升降档：按新档初始寿命重算，不在旧寿命上叠加（硬规则 4）。
    // 从「现在」起算新档寿命：若按 createdAt 重算，老条目降档会直接变成已过期。
    const nextLevel = level === undefined ? null : normalizeLevel(level);
    if (nextLevel && nextLevel !== item.level) {
      updated.level = nextLevel;
      updated.expiresAt = now + DIARY_LEVELS[nextLevel].initialDays * DAY;
    }

    // 只有明确 extend 才加天数；按 createdAt 的绝对时长累加（硬规则 1/2）。
    const extend = Number(extendDays);
    if (Number.isFinite(extend) && extend > 0) {
      updated.expiresAt += Math.min(3650, Math.round(extend)) * DAY;
    }
    entry = updated;
    return updated;
  });
  return { list: next, entry };
}

/** 软删进回收站：只标 deletedAt，不物理删除。 */
export function deleteDiary(list, id, { now = Date.now() } = {}) {
  let entry = null;
  const next = normalizeDiary(list).map((item) => {
    if (item.id !== str(id)) return item;
    if (item.status === 'deleted') { entry = item; return item; }
    const updated = { ...item, status: 'deleted', deletedAt: now };
    entry = updated;
    return updated;
  });
  return { list: next, entry: entry?.status === 'deleted' ? entry : null };
}

const LEVEL_NAME = (level) => DIARY_LEVELS[normalizeLevel(level)].name;

function shortTitle(text, max = DIARY_LIMITS.maxTitle) {
  const list = chars(text);
  return list.length > max ? `${list.slice(0, max).join('')}…` : list.join('');
}

function shortDate(timestamp) {
  const d = new Date(timestamp);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function remainingRatio(entry, now) {
  const total = Math.max(1, Number(entry.expiresAt) - Number(entry.createdAt));
  return Math.min(1, Math.max(0, diaryRemainingMs(entry, now) / total));
}

function levelLine(entry, now) {
  const ratio = remainingRatio(entry, now);
  const parts = [`[${LEVEL_NAME(entry.level)}]`, shortDate(entry.createdAt)];
  if (entry.mood) parts.push(`心情：${entry.mood}`);
  if (ratio > 0.5) parts.push(`｜${shortTitle(entry.text)}`);
  return `- ${parts.join(' ')}`;
}

/** 模糊视图：永不返回正文全文与 unsaid。 */
export function fuzzyDiary(entry, now = Date.now()) {
  if (!entry) return null;
  const remaining = diaryRemainingMs(entry, now);
  return {
    id: entry.id,
    level: entry.level,
    levelName: LEVEL_NAME(entry.level),
    date: shortDate(entry.createdAt),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    daysLeft: Math.max(0, Math.ceil(remaining / DAY)),
    remainingRatio: Number(remainingRatio(entry, now).toFixed(3)),
    mood: entry.mood,
    title: shortTitle(entry.text),
    hasUnsaid: Boolean(entry.unsaid),
    status: entry.status,
    shelveReason: entry.shelveReason,
    viewCount: entry.viewCount
  };
}

/** 【日记】块：仅在 owner 私聊注入；最多 3 条，按到期紧急度排序。 */
export function formatDiaryBlock(diary, { now = Date.now(), maxChars = DIARY_LIMITS.maxPromptChars, maxItems = DIARY_LIMITS.maxInject } = {}) {
  const live = normalizeDiary(diary)
    .filter((item) => item.status === 'active' && diaryRemainingMs(item, now) > 0)
    .sort((a, b) => remainingRatio(a, now) - remainingRatio(b, now))
    .slice(0, Math.max(1, Number(maxItems) || DIARY_LIMITS.maxInject));
  if (!live.length) return '';
  const lines = ['【日记】', ...live.map((item) => levelLine(item, now))];
  if (live.length) lines.push('（看全文用 qq_diary_open；不主动在群里提）');
  let block = lines.join('\n');
  const limit = Math.max(80, Number(maxChars) || DIARY_LIMITS.maxPromptChars);
  if ([...block].length > limit) block = `${[...block].slice(0, limit - 1).join('')}…`;
  return block;
}

/** 机械结算 + 生成待 AI 决定的清单。 */
export function settleDiary({ diary, profile, now = Date.now() } = {}) {
  let expired = 0;
  const list = normalizeDiary(diary).map((item) => {
    if (item.status !== 'active' && item.status !== 'shelved') return item;
    if (diaryRemainingMs(item, now) > 0) return item;
    expired += 1;
    return { ...item, status: 'expired' };
  });

  const pending = [];
  const settled = list.map((item) => {
    if (item.status !== 'active') return item;
    const config = DIARY_LEVELS[item.level];
    const daysLeft = Math.max(0, Math.ceil(diaryRemainingMs(item, now) / DAY));
    let updated = item;
    // warnedAt 按档更新：normal 1 天一次 / important 3 天 / etched 7 天。
    if (now - item.warnedAt >= config.warnEveryDays * DAY) {
      pending.push({ type: 'dueSoon', id: item.id, level: item.level, text: shortTitle(item.text), daysLeft });
      updated = { ...updated, warnedAt: now };
    }
    if (config.upgradeAboveDays != null && daysLeft > config.upgradeAboveDays) {
      pending.push({ type: 'upgrade', id: item.id, level: item.level, text: shortTitle(item.text), daysLeft });
    }
    if (config.downgradeBelowDays != null && daysLeft < config.downgradeBelowDays) {
      pending.push({ type: 'downgrade', id: item.id, level: item.level, text: shortTitle(item.text), daysLeft });
    }
    return updated;
  });

  for (const item of Array.isArray(profile) ? profile : []) {
    if (!item || item.status !== 'active' || Number(item.strength) < 3) continue;
    pending.push({ type: 'profile', id: str(item.id), text: clipChars(item.text, 60), strength: Number(item.strength) });
  }

  return { diary: settled, pending, expired };
}

/** 【日记待结算】块：只列事实，最多 5 条。 */
export function formatDiaryPendingBlock(pending, { maxItems = DIARY_LIMITS.maxPending } = {}) {
  const rows = (Array.isArray(pending) ? pending : []).slice(0, Math.max(1, Number(maxItems) || DIARY_LIMITS.maxPending));
  if (!rows.length) return '';
  const lines = ['【日记待结算】'];
  for (const item of rows) {
    if (item?.type === 'dueSoon') {
      lines.push(`- 日记「${item.text}」${LEVEL_NAME(item.level)}：还剩 ${item.daysLeft} 天（延长 / 升档 / 搁着 / 删除）`);
    } else if (item?.type === 'upgrade') {
      lines.push(`- 日记「${item.text}」${LEVEL_NAME(item.level)}：还剩 ${item.daysLeft} 天，可升档`);
    } else if (item?.type === 'downgrade') {
      lines.push(`- 日记「${item.text}」${LEVEL_NAME(item.level)}：还剩 ${item.daysLeft} 天，可降档`);
    } else if (item?.type === 'profile') {
      lines.push(`- 画像「${item.text}」强度 ${item.strength}：可以考虑记进日记`);
    }
  }
  return lines.join('\n');
}
