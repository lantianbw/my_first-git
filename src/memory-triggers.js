// 记忆写入触发点（B5）：睡前日记 / 承诺即记 / 被纠正即记 / 周日归拢 / 漏写提醒。
// 纯函数模块：只做「该不该触发」的判定与文本信号检测；由 bridge 注入 wake prompt
// 或定时唤醒。日记/待办的真正写入仍由 agent 调 qq_diary / qq_memo 完成——
// 桥接不代写内容（那会变成程序编日记），只保证「到点必被提醒」。
//
// 状态文件 state/memory-triggers.json：
//   { date: 'YYYY-MM-DD', diarySettleAt: 0, weeklyDigestWeek: '' }

import fs from 'node:fs';
import path from 'node:path';

/** 约定/承诺信号：时间锚 + 承诺动词（窗口放宽到 20 字），或明确的日期锚/成交词。 */
const COMMITMENT_RE = /(明天|后天|下次|待会|今晚|晚上|下午|上午|中午|周末|周日|周六|周五|下(周|月)|\d{1,2}[点:：]).{0,20}(见|给|发|送|喊|叫|做|弄|完|回|带|试|测|聊|催|兑|请|开|打|叫)|(\d{1,2}[号日])|(说好|约好|答应|一言为定|说定了|记得|别忘了|别忘|一言为定)/;
/** 纠正信号：优先 owner/熟人，且语气是「指出错误」而非闲聊。 */
const CORRECTION_RE = /(不是跟你说过|我说过多少次|你记错|认错|搞错|看错了|乱认|又错|跟你说了|你记住|下次别再|不许再|别再把|谁是|这是谁|那是你|这是你)/;

export function detectCommitment(text) {
  return COMMITMENT_RE.test(String(text ?? ''));
}

export function detectCorrection(text) {
  return CORRECTION_RE.test(String(text ?? ''));
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayOf(ts) {
  return todayStr(new Date(Number(ts)));
}

/** 漏写提醒：昨天一整天没有新日记（diary 条目的 createdAt 落在昨天）。 */
export function diaryNeedsBackfill(diary, now = new Date()) {
  const yest = todayStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const list = Array.isArray(diary) ? diary : [];
  return !list.some((e) => Number(e?.createdAt) && dayOf(e.createdAt) === yest);
}

/** 睡前日记：now 落在「入睡时刻前后 20 分钟」窗口且今天还没触发过。 */
export function shouldDiarySettle({ now = new Date(), sleepTime = '23:30', lateTime = '01:00', state }) {
  const [sh, sm] = String(sleepTime).split(':').map(Number);
  const [lh, lm] = String(lateTime).split(':').map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const sleepMin = sh * 60 + sm;
  const lateMin = lh * 60 + lm;
  // 周五六/熬夜晚睡的日子，日记窗也跟着挪到 00:50（lateTime 前 10 分钟）。
  const dowYesterday = now.getDay();
  const windowStart = sleepMin - 10;
  const windowEnd = sleepMin + 10;
  const inWindow = minutes >= windowStart && minutes <= windowEnd;
  const lateWindow = minutes >= lateMin - 70 && minutes <= lateMin - 50; // 23:50~00:10
  if (state?.date === todayStr(now) && Number(state?.diarySettleAt) > 0) return { ok: false, why: 'done-today' };
  if (inWindow) return { ok: true, late: false };
  if (lateWindow && dowYesterday >= 0) return { ok: true, late: true }; // 晚睡日补位窗口
  return { ok: false, why: 'not-in-window' };
}

/** 周日归拢：周日 21:00~21:30，且本周（ISO 周）未做过。 */
export function shouldWeeklyDigest({ now = new Date(), state }) {
  if (now.getDay() !== 0) return { ok: false, why: 'not-sunday' };
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 21 * 60 || minutes > 21 * 60 + 30) return { ok: false, why: 'not-in-window' };
  const week = isoWeek(now);
  if (state?.weeklyDigestWeek === week) return { ok: false, why: 'done-this-week' };
  return { ok: true, week };
}

export function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

export function loadMemoryTriggerState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { date: raw.date ?? '', diarySettleAt: Number(raw.diarySettleAt) || 0, weeklyDigestWeek: raw.weeklyDigestWeek ?? '' };
  } catch {
    return { date: '', diarySettleAt: 0, weeklyDigestWeek: '' };
  }
}

export function saveMemoryTriggerState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* 下一轮重建 */ }
}
