// content/memory-export — 把长期记忆渲染成一份人可读的 markdown 快照
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：now                     （optional：无）
// 失败策略：fail-open            （依据：D 表 content/memory「导出失败只丢可读性，不影响记账与会话」）
// 单测：tests/memory-export.test.mjs
//
// 为什么搬：这段拼装原本内联在 bridge.js 的 /api/socialV2/memory/export 端点里，
// 一半是「读哪些文件」，一半是「怎么排版」。搬到模块后只留排版：数据由中枢读好传进来，
// 接缝落在「数据进、markdown 出」，模块本身不碰 fs，也不认文件路径。
//
// 边界：不读文件、不读时钟（now 由调用方注入）、不写文件、不 import bridge。
// 入参允许缺字段，一律降级成「（暂无）」，绝不让 undefined 漏进输出。

export const spec = Object.freeze({
  name: 'content/memory-export',
  version: '1.0.0',
  deps: Object.freeze(['now']),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间的完整时间戳（与 bridge 的 localStamp 同口径，不用 toISOString 的 UTC）。 */
function clockText(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 只取日期部分；时间戳非法时给「—」。 */
function dayOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const textOf = (value, max) => String(value ?? '').slice(0, max);

/**
 * @pure 渲染记忆快照 markdown。
 *
 * @param {object}   input
 * @param {Date}     [input.now]           导出时间（用于头部标注，缺省用传入值，不读时钟）
 * @param {Array}    [input.profile]       长期事实（profile.json 原始数组）
 * @param {object}   [input.relations]     关系（relations.json 原始对象）
 * @param {Array}    [input.diary]         日记（已 normalized 的数组）
 * @param {object}   [input.moods]         心情（moods.json 原始对象）
 * @param {Array|object} [input.memes]     梗库（数组，或 { items: [] }）
 * @param {string}   [input.sessionKey]    当前会话 key；为空则不渲染会话段
 * @param {string}   [input.sessionMemory] 当前会话层记忆文本（通常来自 content/memory-render）
 * @returns {string}
 */
export function renderMemoryMarkdown({
  now,
  profile = [],
  relations = {},
  diary = [],
  moods = {},
  memes = [],
  sessionKey = '',
  sessionMemory = ''
} = {}) {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(0);
  const out = [];
  out.push('# 小鲸鱼 · 记忆');
  out.push('');
  out.push(`> 导出时间：${clockText(at)} · 只读导出，格式即「记忆外置」的目标形态。`);
  out.push('');

  // 1) 长期事实
  const facts = (Array.isArray(profile) ? profile : [])
    .filter((p) => p && p.text && p.status !== 'deleted');
  out.push('## 关于我 / 长期事实');
  if (!facts.length) out.push('（暂无）');
  for (const f of facts) {
    out.push(`- ${f.text}${f.evidence ? `（证据：${f.evidence}）` : ''}`);
  }
  out.push('');

  // 2) 关系
  const relMap = relations && typeof relations === 'object' ? relations : {};
  const relKeys = Object.keys(relMap);
  out.push('## 关系');
  if (!relKeys.length) out.push('（暂无）');
  for (const k of relKeys) {
    const rel = relMap[k] || {};
    out.push(`### ${k}`);
    const prof = rel.profile && typeof rel.profile === 'object' ? rel.profile : {};
    if (prof['称呼']) out.push(`- 称呼：${prof['称呼']}`);
    if (Array.isArray(prof['雷点']) && prof['雷点'].length) out.push(`- 雷点：${prof['雷点'].join('、')}`);
    if (Array.isArray(prof['禁忌']) && prof['禁忌'].length) out.push(`- 禁忌：${prof['禁忌'].join('、')}`);
    const events = Array.isArray(rel.events) ? rel.events : [];
    if (events.length) {
      out.push('- 事件：');
      for (const ev of events.slice(-10)) {
        out.push(`  - ${ev.date ? `${ev.date} ` : ''}${textOf(ev.text, 200)}`);
      }
    }
    out.push('');
  }

  // 3) 日记：倒序取最近 15 条
  const diaryList = (Array.isArray(diary) ? diary : [])
    .filter((d) => d && d.text && d.status !== 'deleted');
  out.push('## 日记');
  if (!diaryList.length) out.push('（暂无）');
  for (const d of diaryList.slice(-15).reverse()) {
    out.push(`### ${dayOf(d.createdAt)}`);
    out.push(String(d.text));
    if (d.mood) out.push(`- 感受：${d.mood}`);
    if (d.unsaid) out.push(`- 没说出口：${d.unsaid}`);
    out.push('');
  }

  // 4) 心情
  const moodMap = moods && typeof moods === 'object' ? moods : {};
  out.push('## 心情');
  const base = moodMap.baseMood;
  if (base && base.word) {
    out.push(`- 底色：${base.word}${base.reason ? `（${base.reason}）` : ''}`);
  }
  const notes = Array.isArray(moodMap.handnotes) ? moodMap.handnotes : [];
  for (const n of notes.slice(-5)) {
    out.push(`- 手记：${n?.text ?? ''}${n?.tag ? `（${n.tag}）` : ''}`);
  }
  if (!(base && base.word) && !notes.length) out.push('（暂无）');
  out.push('');

  // 5) 梗库：兼容「字符串数组」与「对象数组」两种历史写法
  const memeList = Array.isArray(memes) ? memes : (Array.isArray(memes?.items) ? memes.items : []);
  out.push('## 梗库');
  if (!memeList.length) out.push('（暂无）');
  for (const m of memeList.slice(-20)) {
    const text = typeof m === 'string' ? m : (m?.text ?? m?.name ?? '');
    if (text) out.push(`- ${text}`);
  }
  out.push('');

  // 6) 当前会话层记忆
  if (sessionKey) {
    out.push(`## 当前会话 ${sessionKey}`);
    out.push(sessionMemory || '（会话层记忆为空）');
    out.push('');
  }

  return out.join('\n');
}

/**
 * 契约门面（B.1）。deps 由参数注入，不读 ctx。
 *
 * @param {object} _ctx
 * @param {object} args 同 renderMemoryMarkdown
 * @returns {{ ok: true, value: string }}
 */
export function handle(_ctx, args) {
  return { ok: true, value: renderMemoryMarkdown(args ?? {}) };
}
