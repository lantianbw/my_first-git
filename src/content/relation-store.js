// content/relation-store — 关系线记忆的存取收口（读写注入 + 衰减检索）
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （optional：state → 由 read/write 体现）
// 失败策略：fail-open            （依据：D 表 A.13/A.14「15 个内容模块一律 fail open」）
// 单测：tests/relation-store.test.mjs
//
// 为什么需要：relations.js 只有纯函数（归一化 / 追加 / 格式化），每个调用点都要自己
// 读 state、自己决定注入几条、自己排先后。这里把「读 → 归一化 → 衰减排序 → 截断 →
// 格式化」收成一层，写入口只剩一个 append，排序口径统一复用 memory-score 的 rank。
// 边界：不读时钟（now 注入）、不碰文件（read / write 注入）、不 import bridge、
// 不 console、不删任何记忆——被 limit 挤出的条目只是不进提示词，存储里原样保留。

import { normalizeRelations, appendRelationEntry, formatRelationBlock } from '../relations.js';
import { rank } from './memory-score.js';

export const spec = Object.freeze({
  name: 'content/relation-store',
  version: '1.0.0',
  deps: ['now'],
  optionalDeps: ['state'],
  guards: [],
  toggle: { level: 'free', default: true, hot: true }
});

const DEFAULT_LIMIT = 8;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → 当日 00:00 UTC 毫秒；坏日期给 0（排到最后，但不丢弃）。 */
function dayToMs(date) {
  const match = DAY_RE.exec(String(date ?? ''));
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * 把「按会话 key 分组」的关系线摊平成可打分的条目。
 * - event  → kind='event'，计时基准是日期（只有天粒度）
 * - topic  → kind='months'，计时基准是 lastMentionAt
 * profile（称呼 / 雷点 / 禁忌）没有时间戳，不参与衰减排序，见 formatForPrompt。
 */
function flatten(relations, onlyKey) {
  const out = [];
  for (const [key, entry] of Object.entries(relations)) {
    if (onlyKey && key !== onlyKey) continue;
    for (const event of entry.events) {
      const at = dayToMs(event.date);
      out.push({
        key,
        type: 'event',
        kind: 'event',
        text: event.text,
        date: event.date,
        createdAt: at,
        lastMentionAt: at,
        reviewCount: 0,
        importance: 1
      });
    }
    for (const topic of entry.recentTopics) {
      out.push({
        key,
        type: 'topic',
        kind: 'months',
        text: topic.text,
        createdAt: topic.lastMentionAt,
        lastMentionAt: topic.lastMentionAt,
        reviewCount: 0,
        importance: 1
      });
    }
  }
  return out;
}

export function createRelationStore({ read, write, now } = {}) {
  const canWrite = typeof write === 'function';
  const clock = typeof now === 'function' ? now : () => 0;
  // read 缺省时按「没有任何关系线」处理（fail open）。
  const load = () => normalizeRelations(typeof read === 'function' ? read() : null);

  /**
   * 追加一条关系线。去重语义完全交给 appendRelationEntry：
   * topic 按文本刷新 lastMentionAt，event 按「同一天 + 同文本」去重。
   */
  function append(entry = {}) {
    if (!canWrite) return { ok: false, code: 'DEP_MISSING', error: '未注入 write，关系线只读' };
    const { key, type = 'event', text, date } = entry ?? {};
    const result = appendRelationEntry(load(), key, { type, text, date, now: clock() });
    if (!result.ok) return result;
    write(result.relations);
    return { ok: true, key: result.key, type: result.type };
  }

  /** 规范化后的扁平条目数组；read 返回 null / 坏结构时为空数组，不抛。 */
  function list() {
    return flatten(load());
  }

  /**
   * 按衰减分取前 limit 条，拼成注入文本。
   * opts.key 只取该会话；opts.kind / isOwner 透传给 formatRelationBlock——
   * 私聊块必须显式给 isOwner:true，本模块不猜「谁是主人」。
   */
  function formatForPrompt(limit = DEFAULT_LIMIT, { key, kind, isOwner = false, maxChars } = {}) {
    const relations = load();
    const at = clock();
    const size = Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_LIMIT;
    const top = rank(flatten(relations, key), { now: at }, size);
    if (!top.length) return '';

    const buckets = new Map();
    for (const { item } of top) {
      if (!buckets.has(item.key)) {
        buckets.set(item.key, { profile: relations[item.key].profile, events: [], recentTopics: [] });
      }
      const bucket = buckets.get(item.key);
      if (item.type === 'event') bucket.events.push({ date: item.date, text: item.text });
      else bucket.recentTopics.push({ text: item.text, lastMentionAt: item.lastMentionAt });
    }

    const blocks = [];
    for (const [bucketKey, entry] of buckets) {
      const block = formatRelationBlock({ [bucketKey]: entry }, {
        key: bucketKey,
        kind: kind ?? (bucketKey.startsWith('group:') ? 'group' : 'private'),
        isOwner,
        now: at,
        maxChars
      });
      if (block) blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  return { append, list, formatForPrompt };
}
