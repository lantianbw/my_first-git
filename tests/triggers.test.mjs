import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, matchTriggers, handle } from '../src/scheduler/triggers.js';

const SELF = { selfNames: ['小鲸鱼'], selfQQ: '10001' };

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'scheduler/triggers');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('触发一：@ 我（CQ 码）→ 最高优先级', () => {
  const out = matchTriggers({ ...SELF, triggers: { atMention: true, anyMessage: true }, message: '[CQ:at,qq=10001] 在吗' });
  assert.equal(out.hit, true);
  assert.equal(out.priority, 90);
  assert.match(out.reason, /@/);
});

test('触发一补充：@ 昵称也算 @，不会降级成「提到名字」', () => {
  const out = matchTriggers({ ...SELF, triggers: { nameMention: true }, message: '@小鲸鱼 你好' });
  assert.equal(out.priority, 90);
  assert.equal(out.reason.includes('同时命中'), false, '@昵称 不该再被算一次名字');
});

test('触发二：提到名字 → 次高', () => {
  const out = matchTriggers({ ...SELF, triggers: { nameMention: true }, message: '小鲸鱼今天怎么样' });
  assert.equal(out.hit, true);
  assert.equal(out.priority, 80);
  assert.match(out.reason, /小鲸鱼/);
});

test('触发三：关键词 → 再次', () => {
  const out = matchTriggers({ ...SELF, triggers: { keywords: ['上线', '报错'] }, message: '服务上线了吗' });
  assert.equal(out.priority, 70);
  assert.match(out.reason, /上线/);
});

test('触发四：提问 → 再次', () => {
  const out = matchTriggers({ ...SELF, triggers: { question: true }, message: '这个方案可行吗，你觉得呢' });
  assert.equal(out.priority, 60);
  assert.match(out.reason, /追问/);
});

test('触发五：任意消息 → 最低', () => {
  const out = matchTriggers({ ...SELF, triggers: { anyMessage: true }, message: '随便说点什么' });
  assert.equal(out.hit, true);
  assert.equal(out.priority, 50);
  assert.match(out.reason, /anyMessage/);
});

test('多项叠加：取最高并说明同时命中了什么', () => {
  const out = matchTriggers({
    ...SELF,
    triggers: { atMention: true, nameMention: true, keywords: ['上线'], question: true },
    message: '@小鲸鱼 服务上线了吗，你觉得呢'
  });

  assert.equal(out.priority, 90);
  assert.match(out.reason, /同时命中/);
  assert.match(out.reason, /关键词/);
  assert.match(out.reason, /追问/);
});

test('全部关闭：就算 @ 了也不命中', () => {
  const out = matchTriggers({
    ...SELF,
    triggers: { atMention: false, nameMention: false, keywords: [], question: false, anyMessage: false },
    message: '@小鲸鱼 上线了吗'
  });

  assert.equal(out.hit, false);
  assert.equal(out.priority, 0);
  assert.ok(out.reason.length > 0);
});

test('空消息：不触发，也不误报 anyMessage', () => {
  for (const message of ['', '   ', '\n\t', null, undefined]) {
    const out = matchTriggers({ ...SELF, triggers: { anyMessage: true, atMention: true }, message });
    assert.deepEqual(out, { hit: false, reason: '空消息，不触发任何唤醒', priority: 0 });
  }
});

test('selfNames 为空：名字类触发失效，但 @QQ 仍有效', () => {
  const noNames = matchTriggers({ selfNames: [], selfQQ: '10001', triggers: { nameMention: true }, message: '@小鲸鱼 在吗' });
  assert.equal(noNames.hit, false);

  const byQQ = matchTriggers({ selfNames: [], selfQQ: '10001', triggers: { atMention: true }, message: '[CQ:at,qq=10001] 在吗' });
  assert.equal(byQQ.priority, 90);

  const undefinedNames = matchTriggers({ selfQQ: '10001', triggers: { nameMention: true }, message: '小鲸鱼 在吗' });
  assert.equal(undefinedNames.hit, false);
});

test('大小写：默认不敏感（同 bridge），caseSensitive 时严格', () => {
  const args = { selfNames: ['Alice'], triggers: { keywords: ['DS'], nameMention: true } };

  const loose = matchTriggers({ ...args, message: 'ds 挂了，alice 看看' });
  assert.equal(loose.hit, true);
  assert.equal(loose.priority, 80); // 名字 80 > 关键词 70

  const strict = matchTriggers({ ...args, triggers: { ...args.triggers, caseSensitive: true }, message: 'ds 挂了，alice 看看' });
  assert.equal(strict.hit, false);

  const strictHit = matchTriggers({ ...args, triggers: { ...args.triggers, caseSensitive: true }, message: 'DS 挂了，Alice 看看' });
  assert.equal(strictHit.hit, true);
});

test('priority 单调：@ > 名字 > 关键词 > 提问 > 任意消息', () => {
  const chain = [
    matchTriggers({ ...SELF, triggers: { atMention: true }, message: '@小鲸鱼 你好' }).priority,
    matchTriggers({ ...SELF, triggers: { nameMention: true }, message: '小鲸鱼 你好' }).priority,
    matchTriggers({ ...SELF, triggers: { keywords: ['上线'] }, message: '上线了' }).priority,
    matchTriggers({ ...SELF, triggers: { question: true }, message: '你觉得行吗' }).priority,
    matchTriggers({ ...SELF, triggers: { anyMessage: true }, message: '随便' }).priority
  ];

  assert.deepEqual(chain, [90, 80, 70, 60, 50]);
  for (let i = 1; i < chain.length; i += 1) assert.ok(chain[i - 1] > chain[i]);
});

test('reason 在所有分支都非空', () => {
  const cases = [
    matchTriggers({ ...SELF, triggers: { atMention: true }, message: '@小鲸鱼 你好' }),
    matchTriggers({ ...SELF, triggers: { nameMention: true }, message: '小鲸鱼 你好' }),
    matchTriggers({ ...SELF, triggers: { keywords: ['上线'] }, message: '上线了' }),
    matchTriggers({ ...SELF, triggers: { question: true }, message: '你觉得行吗' }),
    matchTriggers({ ...SELF, triggers: { anyMessage: true }, message: '随便' }),
    matchTriggers({ ...SELF, triggers: {}, message: '普通的一句话' }),
    matchTriggers({ ...SELF, triggers: {}, message: '' })
  ];

  for (const item of cases) {
    assert.equal(typeof item.reason, 'string');
    assert.ok(item.reason.trim().length > 0);
    assert.equal(Number.isFinite(item.priority), true);
  }
});

test('未知字段忽略：多余配置不影响判定', () => {
  const out = matchTriggers({
    ...SELF,
    triggers: { atMention: true, 未来字段: 123, whatever: { deep: true }, keywords: ['上线'] },
    message: '上线了'
  });

  assert.equal(out.priority, 70);
});

test('短英文关键词走词边界：DS 不命中 BDSM', () => {
  const triggers = { keywords: ['DS'] };
  assert.equal(matchTriggers({ ...SELF, triggers, message: 'BDSM 是什么' }).hit, false);
  assert.equal(matchTriggers({ ...SELF, triggers, message: 'DS 这边挂了' }).hit, true);
});

test('handle：契约形状 { ok, value }，与 matchTriggers 一致', () => {
  const out = handle({}, { ...SELF, triggers: { atMention: true }, message: '@小鲸鱼 你好' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, matchTriggers({ ...SELF, triggers: { atMention: true }, message: '@小鲸鱼 你好' }));
  assert.equal(out.value.priority, 90);
});
