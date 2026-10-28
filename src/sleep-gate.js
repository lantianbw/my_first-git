// 作息门控（B3）：07:30 起床 / 23:30 睡；周五六 01:00 睡；每天 15% 概率熬夜到 01:00。
// 纯函数模块：状态不落盘（熬夜的随机性用「日期种子」做确定性随机，同一天结果稳定，
// 跨进程重启不漂移）。
//
// 语义（本地时区）：
//   正常入睡窗口：23:30 → 次日 07:30
//   周五六（周五晚、周六晚）：01:00 → 07:30
//   熬夜日（其余五天里每天 15% 概率）：01:00 → 07:30
// 「昨晚」的定义：now 在凌晨（00:00~wakeTime）时，入睡决定按前一天的日期算；
// now 在深夜（sleepTime~24:00）时按当天算。

/** 日期种子的确定性 0~99 整数（同一天恒定，不同天不同）。 */
export function dayRandom(dateStr, salt = 'late-night') {
  let h = 2166136261;
  const s = `${salt}:${dateStr}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}

export function parseHm(hm, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? '').trim());
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 24 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

function dateStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 计算 now 时刻的作息状态。
 * cfg: { wakeTime:'07:30', sleepTime:'23:30', weekendSleepTime:'01:00', lateNightProbability:0.15 }
 * 返回 { asleep, reason: 'normal'|'weekend'|'lateNight'|'', wakeAtMin, sleepAtMin, lateNight }
 */
export function computeSleepGate(now, cfg = {}) {
  const wakeAtMin = parseHm(cfg.wakeTime ?? '07:30', 7 * 60 + 30);
  const sleepAtMin = parseHm(cfg.sleepTime ?? '23:30', 23 * 60 + 30);
  const lateAtMin = parseHm(cfg.weekendSleepTime ?? '01:00', 60);
  const lateNightProb = Math.min(1, Math.max(0, Number(cfg.lateNightProbability ?? 0.15)));

  const d = now instanceof Date ? now : new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const dow = d.getDay(); // 0=周日 … 5=周五 6=周六

  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // 凌晨段（00:00 ~ 起床）：看「昨晚」是周几/是否熬夜
  if (minutes < wakeAtMin) {
    const yest = new Date(d.getTime() - 24 * 60 * 60 * 1000);
    const yestDow = yest.getDay();
    const yestLate = dayRandom(dateStrOf(yest)) < lateNightProb * 100;
    const sleptLate = yestDow === 5 || yestDow === 6 || yestLate; // 周五六晚 or 熬夜
    // 昨晚睡得晚（01:00 才睡）：凌晨任何时刻都在睡；昨晚正常 23:30 睡：凌晨也在睡
    return { asleep: true, reason: sleptLate ? (yestDow === 5 || yestDow === 6 ? 'weekend' : 'lateNight') : 'normal',
             wakeAt: fmt(wakeAtMin), sleepAt: sleptLate ? fmt(lateAtMin) : fmt(sleepAtMin), lateNight: yestLate };
  }
  // 白天段（起床 ~ 入睡）：醒着
  if (minutes < sleepAtMin) {
    return { asleep: false, reason: '', wakeAt: fmt(wakeAtMin), sleepAt: fmt(sleepAtMin), lateNight: false };
  }
  // 深夜段（入睡 ~ 24:00）：周五六或熬夜日 → 还能撑到 01:00；否则已睡
  const lateTonight = dow === 5 || dow === 6 || dayRandom(dateStrOf(d)) < lateNightProb * 100;
  return { asleep: !lateTonight, reason: lateTonight ? (dow === 5 || dow === 6 ? 'weekend' : 'lateNight') : 'normal',
           wakeAt: fmt(wakeAtMin), sleepAt: lateTonight ? fmt(lateAtMin) : fmt(sleepAtMin), lateNight: lateTonight && !(dow === 5 || dow === 6) };
}
