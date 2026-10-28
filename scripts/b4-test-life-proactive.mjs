// B4 验收：生活型主动判定（纯函数模拟）。
// 场景：起床后 30 分钟没人找 → 起床号；有人找过 → 不发；刷到好玩的：有素材/无素材、
// 次数上限、间隔、睡眠期、群正忙。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldMorningPoke, shouldDiscoveryShare, loadMaterialDigest } from '../src/life-proactive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };
const T = (h, m = 0) => new Date(`2026-10-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`); // 周一
const fresh = { date: '2026-10-26', morningSentAt: 0, discoveryTimes: [] };
const wakeToday = T(7, 30).getTime();

// ── 起床号 ──
ok('08:00 没人找 → 发', shouldMorningPoke({ now: T(8, 0), lastIncomingAt: wakeToday - 3600e3, state: fresh }).ok);
ok('07:50 还没到点 → 不发', !shouldMorningPoke({ now: T(7, 50), lastIncomingAt: 0, state: fresh }).ok);
ok('07:45 有人找过（07:40 来过消息）→ 不发', !shouldMorningPoke({ now: T(8, 0), lastIncomingAt: T(7, 40).getTime(), state: fresh }).ok);
ok('今天已发过 → 不发', !shouldMorningPoke({ now: T(8, 5), lastIncomingAt: 0, state: { ...fresh, morningSentAt: T(8, 0).getTime() } }).ok);
ok('08:20 过窗 → 不补发', !shouldMorningPoke({ now: T(8, 20), lastIncomingAt: 0, state: fresh }).ok);
ok('昨晚的旧消息不算「今天有人找」', shouldMorningPoke({ now: T(8, 0), lastIncomingAt: T(23, 0).getTime() - 24 * 3600e3, state: fresh }).ok);

// ── 刷到好玩的 ──
const digest = { date: '2026-10-26', items: [{ source: 'B站', title: '某热榜第一', angle: '离谱' }, { source: '抖音', title: '某热点' }] };
const sleepCfg = { wakeTime: '07:30', sleepTime: '23:30', weekendSleepTime: '01:00', lateNightProbability: 0 };
ok('12:00 有素材+首刷 → 发', shouldDiscoveryShare({ now: T(12, 0), digest, state: fresh, sleepCfg }).ok);
ok('无素材 → 不发', !shouldDiscoveryShare({ now: T(12, 0), digest: null, state: fresh, sleepCfg }).ok);
ok('当天已 2 次 → 不发', !shouldDiscoveryShare({ now: T(16, 0), digest, state: { ...fresh, discoveryTimes: [T(9, 0).getTime(), T(13, 0).getTime()] }, sleepCfg }).ok);
ok('距上次不足 4h → 不发', !shouldDiscoveryShare({ now: T(11, 0), digest, state: { ...fresh, discoveryTimes: [T(9, 0).getTime()] }, sleepCfg }).ok);
ok('距上次 ≥4h 且未到上限 → 发', shouldDiscoveryShare({ now: T(13, 30), digest, state: { ...fresh, discoveryTimes: [T(9, 0).getTime()] }, sleepCfg }).ok);
ok('深夜（23:40，周一正常入睡）→ 不发', !shouldDiscoveryShare({ now: T(23, 40), digest, state: fresh, sleepCfg }).ok);
ok('群里 5 分钟前还在聊 → 不打断', !shouldDiscoveryShare({ now: T(12, 0), digest, state: fresh, groupLastIncomingAt: T(11, 55).getTime(), quietGroupMs: 10 * 60 * 1000, sleepCfg }).ok);
ok('群里 20 分钟没说话 → 可发', shouldDiscoveryShare({ now: T(12, 0), digest, state: fresh, groupLastIncomingAt: T(11, 40).getTime(), quietGroupMs: 10 * 60 * 1000, sleepCfg }).ok);

// 素材文件读取（当天性校验）
const tmp = path.join(root, 'state', 'material-digest.test.json');
fs.writeFileSync(tmp, JSON.stringify({ date: '2026-10-26', items: [{ title: 'a' }] }), 'utf8');
ok('素材文件当天可读', !!loadMaterialDigest(tmp, { now: T(12, 0) }));
ok('素材文件过期不读（昨天）', loadMaterialDigest(tmp, { now: new Date('2026-10-27T12:00:00') }) === null);
fs.rmSync(tmp);

// 日志格式验收：bridge 的 appendActivity 行（见 lifeProactiveTick 内的文案）
console.log('验收日志样例（bridge 运行时写入 qq-activity.log）：');
console.log('  [life-proactive] 起床号：2026-10-26 起床后 30 分钟无人来找，主动戳 private:1843979560（生活节律额度，不走常规主动配额）');
console.log('  [life-proactive] 刷到好玩的：2026-10-26 第 1 次素材分享唤醒 group:1057896469（素材 2 条，上限 2）');

console.log(`\nB4 模拟验收：${pass} pass / ${fail} fail —— ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
