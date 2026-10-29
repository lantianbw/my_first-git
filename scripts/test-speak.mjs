// qq_speak（TTS 语音合成发送）自检：
// 1) tts-lib 纯函数：instruction 权重、费用估算、WAV 头解析、心情→语气映射、凭据读取、
//    缓存索引、目录清理（保留最近 N 个）
// 2) speakFlow 编排（假 TTS + 假发送）：文件落到 audio/tts/、走 sendVoice 链路、verified 透传、
//    24h 缓存复用（只合成一次）、出站守卫/超长拦截、发送失败不重复计费、限流第 3 条被拦
// 3) 接线存在性：bridge 路由 / 工具开关默认值 / MCP 注册 / config 键 / 配置里没有明文 key
//
// 默认**不调真实 TTS、不发真实 QQ 消息**（要花真钱、产生不可撤回的消息）。
// 真实链路验证用 tools/tts-batch.mjs --tones（只合成不发送）与 QQ 里的实际对话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TONE_MAP,
  assertInstructionOk,
  batchTtsFileName,
  cleanupTtsDir,
  countChars,
  ensureTtsAudio,
  estimateCostYuan,
  findCachedEntry,
  instructionWeight,
  loadTtsIndex,
  matchToneGroup,
  readBailianApiKey,
  resolveToneInstruction,
  runtimeTtsFileName,
  saveTtsIndex,
  sanitizeFileToken,
  speakFlow,
  ttsCacheKey,
  wavInfoFromBuffer
} from '../src/tts-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}
function throwsWith(fn, substr, name) {
  try {
    fn();
    ok(false, `${name}（没有抛错）`);
  } catch (e) {
    ok(String(e?.message ?? e).includes(substr), `${name}（${String(e?.message).slice(0, 60)}）`);
  }
}
async function rejectsWith(fn, substr, name) {
  try {
    await fn();
    ok(false, `${name}（没有抛错）`);
  } catch (e) {
    ok(String(e?.message ?? e).includes(substr), `${name}（${String(e?.message).slice(0, 60)}）`);
  }
}

// ── fixture：手搓一个 1 秒 24kHz 单声道 16bit WAV ──────────────────────────
function makeWavBuffer({ seconds = 1, sampleRate = 24000, channels = 1, bits = 16 } = {}) {
  const dataBytes = Math.round(seconds * sampleRate * channels * (bits / 8));
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  buf.writeUInt16LE(channels * bits / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

const FIXTURE_WAV = makeWavBuffer({ seconds: 1 });

console.log('## tts-lib 纯函数');
{
  ok(instructionWeight('abc') === 3 && instructionWeight('你好') === 4 && instructionWeight('a你') === 3, 'instructionWeight 汉字算 2');
  ok(instructionWeight('语气'.repeat(25)) === 100, 'instructionWeight 50 个汉字 = 100（临界）');
  throwsWith(() => assertInstructionOk('语气'.repeat(26)), '过长', 'assertInstructionOk 超 100 拒绝');
  assertInstructionOk('轻快，尾音上扬');

  ok(countChars('  晚安 ') === 2 && countChars('真的假?') === 4, 'countChars 去空白计码点');
  const c18 = estimateCostYuan(18, 2);
  ok(c18 > 0.003 && c18 < 0.004, `estimateCostYuan 18 字 ≈ 0.003 元（实际 ${c18}）`);
  ok(estimateCostYuan(10000, 2) === 2, 'estimateCostYuan 万字 = 单价');

  const info = wavInfoFromBuffer(FIXTURE_WAV);
  ok(info?.sampleRate === 24000 && info?.channels === 1 && info?.bits === 16, 'wavInfoFromBuffer 读头部参数');
  ok(info?.durationSec === 1, `wavInfoFromBuffer 时长 1s（实际 ${info?.durationSec}）`);
  ok(wavInfoFromBuffer(Buffer.from('not a wav at all....')) === null, 'wavInfoFromBuffer 非 WAV 返回 null');
}

console.log('## 心情 → 语气映射');
{
  const t1 = resolveToneInstruction({ tone: '松快' });
  ok(t1.via === 'tone-map' && t1.toneKey === '松快' && t1.instruction.includes('轻快'), '显式 tone 命中映射');
  const t2 = resolveToneInstruction({ moodWord: '被逗到' });
  ok(t2.via === 'mood' && t2.toneKey === '逗' && t2.instruction.includes('憋笑'), '心情词「被逗到」→ 逗（憋笑）');
  const t3 = resolveToneInstruction({ moodWord: '软下来' });
  ok(t3.via === 'mood' && t3.toneKey === '软', '心情词「软下来」→ 软');
  const t4 = resolveToneInstruction({ hour: 23, moodWord: null });
  ok(t4.via === 'night' && t4.toneKey === '困', '深夜 23 点无心情 → 困');
  const t4b = resolveToneInstruction({ hour: 2 });
  ok(t4b.via === 'night', '凌晨 2 点 → 困');
  const t5 = resolveToneInstruction({ hour: 14 });
  ok(t5.via === 'default' && t5.instruction === '自然地说', '无 tone 无心情白天 → 默认自然');
  const t6 = resolveToneInstruction({ moodWord: '松快了', hour: 23 });
  ok(t6.via === 'mood' && t6.toneKey === '松快', '心情命中优先于深夜兜底');
  const t7 = resolveToneInstruction({ tone: '像刚跑完八百米喘着说' });
  ok(t7.via === 'tone-raw' && t7.instruction === '像刚跑完八百米喘着说', '未知 tone 透传为自然语言指令');
  throwsWith(() => resolveToneInstruction({ tone: '语气'.repeat(30) }), '过长', '透传指令超长被拒');

  const custom = resolveToneInstruction({ moodWord: 'emo了', toneMap: { 'emo/难过': '声音沉一点', '默认/自然': '平静地说' } });
  ok(custom.instruction === '声音沉一点', 'config 自定义 toneMap 覆盖生效');
  ok(matchToneGroup('草', DEFAULT_TONE_MAP) === null, '单字词不做子串误匹配');
  ok(matchToneGroup('有点闷', DEFAULT_TONE_MAP)?.primary === '闷', '「有点闷」子串命中 闷 组');
  ok(matchToneGroup('生气', DEFAULT_TONE_MAP)?.primary === '生气', '「生气」精确命中');
}

console.log('## 凭据读取（fixture，不碰真实 key）');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speak-cred-'));
  const cred = path.join(tmp, 'credentials.yaml');
  fs.writeFileSync(cred, 'version: 1\nrefs:\n  BAILIAN_API_KEY: "sk-test-fake-not-real"\n  OTHER: x\n', 'utf8');
  const key = readBailianApiKey({ envVar: 'QQ_SPEAK_TEST_NO_ENV', credentialsFile: cred, apiKeyRef: 'BAILIAN_API_KEY' });
  ok(key === 'sk-test-fake-not-real', 'yaml refs.BAILIAN_API_KEY 解析');
  const broken = path.join(tmp, 'broken.yaml');
  fs.writeFileSync(broken, 'refs: [unclosed\n  BAILIAN_API_KEY: sk-regex-fallback\n', 'utf8');
  ok(readBailianApiKey({ envVar: 'QQ_SPEAK_TEST_NO_ENV', credentialsFile: broken, apiKeyRef: 'BAILIAN_API_KEY' }) === 'sk-regex-fallback', 'yaml 损坏时正则兜底');
  ok(readBailianApiKey({ envVar: 'QQ_SPEAK_TEST_NO_ENV', credentialsFile: path.join(tmp, 'nope.yaml') }) === null, '文件缺失返回 null');
}

console.log('## 缓存索引与清理');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speak-idx-'));
  const ttsDir = path.join(tmp, 'tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  const indexFile = path.join(ttsDir, 'index.json');
  // 205 个 wav：把前 5 个的 mtime 调旧，它们应当被清掉（保留最近 200 ≈ 40MB 的服务器适配策略）
  const names = [];
  for (let i = 0; i < 205; i++) {
    const f = path.join(ttsDir, `a${String(i).padStart(3, '0')}.wav`);
    fs.writeFileSync(f, FIXTURE_WAV);
    names.push(path.basename(f));
  }
  for (let i = 0; i < 5; i++) fs.utimesSync(path.join(ttsDir, names[i]), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const index = { entries: names.map((f, i) => ({ file: f, cacheKey: `k${i}`, text: `t${i}`, createdAt: Date.now() })) };
  const res = cleanupTtsDir(ttsDir, index, 200);
  ok(res.removed === 5 && res.kept === 200, `保留 200 删 5（实际删 ${res.removed} 留 ${res.kept}）`);
  ok(res.index.entries.length === 200, '索引同步剪掉被删文件的条目');

  // 写盘 → 加一个文件已不存在的幽灵条目 → 重新加载应丢弃
  saveTtsIndex(indexFile, res.index);
  const withGhost = { ...res.index, entries: [...res.index.entries, { file: 'ghost.wav', cacheKey: 'ghost' }] };
  saveTtsIndex(indexFile, withGhost);
  const round = loadTtsIndex(indexFile, ttsDir);
  ok(round.entries.length === 200, `加载时丢弃文件已丢失的条目（实际 ${round.entries.length}）`);

  const hit = findCachedEntry({ entries: [{ cacheKey: ttsCacheKey('晚安', '自然地说'), createdAt: Date.now() - 1000, file: 'x.wav' }] }, { text: '晚安', instruction: '自然地说' });
  ok(!!hit, 'findCachedEntry 命中未过期条目');
  const expired = findCachedEntry({ entries: [{ cacheKey: ttsCacheKey('晚安', '自然地说'), createdAt: Date.now() - 25 * 3600 * 1000, file: 'x.wav' }] }, { text: '晚安', instruction: '自然地说' });
  ok(!expired, 'findCachedEntry 超过 24h 不复用');
  ok(ttsCacheKey('晚安', '轻快') !== ttsCacheKey('晚安', '自然地说'), '缓存键区分语气');

  ok(/^\d{8}-\d{6}-[0-9a-f]{12}\.wav$/.test(runtimeTtsFileName('晚安', '自然地说')), `运行时文件名格式 ${runtimeTtsFileName('晚安', '自然地说')}`);
  ok(batchTtsFileName('困', 1, '我先睡了') === '困-01-我先睡了.wav', `批量文件名格式 ${batchTtsFileName('困', 1, '我先睡了')}`);
  ok(sanitizeFileToken('a/b:c*d?', 6) === 'abcd', '文件名净化去非法字符');
}

console.log('## speakFlow 编排（假 TTS / 假发送）');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speak-flow-'));
  const voiceDir = path.join(tmp, 'audio');       // 模拟语音库 audio/
  const ttsDir = path.join(voiceDir, 'tts');      // qq_speak 落盘点 audio/tts/
  fs.mkdirSync(ttsDir, { recursive: true });
  const indexFile = path.join(ttsDir, 'index.json');

  let synthCalls = 0;
  let sendCalls = [];
  const fakeSent = { messageId: 10086, detail: '1秒 · 48 KB', warnings: [], verification: { confirmed: true } };

  const ensureAudio = ({ text, instruction, toneKey }) => ensureTtsAudio(
    { text, instruction, toneKey },
    {
      ttsDir,
      indexFile,
      cacheTtlMs: 86400000,
      keepFiles: 200,
      pricePer10kChars: 2,
      // 假 TTS：返回固定 wav（经本地文件 URL「下载」）
      synth: async () => {
        synthCalls += 1;
        const fakeUrl = path.join(tmp, `fake-${synthCalls}.wav`);
        fs.writeFileSync(fakeUrl, FIXTURE_WAV);
        return { audioUrl: `file://${fakeUrl.replace(/\\/g, '/')}`, requestId: `req-${synthCalls}` };
      },
      download: async (audioUrl, dest) => {
        fs.copyFileSync(audioUrl.replace(/^file:\/\//, ''), dest);
        return { bytes: FIXTURE_WAV.length };
      }
    }
  );
  // 假 sendVoice 工厂：limitPerMinute>0 时带 bridge 同款限流语义（验证完限流要换新实例，
  // 否则前面用例的发送记录会把后面的用例误拦——shared 可变状态在测试里是坑）。
  const makeSendVoice = ({ limitPerMinute = 0 } = {}) => {
    let budgetTimes = [];
    return async (key, relFile, opts) => {
      if (limitPerMinute > 0) {
        const now = Date.now();
        budgetTimes = budgetTimes.filter((t) => now - t < 60000);
        if (budgetTimes.length + 1 > limitPerMinute) throw new Error(`语音发送频率超限（每分钟最多 ${limitPerMinute} 条），请稍后再试`);
        budgetTimes.push(now);
      }
      sendCalls.push({ key, relFile, opts });
      return { ...fakeSent };
    };
  };

  const deps = (over = {}) => ({
    maxChars: 120,
    guardText: () => ({ ok: true }),
    moodWord: () => '被逗到',
    hour: 14,
    toneMap: DEFAULT_TONE_MAP,
    ensureAudio,
    sendVoice: makeSendVoice(),
    log: () => {},
    usage: () => {},
    ...over
  });

  // 验收 1：假 TTS 返回固定 wav → 文件落 audio/tts/ 且调用 sendVoice
  const r1 = await speakFlow({ key: 'private:123', text: ' 笑死，真的假的 ', tone: '逗', label: '笑了' }, deps());
  ok(fs.existsSync(path.join(ttsDir, r1.file)), `wav 落到 audio/tts/（${r1.file}）`);
  ok(sendCalls.length === 1 && sendCalls[0].relFile.startsWith('tts/') && sendCalls[0].relFile.endsWith('.wav'), `sendVoice 收到库内相对路径 ${sendCalls[0]?.relFile}`);
  ok(sendCalls[0].key === 'private:123' && sendCalls[0].opts.label === '笑了', 'key/label 透传给发送链');
  ok(r1.verified === true, 'verified=true 透传（回读校验确认）');
  ok(r1.toneKey === '逗' && r1.via === 'tone-map' && r1.chars === 7, `语气/字符数正确（tone=${r1.toneKey} chars=${r1.chars}）`);
  ok(r1.durationSec === 1, `时长来自 WAV 头（${r1.durationSec}s）`);
  ok(r1.costYuan > 0.001 && r1.costYuan < 0.002, `费用估算（${r1.costYuan} 元）`);
  const idx = loadTtsIndex(indexFile, ttsDir);
  ok(idx.entries.length === 1 && idx.entries[0].text === '笑死，真的假的' && idx.entries[0].tone === '逗', 'index.json 登记 text/tone/费用');

  // 缓存：同 text+tone 24h 内复用，不重复计费
  const r2 = await speakFlow({ key: 'private:123', text: '笑死，真的假的', tone: '逗' }, deps());
  ok(r2.cached === true && synthCalls === 1, `第二次命中缓存（cached=${r2.cached}，合成次数 ${synthCalls}）`);
  // 语气不同 ⇒ 不算同一条缓存
  const r3 = await speakFlow({ key: 'private:123', text: '笑死，真的假的', tone: '生气' }, deps());
  ok(r3.cached === false && synthCalls === 2, '不同语气重新合成（缓存键含 instruction）');

  // 心情自动选语气：不传 tone，moodWord=被逗到
  const r4 = await speakFlow({ key: 'private:123', text: '救命' }, deps());
  ok(r4.toneKey === '逗' && r4.via === 'mood', '不传 tone 时按当前心情选语气');

  // 出站守卫拦截：抛错且不进发送链
  const sentBefore = sendCalls.length;
  const blocked = deps({ guardText: () => ({ ok: false, reason: '疑似地址' }) });
  await rejectsWith(() => speakFlow({ key: 'private:123', text: '晚安' }, blocked), '出站守卫', '守卫拦截时抛错');
  ok(sendCalls.length === sentBefore, '守卫拦截时不会调用 sendVoice');

  // 文本校验
  await rejectsWith(() => speakFlow({ key: 'private:123', text: '长'.repeat(121) }, deps()), '过长', '超过 120 字拒绝');
  await rejectsWith(() => speakFlow({ key: 'private:123', text: '   ' }, deps()), '不能为空', '空白文本拒绝');

  // 发送失败（模拟网关错）：错误透传，重试同一句不重复计费（文件保留在缓存里）
  const failSend = deps({ sendVoice: async () => { throw new Error('OneBot send_private_msg 失败'); } });
  const t0 = synthCalls;
  await rejectsWith(() => speakFlow({ key: 'private:123', text: '离谱' }, failSend), 'OneBot', '发送失败错误透传');
  await rejectsWith(() => speakFlow({ key: 'private:123', text: '离谱' }, failSend), 'OneBot', '重试仍失败也如实报错');
  ok(synthCalls === t0 + 1, `失败重试同一句不重复合成（${t0}→${synthCalls}）`);

  // 验收 3（限流语义）：1 分钟内第 3 条被拦（限流是 deps.sendVoice —— 即真桥里 sendVoiceForV2 的职责）
  sendCalls = [];
  const limited = deps({ sendVoice: makeSendVoice({ limitPerMinute: 2 }) });
  const results = [];
  for (const t of ['在', '草', '就这']) {
    try { results.push(await speakFlow({ key: 'group:999', text: t }, limited)); }
    catch (e) { results.push({ error: String(e?.message ?? e) }); }
  }
  ok(Boolean(results[0]?.file) && Boolean(results[1]?.file), '前两条发送成功');
  ok(String(results[2]?.error).includes('每分钟最多 2 条'), `第 3 条被限流拦下（${String(results[2]?.error).slice(0, 40)}）`);
  ok(sendCalls.length === 2, '被拦的那条没有进发送链');

  // usage 记账钩子收到 chars/费用/cached
  let usageSeen = null;
  const withUsage = deps({ usage: (u) => { usageSeen = u; } });
  await speakFlow({ key: 'private:123', text: '你猜' }, withUsage);
  ok(usageSeen?.chars === 2 && usageSeen.costYuan > 0 && typeof usageSeen.cached === 'boolean', 'usage 记账钩子字段齐全');
}

console.log('## 接线存在性（bridge / MCP / config）');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  const cfgText = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  const cfg = JSON.parse(cfgText);

  ok(bridge.includes("'/api/socialV2/speak'"), 'bridge 注册了 /api/socialV2/speak 路由');
  ok(bridge.includes("v2ToolEnabled('speak')"), 'speak 路由校验 tools.speak 开关');
  ok(bridge.includes('speakFlow') && bridge.includes('sendVoiceForV2'), 'speak 流程复用 sendVoiceForV2 发送链');
  ok(bridge.includes("'sendVoice', 'speak'"), '控制台 toolFlags 归一化包含 speak');
  ok(bridge.includes('speak: false'), '工具默认表 speak 默认关闭（保守默认）');
  ok(bridge.includes("speak: 'qq_speak'"), 'enabledTools 提示包含 qq_speak');
  ok(bridge.includes('appendTtsUsage') && bridge.includes('tts-usage.jsonl'), '费用记账落到 state/tts-usage.jsonl');

  ok(mcp.includes("'qq_speak'") && mcp.includes("qq_speak: 'speak'"), 'MCP 注册 qq_speak（注册期开关过滤）');
  ok(mcp.includes('/api/socialV2/speak'), 'MCP 工具调 /api/socialV2/speak');

  ok(cfg.socialV2?.tools?.speak === true, 'config.json 已打开 socialV2.tools.speak');
  // 断言「有复刻音色且与模型绑定一致」，而不是钉死某个具体音色——
  // 换模型（cosyvoice ⇄ qwen-audio-tts ⇄ …）时音色必然要重新复刻，
  // 钉死具体值会让每次换模型都误报；但「voiceId 必须由该 model 复刻而来」
  // 是百炼的硬约束（音色绑定 target_model，跨模型会合成失败），必须校验。
  const ttsCfg = cfg.socialV2?.voice?.tts ?? {};
  ok(typeof ttsCfg.voiceId === 'string' && ttsCfg.voiceId.length > 0, 'config 记录复刻音色 voiceId');
  ok(typeof ttsCfg.model === 'string' && ttsCfg.model.length > 0, 'config 记录目标模型');
  ok(ttsCfg.voiceId.startsWith(ttsCfg.model), 'voiceId 由当前 model 复刻（音色不能跨模型复用）');
  ok(cfg.socialV2?.voice?.toneMap && Object.keys(cfg.socialV2.voice.toneMap).length >= 6, 'config 携带可覆盖 toneMap');
  ok(cfg.socialV2?.voice?.tts?.credentialsFile === '~/.dsh/.credentials.yaml', '凭据走 credentials.yaml 指针');
  ok(!/sk-[A-Za-z0-9]{16,}/.test(cfgText), 'config.json 没有明文 API key');
  ok(!/Bearer\s+[A-Za-z0-9_-]{16,}/.test(cfgText), 'config.json 没有 Bearer 明文令牌');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
