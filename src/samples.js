// 对话样本导出：按固定时刻把二代会话的 recentMessages 落成 Markdown 文件。
//
// 纯逻辑在此（格式化/幂等判断/清理），文件读写与定时器在 bridge.js。
// 设计约束：
// - 幂等：同一天同一时段只导一次（state/samples-last.json 记录 runs[date] = ["0355"]）；
// - 补跑：bridge 在时段当时不在线（看门狗重启、凌晨宕机）时，时段后 catchupMinutes
//   分钟内上线仍会导出 —— 2026-10-24 当天 03:55 的样本就因为 00:47–07:37 不在线而缺失；
// - 只保留最近 keepDays 个日期（按文件名里的日期分组）；
// - 单行截断 maxCharsPerLine，isSelf 显示为「我」。

export const SAMPLE_DEFAULTS = Object.freeze({
  enabled: true,
  dir: '',
  times: ['03:55', '11:50'],
  keepDays: 14,
  maxCharsPerLine: 120,
  catchupMinutes: 120
});

const pad2 = (n) => String(n).padStart(2, '0');

const int = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const str = (value) => String(value ?? '').trim();

/** socialV2.samples 归一化；times 只接受 HH:mm。 */
export function normalizeSamplesConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const times = (Array.isArray(src.times) ? src.times : SAMPLE_DEFAULTS.times)
    .map((value) => str(value))
    .filter((value) => /^\d{2}:\d{2}$/.test(value))
    .slice(0, 12);
  return {
    enabled: src.enabled !== false,
    dir: str(src.dir),
    times: times.length ? times : [...SAMPLE_DEFAULTS.times],
    keepDays: int(src.keepDays, SAMPLE_DEFAULTS.keepDays, 1, 365),
    maxCharsPerLine: int(src.maxCharsPerLine, SAMPLE_DEFAULTS.maxCharsPerLine, 20, 2000),
    catchupMinutes: int(src.catchupMinutes, SAMPLE_DEFAULTS.catchupMinutes, 0, 720)
  };
}

export function sampleDateKey(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function formatClock(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const date = new Date(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function clipLine(text, max) {
  const value = str(text).replace(/[\s\u00a0\u3000]+/g, ' ');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 生成 Markdown：
 *   # 对话样本 YYYY-MM-DD
 *   ## key
 *   HH:mm 发送者：正文
 */
export function formatSamplesMarkdown(conversations, { date, maxCharsPerLine = 120 } = {}) {
  const src = conversations && typeof conversations === 'object' && !Array.isArray(conversations) ? conversations : {};
  const blocks = [];
  for (const key of Object.keys(src).sort()) {
    const messages = Array.isArray(src[key]?.recentMessages) ? src[key].recentMessages : [];
    if (!messages.length) continue;
    const lines = messages.map((message) => {
      const sender = message?.isSelf ? '我' : (str(message?.sender) || '未知');
      const text = clipLine(message?.text ?? message?.plain ?? '', maxCharsPerLine);
      return `${formatClock(message?.time)} ${sender}：${text}`;
    });
    blocks.push(`## ${key}\n\n${lines.join('\n')}`);
  }
  if (!blocks.length) return '';
  return `# 对话样本 ${str(date)}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * 已到期的时段（HH:mm），按当天时间先后排序：
 * 精确命中（时钟等于时段）或落在「时段 + catchupMinutes」的补跑窗口内都算到期。
 * 补跑只认同一天内：跨午夜的窗口不补 —— runSampleExport 按当前日期命名并写入
 * 当前会话内容，昨晚的时段补到今天会把日期张冠李戴。
 */
export function dueSampleSlots(times, now = new Date(), catchupMinutes = 0) {
  const window = Math.max(0, Math.round(Number(catchupMinutes) || 0));
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const due = [];
  for (const value of Array.isArray(times) ? times : []) {
    const matched = /^(\d{2}):(\d{2})$/.exec(str(value));
    if (!matched) continue;
    const slotMin = Number(matched[1]) * 60 + Number(matched[2]);
    const exact = nowMin === slotMin;
    if (exact || (window > 0 && nowMin > slotMin && nowMin - slotMin <= window)) {
      due.push({ slot: `${matched[1]}:${matched[2]}`, slotMin, exact });
    }
  }
  due.sort((a, b) => a.slotMin - b.slotMin || (a.exact ? -1 : 1));
  return due.map((item) => item.slot);
}

/** 当前时刻命中的时段（HH:mm），没命中返回空串。 */
export function sampleSlotNow(times, now = new Date(), catchupMinutes = 0) {
  const slots = dueSampleSlots(times, now, catchupMinutes);
  return slots.length ? slots[0] : '';
}

/** 幂等判断：当天已到期的时段里第一个还没跑过的；有补跑窗口时优先补最早缺的时段。 */
export function shouldRunSample(times, runs, now = new Date(), catchupMinutes = 0) {
  const date = sampleDateKey(now);
  const done = Array.isArray(runs?.[date]) ? runs[date] : [];
  for (const slot of dueSampleSlots(times, now, catchupMinutes)) {
    if (!done.includes(slot.replace(':', ''))) return slot;
  }
  return '';
}

/** 记录一次执行（返回新的 runs 对象）。 */
export function markSampleRun(runs, date, slot) {
  const src = runs && typeof runs === 'object' && !Array.isArray(runs) ? runs : {};
  const key = String(slot ?? '').replace(':', '');
  const existing = Array.isArray(src[date]) ? src[date] : [];
  return {
    ...src,
    [date]: [...new Set([...existing, key])].slice(-12)
  };
}

/** 按文件名日期分组，返回需要删除的文件名（只保留最近 keepDays 个日期）。 */
export function pruneSampleFiles(names, { keepDays = 14 } = {}) {
  const byDate = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    const matched = /^(\d{4}-\d{2}-\d{2})_(\d{4})\.md$/.exec(String(name ?? ''));
    if (!matched) continue;
    const list = byDate.get(matched[1]) ?? [];
    list.push(String(name));
    byDate.set(matched[1], list);
  }
  const dates = [...byDate.keys()].sort();
  const keep = new Set(dates.slice(-Math.max(1, Number(keepDays) || 14)));
  const remove = [];
  for (const [date, list] of byDate) {
    if (keep.has(date)) continue;
    remove.push(...list);
  }
  return remove;
}
