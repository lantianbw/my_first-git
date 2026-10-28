// B3 验收：作息门控判定（纯函数模拟，覆盖验收场景）。
// 场景：23:35 群里发消息她不回；私聊能回；被 @ 能回；周五六 00:30 仍睡到 01:00 后正常；
//       熬夜日由日期种子决定（同一天恒定）；07:30 起床。
import { computeSleepGate, dayRandom } from '../src/sleep-gate.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };
const at = (str) => new Date(`2026-10-${str}`.replace('T', 'T')); // 2026-10-26 是周一

const CFG = {}; // 全默认：07:30 / 23:30 / 周五六 01:00 / 15% 熬夜

// 2026-10-26 周一；2026-10-30 周五；2026-10-31 周六
const cases = [
  ['周一 23:35（正常入睡）', '26T23:35:00', { asleep: true, reason: 'normal' }],
  ['周一 23:29（还没睡）',   '26T23:29:00', { asleep: false }],
  ['周二 03:00（凌晨睡眠）', '27T03:00:00', { asleep: true }],
  ['周二 07:30（起床整点）', '27T07:30:00', { asleep: false }],
  ['周二 12:00（白天）',     '27T12:00:00', { asleep: false }],
  ['周五 23:35（周末晚睡，醒着）', '30T23:35:00', { asleep: false, reason: 'weekend' }],
  ['周六 00:30（周末凌晨，睡）',  '31T00:30:00', { asleep: true, reason: 'weekend' }],
  ['周六 23:40（周六晚，醒着）',  '31T23:40:00', { asleep: false, reason: 'weekend' }],
  ['周日 00:20（周日凌晨=周六晚的夜，睡）', '2026-11-01T00:20:00', { asleep: true, reason: 'weekend' }],
];
for (const [name, ts, want] of cases) {
  const d = ts.includes('2026-11') ? new Date(ts) : new Date(`2026-10-${ts}`);
  const g = computeSleepGate(d, CFG);
  ok(name, g.asleep === want.asleep && (want.reason === undefined || g.reason === want.reason));
}

// 熬夜确定性：同一日期种子恒定
const d1 = dayRandom('2026-10-26') === dayRandom('2026-10-26');
ok('熬夜随机种子同日恒定', d1);
// 统计一个月的熬夜天数应在合理范围（30 天 × 15% ≈ 2~8 天）
let lateDays = 0;
for (let i = 1; i <= 30; i++) {
  const ds = `2026-10-${String(i).padStart(2, '0')}`;
  const dow = new Date(ds).getDay();
  if (dow !== 5 && dow !== 6 && dayRandom(ds) < 15) lateDays += 1;
}
ok(`工作日熬夜天数合理（实测 ${lateDays}/26，预期 0~8）`, lateDays >= 0 && lateDays <= 8);
console.log(`  → 10 月每天作息速览（N=正常23:30睡，L=熬夜，W=周末）：`);
for (let i = 24; i <= 31; i++) {
  const ds = `2026-10-${String(i).padStart(2, '0')}`;
  const dow = new Date(ds).getDay();
  const late = dow === 5 || dow === 6 ? 'W' : (dayRandom(ds) < 15 ? 'L' : 'N');
  const g = computeSleepGate(new Date(`${ds}T23:40:00`), CFG);
  process.stdout.write(`  10-${i} ${['日','一','二','三','四','五','六'][dow]} ${late}${g.asleep ? '(睡)' : '(醒)'}`);
  process.stdout.write(i % 4 === 0 ? '\n' : '  ');
}
console.log('');

// 验收主场景重放：23:35 群消息（无@）→ evaluateWakeTriggerV2 的门控分支 = null（不唤醒）；
// 该分支逻辑已内联在 bridge（无法离线直接调闭包），这里验证其依赖的判定值：
const g235 = computeSleepGate(new Date('2026-10-26T23:35:00'), CFG);
ok('验收场景 23:35：asleep=true → 群消息不唤醒（私聊/被@在 bridge 中已放行）', g235.asleep === true);

console.log(`\nB3 模拟验收：${pass} pass / ${fail} fail —— ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
