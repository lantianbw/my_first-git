// A3 生成-评分器（规则版）。
//
// 忠实移植 `_pad/QQ/05-拟人优化/a3-scorer.py` 的判定：六维打分 + 硬门 veto + 复读封顶，
// 词表与阈值逐条对齐（回放 262 条、拦 56 条的结论才有效）。
//
// ⚠️ 当前只接 **shadow**：对**最终要发出的那一条**打分并落日志，不改发不发、不改文本。
// 真正的 best-of-n（1 次调用 n=8 候选、择优、全不合格则沉默/兜底）要改生成调用链，
// 不在本次接线范围 —— 见交付说明里的边界。

export const WEIGHTS = { L: 0.25, R: 0.25, M: 0.15, B: 0.15, X: 0.10, D: 0.10 };
export const DEFAULT_THRESHOLD = 0.60;

export const MEME_WORDS = [
  '罐头', '账', '盗版', '倒水', '打鸣', '匾', '出租车', '记账', '凭证', '定金',
  '公鸡', '背答案', '排队', '工装', '沉默模式', '利息', '月卡', '执照', '祖产',
  '收费站', '押金', '收押', '欠', '债', '抵债'
];
export const MECH_HARD = [
  'token', 'prompt', '提示词', '样本', '部署', '发言号', 'proactive',
  'remaining', 'satisfied', 'qq_', '接口', '参数', '24小时在线', '任务运行中'
];
export const MECH_SOFT_OWNER = ['升级', '工具', '模式', '版本', '自检', '复测'];
export const INSULT_WORDS = ['蠢', '滚', '闭嘴', '贱', '丑八怪', '废物', '智障', '脑残', '死开', '烦不烦'];
const ANSWER_STARTS = ['是', '不', '有', '没', '在', '好', '行', '对', '嗯', '哦', '能', '查', '早', '晚'];
const QUESTION_RE = /[？?]|[嘛吗呢]\s*$|(什么|谁|哪|咋|怎么|多少|几|能不能|是不是|有没有)/;
const PLACEHOLDER_RE = /^\s*(\[表情包[^\]]*\]|\[表情\d+\]|\[图片[^\]]*\]|\[拍一拍[^\]]*\]|\[语音[^\]]*\])\s*$/;

/** 字数口径与 A2 一致：占位标记压成 1 个字，空白不计。 */
export function countChars(text) {
  const t = String(text ?? '').replace(/\[表情包[^\]]*\]|\[表情\d+\]|\[图片[^\]]*\]|\[语音[^\]]*\]|\[卡片[^\]]*\]|\[拍一拍[^\]]*\]/g, '图');
  return [...t.replace(/\s/g, '')].length;
}

export function isPlaceholder(text) {
  return PLACEHOLDER_RE.test(String(text ?? ''));
}

function scoreL(n, isOwner) {
  if (n <= 15) return 1;
  if (n <= 25) return 0.6;
  return isOwner ? 0.6 : 0.2;
}

function scoreR(reply, questionMsg) {
  if (!questionMsg) return 1;
  const q = String(questionMsg.text ?? '');
  if (!QUESTION_RE.test(q)) return 1;
  if (ANSWER_STARTS.some((s) => reply.startsWith(s))) return 1;
  const norm = (s) => s.replace(/[？?。，,.！!@\s]/g, '');
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const q2 = bigrams(norm(q));
  const r2 = bigrams(norm(reply));
  for (const g of r2) if (q2.has(g)) return 1;
  return 0;
}

function scoreM(text, memeUsed24h) {
  const used = MEME_WORDS.filter((w) => text.includes(w) && Number(memeUsed24h?.[w]) > 0);
  if (!used.length) return 1;
  const worst = Math.max(...used.map((w) => Number(memeUsed24h[w])));
  return worst === 1 ? 0.6 : 0;
}

function scoreB(rounds) {
  const n = Number(rounds) || 0;
  if (n >= 6) return 0;
  if (n >= 4) return 0.3;
  return 1;
}

function scoreX(text, isOwner) {
  const low = text.toLowerCase();
  if (MECH_HARD.some((w) => low.includes(w.toLowerCase()))) return { value: 0, veto: true };
  if (MECH_SOFT_OWNER.some((w) => text.includes(w))) return { value: isOwner ? 0.6 : 0.3, veto: false };
  return { value: 1, veto: false };
}

function scoreD(text, targetIsHuman) {
  if (targetIsHuman && INSULT_WORDS.some((w) => text.includes(w))) return { value: 0, veto: true };
  return { value: 1, veto: false };
}

/**
 * 给一条候选打分。
 * ctx: { isOwner, questionMsg, memeUsed24h, botRounds, targetIsHuman }
 * @returns {{text, len, dims, total, pass, veto: string[]}}
 */
export function evaluate(text, ctx = {}, { threshold = DEFAULT_THRESHOLD } = {}) {
  const body = String(text ?? '');
  const isOwner = Boolean(ctx.isOwner);
  const dims = {
    L: scoreL(countChars(body), isOwner),
    R: scoreR(body, ctx.questionMsg),
    M: scoreM(body, ctx.memeUsed24h),
    B: scoreB(ctx.botRounds)
  };
  const x = scoreX(body, isOwner);
  const d = scoreD(body, ctx.targetIsHuman);
  dims.X = x.value;
  dims.D = d.value;
  const veto = [];
  if (x.veto) veto.push('mech');
  if (d.veto) veto.push('insult');
  let total = Object.keys(WEIGHTS).reduce((sum, k) => sum + dims[k] * WEIGHTS[k], 0);
  // 复读封顶：24h 内梗已用 ≥2 次还复读，非 owner 语境封顶 0.5（低于发送线）
  if (dims.M === 0 && !isOwner) total = Math.min(total, 0.5);
  return {
    text: body,
    len: countChars(body),
    dims,
    total: Number(total.toFixed(3)),
    pass: total >= threshold && veto.length === 0,
    veto
  };
}

/** 从若干候选里挑最高分（分数接近时随机，避免总选最长的那条）。 */
export function pickBest(candidates, ctx = {}, { threshold = DEFAULT_THRESHOLD, rng = Math.random } = {}) {
  const scored = (Array.isArray(candidates) ? candidates : [])
    .filter((t) => typeof t === 'string' && t.trim() && !isPlaceholder(t))
    .map((t) => evaluate(t, ctx, { threshold }));
  const passing = scored.filter((c) => c.pass);
  if (!passing.length) return { action: 'silent', scored, best: null, reason: '全部低于发送线或命中硬门' };
  const top = Math.max(...passing.map((c) => c.total));
  const tied = passing.filter((c) => top - c.total < 0.05);
  const best = tied[Math.floor(rng() * tied.length)] ?? tied[0];
  return { action: 'send', scored, best, reason: '' };
}

/** 汇总一行，供日志/活动流使用。 */
export function formatVerdict(verdict) {
  const dims = Object.entries(verdict.dims).map(([k, v]) => `${k}${v}`).join(' ');
  return `total=${verdict.total} pass=${verdict.pass ? 1 : 0} ${dims}${verdict.veto.length ? ` veto=${verdict.veto.join(',')}` : ''}`;
}
