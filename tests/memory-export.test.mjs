import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, renderMemoryMarkdown, handle } from '../src/content/memory-export.js';

const NOW = new Date(2026, 9, 28, 16, 0, 0);   // 2026-10-28 16:00:00（本地）

test('spec 契约形状', () => {
  assert.equal(spec.name, 'content/memory-export');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['now']);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
});

test('空数据：六个小节都写「（暂无）」，且不渲染会话段', () => {
  const md = renderMemoryMarkdown({ now: NOW });
  assert.match(md, /^# 小鲸鱼 · 记忆/m);
  assert.match(md, /导出时间：2026-10-28 16:00:00/);
  for (const title of ['关于我 / 长期事实', '关系', '日记', '心情', '梗库']) {
    assert.match(md, new RegExp(`## ${title.replace(/[/]/g, '\\/')}`), title);
  }
  assert.equal((md.match(/（暂无）/g) || []).length, 5, '五节无数据');
  assert.doesNotMatch(md, /## 当前会话/);
});

test('长期事实：保留证据，过滤已删除与空文本', () => {
  const md = renderMemoryMarkdown({
    now: NOW,
    profile: [
      { text: '私下叫老爹', evidence: '原话', status: 'active' },
      { text: '要删的', status: 'deleted' },
      { text: '', status: 'active' }
    ]
  });
  assert.match(md, /- 私下叫老爹（证据：原话）/);
  assert.doesNotMatch(md, /要删的/);
});

test('关系：称呼 / 雷点 / 禁忌 / 最近事件都渲染', () => {
  const md = renderMemoryMarkdown({
    now: NOW,
    relations: {
      'private:1': {
        profile: { 称呼: '老爹', 雷点: ['被叫肥鱼'], 禁忌: ['感情'] },
        events: [{ date: '2026-10-23', text: '充了100' }]
      }
    }
  });
  assert.match(md, /### private:1/);
  assert.match(md, /- 称呼：老爹/);
  assert.match(md, /- 雷点：被叫肥鱼/);
  assert.match(md, /- 禁忌：感情/);
  assert.match(md, /  - 2026-10-23 充了100/);
});

test('日记：倒序（最新在前），带感受与没说出口', () => {
  const md = renderMemoryMarkdown({
    now: NOW,
    diary: [
      { text: '旧的一天', createdAt: new Date(2026, 9, 20).getTime(), status: 'active' },
      { text: '新的一天', createdAt: new Date(2026, 9, 27).getTime(), status: 'active', mood: '有点烫', unsaid: '没说' },
      { text: '删掉的', createdAt: new Date(2026, 9, 26).getTime(), status: 'deleted' }
    ]
  });
  const iNew = md.indexOf('新的一天');
  const iOld = md.indexOf('旧的一天');
  assert.ok(iNew > 0 && iOld > 0, '两条都在');
  assert.ok(iNew < iOld, '最新在前');
  assert.doesNotMatch(md, /删掉的/);
  assert.match(md, /- 感受：有点烫/);
  assert.match(md, /- 没说出口：没说/);
  assert.match(md, /### 2026-10-27/);
});

test('心情：底色与手记都渲染', () => {
  const md = renderMemoryMarkdown({
    now: NOW,
    moods: { baseMood: { word: '软下来', reason: '像一家人' }, handnotes: [{ text: '被晾着', tag: '被冷落' }] }
  });
  assert.match(md, /- 底色：软下来（像一家人）/);
  assert.match(md, /- 手记：被晾着（被冷落）/);
});

test('梗库：兼容字符串数组与 { items } 两种形态', () => {
  const a = renderMemoryMarkdown({ now: NOW, memes: ['罐头梗'] });
  assert.match(a, /- 罐头梗/);
  const b = renderMemoryMarkdown({ now: NOW, memes: { items: [{ text: '鲸鱼梗' }] } });
  assert.match(b, /- 鲸鱼梗/);
});

test('会话段：仅当传入 sessionKey 时出现，空记忆给占位文案', () => {
  const withKey = renderMemoryMarkdown({ now: NOW, sessionKey: 'private:1', sessionMemory: '' });
  assert.match(withKey, /## 当前会话 private:1/);
  assert.match(withKey, /（会话层记忆为空）/);

  const withMemory = renderMemoryMarkdown({ now: NOW, sessionKey: 'private:1', sessionMemory: '【进行中的话题】\n- 搬家' });
  assert.match(withMemory, /- 搬家/);
});

test('纯函数：同输入输出稳定，且不改入参', () => {
  const input = {
    now: NOW,
    profile: [{ text: 'a', status: 'active' }],
    relations: { 'group:2': { profile: { 称呼: '小鲸鱼' }, events: [] } },
    diary: [{ text: 'b', createdAt: 1, status: 'active' }],
    moods: { baseMood: { word: 'w' }, handnotes: [] },
    memes: ['m'],
    sessionKey: 'group:2',
    sessionMemory: 'x'
  };
  const snapshot = JSON.stringify(input);
  const one = renderMemoryMarkdown(input);
  const two = renderMemoryMarkdown(input);
  assert.equal(one, two);
  assert.equal(JSON.stringify(input), snapshot);
});

test('handle：契约形状 { ok, value }，与 renderMemoryMarkdown 一致', () => {
  const args = { now: NOW, memes: ['m'] };
  const result = handle({}, args);
  assert.equal(result.ok, true);
  assert.equal(result.value, renderMemoryMarkdown(args));
});
