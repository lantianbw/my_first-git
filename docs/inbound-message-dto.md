# inbound/message DTO 契约（v1 草案）

> 状态：**草案，待评审**（2026-10-29）。实现前不要动 `bridge.js`。
> 事实源：`docs/module-contract.md` A.4「`inbound/message` 待新建：目前只有 `handleIncoming()` 与
> `appendSocialV2Message()` 两处各自拼装，无统一 DTO」。

---

## 一、为什么需要（问题陈述）

同一条入站消息目前被**三处各自拼装**，字段名与归一规则都不一致：

| # | 构造点 | 产物 | 当前字段 |
| --- | --- | --- | --- |
| 1 | `appendRecentMessage()` | 内存 `social.recentMessages` | `sender/text/plain/quoteTargetIsSelf/isOwner/media/messageId/hasMedia/time` |
| 2 | `appendSocialV2Message()` | 持久化 `social-v2.json` 的 `recentMessages` | `sender/text/plain/isSelf/isOwner/media/mediaText/forwardIds/messageId/time/poke...` |
| 3 | `handleIncoming()` 内的 `msg` | 唤醒提示 / 推送用的 DTO | `isOwner/ownerLabel/isSelf/media/hasMedia/mediaText/forwardIds/hasForward/time` |

**症状**（都是真实存在过的）：
- 媒体字段被拍平：`emojiId/subType` 丢过 → 市场表情先走必然失败的 `get_image`，CDN 兜底失效（见 `appendSocialV2Message` 上方注释）
- 同一份文本有的地方存原文、有的地方存截断到 200 字的版本，下游只能靠猜
- `forwardIds` 只在其中一处做过去重与 `sanitizeForwardId`

**目标**：入站消息只在一个地方被"定形"，三处消费者都读同一个对象；归一是纯函数、可单测。

---

## 二、DTO 定义

```ts
type InboundMessage = {
  // ── 身份 ─────────────────────────────────────────────
  key: string,              // 规范会话键：group:<id> / private:<id>（已过 parseKey）
  kind: 'group' | 'private',
  chatId: string,           // 群号或对方 QQ（字符串，保留前导零的原始形态由 canonical 决定）
  userId: string,           // 发送者 QQ；isSelf 时为自己的号
  senderName: string,       // 显示名，空串允许

  // ── 消息标识 ─────────────────────────────────────────
  messageId: string,        // OneBot message_id；可空串（部分事件没有）
  seq: number,              // 会话内本地 seq（未读水位用）；0 表示未知

  // ── 归属 ─────────────────────────────────────────────
  isSelf: boolean,          // 是否自己发的（用于回声识别）
  isOwner: boolean,         // 是否 ownerQQ（中枢算好传入，模块不读 cfg）
  quoteTargetIsSelf: boolean, // 引用的是否自己

  // ── 文本 ─────────────────────────────────────────────
  text: string,             // 带引用的归一文本（segmentsToText 结果）
  plainText: string,        // 纯文本（跳过 reply 段）；无引用时与 text 相同

  // ── 媒体 ─────────────────────────────────────────────
  media: MediaItem[],       // 已归一，见下
  hasMedia: boolean,        // media.length > 0
  mediaText: string[],      // OCR/ASR 补充文本，最多 6 条

  // ── 转发 / 互动 ───────────────────────────────────────
  forwardIds: string[],     // 已 sanitize，未去重（去重需跨消息状态，留中枢）
  hasForward: boolean,
  poke: null | { targetId: string | null, targetIsSelf: boolean, groupId: string | null },
  atUserId: string | null,  // 本条消息 @ 了谁

  // ── 时间 ─────────────────────────────────────────────
  time: number              // 毫秒时间戳，由调用方传入（模块不读 Date.now）
}
```

```ts
type MediaItem = {
  kind: 'image' | 'sticker' | 'face',
  file?: string,            // OneBot 文件名（image/mface）
  url?: string,             // CDN 地址
  faceId?: string,          // kind='face' 必有
  emojiId?: string,         // 收藏/市场表情
  emojiPackageId?: string,  // 表情包 id（当前持久化会丢，DTO 保留）
  emojiKey?: string,        // 表情 key（当前持久化会丢，DTO 保留）
  subType?: string,         // '0' 普通图 / '1' 市场表情
  summary?: string          // 已 sanitize 的描述
}
```

---

## 三、模块接口

```js
// src/inbound/message.js
export const spec = Object.freeze({
  name: 'inbound/message',
  version: '1.0.0',
  deps: [],                 // 纯函数，无需注入
  optionalDeps: [],
  guards: [],
  toggle: { level: 'locked', default: true, hot: true }
});

/** 入站消息定形。纯函数，不读 cfg/state/时钟，不写文件。 */
export function normalizeInbound(input)   // → { ok:true, message } | { ok:false, code, error }

/** 媒体项归一（单条）。 */
export function sanitizeMediaItem(m)      // → MediaItem | null

/** 媒体列表归一（丢空项、去重按 kind+标识）。 */
export function sanitizeMediaList(list)   // → MediaItem[]

/** 转发的 id 清洗（不去重）。 */
export function sanitizeForwardIds(list)  // → string[]
```

失败策略：**fail closed（仅本条消息）**——`normalizeInbound` 返回 `{ok:false}` 时，
调用方丢弃这一条并记账，绝不把半截文本投给模型（与 `inbound/segments` 同口径，依据 D 表）。

硬约束：不 import `bridge.js`；不读 `cfg`/`state`/`process.env`；不写文件；不联网；
不用 `Date.now()`/`Math.random()`；不 console.log。

---

## 四、归一口径（必须逐条对齐现有实现）

| 字段 | 规则 | 依据 |
| --- | --- | --- |
| `kind` | 只允许 `image`/`sticker`/`face`，其余一律 `image` | `appendSocialV2Message` 的 `safeMedia` |
| `face` | 必须有 `faceId`，否则该 media 项丢弃 | 同上 `.filter(...)` |
| `image/sticker` | `file`/`url`/`emojiId` 至少一个非空，否则丢弃 | 同上 |
| `summary` | 走 `sanitizeMediaSummary` | `mediaOf` |
| `subType` | 读 `sub_type`（snake）优先，回退 `subType`，转字符串 | `mediaOf` 注释：只读 camelCase 会永远空串 |
| `forwardIds` | 走 `sanitizeForwardId`，过滤空值 | `appendSocialV2Message` |
| `mediaText` | 去空白、最多 6 条 | `handleIncoming` 的 `msg` 组装 |
| `text`/`plainText` | **保留原文**，截断由消费者做 | 现状不一，DTO 里统一为原文 |

> 已知差异（保留现状，不在本契约里改）：`safeMedia` 现在会丢掉 `emojiPackageId`/`emojiKey`。
> DTO 允许携带；若接线时保持"零行为变化"，可先不写入持久化，只在这两个字段上留 TODO。

---

## 五、接线方式（灰度，与 session/router 同套路）

1. **影子先行**：三处构造点在拼装后，再调一次 `normalizeInbound(...)`，逐字段比对；
   不一致时每个 key 只记一条 `[inbound/message] 影子不一致：字段=... 旧=... 新=...`
2. **零行为变化**：返回给下游的仍是旧对象，影子只记账
3. 一致率稳定后，再逐个把构造点改为"先 normalizeInbound，再生产旧结构"（此时仍不改下游读取方式）
4. 最后一步才是让下游直接读 DTO —— 那一步要改消费方，单独一轮

**验收判据**
- 单测：`normalizeInbound` ≥ 14 条（三类媒体、空文本、缺失 messageId、非法 kind、poke 三种形态、超长 mediaText、forwardIds 空/脏数据、时间必传、失败返回 ok:false）
- 影子：连续 24 小时 0 分歧
- 线上：`[inbound/message] 影子已接入` 首条日志出现（证明新路径真的被走到）

---

## 六、不做的事

- 不改消息持久化文件的字段名（`recentMessages` 的 JSON 形状保持原样）
- 不合并 `appendRecentMessage` 与 `appendSocialV2Message` 两个函数（一个写内存、一个写盘，副作用不同）
- 不在模块里做 seq 分配、去重、限流（都需要跨消息状态）
