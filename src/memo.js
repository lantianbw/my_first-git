// 记忆系统三件套（第二期）：日程（agenda）、画像（profile）、主观认知（selfview）。
//
// 纯逻辑在此：归一化、增删改查、机械衰减、结算清单、注入格式化。
// 文件读写与 HTTP/MCP 接线在 bridge.js；daily-reset 只调用 settle 端点。
//
// 设计约束：
// - agenda 默认 7 天到期；blurred 是由 AI 在结算时填的模糊化版本（"上了高数"→"有课"）；
// - profile 机械衰减：lastConfirmedAt 超过 14 天且 strength<=2 → faded（不删、不注入）；
// - 注入总长 <=300 字；pending 只列事实，不做情绪引导。

export const MEMO_LIMITS = Object.freeze({
  maxAgenda: 50,
  maxProfile: 50,
  agendaDays: 7,
  fadeDays: 14,
  fadeStrengthMax: 2,
  dueSoonDays: 3,
  maxPromptChars: 300,
  maxPending: 5,
  maxText: 60,
  maxSelfview: 150
});

const DAY = 86_400_000;

const str = (value) => String(value ?? '').trim();

function clip(value, max) {
  const text = str(value);
  return text.length > max ? text.slice(0, max) : text;
}

function createId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** agenda 列表归一化：坏条目丢弃，按到期时间排序。 */
export function normalizeAgenda(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = clip(item.text, MEMO_LIMITS.maxText);
      if (!text) return null;
      const createdAt = Number(item.createdAt) || Date.now();
      const expiresAt = Number(item.expiresAt) || createdAt + MEMO_LIMITS.agendaDays * DAY;
      return {
        id: str(item.id) || createId('a'),
        text,
        blurred: clip(item.blurred, MEMO_LIMITS.maxText),
        createdAt,
        expiresAt,
        strength: clampInt(item.strength, 1, 0, 99),
        source: item.source === 'manual' ? 'manual' : 'ai'
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, MEMO_LIMITS.maxAgenda);
  return list;
}

/** profile 列表归一化：status 只允许 active/faded。 */
export function normalizeProfile(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = clip(item.text, MEMO_LIMITS.maxText);
      if (!text) return null;
      return {
        id: str(item.id) || createId('p'),
        text,
        status: item.status === 'faded' ? 'faded' : 'active',
        strength: clampInt(item.strength, 1, 0, 99),
        evidence: clip(item.evidence, 120),
        createdAt: Number(item.createdAt) || Date.now(),
        lastConfirmedAt: Number(item.lastConfirmedAt) || Date.now()
      };
    })
    .filter(Boolean)
    .slice(0, MEMO_LIMITS.maxProfile);
  return list;
}

export function normalizeSelfview(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = clip(src.text, MEMO_LIMITS.maxSelfview);
  return { text, updatedAt: Number(src.updatedAt) || 0 };
}

export function addAgenda(list, { text, note, now = Date.now(), days = MEMO_LIMITS.agendaDays } = {}) {
  const value = clip(text, MEMO_LIMITS.maxText);
  if (!value) return { list: normalizeAgenda(list), entry: null };
  const entry = {
    id: createId('a'),
    text: value,
    blurred: clip(note, MEMO_LIMITS.maxText),
    createdAt: now,
    expiresAt: now + Math.max(1, Number(days) || MEMO_LIMITS.agendaDays) * DAY,
    strength: 1,
    source: 'ai'
  };
  const next = [...normalizeAgenda(list), entry]
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, MEMO_LIMITS.maxAgenda);
  return { list: next, entry };
}

/** 同一文本视为「再次提及」：strength+1、刷新 lastConfirmedAt；否则新增。 */
export function addProfile(list, { text, note, now = Date.now() } = {}) {
  const value = clip(text, MEMO_LIMITS.maxText);
  if (!value) return { list: normalizeProfile(list), entry: null, created: false };
  const existing = normalizeProfile(list).find((item) => item.text === value);
  if (existing) {
    const next = normalizeProfile(list).map((item) => (item.id === existing.id
      ? { ...item, strength: item.strength + 1, status: 'active', lastConfirmedAt: now, evidence: clip(note, 120) || item.evidence }
      : item));
    return { list: next, entry: next.find((item) => item.id === existing.id), created: false };
  }
  const entry = {
    id: createId('p'),
    text: value,
    status: 'active',
    strength: 1,
    evidence: clip(note, 120),
    createdAt: now,
    lastConfirmedAt: now
  };
  return { list: [...normalizeProfile(list), entry].slice(0, MEMO_LIMITS.maxProfile), entry, created: true };
}

export function updateAgenda(list, id, { text, strengthDelta, extendDays, blur, now = Date.now() } = {}) {
  let entry = null;
  const next = normalizeAgenda(list).map((item) => {
    if (item.id !== String(id)) return item;
    const updated = {
      ...item,
      text: text ? clip(text, MEMO_LIMITS.maxText) : item.text,
      blurred: blur !== undefined ? clip(blur, MEMO_LIMITS.maxText) : item.blurred,
      strength: Math.max(0, item.strength + clampInt(strengthDelta, 0, -99, 99)),
      expiresAt: extendDays ? Math.max(item.expiresAt, now + Number(extendDays) * DAY) : item.expiresAt
    };
    entry = updated;
    return updated;
  }).sort((a, b) => a.expiresAt - b.expiresAt);
  return { list: next, entry };
}

export function updateProfile(list, id, { text, strengthDelta, now = Date.now() } = {}) {
  let entry = null;
  const next = normalizeProfile(list).map((item) => {
    if (item.id !== String(id)) return item;
    const updated = {
      ...item,
      text: text ? clip(text, MEMO_LIMITS.maxText) : item.text,
      strength: Math.max(0, item.strength + clampInt(strengthDelta, 0, -99, 99)),
      status: 'active',
      lastConfirmedAt: now
    };
    entry = updated;
    return updated;
  });
  return { list: next, entry };
}

export function removeMemo(list, id) {
  const source = Array.isArray(list) ? list : [];
  const target = source.find((item) => item && item.id === String(id));
  if (!target) return { list: source, removed: false, entry: null };
  return { list: source.filter((item) => item.id !== String(id)), removed: true, entry: target };
}

/**
 * 机械结算 + 生成待 AI 决定的清单。
 * - agenda：过期删除；3 天内到期 → pending 询问
 * - profile：14 天未确认且 strength<=2 → faded；strength>=3 → pending 询问
 */
export function settleMemos({ agenda, profile, now = Date.now() } = {}) {
  const liveAgenda = normalizeAgenda(agenda).filter((item) => item.expiresAt > now);
  const fadedProfile = normalizeProfile(profile).map((item) => (
    item.status === 'active'
      && now - item.lastConfirmedAt > MEMO_LIMITS.fadeDays * DAY
      && item.strength <= MEMO_LIMITS.fadeStrengthMax
      ? { ...item, status: 'faded' }
      : item
  ));

  const pending = [];
  for (const item of liveAgenda) {
    const daysLeft = Math.max(1, Math.ceil((item.expiresAt - now) / DAY));
    if (daysLeft <= MEMO_LIMITS.dueSoonDays) {
      pending.push({ type: 'agenda', id: item.id, text: item.text, daysLeft });
    }
  }
  for (const item of fadedProfile) {
    if (item.status === 'active' && item.strength >= 3) {
      pending.push({ type: 'profile', id: item.id, text: item.text, strength: item.strength });
    }
  }

  return { agenda: liveAgenda, profile: fadedProfile, pending };
}

function daysLeftText(expiresAt, now) {
  const days = Math.max(1, Math.ceil((Number(expiresAt) - now) / DAY));
  return `${days} 天`;
}

/**
 * 【记忆】块：日程最多 3（临近到期优先）+ 画像最多 3（active 按 strength）+ 关系 1 句。
 * 总长受 maxChars（默认 300）截断。
 */
export function formatMemoBlock({ agenda, profile, selfview, now = Date.now(), maxChars = MEMO_LIMITS.maxPromptChars } = {}) {
  const lines = ['【记忆】'];
  const agendaTop = normalizeAgenda(agenda)
    .filter((item) => item.expiresAt > now)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, 3);
  if (agendaTop.length) {
    lines.push(`- 日程：${agendaTop.map((item) => `${item.text}（还剩 ${daysLeftText(item.expiresAt, now)}）`).join('；')}`);
  }
  const profileTop = normalizeProfile(profile)
    .filter((item) => item.status === 'active')
    .sort((a, b) => b.strength - a.strength || b.lastConfirmedAt - a.lastConfirmedAt)
    .slice(0, 3);
  if (profileTop.length) {
    lines.push(`- 画像：${profileTop.map((item) => item.text).join('；')}`);
  }
  const selfText = normalizeSelfview(selfview).text;
  if (selfText) lines.push(`- 关系：${selfText}`);
  if (lines.length === 1) return '';
  let block = lines.join('\n');
  const limit = Math.max(80, Number(maxChars) || MEMO_LIMITS.maxPromptChars);
  if ([...block].length > limit) block = `${[...block].slice(0, limit - 1).join('')}…`;
  return block;
}

/** 【待结算】块：只列事实，最多 maxItems 条。 */
export function formatPendingBlock(pending, { maxItems = MEMO_LIMITS.maxPending } = {}) {
  const rows = (Array.isArray(pending) ? pending : []).slice(0, Math.max(1, Number(maxItems) || MEMO_LIMITS.maxPending));
  if (!rows.length) return '';
  const lines = ['【待结算】'];
  for (const item of rows) {
    if (item?.type === 'agenda') {
      lines.push(`- 日程「${item.text}」还剩 ${item.daysLeft} 天：延长 3 天 / 模糊化 / 删除？`);
    } else {
      lines.push(`- 画像「${item.text}」强度 ${item.strength}：记进日记 / 继续保留 / 淡出？`);
    }
  }
  return lines.join('\n');
}

/** 应用 pending 里的某条决定（bridge 的 settle 端点可选支持，便于一次处理完）。 */
export function applyPendingDecision(state, decision = {}) {
  const { type, id, action, blur } = decision;
  if (type === 'agenda') {
    if (action === 'extend') return updateAgenda(state.agenda, id, { extendDays: 3 });
    if (action === 'blur') return updateAgenda(state.agenda, id, { blur: blur || '' });
    if (action === 'delete') return removeMemo(state.agenda, id);
  }
  if (type === 'profile') {
    if (action === 'keep') return updateProfile(state.profile, id, { strengthDelta: 1 });
    if (action === 'fade') {
      const next = normalizeProfile(state.profile).map((item) => (
        item.id === String(id) ? { ...item, status: 'faded' } : item
      ));
      return { list: next, entry: next.find((item) => item.id === String(id)) };
    }
  }
  return { list: type === 'agenda' ? state.agenda : state.profile, entry: null };
}
