# qq-bridge 模块接口契约 v1.1

> **状态**：v1.1 · 2026-10-27 · 本文件是并行开发的**唯一接口事实源**。
> **v1.1 变更**：① 回填 12 项待确认结论（Q1~Q12 全部 ✅，见文末结论表）；② 新增 `content` / `persona` 两域（A.13 / A.14，15 个模块），全仓 48 → 63；③ 统一 `locked` 计数口径（34 / 11 / 3 为运行时 48 个模块的数）；④ 行号基准更新为 15742 行。
> **适用范围**：`E:\DSH\qq-bridge`。所有在「中枢 + 模块」拆分中新增或改造的 `src/**` 代码必须满足本契约。
> **不改变的东西**：架构五原则（中枢唯一状态与调度权 / 模块只提供能力 / 成本模块独立 / 守卫链 fail open + 5 次熔断 / 每模块可 `node --test` 单跑）已定稿，本文件只把它们翻译成可执行的接口。
> **与 RULES.md 的关系**：`RULES.md` 定义**对外的权限边界**（谁能做什么）；本文件定义**对内的模块边界**（哪段代码凭什么被调用）。两者冲突时以 `RULES.md` 的安全口径为准，并在文末结论表登记。
>
> **引用方式**：文中 `bridge.js:1044x` 一律指 `src/bridge.js` 的行号；行号基准为 2026-10-27 的 **`bridge.js` 现为 15742 行**。
>
> **⚠️ 行号会随重构漂移 —— 引用一律以函数名为准、行号为辅。** 按行号找不到时，用文中给出的函数名 / 常量名搜索定位，**不要按行号猜代码**。

---

## A. 模块清单

`src/` 现有 53 个模块文件 + `bridge.js`（15742 行）。下表按 **12 个运行时职责域**收敛成 **48 个模块**；v1.1 另新增 **2 个内容域**（A.13 `content` / A.14 `persona`，15 个模块）承载记忆与人格，合计 **63 个域模块**。

Q1 ✅ 未覆盖的 12 个文件（`eco-lib` / `tts-lib` / `voice-core` / `forward` / `forward-approval` / `cross-key` / `image-path` / `save-path` / `media-cache` / `tool-turn-stats` / `qq-model-view` / `self-test`）按 E.1 的 `<domain>/lib-*.js` 挂到最近域，不单独成模块。

**状态图例**：`已存在` = 已有独立文件且职责清晰 · `需合并` = 逻辑已存在但内嵌在 `bridge.js`，需搬出 · `待新建` = 目前没有。

### A.1 生命周期（lifecycle）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `lifecycle/boot.js` | 需合并 | `bridge.js:1685` `main()`（进程装配、单实例、控制台起服） |
| `lifecycle/lock.js` | 需合并 | `bridge.js:1353` `LOCK_FILE` · `bridge.js:1379` `acquireLock()` · `bridge.js:1442` `releaseLock()` · `bridge.js:15749` `process.on('exit')` |
| `lifecycle/shutdown.js` | 需合并 | `bridge.js:15719` SIGINT · `bridge.js:15725` SIGTERM · `bridge.js:15730` `unhandledRejection` · `bridge.js:15743` `uncaughtException` |
| `lifecycle/onebot-retry.js` | 已存在 | `src/onebot-retry.js:59` `createOnebotRetry()`；接线点 `bridge.js:15652` `retryOnebot()` |

### A.2 接入鉴权（auth）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `auth/console-token.js` | 需合并 | `bridge.js:390` `loadOrCreateConsoleToken()` · `bridge.js:3818` `consoleToken` · `bridge.js:3830` `tokenEq()`（`timingSafeEqual`） |
| `auth/agent-token.js` | 需合并 | `bridge.js:719` `rememberAgentToken()` · `bridge.js:740` `forgetAgentToken()` · `bridge.js:3837` `agentTokenOk()` · `bridge.js:15557` `applyHealedTokens()` |
| `auth/admission.js` | 需合并 | `bridge.js:1657` `allowed()` · `bridge.js:3340` `modeAllowed()` · `bridge.js:3387` `isSessionAllowedInCurrentMode()` · `bridge.js:3985` Host 白名单 |
| `auth/tool-gate.js` | 需合并 | `bridge.js:3792` `v2ToolEnabled()` · `bridge.js:3800` `ecoGate()` · `bridge.js:3887-4090` 各端点令牌校验 · `dsh/agent-presets/qq-chat/qq-tool-restrict.mjs` |

### A.3 会话状态（session）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `session/store.js` | 需合并 | `bridge.js:197` `STATE_FILE` · `bridge.js:1312` `loadState()` · `bridge.js:1342` `saveState()` · `bridge.js:1311` `stateWritable` |
| `session/social-state.js` | 需合并 | `bridge.js:11042` `getSocialV2State()` · `bridge.js:11090` `loadSocialV2State()` · `bridge.js:11213` `saveSocialV2State()` |
| `session/router.js` | 已存在（**未接线**） | `src/core/session-router.mjs`（`SessionRouter` / `canonicalConversationKey`）；`src/core/session-router.test.mjs` 已存在；全仓 **0 处 import**。**Q2 ✅ B**：先接入新代码路径，`modeAllowed()`（`bridge.js:3340`）保留一版灰度，稳定后再删 |
| `session/lifecycle.js` | 需合并 | `bridge.js:10700` `shouldRotateSession()` · `bridge.js:10726` `ensureSession()` · `bridge.js:3437` `retireSession()` · `bridge.js:3482` `reconcileSessionPolicies()` |

### A.4 入站归一（inbound）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `inbound/segments.js` | 需合并 | `bridge.js:1533` `segmentsToText()`（两遍：带引用 / 纯文本）· `bridge.js:1613` `extractMediaFromSegments()`；`src/media-tools.js` `extractTextPayload`、`src/md-to-plain.js` |
| `inbound/media.js` | 需合并 | `bridge.js:9702` `resolveMediaList()` · `bridge.js:9774` `fetchMediaData()` · `bridge.js:9975` `enrichIncomingMediaV2()` · `bridge.js:9915` `ocrImageText()` · `bridge.js:9942` `pttTextFor()` |
| `inbound/gif.js` | 已存在 | `src/gif-frames.js:19` `isGifBuffer` · `:34` `gifHintOf` · `:55` `gifMediaPlan` · `:65` `decodeGifToSheet` |
| `inbound/message.js` | 待新建 | 目前只有 `bridge.js:14349` `handleIncoming()` 与 `bridge.js:13195` `appendSocialV2Message()` 两处各自拼装，无统一 DTO |
| `inbound/command.js` | 需合并 | `bridge.js:14406-14430`（`/role` `/silent` `/active` `/reset` `/status` 拦截）· `bridge.js:14749` `handlePendingAnswer()` · `bridge.js:14412-14430` 转发审批码 |

### A.5 调度（scheduler）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `scheduler/wake.js` | 需合并 | `bridge.js:14072` `wakePriorityV2()` · `bridge.js:14085` `scheduleWakeV2()` · `bridge.js:14141` `replayPendingWakeReasonsV2()` · `bridge.js:14031` `isConversationBusyV2()` |
| `scheduler/tick.js` | 需合并 | `bridge.js:3621` `startDshWatch` · `:3780` `startSnowlumaWatch` · `:12026` `startLifeProactiveTimer` · `:12071` `startHealthTimer` · `:12131` `startSampleTimer` · `:12187` `startDshDriftTimer` · `:12766` `startSocialLoop` |
| `scheduler/queue.js` | 需合并 | `bridge.js:12596` `deliverPrompt()` · `:12608` `processPromptQueue()` · `:12648` `socialLoopTick()` · `:14333` `drainPromptQueue()` |

### A.6 工具注册（tools）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `tools/registry.js` | 待新建 | 工具面目前散在 `bridge.js:3811-9090` 的 HTTP 路由 + `cfg.socialV2.tools` 的 66 个布尔开关（`bridge.js:3792`）；无统一注册表。**Q11 ✅ B**：registry 只登记**新**工具，66 个旧 flag 按域逐步回填，不一次性迁移 |
| `tools/module-switch.js` | 待新建 | 无（H 节新增；`qq_module_list` / `qq_module_toggle`） |
| `tools/mcp-snowluma.js` | 已存在 | `src/mcp-snowluma-safe.js:407` 起共 **79** 处 `server.tool(...)` |
| `tools/mcp-websearch.js` | 已存在 | `src/mcp-web-search-safe.js`、`src/web-search.js`（`webSearch` `:477`） |

### A.7 守卫链（guards）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `guards/chain.js` | 需合并 | `bridge.js:10441` `GUARD_TRIP_AFTER=5` · `:10442` `guardFailStreak` · `:10443` `guardTripped` · `:10444` `runGuard()`。**Q4 ✅ B**：签名扩为 `runGuard(name, fn, fallback, policy)`，`policy:'closed'` 用于静默/鉴权项；**Q12 ✅ B**：熔断 5 分钟后半开试探一次 |
| `guards/outbound-content.js` | 需合并 | `bridge.js:10461` `guardOutboundV2()` · `:10419` `guardSectionV2()` · `:10423` `guardSectionEnabledV2()` · `:10429` `DEFAULT_META_BLOCK_WORDS_V2` · `:10432` `looksLikeVocativeAddressV2()` |
| `guards/length.js` | 需合并 | `bridge.js:10533` `guardLengthNudgeV2()` · `:10532` `lengthNudgeRetriesV2` |
| `guards/sensitive.js` | 已存在 | `src/sensitive.js`（`SENSITIVE_RE`）· `bridge.js:773` `redactSensitiveText()` · `bridge.js:2095` `assertOutboundAuditOk()` |
| `guards/anti-ai.js` | 已存在 | `src/anti-ai-patterns.js:28` `loadAntiAiPatterns` · `:62` `checkAntiAi` · `:90` `formatAntiAiHits`；接线 `bridge.js:3858`、`bridge.js:10487` |
| `guards/scorer.js` | 已存在 | `src/scorer.js:92` `evaluate` · `:122` `pickBest` · `:135` `formatVerdict`；接线 `bridge.js:10465`（shadow） |

### A.8 出站闸门（outbound）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `outbound/send.js` | 需合并 | `bridge.js:9146` `sendToQQ()` · `:9369` `onebotSend()` · `:9174` `singleLineForQQ()` · `:9183` `splitLongSegment()` |
| `outbound/batch.js` | 需合并 | `bridge.js:10355` `sendMessagesV2()` · `:10319` `clampGapV2()` · `:10325` `computeGapsV2()` · `:9325` `sendBurstToQQ()` |
| `outbound/recheck.js` | 需合并 | `bridge.js:10398` `captureSendGuard()` · `:10410` `shouldBlockSilentReply()` · `:10561` `auditAndSend()` · `:10390` `shouldAuditKey()` |

### A.9 状态持久化（persist）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `persist/atomic.js` | 需合并 | `bridge.js:310` `readJsonSafe()` · `:346` `renameWithRetry()` · `:363` `atomicWriteJson()` · `:377` `atomicWriteText()` |
| `persist/acl.js` | 已存在 | `src/state-acl.mjs`（`hardenDir` / `manualDirCommand`）；接线 `bridge.js:421` `hardenStateDirAcl()` |
| `persist/migrations.js` | 需合并 | `bridge.js:247` `fileNeedsPinyinBackfill()` · `bridge.js:1336-1340` 字段补齐 |

### A.10 观测（observability）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `obs/log.js` | 需合并 | `bridge.js:1465` `createCappedLogger()` · `:1494` `localClock()` · `:1502` `log()` · `:1454` `LOG_LINE_MAX` · `:1500` `appendBridgeLog` |
| `obs/activity.js` | 需合并 | `bridge.js:805` `appendActivity()` · `:438` `readActivityTail()` · `:240` `ACTIVITY_LOG` |
| `obs/tool-log.js` | 需合并 | `bridge.js:13349` `appendFeedbackEntry()` · `:13376` `appendToolLog()` · `:13408` `redactSensitive()` · `:13424` `sanitizeToolArgs()` |
| `obs/health.js` | 需合并 | `bridge.js:11896` `runHealthCheckV2()` · `:3688` `noteReceiveHealth()` · `:3697` `snowlumaHealthSnapshot()` · `:11851` `todayTokenUsage()` |
| `obs/samples.js` | 已存在 | `src/samples.js`（`shouldRunSample` / `markSampleRun` / `pruneSampleFiles`）；接线 `bridge.js:12107` `runSampleExport()` |

### A.11 降级自愈（heal）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `heal/model-fallback.js` | 已存在 | `src/model-fallback.js`；接线 `bridge.js:10595` `modelFallbackChain` · `:10605` `noteModelRuntimeError()` · `:10629` `ensureChatModel()` |
| `heal/dsh-port.js` | 已存在 | `src/dsh-port.js:102` `createDshPortScanner()`；接线 `bridge.js:12157` `currentDshPort()` · `:12187` `startDshDriftTimer()` |
| `heal/onebot.js` | 已存在 | `src/onebot-retry.js` + `bridge.js:15652` `retryOnebot()` + `bridge.js:3754` `pollSnowlumaStatus()` |
| `heal/token.js` | 需合并 | `bridge.js:15557` `applyHealedTokens()` · `:15612` `syncTokenToFile()` · `:15623` `healTokenIfStale()` · `src/snowluma-conn.js` |

### A.12 成本（cost）

| 模块 | 状态 | 当前位置 |
| --- | --- | --- |
| `cost/prices.js` | 已存在 | `src/model-prices.js:85` `DEFAULT_PRICE_TABLE` · `:133` `resolvePriceTable` · `:181` `isPeakAt` · `:271` `priceUsage`；接线 `bridge.js:3107` |
| `cost/ledger.js` | 已存在 | `src/token-ledger.js:102` `createTokenLedger()`；接线 `bridge.js:3108`、看板 `bridge.js:7158` |
| `cost/gate.js` | **待新建** | 目前**不存在成本熔断**。可借鉴的同类闸门：`bridge.js:2313` `voiceBudgetCheck()`、`src/eco-lib.js` `takeLikeQuota` / `takeWindowQuota`。**Q3 ✅**：日预算 **¥30 预警 / ¥50 硬停**；硬停只拒绝「新会话 / 新轮次」，**不打断进行中的对话** |

### A.13 内容（content）— v1.1 新增

> 归属依据 **Q1 ✅**：记忆 / 日记 / 心情 / 黑话 / 表情 / 梗 归 `content`。这些模块的共同特征是「**只组装与选择内容，不决定何时发、发到哪**」——投递权仍在 `scheduler` / `outbound`。

| 模块 | 状态 | 分级 | 归属文件与实际路径 |
| --- | --- | --- | --- |
| `content/memo.js` | 已存在 | owner | `src/memo.js` — 记忆三件套（日程 / 画像 / 自我认知）与结算清单：`normalizeAgenda` `normalizeProfile` `normalizeSelfview` `addAgenda` `settleMemos` `formatMemoBlock`；接线 `bridge.js:11579` `readAgenda()` ~ `bridge.js:11632` |
| `content/diary.js` | 已存在 | owner | `src/diary.js` — 日记三档与结算：`addDiary` `openDiary` `settleDiary` `formatDiaryBlock`；接线 `bridge.js:11648` `readDiary()` ~ `bridge.js:11684` |
| `content/mood.js` | 已存在 | **free** | `src/mood.js` — 手札 / 底色 / 动态心情：`addHandnote` `setDynamicMood` `settleMood` `formatMoodBlock` `MOOD_TAGS`；接线 `bridge.js:11690` `readMoods()` ~ `bridge.js:11718` |
| `content/relations.js` | 已存在 | owner | `src/relations.js` — 跨日保留的关系线（只有控制台能写）：`normalizeRelations` `appendRelationEntry` `formatRelationBlock`；接线 `bridge.js:11550` `readRelationsFile()`、`bridge.js:11555` `relationBlockV2()` |
| `content/life.js` | 已存在 | owner | `src/life-proactive.js` — 生活线主动状态与素材摘要：`loadLifeProactiveState` `loadMaterialDigest` `shouldMorningPoke` `shouldDiscoveryShare`；接线 `bridge.js:11981` `lifeProactiveTick()` |
| `content/memory-triggers.js` | 已存在 | owner | `src/memory-triggers.js` — 承诺 / 纠正检测与结算判定：`detectCommitment` `detectCorrection` `diaryNeedsBackfill` `shouldDiarySettle`；接线 `bridge.js:12044` `memoryTriggerTick()` |
| `content/slang.js` | 已存在 | owner | `src/slang-learner.js` — 黑话词库、提取 / 研究提示与注入块：`loadSlang` `upsertSlangEntry` `buildSlangContext` `buildExtractionPrompt`；接线 `bridge.js:2793` `runSlangExtraction()` |
| `content/slang-candidates.js` | 已存在 | owner | `src/slang-candidates.js` — 待确认候选词（与正式词库分离）：`loadCandidates` `addCandidate` `seedCandidates`；接线 `bridge.js:2717` `saveCandidatesStore()` |
| `content/slang-admin.js` | 已存在 | owner | `src/slang-admin.js` — 控制台确认 / 拒绝 / 编辑：`listCandidates` `confirmCandidate` `rejectCandidate`；仅控制台可达（`RULES.md` §黑话） |
| `content/stickers.js` | 已存在 | **free** | `src/sticker-lib.js` — 表情库同步、检索与策略提示：`loadStickerStore` `buildStickerContextSmart` `suggestStickers` `markStickerUsed`；接线 `bridge.js:2014` `syncStickerLibrary()`、`bridge.js:2542` `sendStickerV2()` |
| `content/memes.js` | 已存在 | **free** | `src/meme-lib.js` — 梗库增删查与注入提示：`loadMemes` `queryMemes` `buildMemeHint` `MEME_MAX_ENTRIES`；接线 `bridge.js:1792` `memeEnabled()`、`bridge.js:1847` `saveMemeStoreSafe()` |
| `content/pinyin.js` | 已存在 | **locked** | `src/pinyin-util.js` — 拼音 / 谐音（被黑话匹配依赖的纯工具）：`getPinyin` `findHomophone`；接线 `bridge.js:172` import、`bridge.js:2957` `feedSlangWindow()`。关掉会让黑话/谐音识别**静默降级**，故 locked |

**小计：12 个**（locked 1 · owner 8 · free 3）。

### A.14 人格（persona）— v1.1 新增

> 归属依据 **Q1 ✅**：角色卡 / 反 AI 词库 / 人格注入 归 `persona`。这一域决定「AI 是谁、怎么说话」，是**身份与安全不变量的载体**（`RULES.md` §提示词的两层边界），因此全部 locked。

| 模块 | 状态 | 分级 | 归属文件与实际路径 |
| --- | --- | --- | --- |
| `persona/role-card.js` | 已存在 | **locked** | `src/role-card.js` — 角色卡解析、代次筛选与统计：`GEN1_ROLE_LINE_RE` `parseRoleSections` `selectRoleText` `roleSectionReport`；接线 `bridge.js:12828` `roleRawContent()`、`bridge.js:12956` `currentRoleHintV2()`、`bridge.js:495` `roleWarnings()` |
| `persona/preset-prompt.js` | 已存在 | **locked** | `src/preset-prompt.js` — 仿真提示词校验 / 渲染（安全不变量检查在此）：`extractPresetPrefix` `presetPromptBlockers` `presetPromptWarnings` `renderPresetPromptYaml`；接线 `bridge.js:595` ~ `bridge.js:678` preset 状态、备份与校验 |
| `persona/inject.js` | 需合并 | **locked** | 人格注入装配（拼装顺序 = 仿真提示词 → 人格提示词 → 本轮消息）：`bridge.js:3014` `withSlangContext()` · `bridge.js:11769` `buildBriefV2()` · `bridge.js:12860` `roleHintForMode()` · `bridge.js:13665` `buildWakePromptV2()`；目前无独立文件 |
| `persona/anti-ai.js`（与 A.7 `guards/anti-ai` **同一文件，不重复计数**） | 已存在 | **free** | `src/anti-ai-patterns.js` — 词库**归属** persona 维护（Q1 ✅），**运行时注册**在 A.7 `guards/anti-ai`（守卫阶段 `outbound.content`）；接线 `bridge.js:3858`、`bridge.js:10487` |

**小计：3 个计入总数**（locked 3 · owner 0 · free 0）+ 1 个与 guards 共用的文件。

**合计：63 个域模块**（A.1~A.12 运行时 48 + A.13/A.14 内容 15）：已存在 29 / 需合并 30 / 待新建 4。

---

## B. 模块对外接口

### B.1 唯一出口

每个模块**只 export 两个契约符号**，其余符号一律视为私有。需要被复用的纯函数必须以显式名字导出，并在文件头注释里标注 `@pure`。

```js
// src/<domain>/<module>.js
export const spec = Object.freeze({
  name: 'guards/anti-ai',   // 全仓唯一，必须等于 `<domain>/<file 基名>`
  version: '1.0.0',         // semver；接口变更必须升 major
  deps: ['log', 'cfg'],     // 必需能力：缺一个就不装配
  optionalDeps: ['state'],  // 可选能力：缺了走本模块声明的降级路径
  guards: ['outbound.content'], // 本模块参与的守卫阶段；非守卫模块用 []
  toggle: { level: 'free', default: true, hot: true } // 见 H1
});

/**
 * @param {Ctx}    ctx  中枢注入的上下文（C 节字段表）
 * @param {object} args 调用参数（由调用方域定义，见各自 README）
 * @returns {Promise<Result>|Result}
 */
export function handle(ctx, args) { /* ... */ }
```

`spec` 必须 `Object.freeze`，中枢在装配时会**再冻结一次**并做结构校验（`name` 与路径一致、`version` 是 semver、`deps` 全是字符串、`toggle.level ∈ {free,owner,locked}`）。校验失败 → 该模块**不装配**，并写一条 `obs.log` 记账，不影响其它模块。

### B.2 `handle` 的返回约定

```js
// 成功
{ ok: true,  value: <任意可序列化值>, notes?: string[] }
// 失败（可预期）
{ ok: false, code: 'GUARD_BLOCKED' | 'INVALID_ARGS' | 'DEP_MISSING' | 'UPSTREAM' | 'LIMITED', error: '人话原因' }
```

- **不得返回 `undefined`**：`handle` 必须显式给出 `ok`。中枢把 `undefined`/非对象返回值一律当作模块违约，按 D 表该模块的策略处理并记账。
- **可以抛**：抛错等价于 `{ok:false, code:'UPSTREAM'}`，中枢会 `try/catch` 并按 D 表判定，**但抛错必须携带可读 `message`**（禁止 `throw new Error()` 空消息）。
- **不得吞错**（F.5）：任何 `catch` 要么向上抛，要么 `ctx.log('warn', ...)` 记账后返回 `ok:false`。空 `catch {}` 只允许出现在「日志系统自身」这类不能递归失败的极少数位置。
- **副作用白名单（Q10 ✅ A）**：`outbound/*`、`inbound/*`、`scheduler/*` 允许有真实副作用（发送、拉取、定时）；但**写动作必须经中枢授权**——发消息走 `ctx.tools.call`，落盘走 `ctx.state.write`，扣额度走 `ctx.cost`。模块**不得**自己持有 HTTP 客户端、文件句柄或额度计数器；其余域（`guards/*`、`content/*`、`persona/*`、`cost/prices` 等）的 `handle` 必须是纯读或纯计算。

### B.3 `deps` 如何声明"我需要 ctx 里的哪些能力"

`deps` 是 **ctx 字段名 / 能力名**的字符串数组，不是模块名。**模块永远不声明"我要 import 谁"**，只声明"我需要中枢给我什么"。

| 能力名 | 含义 | 缺失时 |
| --- | --- | --- |
| `cfg` | 只读配置视图 | 必填 |
| `log` | 结构化日志函数 | 必填 |
| `now` | 单调递增毫秒时钟 | 必填（否则不可单测） |
| `random` | `[0,1)` 随机源 | 必填（否则不可单测） |
| `session` | 当前会话只读快照 | 必填 |
| `state` | 命名空间化状态句柄 | 视模块 |
| `tools` | 工具调用门面 | 视模块 |
| `audit` | 审计写入（activity/tool-log） | 视模块 |
| `cost` | 成本只读判断（`judge()` / `spentToday()`） | 仅成本相关模块 |
| `net` | 受控出网（仅 `web-search` / `web-sticker`） | 视模块 |

**降级规则（中枢实现，模块不自作主张）：**

1. **必需依赖缺失 → 不装配。** 该模块从注册表移除，`toggle.on` 视为 `false` 且 `offReason='missing-dep:<name>'`；调用方拿到 `{ok:false, code:'DEP_MISSING'}`，按 D 表该模块的策略继续（fail open 的模块就是"这项能力不存在"，不是"报错"）。
2. **可选依赖缺失 → 走模块声明的降级分支。** 模块必须在 `handle` 里显式判断 `if (!ctx.state)` 并返回降级结果（例如反 AI 味词库拿不到 `state` → 按"零命中"处理），**不得**因为可选依赖缺失而抛错。
3. **禁止用 `import` 兜底。** "deps 缺了我就自己 import 那个模块" 是 F.6 明令禁止的行为——那会把并行开发重新耦合回一张网。

### B.4 一个最小可运行例子

```js
export const spec = Object.freeze({
  name: 'guards/scorer',
  version: '1.0.0',
  deps: ['log', 'cfg', 'now'],
  optionalDeps: [],
  guards: ['outbound.content.observe'],
  toggle: { level: 'free', default: true, hot: true }
});

export function handle(ctx, { key, text }) {
  if (ctx.cfg.socialV2?.scorer?.enabled !== true) return { ok: true, value: null };
  const verdict = evaluate(String(text ?? ''), { targetIsHuman: true });
  ctx.log('info', `[scorer] shadow (${key}) ${formatVerdict(verdict)}`);
  return { ok: true, value: verdict };
}
```

---

## C. ctx 字段表

中枢在装配期构造**唯一一个** ctx 工厂，所有模块拿到的是同一个基座 + 各自 `spec.deps` 的白名单视图（未在 `deps`/`optionalDeps` 里声明的字段，注入时**直接不存在**，读取即 `undefined`）。

| 字段 | 类型 | 由谁注入 | 只读 | 说明 |
| --- | --- | --- | --- | --- |
| `cfg` | `Readonly<ConfigView>` | 中枢（`bridge.js:1686` `loadConfig()` 的代理） | **是** | 每次调用**重新读**，模块不得缓存到模块级变量。当前只有 `cfg.socialV2` 支持运行期整体替换（`bridge.js:5291`），其余字段仍是启动快照——见 H7。 |
| `session` | `{ key, kind, id, isOwner, mode, preset, tokenRef }` | 中枢（`bridge.js:11042` / `:3387`） | **是** | `key` 是 `group:<id>` / `private:<id>` 规范键；`tokenRef` 只给不透明引用，**不给明文令牌**。 |
| `log` | `(level:'debug'\|'info'\|'warn'\|'error', msg:string, meta?:object) => void` | 中枢（`bridge.js:1502`） | **是**（函数本身不可替换/包装） | 模块内部**禁止** `console.log`、禁止直接 `fs.appendFile`。 |
| `state` | `{ read(ns), write(ns, value), patch(ns, fn), onFlush(cb) }` | 中枢（`persist/*`） | 句柄只读，写入经方法 | `ns` 必须是 `'<domain>/<module>'`。模块**不得**知道真实文件路径（F.4）。 |
| `now` | `() => number` | 中枢（默认 `Date.now`，测试可注入假时钟） | **是** | 禁止直接用 `Date.now()`（F.7）。 |
| `random` | `() => number` | 中枢（默认 `Math.random`，测试可注入种子） | **是** | 禁止直接用 `Math.random()`（F.7）。 |
| `tools` | `{ has(name), call(name, args), list() }` | 中枢（`tools/registry.js`） | **是** | 只暴露当前会话**有权调用**的工具；`call` 走中枢鉴权链，模块不得绕过。 |
| `audit` | `{ activity(line), tool(entry) }` | 中枢（`bridge.js:805` / `:13376`） | **是** | 与 `log` 分开：`audit` 写"谁做了什么"，`log` 写"程序发生了什么"。 |
| `cost` | `{ judge(estimate): {allow, reason}, spentToday() }` | 中枢（`cost/gate.js`） | **是** | **只读判断**。模块不得自己扣额度、不得自己写账本（架构原则 3）。 |
| `net` | `{ fetchText, fetchBinary }` | 中枢（`src/safe-fetch.js` 包装） | **是** | 仅对声明了 `net` 的模块注入；SSRF 校验在中枢侧做完，模块不能自行拼 http。 |
| `timer` | `{ setTimeout, clearTimeout, setInterval, clearInterval }` | 中枢（`scheduler/tick.js`） | **是** | 模块**禁止**直接使用全局定时器（F.10），否则 `node --test` 跑不干净。 |

**不变式**：`ctx` 里**没有** `fs`、没有 `process`、没有 `http`、没有 `bridge`。凡需要这些能力的模块，说明它的职责划错了，应回到 A 节重新分域。

---

## D. 失败策略矩阵

**判定口径（一句话版）**：**这一项如果坏了，继续放行会不会造成"越权 / 泄密 / 资损 / 谎报"？会 → fail closed；只会造成"少一点信息 / 风格差一点" → fail open。**

fail open 的硬依据来自线上事故 `bridge.js:193-195`：反 AI 味词库曾因作用域错误在出站时抛 `ReferenceError`，把整条发送链路打断——**质量增强类的任何异常都不能挡住出站**。

| 模块 | 策略 | 判定依据 |
| --- | --- | --- |
| `lifecycle/boot` | fail closed | 起不来就没有桥；单实例冲突必须 `exit 2`（`bridge.js:1440`） |
| `lifecycle/lock` | fail closed | 双例会抢消息、互相覆盖会话映射（`bridge.js:1349-1353`） |
| `lifecycle/shutdown` | fail open（尽力） | 释放锁失败只影响下次启动的 PID 校验（`bridge.js:1442-1448`） |
| `lifecycle/onebot-retry` | fail open | 重试只负责重连；未连接时的拒绝由 `outbound/*` 负责，不能让重试吞消息 |
| `auth/console-token` | **fail closed** | 控制台无鉴权 = 本机任意进程可改配置、可发消息（`bridge.js:3819-3821` 已明确改为失败关闭） |
| `auth/agent-token` | **fail closed** | 会话令牌是二代会话隔离的唯一凭据（`bridge.js:3837`） |
| `auth/admission` | **fail closed** | 白名单/模式准入是"群友不能触达"的硬边界（`RULES.md §权限分层`） |
| `auth/tool-gate` | **fail closed** | 工具面越权比功能缺失严重得多（`bridge.js:3792-3805`） |
| `session/store` | 写 fail closed / 读 fail open | 读失败降级"只读不写"、绝不回写覆盖（`bridge.js:1311-1347`）；写失败不能谎报成功 |
| `session/social-state` | 同 `store` | 同上，仿真状态丢失会让 AI 重复发言，但优先保住原文件 |
| `session/router` | **fail closed** | 它决定"这个会话用哪个 preset/权限"，判定不出来就不该投递（与 `session-router.mjs` 头注释的 fail-closed 设计一致） |
| `session/lifecycle` | fail open | 退役/重建失败只是多留一个旧会话，不影响收发 |
| `inbound/segments` | fail closed（**仅本条消息**） | 归一失败 → 丢弃这一条并记账；绝不能把半截文本投给模型（会答错人） |
| `inbound/media` | fail open | 媒体理解失败退化为"这条有张图"的提示（`bridge.js:9975`），不影响文字 |
| `inbound/gif` | fail open | 解码失败回退原图（`src/gif-frames.js:55` `gifMediaPlan`） |
| `inbound/message` | fail open（丢弃本条） | DTO 构造失败与 segments 同级，逐条隔离 |
| `inbound/command` | **fail closed** | 管理命令解析错 = 越权执行（`/role` `/silent` 必须精确匹配） |
| `scheduler/wake` | fail open | 漏一次唤醒，下条消息仍会触发投递，不构成静默故障 |
| `scheduler/tick` | fail open | 单个 timer 抛错记日志后重建，不阻断消息链路 |
| `scheduler/queue` | fail open | 队列异常走 `drainPromptQueue`（`bridge.js:14333`）清空并记账 |
| `tools/registry` | **fail closed** | 注册表坏了宁可"工具不存在"，也不能放行未登记的工具 |
| `tools/module-switch` | **fail closed** | 开关工具自身异常时必须拒绝一切变更（"默认允许"等于开关失效） |
| `tools/mcp-snowluma` | **fail closed** | 文本收发 + 白名单强制（`RULES.md` §4） |
| `tools/mcp-websearch` | fail open | 搜索挂了只让工具报错，聊天继续 |
| `guards/chain`（执行器） | fail open（默认）/ `policy:'closed'` 项 fail closed | `bridge.js:10438-10460`：单项失败跳过 + 记账 + 5 次熔断。**Q4 ✅ B**：`runGuard(name, fn, fallback, policy)`，`policy:'closed'` 用于**静默与鉴权**项，失败即拒绝而非跳过；**Q12 ✅ B**：熔断 5 分钟后**半开试探一次**，成功即复位、失败继续跳过 |
| `guards/outbound-content` | fail open | 词表/正则坏了按"无命中"处理（`bridge.js:10486-10487`） |
| `guards/length` | fail open | 纯软干预，最多放宽一次（`bridge.js:10546-10555` 有防死锁放行） |
| `guards/sensitive` | **fail closed** | 凭据/路径/令牌外发不可放行（`bridge.js:10571-10578`、`:2095`） |
| `guards/anti-ai` | fail open | `bridge.js:10477-10496`：异常 → 无命中；`enforce` 命中才拦 |
| `guards/scorer` | fail open | shadow 只观测（`bridge.js:10477`） |
| `outbound/send` | **fail closed** | 发送失败必须抛，不能静默丢消息（`bridge.js:10380-10384`） |
| `outbound/batch` | **fail closed** | 部分失败向上抛并带 `err.sent`，由调用方决定重试 |
| `outbound/recheck` | **fail closed** | 发送前权限复核失败即取消（`bridge.js:10401-10406`） |
| `persist/atomic` | 写 fail closed / 读 fail open | 原子写失败不能报成功；读失败走 `readJsonSafe` 兜底（`bridge.js:310`） |
| `persist/acl` | fail open | ACL 加固失败只告警（`bridge.js:421-437`），不阻断启动 |
| `persist/migrations` | fail open | 历史补齐失败不影响启动（`bridge.js:247-256`） |
| `obs/log` | fail open | `log()` 全程 try 包裹（`bridge.js:1510-1516`），日志坏了不能带走进程 |
| `obs/activity` | fail open | `appendActivity` 自身吞异常，审计轨迹缺失不阻断发送 |
| `obs/tool-log` | fail open | 同上 |
| `obs/health` | fail open | 自检失败只影响看板数字 |
| `obs/samples` | fail open | 样本导出是离线产物 |
| `heal/model-fallback` | fail open | 生效链为空时行为与旧版一致（`bridge.js:10589-10593`） |
| `heal/dsh-port` | fail open | 探测失败保留上次已知端口（`bridge.js:12157`） |
| `heal/onebot` | fail open（无限重试） | `bridge.js:15652`；退避 5s→15s→60s→300s 永不放弃（`src/onebot-retry.js:11`） |
| `heal/token` | fail open | 自愈失败只记日志（`bridge.js:15623`），令牌由人处理 |
| `cost/prices` | fail open | 缺覆盖配置时回退 `DEFAULT_PRICE_TABLE`（`src/model-prices.js:133`） |
| `cost/ledger` | fail open | 记账失败只丢统计（`bridge.js:7158` 看板） |
| `cost/gate` | **fail closed** | 熔断命中必须拒绝——这是它唯一的存在意义。**Q3 ✅**：日预算 **¥30 预警 / ¥50 硬停**，硬停**只拒新会话 / 新轮次**、不打断进行中的对话，所以不会出现"半句话被砍" |

**统计（上表 48 行 = A.1~A.12 运行时模块全覆盖）**：整体 fail closed 17 项 · 混合 3 项（"写 fail closed / 读 fail open"：`session/store`、`session/social-state`、`persist/atomic`）· 整体 fail open 28 项。**新增模块默认 fail open**，要 fail closed 必须在 PR 里写清"挡的是什么损失"。

**A.13/A.14 的 15 个内容模块（v1.1 新增）**：**一律 fail open**——记忆/日记/心情/黑话/表情/梗的组装失败只让这一轮"少点佐料"，绝不挡收发（依据同上：`bridge.js:193-195` 的线上事故）。唯一例外是 `persona/preset-prompt` 的**保存前校验**：缺 `你没有本地工具` / `角色由桥接注入` 等安全不变量即**拒绝保存**，属 fail closed（`RULES.md` §提示词的两层边界）。

---

## E. 目录与命名约定

### E.1 目录

```
src/
  bridge.js                 ← 中枢（唯一持有状态与调度）
  <domain>/                 ← 14 个域（12 运行时 + content/persona），目录名与 A 节一致
    <module>.js             ← 每个模块一个文件，对应一个 spec.name
    README.md               ← 可选：该域的 args 定义与调用点
  core/                     ← 历史目录，只保留 session-router（见 Q2）
tests/
  <module>.test.mjs         ← 与 src/<domain>/<module>.js 同名
```

- `spec.name` **必须**等于 `<domain>/<module 基名>`，例如 `src/guards/anti-ai.js` → `guards/anti-ai`。
- 文件名与域目录名一律 **kebab-case**；不得出现 `v2`、`new`、`fix`、`tmp` 等版本/临时后缀（历史遗留按 A 节迁移时一并改名）。
- 一个文件一个模块。**禁止** `index.js` 桶文件（桶文件会让"谁依赖谁"重新变成隐式全局）。
- 模块之间的**唯一**合法依赖方向：`<domain>/<module>` → 纯函数库（`<domain>/lib-*.js`，无 IO、无状态）。跨域调用一律经 `ctx`。

### E.2 测试

- 路径固定 `tests/<module>.test.mjs`，使用 `node:test` + `node:assert/strict`（对齐 `src/core/session-router.test.mjs` 的写法）。
- **必须能 `node --test tests/<module>.test.mjs` 单跑**：不起服务、不读真 `config.json`、不碰网络、不写真实 `state/`（用临时目录 + `ctx.state` 的内存实现）。
- 每个模块至少覆盖三条：① 正常路径 ② **缺依赖时的降级路径** ③ 抛错时的策略（fail open 要断言"主链路继续"，fail closed 要断言"拒绝了"）。
- 守卫链还要额外断言"连续 5 次失败后熔断、**5 分钟后半开试探一次**"（`bridge.js:10454`，Q12 ✅ B）；`policy:'closed'` 的项（静默/鉴权）要断言"失败即拒绝"而非跳过（Q4 ✅ B）。
- **双轨（Q5 ✅ A）**：新模块一律 `tests/<module>.test.mjs`；`scripts/` 下那 50+ 个 `test-*.mjs` 保持原路径与 `package.json` 的 `test:*` 入口不变，本契约**不要求**迁移或改名。

### E.3 文件头注释（强制模板）

```js
// <domain>/<module> — <一句话职责，动词开头>
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：cfg, log, now        （optional：state）
// 失败策略：fail-open         （依据：D 表 `<domain>/<module>` 行）
// 单测：tests/<module>.test.mjs
//
// 为什么需要：<这里写清它解决的具体问题；没有这段就删掉这个模块>
// 边界：<明确写"不做什么"，例如"不发消息、不写 state、不联网">
```

头注释不是形式主义：`bridge.js` 里最好的几段注释（`onebot-retry.js:1-9`、`anti-ai-patterns.js:1-12`）恰好都是"为什么需要 + 边界"，事故复盘时能直接定位责任面。缺这一段的新模块在评审时直接退回。

---

## F. 禁止清单

以下 12 条是**硬约束**，评审时逐条对照；违反任一条的 PR 不予合入。

1. **不许 `import` `bridge.js`。** 包括相对路径（`../bridge.js`）、绝对路径、`import()` 动态导入。`bridge.js` 一被 import 就起服务（`src/onebot-retry.js:3` 已记录这个坑），单测会挂死。
2. **不许读全局变量。** 禁止 `globalThis.*`、模块级 `let` 缓存跨调用状态、直接读 `process.env`（配置只能经 `ctx.cfg`）。唯一例外：`lifecycle/boot` 读 `process.argv`。
3. **不许自开端口 / 自建 socket。** 禁止 `http.createServer`、`net.createServer`、`listen()`。控制台端口只属于 `lifecycle/boot`（`bridge.js:3811`）。
4. **不许直接写 `state/*.json`。** 禁止 `fs.writeFileSync('state/...')`、禁止自己拼 `STATE_DIR` 路径、禁止自己实现"原子写"（统一走 `persist/atomic.js`，`bridge.js:363`）。模块只能 `ctx.state.write('<domain>/<module>', value)`。
5. **不许吞错。** 禁止空 `catch {}`、禁止 `catch (e) {}`、禁止 `catch` 后返回成功。要么向上抛，要么 `ctx.log('warn', ...)` + `{ok:false}`。
6. **不许 `import` 其他模块的内部状态。** 跨模块只能：① 经 `ctx`；② import 显式标注 `@pure` 的纯函数。禁止为了拿一个 `Map` 而 import 另一个域的实现文件。
7. **不许直接用 `Date.now()` / `Math.random()`。** 一律 `ctx.now()` / `ctx.random()`，否则测试不可复现（这也是 `scorer.pickBest` 收 `rng` 参数的原因，`src/scorer.js:122`）。
8. **不许 `console.log` / 直接写日志文件。** 一律 `ctx.log` / `ctx.audit`（`bridge.js:1502` 的 `log()` 负责脱敏与轮转）。
9. **不许 `process.exit` / 注册进程级钩子。** 退出只属于 `lifecycle/*`（`bridge.js:15719-15749`）。
10. **不许模块内常驻 `setInterval`。** 定时器统一由 `scheduler/tick.js` 持有并注入 `ctx.timer`，否则进程关不掉、测试跑不停。
11. **不许自行联网。** 只有声明了 `net` 依赖的模块（`web-search` / `web-sticker`）可出网，且必须经 `ctx.net`（`src/safe-fetch.js` 的 SSRF 防护）。其余模块联网一律视为后门。
12. **不许在 import 时产生副作用。** 顶层不得读文件、不得起 timer、不得改任何共享对象。`import` 必须安全到"随便 import 也不会出事"，这是 `node --test` 单跑的前提。

---

## G. 现有 8 个模块的映射

| 模块 | 是否已符合契约 | 需要什么改造 | 改造量 |
| --- | --- | --- | --- |
| `gif-frames`（`src/gif-frames.js`，4 个导出） | **基本符合**。纯函数、无 IO、无状态、不 import 本项目任何文件（只依赖 `gifuct-js` / `pngjs`），参数全显式（`{ maxFrames, cellMax, maxBytes }`），天然可单测 | ① 加 `spec` + `handle` 门面（`handle(ctx,{buffer,mimeType})` 转发到 `decodeGifToSheet`），`spec.name='inbound/gif'`；② 补文件头注释模板（现有头注释已讲"为什么"，缺"失败策略/deps"两行）；③ 迁到 `src/inbound/gif.js` | **小** |
| `relay`（`src/relay.js`，`createRelay`） | **最接近契约**。依赖注入做得很干净：`hasSession` / `agentTokenOk` / `send` / `log` / `appendActivity` / `guardLength` / `isSensitive` 全部由外部传入（`bridge.js:3862-3877`），模块内不碰网络与全局 | ① `spec.toggle.level='owner'`（跨会话外发）、`deps=['cfg','session','log']`；② **实例化点要挪**：`createRelay` 目前在 `startConsoleServer()` 内部（`bridge.js:3862`），职责上属于工具域而非控制台；③ `cfg` 参数收窄为 `cfg.socialV2.relay` 视图，不要整个 `cfg`；④ `RELAY_WINDOW_MS` 这类常量改成 `spec.config` 默认值以便热改 | **小** |
| `scorer`（`src/scorer.js`，`evaluate`/`pickBest`） | **基本符合**。纯函数，`ctx` 参数已是普通对象、`rng` 可注入（`:122`），词表是模块常量 | ① `spec.toggle.level='free'`（shadow 无副作用）；② 接线方式要改：现在是 `guardOutboundV2` 里**硬编码**调用（`bridge.js:10465`），应改为守卫链注册（`guards:['outbound.observe']`），否则新增观测项必须改中枢；③ `pickBest` 的 best-of-n 尚未接线（`:8-11` 自注），接的时候走 `scheduler` 而非模块内循环 | **小** |
| `anti-ai-patterns`（`src/anti-ai-patterns.js`） | **部分符合**。检测逻辑（`checkAntiAi`）是纯的，但**加载器做 IO**：`loadAntiAiPatterns(file)` 自己 `fs.readFileSync`（`:28`），且加载结果被存进 `bridge.js` 的模块级变量 `antiAiLibrary`（`bridge.js:196`，`:3858` 赋值一次） | ① 拆成"读文件（中枢）→ 编译（纯函数）"两半，模块只留编译与检测；② 干掉模块级 `antiAiLibrary`，改 `ctx.state.read('guards/anti-ai')`；③ **热加载**：目前注释明说"换词库仍需重启桥"（`bridge.js:193-195`、`:3861`），必须改成按 mtime 失效重载（见 H7）；④ `spec.toggle.level='free'`，但把 `mode: shadow→enforce` 的切换归为 owner | **中** |
| `onebot-retry`（`src/onebot-retry.js`，`createOnebotRetry`/`nextDelay`） | **完全符合**（本仓最佳范例）。零 import、定时器与 `log` 全部注入（`:59`），纯状态机，`nextDelay` 是无状态纯函数 | ① 补 `spec`（`level='locked'`，OneBot 连接不可关）；② `handle(ctx,{action})` 包 `start/stop/status` 三个动作；③ 迁 `src/lifecycle/onebot-retry.js`；④ 无需逻辑改动 | **小** |
| `web-search`（`src/web-search.js`，`webSearch` 等 13 个导出） | **不符合**。① 有**模块级可变缓存**（`clearSearchCache` `:469` 暗示内部有跨调用缓存）；② 自己读凭据（`resolveSearchApiKey` `:110` + `readDshCredential` `:97` 直接读文件）；③ 默认参数里带真实网络实现（`webSearch` 的 `transport` 默认值），单跑会真的出网 | ① 缓存改为 `ctx.state` 命名空间或由中枢注入 `cache`；② 凭据解析上移中枢（模块只收 `apiKey`），**模块不得读 DSH 凭据文件**；③ `transport` / `post` 全部改为必传，默认实现移到 `tools/mcp-websearch` 装配层；④ `spec.deps` 加 `net`、`toggle.level='owner'`（外发+成本）；⑤ 补"离线用假 transport"的测试夹具 | **中** |
| `web-sticker`（`src/web-sticker.js`，`searchWebImage` 等 8 个导出） | **不符合（状态问题最重）**。① **持有模块级全局状态**：`resetDailyQuota()`（`:67`）/`quotaSnapshot()`（`:72`）说明日配额存在模块作用域里，进程重启即清零、多实例会各算各的；② import 了 `safe-fetch.js`（合规，但应改为 `ctx.net`）；③ 直接读整个 `cfg`（`stickerWebConfig(cfg)` `:47`） | ① **配额迁出**：改 `ctx.state.patch('inbound/web-sticker', ...)` + `ctx.now()` 判日切；② 去掉 `import safe-fetch`，改注入 `ctx.net`；③ `stickerWebConfig` 只接收 `cfg.socialV2.stickerWeb` 子树；④ `spec.toggle.level='owner'`（联网 + 默认关闭，见其头注释 `:1-2`）；⑤ `BING_IMAGE_SEARCH` 这类端点常量收敛进 `spec.config` | **中** |
| `model-prices`（`src/model-prices.js`，20 个导出） | **符合**。纯数据 + 纯函数，节假日表是常量，`isPeakAt(atMs)` 时间全部作为参数传入（不读 `Date.now()`），`resolvePriceTable(override)` 自带兜底（`:133`） | ① 补 `spec`（`name='cost/prices'`、`deps=['cfg']`、`toggle.level='owner'`——价目表错会直接导致成本熔断误判，不能给 AI 改）；② `handle` 只 expose `priceUsage` 一个动作，其余保持纯函数导出并标 `@pure`；③ 版本号 `PRICE_TABLE_VERSION`（`:21`）接入 `spec.version` 的校验链 | **小** |

**改造量汇总**：小 5 个（gif-frames / relay / scorer / onebot-retry / model-prices）、中 3 个（anti-ai-patterns / web-search / web-sticker）、大 0 个。
**三条共性结论**：
1. **纯函数模块几乎零成本**（`onebot-retry` / `model-prices` / `gif-frames`）——说明"依赖注入 + 无 IO"这条路是对的，新模块照抄即可。
2. **凡是持有模块级可变状态的都要动手术**（`web-sticker` 的配额、`web-search` 的缓存、`anti-ai` 的词库句柄），这三处也是并行开发最容易撞车的地方，建议**同一个会话连续做完**。
3. **接线点比模块本身更难拆**：`relay`（`bridge.js:3862`）、`scorer`（`:10465`）、`anti-ai`（`:3858`+`:10487`）三个模块的代码都是干净的，脏的是中枢里那三处硬编码调用——拆分的主要工作量在"把调用点改成注册制"。

---

## H. 模块开关与运行时状态

> **本节目标**：让 QQ 侧 AI（小鲸鱼）能自己开关**部分**模块以获得更好的表达/交互，但**绝不允许**它关掉任何一条能让桥停止工作的东西。这条线的实现方式是"**白名单 + 分级 + 自锁**"，而不是"给个开关再靠提示词劝它别关"。

### H1. `spec.toggle` 字段定义

```js
toggle: {
  level: 'free' | 'owner' | 'locked',
  default: true | false,   // 缺省状态；文件里没有记录时用它
  hot: true                // 是否支持热生效（false = 必须重启，v1 不允许出现）
}
```

| 字段 | 取值 | 语义 | 校验规则 |
| --- | --- | --- | --- |
| `level` | `free` | **AI 自己可开关**。仅限"纯本地、无外发、无成本、失败不影响收发"的增强项 | 只有满足 H2 白名单三条件才能标 `free`；标错由评审拦 |
| | `owner` | **仅主人可改**。AI 调用返回 403；控制台（`consoleToken`）或主人私聊 + 一次性确认码可改 | 默认值。**新模块不写 `toggle` 时按 `owner` 处理**（安全默认） |
| | `locked` | **任何人不可关闭**。传了就拒绝，不接受别名、不接受 `level` 覆盖 | 只能在代码里改 `spec.toggle.default` 后重启；运行期无任何通道可改 |
| `default` | `true`/`false` | 无状态记录时的初值 | `locked` 且 `default:false` 视为配置错误，装配时拒绝 |
| `hot` | `true` | 变更后**下一次调用**即生效 | v1 只接受 `true`；出现 `false` 说明该模块还在读启动快照，见 H7 |

`hot: true` 的实现要求：模块的每次 `handle` 都必须重新读取开关状态（经 `ctx.cfg` 或中枢注入的 `isOn()`），**不得**在 import 时或首次调用时把开关值缓存到模块级变量。

### H2. 分级清单

**硬性要求已满足的 locked 集合**（用户指定 8 类，逐条对应到模块）：OneBot 连接、文本收发、守卫链执行器、鉴权、状态持久化、日志、成本熔断、模块开关工具本身 —— 见下表加粗行。

| 模块 | level | 理由 |
| --- | --- | --- |
| `lifecycle/boot` | **locked** | 核心运行程序；关掉 = 进程不起 |
| `lifecycle/lock` | **locked** | 单实例保护；关掉 = 双实例抢消息（`bridge.js:1349-1353`） |
| `lifecycle/shutdown` | **locked** | 优雅退出；关掉 = 锁文件残留、下次启动被自己挡住 |
| `lifecycle/onebot-retry` | **locked** | **OneBot 连接**；关掉 = 断线后再不重连（`src/onebot-retry.js:1-9` 记录的 6h44m 事故） |
| `auth/console-token` | **locked** | **鉴权** |
| `auth/agent-token` | **locked** | **鉴权**（二代会话隔离唯一凭据） |
| `auth/admission` | **locked** | **鉴权**（白名单/模式准入） |
| `auth/tool-gate` | **locked** | **鉴权**（工具面） |
| `session/store` | **locked** | **状态持久化**（会话映射） |
| `session/social-state` | **locked** | **状态持久化**（仿真状态） |
| `session/router` | owner | 决定"哪个会话用哪个 preset"，改它等于改权限边界；但主人可能需要按会话调策略 |
| `session/lifecycle` | **locked** | 会话退役/重建与 token 撤销绑定（`bridge.js:3408-3482`），关掉会留下高权限旧会话 |
| `inbound/segments` | **locked** | **文本收发**（入站归一） |
| `inbound/media` | owner | 影响 OCR/ASR，**有成本**且会把媒体发给上游模型；主人可关以省钱 |
| `inbound/gif` | **free** | 纯本地解码、无外发、无成本，失败回退原图（`gifMediaPlan`）；关掉只是"看不到动图分镜" |
| `inbound/message` | **locked** | **文本收发**（消息 DTO） |
| `inbound/command` | owner | 管理命令解析；主人可能想临时禁用某些命令，但 AI 绝不该碰 |
| `scheduler/wake` | owner | 直接决定"AI 主动发言的频率"，属于行为策略，主人定 |
| `scheduler/tick` | **locked** | 常驻定时器与健康检查；关掉 = 再没有任何自愈与兜底 |
| `scheduler/queue` | **locked** | 投递队列；关掉 = 消息进来不处理 |
| `tools/registry` | **locked** | 工具面总表；关掉 = AI 全瞎，且等于绕过所有工具级鉴权 |
| `tools/module-switch` | **locked** | **模块开关工具本身**；允许关它 = 开关系统自杀 |
| `tools/mcp-snowluma` | **locked** | **文本收发** |
| `tools/mcp-websearch` | owner | 联网外发 + 按次计费；只有主人能决定"允不允许查网" |
| `guards/chain` | **locked** | **守卫链执行器**；关掉 = 全部出站校验失效 |
| `guards/outbound-content` | owner | 单条规则（元信息/称呼）的开关与词表可调，但**默认必须开**；链执行器本身 locked |
| `guards/length` | owner | 软干预阈值（40 字/12 字/10 分钟）是体验参数，主人可调；AI 自调等于可以无限刷屏 |
| `guards/sensitive` | **locked** | 凭据/路径外发审计；`RULES.md` §6 的硬拦截，不可关 |
| `guards/anti-ai` | **free** | 当前只 shadow（`bridge.js:10484-10499`），纯观测；**例外**：`mode: shadow→enforce` 的切换是 owner |
| `guards/scorer` | **free** | 当前只 shadow（`bridge.js:10465-10481`），纯观测，无出站影响 |
| `outbound/send` | **locked** | **文本收发** |
| `outbound/batch` | **locked** | **文本收发**（分条/间隔） |
| `outbound/recheck` | **locked** | 发送前权限复核与静默判定（`bridge.js:10398-10413`） |
| `persist/atomic` | **locked** | **状态持久化** |
| `persist/acl` | **locked** | **状态持久化**（目录 ACL 加固） |
| `persist/migrations` | **locked** | **状态持久化**（历史字段补齐） |
| `obs/log` | **locked** | **日志**；关掉 = 事故无法复盘 |
| `obs/activity` | **locked** | **日志**（`state/qq-activity.log`，`RULES.md` §管理员操作手册 依赖它） |
| `obs/tool-log` | **locked** | **日志**（`state/tool-calls.jsonl`） |
| `obs/health` | owner | 自检频率/阈值是运维参数，主人调；关自检不致命但会失去早期告警 |
| `obs/samples` | owner | 会把对话内容导出成文件，涉及隐私，只有主人能决定开 |
| `heal/model-fallback` | owner | 换模型 = 换质量与成本；且 `fallbackChain` 是主人显式配的 |
| `heal/dsh-port` | **locked** | DSH 端口自愈；关掉 = DSH 换端口后桥永久失联（`bridge.js:12187` drifted 场景） |
| `heal/onebot` | **locked** | **OneBot 连接** |
| `heal/token` | **locked** | 令牌自愈（`bridge.js:15623`）；关掉 = 令牌过期后整桥静默 |
| `cost/prices` | owner | 计价口径（峰谷/节假日）；口径错会让熔断误判，只能主人改 |
| `cost/ledger` | **locked** | **成本熔断**（账本是熔断的判据来源） |
| `cost/gate` | **locked** | **成本熔断**本体 |

**统计（口径分开记，不要互相推导）**：

| 口径 | locked | owner | free | 合计 |
| --- | --- | --- | --- | --- |
| A.1~A.12 运行时模块（上表逐行） | **34** | **11** | **3** | 48 |
| A.13/A.14 内容模块（分级见 A 节表） | 4 | 8 | 3 | 15 |
| **全仓** | **38** | **19** | **6** | **63** |

> Q9 ✅ 说的「维持 locked 34 个」指的**只是**第一行（运行时 48 个模块）——这是"绝不能关核心"推导出的基线。内容域的 4 个 locked 是 `content/pinyin`、`persona/role-card`、`persona/preset-prompt`、`persona/inject`。

**为什么 free 只有 6 个**：这是刻意的。free 的准入门槛是三条**同时**满足：① 不产生任何外发（网络/消息/文件）② 不产生任何计费 ③ 失败时主链路行为不变。按这个口径：运行时 48 个里只有 `inbound/gif`、`guards/anti-ai`（shadow）、`guards/scorer`（shadow）合格；内容域里只有 `content/mood`、`content/stickers`、`content/memes` 合格（三者都只是"本地选内容"，真正的发送在 `outbound/*`）。**新增模块默认 `owner`**，想标 `free` 必须在上表补一行并写明三条如何满足。

### H3. 状态存储

**路径**：`state/module-switches.json`（新增约定，当前不存在）。

```json
{
  "version": 1,
  "updatedAt": 1793193600000,
  "switches": {
    "guards/scorer": {
      "on": false,
      "level": "free",
      "changedAt": 1793193500000,
      "changedBy": "qq:private:10001",
      "reason": "打分日志太吵，先关一周"
    },
    "inbound/gif": {
      "on": true,
      "level": "free",
      "changedAt": 1793193600000,
      "changedBy": "console",
      "reason": "恢复默认"
    }
  },
  "stats": {
    "guards/scorer": {
      "toggleTimes": [1793193500000, 1793190000000],
      "offSince": 1793193500000
    }
  }
}
```

字段说明：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `version` | int | 结构版本；当前 `1`。读到更高版本 → 按"未知结构"降级 |
| `updatedAt` | ms | 整文件最后写入时间（诊断用） |
| `switches[name].on` | bool | 实际状态 |
| `switches[name].level` | enum | **冗余快照**，仅供诊断与审计回放；**判定一律以代码里的 `spec.toggle.level` 为准**，文件里的 level 永不参与鉴权（防止改文件提权） |
| `changedAt` / `changedBy` / `reason` | ms / string / string | 最近一次变更（`qq_module_list` 的"最近变更"就是这三个） |
| `stats[name].toggleTimes` | ms[] | 滑动窗口原始记录，保留最近 10 条（H5 限频用） |
| `stats[name].offSince` | ms \| null | 关闭起始时刻（H5 自动恢复用） |

**内存缓存 + 异步落盘**：

- 中枢在 `lifecycle/boot` 里加载一次，构造 `Map<string, {on, changedAt, changedBy, reason}>` 作为**唯一**真相；`ctx` 里的开关读取是无锁内存读（O(1)）。
- 变更流程：**先改内存 → 立即回包 → `scheduleFlush()`**。落盘走 `persist/atomic.js` 的 `atomicWriteJson`（`bridge.js:363`，含 `renameWithRetry` 应对杀软占用），**不在请求路径上同步写**。
- 合并写：200ms 内多次变更加合并为一次写（debounce）。进程退出时 `lifecycle/shutdown` 强制 flush 一次（`bridge.js:15749` 的 `exit` 钩子里已有 `releaseLock()`，flush 挂同一处）。
- 写入失败：`ctx.log('error', ...)` 记账 + 保留内存状态 + 标记 `dirty`，下一次变更/退出时重试。**不抛出**——开关写盘失败不该让工具调用报错，但必须留日志（否则重启后状态静默丢失）。

**启动时加载与降级**（对齐 `loadState` 的成熟做法，`bridge.js:1312-1347`）：

| 情况 | 行为 |
| --- | --- |
| 文件不存在（首次运行） | 全部按 `spec.toggle.default`，立即写一次文件建立基线；不报错 |
| JSON 解析失败 | **保留原文件不覆盖**（改名 `module-switches.json.corrupt-<ts>` 留证），全部回默认，`log('error')` 一条，进程继续起 |
| 结构不对（缺 `switches` / 不是对象 / `version` 高于支持） | 同上，按"损坏"处理 |
| 某模块名在文件里但代码里已不存在 | 忽略该条（不删，仅不加载），`log('warn')` 列出；便于回滚旧版本 |
| **`locked` 模块在文件里被写成 `on:false`** | **忽略并强制 `on:true`**，`log('error')` + 写审计 `reason='reject-locked-override'`；这是防手改文件的关键一条 |
| **手改文件（非工具/控制台写入）** | **Q8 ✅ B：手改在启动时被覆盖。** 加载后立即 `normalizeOnBoot` 整文件重写一次：不符合 schema 的字段丢弃、`level` 一律重置为代码值、缺 `changedBy` 的条目回退 `default`。篡改判据：正常写入恒有 `updatedAt === max(switches[*].changedAt)`，不等即判为外部改动 → **全部条目回退 default** + 审计 `reason='manual-edit-detected'` |
| `free`/`owner` 模块缺记录 | 用 `spec.toggle.default` |

### H4. 工具接口

两个工具都注册在 `tools/module-switch.js`，走既有 MCP 工具面（`src/mcp-snowluma-safe.js` 的 `server.tool` 风格），**并且**在控制台开一对等价 HTTP 端点（`GET /api/modules`、`POST /api/modules/toggle`），以便主人用控制台改 owner 级。

#### `qq_module_list`

```
入参：{}                     // 只读，无参数
返回：{
  ok: true,
  now: 1793193600000,
  modules: [
    { name:'guards/scorer', level:'free', on:false,
      lastChangedAt:1793193500000, lastChangedBy:'qq:private:10001',
      default:true, hot:true, offReason:null }
  ]
}
```

- 只返回**当前会话有权看到**的模块：群聊里 `level:'locked'` 的项也要返回（AI 需要知道"这些不能动"），但 `owner` 项附 `toggleable:false`。
- `lastChanged*` 取 `switches[name]`，无记录时返回 `null`。
- `offReason`：`'missing-dep:<name>'` / `'auto-restore'` / `null`（H3 与 B.3 的接线）。

#### `qq_module_toggle`

```
入参：{ name: string, on: boolean, reason?: string }
返回（成功）：{ ok:true, name, from:boolean, to:boolean, level, changedAt, auditId }
返回（拒绝）：{ ok:false, code, error }
```

| 场景 | code | HTTP | 文案（对 AI 可读） |
| --- | --- | --- | --- |
| `level='locked'` | `LOCKED` | 403 | `该模块不可关闭`（**不区分 on/off，一律拒**，见 H5-1） |
| `level='owner'` 且调用者非主人 | `FORBIDDEN` | 403 | `该模块仅主人可改`（H5-2） |
| `level='owner'` 且主人但缺确认码 | `NEED_CONFIRM` | 401 | `请回复确认码以修改 <name>`（一次性 6 位码，10 分钟有效） |
| 名字不存在 | `UNKNOWN_MODULE` | 404 | `没有名为 <name> 的模块` |
| 限频命中 | `RATE_LIMITED` | 429 | `该模块 10 分钟内已改 2 次，请稍后再试`（H5-3） |
| 参数非法（`on` 非布尔 / `reason` 超 200 字） | `INVALID_ARGS` | 400 | 指明哪个字段 |
| 无实质变化（`on` 与原值相同） | `{ok:true, noop:true}` | 200 | 不写审计、不计频次 |

- `reason` **可选但强烈建议**；为空时审计记 `'(no reason)'`。禁止因为没写 reason 就拒绝——那会让 AI 为了填字段编理由。
- 返回里带 `auditId`（= 审计行的序号或时间戳），方便 AI 事后引用"我改过什么"。

### H5. 三条防呆规则（逐条实现）

#### 规则 1：自锁保护 —— locked 模块名不在 toggle 白名单内

**实现方式（三层，任一层单独成立即可拦下）：**

1. **白名单是"查询结果"，不是"黑名单校验"**。`qq_module_toggle` 第一步不是判断"是不是 locked"，而是：
   ```js
   const entry = registry.get(String(args.name));   // 精确键查找
   if (!entry) return { ok:false, code:'UNKNOWN_MODULE' };
   if (entry.spec.toggle.level === 'locked') return { ok:false, code:'LOCKED', error:'该模块不可关闭' };
   ```
   即：**根本不存在"传 locked 名字能走到写入逻辑"的代码路径**，而不是"写进去之前检查一下"。
2. **名字规范化只做一件事**：`trim()` + 拒绝含空格/斜杠异常/大写折叠后的重名。**不做别名表、不做模糊匹配、不做前缀补全**。`guards/chain` 与 `guards/chain ` 与 `Guards/Chain` 中只有第一个能被查到，其余一律 `UNKNOWN_MODULE`——这样"用别名绕过 locked"在物理上不可能（`bridge.js:3830` `tokenEq` 的定长比较也是同一思路：不给试探留缝隙）。
3. **`level` 永远来自代码**。H3 已规定文件里的 `level` 字段只做诊断快照；即使有人手动把 `state/module-switches.json` 里 `guards/chain.level` 改成 `"free"`，装配时以 `spec.toggle.level` 为准，启动加载还会把 locked 的 `on` 强制回 `true`（H3 表最后两行）。**改文件不能提权。**

同时 `qq_module_list` 必须把 locked 项**列出来**并带 `toggleable:false`，让 AI 明确知道"这些是地基，不在讨论范围内"，减少它反复尝试。

#### 规则 2：仅 owner —— 群聊与非 owner 私聊返回 403

**实现方式：**

1. 判定发生在**工具入口第一行**，早于任何参数解析：
   ```js
   function assertCallerAllowed(ctx, level) {
     if (ctx.session.kind !== 'private') return deny(403, '群聊不可修改模块开关');
     if (!ctx.session.isOwner) return deny(403, '仅主人可修改模块开关');
     if (level === 'owner' && !ctx.ownerConfirmed) return deny(401, 'NEED_CONFIRM');
     return null;
   }
   ```
   `ctx.session.isOwner` 来自中枢既有判定（`bridge.js:14388` `String(event.user_id) === String(cfg.ownerQQ)`），**模块自己不算**——`ownerQQ` 的读取权在中枢，模块拿到的是布尔结论。
2. **"额外凭证"的定义（Q7 ✅ A，新增约定，复用现成机制）**：owner 级变更需要一次性 6 位确认码，由第一次调用拒绝时通过 owner 私聊下发，10 分钟有效，用后即焚。直接复用 `src/forward-approval.js:128` `generateApprovalCode` / `:126` `pruneApprovals` 的实现与过期口径，不新造一套。
3. **控制台通道等价于主人**：带有效 `consoleToken` 的 `POST /api/modules/toggle` 视为 owner 级调用，无需确认码（控制台本来就是最高权限，`RULES.md` §权限分层 已如此定义）。`x-agent-token` 通道**永远不能**碰 owner 级。
4. **AI 自我提权的堵口**：`ctx.session.isOwner` 只在入站时由中枢算一次并冻结；模块内不得重新解析 `key` 或读 `cfg.ownerQQ` 来判断"我是不是主人"（这也是 F.2 的一部分）。

#### 规则 3：限频 + 自动恢复

**限频（同一模块 10 分钟内最多改 2 次）**

```js
const WINDOW_MS = 10 * 60 * 1000;
const MAX_IN_WINDOW = 2;
function checkRate(stats, nowMs) {
  const times = (stats.toggleTimes ?? []).filter((t) => nowMs - t < WINDOW_MS);
  return times.length < MAX_IN_WINDOW ? { ok: true, times } : { ok: false, times };
}
```

- 滑动窗口，`toggleTimes` 只保留最近 10 条（H3）。**只统计"实际生效"的变更**：`noop`、被拒、403 都不计入——否则 AI 试错会被自己的失败调用锁住。
- 变更成功时把 `now` push 进 `toggleTimes`，并把结果写进 `stats`。
- 窗口按**模块**独立计，不是全局计数（避免"关了一个就关不了另一个"）。
- 越限返回 `429 RATE_LIMITED`，文案里带"下次可改时间"（`times[0] + WINDOW_MS`），让 AI 能自我纠正而不是硬撞。

**自动恢复（关闭状态超过 24 小时回默认值）**

- 不靠内存定时器（会随重启丢失），靠**两个触发点 + 一个幂等判定**：
  1. `scheduler/tick` 每 10 分钟扫一次（新增一个 tick 动作，挂在 `bridge.js:12071` `startHealthTimer` 同类位置）；
  2. `lifecycle/boot` 加载 H3 文件时先扫一次（覆盖"停机超过 24h"的情况）。
- 判定：`on === false && stats.offSince != null && now - offSince > 24*3600*1000` → 把 `on` 设为 `spec.toggle.default`，清 `offSince`，写审计 `reason='auto-restore-24h'`。
- **只对 `free` 级生效**；`owner` 级的关闭是主人的明确决定，不自动回滚（否则主人关掉的联网搜索会在一天后自己打开）。
- 恢复后 `offReason` 置 `'auto-restore'`，`qq_module_list` 能看到"它为什么又开着"。

### H6. 审计

**路径**：`state/module-switch.log`（新增；与 `state/bridge.log` 分离，避免被日志轮转冲掉）。

**格式**：JSONL，一行一条，字段顺序固定。

```json
{"ts":"2026-10-27T21:12:33+08:00","actor":"qq:private:10001","actorKind":"owner","module":"guards/scorer","from":true,"to":false,"level":"free","reason":"打分日志太吵","result":"applied","src":"qq_module_toggle"}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ts` | 是 | 本地时间带时区偏移（复用 `bridge.js:1494` `localClock` 的思路，**不用** `toISOString()` 的 UTC） |
| `actor` | 是 | `console` / `qq:group:<id>:<uid>` / `qq:private:<uid>` / `system` |
| `actorKind` | 是 | `owner` / `agent` / `system`——用于事后区分"AI 自己关的"还是"人关的" |
| `module` | 是 | 规范模块名 |
| `from` / `to` | 是 | 布尔 |
| `level` | 是 | 变更时的级别快照 |
| `reason` | 是 | 调用方给的理由；空则 `"(no reason)"` |
| `result` | 是 | `applied` / `rejected` / `noop` / `auto-restore` |
| `src` | 是 | `qq_module_toggle` / `console` / `boot-sweep` / `tick-sweep` |

- **拒绝也要记**：`LOCKED` / `FORBIDDEN` / `RATE_LIMITED` 全部写一行 `result:'rejected'`。这是发现"AI 在试探 locked 边界"的唯一信号。
- 写入方式：复用 `createCappedLogger`（`bridge.js:1465`，行数上限 + 轮转到 `.1`），**同步 append**（量小、必须可靠），失败只 `log('warn')`，绝不阻断开关操作。
- 追加而不是重写；不做自动清理（审计价值高于磁盘）。

### H7. 热生效要求

**总要求：任何 `toggle` 变更都不得依赖重启。** 变更后**下一次调用**即按新状态执行；不得出现"控制台显示已关，实际还在跑"的状态漂移（`bridge.js:289-298` `settingFromDshNamespace` 的注释记录过同类事故：写了 user 层但进程内读到的还是旧值）。

**实现范式**：中枢在每次装配/调用时注入 `isOn` 闭包读内存缓存，模块不缓存开关值：

```js
// 中枢侧（唯一真相来源）
const isOn = (name) => switchCache.get(name)?.on ?? registry.get(name).spec.toggle.default;

// 调用点（每次调用都过一遍）
if (isOn('guards/scorer')) { ... }
```

**目前"从 cfg 启动时读取、需要改为运行时读取"的开关点**（以下为 H7 的施工清单，逐条给位置）：

| # | 位置 | 现状 | 改造要求 |
| --- | --- | --- | --- |
| 1 | `bridge.js:196` + `bridge.js:3858` | `antiAiLibrary` 模块级变量，`startConsoleServer()` 里赋值一次；注释自认"换词库仍需重启桥"（`:193-195`、`:3861`） | 改 mtime 失效重载：每次出站前比较文件 mtime（缓存 60s），变了就重建词库；同时改走 `ctx.state`，消除模块级变量 |
| 2 | `bridge.js:3107` | `const priceTable = resolvePriceTable(cfg.pricing)` —— 启动快照 | 改 `() => resolvePriceTable(ctx.cfg.pricing)`，或在 `cfg.pricing` 变更时由中枢重建；`cost/gate` 每次判断都取最新 |
| 3 | `bridge.js:10595` | `const modelFallbackChain = buildEffectiveChain(cfg.dsh)` —— 启动快照 | 改可重算（`let` + `rebuildChain()`），在控制台改 `dsh.fallbackChain` 后立即重算 |
| 4 | `bridge.js:10598` | `MODEL_FALLBACK_PROBE_MS` 启动快照 | 同 3，改为函数或随链重算 |
| 5 | `bridge.js:1686` | `const cfg = loadConfig()` —— **整个配置的一次性快照**；运行期只有 `cfg.socialV2` 被整体替换（`bridge.js:5291`） | **Q6 ✅ A**：v1 **不要求**全量热加载（风险大）。要求：**所有模块开关判定不得依赖 `cfg` 里的一次性字段**，只依赖 `module-switches` 缓存；`cfg` 的其余字段仍是启动快照，逐域改造留到 v2 |
| 6 | `bridge.js:3792` | `v2ToolEnabled()` 已**运行时读取** `cfg.socialV2.tools` | **已经是正确范式，不必改**；新的 `isOn()` 与它并列，作为 H7 的参考实现 |
| 7 | `bridge.js:3812` | `const port = cfg.consolePort ?? 3100` —— 端口快照 | **明确不热改**（换端口 = 换控制台地址，需重启）。在 `qq_module_list` 里对该项标注 `hot:false` 语义 |
| 8 | `bridge.js:1297` / `bridge.js:3043` / `bridge.js:3668` | `wsUrl` / `NodeApiClient` baseUrl / `SNOWLUMA_SILENCE_WARN_MS` 启动快照 | 不属模块开关范围，但属"同样是启动快照"的清单；接入 DSH 端口漂移（`bridge.js:12161` `applyDshBaseUrl`）时应一并改为可重算 |
| 9 | `src/anti-ai-patterns.js:28` | 加载器自己读文件（IO 在模块内） | 与 #1 同批改：IO 上移中枢，模块只留编译/检测 |
| 10 | `src/web-sticker.js:67` / `:72` | 日配额存在模块作用域 | 配额与开关都必须落 `ctx.state`，否则"关掉再开"会重置额度，等于绕过限流 |

**验收方式（新增约定）**：任一 `free`/`owner` 模块的开关测试必须包含"改完不重启、下一次 `handle` 生效"的断言，且**不得**在测试里调 `process.exit` 或重建进程。

---

## 待确认清单（Q1~Q12：v1.1 已全部定稿 ✅）

**12 项均已定稿**，原先的"现状 / 可选方案"不再并列展示（避免两份说法并存，需要考古时看 v1 的 git 历史）。下表只记**结论**与**落地位置**；结论已回填到正文对应小节。

| # | 原问题 | ✅ 结论（v1.1 定稿） | 落地位置 |
| --- | --- | --- | --- |
| **Q1** | 27 个内容类库归哪个域 | **拆 `content` + `persona` 两域**：记忆 / 日记 / 心情 / 黑话 / 表情 / 梗 → `content`（A.13）；角色卡 / 反 AI 词库 / 人格注入 → `persona`（A.14） | A.13 / A.14（15 个模块，含归属文件与实际路径）；`eco-lib` 等 12 个按 `<domain>/lib-*.js` 挂靠 |
| **Q2** | `session-router` 是否正式接入 | **B**：先接入**新代码路径**；旧 `modeAllowed`（`bridge.js:3340`）保留一版灰度，稳定后再删 | A.3 `session/router` 行；新调用点由 `session/router.js` 提供，旧判定本轮不动 |
| **Q3** | 成本熔断口径与阈值 | **日预算 ¥30 预警 / ¥50 硬停**；硬停**只拒绝「新会话 / 新轮次」**，**不打断进行中的对话** | A.12 `cost/gate`；D 表 `cost/gate` 行；`ctx.cost.judge()` 返回 `{ allow, warn, reason }` |
| **Q4** | 守卫链 fail closed 边界 | **B**：`runGuard(name, fn, fallback, policy)` 增加 `policy: 'open' \| 'closed'`；**静默与鉴权走 `closed`** | A.7 `guards/chain`；D 表 `guards/chain` 行；E.2 断言 |
| **Q5** | 测试放 `tests/` 还是 `scripts/` | **A**：新模块用 `tests/`；`scripts/test-*.mjs` 那 50+ 个老脚本**不动**（双轨） | E.2「双轨」条 |
| **Q6** | `cfg` 热加载边界 | **A**：v1 只保证**模块开关**热生效；`cfg` 其余字段仍是启动快照 | H7 第 5 条 |
| **Q7** | owner 级"额外凭证"形态 | **A**：一次性 **6 位确认码**，10 分钟有效，复用 `forward-approval` 的实现 | H5-2 第 2 条 |
| **Q8** | 是否允许手改开关 JSON | **B**：只认**工具 / 控制台**写入；手改在**启动时被覆盖** | H3「手改文件」行 |
| **Q9** | locked 34 个是否过严 | **A**：**维持 locked 34 个**（A.1~A.12 运行时 48 个模块口径；内容域另计） | H2 统计表第一行 |
| **Q10** | `handle` 能否有副作用 | **A**：允许 `outbound/*` 等模块发送；**写动作由中枢授权**（经 `ctx.tools.call` / `ctx.state.write`） | B.2「副作用白名单」 |
| **Q11** | registry 与 66 个旧 flag | **B**：registry 只登记**新**工具；66 个旧 flag 按域**逐步回填** | A.6 `tools/registry` 行 |
| **Q12** | 熔断后是否恢复 | **B**：熔断 **5 分钟后半开试探一次**（成功即复位，失败继续跳过并计下次） | D 表 `guards/chain`；E.2 |

**遗留（不属于 Q1~Q12，v2 再议）**：`eco-lib` / `tts-lib` / `voice-core` / `forward` / `forward-approval` / `cross-key` / `image-path` / `save-path` / `media-cache` / `tool-turn-stats` / `qq-model-view` / `self-test` 共 12 个文件，v1.1 只约定"按 `<domain>/lib-*.js` 挂靠"，不单独成模块。

---

## 附：本文件的自检表

| 要求 | 落点 |
| --- | --- |
| 12 运行时职责域 + 2 内容域 + 状态 + 代码位置 | A.1 ~ A.14（**63 个模块**：运行时 48 + content/persona 15，每条带 `file:line` 或实际路径） |
| `spec` / `handle` / deps / 缺依赖降级 | B.1 ~ B.4 |
| ctx 字段表（含 cfg、session、log、state、now、random、tools） | C |
| 每模块 fail open/closed + 依据 | D（48 行）+ A.13/A.14 的统一口径段 |
| 目录、命名、测试、头注释模板 | E.1 ~ E.3 |
| 禁止清单（≥6 条） | F（12 条） |
| 8 个现有模块映射 + 改造量 | G（小 5 / 中 3 / 大 0） |
| toggle 定义、分级、存储、工具、三条防呆、审计、热生效 | H1 ~ H7 |
| 拿不准的不发明 | Q1 ~ Q12 已于 **v1.1 全部定稿**（✅ 结论表，每条带落地位置） |
