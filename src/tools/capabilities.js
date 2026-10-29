// tools/capabilities — 能力清单（人话）+ 告警出口的两块纯逻辑
//
// 契约：docs/module-contract.md v1.1（B.1 spec；纯函数按 E.2 标 @pure）
// deps：无
// 失败策略：fail open            （依据：D 表「能力清单只影响模型怎么介绍自己，读坏了最多少一句介绍」）
// 单测：tests/capabilities.test.mjs
//
// 为什么存在（M11）：
//   ① 模型被问「你会什么」时，手里只有一串 qq_ 工具名，说不成人话；关掉的功能连名字都还在，
//      它照样敢说「我会发语音」，然后调用拿 403。能力清单把「开了什么 / 关了什么 / 为什么关」
//      一次性摊开，供 qq_get_prompt 返回、供人格自述引用。
//   ② qq_report_feedback(level='error') 以前只写日志，坏了没人知道。这里补上告警内容的
//      捏造（【她的报告】<会话>：<内容>）和 10 分钟同内容去重，桥接只负责发。
//
// 为什么告警逻辑也放这个文件：M11 只允许新增这一个源文件（见 docs/module-ownership.md），
// 而「能力清单」与「出问题怎么告诉主人」本就是同一件事的两面：能做什么 / 做不成怎么开口。
//
// 边界：不读 state、不读系统时钟（冷却的 now 由调用方注入）、不写文件、不记日志、不发消息。
//
// 能力形状（qq_get_prompt 返回 capabilities 的每一项，字段已钉死，M12 会引用）：
//   { name: string, desc: string, enabled: boolean, why?: string }
//   - name  人话能力名（「发语音」），不是工具名
//   - desc  一句话人话说明，**不出现 qq_ 工具名、不描述实现**
//   - enabled 现在能不能用（工具开关 + 体系总闸都开着才算 true）
//   - why   只有 enabled=false 时才有：一句人话原因（「语音发送没开」）
//
// 开关口径与 src/bridge.js 的 v2ToolEnabled 保持一致：`tools[flag] !== false`，即**没写 = 开**。
// 传进来的应当是桥接已经合并过默认值的那份 cfg（那里 sendVoice / speak 默认 false）。

export const spec = Object.freeze({
  name: 'tools/capabilities',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'free', default: true, hot: true })
});

/**
 * 体系总闸的关闭原因（与工具开关的 why 分开写，便于一眼看出是「这一项没开」还是「整套关了」）。
 * 三个闸门在 bridge 里分别是 stickerEnabled() / memeEnabled() / voiceCfg().enabled。
 */
const GATE_REASONS = Object.freeze({
  voice: '语音功能整个关着',
  sticker: '表情包体系已关闭',
  meme: '梗库已关闭'
});

/**
 * 人话能力表（顺序即展示顺序：先「日常聊天」，再「内容/资料」，最后「运维」）。
 *
 * flags：支撑这项能力所必需的工具开关（全部为开才算可用；只列核心工具，
 *        例如表情包不把默认关闭的 setStickerRemark 算进来，否则整项会被误判成关）。
 * gate： 额外需要的体系总闸，见 GATE_REASONS。
 * why：  工具开关被关掉时的原因文案。
 */
const CAPABILITY_CATALOG = Object.freeze([
  Object.freeze({
    name: '看消息',
    desc: '翻群里和私聊最近的聊天，谁说了什么、有没有漏看的',
    flags: Object.freeze(['getUnread', 'getRecent', 'getMyRecent', 'getMessageDetail', 'getActiveMembers']),
    why: '消息读取被关掉了'
  }),
  Object.freeze({
    name: '说话',
    desc: '在群里或私聊发文字，可以拆成几条接着发',
    flags: Object.freeze(['sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage']),
    why: '发消息被关掉了'
  }),
  Object.freeze({
    name: '等新消息',
    desc: '先不答，等有人说话再醒过来',
    flags: Object.freeze(['waitMessages']),
    why: '等消息被关掉了'
  }),
  Object.freeze({
    name: '自己定作息',
    desc: '决定什么时候留意群、什么时候去睡',
    flags: Object.freeze(['setWakeConfig', 'markRead']),
    why: '作息调整被关掉了'
  }),
  Object.freeze({
    name: '发语音',
    desc: '把语音库里的音频当 QQ 语音发出去',
    flags: Object.freeze(['sendVoice']),
    gate: 'voice',
    why: '语音发送没开'
  }),
  Object.freeze({
    name: '直接开口说',
    desc: '把一句话现合成语音发出去，不用先准备音频',
    flags: Object.freeze(['speak']),
    gate: 'voice',
    why: '合成语音没开'
  }),
  Object.freeze({
    name: '发表情包',
    desc: '从收藏的表情里挑一个发出去，也能收新表情',
    flags: Object.freeze(['listStickers', 'sendSticker', 'getStickerImage']),
    gate: 'sticker',
    why: '发表情包被关掉了'
  }),
  Object.freeze({
    name: '攒梗',
    desc: '把好笑的对话记成梗，聊天时拿出来用',
    flags: Object.freeze(['memeAdd', 'memeQuery', 'memeList']),
    gate: 'meme',
    why: '梗库被关掉了'
  }),
  Object.freeze({
    name: '记事',
    desc: '记日程、备忘和待办，到点提醒',
    flags: Object.freeze(['memo']),
    why: '记事本被关掉了'
  }),
  Object.freeze({
    name: '写日记',
    desc: '把当天的事写成日记，以后能翻回来',
    flags: Object.freeze(['diary']),
    why: '日记被关掉了'
  }),
  Object.freeze({
    name: '记心情',
    desc: '记下自己这会儿的情绪，过一阵回头结算',
    flags: Object.freeze(['mood']),
    why: '心情记录被关掉了'
  }),
  Object.freeze({
    name: '记自己',
    desc: '记下自己是谁、在意什么，慢慢攒成自画像',
    flags: Object.freeze(['selfview']),
    why: '自画像被关掉了'
  }),
  Object.freeze({
    name: '记住人',
    desc: '记住某人的脾气、说过的话和不能碰的边界',
    flags: Object.freeze(['memory']),
    why: '记忆被关掉了'
  }),
  Object.freeze({
    name: '学黑话',
    desc: '问群里的话是什么意思，学会了记下来',
    flags: Object.freeze(['slangQuery', 'slangSubmit']),
    why: '黑话学习被关掉了'
  }),
  Object.freeze({
    name: '看图',
    desc: '看清图片里是什么，包括表情和自己的图',
    flags: Object.freeze(['getImages', 'ocrImage', 'getSelfImage']),
    why: '看图被关掉了'
  }),
  Object.freeze({
    name: '看转发',
    desc: '翻出聊天记录转发里到底说了什么',
    flags: Object.freeze(['getForwardMsg']),
    why: '转发内容解析被关掉了'
  }),
  Object.freeze({
    name: '听语音',
    desc: '把别人发的语音转成文字看',
    flags: Object.freeze(['voiceText']),
    why: '语音转文字被关掉了'
  }),
  Object.freeze({
    name: '看群资料',
    desc: '查群信息、群公告、群文件、群成员和精华，改自己的群名片',
    flags: Object.freeze(['groupInfo', 'groupNotice', 'groupHonor', 'groupFiles', 'groupMembers', 'essenceList', 'setGroupCard']),
    why: '群资料查询被关掉了'
  }),
  Object.freeze({
    name: '小动作',
    desc: '戳一戳、点赞、给消息贴表情、显示正在输入',
    flags: Object.freeze(['sendPoke', 'sendLike', 'msgReaction', 'inputStatus']),
    why: '这些小动作被关掉了'
  }),
  Object.freeze({
    name: '撤回',
    desc: '说错了把自己的消息撤回来',
    flags: Object.freeze(['deleteMessage']),
    why: '撤回被关掉了'
  }),
  Object.freeze({
    name: '汇总一天',
    desc: '把一天里发生的事收成一段简报',
    flags: Object.freeze(['brief']),
    why: '简报被关掉了'
  }),
  Object.freeze({
    name: '汇报故障',
    desc: '遇到真坏了的事，直接私聊主人说清楚',
    flags: Object.freeze(['feedback']),
    why: '反馈通道被关掉了'
  })
]);

/** 能力表的只读副本，供单测/文档核对（不含任何运行期状态）。 */
export const CAPABILITIES = CAPABILITY_CATALOG;

/**
 * @pure 读三个体系总闸（与 bridge 的 stickerEnabled / memeEnabled / voiceCfg().enabled 同口径）。
 *
 * @param {object} [config] 桥接合并过默认值的 cfg
 * @returns {{ voice: boolean, sticker: boolean, meme: boolean }}
 */
export function readGates(config) {
  const social = (config && typeof config === 'object' && config.socialV2) || {};
  return {
    voice: social.voice?.enabled !== false,
    sticker: social.sticker?.enabled !== false,
    meme: social.memes?.enabled !== false
  };
}

/**
 * @pure 生成能力清单。返回**新数组 + 新对象**，调用方随便改都不影响本模块。
 *
 * 判定：该项挂的 flags 全开（`!== false`）且总闸开着 → enabled=true；
 * 否则 enabled=false，并给出 why（总闸的优先级高于单项开关：整套都关了就没必要说「这一项没开」）。
 *
 * @param {object} [config] 桥接合并过默认值的 cfg
 * @returns {Array<{ name: string, desc: string, enabled: boolean, why?: string }>}
 */
export function buildCapabilities(config) {
  const tools = (config && typeof config === 'object' && config.socialV2?.tools) || {};
  const gates = readGates(config);
  return CAPABILITY_CATALOG.map((item) => {
    const gateOpen = !item.gate || gates[item.gate] === true;
    const flagsOpen = item.flags.every((flag) => tools[flag] !== false);
    const enabled = gateOpen && flagsOpen;
    const entry = { name: item.name, desc: item.desc, enabled };
    if (!enabled) entry.why = gateOpen ? item.why : GATE_REASONS[item.gate];
    return entry;
  });
}

/**
 * @pure 会话 key → 人话。给告警消息用：主人看到的应该是「群 123」，不是 `group:123`。
 *
 * @param {string} key group:群号 / private:QQ号
 * @returns {string} 群 123 / 私聊 456；不认识的 key 原样返回（只 trim，不猜）
 */
export function describeKeyHuman(key) {
  const raw = typeof key === 'string' ? key.trim() : '';
  const matched = /^(group|private):(\d+)$/.exec(raw);
  if (!matched) return raw || '未知会话';
  return matched[1] === 'group' ? `群 ${matched[2]}` : `私聊 ${matched[2]}`;
}

/**
 * @pure 捏一条给主人的告警文案。格式固定为 `【她的报告】<会话>：<内容>`，
 * 空内容退化成一句兜底，绝不发出「【她的报告】群 1：」这种没说完的话。
 *
 * @param {string} key 会话 key
 * @param {string} message 模型给的人话描述
 * @returns {string}
 */
export function renderFeedbackAlert(key, message) {
  const body = typeof message === 'string' ? message.trim() : String(message ?? '').trim();
  return `【她的报告】${describeKeyHuman(key)}：${body || '（她没写具体是什么坏了）'}`;
}

/** 同一会话同一内容的告警冷却窗口：10 分钟。 */
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
/** 冷却表最多记多少条（超出按插入顺序淘汰最旧的），防止长跑内存缓慢增长。 */
export const ALERT_COOLDOWN_MAX_ENTRIES = 200;

/**
 * 10 分钟同内容冷却表。**不是纯函数**：shouldSend 会记下这次放行的时间。
 * now 由调用方注入，本模块不读系统时钟（单测因此可以随便造时间）。
 *
 * 语义：同一 id 在窗口内重复调用只放行第一次；窗口过后再放行。系统时间被往回调时
 * 按「刚发过」处理（宁可少发一条，也不刷屏）。
 *
 * @param {{ windowMs?: number, maxEntries?: number, now?: () => number }} [options]
 * @returns {{ shouldSend: (id: string) => boolean, size: () => number, reset: () => void }}
 */
export function createAlertCooldown(options = {}) {
  const windowMs = Math.max(0, Number(options.windowMs ?? ALERT_COOLDOWN_MS) || 0);
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries ?? ALERT_COOLDOWN_MAX_ENTRIES) || ALERT_COOLDOWN_MAX_ENTRIES));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sentAt = new Map(); // id -> 放行时间

  /**
   * 该 id 现在能不能发。true = 放行并记账；false = 窗口内已发过（或 id 为空）。
   * @param {string} id 去重口径，桥接传 `${key}\n${message}`
   * @returns {boolean}
   */
  function shouldSend(id) {
    const key = typeof id === 'string' ? id : String(id ?? '');
    if (!key) return false;
    const at = Number(now());
    const last = sentAt.get(key);
    if (last !== undefined && !(at - last >= windowMs)) return false;
    // 删了再插，让它回到 Map 尾部（淘汰时先丢最旧的）
    sentAt.delete(key);
    sentAt.set(key, at);
    while (sentAt.size > maxEntries) {
      const oldest = sentAt.keys().next();
      if (oldest.done) break;
      sentAt.delete(oldest.value);
    }
    return true;
  }

  return {
    shouldSend,
    size: () => sentAt.size,
    reset: () => sentAt.clear()
  };
}
