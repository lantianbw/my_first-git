#!/usr/bin/env node
// TTS 批量预生成：把常用短语按语气合成落盘到 audio/tts/，生成/更新 audio/tts/index.json。
//
// 用法（在 qq-bridge 目录）：
//   node tools/tts-batch.mjs                     # 按内置短语表（20 条）批量生成
//   node tools/tts-batch.mjs --dry-run           # 只打印计划，不花钱
//   node tools/tts-batch.mjs --table my.json     # 自定义短语表 [{text, tone?, instruction?}]
//   node tools/tts-batch.mjs --text "晚安" --tones 松快,闷,逗,生气
//                                                 # 同一句话按多个语气各生成一份（验收/试音用）
//   node tools/tts-batch.mjs --keep 200          # 顺带按保留数清理旧 wav（默认 config 的 keepFiles）
//
// 费用：约 2 元/万字符（一句十几字 ≈ 0.003 元）；24h 内同 text+instruction 的条目直接复用，不重复计费。
// 凭据：环境变量 BAILIAN_API_KEY，或 ~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY（不进 config）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TTS_DEFAULTS,
  DEFAULT_TONE_MAP,
  batchTtsFileName,
  cleanupTtsDir,
  estimateCostYuan,
  ensureTtsAudio,
  loadTtsIndex,
  readBailianApiKey,
  resolveToneInstruction,
  saveTtsIndex,
  synthesizeTts,
  downloadAudioFile
} from '../src/tts-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

// ── 配置（config.json 的 socialV2.voice，与桥运行时同一份） ──────────────────
function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    console.error('读 config.json 失败：请在 qq-bridge 目录下运行本脚本');
    process.exit(1);
  }
}
const cfg = loadConfig();
const voiceCfg = cfg.socialV2?.voice ?? {};
const tts = { ...TTS_DEFAULTS, ...(voiceCfg.tts ?? {}) };
const toneMap = (voiceCfg.toneMap && Object.keys(voiceCfg.toneMap).length) ? voiceCfg.toneMap : DEFAULT_TONE_MAP;
// 语气 → 富语言标签前缀（Qwen-Audio-TTS 专用）；config 不配就不加，与以前行为一致。
const toneTags = (voiceCfg.toneTags && typeof voiceCfg.toneTags === 'object' && Object.keys(voiceCfg.toneTags).length) ? voiceCfg.toneTags : null;
const voiceDir = path.resolve(ROOT, String(voiceCfg.dir ?? 'audio'));
const ttsDir = path.resolve(voiceDir, tts.dir || 'tts');
const indexFile = path.join(ttsDir, 'index.json');

// ── 短语表初稿（20 条；tone 缺省=自然；instruction 可精调单条语气） ───────────
const DEFAULT_PHRASES = [
  { text: '晚安', tone: '困' },
  { text: '我先睡了', tone: '困' },
  { text: '早安', tone: '松快' },
  { text: '在', tone: '松快' },
  { text: '草', tone: '松快' },
  { text: '就这', tone: '松快' },
  { text: '你猜', tone: '松快' },
  { text: '搞什么', tone: '松快' },
  // 任务初稿里的「？」单标点不可念（API 报 InvalidParameter），换成同义的「嗯？」。
  { text: '嗯？', tone: '逗' },
  { text: '笑死', tone: '逗' },
  { text: '真的假', tone: '逗' },
  { text: '离谱', tone: '逗' },
  { text: '救命', tone: '逗' },
  { text: '别吵', tone: '生气' },
  { text: '好累', tone: '闷' },
  { text: '想你了', tone: '软' },
  { text: '摸摸头', tone: '软' },
  { text: '等我一下', tone: '自然' },
  { text: '我去吃饭了', tone: '自然' },
  { text: '不告诉你', tone: '自然' }
];

// ── 组任务清单 ──────────────────────────────────────────────────────────────
function buildJobs() {
  if (opt('text')) {
    const text = String(opt('text'));
    const tones = String(opt('tones') ?? '松快,闷,逗,生气').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    return tones.map((tone) => ({ text, tone, explicit: true }));
  }
  let phrases = DEFAULT_PHRASES;
  if (opt('table')) {
    try {
      phrases = JSON.parse(fs.readFileSync(opt('table'), 'utf8'));
    } catch (e) {
      console.error(`读短语表失败：${e.message}`);
      process.exit(1);
    }
  }
  return phrases.map((p) => (typeof p === 'string' ? { text: p } : p));
}

const jobs = buildJobs();
if (!jobs.length) { console.error('任务清单为空'); process.exit(1); }

// 预解析每条任务的语气与 instruction（dry-run 也要先算对，打印的才是真会发生的）
const plans = jobs.map((job) => {
  const text = String(job.text ?? '').trim();
  if (!text) throw new Error('短语表里有空 text');
  if (job.instruction) {
    return { text, toneKey: job.tone ?? '自定义', instruction: String(job.instruction) };
  }
  const r = resolveToneInstruction({ tone: job.tone ?? null, toneMap });
  return { text, toneKey: r.toneKey, instruction: r.instruction };
});
const totalChars = plans.reduce((n, p) => n + [...p.text].length, 0);
const estTotal = estimateCostYuan(totalChars, tts.pricePer10kChars);

// ── dry-run：打印计划即止 ───────────────────────────────────────────────────
if (flag('dry-run')) {
  console.log(`[dry-run] 目标目录：${ttsDir}`);
  for (const p of plans) console.log(`  [${p.toneKey}] 「${p.text}」 ← ${p.instruction}`);
  console.log(`[dry-run] 共 ${plans.length} 条，约 ${totalChars} 字，估算 ${estTotal} 元（不合成）`);
  process.exit(0);
}

// ── 真跑 ────────────────────────────────────────────────────────────────────
const apiKey = readBailianApiKey({ envVar: tts.apiKeyEnv, credentialsFile: tts.credentialsFile, apiKeyRef: tts.apiKeyRef });
if (!apiKey) {
  console.error(`找不到百炼 API key：先设置环境变量 ${tts.apiKeyEnv}，或确认 ${tts.credentialsFile} 里有 refs.${tts.apiKeyRef}`);
  process.exit(1);
}

fs.mkdirSync(ttsDir, { recursive: true });
const ensure = (plan, fileName) => ensureTtsAudio(
  { text: plan.text, instruction: plan.instruction, toneKey: plan.toneKey, fileName },
  {
    ttsDir,
    indexFile,
    cacheTtlMs: tts.cacheTtlMs,
    keepFiles: tts.keepFiles,
    pricePer10kChars: tts.pricePer10kChars,
    toneTags,
    synth: (a) => synthesizeTts({ ...a, apiKey, model: tts.model, voice: tts.voiceId, baseUrl: tts.baseUrl, format: tts.format, sampleRate: tts.sampleRate, timeoutMs: tts.timeoutMs }),
    download: (audioUrl, dest) => downloadAudioFile(audioUrl, dest, { maxBytes: tts.maxBytes, timeoutMs: Math.min(tts.timeoutMs, 60000) })
  }
);

// 语气分组序号：<语气>-<序号>-<短语前6字>.wav（序号在本次运行内按语气递增）
const seqByTone = new Map();
let done = 0;
let cached = 0;
let spentChars = 0;
const t0 = Date.now();
for (const plan of plans) {
  const seq = (seqByTone.get(plan.toneKey) ?? 0) + 1;
  seqByTone.set(plan.toneKey, seq);
  const fileName = batchTtsFileName(plan.toneKey, seq, plan.text);
  try {
    const r = await ensure(plan, fileName);
    if (r.cached) cached += 1;
    else { done += 1; spentChars += r.chars; }
    console.log(`  [${r.cached ? '缓存' : '合成'}] [${plan.toneKey}] 「${plan.text}」 → ${r.file}${r.durationSec != null ? ` (${r.durationSec}s, ${r.bytes}B)` : ''} 估${r.costYuan}元`);
  } catch (e) {
    console.error(`  [失败] [${plan.toneKey}] 「${plan.text}」：${e.message}`);
    process.exitCode = 2; // 单条失败不中断整批，但退出码要能看出有失败
  }
}

// 收尾：按保留数清理 + 索引落盘（ensureTtsAudio 每条都会存一次，这里再统一清一次）
const index = loadTtsIndex(indexFile, ttsDir);
const cleaned = cleanupTtsDir(ttsDir, index, Number(opt('keep')) > 0 ? Number(opt('keep')) : tts.keepFiles);
saveTtsIndex(indexFile, cleaned.index);

console.log(`\n完成：新合成 ${done} 条，缓存复用 ${cached} 条，清理旧文件 ${cleaned.removed} 个；本次花费估算 ${estimateCostYuan(spentChars, tts.pricePer10kChars)} 元，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`索引：${indexFile}（共 ${cleaned.index.entries.length} 条）`);
console.log('这些文件已进语音库（audio/），AI 可用 qq_send_voice 发，qq_speak 也会自动复用同句缓存。');
