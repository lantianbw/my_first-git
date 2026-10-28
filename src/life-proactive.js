// 生活型主动（B4）：起床号 + 刷到好玩的。两类都绕过常规 proactive 的
// 「对方未回不追加 / 每日上限」守卫（那些守卫管的是普通冒泡，不管生活节律），
// 但发送仍走既有的出站守卫与发送限流——只是唤醒配额独立记账。
//
// 纯函数模块；状态文件 state/life-proactive.json 由 bridge 读写：
//   { date: 'YYYY-MM-DD', morningSentAt: 0, discoveryTimes: [ts, ...] }
// 素材文件 state/material-digest.json（C3 的产物）：
//   { date: 'YYYY-MM-DD', items: [{ source, title, angle }] }

import fs from 'node:fs';
import path from 'node:path';
import { computeSleepGate } from './sleep-gate.js';

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadLifeProactiveState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.date !== todayStr()) return { date: todayStr(), morningSentAt: 0, discoveryTimes: [] }; // 跨天重置
    return { date: raw.date, morningSentAt: Number(raw.morningSentAt) || 0, discoveryTimes: Array.isArray(raw.discoveryTimes) ? raw.discoveryTimes : [] };
  } catch {
    return { date: todayStr(), morningSentAt: 0, discoveryTimes: [] };
  }
}

export function saveLifeProactiveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* 写失败下一轮重建 */ }
}

export function loadMaterialDigest(file, { now = new Date() } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.date !== todayStr(now)) return null; // 只用当天素材
    const items = Array.isArray(raw.items) ? raw.items.filter((x) => x && x.title) : [];
    return items.length ? { date: raw.date, items: items.slice(0, 5) } : null;
  } catch {
    return null;
  }
}

/**
 * 起床号：起床时刻 + quietMs 后的 15 分钟检查窗口内，整天没人找过她（lastIncomingAt
 * 早于今天起床时刻）且今天还没发过 → 该戳老爹一句。
 * 返回 true/{} 或 false/{why}。
 */
export function shouldMorningPoke({ now = new Date(), wakeTime = '07:30', quietMs = 30 * 60 * 1000, lastIncomingAt = 0, state }) {
  const [wh, wm] = String(wakeTime).split(':').map(Number);
  const wakeAt = new Date(now); wakeAt.setHours(wh, wm, 0, 0);
  const dueAt = wakeAt.getTime() + quietMs;
  const t = now.getTime();
  if (t < dueAt) return { ok: false, why: 'not-due' };
  if (t > dueAt + 15 * 60 * 1000) return { ok: false, why: 'window-passed' }; // 过窗不补（别在中午发起床号）
  if (Number(state.morningSentAt) > 0 && todayStr(new Date(Number(state.morningSentAt))) === todayStr(now)) {
    return { ok: false, why: 'already-sent' };
  }
  if (lastIncomingAt && lastIncomingAt >= wakeAt.getTime()) return { ok: false, why: 'someone-already-there' };
  return { ok: true };
}

/**
 * 刷到好玩的：当天素材摘要存在、今日次数 < maxPerDay、距上次 ≥ minGapMs、
 * 当前不在睡眠期、群最近 quietGroupMs 内没人正聊（不打断进行中的对话）。
 */
export function shouldDiscoveryShare({ now = new Date(), digest, state, maxPerDay = 2, minGapMs = 4 * 60 * 60 * 1000, groupLastIncomingAt = 0, quietGroupMs = 10 * 60 * 1000, sleepCfg }) {
  if (!digest) return { ok: false, why: 'no-digest' };
  const t = now.getTime();
  const todays = state.discoveryTimes.filter((ts) => todayStr(new Date(Number(ts))) === todayStr(now));
  if (todays.length >= maxPerDay) return { ok: false, why: 'max-per-day' };
  const last = Math.max(0, ...state.discoveryTimes.map(Number));
  if (last && t - last < minGapMs) return { ok: false, why: 'too-soon' };
  if (sleepCfg && computeSleepGate(now, sleepCfg).asleep) return { ok: false, why: 'asleep' };
  if (groupLastIncomingAt && t - Number(groupLastIncomingAt) < quietGroupMs) return { ok: false, why: 'group-busy' };
  return { ok: true };
}
