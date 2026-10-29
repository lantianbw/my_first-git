import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

// M13·2：唤醒 prompt 结尾的「人格锚」。
// 钉住四件事：① 只能在最末尾（tail 之后、wake.before 追加段之后）；
// ② 带的是**动态角色名**，不是桥里抄的一份人格；③ 长度 40~70 字；
// ④ 计入 prompt 预算，且能用 socialV2.prompt.personaAnchor=false 关掉。

const KEY = 'group:456';
const ROLE = '小鲸鱼';
const ANCHOR_MARK = '【人格锚】';

/** 只读锚那一句：从最后一次「【人格锚】」到结尾。 */
function anchorOf(prompt) {
  const at = prompt.lastIndexOf(ANCHOR_MARK);
  return at < 0 ? '' : prompt.slice(at);
}

/** 起一个带角色状态的桥；files 里写 state/current-role.json 就等于换角色名。 */
async function withBridge(role, fn) {
  const files = role === null ? {} : { 'state/current-role.json': { role, mode: 'active' } };
  const h = await bridgeHarness({ files });
  try {
    h.setSelfIdentity(ROLE, '999');
    return await fn(h);
  } finally {
    await h.close();
  }
}

test('人格锚出现在唤醒 prompt 最末尾：所有唤醒分支都以锚收尾，且只有一处', async () => {
  await withBridge(ROLE, async (h) => {
    const reasons = [
      'bootstrap', 'timeout', 'replyCheck', 'proactiveCheck', 'diarySettle',
      'weeklyDigest', 'lifeMorning', 'poke', 'question'
    ];
    const anchor = anchorOf(h.buildWakePromptV2(KEY, 'question'));
    assert.ok(anchor, '默认就该有锚');
    for (const reason of reasons) {
      const prompt = h.buildWakePromptV2(KEY, reason);
      assert.ok(prompt.endsWith(anchor), `${reason} 唤醒必须以锚收尾`);
      assert.equal((prompt.match(/【人格锚】/g) || []).length, 1, `${reason} 只应出现一处锚`);
    }
  });
});

test('锚用的是动态角色名：换角色名锚跟着变，没有角色时退回「你还是你」', async () => {
  await withBridge(ROLE, async (h) => {
    const anchor = anchorOf(h.buildWakePromptV2(KEY, 'question'));
    assert.ok(anchor.includes(`你是「${ROLE}」`), `锚要带当前角色名：${anchor}`);

    // 换角色：同一个桥重读 state/current-role.json（readRoleState 每次唤醒都读）
    fs.writeFileSync(
      path.join(h.temp, 'state', 'current-role.json'),
      JSON.stringify({ role: '傲娇小狐狸', mode: 'active' })
    );
    const changed = anchorOf(h.buildWakePromptV2(KEY, 'question'));
    assert.ok(changed.includes('傲娇小狐狸'));
    assert.ok(!changed.includes(ROLE), '旧角色名不应残留');
  });

  await withBridge(null, async (h) => {
    const anchor = anchorOf(h.buildWakePromptV2(KEY, 'question'));
    assert.ok(anchor.includes('你还是你'), `没设角色时也要有主语：${anchor}`);
    assert.doesNotMatch(anchor, /你是「」/);
  });
});

test('锚长度 40~70 字：空角色/普通角色/超长角色名都不越界', async () => {
  for (const role of [null, ROLE, '超'.repeat(40)]) {
    await withBridge(role, async (h) => {
      const anchor = anchorOf(h.buildWakePromptV2(KEY, 'question'));
      const len = [...anchor].length;
      assert.ok(len >= 40 && len <= 70, `锚长度应在 40~70 字，实际 ${len}（role=${role}）`);
      if (role) {
        assert.ok(anchor.includes('你是「'), `锚要带角色名：${anchor}`);
        assert.doesNotMatch(anchor, /你是「.{17,}」/, '角色名最多留 16 字');
      } else {
        assert.ok(anchor.includes('你还是你'));
      }
    });
  }
});

test('开关 socialV2.prompt.personaAnchor=false：锚不出现，长度回到关闭前', async () => {
  await withBridge(ROLE, async (h) => {
    const on = h.buildWakePromptV2(KEY, 'question');
    assert.ok(on.includes(ANCHOR_MARK), '默认开');

    h.cfg.socialV2.prompt = { personaAnchor: false };
    const off = h.buildWakePromptV2(KEY, 'question');
    assert.ok(!off.includes(ANCHOR_MARK), '关掉后不得出现锚');
    assert.ok(off.length < on.length);

    // 只有 undefined（没配过）才算默认开；false 才算关
    h.cfg.socialV2.prompt = {};
    assert.ok(h.buildWakePromptV2(KEY, 'question').includes(ANCHOR_MARK), '未配置时默认开');
    h.cfg.socialV2.prompt = { personaAnchor: true };
    assert.ok(h.buildWakePromptV2(KEY, 'question').includes(ANCHOR_MARK));
  });
});

test('锚长度计入 budget：同一预算下，关掉锚记忆块留得住，打开锚就得裁', async () => {
  await withBridge(ROLE, async (h) => {
    // 造一段够长的可裁记忆块（「群聊摘要」段），让预算卡在临界值上。
    const st = h.getSocialV2State(KEY);
    st.memberImpressions = {};
    for (let i = 0; i < 6; i += 1) {
      st.memberImpressions[`群友${i}`] = { traits: ['很长的特征描述'.repeat(4)], interactionCount: 3 };
    }
    const full = h.buildWakePromptV2(KEY, 'question');
    assert.ok(full.includes('【对群友的印象】'), '预算充足时记忆块在');

    // 预算设成「比带锚的长度少 10 字」：不裁锚就必然超限。
    const budget = [...full].length - 10;
    h.cfg.socialV2.context.maxPromptChars = budget;

    const withAnchor = h.buildWakePromptV2(KEY, 'question');
    assert.ok(withAnchor.endsWith(anchorOf(full)), '预算紧也要保住锚');
    assert.ok(!withAnchor.includes('【对群友的印象】'), '锚占了额度，记忆块应被裁掉');
    assert.ok([...withAnchor].length <= budget, `裁剪后仍超预算：${withAnchor.length} > ${budget}`);

    // 同一预算、关掉锚：省下的额度足够装下记忆块 → 说明锚确实算进了预算。
    h.cfg.socialV2.prompt = { personaAnchor: false };
    const withoutAnchor = h.buildWakePromptV2(KEY, 'question');
    assert.ok(withoutAnchor.includes('【对群友的印象】'), '关掉锚后记忆块留得住');
    assert.ok([...withoutAnchor].length <= budget);
  });
});

test('锚在 wake.before 追加段之后：mod 追加内容仍在锚前面', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-anchor-mod-'));
  const dir = path.join(root, 'observer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'observer',
    name: '观察器',
    version: '1.0.0',
    apiVersion: '1',
    entry: './index.js',
    hooks: ['wake.before'],
    level: 'owner',
    default: true
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `
export default {
  hooks: {
    'wake.before': (ctx, payload) => ({ append: 'MOD-WAKE:' + payload.reason })
  }
};
`);
  const h = await bridgeHarness({ config: { mods: { enabled: true, dir: root } } });
  try {
    const prompt = h.buildWakePromptV2(KEY, 'question');
    assert.ok(prompt.includes('MOD-WAKE:question'));
    assert.ok(prompt.indexOf('MOD-WAKE:question') < prompt.indexOf(ANCHOR_MARK), '追加段在锚之前');
    assert.ok(prompt.endsWith(anchorOf(prompt)), '锚仍是最后一段');
  } finally {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('锚只放元指令：不含角色卡细节，也不重复角色段', async () => {
  await withBridge(ROLE, async (h) => {
    const prompt = h.buildWakePromptV2(KEY, 'question');
    const anchor = anchorOf(prompt);
    assert.ok(anchor.includes('有主见'), '元指令要在');
    assert.ok(anchor.includes('不当客服'));
    assert.doesNotMatch(anchor, /完整角色卡|角色设定|性格：|背景：/, '锚不得抄人格全文');
    assert.ok(anchor.length <= 70);
    // 角色段仍是唯一的人格来源，锚只复述名字
    assert.equal((prompt.match(/【当前角色】/g) || []).length, 1);
  });
});
