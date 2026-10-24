// 表情精准（qq_sticker_suggest + fetch_custom_face 同步 + 唤醒表情块）自检：
// 1) sticker-lib 新纯函数：URL→id/md5、fetch_custom_face URL 合并、推荐打分、唤醒块
// 2) config 新开关、bridge 路由、MCP 工具注册的存在性
// 3) 可选 live：QQ_BRIDGE_TEST_LIVE=1 时真打一次 fetch_custom_face 验证 URL 形状
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  applyStickerNote,
  markStickerUsed,
  stickerIdFromUrl,
  md5FromStickerId,
  mergeCustomFaceUrls,
  suggestStickers,
  buildStickerContext,
  buildStickerContextSmart
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

const QQ_URL = (id) => `https://p.qpic.cn/qq_expression/3325026093/${id}/0`;
const FACE_ID_A = '3325026093_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const FACE_ID_B = '3325026093_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';

console.log('## URL → id / md5');
{
  ok(stickerIdFromUrl(QQ_URL(FACE_ID_A)) === FACE_ID_A, '从 QQ 表情 URL 取到 emoji_id');
  ok(stickerIdFromUrl('https://p.qpic.cn/qq_expression/1/12345678/0') === '12345678', '短数字尾巴也接受');
  ok(stickerIdFromUrl('') === '' && stickerIdFromUrl('not a url') === '', '空/非 URL 返回空');
  ok(stickerIdFromUrl(QQ_URL(FACE_ID_A) + '/') === FACE_ID_A, '末尾多一个斜杠也能解析');
  ok(stickerIdFromUrl('javascript:alert(1)') === '', 'javascript: 被拒');
  ok(stickerIdFromUrl('https://user:pass@x/y/' + 'a'.repeat(10)) === '', '带 userinfo 的 URL 被拒');
  ok(md5FromStickerId(FACE_ID_A) === 'A'.repeat(32), '从 id 抽出 md5');
  ok(md5FromStickerId('abc') === '', '没有 md5 时返回空');
}

console.log('## fetch_custom_face URL 合并');
{
  const existing = [
    normalizeStickerEntry({ id: FACE_ID_A, resId: FACE_ID_A, url: QQ_URL(FACE_ID_A), desc: '哼', localNote: '被噎住', tags: ['哼'], useCount: 4, lastUsedAt: 111, source: 'qq' }),
    normalizeStickerEntry({ id: 'manual-1', resId: 'manual-1', source: 'manual', desc: '手动条目' })
  ];
  const urls = [QQ_URL(FACE_ID_A), QQ_URL(FACE_ID_B), 'https://bad/@@', ''];
  const r = mergeCustomFaceUrls(existing, urls);
  ok(r.added === 1, `新增 1 条（实际 ${r.added}）`);
  ok(r.updated === 1, '已存在条目补全 1 条');
  ok(r.skipped === 2, '非法 URL 跳过 2 条');
  const a = r.entries.find((e) => e.id === FACE_ID_A);
  ok(a.desc === '哼' && a.localNote === '被噎住' && a.useCount === 4 && a.lastUsedAt === 111, '已存在条目保留 desc/note/使用统计');
  ok(a.source === 'qq', '已存在条目 source 不变');
  const b = r.entries.find((e) => e.id === FACE_ID_B);
  ok(b && b.source === 'custom_face', '新增条目 source=custom_face');
  ok(b.desc === '' && b.localNote === '' && b.useCount === 0, '新增条目 desc 留空、统计归零');
  ok(b.md5 === 'B'.repeat(32), '新增条目自动带 md5');
  ok(r.entries.some((e) => e.id === 'manual-1'), '手动条目不受影响');
  // detail 同步删除了 qq 条目，但 custom_face 条目不应被误删
  const pruned = mergeStickerLibrary(r.entries, [], { complete: true });
  ok(pruned.some((e) => e.id === FACE_ID_B), 'custom_face 条目不会被 detail 的「完整同步」误删');
  // 按 md5 兜底匹配：id 不同的同图不重复新增
  const byMd5 = mergeCustomFaceUrls([
    normalizeStickerEntry({ id: 'old-id', resId: 'old-id', md5: 'C'.repeat(32), desc: '同名图' })
  ], [QQ_URL('3325026093_0_0_0_' + 'C'.repeat(32) + '_0_0')]);
  ok(byMd5.added === 0 && byMd5.entries.length === 1 && byMd5.entries[0].desc === '同名图', 'md5 相同视为同一张，不重复新增');
}

console.log('## 推荐打分（suggestStickers）');
{
  let list = [
    normalizeStickerEntry({ id: 's1', resId: 's1', desc: '小黄鸡滚地大笑', localNote: '笑到失控', tags: ['大笑', '嘲讽'], useCount: 5, lastUsedAt: 5000 }),
    normalizeStickerEntry({ id: 's2', resId: 's2', desc: '哼哼/不爽', localNote: '撇嘴瞪人', tags: ['不爽', '哼'], useCount: 3, lastUsedAt: 4000 }),
    normalizeStickerEntry({ id: 's3', resId: 's3', desc: '躺着装死', localNote: '偷感很重、装无辜', tags: ['装死', '卖萌'], useCount: 2, lastUsedAt: 3000 }),
    normalizeStickerEntry({ id: 's4', resId: 's4', desc: '', localNote: '', tags: [], useCount: 0, lastUsedAt: 0 }),
    normalizeStickerEntry({ id: 's5', resId: 's5', desc: '摸头安慰', localNote: '安慰对方', tags: ['安慰', '摸头'], useCount: 0, lastUsedAt: 0 })
  ];
  // 最近 3 次用过的（s1/s2/s3）必须被避开
  const r = suggestStickers(list, '安慰一下对方', { limit: 3, excludeRecent: 3 });
  ok(r.excluded.length === 3, '返回最近用过的 3 张');
  ok(r.suggestions.every((s) => !['s1', 's2', 's3'].includes(s.id)), '推荐结果避开最近用过的 3 张');
  ok(r.suggestions[0].id === 's5', '最贴合语境的 s5 排第一');
  ok(/安慰|摸头/.test(r.suggestions[0].reason), `理由说明命中点（${r.suggestions[0].reason}）`);
  ok(r.suggestions.length === 2, '候选不够时只返回可用的（2 条）');

  const selfharm = suggestStickers(list, '大笑 嘲讽', { limit: 1, excludeRecent: 0 });
  ok(selfharm.suggestions[0].id === 's1', '标签/备注命中最多的排第一');
  ok(selfharm.excluded.length === 0, 'excludeRecent=0 时不排除');

  // hint 为空：优先从没用过的
  const blank = suggestStickers(list, '', { limit: 2, excludeRecent: 3 });
  ok(blank.suggestions.every((s) => s.neverUsed), '空 hint 优先推没用过的');
  ok(blank.suggestions[0].reason.includes('没用过'), '空 hint 理由说明「没用过」');

  // top 数量上限
  const limited = suggestStickers(list, '', { limit: 99, excludeRecent: 0 });
  ok(limited.suggestions.length === 5, 'limit 超过候选数时返回全部候选');
  ok(suggestStickers([], '笑', {}).suggestions.length === 0, '空库返回空推荐');

  // 使用一次后再推荐，该张应进入 excluded
  const used = markStickerUsed(list, 's5', 'test');
  const r2 = suggestStickers(used.entries, '安慰', { limit: 3, excludeRecent: 3 });
  ok(r2.excluded.some((e) => e.id === 's5'), '刚用过的会被排除（最近 3 张）');
  ok(r2.suggestions.every((s) => s.id !== 's5'), '推荐里不再出现刚用过的');
}

console.log('## 唤醒表情块（buildStickerContextSmart）');
{
  ok(buildStickerContextSmart([]) === '', '空库返回空串');
  const list = [];
  for (let i = 1; i <= 4; i += 1) {
    list.push(normalizeStickerEntry({ id: `used${i}`, resId: `used${i}`, desc: `常用${i}`, tags: ['常用'], useCount: i, lastUsedAt: 1000 * i }));
  }
  for (let i = 1; i <= 3; i += 1) {
    list.push(normalizeStickerEntry({ id: `new${i}`, resId: `new${i}`, desc: `新表情${i}`, createdAt: new Date(2026, 0, i).toISOString() }));
  }
  const block = buildStickerContextSmart(list, { recent: 3, unused: 2 });
  ok(block.includes('最近用过') && block.includes('还没试过'), '同时有「最近用过」与「还没试过」两段');
  const recentLine = block.split('\n').filter((l) => l.startsWith('- [用过'));
  ok(recentLine.length === 3, `最近用过 3 张（实际 ${recentLine.length}）`);
  ok(block.includes('常用4') && block.includes('常用3') && block.includes('常用2'), '最近用过按 lastUsedAt 倒序取 3');
  ok(!block.includes('- [用过1次] 常用1'), '第 4 近的没有挤进最近用过段');
  const unusedLines = block.split('\n').filter((l) => l.startsWith('- [没用过]'));
  ok(unusedLines.length === 2, `从没用过 2 张（实际 ${unusedLines.length}）`);
  ok(block.includes('新表情'), '新表情出现在「还没试过」段');
  ok(!block.includes('\n【'), '块内不会伪造新段落（单行化）');
  ok(block.includes('qq_sticker_suggest'), '块内提示可用 qq_sticker_suggest(hint) 问一句（Lead 追加要求）');
  ok(buildStickerContextSmart(list, { recent: 0, unused: 0 }) === '', 'recent/unused 都为 0 时返回空串（不崩）');
  // 没备注的表情给出看图提示
  const bare = buildStickerContextSmart([normalizeStickerEntry({ id: 'b', resId: 'b' })], { recent: 1, unused: 1 });
  ok(bare.includes('无备注'), '没有备注时提示可先看图');
  // 旧函数保持原样（既有测试依赖）
  ok(buildStickerContext([normalizeStickerEntry({ id: 'x', resId: 'x', desc: '笑死' })], 8).includes('笑死'), 'buildStickerContext 仍保留（兼容）');
}

console.log('## 配置与接线');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  ok(cfg.socialV2?.tools?.stickerSuggest === true, 'config tools.stickerSuggest=true');
  ok(cfg.socialV2?.tools?.memeAdd === true, 'config tools.memeAdd=true');

  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-suggest', 'suggestStickers', 'fetchCustomFaceUrls', 'fetch_custom_face', 'buildStickerContextSmart', 'mergeCustomFaceUrls']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
  ok(bridge.includes("await fetchCustomFaceUrls(50)"), '同步表情时带 count=50 调 fetch_custom_face');

  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  ok(mcp.includes("'qq_sticker_suggest'"), 'MCP 工具 qq_sticker_suggest 已注册');
  ok(mcp.includes("qq_sticker_suggest: 'stickerSuggest'"), 'MCP 工具开关 stickerSuggest 已登记');
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：fetch_custom_face 链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 50 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face 调用成功');
    const urls = Array.isArray(body.data) ? body.data : [];
    ok(urls.length > 0, `返回 ${urls.length} 个表情 URL`);
    ok(urls.every((u) => stickerIdFromUrl(u)), '每个 URL 都能解析出 emoji_id');
    const merged = mergeCustomFaceUrls([], urls);
    ok(merged.added === urls.length, `合并新增 ${merged.added}/${urls.length} 条`);
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
