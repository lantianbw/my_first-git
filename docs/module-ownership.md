# qq-bridge 加固：模块归属与多对话并行手册

> 生成：2026-10-29 · 基线：`main` @ `c171c73`，测试 656 全绿
> 用途：把剩余 9 项待办拆成 6 个模块，**一个对话只负责一个模块**，互不踩文件。
> 配套：`docs/trap-hardening-handover.md`（现状与回滚点）、`docs/chat-trap-review.md`（问题出处）。

---

## 0. 一句话结论

剩余工作拆成 **6 个模块、3 条泳道**，第 1 批可以同时开 3 个对话（M1 / M2 / M5）。
铁律只有三条：**同一文件同一时间只有一个对话改；模块对话不部署；部署只有一个出口。**

---

## 1. 模块总表

| ID | 模块 | 覆盖待办 | 负责文件（只能改这些） | 绝对不能碰 | 依赖 | 批次 |
| --- | --- | --- | --- | --- | --- | --- |
| **M1** | 入站文件安全 | §6-2 可疑文件 | `src/inbound/file-risk.js`（新建）、`tests/inbound-file-risk.test.mjs`（新建）、`src/bridge.js` **仅群入站分支一处调用** | `src/guards/*`、preset、`src/content/*` | 无 | 第 1 批 |
| **M2** | 提示词硬边界 | §6-3 技术探询、§6-8 R2~R5 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（生成物）、`tests/preset-trap-rules.test.mjs` | `src/bridge.js`、`src/guards/*` | 无 | 第 1 批 |
| **M3** | 记忆与边界档案 | §6-5 风险档案、§6-9 称呼单测 | `src/memory/*.js`（新建，放纯函数）、`src/content/memory-render.js`、`src/bridge.js` **仅记忆段**、`tests/*` | preset、`src/guards/*` | M1（共用 bridge 锁） | 第 2 批 |
| **M4** | 点名与调度 | §6-6 点名判断 | `src/bridge.js` **仅 `evaluateWakeTriggerV2` 一带**、`tests/*`；如需改话术才动 preset | 出站守卫、记忆段 | M2 + M3 | 第 3 批 |
| **M5** | 运维与审计 | §6-4 24h 观察、§6-7 审计指标 | `scripts/ops-daily-check.sh`、`docs/trap-hardening-handover.md`（只追加观察记录） | `src/*`、preset | 无 | 全程并行 |
| **M6** | 存量清理 | §6-10 preset 契约红 | `scripts/test-qq-preset-contract.mjs`；若最终决定改 preset，则并入 M2 之后 | `src/bridge.js` | M2（若改 preset） | 第 2 批 |
| **M7** | 音色复刻换声 | 新需求：TTS 声音太人机 | `config.json`（本地 .gitignore，不进 git）、可新增 `scripts/clone-voice.mjs`（复刻辅助脚本） | `src/*`、preset、`plugins/*` | 无（独立泳道） | 独立 |
| **M8** | 好感度系统 | 功能愿望清单 §1 | `src/memory/*.js`（扩字段）、`src/content/memory-render.js`、`src/bridge.js` **仅记忆段**、`tests/*` | preset、`src/guards/*`、`src/inbound/*` | 无（bridge 泳道，与其它 bridge 模块串行） | 第 4 批 |
| **M9** | 思维链防抖 | 功能愿望清单 §2 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（生成物）、`tests/*` | `src/*` | 无（preset 泳道） | 第 4 批 |
| **M10** | QQ 资料管理探测 | 功能愿望清单 §3 | 只读探测 SnowLuma 是否支持改资料（可新增 `scripts/probe-*.mjs`）；**先不改任何功能代码** | `src/*`、preset | 无（只读） | 第 4 批 |

**为什么这么切**：`src/bridge.js` 是唯一热点，M1/M3/M4 都会碰它，所以必须串行；preset 是第二热点，M2/M6 串行；其余文件天然隔离。M7 只动 `config.json`（换 `socialV2.voice.tts.voiceId`）+ 一个复刻辅助脚本，不碰代码泳道与 preset 泳道，天然隔离。M8（bridge）/ M9（preset）/ M10（只读探测）分属三个不同泳道，可并行。

---

## 2. 三条泳道（决定你能同时开几个对话）

```
Lane A（代码 / bridge 串行）:  M1 ──→ M3 ──→ M4 ──→ M8（好感度）
Lane B（提示词 / preset）:      M2 ──→ M6（若改 preset）──→ M9（思维链防抖）
Lane C（运维 / 只读）:          M5 ──────────────────→（24h 后出观察结论）
Lane D（配置 / 运营）:          M7（音色换声，只改 config.json + 复刻脚本，独立）
Lane E（只读探测）:             M10（QQ 资料管理探测，先不改功能码）
```

- **第 1 批（可同时开 3 个对话）**：M1 + M2 + M5
- **第 2 批**：M1 完成后开 M3；M2 完成后开 M6
- **第 3 批**：M3 + M2 都完成后开 M4

> 想让“每个对话一个模块”真正成立，**最多同时 3 个**。开第 4 个只会制造文件冲突。

---

## 3. 三把锁（照着做，不用临场判断）

### 3.1 bridge 锁（M1 / M3 / M4）

同一时间只允许一个对话改 `src/bridge.js`。开工前在本文件 §7 状态表把模块标成「进行中」；发现已有别的模块在改 bridge → **不要开工**，先做只读分析，等对方标「完成」。

### 3.2 preset 锁（M2 / M6）

同一时间只允许一个对话改 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`。
改完必须：`node scripts/build-agent-preset-patches.mjs` → `--check` 通过 → 才算完成。
**不要手改 patch 文件**，它是生成物。

### 3.3 部署锁（全局唯一出口）

**模块对话一律不部署。** 部署只发生在「合并到 main 之后」，由主理人对话或你指定的发布对话执行。
部署前在服务器抢原子锁，避免两个对话同时重启：

```bash
# 抢锁（成功=拿到；失败=别人在部署，等 5 分钟再试）
ssh root@175.178.200.118 "mkdir /opt/qq-bridge/.deploy-lock"

# 部署（在 main worktree 里执行）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1

# 放锁（无论成功失败都要放）
ssh root@175.178.200.118 "rmdir /opt/qq-bridge/.deploy-lock"
```

锁目录超过 30 分钟还在 → 先确认没有部署进程，再手工 `rmdir`。

---

## 4. Git 策略（二选一，先定这个）

### 方案 A（推荐，可并行）：每个模块一个 worktree + 分支

```bash
# 在 E:/DSH/qq-bridge 执行一次
git worktree add ../qq-bridge-m1 -b mod/m1-inbound-files
git worktree add ../qq-bridge-m2 -b mod/m2-preset-boundaries
# 每个对话 cd 到自己的 worktree 工作
```

- 优点：三个对话互不干扰，不会互相切分支、不会把对方的未提交改动带走。
- 规则：**模块对话只提交到自己分支，不合并、不部署**；完成后报告 commit hash。
- 发布：主理人按 M1 → M3 → M4 / M2 → M6 的顺序合并到 `main`，在 main worktree 跑全量测试，再走部署锁。

**第 1 批工作区已建好（2026-10-29）：**

| 模块 | 工作区 | 分支 | 状态 |
| --- | --- | --- | --- |
| M1 | `E:\DSH\qq-bridge-m1` | `mod/m1-inbound-files` | 已完成（ab6542a） |
| M2 | `E:\DSH\qq-bridge-m2` | `mod/m2-preset-boundaries` | 已完成（a2573b3） |
| M5 | `E:\DSH\qq-bridge-m5` | `mod/m5-ops-metrics` | 已完成（841b51c） |
| M6 | `E:\DSH\qq-bridge-m6` | `mod/m6-preset-contract` | 已完成（b0b1b76） |

**第 2 批工作区已建好：**

| 模块 | 工作区 | 分支 | 状态 |
| --- | --- | --- | --- |
| M3 | `E:\DSH\qq-bridge-m3` | `mod/m3-memory-risk` | 已完成（635154b，已合并） |
| M4 | `E:\DSH\qq-bridge-m4` | `mod/m4-mention-gate` | 已完成（e148c5d，已合并） |

**第 3 批工作区已建好：**

| 模块 | 工作区 | 分支 | 状态 |
| --- | --- | --- | --- |
| M7 | `E:\DSH\qq-bridge-m7` | `mod/m7-voice-clone` | 待开工 |
| M8 | `E:\DSH\qq-bridge-m8` | `mod/m8-affection` | 待开工 |
| M9 | `E:\DSH\qq-bridge-m9` | `mod/m9-think-debounce` | 待开工 |
| M10 | `E:\DSH\qq-bridge-m10` | `mod/m10-profile-probe` | 待开工 |

所有工作区的 `node_modules` 已用目录联接指向主干仓库，可直接跑测试/构建。

### 方案 B（最简，只能串行）：同一个目录，一个一个做

- 一个模块做完、测试全绿、提交、部署、更新交接文档，再开下一个对话。
- 优点：零额外设置；缺点：不能并行，且中途换人容易带未提交改动。

---

## 5. 模块任务书 + 启动提示（直接粘贴到新对话）

### M1 入站文件安全

**目标**：群里出现「资源合集 / 下载 / 解压密码 / 打开即可 / 网盘」类文件名时，**不触发唤醒、不接话**，记一条 `[guard] suspicious-file`。
**验收**：10-29 15:22 那条 `PC电脑资源大合集打开即可下载 .txt` 作为回归样本，不再触发回复；普通图片/文档不受影响；新增单测 ≥4 条。

```
你是 qq-bridge 的 M1 模块负责人（入站文件安全）。
先读 E:\DSH\qq-bridge\docs\trap-hardening-handover.md 第 6 节第 2 项，再读 docs/module-ownership.md 的 M1 任务书。
工作目录：E:\DSH\qq-bridge-m1（分支 mod/m1-inbound-files）。

只改这些文件：新建 src/inbound/file-risk.js（纯函数）+ tests/inbound-file-risk.test.mjs，src/bridge.js 只加一处调用。
不要碰 src/guards/*、preset、src/content/*（那些是别的模块的）。
交付：单测通过 + 全量 656 不回归 + commit；不部署、不合并。
结束前按四行汇报：改了什么 / 测试结果 / commit / 等谁。
```

### M2 提示词硬边界

**目标**：
1. 技术探询统一话术（「这些我不聊，换个话题」，被追问不解释）；
2. R2 数字/时间/次数降级（数量→几个、六点二十→六点多、第三次→又）；
3. R3 金句连发软约束（90 秒内第二条金句降级）；
4. R4 三连问限制（一次只问一个）；
5. R5 借嘴禁令扩到「别人的比喻/金句/答案」。

**验收**：`build-agent-preset-patches.mjs --check` 通过；`tests/preset-trap-rules.test.mjs` 覆盖新增规则；新会话系统提示含这些条目。

```
你是 qq-bridge 的 M2 模块负责人（提示词硬边界）。
先读 E:\DSH\qq-bridge\docs\chat-trap-review.md §12.5（R2~R5），再读 docs/module-ownership.md 的 M2 任务书。
工作目录：E:\DSH\qq-bridge-m2（分支 mod/m2-preset-boundaries）。

只改 preset 源文件 dsh/agent-presets/qq-chat-v2/agent.cordis.yml，然后重新生成 plugins/.../qq-chat-v2.patch.yml。
不要碰 src/ 下任何文件（那是别的模块的）。
交付：patch 重建 + --check 通过 + preset 测试通过 + commit；不部署、不合并、不重启 dsh-web。
结束前按四行汇报。
```

### M3 记忆与边界档案

**目标**：`memberImpressions` 增加风险档案（`noKinshipTitle` 的雏形扩成「爱下套 / 不能接的话题 / 已拒绝的称呼」）；把 `markKinshipRefusalV2` 抽成纯函数并补单测（私聊记、群聊不记、重复不叠加）。

**验收**：唤醒提示里能看到边界；单测覆盖三种场景；`renderMemory` 的 10 条上限有说明。

```
你是 qq-bridge 的 M3 模块负责人（记忆与边界档案）。
先读 docs/trap-hardening-handover.md 第 6 节第 5、9 项，再读 docs/module-ownership.md 的 M3 任务书。
工作目录：E:\DSH\qq-bridge-m3（分支 mod/m3-memory-risk，已 fast-forward 到最新 main，含 M1/M2/M5/M6）。

只改 src/memory/*（新建纯函数）、src/content/memory-render.js、src/bridge.js 的记忆段。
不要碰 src/guards/*、preset、src/inbound/*（别的模块在用）。
基线：node --test tests/*.test.mjs 当前 672，交付时不得低于 672。
交付：单测 + 全量不回归 + commit；不部署、不合并不 push（合并与部署由主理人对话做）。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M4 点名与调度

**目标**：`@` 只保证「会看」，不保证「一定接」；同一人连续点名 3 次以上时，允许只回一句或不回。

**验收**：`evaluateWakeTriggerV2` 的单测覆盖「连续点名」；线上观察不出现「点名即入场」。

```
你是 qq-bridge 的 M4 模块负责人（点名与调度）。
先读 docs/module-ownership.md 的 M4 任务书；前置 M2 已完成、M3 必须已合并到 main（看 §7 状态表）。
**开工前先确认 M3 状态为「已完成」，否则不要动手。**
工作目录：E:\DSH\qq-bridge-m4（分支 mod/m4-mention-gate）。开工前先 `git merge --ff-only origin/qq-bridge` 拉到最新主干。

只改 src/bridge.js 的 evaluateWakeTriggerV2 一带 + tests；如需话术才动 preset（改 preset 必须改 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 源，再用 scripts/build-agent-preset-patches.mjs 重建 patch 并 --check，禁止手改 patch）。
不要碰出站守卫、记忆段、src/inbound/*。
基线：node --test tests/*.test.mjs 当前 672，交付时不得低于 672。
交付：单测 + 全量不回归 + commit；不部署、不合并不 push（合并与部署由主理人对话做）。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M5 运维与审计

**目标**：每日巡检报告新增三行指标（entity-blocked / kinship-blocked / preset-echo 次数、称呼复发、群发言占比）；完成 24h 观察记录。

**验收**：`scripts/ops-daily-check.sh` 跑一次能看到三行；`docs/trap-hardening-handover.md` 追加 24h 观察结论。

```
你是 qq-bridge 的 M5 模块负责人（运维与审计）。
先读 docs/trap-hardening-handover.md 第 5.1、5.4 节，再读 docs/module-ownership.md 的 M5 任务书。
工作目录：E:\DSH\qq-bridge-m5（分支 mod/m5-ops-metrics）。

只改 scripts/ops-daily-check.sh 和 docs/trap-hardening-handover.md 的观察记录。
不要碰 src/ 和 preset。
交付：脚本改动 + 一次只读运行结果 + commit；不部署、不重启服务。
结束前按四行汇报。
```

### M6 存量清理

**目标**：修 `scripts/test-qq-preset-contract.mjs` 的 `missing rule: qq_memory_clear`。先判断是「测试过期」还是「人格真该写这条」——拿不准就只改测试并注明理由。

**验收**：脚本转绿；不引入新规则冲突。

```
你是 qq-bridge 的 M6 模块负责人（存量清理）。
先读 docs/module-ownership.md 的 M6 任务书；确认 M2 已完成（preset 锁）。
工作目录：E:\DSH\qq-bridge-m6（分支 mod/m6-preset-contract）。

只改 scripts/test-qq-preset-contract.mjs；若必须改 preset，先停下来说明理由，等主理人确认。
交付：脚本转绿 + commit；不部署。
结束前按四行汇报。
```

### M7 音色复刻换声

**目标**：把 TTS 现在「太人机」的音色，换成一段真人声音克隆出来的音色。只改 `config.json` 的 `socialV2.voice.tts.voiceId`（本地 .gitignore 文件，不进 git），可选新增一个复刻辅助脚本 `scripts/clone-voice.mjs`。**零代码改动**（不碰 `src/*`、preset、`plugins/*`）。

**背景事实（已核实，别再查）**：
- 当前音色 `cosyvoice-v3.5-plus-xluma-722f1767a5d348869159ac284cce7986`（model `cosyvoice-v3.5-plus`）本身已是「复刻音色」，链路跑通过。
- 百炼 API key 已就绪：`~/.dsh/.credentials.yaml` 的 `refs.BAILIAN_API_KEY`（`src/tts-lib.js` 的 `readBailianApiKey` 能读到）。
- 音色复刻（voice cloning）阿里云**免费**、个人可用，用 10~20 秒人声样本，无需训练。
- 复刻接口：`voice-enrollment` + `action=create_voice`，参考音频走 `audio` 字段（URL 或 base64），返回 `voice_id`。
- **唯一需现场验证的点**：`src/tts-lib.js` 第 14 行注释写「复刻必须走 dashscope 老域名」，但当前 TTS 合成用的是 workspace 专属域名 `ws-rk8hg92mj2eun18t.cn-beijing.maas.aliyuncs.com`。复刻到底走哪个域名，需实测（先试 workspace 域名，不行再试 `dashscope.aliyuncs.com/api/v1`）。

**样本要求（阿里云官方）**：10~20 秒清晰人声朗读（**不能用唱歌录音**）、WAV/MP3/M4A、≥16kHz、≤10MB、无背景音乐/他人声音、≥5 秒连续说话。

**验收**：复刻出一个新 `voice_id`；把 `config.json` 的 `voiceId` 换成它；跑一次 `qq_speak` 试听（或 `tools/tts-batch.mjs --text "..."`）确认新音色生效且自然度改善。

```
你是 qq-bridge 的 M7 模块负责人（音色复刻换声）。
先读 docs/guides/VOICE.md 的 §3.5，再读 src/tts-lib.js 的头部注释与 readBailianApiKey。
工作目录：E:\DSH\qq-bridge-m7（分支 mod/m7-voice-clone，已建好，node_modules 已联接）。

任务：把 TTS 当前「太人机」的音色换成一段真人声音克隆的音色。
只改 config.json 的 socialV2.voice.tts.voiceId（本地文件，不进 git）；
可选新增 scripts/clone-voice.mjs 复刻辅助脚本。
不要碰 src/*、preset、plugins/*（零代码改动）。
关键事实：百炼 key 已在 ~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY；
当前 voiceId=cosyvoice-v3.5-plus-xluma-722f1767a5d348869159ac284cce7986；
复刻接口 voice-enrollment + action=create_voice，需现场验证走 workspace 域名还是 dashscope 老域名。
样本要求：10~20 秒清晰人声朗读（不能用唱歌录音），WAV/MP3/M4A，≥16kHz，≤10MB。
交付：新 voice_id + config.json 换好 + 一次试听确认 + 四行汇报；
不部署、不合并不 push（换音色是本地 config，不进 git；若要提交 clone-voice.mjs 脚本则 commit 到分支）。
结束前按四行汇报（改了什么 / 试听结果 / 新 voice_id / 等谁下一步）。
```

**注意**：M7 改的是 `config.json`（.gitignore 本机文件）——这个文件**不进 git**，所以「交付」不是靠 commit config，而是靠「新 voice_id + 试听截图/结果」证明换成功。若写了 `scripts/clone-voice.mjs`，那才需要 commit 到分支供主理人合并。

### M8 好感度系统

**目标**：给 `memberImpressions` 增加「好感度 / 关系温度」字段（正向关系），与 M3 的「风险档案」（负面边界）互补；在唤醒记忆块渲染好感度，让机器人对不同人态度分化。只改 `src/memory/*`、`src/content/memory-render.js`、`src/bridge.js` 的记忆段、`tests/*`。

**背景事实（已核实）**：
- 现有 `src/memory/risk-profile.js`（M3 产出）已有 `memberImpressions.<name>.risk = { trapHappy, noGoTopics, refusedTitles }` 结构，M8 是**并行新增一个 `affection` 字段**，不是改 risk。
- 现有 `relations.js` / `mood.js` / `memory-render.js`（`renderMemory` / `renderRiskNotes`）可参考。
- 记忆三件套：日程 / 画像 / 主观认知（`src/bridge.js` 第 276 行注释）。

**验收**：`memberImpressions` 支持好感度（如 `affection` 或 `affinity` 数值 + 可选标签）；`renderMemory` 印象行渲染好感度；单测覆盖「好感度增减、上限、不越界」；全量不回归。

```
你是 qq-bridge 的 M8 模块负责人（好感度系统）。
先读 docs/feature-wishlist.md 的 §1、docs/trap-hardening-handover.md 第 6 节第 5 项，再读 src/memory/risk-profile.js（M3 同族结构）。
工作目录：E:\DSH\qq-bridge-m8（分支 mod/m8-affection，已建好，node_modules 已联接）。

任务：给 memberImpressions 增加「好感度 / 关系温度」，与 M3 的 risk（负面边界）互补，让机器人对不同人态度分化。
只改 src/memory/*（新建纯函数）、src/content/memory-render.js、src/bridge.js 的记忆段、tests/*。
不要碰 preset、src/guards/*、src/inbound/*（别的模块在用）。
基线：node --test tests/*.test.mjs 当前 692，交付时不得低于 692。
交付：单测 + 全量不回归 + commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M9 思维链防抖（preset 层）

**目标**：在 preset 人格里加「逐条思考再回复」的节奏约束，降低 AI 味（拟人化「读消息→思考→回复」）。只改 preset 源 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` + 生成物 patch + 相关测试。

**背景事实（已核实）**：
- preset 源在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，生成物是 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（**禁止手改生成物**）。
- 改源后必须 `node scripts/build-agent-preset-patches.mjs` → `--check` 通过。
- 现有 `anti-ai-patterns.js`、长度软干预、唤醒前「行动前判断」提示词是「反 AI 味」的现有抓手，M9 是在 preset 层补「逐条思考」节奏。
- 契约测试 `scripts/test-qq-preset-contract.mjs`（M6 修复后 7/7 绿）不能回归。

**验收**：preset 加了「逐条思考再回复」的节奏约束；`build-agent-preset-patches.mjs --check` 通过；preset 契约测试不回归；全量不回归。

```
你是 qq-bridge 的 M9 模块负责人（思维链防抖，preset 层）。
先读 docs/feature-wishlist.md 的 §2、docs/module-ownership.md 的 M9 任务书，再读 docs/guides/VOICE.md 无关可跳过。
工作目录：E:\DSH\qq-bridge-m9（分支 mod/m9-think-debounce，已建好，node_modules 已联接）。

任务：在 preset 人格里加「逐条思考再回复」的节奏约束，拟人化、降 AI 味。
只改 dsh/agent-presets/qq-chat-v2/agent.cordis.yml（源）+ 生成物 patch + tests/*。
不要碰 src/*（bridge 代码泳道是别的模块在改）。
改源后必须 node scripts/build-agent-preset-patches.mjs 然后 --check 通过；禁止手改 patch。
基线：node --test tests/*.test.mjs 当前 692，交付时不得低于 692；preset 契约 scripts/test-qq-preset-contract.mjs 保持 7/7 绿。
交付：preset 改动 + patch --check 过 + 单测不回归 + commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M10 QQ 资料管理探测（只读）

**目标**：探测底层网关（SnowLuma / OneBot）**是否支持「改自己 QQ 全局头像/昵称/签名/状态」**。**只探测、不改任何功能代码**。探测清楚后回报结论，由主理人决定是否立项做真正的「资料管理」模块。

**背景事实（已核实）**：
- 当前桥接只封装了 `set_group_card`（改群名片），**没有** `set_qq_profile` / `set_self_profile` 之类「改自己全局资料」的接口。
- `oneBotHttp(action, params)`（`src/bridge.js` 约 1825 行）是桥接调网关的统一入口，可用来探测。
- 项目有探针脚本传统（`scripts/probe-*.mjs`，见 `docs/FOLDER_MAP.md`）：问 SnowLuma「实际支持什么」。
- SnowLuma 是第三方网关，能力以它实际支持为准；OneBot v11 标准有 `set_qq_profile`（QQ 官方接口）、`set_group_card` 等，但 SnowLuma 是否实现需实测。

**验收**：一份结论——「SnowLuma 是否支持改 QQ 全局资料；支持哪些字段（头像/昵称/签名/状态）；若不支持，是否有替代路径」。可提交一个 `scripts/probe-qq-profile.mjs`（只读探测脚本）。

```
你是 qq-bridge 的 M10 模块负责人（QQ 资料管理探测，只读）。
先读 docs/feature-wishlist.md 的 §3、docs/FOLDER_MAP.md 的 probe 说明，再读 src/bridge.js 的 oneBotHttp（约 1825 行）与 set_group_card 封装（约 8606 行）。
工作目录：E:\DSH\qq-bridge-m10（分支 mod/m10-profile-probe，已建好，node_modules 已联接）。

任务：只读探测 SnowLuma/OneBot 是否支持「改自己 QQ 全局头像/昵称/签名/状态」。
只允许新增 scripts/probe-qq-profile.mjs（只读探测脚本）；不改任何 src/*、preset 功能代码。
探测方法：用 oneBotHttp 或直连 SnowLuma 试调 set_qq_profile / set_self_profile / get_login_info / get_status 等，观察返回（只探测「支不支持」，不要真的改资料）。
交付：一份结论（支持哪些字段 / 不支持则有无替代路径）+ 可选探测脚本 commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 探测结论 / commit / 等谁下一步）。
```

---

## 6. 完成定义（DoD，四个都满足才算完）

1. 只改了自己模块清单里的文件（`git diff --name-only` 自查）；
2. 全量测试通过（当前基线 **692**：656 起始 + M1 11 + M2 5 + M3 11 + M4 9；跑 `node --test tests/*.test.mjs` 不得低于 692），新增单测覆盖验收点；
3. 已提交到自己的分支，报告 commit hash；
4. 没有部署、没有合并、没有重启线上服务。

---

## 7. 状态看板（开工/收工都来改这一行）

| 模块 | 状态 | 分支 | commit | 验收 | 备注 |
| --- | --- | --- | --- | --- | --- |
| M1 | 已完成 | mod/m1-inbound-files | ab6542a | 线上判定已验 | 17:23 上线 |
| M2 | 已完成 | mod/m2-preset-boundaries | a2573b3 | patch --check 过 | 17:24 上线 |
| M3 | 已完成 | mod/m3-memory-risk | 635154b | 683 全绿、已合并 | 18:38 合并 main |
| M4 | 已完成 | mod/m4-mention-gate | e148c5d | 692 全绿、已合并 | 18:59 随 M3 上线 |
| M5 | 已完成 | mod/m5-ops-metrics | 841b51c | 三行指标已出 | 24h 观察待补 |
| M6 | 已完成 | mod/m6-preset-contract | b0b1b76 | 契约 7/7 转绿 | 已合并 main，无需部署 |
| M7 | 待开工 | mod/m7-voice-clone | — | — | 音色换声，独立泳道 |
| M8 | 待开工 | mod/m8-affection | — | — | 好感度，bridge 泳道 |
| M9 | 待开工 | mod/m9-think-debounce | — | — | 思维链防抖，preset 泳道 |
| M10 | 待开工 | mod/m10-profile-probe | — | — | 资料探测，只读 |

状态只允许四种：`待开工` / `进行中` / `待合并` / `已完成`。改状态时顺手写时间。

---

## 8. 每个对话结束必须给的四行

```
改了什么：
测试结果：
commit：
等谁 / 下一步：
```

少于这四行 = 这个模块没交付。

---

## 9. 不要做的事

1. **不要两个对话同时改 `src/bridge.js`**（M1/M3/M4 必须排队）。
2. **不要从模块分支直接 deploy**（会把别人未合并的改动一起传上去）。
3. **不要顺手改别人模块的文件**（哪怕只是格式化）。
4. **不要在 M2/M6 里动 `src/`，也不要在 M1/M3/M4 里动 preset**。
5. **不要手改 `plugins/.../qq-chat-v2.patch.yml`**（生成物，改源再 build）。
6. **不要在主理人对话里派子代理替模块开工**：每个模块必须由独立对话负责；子代理没有对话归属，还会绕过 bridge/preset 两把锁（2026-10-29 已踩过一次，M6 保留成果、M3 回退重来）。
