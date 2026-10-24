// QQ 生态工具（群资料 / 群名片 / 点赞 / 撤回 / 正在输入 / 表情回应）的纯逻辑层。
//
// 这里只放**可单测、无副作用**的东西：
// - 配置默认值与归一化（限额 / 列表条数上限）
// - state/eco-actions.json 的形状归一化与「按天/按小时窗口」的配额计算
// - OneBot 原始返回 → 给模型看的紧凑结构（截断文本、裁剪条数）
//
// 所有真正发请求/N 落盘的逻辑都在 src/bridge.js（需要 agent token、白名单、审计）。
import { truncateText } from './md-to-plain.js';

// ── 默认限额 ────────────────────────────────────────────────────────────────
// 数值来自 task-3 的硬要求（点赞每人每天 ≤3、总量每天 ≤20；群名片每小时 ≤2），
// 其余是「防刷屏」的经验值：表情回应/正在输入都是高频小动作，宁可保守。
export const ECO_DEFAULTS = Object.freeze({
  limits: {
    sendLike: { perUserPerDay: 3, totalPerDay: 20 },
    setGroupCard: { perHour: 2 },
    deleteMessage: { perHour: 5 },
    msgReaction: { perMinute: 6, perHour: 30 },
    inputStatus: { perMinute: 10 }
  },
  maxItems: {
    groupMembers: 100,
    groupFiles: 30,
    groupNotices: 5,
    groupHonors: 10,
    essenceList: 20
  }
});

const int = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** 把用户手改过的 socialV2.eco 收敛到安全区间（config.json 是用户可编辑的）。 */
export function normalizeEcoConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const limits = src.limits && typeof src.limits === 'object' ? src.limits : {};
  const maxItems = src.maxItems && typeof src.maxItems === 'object' ? src.maxItems : {};
  return {
    limits: {
      sendLike: {
        perUserPerDay: int(limits.sendLike?.perUserPerDay, ECO_DEFAULTS.limits.sendLike.perUserPerDay, 0, 10),
        totalPerDay: int(limits.sendLike?.totalPerDay, ECO_DEFAULTS.limits.sendLike.totalPerDay, 0, 50)
      },
      setGroupCard: {
        perHour: int(limits.setGroupCard?.perHour, ECO_DEFAULTS.limits.setGroupCard.perHour, 0, 10)
      },
      deleteMessage: {
        perHour: int(limits.deleteMessage?.perHour, ECO_DEFAULTS.limits.deleteMessage.perHour, 0, 30)
      },
      msgReaction: {
        perMinute: int(limits.msgReaction?.perMinute, ECO_DEFAULTS.limits.msgReaction.perMinute, 0, 30),
        perHour: int(limits.msgReaction?.perHour, ECO_DEFAULTS.limits.msgReaction.perHour, 0, 200)
      },
      inputStatus: {
        perMinute: int(limits.inputStatus?.perMinute, ECO_DEFAULTS.limits.inputStatus.perMinute, 0, 60)
      }
    },
    maxItems: {
      groupMembers: int(maxItems.groupMembers, ECO_DEFAULTS.maxItems.groupMembers, 1, 300),
      groupFiles: int(maxItems.groupFiles, ECO_DEFAULTS.maxItems.groupFiles, 1, 100),
      groupNotices: int(maxItems.groupNotices, ECO_DEFAULTS.maxItems.groupNotices, 1, 20),
      groupHonors: int(maxItems.groupHonors, ECO_DEFAULTS.maxItems.groupHonors, 1, 50),
      essenceList: int(maxItems.essenceList, ECO_DEFAULTS.maxItems.essenceList, 1, 50)
    }
  };
}

// ── state/eco-actions.json 形状 ─────────────────────────────────────────────
const BUCKETS = ['card', 'deleteMessage', 'msgReactionMinute', 'msgReactionHour', 'inputStatus'];
const MAX_TIMES = 500;
// 合并转发的冷却记录按会话分开存，最多保留 50 个会话，避免 state 文件无限膨胀。
const MAX_FORWARD_SESSIONS = 50;

function normalizeTimes(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0)
    .slice(-MAX_TIMES);
}

function normalizeForwardSessions(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, list] of Object.entries(value)) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    const times = normalizeTimes(list).slice(-50);
    if (times.length) out[key] = times;
    if (Object.keys(out).length >= MAX_FORWARD_SESSIONS) break;
  }
  return out;
}

/** 读取时归一化：允许缺字段/旧版本文件，绝不因为一个怪字段整库作废。 */
export function normalizeEcoActions(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const likes = src.likes && typeof src.likes === 'object' ? src.likes : {};
  const users = {};
  if (likes.users && typeof likes.users === 'object' && !Array.isArray(likes.users)) {
    for (const [id, count] of Object.entries(likes.users)) {
      if (!/^\d+$/.test(String(id))) continue;
      const n = int(count, 0, 0, 1000);
      if (n > 0) users[String(id)] = n;
    }
  }
  const times = {};
  for (const bucket of BUCKETS) times[bucket] = normalizeTimes(src.times?.[bucket]);
  return {
    likes: {
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(likes.date ?? '')) ? String(likes.date) : '',
      total: int(likes.total, 0, 0, 100000),
      users
    },
    times,
    // 合并转发：sessions 是各会话最近发送时间（冷却 5 分钟），approvalTimes 是审批通过时间（每小时限额）。
    forwards: {
      sessions: normalizeForwardSessions(src.forwards?.sessions),
      approvalTimes: normalizeTimes(src.forwards?.approvalTimes)
    }
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的「今天」（YYYY-MM-DD）。日限额按本机日期翻页，不用 UTC。 */
export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 名片点赞配额：每人每天上限 + 全账号每天总量上限。
 * 返回 granted=0 时 reason 说明是哪个上限挡住了。
 */
export function takeLikeQuota(state, userId, requested, limits, now = Date.now()) {
  const safe = normalizeEcoActions(state);
  const day = dayKey(now);
  const likes = safe.likes.date === day
    ? { date: day, total: safe.likes.total, users: { ...safe.likes.users } }
    : { date: day, total: 0, users: {} };
  const uid = String(userId);
  const perUser = int(limits?.sendLike?.perUserPerDay, ECO_DEFAULTS.limits.sendLike.perUserPerDay, 0, 10);
  const totalLimit = int(limits?.sendLike?.totalPerDay, ECO_DEFAULTS.limits.sendLike.totalPerDay, 0, 50);
  const userUsed = int(likes.users[uid], 0, 0, 1000);
  const want = int(requested, 1, 1, 10);
  const remainUser = Math.max(0, perUser - userUsed);
  const remainTotal = Math.max(0, totalLimit - likes.total);
  const granted = Math.min(want, remainUser, remainTotal);
  if (granted <= 0) {
    const reason = remainTotal <= 0
      ? `今天全账号点赞总量已达上限（${totalLimit} 次），明天再点`
      : `今天给这个人点的赞已达上限（每人每天 ${perUser} 次），别刷`;
    return { granted: 0, state: safe, reason, userUsed, totalUsed: likes.total };
  }
  likes.total += granted;
  likes.users[uid] = userUsed + granted;
  return {
    granted,
    state: { ...safe, likes },
    reason: '',
    userUsed: likes.users[uid],
    totalUsed: likes.total,
    remainUser: Math.max(0, perUser - likes.users[uid]),
    remainTotal: Math.max(0, totalLimit - likes.total)
  };
}

/**
 * 滑动窗口配额（群名片/撤回/表情回应/正在输入共用）。
 * @returns {{allowed:boolean, retryAfterMs:number, state:object, used:number}}
 */
export function takeWindowQuota(state, bucket, limit, windowMs, now = Date.now()) {
  const safe = normalizeEcoActions(state);
  const max = int(limit, 0, 0, 10000);
  const window = Math.max(1000, Number(windowMs) || 60000);
  if (max <= 0) return { allowed: false, retryAfterMs: 0, state: safe, used: 0, reason: '该动作已被限额配置关闭（上限 0）' };
  const list = safe.times[bucket] || [];
  const fresh = list.filter((t) => now - t < window && t <= now + 60000);
  if (fresh.length >= max) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, window - (now - fresh[0])),
      state: { ...safe, times: { ...safe.times, [bucket]: fresh } },
      used: fresh.length,
      reason: `太频繁了：该动作 ${Math.round(window / 60000)} 分钟内上限 ${max} 次，约 ${Math.ceil(Math.max(0, window - (now - fresh[0])) / 1000)} 秒后再试`
    };
  }
  const next = [...fresh, now].slice(-MAX_TIMES);
  return { allowed: true, retryAfterMs: 0, state: { ...safe, times: { ...safe.times, [bucket]: next } }, used: fresh.length + 1 };
}

// ── OneBot 返回 → 给模型看的紧凑结构 ────────────────────────────────────────
const clip = (value, max = 120) => truncateText(String(value ?? '').replace(/[\s\u00a0\u3000]+/g, ' ').trim(), max);

export function compactGroupInfo(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  return {
    groupId: String(g.group_id ?? ''),
    name: clip(g.group_name, 60),
    remark: clip(g.group_remark, 60),
    memberCount: Number(g.member_count) || 0,
    maxMemberCount: Number(g.max_member_count) || 0,
    createTime: Number(g.group_create_time) || 0,
    level: Number(g.group_level) || 0,
    memo: clip(g.group_memo, 200),
    description: clip(g.group_description, 300),
    allShut: Number(g.group_all_shut) || 0
  };
}

export function compactGroupMember(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    userId: String(m.user_id ?? ''),
    nickname: clip(m.nickname, 40),
    card: clip(m.card, 40),
    role: String(m.role ?? ''),
    level: String(m.level ?? ''),
    qqLevel: Number(m.qq_level) || 0,
    joinTime: Number(m.join_time) || 0,
    lastSentTime: Number(m.last_sent_time) || 0
  };
}

/** 群成员列表：支持按昵称/群名片/QQ 号过滤，再按上限截断。 */
export function compactGroupMembers(list, { limit = 100, query = '' } = {}) {
  const all = (Array.isArray(list) ? list : []).map(compactGroupMember);
  const q = String(query ?? '').trim().toLowerCase();
  const matched = q
    ? all.filter((m) => [m.userId, m.nickname, m.card].join(' ').toLowerCase().includes(q))
    : all;
  const max = Math.max(1, Math.min(300, Number(limit) || 100));
  return {
    total: all.length,
    matched: matched.length,
    truncated: matched.length > max,
    members: matched.slice(0, max)
  };
}

/** 群公告：兼容 {publish_time, sender_id, message:{text,images}} 与扁平结构。 */
export function compactGroupNotice(raw) {
  const n = raw && typeof raw === 'object' ? raw : {};
  const msg = n.message && typeof n.message === 'object' ? n.message : {};
  const text = clip(msg.text ?? n.text ?? n.content ?? '', 400);
  const images = Array.isArray(msg.images) ? msg.images : (Array.isArray(n.images) ? n.images : []);
  return {
    noticeId: clip(n.notice_id ?? n.fid ?? n.id ?? '', 60),
    senderId: String(n.sender_id ?? n.sender ?? ''),
    publishTime: Number(n.publish_time ?? n.time ?? 0) || 0,
    text,
    imageCount: images.length
  };
}

export function compactGroupNotices(list, limit = 5) {
  const all = (Array.isArray(list) ? list : []).map(compactGroupNotice);
  const max = Math.max(1, Math.min(20, Number(limit) || 5));
  return { total: all.length, truncated: all.length > max, notices: all.slice(0, max) };
}

const HONOR_TYPES = [
  ['currentTalkative', 'current_talkative'],
  ['talkative', 'talkative_list'],
  ['performer', 'performer_list'],
  ['legend', 'legend_list'],
  ['emotion', 'emotion_list'],
  ['strongNewbie', 'strong_newbie_list']
];

export function compactGroupHonor(raw, limit = 10) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const max = Math.max(1, Math.min(50, Number(limit) || 10));
  const one = (item) => (item && typeof item === 'object'
    ? { userId: String(item.user_id ?? item.uin ?? ''), nickname: clip(item.nickname ?? item.name ?? '', 40), description: clip(item.description ?? '', 80) }
    : null);
  const out = { groupId: String(g.group_id ?? '') };
  for (const [key, field] of HONOR_TYPES) {
    const value = g[field];
    if (Array.isArray(value)) {
      const items = value.map(one).filter(Boolean);
      out[key] = { total: items.length, items: items.slice(0, max) };
    } else if (value && typeof value === 'object') {
      out[key] = { total: 1, items: [one(value)].filter(Boolean) };
    } else {
      out[key] = { total: 0, items: [] };
    }
  }
  return out;
}

export function compactGroupFile(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    fileId: clip(f.file_id, 80),
    name: clip(f.file_name, 80),
    busid: Number(f.busid) || 0,
    size: Number(f.file_size) || 0,
    uploadTime: Number(f.upload_time) || 0,
    uploader: String(f.uploader ?? ''),
    uploaderName: clip(f.uploader_name ?? '', 40),
    downloadTimes: Number(f.download_times) || 0
  };
}

export function compactGroupFiles(raw, { limit = 30 } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const files = (Array.isArray(data.files) ? data.files : []).map(compactGroupFile);
  const folders = (Array.isArray(data.folders) ? data.folders : []).map((f) => ({
    folderId: clip(f?.folder_id ?? f?.folderId ?? '', 80),
    name: clip(f?.folder_name ?? f?.name ?? '', 80),
    totalFileCount: Number(f?.total_file_count ?? f?.totalFileCount ?? 0) || 0,
    createTime: Number(f?.create_time ?? 0) || 0
  }));
  const max = Math.max(1, Math.min(100, Number(limit) || 30));
  return {
    total: files.length,
    truncated: files.length > max,
    files: files.slice(0, max),
    folders: folders.slice(0, max)
  };
}

/** 群精华消息：SnowLuma 返回可能带 message 段或扁平预览字段，这里统一兜底。 */
export function compactEssenceItem(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const msg = e.message && typeof e.message === 'object' ? e.message : null;
  const textFromMessage = Array.isArray(msg)
    ? msg.map((seg) => (seg && typeof seg === 'object' ? (seg.data?.text ?? seg.text ?? '') : '')).join(' ')
    : String(msg?.text ?? '');
  return {
    messageId: String(e.message_id ?? e.msg_id ?? e.msgId ?? ''),
    messageSeq: String(e.message_seq ?? e.msg_seq ?? ''),
    senderId: String(e.sender_id ?? e.sender_uin ?? ''),
    senderNick: clip(e.sender_nick ?? e.sender_nickname ?? '', 40),
    operatorId: String(e.operator_id ?? ''),
    operatorNick: clip(e.operator_nick ?? '', 40),
    time: Number(e.message_time ?? e.time ?? 0) || 0,
    text: clip(e.text ?? e.content ?? textFromMessage, 300)
  };
}

export function compactEssenceList(list, limit = 20) {
  const all = (Array.isArray(list) ? list : []).map(compactEssenceItem);
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  return { total: all.length, truncated: all.length > max, items: all.slice(0, max) };
}

/** 表情回应编码校验：系统表情 id 是 ≤3 位数字（76=/赞）；自定义表情（>3 位）留给后续版本。 */
export function normalizeReactionCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '76';
  if (!/^\d{1,3}$/.test(raw)) return '';
  return raw;
}
