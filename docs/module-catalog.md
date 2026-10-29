# qq-bridge 模块目录（域 · 职责 · 现状）

> 生成于 2026-10-29。事实源：`docs/module-contract.md` v1.1（63 个域模块）。
> 本文件只做两件事：**按域列清每个模块干什么**，以及**它现在到底接没接线**。
> 判断依据见 `docs/module-wiring-feasibility.md` 第七节 A/B 与新增 D 节（结论，不需重新评估）。

**列说明**

| 列 | 含义 |
| --- | --- |
| 状态 | `已存在` 独立文件 · `需合并` 逻辑仍内嵌 `bridge.js` · `待新建` 尚无 |
| 接线 | `已上线` 中枢已 import 并在跑 · `未接线` 文件存在但无人调用 · `不切` 结论为不动 · `灰度` 影子/开关 |
| 位置 | 实际文件，或中枢里的函数名（行号会漂移，按函数名搜） |

汇总：运行时 48（A.1~A.12）+ 内容 15（A.13/A.14）= **63**。
当前：**已上线 15 · 灰度 1 · 不切 8 · 未动 7 · 未接线 1 · 待新建 2 · 其余早已在跑**。

---

## A.1 生命周期 lifecycle（4）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `lifecycle/boot` | 需合并 | 不切 | 进程装配根：读配置、起控制台、连 DSH/SnowLuma、注册信号 | `main()` |
| `lifecycle/lock` | 需合并 | 不切 | 单实例锁：无锁→create、指向存活进程→refuse(exit 2)、已死/过期→takeover | `LOCK_FILE` / `acquireLock` / `releaseLock`；模块 `src/lifecycle/lock.js`（13 单测） |
| `lifecycle/shutdown` | 需合并 | 不切 | 优雅退出编排（当前 systemd 直接 SIGTERM，模块无落点） | SIGINT/SIGTERM/uncaughtException 钩子 |
| `lifecycle/onebot-retry` | 已存在 | 已上线 | OneBot 断线重连状态机，退避 5s→15s→60s→300s 永不放弃 | `src/onebot-retry.js` |

## A.2 接入鉴权 auth（4）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `auth/console-token` | 需合并 | 未动 | 控制台令牌：未配置则自动生成并持久化，比较用 timingSafeEqual | `loadOrCreateConsoleToken` / `tokenEq` |
| `auth/agent-token` | 需合并 | 未动 | 二代会话隔离凭据：记住/遗忘/校验/自愈同步 | `rememberAgentToken` / `agentTokenOk` / `applyHealedTokens` |
| `auth/admission` | 需合并 | 未动 | 准入判定：白名单 + 模式闸门（谁在什么模式下能触达） | `allowed` / `modeAllowed` / `isSessionAllowedInCurrentMode` |
| `auth/tool-gate` | 需合并 | 未动 | 工具面开关与令牌校验（66 个布尔 flag + 各端点校验） | `v2ToolEnabled` / `ecoGate` |

> 这一域按结论**一律不替换**：会改权限边界。

## A.3 会话状态 session（4）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `session/store` | 需合并 | 不切 | 会话映射与策略持久化（读失败 → 只读不写，绝不回写覆盖） | `loadState` / `saveState`；模块 `src/session/store.js` |
| `session/social-state` | 需合并 | 不切 | 仿真状态真源：话题、最近消息、未读水位、唤醒配置 | `getSocialV2State` / `loadSocialV2State` / `saveSocialV2State`；模块 `src/session/social-state.js` |
| `session/router` | 已存在 | **未接线** | 会话键规范化与路由：决定"这个会话用哪个 preset/权限" | `src/core/session-router.mjs`（全仓 0 import） |
| `session/lifecycle` | 需合并 | 不切 | 轮换/退役/重建：超龄 + 空闲 → 归档旧会话并重建 | `shouldRotateSession` / `ensureSession` / `retireSession` / `reconcileSessionPolicies`；模块 `src/session/lifecycle.js`（10 单测） |

## A.4 入站归一 inbound（5）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `inbound/segments` | 需合并 | **已上线** | 消息段 → 纯文本（两遍：带引用/纯文本）+ 媒体元数据提取 | `src/inbound/segments.js`（`normalizeSegments` / `extractMediaFromSegments`） |
| `inbound/media` | 需合并 | 不切 | 媒体取回与预算：单条上限、跨媒体累积字节预算、GIF 抽帧、OCR/ASR | `resolveMediaList` / `fetchMediaData` / `enrichIncomingMediaV2` / `ocrImageText` / `pttTextFor` |
| `inbound/gif` | 已存在 | 已上线 | GIF 判定与抽帧拼分镜图 | `src/gif-frames.js` |
| `inbound/message` | **待新建** | — | 统一入站消息 DTO（目前 `handleIncoming` 与 `appendSocialV2Message` 各自拼装） | 无 |
| `inbound/command` | 需合并 | 未动 | 管理命令解析（`/role` `/silent` `/active` `/reset` `/status`）与转发审批码 | `handleIncoming` 命令拦截段 / `handlePendingAnswer` |

## A.5 调度 scheduler（3）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `scheduler/wake` | 需合并 | **已上线** | 唤醒优先级表、原因基名解析、定时器类判定、合并窗口升级 | `src/scheduler/wake.js`（`wakePriority` / `isTimerWakeReason`） |
| `scheduler/tick` | 需合并 | 不切 | 7 个常驻定时器（DSH 看门、SnowLuma 看门、生活线、自检、采样、端口漂移、社交循环） | `startDshWatch` / `startSnowlumaWatch` / `startHealthTimer` / `startSocialLoop` 等 |
| `scheduler/queue` | 需合并 | 未动 | 投递队列：合并/升级、忙时暂存、逐条出队 | `deliverPrompt` / `processPromptQueue` / `socialLoopTick` / `drainPromptQueue` |

## A.6 工具注册 tools（4）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `tools/registry` | **待新建** | — | 新工具的统一注册表（目前工具面散在 HTTP 路由 + 66 个布尔 flag） | 无 |
| `tools/module-switch` | 待新建 | 已上线 | 模块开关工具（`qq_module_list` / `qq_module_toggle`，分级+防呆+审计） | `src/tools/module-switch.js` |
| `tools/mcp-snowluma` | 已存在 | 已上线 | QQ 侧全部 MCP 工具（读消息/发消息/表情/语音/群管理…共 79 处注册） | `src/mcp-snowluma-safe.js` |
| `tools/mcp-websearch` | 已存在 | 已上线 | 联网搜索与网页抓取（SSRF 防护在 `safe-fetch`） | `src/mcp-web-search-safe.js` / `src/web-search.js` |

## A.7 守卫链 guards（6）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `guards/chain` | 需合并 | **已上线** | 守卫执行器：连续失败 5 次熔断、5 分钟后半开试探一次 | `src/guards/chain.js`（`createChain`） |
| `guards/outbound-content` | 需合并 | **已上线** | 出站内容校验：称呼越界、元信息泄漏、分区开关 | `src/guards/outbound-content.js`（`evaluateContent`） |
| `guards/length` | 需合并 | **已上线** | 长度软干预：超长先提醒一次，再超长放行（防死锁） | `src/guards/length.js`（`evaluateLengthNudge`） |
| `guards/sensitive` | 已存在 | 已上线 | 敏感信息外发审计（凭据/路径/令牌），fail closed | `src/guards/sensitive.js` |
| `guards/anti-ai` | 已存在 | 已上线 | 反 AI 味词库检测与改写（当前 enforce 34 条） | `src/anti-ai-patterns.js` |
| `guards/scorer` | 已存在 | 灰度 | 出站文本打分（当前 shadow，只观测），best-of-n 未接 | `src/scorer.js` |

## A.8 出站闸门 outbound（3）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `outbound/send` | 需合并 | **已上线（部分）** | 发送通道：单行化、超长拆分、OneBot 发送；本批只接了单行化 | `src/outbound/send.js`（`singleLineForQQ`）；`splitLongSegment` 因老测试 eval 源码未动 |
| `outbound/batch` | 需合并 | **已上线** | 分条节奏：fixed / byLength / auto 三种间隔算法 + 上下界夹取 | `src/outbound/batch.js`（`computeGaps` / `clampGap`） |
| `outbound/recheck` | 需合并 | **已上线** | 发送前复核：静默模式是否该拦、哪些会话要审计 | `src/outbound/recheck.js`（`shouldBlockSilentReply` / `shouldAuditKey`） |

## A.9 状态持久化 persist（3）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `persist/atomic` | 需合并 | **已上线** | 原子读写：临时文件 + 重命名重试，BOM 容错，`required` 快速失败 | `src/persist/atomic.js` |
| `persist/acl` | 已存在 | 已上线 | state 目录权限加固 | `src/state-acl.mjs` |
| `persist/migrations` | 需合并 | **已上线** | 历史数据补齐：拼音/variants 判定、状态字段归一 | `src/persist/migrations.js`（`needsPinyinBackfill` / `normalizeState`） |

## A.10 观测 observability（5）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `obs/log` | 需合并 | **已上线** | 日志行组装：脱敏、换行折叠、超长截断、按行数上限轮转 | `src/obs/log.js`（`formatLine` / `createCappedLogger`） |
| `obs/activity` | 需合并 | 已上线 | 审计日志追加与尾部倒读（跨天回绕推算） | `src/observability/activity.js` |
| `obs/tool-log` | 需合并 | **已上线** | 工具调用日志：敏感键脱敏、JSON 逐层解开、2000 字截断 | `src/obs/tool-log.js`（`prepareToolLogEntry` / `sanitizeToolArgs`） |
| `obs/health` | 需合并 | **已上线** | 自检判定：端口/在线/成本占比/未读积压/事件陈旧（12h） | `src/observability/health.js`（`judgeHealth`） |
| `obs/samples` | 已存在 | 已上线 | 对话样本导出（按日期幂等，只 owner 可开） | `src/samples.js` |

## A.11 降级自愈 heal（4）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `heal/model-fallback` | 已存在 | 已上线 | 模型回退链与运行期错误记账 | `src/model-fallback.js` |
| `heal/dsh-port` | 已存在 | 已上线 | DSH 端口漂移探测（换端口后自动跟随） | `src/dsh-port.js` |
| `heal/onebot` | 已存在 | 已上线 | OneBot 状态轮询与重连 | `src/onebot-retry.js` |
| `heal/token` | 需合并 | **已上线** | 令牌自愈：过期检测、同步到文件、失败只记日志 | `src/heal/token.js`（`createTokenHeal`） |

## A.12 成本 cost（3）

| 模块 | 状态 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `cost/prices` | 已存在 | 已上线 | 计价表：峰谷/节假日、按用量算价 | `src/model-prices.js` |
| `cost/ledger` | 已存在 | 已上线 | token 账本与看板 | `src/token-ledger.js` |
| `cost/gate` | 待新建 | 已上线 | 成本熔断：日预算 ¥30 预警 / ¥50 硬停，只拒新会话/新轮次 | `src/cost/gate.js`（`judge`） |

## A.13 内容 content（12）— 只组装与选择内容，不决定何时发

| 模块 | 分级 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `content/memo` | owner | 已上线 | 记忆三件套：日程/画像/自我认知与结算清单 | `src/memo.js` |
| `content/diary` | owner | 已上线 | 日记三档（日常 7 天 / 重要 21 天 / 刻骨 90 天）与结算 | `src/diary.js` |
| `content/mood` | free | 已上线 | 手札 / 底色 / 动态心情 | `src/mood.js` |
| `content/relations` | owner | 已上线 | 跨日保留的关系线（只控制台能写，AI 只读） | `src/relations.js` |
| `content/life` | owner | 已上线 | 生活线主动状态与素材摘要（早安/发现分享） | `src/life-proactive.js` |
| `content/memory-triggers` | owner | 已上线 | 承诺/纠正检测、日记回填与结算判定 | `src/memory-triggers.js` |
| `content/slang` | owner | 已上线 | 黑话词库、提取提示与注入块 | `src/slang-learner.js` |
| `content/slang-candidates` | owner | 已上线 | 待确认候选词（与正式词库分离） | `src/slang-candidates.js` |
| `content/slang-admin` | owner | 已上线 | 控制台确认/拒绝/编辑候选词 | `src/slang-admin.js` |
| `content/stickers` | free | 已上线 | 表情库同步、智能检索与策略提示 | `src/sticker-lib.js` |
| `content/memes` | free | 已上线 | 梗库增删查与注入提示 | `src/meme-lib.js` |
| `content/pinyin` | locked | 已上线 | 拼音/谐音（黑话匹配的纯工具） | `src/pinyin-util.js` |

## A.14 人格 persona（3，另 1 与 guards 共用）

| 模块 | 分级 | 接线 | 职责 | 位置 |
| --- | --- | --- | --- | --- |
| `persona/role-card` | locked | 已上线 | 角色卡解析、代次筛选与统计 | `src/role-card.js` |
| `persona/preset-prompt` | locked | 已上线 | 仿真提示词校验/渲染（安全不变量在此，缺了拒绝保存） | `src/preset-prompt.js` |
| `persona/inject` | locked | 未动 | 人格注入装配：仿真提示词 → 人格提示词 → 本轮消息 | `withSlangContext` / `buildBriefV2` / `roleHintForMode` / `buildWakePromptV2` |
| `persona/anti-ai` | free | 已上线 | 与 `guards/anti-ai` 同一文件，不重复计数 | `src/anti-ai-patterns.js` |

---

## 附：与本轮 token 优化相关的三个事实

1. **历史长度是最大杠杆**：`maxAgeHours=12`（原 24）。实测一次轮换把 owner 会话从 460k 压到 41.6k（−91%）。
2. **换厂商是负收益**：缓存命中 98.8%，换掉等于全价，同量成本约涨 9 倍；商汤 32K / 百炼 128K 也装不下 460K 历史。
3. **步数上限在 DSH 侧不可配**：仓库、`~/.dsh`、DSH 包内均无 `maxSteps`/`maxTurns`；
   唯一等价手段是改 preset 里"回复后立刻 wait / 沉睡前观察 5 分钟"，属行为设计，需产品决策。
