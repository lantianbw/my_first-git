// content/memory-render — 把会话记忆（进行中话题 / 想说没说 / 群友印象）渲染成注入提示词的文本
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （optional：无）
// 失败策略：fail-open            （依据：D 表 content/memory「渲染坏了只少一段背景，不影响收发」）
// 单测：tests/memory-render.test.mjs
//
// 为什么搬：这段拼装原本内联在 bridge.js 的 formatMemoryV2 里，混着 Date.now()、排序策略
// 和文案措辞，想单独验一段措辞就得把整个桥跑起来。搬到模块后接缝落在「数据进、文本出」，
// 会话状态与文件读写的调度权仍留在中枢。
//
// 边界：不读 state、不读时钟（now 由调用方注入）、不写文件、不发消息。
// 排序复用同域的 memory-score，不另写一套衰减公式。

import { rank as rankMemories } from './memory-score.js';
import { hasAffection, normalizeAffection, describeAffection } from '../memory/affection-profile.js';

export const spec = Object.freeze({
  name: 'content/memory-render',
  version: '1.0.0',
  deps: Object.freeze(['now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

/** 超过这个时长没被提到的话题，文案上加「已搁置」。 */
const STALE_MS = 2 * 60 * 60 * 1000;

function minutesAgo(now, at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((now - n) / 60000);
}

/**
 * @pure 把一条印象的风险档案（risk.trapHappy / noGoTopics / refusedTitles）拼成印象行末尾的说明。
 * 没有风险信息返回空串；只有旧字段 noKinshipTitle 时退回旧文案，保证老数据渲染不变。
 */
function renderRiskNotes(im) {
  const risk = im && im.risk && typeof im.risk === 'object' ? im.risk : {};
  const notes = [];
  if (risk.trapHappy === true) notes.push('爱下套');
  const noGoTopics = Array.isArray(risk.noGoTopics)
    ? risk.noGoTopics.filter((t) => typeof t === 'string' && t.trim())
    : [];
  if (noGoTopics.length) notes.push(`不能接的话题：${noGoTopics.join('、')}`);
  const refusedTitles = Array.isArray(risk.refusedTitles)
    ? risk.refusedTitles.filter((t) => typeof t === 'string' && t.trim())
    : [];
  if (refusedTitles.length) {
    notes.push(`已拒绝的称呼：${refusedTitles.join('、')}`);
  } else if (im && im.noKinshipTitle === true) {
    notes.push('边界：不叫亲属称呼，用名字或「你」');
  }
  return notes.length ? `（${notes.join('；')}）` : '';
}

/**
 * @pure 把一条印象的好感度（affection.score / affection.tags）拼成印象行末尾的说明。
 * 没写过好感度返回空串（不给没记录的人凭空补「一般」，保证老数据渲染不变）。
 * 档位文案由 memory/affection-profile 决定，本模块只管排版。
 */
function renderAffectionNote(im) {
  if (!hasAffection(im)) return '';
  const { score, tags } = normalizeAffection(im.affection);
  const label = describeAffection(score);
  const tagPart = tags.length ? `；关系标签：${tags.join('、')}` : '';
  return `（好感度 ${score}·${label}${tagPart}）`;
}

/**
 * @pure 渲染会话级记忆块。
 *
 * @param {object} st   会话状态（activeTopics / pendingThoughts / memberImpressions）
 * @param {object} opts
 * @param {number} opts.now            毫秒时间戳（必填，本模块不读系统时钟）
 * @param {object} [opts.limits]       { topicLimit, thoughtLimit, impressionLimit }，缺省各 10
 * @returns {string} 直接拼进提示词的文本；没有任何内容时返回空串
 */
export function renderMemory(st, { now, limits } = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('renderMemory: now 必须是毫秒时间戳（由调用方注入，本模块不读系统时钟）');
  }
  if (!st || typeof st !== 'object') return '';

  const tune = limits ?? {};
  const pickLimit = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.round(value) : fallback);
  const topicLimit = pickLimit(tune.topicLimit, 10);
  const thoughtLimit = pickLimit(tune.thoughtLimit, 10);
  const impressionLimit = pickLimit(tune.impressionLimit, 10);

  const lines = [];

  // 1) 进行中的话题：按「新近 + 反复提及」的衰减分取前 N，只影响排序，不删任何话题。
  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of rankMemories(topics, { now }, topicLimit).map((r) => r.item)) {
      const ago = minutesAgo(now, t.lastMentionAt);
      const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > STALE_MS ? '（已搁置）' : '';
      const pending = t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : '';
      lines.push(`- ${t.text}${stale}（${ago > 0 ? `${ago}分钟前` : '刚刚'}）${pending}`);
    }
  }

  // 2) 想说但还没说的：过期的直接不渲染。
  const thoughts = Array.isArray(st.pendingThoughts)
    ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < Number(t.expiresAt)))
    : [];
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-thoughtLimit)) {
      lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
    }
  }

  // 3) 对群友的印象：取最后 N 个名字，没有 traits 时给「暂无记录」而不是留空。
  //    风险档案（risk.trapHappy / risk.noGoTopics / risk.refusedTitles）追加到印象行末尾，
  //    让模型下次唤醒直接看到「此人爱下套 / 哪些话题不能接 / 哪些称呼已拒绝」，不用重新谈判。
  //    没有 risk.refusedTitles 的老数据退回 noKinshipTitle 的旧文案（兼容 2026-10-29 前落盘的档案）。
  //    好感度（affection.score / affection.tags）排在边界之前：先写「跟这人多熟」，再写「哪些不能碰」，
  //    没写过好感度的老数据不渲染这一段（见 renderAffectionNote）。
  //
  //    —— 10 条上限（impressionLimit，默认 10）说明 ——
  //    注入窗口只有几百字，三类记忆都要挤进去，所以印象只取「最后 N 个名字」。
  //    Object.keys 对字符串键按插入顺序返回，slice(-N) 拿到的是最后写入的 N 个人，
  //    而不是「互动最频繁」或「最近互动」的 N 个人；超过 N 人时最早写入的印象会被挤出。
  //    代价是：被标记边界（如拒称呼）的人若不在最近 N 个里，唤醒提示里就看不到这条边界，
  //    人数多的群尤其要注意（见 docs/trap-hardening-handover.md §7-7）。这是有意的取
  //    舍——宁可少渲染，也不无限撑大提示词。
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('【对群友的印象】');
    for (const name of names.slice(-impressionLimit)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      const count = Number(im.interactionCount) || 0;
      const affection = renderAffectionNote(im);
      const boundary = renderRiskNotes(im);
      lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${count} 次）${affection}${boundary}`);
    }
  }

  return lines.join('\n');
}

/**
 * 契约门面（B.1）。deps 由参数注入，不读 ctx。
 *
 * @param {object} _ctx
 * @param {{ state: object, now: number, limits?: object }} args
 * @returns {{ ok: true, value: string }}
 */
export function handle(_ctx, args) {
  return { ok: true, value: renderMemory(args?.state, { now: args?.now, limits: args?.limits }) };
}
