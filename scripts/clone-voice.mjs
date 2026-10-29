#!/usr/bin/env node
// 音色复刻辅助脚本：把一段真人音频通过百炼 voice-enrollment 复刻成 cosyvoice 音色。
//
// 用法（在 qq-bridge 目录）：
//   node scripts/clone-voice.mjs <音频绝对路径> [前缀]
//   例：node scripts/clone-voice.mjs "E:\DSH\refs\human.wav" xiaojingyu
//
// 行为：
//   1. 读 config.json 的 socialV2.voice.tts（model / baseUrl），缺省回退 src/tts-lib.js 的 TTS_DEFAULTS。
//   2. 凭据从环境变量 BAILIAN_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY 读取
//      （复用 readBailianApiKey，绝不把 key 写进 config）。
//   3. 本地音频转 base64 Data URI 走 input.audio 字段（免去先传 OSS）。
//   4. 域名优先级：workspace（config 的 baseUrl）→ dashscope 老域名（复刻域名与合成域名可能不同，现场验证）。
//   5. 轮询 query_voice 直到 status=OK，最后打印 voice_id。
//
// 样本要求：10~20 秒清晰人声朗读，WAV/MP3/M4A，≥16kHz，≤10MB，无背景音乐、不用唱歌录音。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBailianApiKey, TTS_DEFAULTS } from '../src/tts-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };

function loadTtsConfig() {
  try {
    const p = path.join(ROOT, 'config.json');
    let text = fs.readFileSync(p, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const cfg = JSON.parse(text);
    return { ...TTS_DEFAULTS, ...(cfg.socialV2?.voice?.tts ?? {}) };
  } catch {
    return TTS_DEFAULTS;
  }
}

function dataUriOf(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] ?? 'audio/wav';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 按下面统一报错 */ }
  return { status: res.status, ok: res.ok, data };
}

async function createVoice(baseUrl, apiKey, audioDataUri, prefix, targetModel) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/v1/services/audio/tts/customization`;
  return postJson(url, apiKey, {
    model: 'voice-enrollment',
    input: { action: 'create_voice', target_model: targetModel, prefix, audio: audioDataUri }
  });
}

async function queryVoice(baseUrl, apiKey, voiceId) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/v1/services/audio/tts/customization`;
  return postJson(url, apiKey, {
    model: 'voice-enrollment',
    input: { action: 'query_voice', voice_id: voiceId }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [fileArg, prefixArg] = process.argv.slice(2);
  if (!fileArg) {
    console.error('用法：node scripts/clone-voice.mjs <音频绝对路径> [前缀]');
    process.exit(2);
  }
  const file = path.resolve(fileArg);
  if (!fs.existsSync(file)) {
    console.error(`音频不存在：${file}`);
    process.exit(2);
  }

  const tts = loadTtsConfig();
  const apiKey = readBailianApiKey({});
  if (!apiKey) {
    console.error('缺少百炼 API key（环境变量 BAILIAN_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY）');
    process.exit(1);
  }
  const prefix = String(prefixArg || 'qqbridge').replace(/[^\w-]/g, '') || 'qqbridge';
  const targetModel = tts.model || 'cosyvoice-v3.5-plus';
  const audioDataUri = dataUriOf(file);
  const size = fs.statSync(file).size;

  console.log(`[clone] 样本=${file} (${size} B)`);
  console.log(`[clone] target_model=${targetModel} prefix=${prefix}`);

  // 域名优先级：workspace（config 的 baseUrl）→ dashscope 老域名。
  const bases = [];
  if (tts.baseUrl) bases.push(tts.baseUrl);
  if (!bases.includes('https://dashscope.aliyuncs.com')) bases.push('https://dashscope.aliyuncs.com');

  let voiceId = null;
  let usedBase = null;
  for (const base of bases) {
    console.log(`[clone] 尝试域名 ${base}`);
    try {
      const r = await createVoice(base, apiKey, audioDataUri, prefix, targetModel);
      const vid = r.data?.output?.voice_id;
      if (r.ok && vid) {
        voiceId = vid;
        usedBase = base;
        break;
      }
      const code = r.data?.code ?? r.status;
      const msg = r.data?.message ?? JSON.stringify(r.data);
      console.error(`[clone] ${base} 失败[${code}] ${msg}`);
    } catch (e) {
      console.error(`[clone] ${base} 异常：${e?.message ?? e}`);
    }
  }
  if (!voiceId) {
    console.error('[clone] 两个域名都复刻失败');
    process.exit(1);
  }
  console.log(`[clone] 已创建 voice_id=${voiceId}（域名 ${usedBase}）`);

  // 轮询直到 status=OK（一般几秒内，最长等 30s）。
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const q = await queryVoice(usedBase, apiKey, voiceId);
    const st = q.data?.output?.status;
    console.log(`[clone] 状态轮询 #${i + 1}: ${st ?? 'unknown'}`);
    if (st === 'OK') {
      ready = true;
      break;
    }
    if (st && st !== 'DEPLOYING' && st !== 'PENDING') {
      console.error(`[clone] 异常状态 ${st}: ${JSON.stringify(q.data)}`);
      process.exit(1);
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error('[clone] 等待超时（30s 未就绪），可稍后用 query_voice 再查');
    process.exit(1);
  }
  console.log(`[clone] 就绪 voice_id=${voiceId}`);
  console.log(voiceId);
}

main().catch((e) => {
  console.error('[clone] 异常：', e?.message ?? e);
  process.exit(1);
});
