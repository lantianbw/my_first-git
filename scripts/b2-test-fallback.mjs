// B2 验收：模拟 429/超时自动切换模型链并记录（不依赖 DSH 在线）。
// 覆盖：错误识别 → 逐档推进 → 最后一档保持 → 回探成功回主 → 回探失败留降级档 → 状态落盘。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FALLBACK_ERROR_RE, isFallbackError, normalizeChain, advanceFallback,
  activeModelChoice, noteProbeResult, loadModelFallback, saveModelFallback
} from '../src/model-fallback.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpState = path.join(root, 'state', 'model-fallback.test.json');
try { fs.rmSync(tmpState); } catch {}

const cfg = {
  provider: 'bailian', model: 'qwen3.8-flash',
  fallbackChain: [
    { provider: 'bailian', model: 'qwen3.8-flash' },
    { provider: 'sensenova', model: 'deepseek-v4-flash', reasoningEffort: 'none' },
    { provider: 'sensenova', model: 'sensenova-6.8-flash-lite', reasoningEffort: 'none' }
  ]
};
const chain = normalizeChain(cfg);
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };

// 1) 错误识别
ok('识别 429', isFallbackError('HTTP 429: Too Many Requests'));
ok('识别限流', isFallbackError('rate limit exceeded, retry later'));
ok('识别额度不足', isFallbackError('Arrearage: 额度不足，请充值'));
ok('识别超时', isFallbackError('request timed out after 30000ms'));
ok('不误判参数错误', !isFallbackError('INVALID_ARGUMENT: model not found'));
ok('不误判 not-found', !isFallbackError('session not-found'));

// 2) 逐档推进
let state = loadModelFallback(tmpState);
let now = Date.parse('2026-10-26T02:10:00+08:00');
let r1 = advanceFallback(state, chain, { now, error: 'HTTP 429: Too Many Requests' });
ok(`429 后切到第 2 档（${r1.entry.provider}/${r1.entry.model}）`, r1.changed && r1.entry.model === 'deepseek-v4-flash');
let r2 = advanceFallback(r1.state, chain, { now: now + 60000, error: 'timeout' });
ok('再失败切到第 3 档', r2.changed && r2.entry.model === 'sensenova-6.8-flash-lite');
let r3 = advanceFallback(r2.state, chain, { now: now + 120000, error: '429 again' });
ok('最后一档不再推进', !r3.changed);
saveModelFallback(tmpState, r2.state);
ok('状态落盘可回读', loadModelFallback(tmpState).index === 2);

// 3) 降级期内的选择
let pick = activeModelChoice(r2.state, chain, { now: now + 5 * 60 * 1000 }); // 降级后 5 分钟
ok('降级窗口内用第 3 档', !pick.probing && pick.entry.model === 'sensenova-6.8-flash-lite');
let pick2 = activeModelChoice(r2.state, chain, { now: now + 31 * 60 * 1000 }); // 30 分钟后
ok('到期后回探主模型', pick2.probing && pick2.entry.model === 'qwen3.8-flash');

// 4) 回探结果
let back = noteProbeResult(r2.state, chain, true, { now: now + 31 * 60 * 1000 });
ok('回探成功回主档', back.index === 0);
let stay = noteProbeResult(r2.state, chain, false, { now: now + 31 * 60 * 1000, error: '429 still' });
ok('回探失败留降级档并推迟', stay.index === 2 && stay.probeDueAt > now + 31 * 60 * 1000);

// 5) 历史记录
ok('历史记录 2 条（含两次推进+失败原因）', r2.state.history.length === 2 && r2.state.history[0].error.includes('429'));

fs.rmSync(tmpState);
console.log(`\nB2 模拟验收：${pass} pass / ${fail} fail —— ${fail === 0 ? 'PASS（模拟 429 能自动切换并记录）' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
