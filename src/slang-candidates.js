// 谐音候选登记表（state/slang-candidates.json）。
//
// 与 slang.json 分开的原因：
// - slang.json 是「已进入学习流程的词条」，候选确认后才是正式词条；
// - 这里是**待管理员确认**的谐音映射，只记录「疑似」关系，不参与提示词注入，
//   也不直接当成新词条——避免自动提取把「飞舞」写成一条独立黑话。
//
// 写入点只有两处：学习器自动登记、首次启动的种子数据。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPinyin, normalizePinyin } from './pinyin-util.js';

export const CANDIDATE_MAX = 500;
const CONTENT_MAX = 50;
const TEXT_MAX = 120;

export function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function clip(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function normalizeCandidate(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const content = clip(item.content, CONTENT_MAX);
  const targetContent = clip(item.targetContent ?? item.target, CONTENT_MAX);
  if (!content || !targetContent) return null;
  const status = ['pending', 'confirmed', 'rejected'].includes(item.status) ? item.status : 'pending';
  const source = ['auto', 'seed', 'manual'].includes(item.source) ? item.source : 'auto';
  const kind = ['homophone', 'near', 'visual', 'abbrev', 'slang'].includes(item.kind) ? item.kind : 'homophone';
  const ids = Array.isArray(item.sourceMessageIds)
    ? [...new Set(item.sourceMessageIds.map((v) => clip(v, 80)).filter(Boolean))].slice(-20)
    : [];
  return {
    id: String(item.id || createId()),
    content,
    pinyin: normalizePinyin(item.pinyin) || getPinyin(content),
    targetId: clip(item.targetId, 80),
    targetContent,
    meaning: clip(item.meaning, TEXT_MAX),
    kind,
    status,
    source,
    occurrences: Math.max(0, Number(item.occurrences) || 0),
    sourceMessageIds: ids,
    createdAt: String(item.createdAt || nowIso()),
    updatedAt: String(item.updatedAt || nowIso()),
  };
}

export function candidateKey(content, targetContent) {
  return `${String(content ?? '').trim().toLowerCase()}→${String(targetContent ?? '').trim().toLowerCase()}`;
}

/** 读取候选表：ENOENT = 空表；读失败/JSON 损坏直接抛错（不覆盖磁盘）。 */
export function loadCandidates(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`谐音候选表读取失败（${error?.code || 'unknown'}）：${error?.message ?? error}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('谐音候选表顶层不是数组');
  return parsed.map(normalizeCandidate).filter(Boolean);
}

export function saveCandidates(file, list, { max = CANDIDATE_MAX } = {}) {
  const entries = (Array.isArray(list) ? list : []).map(normalizeCandidate).filter(Boolean);
  const capped = entries.slice(-Math.max(1, Number(max) || CANDIDATE_MAX));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(capped, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return capped;
}

/**
 * 登记一条候选。同一 `content→targetContent` 只保留一条：
 * 重复出现时累加 occurrences 并合并来源消息 id。
 */
export function addCandidate(list, input = {}) {
  const next = normalizeCandidate(input);
  if (!next) return { list: Array.isArray(list) ? list : [], candidate: null, created: false };
  const entries = (Array.isArray(list) ? list : []).map(normalizeCandidate).filter(Boolean);
  const key = candidateKey(next.content, next.targetContent);
  const existing = entries.find((e) => candidateKey(e.content, e.targetContent) === key);
  if (existing) {
    existing.occurrences = (Number(existing.occurrences) || 0) + Math.max(1, Number(next.occurrences) || 1);
    existing.sourceMessageIds = [...new Set([...(existing.sourceMessageIds || []), ...(next.sourceMessageIds || [])])].slice(-20);
    if (next.meaning && !existing.meaning) existing.meaning = next.meaning;
    existing.updatedAt = nowIso();
    return { list: entries, candidate: existing, created: false };
  }
  entries.push(next);
  return { list: entries.slice(-CANDIDATE_MAX), candidate: next, created: true };
}

/**
 * 种子映射：只写「待确认」，不写 slang.json、不参与提示词。
 * 已存在同 key 的条目（无论来源）不覆盖。
 */
export const SEED_CANDIDATES = Object.freeze([
  { content: '飞舞', targetContent: '废物', meaning: '废物；没用、菜', kind: 'homophone' },
  { content: '彳亍', targetContent: '行', meaning: '行；可以、走（拆字梗，不是同音）', kind: 'visual' },
  { content: '蚌埠住了', targetContent: '绷不住了', meaning: '绷不住了；忍不住笑/崩了', kind: 'homophone' },
  { content: '典', targetContent: '典型', meaning: '典型/典中典；教科书级', kind: 'abbrev' },
  { content: '唐', targetContent: '装唐', meaning: '装唐/装傻；装糊涂', kind: 'slang' },
  { content: '难绷', targetContent: '难受得绷不住', meaning: '难受得绷不住；忍不住', kind: 'abbrev' },
]);

export function seedCandidates(list) {
  let entries = (Array.isArray(list) ? list : []).map(normalizeCandidate).filter(Boolean);
  const keys = new Set(entries.map((e) => candidateKey(e.content, e.targetContent)));
  let added = 0;
  for (const seed of SEED_CANDIDATES) {
    const key = candidateKey(seed.content, seed.targetContent);
    if (keys.has(key)) continue;
    entries = addCandidate(entries, {
      ...seed,
      source: 'seed',
      status: 'pending',
      occurrences: 0,
      sourceMessageIds: [],
    }).list;
    keys.add(key);
    added += 1;
  }
  return { list: entries, added };
}
