// A4 反 AI 味词库（只读加载 + 命中检测）。
//
// ⚠️ 交接包 §4.3 写的「复制到 state/anti-ai-patterns.json 即挂载、不用改代码」在仓库里
// 并不成立：全仓没有 anti-ai-patterns 的加载器，bridge 只有一段写死的【反AI味】文案。
// 所以这里补一个最小加载器，默认 **shadow**（只记命中、不改任何出站行为），
// 需要真正拦截时再把 socialV2.antiAi.mode 改成 'enforce'。
//
// 词库来源：_pad/QQ/05-拟人优化/a4-反AI味词库.json（35 条，severity: block/rewrite/hint）。
// 其 regex 按 Python 语法写，唯一不兼容 JS 的是 P16 的内联 (?i) 标志 —— 这里自动剥掉
// 并翻译成 i 标志，其余原样编译。

import fs from 'node:fs';

const SEVERITIES = ['block', 'rewrite', 'hint'];

/**
 * 把 Python 风格的内联标志转成 JS 标志。
 * 只处理开头出现的 (?i)/(?im)/(?is) 这类组合，词库目前只有 (?i) 一种。
 */
function normalizeSource(source) {
  const m = /^\(\?([a-zA-Z]+)\)/.exec(source);
  if (!m) return { source, flags: '' };
  const flags = [...m[1].toLowerCase()].filter((f) => 'ims'.includes(f)).join('');
  return { source: source.slice(m[0].length), flags };
}

/** 读取并编译词库。文件不存在 / 解析失败 → 返回空词库（调用方据此静默降级）。 */
export function loadAntiAiPatterns(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { patterns: [], skipped: [], error: error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error) };
  }
  const list = Array.isArray(raw?.patterns) ? raw.patterns : [];
  const patterns = [];
  const skipped = [];
  const manual = [];   // 不是文本句式、要靠评分器执行的条目
  for (const item of list) {
    if (!item || typeof item.regex !== 'string' || !item.regex.trim()) continue;
    // P35 这类 `.*` 是占位（真规则由评分器 B 维执行），当正则用会命中每一句话，
    // 噪音比信息多 —— 直接跳过。
    if (/^\^?\.\*\$?$/.test(item.regex.trim())) continue;
    const { source, flags } = normalizeSource(item.regex);
    try {
      patterns.push({
        id: String(item.id ?? ''),
        name: String(item.name ?? ''),
        severity: SEVERITIES.includes(item.severity) ? item.severity : 'hint',
        regex: new RegExp(source, flags),
        examples: Array.isArray(item.examples) ? item.examples : []
      });
    } catch (error) {
      // 单条坏正则不该拖垮整份词库，但要留痕（交接包里能查到）。
      skipped.push(`${item.id ?? '?'}: ${error?.message ?? error}`);
    }
  }
  return { patterns, skipped, error: '' };
}

/** 扫一条文本，返回命中的句式（按 block → rewrite → hint 排序，便于日志一眼看出轻重）。 */
export function checkAntiAi(library, text) {
  const body = String(text ?? '');
  if (!body || !library?.patterns?.length) return [];
  const hits = [];
  for (const pattern of library.patterns) {
    const match = pattern.regex.exec(body);
    if (!match) continue;
    hits.push({
      id: pattern.id,
      name: pattern.name,
      severity: pattern.severity,
      match: String(match[0]).slice(0, 40)
    });
  }
  return hits.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

/**
 * 生成注入提示用的简短文，只取 rewrite / hint 里最典型的几条。
 * 不把 35 条全塞进 prompt：那会让注入变长，反而和"省 token"的目标打架。
 */
export function antiAiHintText(library, limit = 8) {
  const picks = (library?.patterns ?? []).filter((p) => p.severity !== 'block').slice(0, Math.max(1, limit));
  if (!picks.length) return '';
  return `【反AI味】避免这些句式：${picks.map((p) => p.name).join('；')}。`;
}

/** 命中摘要，供日志与活动流复用（格式短、可 grep）。 */
export function formatAntiAiHits(hits) {
  if (!hits?.length) return '';
  return hits.map((h) => `${h.id}(${h.severity})`).join('、');
}
