// 好友申请处理（OneBot post_type=request / request_type=friend）。
//
// 分工：
//   · 本模块只放纯函数 + 一个写 config 的落盘函数，方便离线单测；
//   · 订阅事件、调 set_friend_add_request、给 owner 发通知都在 bridge.js 里接线。
//
// 语义：
//   · 命中 config.friendRequest.whitelist 的预设名单 → 自动同意，并把 QQ 补进 allow.private；
//   · 名单外 → 只通知 owner，绝不自动同意。

import fs from 'node:fs';

/**
 * 规范化预设名单。接受三种写法：
 *   [{ qq: 2453753245, name: '風花雪月' }] / [2453753245] / ['2453753245']
 * 非法项与重复 QQ 直接丢弃（fail-closed：宁可不认，也不乱认）。
 */
export function normalizeFriendWhitelist(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    let qq = '';
    let name = '';
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      qq = String(item.qq ?? item.user_id ?? '').trim();
      name = String(item.name ?? item.nickname ?? '').trim();
    } else {
      qq = String(item ?? '').trim();
    }
    if (!/^\d+$/.test(qq) || seen.has(qq)) continue;
    seen.add(qq);
    out.push({ qq, name });
  }
  return out;
}

/** 在预设名单里按 QQ 找人；找不到返回 null。 */
export function findFriendWhitelistEntry(whitelist, qq) {
  const id = String(qq ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  const list = Array.isArray(whitelist) ? whitelist : [];
  return list.find((entry) => String(entry?.qq ?? '') === id) ?? null;
}

/**
 * 把 QQ 补进 config.json 的 allow.private。
 * 只动 allow.private 这一个字段，其余配置原样保留；已存在时不写文件（幂等）。
 * 返回 { updated, added, list }。
 */
export function persistAllowPrivate(cfgPath, qq) {
  const id = String(qq ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`QQ 号不合法：${qq}`);
  let text = fs.readFileSync(cfgPath, 'utf8');
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  if (!cfg.allow || typeof cfg.allow !== 'object' || Array.isArray(cfg.allow)) cfg.allow = {};
  // 兼容旧配置里的 allow.privates 别名：已有哪个数组就接着用哪个。
  const key = Array.isArray(cfg.allow.private) ? 'private'
    : (Array.isArray(cfg.allow.privates) ? 'privates' : 'private');
  if (!Array.isArray(cfg.allow[key])) cfg.allow[key] = [];
  const list = cfg.allow[key];
  const existing = list.map((v) => String(v));
  if (existing.includes(id)) return { updated: false, added: false, list: existing };
  // 现有 config 用数字存 QQ；能安全转数字就转，保持文件风格一致。
  const n = Number(id);
  list.push(Number.isSafeInteger(n) && n > 0 ? n : id);
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, added: true, list: list.map((v) => String(v)) };
}

/** 验证消息只留一行，避免把换行带进 owner 通知。 */
export function cleanRequestComment(value, maxChars = 60) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/**
 * 给 owner 的通知文案。
 *   approved=true  → "風花雪月（2453753245）加我好友，已通过"
 *   approved=false → "2453753245 加我好友（验证消息：xxx），不在预设名单，未自动通过"
 *   error 非空     → 同意失败时如实把原因带给 owner
 */
export function buildFriendRequestNotice({ approved = false, qq, name = '', comment = '', error = '' } = {}) {
  const label = name ? `${name}（${qq}）` : String(qq ?? '');
  // 带名字时「（QQ）加我好友」连写更顺；只有纯号码时留一个空格，免得数字和汉字糊在一起。
  const sep = name ? '' : ' ';
  if (approved) return `${label}${sep}加我好友，已通过`;
  if (error) return `${label}${sep}加我好友，自动通过失败：${error}`;
  const note = cleanRequestComment(comment);
  return `${label}${sep}加我好友${note ? `（验证消息：${note}）` : ''}，不在预设名单，未自动通过`;
}
