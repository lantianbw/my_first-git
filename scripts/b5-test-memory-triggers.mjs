// B5 验收：记忆写入触发点判定（纯函数模拟）。
// 场景：睡前日记窗口 / 已触发不重复 / 晚睡日窗口；周日归拢窗口与周去重；
// 承诺/纠正信号检测（含样本里的真实句子）；昨日日记缺失判定。
import { detectCommitment, detectCorrection, diaryNeedsBackfill, shouldDiarySettle, shouldWeeklyDigest, isoWeek } from '../src/memory-triggers.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };
const T = (s) => new Date(`2026-10-${s}`); // 2026-10-25 周日 / 26 周一

// ── 睡前日记 ──
ok('周一 23:25 进入窗口 → 触发', shouldDiarySettle({ now: T('26T23:25:00'), state: { date: '', diarySettleAt: 0 } }).ok);
ok('周一 23:35 仍在窗口 → 触发', shouldDiarySettle({ now: T('26T23:35:00'), state: { date: '', diarySettleAt: 0 } }).ok);
ok('周一 22:00 未到 → 不触发', !shouldDiarySettle({ now: T('26T22:00:00'), state: { date: '', diarySettleAt: 0 } }).ok);
ok('当天已触发 → 不重复', !shouldDiarySettle({ now: T('26T23:30:00'), state: { date: '2026-10-26', diarySettleAt: T('26T23:25:00').getTime() } }).ok);
ok('晚睡日 00:00 补位窗口 → 触发', shouldDiarySettle({ now: new Date('2026-10-31T00:00:00'), sleepTime: '23:30', lateTime: '01:00', state: { date: '', diarySettleAt: 0 } }).ok);

// ── 周日归拢 ──
ok('周日 21:10 → 触发（本周未做）', shouldWeeklyDigest({ now: T('25T21:10:00'), state: { weeklyDigestWeek: '' } }).ok);
ok('周六 21:10 → 不触发', !shouldWeeklyDigest({ now: T('24T21:10:00'), state: { weeklyDigestWeek: '' } }).ok);
ok('周日 20:00 未到窗 → 不触发', !shouldWeeklyDigest({ now: T('25T20:00:00'), state: { weeklyDigestWeek: '' } }).ok);
const wk = isoWeek(new Date('2026-10-25'));
ok(`本周（${wk}）已做 → 不重复`, !shouldWeeklyDigest({ now: T('25T21:20:00'), state: { weeklyDigestWeek: wk } }).ok);

// ── 承诺信号（用真实样本句回放）──
ok('「明天周六，睡醒第一件事催罐头」→ 承诺', detectCommitment('明天周六，睡醒第一件事催罐头'));
ok('「26号罐头定金，一笔不落」→ 承诺', detectCommitment('26号罐头定金'));
ok('「今晚升级和夜宵，能兑现一个不」→ 承诺', detectCommitment('今晚升级和夜宵能兑现一个不'));
ok('「说定了，输的那个负责开罐头」→ 承诺', detectCommitment('说定了，输的那个负责开罐头'));
ok('普通闲聊「今天天气不错」→ 非承诺', !detectCommitment('今天天气不错'));

// ── 纠正信号（真实事故句回放）──
ok('「你怎么乱认爹」→ 纠正', detectCorrection('😡你怎么乱认爹'));
ok('「那是你王江叔叔」→ 纠正', detectCorrection('那是你王江叔叔'));
ok('「是小昔涟哦」→ 非纠正（介绍新角色，不误报）', !detectCorrection('是小昔涟哦'));
ok('「我们头像不一样啊」→ 非纠正', !detectCorrection('我们头像不一样啊'));

// ── 漏写提醒 ──
const y = new Date(Date.now() - 24 * 3600e3);
const yTs = y.getTime();
ok('昨天无日记 → 需要补', diaryNeedsBackfill([], new Date()));
ok('昨天有日记 → 不提醒', !diaryNeedsBackfill([{ createdAt: yTs }], new Date()));
ok('只有前天的日记 → 仍提醒', diaryNeedsBackfill([{ createdAt: yTs - 24 * 3600e3 }], new Date()));

console.log('验收日志样例（bridge 运行时写入 qq-activity.log）：');
console.log('  [memory-trigger] 睡前日记提醒：2026-10-26 23:25:03 触发 diarySettle 唤醒 private:1843979560（今天/感受/没说出口，≤3 行）');
console.log('  [memory-trigger] 周日归拢：2026-W43 触发 weeklyDigest 唤醒 private:1843979560（本周日记压成 1 条 profile 印象）');
console.log('wake prompt 注入样例：');
console.log('  【约定要落账】最近一条消息像是一个约定/承诺（大肥鱼说的）。现在就调用 qq_memo(type=agenda) 把它记下来…');
console.log('  【被纠正要长记性】对方在纠正你。先认（别辩解），然后调用 qq_memo(type=profile) 记一条雷/教训…');
console.log('  【昨日日记缺失】昨天没有日记。现在补一句也行（qq_diary 写昨天印象最深的 1 件小事，别硬凑）…');

console.log(`\nB5 模拟验收：${pass} pass / ${fail} fail —— ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('注：「跑三天日记从 0 变 3 篇」需桥接在线运行三天后复核 state/diary.json 条数（本机桥停用中）。');
process.exit(fail === 0 ? 0 : 1);
