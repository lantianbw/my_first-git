// QQ 生态工具（task-3）自检：
// 1) eco-lib 纯逻辑：限额（点赞按天/其它按窗口）、返回数据压缩、表情回应编码校验
// 2) 越权/超限/非本人消息等错误分支的**逻辑层**验证（路由在 bridge 里，不能重启就静态断言关键校验）
// 3) config 开关、bridge 路由、MCP 工具注册与开关登记的存在性
// 4) 可选 live：只打只读 action（get_group_info 等），不触发任何写操作
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ECO_DEFAULTS,
  normalizeEcoConfig,
  normalizeEcoActions,
  dayKey,
  takeLikeQuota,
  takeWindowQuota,
  compactGroupInfo,
  compactGroupMembers,
  compactGroupNotices,
  compactGroupHonor,
  compactGroupFiles,
  compactEssenceList,
  normalizeReactionCode
} from '../src/eco-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## 配置归一化');
{
  const d = normalizeEcoConfig({});
  ok(d.limits.sendLike.perUserPerDay === 3 && d.limits.sendLike.totalPerDay === 20, '默认点赞限额 3/人/天、20/天');
  ok(d.limits.setGroupCard.perHour === 2, '默认群名片 2 次/小时');
  const clamp = normalizeEcoConfig({ limits: { sendLike: { perUserPerDay: 999, totalPerDay: -5 }, msgReaction: { perMinute: 'abc' } }, maxItems: { groupMembers: 99999 } });
  ok(clamp.limits.sendLike.perUserPerDay === 10, '每人每天上限 clamp 到 10');
  ok(clamp.limits.sendLike.totalPerDay === 0, '总量负数 clamp 到 0');
  ok(clamp.limits.msgReaction.perMinute === ECO_DEFAULTS.limits.msgReaction.perMinute, '非法字符串回退默认');
  ok(clamp.maxItems.groupMembers === 300, '列表条数 clamp 到 300');
}

console.log('## 动作记录归一化');
{
  const n = normalizeEcoActions({
    likes: { date: '2026-10-22', total: 3, users: { 1843979560: 2, abc: 5, 123456: '7' } },
    times: { card: [1, 2, 'x', -1], deleteMessage: [] }
  });
  ok(n.likes.date === '2026-10-22' && n.likes.total === 3, '保留合理点赞记录');
  ok(!('abc' in n.likes.users), '非数字用户 id 被丢弃');
  ok(n.likes.users['123456'] === 7, '字符串次数被归一为数字');
  ok(n.times.card.length === 2 && n.times.card[0] === 1, '合法时间戳保留、非法（字符串/负数）被过滤');
  const junk = normalizeEcoActions(null);
  ok(junk.likes.total === 0 && junk.times.card.length === 0, 'null 输入得到空记录（不崩）');
  ok(dayKey(new Date(2026, 9, 22, 23, 59).getTime()) === '2026-10-22', 'dayKey 用本地日期');
}

console.log('## 点赞配额（每人每天 3 / 总量 20）');
{
  let state = normalizeEcoActions({});
  const limits = ECO_DEFAULTS.limits;
  const now = new Date(2026, 9, 22, 10, 0).getTime();
  const q1 = takeLikeQuota(state, '1843979560', 1, limits, now);
  ok(q1.granted === 1 && q1.state.likes.users['1843979560'] === 1, '第一次点赞放行');
  state = q1.state;
  const q2 = takeLikeQuota(state, '1843979560', 5, limits, now + 1000);
  ok(q2.granted === 2, '同一人被每日 3 次上限截断（已用 1，剩 2）');
  state = q2.state;
  const q3 = takeLikeQuota(state, '1843979560', 1, limits, now + 2000);
  ok(q3.granted === 0 && /每人每天/.test(q3.reason), '超过每人上限：granted=0 且说明原因');
  // 换个人还能点
  const q4 = takeLikeQuota(state, '2453753245', 1, limits, now + 3000);
  ok(q4.granted === 1, '换一个目标不受别人额度影响');
  state = q4.state;
  ok(state.likes.total === 4, '总量累计 4');
  // 跨天重置
  const tomorrow = new Date(2026, 9, 23, 0, 30).getTime();
  const q5 = takeLikeQuota(state, '1843979560', 1, limits, tomorrow);
  ok(q5.granted === 1 && q5.state.likes.total === 1, '跨天后额度重置');
  ok(q5.state.likes.date === '2026-10-23', '记录日期翻页');
  // 总量上限
  let big = normalizeEcoActions({ likes: { date: dayKey(now), total: 20, users: {} } });
  const q6 = takeLikeQuota(big, '999', 1, limits, now);
  ok(q6.granted === 0 && /总量/.test(q6.reason), '全账号总量 20 次后拒绝并说明原因');
}

console.log('## 滑动窗口配额');
{
  const now = new Date(2026, 9, 22, 10, 0).getTime();
  let state = normalizeEcoActions({});
  const r1 = takeWindowQuota(state, 'card', 2, 3600000, now);
  ok(r1.allowed && r1.used === 1, '窗口内第一次放行');
  const r2 = takeWindowQuota(r1.state, 'card', 2, 3600000, now + 1000);
  ok(r2.allowed, '第二次放行');
  const r3 = takeWindowQuota(r2.state, 'card', 2, 3600000, now + 2000);
  ok(!r3.allowed && r3.retryAfterMs > 0, '第三次拒绝并给出重试等待');
  const r4 = takeWindowQuota(r3.state, 'card', 2, 3600000, now + 3600001);
  ok(r4.allowed, '窗口滑过后恢复');
  const off = takeWindowQuota(state, 'card', 0, 3600000, now);
  ok(!off.allowed && /上限 0/.test(off.reason), '限额配成 0 = 关闭该动作');
}

console.log('## 返回数据压缩');
{
  const info = compactGroupInfo({
    group_id: 1057896469, group_name: '真爱粉', member_count: 4, max_member_count: 200,
    group_create_time: 1765355965, group_level: 0, group_memo: 'm', group_description: 'd', group_all_shut: 0
  });
  ok(info.groupId === '1057896469' && info.name === '真爱粉' && info.memberCount === 4, '群资料字段映射');
  ok(info.maxMemberCount === 200 && info.createTime === 1765355965, '群资料数值字段');
  ok(compactGroupInfo(null).name === '', '空入参不崩');

  const members = [];
  for (let i = 0; i < 120; i += 1) {
    members.push({ user_id: 1000 + i, nickname: i === 7 ? '大肥鱼' : `群友${i}`, card: i === 7 ? '鱼' : '', role: 'member', level: '10', qq_level: 30, join_time: 1, last_sent_time: 1 });
  }
  const m = compactGroupMembers(members, { limit: 100 });
  ok(m.total === 120 && m.members.length === 100 && m.truncated === true, '群成员默认截断到 100');
  ok(m.members[0].userId === '1000' && m.members[0].nickname === '群友0', '成员字段映射');
  ok(m.members.every((x) => 'qqLevel' in x && 'lastSentTime' in x && 'joinTime' in x), '成员返回约定字段齐全');
  const q = compactGroupMembers(members, { limit: 100, query: '大肥鱼' });
  ok(q.matched === 1 && q.members[0].userId === '1007', '按昵称过滤');
  const q2 = compactGroupMembers(members, { limit: 100, query: '1007' });
  ok(q2.matched === 1, '按 QQ 号过滤');

  const notices = compactGroupNotices([
    { sender_id: 1, publish_time: 1, message: { text: '群规：别刷屏', images: [{}, {}] } },
    { sender_id: 2, publish_time: 2, content: '活动通知' }
  ], 5);
  ok(notices.total === 2 && notices.notices[0].text === '群规：别刷屏', '公告文本解析');
  ok(notices.notices[0].imageCount === 2, '公告图片计数');
  ok(notices.notices[1].text === '活动通知', '兼容扁平 content 字段');
  ok(compactGroupNotices(null, 5).notices.length === 0, '空公告不崩');

  const honor = compactGroupHonor({
    group_id: 1,
    current_talkative: { user_id: 1, nickname: '龙王', description: '今日发言最多' },
    talkative_list: [{ user_id: 2, nickname: '话痨' }],
    performer_list: [], legend_list: [], emotion_list: [], strong_newbie_list: []
  }, 10);
  ok(honor.currentTalkative.items[0].nickname === '龙王', '当前龙王解析');
  ok(honor.talkative.total === 1, '话痨榜解析');
  ok(Array.isArray(honor.legend.items) && honor.legend.total === 0, '空榜结构稳定');

  const files = compactGroupFiles({
    files: [{ file_id: '/a', file_name: '界海.wld', busid: 102, file_size: 12136049, upload_time: 1, uploader: 1843979560, uploader_name: '真爱粉', download_times: 1 }],
    folders: [{ folder_id: 'f1', folder_name: '存档', total_file_count: 3 }]
  }, { limit: 30 });
  ok(files.total === 1 && files.files[0].name === '界海.wld' && files.files[0].size === 12136049, '群文件字段映射');
  ok(files.folders[0].folderId === 'f1' && files.folders[0].totalFileCount === 3, '文件夹映射');
  ok(compactGroupFiles(null, {}).files.length === 0, '空群文件不崩');

  const essence = compactEssenceList([
    { message_id: -123, sender_id: 1, sender_nick: '甲', message_time: 1, text: '名场面' }
  ], 20);
  ok(essence.total === 1 && essence.items[0].messageId === '-123' && essence.items[0].text === '名场面', '精华消息字段映射');
  ok(compactEssenceList(null, 20).items.length === 0, '空精华不崩');
}

console.log('## 表情回应编码校验');
{
  ok(normalizeReactionCode('76') === '76', '76（/赞）通过');
  ok(normalizeReactionCode('') === '76', '空值默认 76');
  ok(normalizeReactionCode(undefined) === '76', 'undefined 默认 76');
  ok(normalizeReactionCode('1234') === '', '4 位数字被拒（自定义表情留给后续）');
  ok(normalizeReactionCode('abc') === '' && normalizeReactionCode('7a') === '', '非数字被拒');
}

console.log('## 配置 / 接线存在性');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const flags = ['groupInfo', 'groupNotice', 'groupHonor', 'groupFiles', 'essenceList', 'groupMembers', 'setGroupCard', 'sendLike', 'deleteMessage', 'inputStatus', 'msgReaction'];
  for (const flag of flags) ok(cfg.socialV2?.tools?.[flag] === true, `config tools.${flag}=true`);
  ok(cfg.socialV2?.eco?.limits?.sendLike?.perUserPerDay === 3, 'config eco 点赞每人限额 3');
  ok(cfg.socialV2?.eco?.limits?.setGroupCard?.perHour === 2, 'config eco 群名片每小时 2');

  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const route of [
    '/api/socialV2/group-info', '/api/socialV2/group-notice', '/api/socialV2/group-honor',
    '/api/socialV2/group-files', '/api/socialV2/essence-list', '/api/socialV2/group-members',
    '/api/socialV2/set-group-card', '/api/socialV2/send-like', '/api/socialV2/delete-message',
    '/api/socialV2/input-status', '/api/socialV2/msg-reaction'
  ]) ok(bridge.includes(route), `bridge 路由 ${route}`);

  // 安全校验关键断言（路由不能真跑，静态确认校验逻辑没被漏掉）
  ok(bridge.includes("'_get_group_notice'"), '群公告用正确 action _get_group_notice');
  ok(!bridge.includes("'get_group_notice'"), '没有用错误的 get_group_notice（会 1404）');
  ok(bridge.includes("'set_group_reaction'"), '表情回应用 set_group_reaction（Lead 修正）');
  ok(bridge.includes('不在白名单（config.allow.groups）内'), '显式群号走白名单校验');
  ok(bridge.includes('只允许当前会话所在群'), '群名片不接受跨群 groupId');
  ok(bridge.includes('只允许 owner、allow.private 名单或白名单群成员'), '点赞目标权限校验存在');
  ok(bridge.includes('m.isSelf') && bridge.includes('只能撤回本会话里你自己刚发出的消息'), '撤回只允许自己的消息（isSelf 校验）');
  ok(bridge.includes('跨重启的旧消息撤不回'), '撤回失败文案提示 messageStore 限制');
  ok(bridge.includes('msgReactionMinute') && bridge.includes('msgReactionHour'), '表情回应有每分钟+每小时双限');
  ok(bridge.includes("send_custom_face"), '发表情优先 send_custom_face');
  ok(bridge.includes('回退 image 段'), 'send_custom_face 失败回退 image 段');
  ok(bridge.includes("'card', ecoLimits().setGroupCard.perHour"), '群名片按小时限流接线');
  ok(bridge.includes('takeLikeQuota(ecoActions'), '点赞配额接线');
  ok(bridge.includes('saveEcoActions'), '配额落盘 state/eco-actions.json');
  ok(bridge.includes('ecoGate('), '生态工具统一闸门存在');

  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const toolNames = ['qq_group_info', 'qq_group_notice', 'qq_group_honor', 'qq_group_files', 'qq_essence_list', 'qq_group_members', 'qq_set_group_card', 'qq_send_like', 'qq_delete_message', 'qq_set_input_status', 'qq_msg_reaction'];
  for (const name of toolNames) ok(mcp.includes(`'${name}'`), `MCP 工具 ${name} 已注册`);
  for (const name of toolNames) ok(mcp.includes(`${name}: '`) || mcp.includes(`'${name}'`), `MCP 工具 ${name} 有开关登记`);
  ok(mcp.includes("qq_send_like: 'sendLike'") && mcp.includes("qq_msg_reaction: 'msgReaction'"), 'MCP 开关映射存在');
  ok(mcp.includes('只支持群消息'), 'MCP 描述里 qq_msg_reaction 注明只支持群消息');
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：只读 action（不触发任何写操作）');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const groupId = Number((cfg.allow?.groups ?? [])[0] || 0);
    ok(groupId > 0, `白名单群号存在（${groupId}）`);
    const call = async (action, params) => {
      const res = await fetch(`${base}/${action}`, { method: 'POST', headers, body: JSON.stringify(params), signal: AbortSignal.timeout(20000) });
      const body = await res.json();
      return body;
    };
    const info = await call('get_group_info', { group_id: groupId });
    ok(info.status === 'ok' && info.data?.group_name, `get_group_info ok：${info.data?.group_name}`);
    const members = await call('get_group_member_list', { group_id: groupId });
    ok(members.status === 'ok' && Array.isArray(members.data), `get_group_member_list ok（${members.data?.length} 人）`);
    ok(compactGroupMembers(members.data, { limit: 5 }).members.length <= 5, '群成员压缩可用');
    const notice = await call('_get_group_notice', { group_id: groupId });
    ok(notice.status === 'ok' && Array.isArray(notice.data), `_get_group_notice ok（${notice.data?.length} 条）`);
    const honor = await call('get_group_honor_info', { group_id: groupId, type: 'all' });
    ok(honor.status === 'ok', 'get_group_honor_info ok');
    const files = await call('get_group_root_files', { group_id: groupId });
    ok(files.status === 'ok' && Array.isArray(files.data?.files), `get_group_root_files ok（${files.data?.files?.length} 个文件）`);
    const essence = await call('get_essence_msg_list', { group_id: groupId });
    ok(essence.status === 'ok' && Array.isArray(essence.data), `get_essence_msg_list ok（${essence.data?.length} 条）`);
    const detail = await call('fetch_custom_face_detail', { count: 3 });
    ok(detail.status === 'ok' && detail.data?.[0]?.emoji_id, 'fetch_custom_face_detail 的 emoji_id 可直接当 send_custom_face 的 emoji_id');
  } catch (error) {
    ok(false, `live 只读链路异常: ${error?.message ?? error}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
