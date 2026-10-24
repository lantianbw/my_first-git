// 谐音候选的管理端逻辑（控制台/admin 接口共用）。
//
// 与 HTTP 层分开：路由只做鉴权、取参与回包，这里负责纯数据变换，
// 方便离线回归（scripts/test-slang-candidates-api.mjs）直接覆盖确认/拒绝语义。

import { createSlangEntry, normalizeSlangEntry, SLANG_STATUS } from './slang-learner.js';

export function candidateText(candidate) {
  return String(candidate?.content ?? '').trim();
}

export function findCandidate(candidates, text) {
  const needle = String(text ?? '').trim().toLowerCase();
  if (!needle) return null;
  return (Array.isArray(candidates) ? candidates : [])
    .find((c) => candidateText(c).toLowerCase() === needle) || null;
}

/** GET /api/socialV2/slang/candidates 的公开形状。 */
export function formatCandidate(candidate) {
  const ids = Array.isArray(candidate?.sourceMessageIds) ? candidate.sourceMessageIds : [];
  return {
    text: candidateText(candidate),
    pinyin: String(candidate?.pinyin ?? ''),
    suggestedFrom: String(candidate?.targetContent ?? ''),
    count: Math.max(0, Number(candidate?.occurrences) || 0),
    firstSeen: String(candidate?.createdAt ?? ''),
    sampleMessageId: ids.length ? String(ids[0]) : null,
  };
}

export function listCandidates(candidates, { limit = 50 } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const list = (Array.isArray(candidates) ? candidates : [])
    .slice()
    .sort((a, b) => (Number(b?.occurrences) || 0) - (Number(a?.occurrences) || 0)
      || String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? '')));
  return {
    total: list.length,
    candidates: list.slice(0, max).map(formatCandidate),
    truncated: list.length > max,
  };
}

function removeCandidatesByText(candidates, text) {
  const needle = String(text ?? '').trim().toLowerCase();
  const kept = [];
  let removed = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (candidateText(c).toLowerCase() === needle) removed += 1;
    else kept.push(c);
  }
  return { candidates: kept, removed };
}

/**
 * 确认一条候选：
 * - 写入/更新 slang.json 的 confirmed 词条（content = 候选词，homophoneOf = 规范词）；
 * - 从候选表里移除同 text 的条目。
 *
 * @returns {{ok: boolean, error?: string, slangEntries: Array, candidates: Array, entry?: object, removed?: number}}
 */
export function confirmCandidate({ slangEntries, candidates, text, realText = '', meaning = '', tags = [] } = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: 'text 不能为空', slangEntries, candidates };
  const candidate = findCandidate(candidates, content);
  const target = String(realText ?? '').trim() || String(candidate?.targetContent ?? '').trim();
  const finalMeaning = String(meaning ?? '').trim()
    || String(candidate?.meaning ?? '').trim()
    || (target ? `${target}（谐音）` : '');
  if (!finalMeaning) {
    return { ok: false, error: '缺少含义：请提供 realText 或 meaning（确认后的词条必须有解释）', slangEntries, candidates };
  }
  const entries = (Array.isArray(slangEntries) ? slangEntries : []).map(normalizeSlangEntry);
  const existing = entries.find((e) => e.content === content);
  let entry;
  if (existing) {
    entry = normalizeSlangEntry({
      ...existing,
      meaning: finalMeaning,
      homophoneOf: target || existing.homophoneOf,
      status: SLANG_STATUS.CONFIRMED,
      source: 'manual',
      updatedAt: new Date().toISOString(),
    });
    entries[entries.indexOf(existing)] = entry;
  } else {
    entry = normalizeSlangEntry({
      ...createSlangEntry({
        content,
        meaning: finalMeaning,
        status: SLANG_STATUS.CONFIRMED,
        source: 'manual',
      }),
      homophoneOf: target,
    });
    entries.push(entry);
  }
  // tags 只作为可选元数据，拼进 usage（词条本身没有 tags 字段）。
  const tagList = Array.isArray(tags) ? tags.map(String).map((t) => t.trim()).filter(Boolean) : [];
  if (tagList.length) entry.usage = [entry.usage, tagList.join('、')].filter(Boolean).join('；');
  const stripped = removeCandidatesByText(candidates, content);
  return { ok: true, slangEntries: entries, candidates: stripped.candidates, entry, removed: stripped.removed };
}

export function rejectCandidate({ candidates, text } = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: 'text 不能为空', candidates, removed: 0 };
  const stripped = removeCandidatesByText(candidates, content);
  if (!stripped.removed) return { ok: false, error: `候选「${content}」不存在`, candidates, removed: 0 };
  return { ok: true, candidates: stripped.candidates, removed: stripped.removed };
}
