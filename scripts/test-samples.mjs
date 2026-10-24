// 对话样本导出回归：格式化/幂等/清理/配置归一。
import assert from 'node:assert/strict';
import {
  normalizeSamplesConfig,
  formatSamplesMarkdown,
  sampleDateKey,
  shouldRunSample,
  markSampleRun,
  pruneSampleFiles
} from '../src/samples.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ts = new Date(2026, 9, 23, 11, 50, 0).getTime();

test('格式化：key 分段、HH:mm、isSelf→我、单行截断', () => {
  const content = formatSamplesMarkdown({
    'group:1': {
      recentMessages: [
        { time: ts, sender: '张三', text: 'x'.repeat(130) },
        { time: ts, isSelf: true, text: '我发的' },
        { time: ts, sender: '李四', text: '多行\n内容' }
      ]
    },
    'private:2': { recentMessages: [] }
  }, { date: '2026-10-23', maxCharsPerLine: 120 });

  assert.ok(content.startsWith('# 对话样本 2026-10-23'));
  assert.ok(content.includes('## group:1'));
  assert.ok(!content.includes('## private:2'), '空会话不输出');
  assert.ok(content.includes('11:50 张三：' + 'x'.repeat(120) + '…'), '超过 120 字要截断');
  assert.ok(content.includes('11:50 我：我发的'));
  assert.ok(content.includes('11:50 李四：多行 内容'), '换行压成空格');
});

test('空数据返回空串', () => {
  assert.equal(formatSamplesMarkdown({}, { date: '2026-10-23' }), '');
  assert.equal(formatSamplesMarkdown({ 'group:1': { recentMessages: [] } }, { date: '2026-10-23' }), '');
});

test('幂等：同一天同一时段只跑一次，重启后仍不重复', () => {
  const now = new Date(2026, 9, 23, 11, 50, 10);
  assert.equal(sampleDateKey(now), '2026-10-23');
  assert.equal(shouldRunSample(['03:55', '11:50'], {}, now), '11:50');
  assert.equal(shouldRunSample(['03:55'], {}, now), '');
  const runs = markSampleRun({}, '2026-10-23', '11:50');
  assert.deepEqual(runs['2026-10-23'], ['1150']);
  assert.equal(shouldRunSample(['03:55', '11:50'], runs, now), '', '同一时段不得重复');
  assert.equal(shouldRunSample(['03:55', '11:50'], runs, new Date(2026, 9, 24, 11, 50, 0)), '11:50', '第二天可以再跑');
});

test('补跑：时段后 2 小时内上线仍要导出，跨多个缺的时段先补最早的', () => {
  const late = new Date(2026, 9, 23, 5, 30, 0); // 03:55 过了 95 分钟
  assert.equal(shouldRunSample(['03:55', '11:50'], {}, late, 120), '03:55', '窗口内补跑 03:55');
  assert.equal(shouldRunSample(['03:55', '11:50'], {}, late), '', '不给窗口时维持旧行为（只在整点命中）');
  // 已跑过就不再补
  const runs = markSampleRun({}, '2026-10-23', '03:55');
  assert.equal(shouldRunSample(['03:55', '11:50'], runs, late, 120), '');
  // 窗口边界：正好 120 分钟仍算，超出就不算
  assert.equal(shouldRunSample(['03:55'], {}, new Date(2026, 9, 23, 5, 55, 0), 120), '03:55');
  assert.equal(shouldRunSample(['03:55'], {}, new Date(2026, 9, 23, 5, 56, 0), 120), '');
  // 两个时段同时到期：先补最早的
  assert.equal(shouldRunSample(['03:55', '04:30'], {}, new Date(2026, 9, 23, 4, 45, 0), 120), '03:55');
  // 整点命中照常工作（03:55 早已超出窗口，不参与）
  assert.equal(shouldRunSample(['03:55', '11:50'], {}, new Date(2026, 9, 23, 11, 50, 0), 120), '11:50');
  // 跨午夜的窗口不补：23:55 的时段到次日 00:30 不算（日期会张冠李戴）
  assert.equal(shouldRunSample(['23:55'], {}, new Date(2026, 9, 23, 0, 30, 0), 120), '');
  // catchupMinutes=0 关闭补跑
  assert.equal(shouldRunSample(['03:55'], {}, new Date(2026, 9, 23, 4, 0, 0), 0), '');
});

test('清理：只保留最近 14 个日期', () => {
  const names = [];
  for (let day = 1; day <= 20; day += 1) {
    const date = `2026-09-${String(day).padStart(2, '0')}`;
    names.push(`${date}_0355.md`, `${date}_1150.md`);
  }
  names.push('not-a-sample.txt');
  const remove = pruneSampleFiles(names, { keepDays: 14 });
  assert.equal(remove.length, 12, '20 个日期只保留 14 个，删 6 天 ×2 份');
  assert.ok(!remove.some((name) => name.startsWith('2026-09-20')), '最新的日期不能删');
  assert.ok(remove.includes('2026-09-01_0355.md'), '最旧的日期要删');
  assert.ok(!remove.includes('not-a-sample.txt'), '非样本文件不动');
});

test('配置归一：times 过滤非法值，缺省回退', () => {
  const config = normalizeSamplesConfig({ times: ['03:55', 'bad', '11:50'], keepDays: 999, maxCharsPerLine: 5 });
  assert.deepEqual(config.times, ['03:55', '11:50']);
  assert.equal(config.keepDays, 365);
  assert.equal(config.maxCharsPerLine, 20);
  assert.deepEqual(normalizeSamplesConfig({ times: [] }).times, ['03:55', '11:50']);
  assert.equal(normalizeSamplesConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeSamplesConfig({ dir: 'E:\\DSH\\_pad\\samples' }).dir, 'E:\\DSH\\_pad\\samples');
  assert.equal(normalizeSamplesConfig({}).catchupMinutes, 120, '补跑窗口缺省 120 分钟');
  assert.equal(normalizeSamplesConfig({ catchupMinutes: 0 }).catchupMinutes, 0, '显式 0 关闭补跑');
  assert.equal(normalizeSamplesConfig({ catchupMinutes: 99999 }).catchupMinutes, 720, '补跑窗口封顶 12 小时');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
