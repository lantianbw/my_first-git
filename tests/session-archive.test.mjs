import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, buildArchiveSnapshot, buildRecallText, handle } from '../src/session/archive.js';

const NOW = 1_800_000_000_000;

test('spec 契约形状', () => {
  assert.equal(spec.name, 'session/archive');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('快照：话题与发言都截断、过滤空文本、保留时间', () => {
  const snap = buildArchiveSnapshot({
    key: 'private:1',
    sessionId: 'session-abc',
    now: NOW,
    state: {
      activeTopics: [{ text: '搬家', lastMentionAt: NOW - 1000 }, { text: '' }],
      recentMessages: [
        { isSelf: true, text: '  multiple\nlines  ', time: NOW - 10 },
        { isSelf: false, name: '老爹', text: '在干嘛', time: NOW - 5 },
        { isSelf: false, text: '' }
      ]
    },
    memoryText: '【进行中的话题】\n- 搬家',
    relationText: '关系：老爹'
  });
  assert.equal(snap.key, 'private:1');
  assert.equal(snap.sessionId, 'session-abc');
  assert.equal(snap.rotatedAt, NOW);
  assert.equal(snap.topics.length, 1);
  assert.equal(snap.recent.length, 2, '空文本被过滤');
  assert.equal(snap.recent[0].text, 'multiple lines', '空白被压缩');
  assert.equal(snap.recent[0].self, true);
  assert.equal(snap.recent[1].who, '老爹');
  assert.equal(snap.memoryText, '【进行中的话题】\n- 搬家');
  assert.equal(snap.relationText, '关系：老爹');
});

test('快照：now 缺失抛 TypeError；空 state 给空数组', () => {
  assert.throws(() => buildArchiveSnapshot({ key: 'g:1', state: {} }), TypeError);
  const snap = buildArchiveSnapshot({ key: 'group:1', now: NOW, state: {} });
  assert.deepEqual(snap.topics, []);
  assert.deepEqual(snap.recent, []);
  assert.equal(snap.sessionId, null);
});

test('快照：text 取值优先级 tail > plain > text', () => {
  const snap = buildArchiveSnapshot({
    key: 'g:1',
    now: NOW,
    state: { recentMessages: [{ tail: '尾巴', plain: '平文', text: '原文' }, { plain: '平文', text: '原文' }, { text: '原文' }] }
  });
  assert.deepEqual(snap.recent.map((m) => m.text), ['尾巴', '平文', '原文']);
});

test('快照：limits 控制条数与字数', () => {
  const snap = buildArchiveSnapshot({
    key: 'g:1',
    now: NOW,
    state: {
      activeTopics: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
      recentMessages: [{ text: 'x' }, { text: 'y' }, { text: 'z' }]
    },
    limits: { topicLimit: 2, recentLimit: 1, topicChars: 1, recentChars: 1 }
  });
  assert.equal(snap.topics.length, 2);
  assert.equal(snap.recent.length, 1);
  assert.equal(snap.topics[0].text.length, 1);
});

test('回注：默认只带最近发言，不重复记忆与关系线', () => {
  const text = buildRecallText({
    memoryText: '【进行中的话题】\n- 搬家',
    recent: [
      { self: true, text: '别再熬夜了' },
      { self: false, who: '老爹', text: '好' },
      { self: false, who: '', text: '在干嘛' }
    ],
    relationText: '关系：老爹'
  });
  assert.match(text, /^【上一次会话的记忆（自动归档，仅供参考）】/);
  assert.match(text, /最近说过的话：/);
  assert.match(text, /- 你：别再熬夜了/);
  assert.match(text, /- 老爹：好/);
  assert.match(text, /- 对方：在干嘛/, 'who 为空时回退「对方」');
  // 这两段在轮换后仍从持久化状态实时注入；归档再带一份会让同一 prompt 出现两份。
  assert.doesNotMatch(text, /【进行中的话题】/);
  assert.doesNotMatch(text, /关系：老爹/);
  assert.ok(text.endsWith('\n\n'), '以两个换行结尾，便于拼接进提示词');
});

test('回注：显式 includeMemory / includeRelation 时带归档原文（导出/排查用）', () => {
  const text = buildRecallText(
    { memoryText: 'M', recent: [{ text: 'hi' }], relationText: 'R' },
    { includeMemory: true, includeRelation: true }
  );
  assert.match(text, /^M$/m);
  assert.match(text, /^R$/m);
  assert.match(text, /- 对方：hi/);
});

test('回注：空快照返回空串（调用方据此决定不标记已注入）', () => {
  assert.equal(buildRecallText(null), '');
  assert.equal(buildRecallText({}), '');
  assert.equal(buildRecallText({ memoryText: '  ', recent: [], relationText: '' }), '');
});

test('回注：recallLimit 只取最后 N 条', () => {
  const text = buildRecallText(
    { recent: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
    { recallLimit: 2 }
  );
  assert.doesNotMatch(text, /- 对方：a/);
  assert.match(text, /- 对方：b/);
  assert.match(text, /- 对方：c/);
});

test('纯函数：不改入参', () => {
  const input = {
    key: 'g:1',
    now: NOW,
    state: { activeTopics: [{ text: 'A' }], recentMessages: [{ text: 'B', time: 1 }] },
    memoryText: 'M',
    relationText: 'R'
  };
  const before = JSON.stringify(input);
  buildArchiveSnapshot(input);
  assert.equal(JSON.stringify(input), before);
});

test('handle：snapshot / recall 两个动作，未知动作返回 INVALID_ARGS', () => {
  const snapResult = handle({}, { action: 'snapshot', key: 'g:1', now: NOW, state: {} });
  assert.equal(snapResult.ok, true);
  assert.equal(snapResult.value.key, 'g:1');

  const recallResult = handle({}, { action: 'recall', snapshot: { recent: [{ text: 'hi' }] } });
  assert.equal(recallResult.ok, true);
  assert.match(recallResult.value, /- 对方：hi/);

  const bad = handle({}, { action: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
});
