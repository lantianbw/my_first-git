// TTS（语音合成）共享内核：qq_speak 工具、tools/tts-batch.mjs 批量脚本共用同一套规则。
//
// 与 voice-core.js 同样的设计约束：这里的函数是**纯工具**（无全局副作用、不读 config 单例），
// 调用方把配置传进来；网络与文件依赖（synth/download）都可注入，方便单测用假 TTS 覆盖。
//
// 凭据纪律：API key 只从环境变量或 ~/.dsh/.credentials.yaml 读取，**绝不**接受从
// config.json 传入明文 key（config 会被控制台接口整段读写/备份，key 落进去等于泄露）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

/** TTS 合成端点所在的工作区域名（合成可用；复刻必须走 dashscope 老域名，见任务说明）。 */
export const TTS_DEFAULT_BASE_URL = 'https://ws-rk8hg92mj2eun18t.cn-beijing.maas.aliyuncs.com';

/** 运行时 tts 配置默认值（bridge 的 voiceCfg() 与 tts-batch.mjs 都从这里取）。 */
export const TTS_DEFAULTS = Object.freeze({
  model: 'cosyvoice-v3.5-plus',
  // 已复刻的音色（状态 OK）。换音色/模型属于运营决策，不在代码里动。
  voiceId: 'cosyvoice-v3.5-plus-xluma-722f1767a5d348869159ac284cce7986',
  baseUrl: TTS_DEFAULT_BASE_URL,
  // 凭据指针：先查环境变量，再查 credentialsFile 的 refs[apiKeyRef]。
  apiKeyEnv: 'BAILIAN_API_KEY',
  credentialsFile: '~/.dsh/.credentials.yaml',
  apiKeyRef: 'BAILIAN_API_KEY',
  format: 'wav',
  sampleRate: 24000,
  timeoutMs: 90000,
  maxChars: 120,
  maxBytes: 10 * 1024 * 1024,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  keepFiles: 200,
  // 实测 18 字 ≈ 0.003 元 ⇒ 约 2 元/万字符；只用于**估算与记账**，不是账单。
  pricePer10kChars: 2,
  // TTS wav 落盘子目录（相对语音库目录，绝不允许越出语音库）。
  dir: 'tts'
});

/**
 * 心情 → 语气映射初稿（config 的 socialV2.voice.toneMap 可整体覆盖）。
 * key 是「/」分隔的别名组（第一个别名是主名，用于回显 toneKey），value 是 instruction。
 * 别名尽量覆盖 moods.json 里会出现的自由措辞（如「软下来」「被逗到」），
 * 匹配规则见 matchToneGroup：全等，或双向包含（长度 ≥2 才参与包含匹配，避免「草」误命中）。
 */
export const DEFAULT_TONE_MAP = Object.freeze({
  '松快/轻快/开心/高兴/心情好/得劲': '语气轻快，语速稍微快一点，尾音上扬',
  '闷/低落/难过/难受/烦/没劲/没意思': '语速放慢，声音压低，句子说短一点',
  '逗/好笑/被逗到/想笑/乐/搞笑': '带着憋笑的感觉说，气息有点不稳',
  '生气/恼/火大/气死/气人': '语速快，音量抬高，语气冲一点',
  '困/深夜/想睡/犯困/瞌睡': '含糊一点，尾音拖长，语速放慢，像快睡着了',
  '软/温柔/撒娇/软下来': '声音放软，轻声说，温柔一点',
  // 顺序必须是「自然」在前：resolveToneInstruction 用 `hit.primary !== '默认'` 判断
  // 是否走映射，主名若是「默认」，tone='自然' 会被判成"未命中映射"而原样透传，
  // 真正发给 TTS 的指令就变成「自然」两个字。别改回 '默认/自然'。
  '自然/默认': '自然地说'
});

/**
 * 语气 → 富语言标签前缀（config 的 socialV2.voice.toneTags 可整体覆盖；不配则不启用）。
 * 语法来自百炼 Qwen-Audio-TTS：控制类标签（如 [excited]）作用到下一个标签为止，
 * 拟声类标签（如 [giggles]）在当前位置插入声音、不改变前后情绪。
 *
 * 为什么用标签而不是只调 instruction：实测同句 22 字，[excited][very fast] 把
 * 音高起伏（5-95% 半音跨度）从 11.71st 拉到 14.11st（+20.5%），而 instruction
 * 只能改整体音高和语速，改不动句调抑扬。标签必须写在 text 里，instruction 里无效，
 * 所以只能在合成前拼到文本前。
 */
export const DEFAULT_TONE_TAGS = Object.freeze({
  '松快/轻快/开心/高兴/心情好/得劲': '[excited][very fast]',
  '闷/低落/难过/难受/烦/没劲/没意思': '[tired][very slowly]',
  '逗/好笑/被逗到/想笑/乐/搞笑': '[mischievously][very fast][giggles]',
  '生气/恼/火大/气死/气人': '[angry][shouting]',
  '困/深夜/想睡/犯困/瞌睡': '[tired]',
  '软/温柔/撒娇/软下来': '[whispers]',
  '自然/默认': '[excited][very fast]'
});

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 展开 ~ 开头路径（Windows 用 USERPROFILE）。 */
export function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    return path.join(home, s.slice(2));
  }
  return s;
}

/**
 * 读百炼 API key：环境变量 → ~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY。
 * yaml 解析失败时退回正则逐行匹配（与 _tone.py 的读法一致）。
 * 返回 null 表示没找到（调用方要给出可操作的错误，而不是把 undefined 发出去）。
 * 注意：**绝不**接受明文 key 参数 —— 那 会诱导调用方把 key 写进 config。
 */
export function readBailianApiKey({
  envVar = TTS_DEFAULTS.apiKeyEnv,
  credentialsFile = TTS_DEFAULTS.credentialsFile,
  apiKeyRef = TTS_DEFAULTS.apiKeyRef
} = {}) {
  const fromEnv = process.env[envVar];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  let text = '';
  try {
    text = fs.readFileSync(expandHome(credentialsFile), 'utf8');
  } catch {
    return null;
  }
  try {
    const doc = yaml.load(text);
    const v = doc?.refs?.[apiKeyRef] ?? doc?.[apiKeyRef];
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* yaml 损坏时走正则兜底 */ }
  const m = new RegExp(`${apiKeyRef}\\s*:\\s*["']?([^\\s"']+)`).exec(text);
  return m ? m[1] : null;
}

/** instruction 长度权重：汉字等全角算 2，ASCII 算 1（API 上限 100）。 */
export function instructionWeight(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 校验 instruction；超限抛错（汉字 2、上限 100，即最多约 50 个汉字）。 */
export function assertInstructionOk(s) {
  const w = instructionWeight(s);
  if (w === 0) throw new Error('语气指令不能为空');
  if (w > 100) throw new Error(`语气指令过长（权重 ${w} > 100，汉字算 2），请缩短`);
  return true;
}

/** 计费字符数：去首尾空白后的码点数。 */
export function countChars(text) {
  return [...String(text ?? '').trim()].length;
}

/** 估算费用（元）：chars × 单价 / 万。四舍五入到 6 位小数（单句约 0.003 元量级）。 */
export function estimateCostYuan(chars, pricePer10kChars = TTS_DEFAULTS.pricePer10kChars) {
  const price = Number(pricePer10kChars) > 0 ? Number(pricePer10kChars) : TTS_DEFAULTS.pricePer10kChars;
  const n = Number(chars);
  const count = Number.isFinite(n) ? n : countChars(chars);
  return Math.round((count * price * 1e6) / 10000) / 1e6;
}

// ── WAV 头解析 ──────────────────────────────────────────────────────────────

/**
 * 解析 WAV（RIFF/WAVE）头：返回 { channels, sampleRate, bits, dataBytes, durationSec }。
 * 为什么不用 ffprobe：这里只需要时长做记录/展示，为一个数字 spawn 子进程不划算
 * （而且受限沙箱里 stdio pipe 会 EPERM，见 voice-core.js 的教训）。非 WAV/怪头返回 null。
 */
export function wavInfoFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length && (!fmt || !data)) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      };
    } else if (id === 'data') {
      data = { start: off + 8, bytes: Math.max(0, Math.min(size, buf.length - off - 8)) };
    }
    off += 8 + size + (size % 2); // chunk 按 2 字节对齐
  }
  if (!fmt || !data || !fmt.sampleRate) return null;
  const bytesPerFrame = (fmt.channels * fmt.bits) / 8;
  const durationSec = bytesPerFrame > 0 ? data.bytes / bytesPerFrame / fmt.sampleRate : 0;
  return { ...fmt, dataBytes: data.bytes, durationSec: Math.round(durationSec * 10) / 10 };
}

// ── 语气解析 ────────────────────────────────────────────────────────────────

/** 别名组 key 拆分（'困/深夜' → ['困','深夜']），去空白、保序。 */
function aliasesOf(key) {
  return String(key ?? '').split('/').map((s) => s.trim()).filter(Boolean);
}

/** 是否全为 CJK 字符（含汉字区起 0x2E80）。单字中文别名（闷/困/软）允许参与子串匹配。 */
function isCjkWord(s) {
  return [...String(s ?? '')].length > 0 && [...String(s)].every((ch) => ch.codePointAt(0) >= 0x2e80);
}

/**
 * 把一个词（语气名或心情词）匹配到 toneMap 的别名组。
 * 命中规则：全等；或双向包含。参与包含的一侧要求 **中文词** 或 **长度 ≥2**——
 * 单字中文别名（闷/困/软…）在中文里表意完整，允许匹配（「有点闷」→ 闷 组）；
 * 单字 ASCII（如 'a'）则不参与，避免一个字母万物匹配。
 * 返回 { key（组原文）, primary（主名）, instruction } 或 null。
 */
export function matchToneGroup(word, toneMap = DEFAULT_TONE_MAP) {
  const w = String(word ?? '').trim();
  if (!w) return null;
  for (const [key, instruction] of Object.entries(toneMap || {})) {
    for (const alias of aliasesOf(key)) {
      const hit = alias === w
        || ((isCjkWord(alias) || alias.length >= 2) && w.includes(alias))
        || ((isCjkWord(w) || w.length >= 2) && alias.includes(w));
      if (hit) return { key, primary: aliasesOf(key)[0], instruction };
    }
  }
  return null;
}

/** 深夜时段：23:00 ~ 06:00（本地时间）。无心情可依时用它兜底选「困」语气。 */
export function isDeepNight(hour) {
  const h = Number.isFinite(hour) ? hour : new Date().getHours();
  return h >= 23 || h < 6;
}

/**
 * 决定本次合成用的 instruction。优先级：
 *   1. 显式 tone（模型指定）：映射表命中 → 用映射；未命中 → 把 tone 当自然语言指令透传
 *      （instruction 字段本来就支持自然语言语气控制；仅做长度校验）。
 *   2. 当前心情词（moods.json 的 dynamicMood/baseMood.word）。
 *   3. 深夜时段 → 「困」组。
 *   4. 默认组（'自然/默认'；自定义 toneMap 漏配时退回 '自然地说'）。
 * 返回 { toneKey, instruction, via }；tone 非法（透传超长）时抛错。
 */
export function resolveToneInstruction({ tone = null, moodWord = null, hour = null, toneMap = DEFAULT_TONE_MAP } = {}) {
  const map = (toneMap && typeof toneMap === 'object' && !Array.isArray(toneMap)) ? toneMap : DEFAULT_TONE_MAP;
  const t = String(tone ?? '').trim();
  if (t) {
    const hit = matchToneGroup(t, map);
    if (hit && hit.primary !== '默认') return { toneKey: hit.primary, instruction: hit.instruction, via: 'tone-map' };
    // 未命中映射：透传为自然语言指令（这正是 instruction 字段的用法）。
    assertInstructionOk(t);
    return { toneKey: t.slice(0, 12), instruction: t, via: 'tone-raw' };
  }
  const mood = String(moodWord ?? '').trim();
  if (mood) {
    const hit = matchToneGroup(mood, map);
    if (hit && hit.primary !== '默认') return { toneKey: hit.primary, instruction: hit.instruction, via: 'mood' };
  }
  if (isDeepNight(hour)) {
    const hit = matchToneGroup('困', map);
    if (hit) return { toneKey: hit.primary, instruction: hit.instruction, via: 'night' };
  }
  const fallback = matchToneGroup('默认', map);
  return {
    toneKey: fallback?.primary ?? '默认',
    instruction: fallback?.instruction ?? '自然地说',
    via: 'default'
  };
}

/**
 * 按 toneKey 取标签前缀。toneTags 结构与 toneMap 完全相同（别名组 → 值），
 * 因此复用 matchToneGroup 的匹配规则：显式语气、心情词、深夜兜底都能命中。
 * 未命中或值不是合法标签时返回空串（宁可不加，也不要把普通文字念出来）。
 */
export function resolveToneTag(toneKey, toneTags = DEFAULT_TONE_TAGS) {
  const w = String(toneKey ?? '').trim();
  if (!w || !toneTags || typeof toneTags !== 'object' || Array.isArray(toneTags)) return '';
  const hit = matchToneGroup(w, toneTags);
  const tag = String(hit?.instruction ?? '').trim();
  // 只接受「一个或多个 [xxx] 连续拼接」，挡住把中文描述误配进 toneTags 的情况
  return /^(?:\[[^[\]]+\])+$/.test(tag) ? tag : '';
}

// ── 合成与下载 ──────────────────────────────────────────────────────────────

/**
 * 调 TTS 合成（非流式）：POST SpeechSynthesizer，返回 { audioUrl, requestId }。
 * 注意返回的是 24 小时有效的 URL，**必须**再下载一次才能落盘（见 downloadAudioFile）。
 * fetchImpl 可注入（单测用假 TTS）。失败抛带 API code/message 的中文错误。
 */
export async function synthesizeTts({
  text,
  instruction = null,
  apiKey,
  model = TTS_DEFAULTS.model,
  voice = TTS_DEFAULTS.voiceId,
  baseUrl = TTS_DEFAULTS.baseUrl,
  format = TTS_DEFAULTS.format,
  sampleRate = TTS_DEFAULTS.sampleRate,
  timeoutMs = TTS_DEFAULTS.timeoutMs,
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error('缺少百炼 API key（未配置环境变量，~/.dsh/.credentials.yaml 里也没找到 refs.BAILIAN_API_KEY）');
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/v1/services/audio/tts/SpeechSynthesizer`;
  const input = { text: String(text ?? ''), voice, format, sample_rate: Number(sampleRate) || 24000 };
  if (instruction) {
    assertInstructionOk(instruction);
    input.instruction = String(instruction);
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(Number(timeoutMs) || 90000)
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '超时' : (error?.message ?? error);
    throw new Error(`TTS 合成请求失败（${reason}）：可稍后重试，或改用文字消息`);
  }
  let body = {};
  try {
    body = await res.json();
  } catch { /* 非 JSON 响应按下面统一报错 */ }
  if (!res.ok || body?.output?.audio?.url == null) {
    const code = body?.code ?? res.status;
    const msg = body?.message ?? '';
    throw new Error(`TTS 合成失败[${code}] ${msg}`.trim() + '：请改用文字消息发送');
  }
  return { audioUrl: String(body.output.audio.url), requestId: body.request_id ?? null };
}

/**
 * 下载合成结果到 destPath。只信 synthesizeTts 返回的 URL（调用方不得把用户输入的 URL 传进来）。
 * 校验：体积上限 + WAV 魔数（格式就是 wav，头部不是 RIFF 说明返回坏了，直接当失败处理）。
 */
export async function downloadAudioFile(audioUrl, destPath, {
  maxBytes = TTS_DEFAULTS.maxBytes,
  timeoutMs = 60000,
  fetchImpl = fetch
} = {}) {
  let res;
  try {
    res = await fetchImpl(audioUrl, { signal: AbortSignal.timeout(Number(timeoutMs) || 60000) });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '超时' : (error?.message ?? error);
    throw new Error(`TTS 音频下载失败（${reason}）`);
  }
  if (!res.ok) throw new Error(`TTS 音频下载失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('TTS 音频下载失败（空文件）');
  if (buf.length > maxBytes) throw new Error(`TTS 音频过大（${buf.length} > ${maxBytes} 字节），已放弃落盘`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('TTS 音频下载失败（内容不是 WAV）：请改用文字消息发送');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length };
}

// ── 缓存索引与清理 ──────────────────────────────────────────────────────────

/**
 * audio/tts/index.json：text/tone/file/时长/字符数/估算费用。
 * 既服务批量预生成（人肉可见清单），也是 qq_speak 的 24h 缓存账本（同 text+instruction 不重复计费）。
 */
export function loadTtsIndex(indexFile, ttsDir) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch { /* 没有或坏了都当空索引重建 */ }
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e.file === 'string') : [];
  // 文件已被清理（手动删/超出保留数）的条目在这里就丢掉，索引与磁盘保持一致。
  const alive = entries.filter((e) => {
    try { return fs.statSync(path.join(ttsDir, e.file)).isFile(); } catch { return false; }
  });
  return { updatedAt: Number(raw?.updatedAt) || 0, entries: alive };
}

/** 崩溃安全写 JSON（临时文件 + rename）。 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function saveTtsIndex(indexFile, index) {
  writeJsonAtomic(indexFile, { updatedAt: Date.now(), entries: index.entries });
}

/** (text, instruction) 的缓存键：指令一致才算同一条（语气不同 ⇒ 不同文件，这是有意的）。 */
export function ttsCacheKey(text, instruction) {
  return crypto.createHash('sha1').update(`${String(text ?? '').trim()}\n${String(instruction ?? '').trim()}`).digest('hex');
}

/** 找 24h 内可复用的条目：text/instruction 全等、未过期、文件还在。 */
export function findCachedEntry(index, { text, instruction, cacheTtlMs = TTS_DEFAULTS.cacheTtlMs, now = Date.now() }) {
  const key = ttsCacheKey(text, instruction);
  return index.entries.find((e) => e.cacheKey === key && now - Number(e.createdAt || 0) < cacheTtlMs) ?? null;
}

/**
 * 清理 tts 目录：保留最近 keepFiles 个 .wav（按 mtime 降序），其余删除；索引里对应条目一并去掉。
 * 2 核 2G 目标机按 200 个 × ~200KB ≈ 40MB 封顶。返回 { removed, kept }。
 */
export function cleanupTtsDir(ttsDir, index, keepFiles = TTS_DEFAULTS.keepFiles) {
  const keep = Math.max(1, Number(keepFiles) || TTS_DEFAULTS.keepFiles);
  let wavs = [];
  try {
    wavs = fs.readdirSync(ttsDir)
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => {
        const st = fs.statSync(path.join(ttsDir, f));
        return { file: f, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { removed: 0, kept: 0, index };
  }
  const doomed = new Set(wavs.slice(keep).map((w) => w.file));
  for (const f of doomed) {
    try { fs.unlinkSync(path.join(ttsDir, f)); } catch { /* 删不掉留给下次 */ }
  }
  return {
    removed: doomed.size,
    kept: wavs.length - doomed.size,
    index: { ...index, entries: index.entries.filter((e) => !doomed.has(e.file)) }
  };
}

/** 文件名记号净化：去 Windows 保留字符/控制字符/空白，截断长度（中文保留）。 */
export function sanitizeFileToken(s, maxLen = 12) {
  const clean = String(s ?? '').replace(/[\u0000-\u001f<>:"/\\|?*\s]+/g, '');
  return [...clean].slice(0, maxLen).join('') || 'x';
}

function compactTimestamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 运行时合成文件名：<时间戳>-<hash12>.wav（hash 由 text+instruction 决定，天然可对账）。 */
export function runtimeTtsFileName(text, instruction, atMs = Date.now()) {
  return `${compactTimestamp(atMs)}-${ttsCacheKey(text, instruction).slice(0, 12)}.wav`;
}

/** 批量预生成文件名：<语气>-<序号>-<短语前6字>.wav。 */
export function batchTtsFileName(toneKey, seq, text) {
  return `${sanitizeFileToken(toneKey, 8)}-${String(seq).padStart(2, '0')}-${sanitizeFileToken(text, 6)}.wav`;
}

/** 同名避让：foo.wav → foo-2.wav（最多 999，防呆）。 */
function uniquePath(dir, name) {
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, name.replace(/(\.[^.]+)$/, `-${n}$1`));
    n += 1;
    if (n > 999) throw new Error('同名 TTS 文件太多');
  }
  return candidate;
}

// 同 cacheKey 的并发合成去重：qq_speak 被连续调用时只花一次钱。
const inflightEnsures = new Map();

/**
 * 「确保有这条音频」：命中缓存直接复用；否则合成 + 下载 + 记索引 + 触发清理。
 * 这是 qq_speak 与 tts-batch 共用的落盘核心。synth/download 可注入（单测用假 TTS）。
 *
 * ctx.toneTags：语气 → 富语言标签前缀（config 的 socialV2.voice.toneTags）。
 *   给了就把标签拼到**发给 TTS 的文本**前；用户可见文本、字数、索引 text 仍是原文。
 *   不传（默认 null）= 不启用，行为与加这个功能之前完全一致。
 *
 * 返回 { file（basename）, cached, chars, costYuan, durationSec, bytes, createdAt, instruction, tag, text }。
 */
export async function ensureTtsAudio({ text, instruction, toneKey, fileName = null }, ctx) {
  const {
    ttsDir,
    indexFile,
    cacheTtlMs = TTS_DEFAULTS.cacheTtlMs,
    keepFiles = TTS_DEFAULTS.keepFiles,
    pricePer10kChars = TTS_DEFAULTS.pricePer10kChars,
    toneTags = null,
    synth,
    download,
    now = Date.now
  } = ctx;
  const cleanText = String(text ?? '').trim();
  const cleanIns = String(instruction ?? '').trim();
  // 富语言标签只拼在「发给 TTS 的文本」上：用户可见文本、字数、索引 text 仍是 cleanText。
  // 缓存键用 spokenText —— 改了 toneTags 就自然失效旧缓存，不会继续播上一个配置的声音。
  const tagPrefix = toneTags ? resolveToneTag(toneKey, toneTags) : '';
  const spokenText = tagPrefix ? `${tagPrefix}${cleanText}` : cleanText;
  const cacheKey = ttsCacheKey(spokenText, cleanIns);
  const chars = countChars(cleanText);

  // 并发去重：同一 (text+instruction) 正在合成时，后来的等它，直接复用结果。
  const running = inflightEnsures.get(`${indexFile}:${cacheKey}`);
  if (running) return running;

  const task = (async () => {
    const index = loadTtsIndex(indexFile, ttsDir);
    const hit = findCachedEntry(index, { text: spokenText, instruction: cleanIns, cacheTtlMs, now: now() });
    if (hit) return { ...hit, cached: true };

    // fileName 可注入（批量脚本用 <语气>-<序号>-<短语前6字>.wav；运行时默认 时间戳-hash）。
    const wantName = fileName ? path.basename(String(fileName)) : runtimeTtsFileName(cleanText, cleanIns, now());
    const dest = uniquePath(ttsDir, wantName);
    const { audioUrl, requestId } = await synth({ text: spokenText, instruction: cleanIns });
    const { bytes } = await download(audioUrl, dest);
    const info = wavInfoFromBuffer(fs.readFileSync(dest));
    const entry = {
      text: cleanText,
      tone: toneKey ?? '',
      tag: tagPrefix || null,
      instruction: cleanIns,
      cacheKey,
      file: path.basename(dest),
      requestId: requestId ?? null,
      bytes,
      durationSec: info?.durationSec ?? null,
      sampleRate: info?.sampleRate ?? null,
      channels: info?.channels ?? null,
      chars,
      costYuan: estimateCostYuan(chars, pricePer10kChars),
      createdAt: now()
    };
    const withEntry = { entries: [...index.entries.filter((e) => e.file !== entry.file), entry] };
    const cleaned = cleanupTtsDir(ttsDir, withEntry, keepFiles);
    saveTtsIndex(indexFile, cleaned.index);
    return { ...entry, cached: false };
  })();

  inflightEnsures.set(`${indexFile}:${cacheKey}`, task);
  try {
    return await task;
  } finally {
    inflightEnsures.delete(`${indexFile}:${cacheKey}`);
  }
}

// ── qq_speak 编排（可注入依赖，供单测与 bridge 共用） ────────────────────────

/**
 * qq_speak 的完整流程：校验文本 → 出站守卫 → 选语气 → 确保音频（缓存/合成）→ 发送。
 *
 * deps（全部可注入）：
 *   maxChars      单条语音文本上限（默认 120）
 *   guardText     出站守卫（bridge 的 guardOutboundV2；文本会被「说出来」，必须过审）
 *   moodWord      () => 当前心情词（bridge 读 moods.json；测试可固定返回）
 *   hour          本地小时数（默认取当前时间）
 *   toneMap       语气映射（config.socialV2.voice.toneMap）
 *   ensureAudio   ({text, instruction, toneKey}) => ensureTtsAudio 结果
 *   sendVoice     (key, relFile, {label, verify}) => sendVoiceForV2 的返回值
 *   log           日志函数（bridge 的 log）
 *   usage         记账钩子 ({key, chars, costYuan, tone, cached, file})，写 state/tts-usage.jsonl
 *   now           时间函数
 *
 * 任一步失败抛 Error（消息里已写明原因）；调用方把错误原样回给模型，
 * 让模型决定改发文字 —— 本函数不做静默降级。
 */
export async function speakFlow({ key, text, tone = null, label = '', verify = true }, deps) {
  const {
    maxChars = TTS_DEFAULTS.maxChars,
    guardText = null,
    moodWord = null,
    hour = null,
    toneMap = DEFAULT_TONE_MAP,
    ensureAudio,
    sendVoice,
    log = () => {},
    usage = () => {},
    now = Date.now
  } = deps;

  const cleanText = String(text ?? '').trim();
  if (!cleanText) throw new Error('text 不能为空：要念的内容');
  const chars = countChars(cleanText);
  if (chars > maxChars) throw new Error(`text 过长（${chars} 字 > 上限 ${maxChars} 字）：语音适合短句，长内容请用文字消息分条发`);

  // 文本即将被「说」进会话，必须走与文本消息相同的出站守卫（地址/敏感信息拦截）。
  if (guardText) {
    const guarded = guardText(cleanText);
    if (!guarded?.ok) throw new Error(`语音文本未过出站守卫：${guarded?.reason ?? '未知原因'}`);
  }

  const mood = typeof moodWord === 'function' ? (moodWord() ?? null) : null;
  const resolvedTone = resolveToneInstruction({ tone, moodWord: mood, hour: hour ?? new Date(now()).getHours(), toneMap });
  const audio = await ensureAudio({ text: cleanText, instruction: resolvedTone.instruction, toneKey: resolvedTone.toneKey });
  const relFile = `tts/${audio.file}`;

  // 发送复用 sendVoiceForV2（限流/审计/记账/回读校验都在那里面）。
  const sent = await sendVoice(key, relFile, { label, verify });
  usage({ key, chars: audio.chars, costYuan: audio.costYuan, tone: resolvedTone.toneKey, instruction: resolvedTone.instruction, via: resolvedTone.via, cached: audio.cached, file: audio.file, messageId: sent?.messageId ?? null, at: now() });
  log(`[tts] ${key} ${audio.cached ? '缓存复用' : '合成'} tone=${resolvedTone.toneKey}(${resolvedTone.via}${mood ? ` 心情:${mood}` : ''}) chars=${audio.chars} est=${audio.costYuan}元 file=${audio.file}${audio.durationSec != null ? ` 时长${audio.durationSec}s` : ''}${sent?.messageId ? ` messageId=${sent.messageId}` : ''}`);
  return {
    toneKey: resolvedTone.toneKey,
    via: resolvedTone.via,
    moodWord: mood,
    instruction: resolvedTone.instruction,
    cached: audio.cached,
    file: audio.file,
    chars: audio.chars,
    costYuan: audio.costYuan,
    durationSec: audio.durationSec ?? null,
    bytes: audio.bytes ?? null,
    // verified=true ⇔ get_msg 回读到 record 段（与 qq_send_voice 同一语义）。
    verified: sent?.verification?.confirmed === true,
    sent
  };
}
