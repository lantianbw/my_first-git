// 拼音工具：无声调全拼、内存缓存、同音匹配。
//
// 用途：
// - 黑话/梗库给每条词条补 `pinyin`，用于「谐音梗」检索；
// - 查询走「先精确/子串，再同音」两段式：全拼完全相等优先，其次编辑距离 ≤1。
//
// 缓存只放内存：pinyin-pro 的转换是纯计算，进程重启后按需重建即可，
// 不落盘，避免把派生数据写进 slang.json / memes.json 之外的缓存文件。

import { pinyin } from 'pinyin-pro';

const CACHE_LIMIT = 5000;
const cache = new Map();

/** 只保留 a-z：去掉声调、空格、数字和标点。 */
export function normalizePinyin(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** 取无声调全拼（如「飞舞」→ feiwu），带进程内缓存。 */
export function getPinyin(text) {
  const key = String(text ?? '').trim();
  if (!key) return '';
  if (cache.has(key)) return cache.get(key);
  let result = '';
  try {
    result = normalizePinyin(pinyin(key, { toneType: 'none', type: 'array' }).join(''));
  } catch {
    result = '';
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

/** 编辑距离（只算插入/删除/替换），超过 max 时提前返回 max+1。 */
export function editDistance(a, b, max = Infinity) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

/** 两个拼音串是否「同音或近音」（完全相等，或编辑距离 ≤1）。 */
export function isPinyinNear(a, b) {
  const x = normalizePinyin(a);
  const y = normalizePinyin(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  return editDistance(x, y, 1) <= 1;
}

function namesOfItem(item) {
  if (!item || typeof item !== 'object') return [];
  const names = [item.content ?? item.text ?? ''];
  if (Array.isArray(item.variants)) names.push(...item.variants);
  return names.map((n) => String(n ?? '').trim()).filter(Boolean);
}

/**
 * 在候选条目里找谐音命中。
 *
 * 两轮：先找全拼完全相同（含 variants），再找编辑距离 ≤1。
 * 返回 `{ item, matched, pinyin, exact, distance }`，没有命中返回 null。
 */
export function findHomophone(query, items, { namesOf = namesOfItem } = {}) {
  const qp = getPinyin(query);
  if (!qp) return null;
  const list = Array.isArray(items) ? items : [];
  let near = null;
  for (const item of list) {
    for (const name of namesOf(item)) {
      const p = getPinyin(name);
      if (!p) continue;
      if (p === qp) {
        return { item, matched: name, pinyin: p, exact: true, distance: 0 };
      }
      if (!near && Math.abs(p.length - qp.length) <= 1 && editDistance(p, qp, 1) <= 1) {
        near = { item, matched: name, pinyin: p, exact: false, distance: 1 };
      }
    }
  }
  return near;
}
