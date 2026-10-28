// C4 验收：同一句话在 4 种心情下的 TTS instruction 映射 + 真实合成 4 个不同语气的 wav。
// 心情来源模拟 state/moods.json 的 dynamicMood.word（线上由 speakFlow 自动注入，bridge.js:6442）。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureTtsAudio, synthesizeTts, downloadAudioFile, readBailianApiKey, TTS_DEFAULTS, resolveToneInstruction, DEFAULT_TONE_MAP } from '../src/tts-lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ttsDir = path.join(root, 'audio', 'tts');
const indexFile = path.join(ttsDir, 'index.json');
const apiKey = readBailianApiKey({});
if (!apiKey) { console.error('未找到 BAILIAN_API_KEY'); process.exit(1); }

const TEXT = '老爹，今天的实验做完了吗';
const MOODS = ['松快', '困', '生气', '软'];   // 对应 mood.js 会出现的 moodWord

const mk = () => ({
  ttsDir, indexFile,
  cacheTtlMs: TTS_DEFAULTS.cacheTtlMs, keepFiles: TTS_DEFAULTS.keepFiles, pricePer10kChars: TTS_DEFAULTS.pricePer10kChars,
  synth: (args) => synthesizeTts({ ...args, apiKey, model: TTS_DEFAULTS.model, voice: TTS_DEFAULTS.voiceId, baseUrl: TTS_DEFAULTS.baseUrl, format: TTS_DEFAULTS.format, sampleRate: TTS_DEFAULTS.sampleRate, timeoutMs: TTS_DEFAULTS.timeoutMs }),
  download: (u, d) => downloadAudioFile(u, d, { maxBytes: TTS_DEFAULTS.maxBytes, timeoutMs: 60000 })
});

const results = [];
for (const mood of MOODS) {
  const tone = resolveToneInstruction({ moodWord: mood, hour: 14, toneMap: DEFAULT_TONE_MAP });
  const fileName = `c4-语气-${mood}-${TEXT.slice(0, 6)}.wav`;
  const audio = await ensureTtsAudio({ text: TEXT, instruction: tone.instruction, toneKey: tone.toneKey, fileName }, mk());
  results.push({ mood, tone: tone.toneKey, instruction: tone.instruction, file: audio.file, cached: audio.cached, durationSec: audio.durationSec, costYuan: audio.costYuan });
  console.log(`mood=${mood.padEnd(3)} -> tone=${tone.toneKey.padEnd(3)} ${audio.cached ? '(缓存)' : `(合成 ${audio.durationSec}s ¥${audio.costYuan})`} instruction=${tone.instruction}`);
}
const uniqueTones = new Set(results.map((r) => r.tone));
const uniqueFiles = new Set(results.map((r) => r.file));
const allExist = results.every((r) => fs.existsSync(path.join(ttsDir, r.file)));
console.log(`\n4 种 mood -> ${uniqueTones.size} 种语气、${uniqueFiles.size} 个文件，全部存在=${allExist}`);
console.log(results.some((r) => r.cached) ? '（部分命中此前缓存属正常——同一 text+instruction 24h 内复用）' : '');
const pass = uniqueTones.size === 4 && allExist;
console.log(`C4 验收：${pass ? 'PASS（同一句话 4 种 mood 生成 4 个不同语气文件）' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
