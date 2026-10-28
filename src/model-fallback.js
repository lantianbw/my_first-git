// 模型降级 fallback（B2）：主模型 429/超时/额度不足时沿 fallbackChain 切换，成功后定时试探回主。
//
// 设计约束：
// - 纯模块：不 import bridge 的任何闭包状态；状态由调用方注入或由本模块落盘 state/model-fallback.json。
// - chain 与 provider 名来自 config.dsh.fallbackChain（例：
//     [{provider:'bailian',model:'qwen3.8-flash'},
//      {provider:'sensenova',model:'deepseek-v4-flash'},
//      {provider:'sensenova',model:'sensenova-6.8-flash-lite'}]）
// - 商汤系模型先输出 reasoning token，DSH 侧 maxTokens 必须 >=512（建议 1024），
//   该参数在 DSH 的 provider 配置里设置，桥接侧无法注入；条目可选 reasoningEffort:'none'
//   只是尽量压 reasoning 消耗（实测只能减不能消除）。
// - 回探：降级后每 probeIntervalMs 在下一次选模型时先试主链头；失败立即回退当前降级档。
// - 可降级错误的收录口径（三类，逐条有理由）：
//     ① 404 model_not_found / "model not exist" / invalid_request_error(model_not_found)：收。
//        这不是配置错误而是**模型名在该 provider 上不可用**（下线、改名、区域不提供），
//        切到链上的下一个模型通常立刻可用；抛给用户等于白白浪费一次回复。
//     ② 403 里的额度/欠费类（free quota exhausted、arrearage、insufficient balance）：收。
//        计费是按模型/账号算的，换一个 provider/模型仍有额度，属于"换条路就能走"。
//     ③ 401 unauthorized / invalid api key：**不收**。鉴权失败是凭证问题，整条链共用同一份
//        凭证配置，换模型只会把同一个错误再抛一遍；必须原样报错让人去修 key。

import fs from 'node:fs';
import path from 'node:path';

/** 命中这些模式的错误视为「可降级」（429 / 限流 / 超时 / 额度 / 模型不存在）。 */
export const FALLBACK_ERROR_RE = /(?:\b429\b|too many requests|rate.?limit|quota|insufficient[\s_-]?(?:balance|quota)|额度不足|余额不足|欠费|arrearage|model[\s._-]?not[\s._-]?(?:found|exist)|timed?\s?-?out|timeout|超时|overload|capacity|service unavailable|503)/i;

const STATE_DEFAULTS = Object.freeze({ index: 0, degradedAt: null, lastError: '', probeDueAt: null, history: [] });

export function loadModelFallback(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { ...STATE_DEFAULTS, ...raw, history: Array.isArray(raw.history) ? raw.history.slice(-50) : [] };
  } catch {
    return { ...STATE_DEFAULTS, history: [] };
  }
}

export function saveModelFallback(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8');
  } catch { /* 状态盘写失败不阻断主流程 */ }
}

export function normalizeChain(cfgDsh) {
  const chain = Array.isArray(cfgDsh?.fallbackChain) ? cfgDsh.fallbackChain.filter((e) => e && e.provider && e.model) : [];
  return chain.map((e) => ({
    provider: String(e.provider),
    model: String(e.model),
    reasoningEffort: e.reasoningEffort === undefined ? null : String(e.reasoningEffort || '')
  }));
}

/**
 * 生效链：**链头永远跟随 config 的 dsh.provider/model**，fallbackChain 只提供后备档。
 * 为什么不能直接用 fallbackChain[0] 当主档：控制台/实验里改 dsh.model（例如换
 * deepseek-v4-flash 做 A/B）时，旧链头会静默把新模型顶掉，实验变量就被污染了。
 * 与主档同 provider+model 的条目丢弃（避免同名两档）。没有任何后备档时返回空数组，
 * 调用方据此保持旧行为（只用 cfg.dsh，不进入降级状态机）。
 */
export function buildEffectiveChain(cfgDsh) {
  const primary = {
    provider: String(cfgDsh?.provider || 'deepseek-official'),
    model: String(cfgDsh?.model || 'deepseek-flash'),
    reasoningEffort: null // null = 沿用 cfg.dsh.reasoningEffort 的解析
  };
  const extras = normalizeChain(cfgDsh)
    .filter((e) => !(e.provider === primary.provider && e.model === primary.model));
  return extras.length ? [primary, ...extras] : [];
}

/** 是否应因该错误降级。模型不存在/额度欠费算；纯鉴权失败（401 invalid api key）不算——换模型救不了。 */
export function isFallbackError(message) {
  return FALLBACK_ERROR_RE.test(String(message ?? ''));
}

/**
 * 推进降级档位。返回 {state, changed, entry}；已在最后一档时 changed=false。
 * 最后一档失败也保持不动——总得有个模型用，继续重试当前档。
 */
export function advanceFallback(state, chain, { now = Date.now(), probeIntervalMs = 30 * 60 * 1000, error = '', maxHistory = 50 } = {}) {
  if (!chain.length) return { state, changed: false, entry: null };
  const nextIndex = Math.min((state.index ?? 0) + 1, chain.length - 1);
  if (nextIndex === state.index) return { state, changed: false, entry: null };
  const entry = chain[nextIndex];
  const next = {
    ...state,
    index: nextIndex,
    degradedAt: now,
    probeDueAt: now + probeIntervalMs,
    lastError: String(error).slice(0, 200),
    history: [...(state.history ?? []), { at: new Date(now).toISOString(), to: `${entry.provider}/${entry.model}`, error: String(error).slice(0, 200) }].slice(-maxHistory)
  };
  return { state: next, changed: true, entry };
}

/** 当前应使用的模型条目；降级中且到了回探时间 → 返回主链头并标记 probing。 */
export function activeModelChoice(state, chain, { now = Date.now(), probeIntervalMs = 30 * 60 * 1000 } = {}) {
  const primary = chain[0] ?? null;
  if (!primary) return { entry: null, probing: false };
  const idx = Math.min(state.index ?? 0, chain.length - 1);
  if (idx === 0) return { entry: primary, probing: false };
  if (state.probeDueAt == null || now >= state.probeDueAt) {
    return { entry: primary, probing: true };
  }
  return { entry: chain[idx], probing: false };
}

/** 回探结果回写：成功 → 回主档；失败 → 继续用降级档并把下次回探推后。 */
export function noteProbeResult(state, chain, ok, { now = Date.now(), probeIntervalMs = 30 * 60 * 1000, error = '' } = {}) {
  if (ok) {
    return { ...state, index: 0, degradedAt: null, probeDueAt: null, lastError: '',
      history: [...(state.history ?? []), { at: new Date(now).toISOString(), to: 'probe-ok: 回主模型', error: '' }].slice(-50) };
  }
  return { ...state, probeDueAt: now + probeIntervalMs,
    history: [...(state.history ?? []), { at: new Date(now).toISOString(), to: 'probe-fail: 留在降级档', error: String(error).slice(0, 200) }].slice(-50) };
}
