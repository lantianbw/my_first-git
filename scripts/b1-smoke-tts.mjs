// B1 冒烟：真实合成一条新句 + 二次调用命中 24h 缓存（不发送，验证 qq_speak 的落盘内核）。
// 与 bridge 的 ttsEnsureAudioFactory 同构注入；产物落在 audio/tts/，与 qq_speak 共用账本 index.json。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureTtsAudio, synthesizeTts, downloadAudioFile, readBailianApiKey,
  TTS_DEFAULTS, resolveToneInstruction, DEFAULT_TONE_MAP
} from '../src/tts-lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ttsDir = path.join(root, 'audio', 'tts');
const indexFile = path.join(ttsDir, 'index.json');

// C4 顺带验证：同一句话在 4 种心情下的 instruction 各不相同
const line = resolveToneInstruction({ moodWord: null, hour: new Date().getHours(), toneMap: DEFAULT_TONE_MAP });
console.log('当前无心情时的默认语气:', JSON.stringify(line));
for (const mood of ['松快', '困', '生气', '软']) {
  const r = resolveToneInstruction({ moodWord: mood, hour: 12, toneMap: DEFAULT_TONE_MAP });
  console.log(`  mood=${mood} -> tone=${r.toneKey} instruction=${r.instruction}`);
}

const apiKey = readBailianApiKey({});
if (!apiKey) { console.error('未找到 BAILIAN_API_KEY'); process.exit(1); }
console.log('API key 已就绪（不打印）');

const mk = () => ({
  ttsDir, indexFile,
  cacheTtlMs: TTS_DEFAULTS.cacheTtlMs,
  keepFiles: TTS_DEFAULTS.keepFiles,
  pricePer10kChars: TTS_DEFAULTS.pricePer10kChars,
  synth: (args) => synthesizeTts({ ...args, apiKey, model: TTS_DEFAULTS.model, voice: TTS_DEFAULTS.voiceId, baseUrl: TTS_DEFAULTS.baseUrl, format: TTS_DEFAULTS.format, sampleRate: TTS_DEFAULTS.sampleRate, timeoutMs: TTS_DEFAULTS.timeoutMs }),
  download: (audioUrl, dest) => downloadAudioFile(audioUrl, dest, { maxBytes: TTS_DEFAULTS.maxBytes, timeoutMs: 60000 })
});

const TEXT = '链路验收冒烟，收到请忽略';
const tone = resolveToneInstruction({ tone: '自然', toneMap: DEFAULT_TONE_MAP });

const t1 = await ensureTtsAudio({ text: TEXT, instruction: tone.instruction, toneKey: tone.toneKey }, mk());
console.log('第一次（真实合成）:', JSON.stringify({ file: t1.file, cached: t1.cached, chars: t1.chars, costYuan: t1.costYuan, durationSec: t1.durationSec, bytes: t1.bytes }));
const t2 = await ensureTtsAudio({ text: TEXT, instruction: tone.instruction, toneKey: tone.toneKey }, mk());
console.log('第二次（应缓存复用）:', JSON.stringify({ file: t2.file, cached: t2.cached }));
console.log('文件存在:', fs.existsSync(path.join(ttsDir, t1.file)));
const pass = t2.cached === true;
console.log('B1 冒烟结论:', pass ? 'PASS（合成 OK + 24h 缓存命中，二次不再计费）' : 'FAIL（第二次未命中缓存）');
process.exit(pass ? 0 : 1);
