import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, buildPersonaBlock } from '../src/content/persona-inject.js';

const IDENTITY = '【你的身份】你在 QQ 上的昵称是「樰」（QQ 10001）。';

test('空：两段都没有时不输出任何文本（含 spec 契约）', () => {
  assert.equal(spec.name, 'content/persona-inject');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'owner', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));

  assert.deepEqual(buildPersonaBlock(), { text: '', truncated: false });
  assert.deepEqual(buildPersonaBlock({ role: '', identity: '' }), { text: '', truncated: false });
  assert.deepEqual(buildPersonaBlock({ role: '   ', identity: '\n\n' }), { text: '', truncated: false });
});

test('只有角色：只输出角色段，不留下多余空行', () => {
  const result = buildPersonaBlock({ role: '学姐', identity: '' });
  assert.equal(result.text, '【当前角色】学姐');
  assert.equal(result.truncated, false);
  assert.ok(!result.text.endsWith('\n'));
  assert.doesNotMatch(result.text, /完整角色卡/);
});

test('只有身份：原样使用 selfIdentityTextV2 的成品文本，不重复加前缀', () => {
  assert.equal(buildPersonaBlock({ identity: IDENTITY }).text, IDENTITY);
  // bridge 的成品带两个尾换行，拼接时应被吃掉
  const trimmed = buildPersonaBlock({ role: '', identity: `${IDENTITY}\n\n` });
  assert.equal(trimmed.text, IDENTITY);
  assert.ok(!trimmed.text.startsWith('\n'));
  assert.equal(trimmed.text.match(/【你的身份】/g).length, 1);
});

test('两段都有：角色在前、身份在后，中间恰好一个空行', () => {
  const { text, truncated } = buildPersonaBlock({ role: '学姐', identity: IDENTITY });
  assert.equal(text, `【当前角色】学姐\n\n${IDENTITY}`);
  assert.equal(truncated, false);
  assert.equal(text.split('\n\n').length, 2);
  assert.doesNotMatch(text, /\n\n\n/);
});

test('超长截断：总长不超过 maxChars，末尾带省略号且标 truncated', () => {
  const full = `【当前角色】学姐\n\n${IDENTITY}`;
  const result = buildPersonaBlock({ role: '学姐', identity: IDENTITY, maxChars: 20 });
  assert.equal(result.truncated, true);
  assert.equal([...result.text].length, 20);
  assert.ok(result.text.endsWith('…'));
  assert.ok(result.text.startsWith('【当前角色】学姐'));
  assert.ok([...result.text].length < [...full].length);

  // 上限为 1 时仍是合法输出
  assert.deepEqual(buildPersonaBlock({ role: '学姐', maxChars: 1 }), { text: '…', truncated: true });
});

test('恰好等于上限：不截断、不加省略号、原样返回', () => {
  const full = `【当前角色】学姐\n\n${IDENTITY}`;
  const exact = [...full].length;
  assert.deepEqual(buildPersonaBlock({ role: '学姐', identity: IDENTITY, maxChars: exact }), {
    text: full,
    truncated: false
  });
  assert.deepEqual(buildPersonaBlock({ role: '学姐', identity: IDENTITY, maxChars: exact + 5 }), {
    text: full,
    truncated: false
  });
});

test('hasRoleCard：为 true 时角色行带附注，否则不带（附注计入长度）', () => {
  const withCard = buildPersonaBlock({ role: '学姐', hasRoleCard: true });
  assert.equal(withCard.text, '【当前角色】学姐（完整角色卡请调用 qq_get_prompt 查看）');

  const withoutCard = buildPersonaBlock({ role: '学姐', hasRoleCard: false });
  assert.equal(withoutCard.text, '【当前角色】学姐');
  assert.equal(buildPersonaBlock({ role: '学姐' }).text, '【当前角色】学姐');

  // 附注不影响空行规则
  const both = buildPersonaBlock({ role: '学姐', identity: IDENTITY, hasRoleCard: true });
  assert.equal(both.text, `【当前角色】学姐（完整角色卡请调用 qq_get_prompt 查看）\n\n${IDENTITY}`);

  // 附注也受 maxChars 约束
  const clipped = buildPersonaBlock({ role: '学姐', hasRoleCard: true, maxChars: 12 });
  assert.equal(clipped.truncated, true);
  assert.equal([...clipped.text].length, 12);
  assert.ok(clipped.text.endsWith('…'));
});
