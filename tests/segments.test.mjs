import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spec,
  handle,
  segmentsToText,
  extractMediaFromSegments,
  sanitizeMediaSummary
} from '../src/inbound/segments.js';

const text = (t) => ({ type: 'text', data: { text: t } });

test('spec：契约字段齐备，且入站归一不可关闭（locked）', () => {
  assert.equal(spec.name, 'inbound/segments');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.equal(spec.toggle.level, 'locked', '文本收发链路的入站归一不支持热关');
  assert.equal(spec.toggle.default, true);
  assert.ok(Object.isFrozen(spec));
});

test('纯文本：纯文本 message 字段 / text 段拼接 / 首尾空白', async () => {
  // 有些 OneBot 实现直接把纯文本放在 message 里
  assert.deepEqual(
    { ...(await segmentsToText('  你好呀  ')) },
    { ok: true, text: '你好呀', truncated: false, notes: [] }
  );

  const joined = await segmentsToText([text('今天'), text('下雨了')]);
  assert.equal(joined.ok, true);
  assert.equal(joined.text, '今天下雨了', '段之间不插分隔符');

  assert.equal((await segmentsToText([text('  两侧有空格  ')])).text, '两侧有空格');
  // 纯空白消息归一出空串（上层据此判空消息），不是失败
  assert.equal((await segmentsToText([text('   ')])).text, '');
});

test('@提及：@全体成员 / 昵称解析成功 / 解析不到回退 QQ 号 / 解析器抛错也只回退并记账', async () => {
  assert.equal((await segmentsToText([{ type: 'at', data: { qq: 'all' } }])).text, '@全体成员');

  const named = await segmentsToText([{ type: 'at', data: { qq: '10001' } }], {
    resolveAtName: async (qq) => (qq === '10001' ? '小明' : null)
  });
  assert.equal(named.text, '@小明');

  // 解析器返回 null：回退成 QQ 号，不算失败
  const fallback = await segmentsToText([{ type: 'at', data: { qq: '10002' } }], {
    resolveAtName: async () => null
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.text, '@10002');

  // 解析器抛错：仍回退成 QQ 号，但原因要进 notes（契约 F.5，不许空 catch 吞掉）
  const thrown = await segmentsToText([{ type: 'at', data: { qq: '10003' } }], {
    resolveAtName: async () => { throw new Error('成员列表超时'); }
  });
  assert.equal(thrown.ok, true, '昵称是增强，解析失败不该让整条消息失败');
  assert.equal(thrown.text, '@10003');
  assert.match(thrown.notes.join('\n'), /成员列表超时/);
});

test('图片段：图片 / 表情 / 市场表情 / 视频 / 文件都变成单行标注', async () => {
  assert.equal((await segmentsToText([{ type: 'image', data: { file: 'a.jpg' } }])).text, '[图片]');
  assert.equal((await segmentsToText([{ type: 'face', data: { id: '14' } }])).text, '[表情14]');
  assert.equal(
    (await segmentsToText([{ type: 'mface', data: { summary: '给你糖吃' } }])).text,
    '[表情:给你糖吃]',
    'mface 有 summary 就用它，别只给模型看 [mface]'
  );
  assert.equal((await segmentsToText([{ type: 'video', data: {} }])).text, '[视频]');
  assert.equal((await segmentsToText([{ type: 'file', data: { name: '报告.pdf' } }])).text, '[文件报告.pdf]');

  // 图文混排：位置与顺序原样保留
  const mixed = await segmentsToText([
    { type: 'at', data: { qq: 'all' } },
    text(' 看这个 '),
    { type: 'image', data: { url: 'http://x/1.png' } },
    text(' 好看吗')
  ]);
  assert.equal(mixed.text, '@全体成员 看这个 [图片] 好看吗');
});

test('语音段：record → [语音]（转文字由上层负责，这里只留位）', async () => {
  const r = await segmentsToText([{ type: 'record', data: { file: 'x.amr' } }]);
  assert.deepEqual(r, { ok: true, text: '[语音]', truncated: false, notes: [] });
});

test('转发段：带安全 id / 无 id / 非法 id 三种形状', async () => {
  const withId = await segmentsToText([{ type: 'forward', data: { id: 'abc-123_4' } }]);
  assert.equal(withId.text, '[转发消息 id=abc-123_4]');

  assert.equal((await segmentsToText([{ type: 'forward', data: {} }])).text, '[转发消息]');
  // id 含空白/控制字符时 sanitizeForwardId 返回空串：不许把它当参数塞进标注
  assert.equal((await segmentsToText([{ type: 'forward', data: { id: 'a b\nc' } }])).text, '[转发消息]');
  // res_id / file_id 也是线上出现过的字段名
  assert.equal((await segmentsToText([{ type: 'forward', data: { res_id: 'r-9' } }])).text, '[转发消息 id=r-9]');
});

test('空输入：空数组 / null / undefined 都归一成空串，不判失败', async () => {
  for (const input of [[], null, undefined]) {
    const r = await segmentsToText(input);
    assert.deepEqual(r, { ok: true, text: '', truncated: false, notes: [] }, String(input));
    const m = extractMediaFromSegments(input);
    assert.deepEqual(m, { ok: true, media: [] }, String(input));
  }
  // 纯文本 message：没有媒体段，但也不是「归一失败」（否则整条纯文本群消息会被丢掉）
  assert.deepEqual(extractMediaFromSegments('在吗'), { ok: true, media: [] });
});

test('未知段类型：兜底成 [type]，缺失 type 兜底成 [未知]，绝不丢内容也不抛', async () => {
  assert.equal((await segmentsToText([{ type: 'hologram', data: {} }])).text, '[hologram]');
  assert.equal((await segmentsToText([{ data: {} }])).text, '[未知]');
  // 数组里混进非对象元素：按未知段处理（旧实现同样落到 default 分支）
  assert.equal((await segmentsToText(['奇怪的字符串'])).text, '[未知]');
  // markdown 段：text 优先，content 次之
  assert.equal((await segmentsToText([{ type: 'markdown', data: { content: '**粗**' } }])).text, '**粗**');
  assert.equal((await segmentsToText([{ type: 'markdown', data: {} }])).text, '[Markdown]');
  // json 卡片：交给 forward.js 的卡片格式化，取不到标题就退成 [卡片消息]
  assert.equal(
    (await segmentsToText([{ type: 'json', data: { meta: { detail: { title: '周报', desc: '点开看' } } } }])).text,
    '[卡片:周报 - 点开看]'
  );
  assert.equal((await segmentsToText([{ type: 'json', data: {} }])).text, '[卡片消息]');
});

test('超长文本截断：默认不截断；给了 maxText 才截，且不切坏 emoji 代理对', async () => {
  const long = '哎'.repeat(5000);
  const untouched = await segmentsToText([text(long)]);
  assert.equal(untouched.text.length, 5000, '默认与搬出前逐字节一致：不截断');
  assert.equal(untouched.truncated, false);
  assert.deepEqual(untouched.notes, []);

  const cut = await segmentsToText([text(long)], { maxText: 100 });
  assert.equal(cut.ok, true);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 100);
  assert.match(cut.notes.join('\n'), /已截断/);

  // 😀 占两个码元：截在代理对中间时前移，宁可少留一个码元也不留孤立代理
  const emoji = await segmentsToText([text('😀😀😀')], { maxText: 3 });
  assert.equal(emoji.text, '😀');
  assert.equal(emoji.text.length, 2);
  assert.equal(emoji.truncated, true);

  // 恰好等于上限：不算截断
  const exact = await segmentsToText([text('12345')], { maxText: 5 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, '12345');

  // 非有限 / ≤0 的 maxText 视为「不截断」，不许把消息截成空串
  assert.equal((await segmentsToText([text('abc')], { maxText: 0 })).text, 'abc');
  assert.equal((await segmentsToText([text('abc')], { maxText: Number.NaN })).text, 'abc');
});

test('两遍：includeReply=true 带出被引用人和原文，false 只留本条消息自己的文字', async () => {
  const segments = [
    { type: 'reply', data: { id: '9527' } },
    text(' 这句话是对谁说的来着'),
    { type: 'image', data: {} }
  ];
  const resolveReply = async (id) =>
    (id === '9527' ? { sender: '小红', text: '明天几点集合' } : null);

  const withReply = await segmentsToText(segments, { resolveReply });
  // 段间空格原样保留（text 段自己带的那个前导空格），只在整体首尾 trim
  assert.equal(withReply.text, '[引用 小红：明天几点集合] 这句话是对谁说的来着[图片]');

  const plain = await segmentsToText(segments, { resolveReply, includeReply: false });
  assert.equal(plain.text, '这句话是对谁说的来着[图片]', '命令/指向性判断必须用这一遍');

  // 引用解析不到原文：留 [引用消息] 占位，不丢「这是一条引用」
  assert.equal((await segmentsToText([{ type: 'reply', data: { id: '1' } }])).text, '[引用消息]');
  // 解析器抛错：占位 + notes 记账
  const failed = await segmentsToText([{ type: 'reply', data: { id: '1' } }], {
    resolveReply: async () => { throw new Error('缓存过期'); }
  });
  assert.equal(failed.text, '[引用消息]');
  assert.match(failed.notes.join('\n'), /缓存过期/);
});

test('fail closed（仅本条消息）：形状不对或某段抛错 → ok:false，且绝不返回半截文本', async () => {
  // 旧实现到这里会抛 TypeError（不是可迭代对象）
  for (const bad of [42, true, { type: 'text', data: { text: 'x' } }]) {
    const r = await segmentsToText(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.code, 'INVALID_ARGS');
    assert.match(r.error, /消息段必须是数组或纯文本/);
    assert.equal(r.text, undefined, '失败结果里不许有半截文本');
  }

  // 前一段正常、后一段取值器抛错：整条失败，不能只交前半截
  const boom = { type: 'text' };
  Object.defineProperty(boom, 'data', { get() { throw new Error('网关返回了坏段'); } });
  const r = await segmentsToText([text('前半截'), boom, text('后半截')]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UPSTREAM');
  assert.equal(r.text, undefined, '半截文本比没有文本更危险（会答错人）');
  assert.match(r.error, /第 2\/3 段/);
  assert.match(r.error, /网关返回了坏段/);

  // 媒体提取同一条消息同样按失败处理
  const badMedia = { type: 'image' };
  Object.defineProperty(badMedia, 'data', { get() { throw new Error('坏图'); } });
  const m = extractMediaFromSegments([badMedia]);
  assert.equal(m.ok, false);
  assert.equal(m.code, 'UPSTREAM');
  assert.equal(m.media, undefined);
  assert.match(m.error, /坏图/);
});

test('媒体提取：image / mface / face 的字段一个都不能丢，摘要压掉换行并限长', async () => {
  const media = extractMediaFromSegments([
    { type: 'text', data: { text: '不算媒体' } },
    {
      type: 'image',
      data: {
        file: 'abc.image',
        url: 'http://cdn/x',
        sub_type: '1',            // 线上是 snake_case
        summary: '坏摘要\n带换行',
        emoji_id: 'e1',
        emoji_package_id: 'p1',
        key: 'k1'
      }
    },
    { type: 'mface', data: { url: 'http://cdn/y', emoji_id: 'e2', summary: '糖' } },
    { type: 'face', data: { id: '178', url: 'http://cdn/z', summary: '[微笑]' } }
  ]);

  assert.equal(media.ok, true);
  assert.deepEqual(media.media, [
    {
      kind: 'image',
      file: 'abc.image',
      url: 'http://cdn/x',
      subType: '1',
      summary: '坏摘要 带换行',   // 换行被压成空格：否则摘要能伪造提示词段落
      emojiId: 'e1',
      emojiPackageId: 'p1',
      emojiKey: 'k1'
    },
    {
      kind: 'sticker',
      file: '',
      url: 'http://cdn/y',
      subType: '1',             // mface 固定标成表情，别被当成普通图片
      summary: '糖',
      emojiId: 'e2',
      emojiPackageId: '',
      emojiKey: ''
    },
    { kind: 'face', faceId: '178', url: 'http://cdn/z', summary: '[微笑]' }
  ]);

  // camelCase 的 subType 也要认（SDK 内部元素用这个拼法）
  const camel = extractMediaFromSegments([{ type: 'image', data: { subType: 0, summary: 'x'.repeat(200) } }]);
  assert.equal(camel.media[0].subType, '0');
  assert.equal(camel.media[0].summary.length, 60, '摘要限长 60');
  assert.equal(sanitizeMediaSummary(null), '');
  assert.equal(sanitizeMediaSummary('\u0000\u0007'), '');
});

test('契约门面 handle：text / plain / media 三个动作与未知动作', async () => {
  const segments = [{ type: 'reply', data: { id: '1' } }, text('在吗')];

  const t = await handle({}, { action: 'text', segments, resolveReply: async () => ({ sender: 'A', text: '在' }) });
  assert.equal(t.text, '[引用 A：在]在吗');

  const p = await handle({}, { action: 'plain', segments });
  assert.equal(p.text, '在吗');

  const m = handle({}, { action: 'media', segments: [{ type: 'image', data: { file: 'f' } }] });
  assert.equal(m.ok, true);
  assert.equal(m.media.length, 1);

  const bad = handle({}, { action: 'video' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  assert.match(bad.error, /只支持 text \/ plain \/ media/);
});
