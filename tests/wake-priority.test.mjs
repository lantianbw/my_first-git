import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, priorityOf, handle } from '../src/scheduler/wake-priority.js';

// 本模块无时钟：下面所有「时间」都由参数传入，测试才知道冷却到底按什么算。
const NICK = '小鲸鱼';

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'scheduler/wake-priority');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('触发一：owner 直接说话 → 最高优先级并唤醒', () => {
  const out = priorityOf({ isOwner: true });
  assert.equal(out.wake, true);
  assert.equal(out.priority, 100);
  assert.match(out.reason, /owner/);
});

test('触发二：@ 或引用 → 高优先级并唤醒', () => {
  const out = priorityOf({ isMentioned: true });
  assert.equal(out.wake, true);
  assert.equal(out.priority, 90);
  assert.match(out.reason, /@|引用/);
});

test('触发三：提问 → 高优先级并唤醒', () => {
  const out = priorityOf({ isQuestion: true });
  assert.equal(out.wake, true);
  assert.equal(out.priority, 80);
});

test('触发四：提到昵称 → 高优先级并唤醒，没提到则不唤醒', () => {
  const hit = priorityOf({ triggers: { nameMention: true, nickname: NICK }, message: `${NICK} 在吗` });
  assert.equal(hit.wake, true);
  assert.equal(hit.priority, 70);
  assert.match(hit.reason, /小鲸鱼/);

  const miss = priorityOf({ triggers: { nameMention: true, nickname: NICK }, message: '今天天气不错' });
  assert.equal(miss.wake, false);
  assert.equal(miss.priority, 0);
});

test('关键词命中 → 中优先级，reason 带出具体词', () => {
  const out = priorityOf({ triggers: { keywords: ['上线', '报错'] }, message: '服务又报错了' });
  assert.equal(out.wake, true);
  assert.equal(out.priority, 60);
  assert.match(out.reason, /报错/);
});

test('短英文关键词走词边界：DS 不命中 BDSM / ADS', () => {
  const triggers = { keywords: ['DS'] };

  assert.equal(priorityOf({ triggers, message: 'BDSM 是什么' }).wake, false);
  assert.equal(priorityOf({ triggers, message: 'ADS 投放' }).wake, false);

  const hit = priorityOf({ triggers, message: 'DS 这边挂了' });
  assert.equal(hit.wake, true);
  assert.equal(hit.priority, 60);
});

test('概率触发 → 最低优先级，且必须由调用方掷好传入', () => {
  const hit = priorityOf({ triggers: { probabilityHit: true } });
  assert.equal(hit.wake, true);
  assert.equal(hit.priority, 10);

  // 只给 0~1 的配置不算命中：本函数不掷骰子，否则测试永远不稳定。
  const config = priorityOf({ triggers: { probability: 0.99 }, message: '随便说点什么' });
  assert.equal(config.wake, false);
});

test('会话正忙 → 不唤醒，reason 说明原因并保留本应触发的类型', () => {
  const out = priorityOf({ isMentioned: true, isBusy: true });
  assert.equal(out.wake, false);
  assert.equal(out.priority, 0);
  assert.match(out.reason, /正忙/);
  assert.match(out.reason, /@|引用/);
});

test('刚唤醒过 → 冷却期内不唤醒，过了窗口恢复', () => {
  const soon = priorityOf({ isMentioned: true, minutesSinceLastWake: 0.5 });
  assert.equal(soon.wake, false);
  assert.equal(soon.priority, 0);
  assert.match(soon.reason, /冷却/);

  const later = priorityOf({ isMentioned: true, minutesSinceLastWake: 30 });
  assert.equal(later.wake, true);

  // 从未唤醒（缺省）不该被判成「刚唤醒过」
  assert.equal(priorityOf({ isMentioned: true }).wake, true);
});

test('冷却窗口可由 triggers.cooldownMinutes 覆盖', () => {
  const triggers = { cooldownMinutes: 10 };
  assert.equal(priorityOf({ triggers, isMentioned: true, minutesSinceLastWake: 5 }).wake, false);
  assert.equal(priorityOf({ triggers, isMentioned: true, minutesSinceLastWake: 15 }).wake, true);

  // 显式 0 表示不要冷却
  assert.equal(priorityOf({ triggers: { cooldownMinutes: 0 }, isMentioned: true, minutesSinceLastWake: 0 }).wake, true);
});

test('无触发 → 不唤醒', () => {
  const out = priorityOf({ triggers: { keywords: ['上线'] }, message: '晚安' });
  assert.equal(out.wake, false);
  assert.equal(out.priority, 0);
  assert.equal(out.reason.length > 0, true);

  const empty = priorityOf();
  assert.equal(empty.wake, false);
  assert.equal(empty.priority, 0);
});

test('priority 排序单调：owner > @ > 提问 > 昵称 > 关键词 > anyMessage > 概率', () => {
  const chain = [
    priorityOf({ isOwner: true }),
    priorityOf({ isMentioned: true }),
    priorityOf({ isQuestion: true }),
    priorityOf({ triggers: { nameMention: true, nickname: NICK }, message: NICK }),
    priorityOf({ triggers: { keywords: ['上线'] }, message: '上线了吗' }),
    priorityOf({ triggers: { anyMessage: true }, message: '随便' }),
    priorityOf({ triggers: { probabilityHit: true } })
  ];

  for (const item of chain) {
    assert.equal(item.wake, true);
    assert.equal(item.priority > 0, true);
  }
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(chain[i - 1].priority > chain[i].priority, `第 ${i} 档应严格高于第 ${i + 1} 档`);
  }
});

test('多触发同时成立时取最高优先级', () => {
  const out = priorityOf({
    isOwner: true,
    isMentioned: true,
    isQuestion: true,
    triggers: { keywords: ['上线'] },
    message: '上线了吗'
  });
  assert.equal(out.priority, 100);
});

test('anyMessage 不再吞掉 @：具体触发优先于兜底', () => {
  const mentioned = priorityOf({ triggers: { anyMessage: true }, isMentioned: true, message: '在吗' });
  assert.equal(mentioned.priority, 90);

  const plain = priorityOf({ triggers: { anyMessage: true }, message: '随便说说' });
  assert.equal(plain.priority, 50);
  assert.equal(plain.wake, true);
});

test('triggers 里的开关能关掉对应触发', () => {
  assert.equal(priorityOf({ triggers: { atMention: false }, isMentioned: true }).wake, false);
  assert.equal(priorityOf({ triggers: { question: false }, isQuestion: true }).wake, false);
});

test('reason 在所有分支都非空', () => {
  const cases = [
    priorityOf({ isOwner: true }),
    priorityOf({ isMentioned: true }),
    priorityOf({ isQuestion: true }),
    priorityOf({ triggers: { probabilityHit: true } }),
    priorityOf({ isBusy: true }),
    priorityOf({ isMentioned: true, minutesSinceLastWake: 0 }),
    priorityOf({ message: '无关内容' }),
    priorityOf()
  ];
  for (const item of cases) {
    assert.equal(typeof item.reason, 'string');
    assert.ok(item.reason.trim().length > 0);
  }
});

test('纯函数：不改入参、可重复、结论不随时间变化', () => {
  const ctx = {
    triggers: { keywords: ['上线'], cooldownMinutes: 3 },
    message: '上线了吗',
    isOwner: false,
    isBusy: false,
    minutesSinceLastWake: 10,
    isMentioned: false,
    isQuestion: false
  };
  const snapshot = JSON.parse(JSON.stringify(ctx));

  const first = priorityOf(ctx);
  const second = priorityOf(ctx);

  assert.deepEqual(ctx, snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.wake, true);
  assert.equal(first.priority, 60);
});

test('handle：契约形状 { ok, value }，与 priorityOf 结论一致', () => {
  const out = handle({}, { isMentioned: true });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, priorityOf({ isMentioned: true }));

  const bare = handle(undefined, undefined);
  assert.equal(bare.ok, true);
  assert.equal(bare.value.wake, false);
});
