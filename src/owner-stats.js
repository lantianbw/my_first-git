// owner 状态偏差：最近 7 天平均字数与平均回复间隔。
//
// 只给事实、不给方向：偏离均值 40% 以上时，唤醒提示只写「他今天话比平时少（约少 60%）」
// 或「他回得比平时慢」，不替她判断「他可能心情不好」。

export const OWNER_STATS_LIMITS = Object.freeze({
  windowDays: 7,
  minSamples: 3,
  deviationRatio: 0.4,
  freshMs: 30 * 60 * 1000,
  maxSamples: 500
});

const DAY = 86_400_000;

function toSamples(raw, now) {
  const list = Array.isArray(raw?.samples) ? raw.samples : [];
  const cutoff = now - OWNER_STATS_LIMITS.windowDays * DAY;
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const at = Number(item.at);
      const chars = Number(item.chars);
      const gapMs = Number(item.gapMs);
      if (!Number.isFinite(at) || at <= cutoff || at > now + 60_000) return null;
      if (!Number.isFinite(chars) || chars < 0) return null;
      return {
        at,
        chars: Math.round(chars),
        gapMs: Number.isFinite(gapMs) && gapMs > 0 ? Math.round(gapMs) : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(-OWNER_STATS_LIMITS.maxSamples);
}

export function normalizeOwnerStats(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const latestSrc = src.latest && typeof src.latest === 'object' ? src.latest : null;
  const latestAt = Number(latestSrc?.at);
  const latest = latestSrc && Number.isFinite(latestAt) && latestAt > now - OWNER_STATS_LIMITS.windowDays * DAY
    ? {
      at: latestAt,
      chars: Math.max(0, Math.round(Number(latestSrc.chars) || 0)),
      gapMs: Math.max(0, Math.round(Number(latestSrc.gapMs) || 0)),
      avgChars: Number(latestSrc.avgChars) > 0 ? Number(latestSrc.avgChars) : 0,
      avgGap: Number(latestSrc.avgGap) > 0 ? Number(latestSrc.avgGap) : 0
    }
    : null;
  return { samples: toSamples(src, now), latest, updatedAt: Number(src.updatedAt) || 0 };
}

const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);

/**
 * 记一条 owner 私聊消息：先用「之前 7 天」的样本算均值，再把当前消息纳入窗口。
 * gapMs 是她上一条回复到这条消息的间隔（没有上一条回复时为 0）。
 */
export function recordOwnerMessage(stats, { at = Date.now(), chars, gapMs = 0, now = at } = {}) {
  const base = normalizeOwnerStats(stats, now);
  const textChars = Number(chars);
  if (!Number.isFinite(textChars) || textChars <= 0) return { stats: base, latest: base.latest };
  const prior = base.samples;
  const charSamples = prior.map((item) => item.chars).filter((value) => value > 0);
  const gapSamples = prior.map((item) => item.gapMs).filter((value) => value > 0);
  const avgChars = charSamples.length >= OWNER_STATS_LIMITS.minSamples ? mean(charSamples) : 0;
  const avgGap = gapSamples.length >= OWNER_STATS_LIMITS.minSamples ? mean(gapSamples) : 0;
  const sample = {
    at,
    chars: Math.round(textChars),
    gapMs: Number(gapMs) > 0 ? Math.round(Number(gapMs)) : 0
  };
  const latest = {
    at,
    chars: sample.chars,
    gapMs: sample.gapMs,
    avgChars,
    avgGap
  };
  return {
    stats: {
      samples: [...prior, sample].slice(-OWNER_STATS_LIMITS.maxSamples),
      latest,
      updatedAt: now
    },
    latest
  };
}

/** 当前消息相对历史的偏差文案；没有明显偏差/样本不足/已过期时返回 ''。 */
export function ownerDeviationText(stats, { now = Date.now(), freshMs = OWNER_STATS_LIMITS.freshMs } = {}) {
  const normalized = normalizeOwnerStats(stats, now);
  const latest = normalized.latest;
  if (!latest || now - latest.at > freshMs || now - latest.at < -60_000) return '';
  const lines = [];
  if (latest.avgChars > 0) {
    const drop = (latest.avgChars - latest.chars) / latest.avgChars;
    if (drop >= OWNER_STATS_LIMITS.deviationRatio) {
      lines.push(`他今天话比平时少（约少 ${Math.round(drop * 100)}%）`);
    }
  }
  if (latest.avgGap > 0 && latest.gapMs > 0) {
    const slower = (latest.gapMs - latest.avgGap) / latest.avgGap;
    if (slower >= OWNER_STATS_LIMITS.deviationRatio) lines.push('他回得比平时慢');
  }
  return lines.join('；');
}
