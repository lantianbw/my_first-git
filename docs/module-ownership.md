# qq-bridge 加固：模块归属与多对话并行手册

> 生成：2026-10-29 · 基线：`main` @ `c171c73`，测试 656 全绿
> 用途：把剩余 9 项待办拆成 6 个模块，**一个对话只负责一个模块**，互不踩文件。
> 配套：`docs/trap-hardening-handover.md`（现状与回滚点）、`docs/chat-trap-review.md`（问题出处）。

---

## 0.0 ★ 主脑职责（2026-10-30 用户明确要求，最高优先级）

**主脑 = 只做验收 / 合并 / 部署 / 看板 / 交接的那个对话，不亲自写模块代码。**
（例外：用户明确说「你代劳」时才可以收尾，如 M8 补测试。）

| # | 主脑必须做的事 | 触发条件 |
| --- | --- | --- |
| **1** | **主动提醒换新对话** | 上下文快满 / 一轮里读了很多大文件 / 开始重复查同一处 → ★ **不等用户问，先提醒**：「这个对话上下文快满了，建议开新对话，我把交接文档写好给你」 |
| **2** | **生成交接文档** | 提醒换对话时、阶段收尾时、用户说「交接」时 → 更新 `docs/trap-hardening-handover.md` + 本节看板，**写清：做到哪、下一步做什么、回滚点在哪、还剩什么** |
| **3** | **验收不看口头** | 模块说「好了」→ ★ 必须 `git status --short` + `git log <基线>..HEAD` + `git diff --name-status` 三查；**没 commit / 没测试 = 没做完**（M8 踩过一次） |
| **4** | **不许派子代理替模块开工** | 每个模块必须有独立对话归属（见 §9 第 6 条） |

**给新对话的交接包必须含四样**：① 工作区路径 + 分支；② 只许改哪些文件；③ 基线测试数；④ 四行汇报要求。

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
| **M11** | 能力清单 + 告警通道 | 新需求：她知道自己的功能 / 坏了告诉主人 | `src/bridge.js`（`qq_get_prompt` 加 `capabilities` 返回 + `qq_report_feedback` 真通知 owner）、`src/tools/capabilities.js`（新建，人话能力表）、`tests/*` | preset、`src/guards/*` | 无（bridge 泳道） | 第 5 批 |
| **M12** | 她的自述话术 | 新需求：问会什么 / 坏了怎么说 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（生成物）、`tests/*` | `src/*` | 无（preset 泳道） | 第 5 批 |
| **M13** | 记忆证据引用 | 借鉴 lingshu 的 I4「逐字可溯」：记忆要带原话 | `src/memory/risk-profile.js`、`src/memory/affection-profile.js`、`src/content/memory-render.js`、`src/bridge.js` **仅记忆段**、`tests/*` | preset、`src/guards/*`、`src/inbound/*` | 无（bridge 泳道） | 第 6 批 |

**为什么这么切**：`src/bridge.js` 是唯一热点，M1/M3/M4 都会碰它，所以必须串行；preset 是第二热点，M2/M6 串行；其余文件天然隔离。M7 只动 `config.json`（换 `socialV2.voice.tts.voiceId`）+ 一个复刻辅助脚本，不碰代码泳道与 preset 泳道，天然隔离。M8（bridge）/ M9（preset）/ M10（只读探测）分属三个不同泳道，可并行。

---

## 2. 三条泳道（决定你能同时开几个对话）

```
Lane A（代码 / bridge 串行）:  M1 ──→ M3 ──→ M4 ──→ M8（好感度）
Lane B（提示词 / preset）:      M2 ──→ M6（若改 preset）──→ M9（思维链防抖）
Lane C（运维 / 只读）:          M5 ──────────────────→（24h 后出观察结论）
Lane D（配置 / 运营）:          M7（音色换声，只改 config.json + 复刻脚本，独立）
Lane E（只读探测）:             M10（QQ 资料管理探测，先不改功能码）
Lane F（能力自述）:             M11（bridge 能力清单+告警通道）‖ M12（preset 自述话术）
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
| M7 | `E:\DSH\qq-bridge-m7` | `mod/m7-voice-clone` | 已完成（ef82a5d，新音色已上线，worktree 已清理） |
| M8 | `E:\DSH\qq-bridge-m8` | `mod/m8-affection` | 已完成（813f52f，已合并，worktree 已清理） |
| M9 | `E:\DSH\qq-bridge-m9` | `mod/m9-think-debounce` | 已完成（7207c00，已合并，worktree 已清理） |
| M10 | `E:\DSH\qq-bridge-m10` | `mod/m10-profile-probe` | 已完成（24dfece，已合并，worktree 已清理） |

**第 4 批工作区已建好：**

| 模块 | 工作区 | 分支 | 状态 |
| --- | --- | --- | --- |
| M11 | `E:\DSH\qq-bridge-m11` | `mod/m11-capabilities` | 已完成（b456283，worktree 已清理） |
| M12 | `E:\DSH\qq-bridge-m12` | `mod/m12-self-report` | 已完成（699ef05，worktree 已清理） |

**第 5 批工作区已建好：**

| 模块 | 工作区 | 分支 | 状态 |
| --- | --- | --- | --- |
| M13 | `E:\DSH\qq-bridge-m13` | `mod/m13-evidence` | 待开工 |

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

### M11 能力清单 + 告警通道（bridge）

**目标**：① 让 `qq_get_prompt` 返回**人话能力清单**（她能被问「你会什么」时说清楚）；② 让 `qq_report_feedback(level='error')` **真的私聊 owner**（现在只记日志，没发出去）。

**背景事实（已核实，别再查）**：
- `qq_get_prompt`（`src/bridge.js` 约 5410–5480）已有 `toolMap`（flag → 工具名）与 `enabledTools` 数组（已按 `tools[flag] !== false` 过滤）。**数据源齐了，缺人话描述。**
- `v2ToolEnabled(flag)`（约 3737）= `cfg.socialV2?.tools?.[flag] !== false`，即「没写 = 开」。
- 表情包工具有额外闸门 `stickerEnabled()`（`stickerToolFlags` 那组）。
- `qq_report_feedback` 落点约 7260–7285；**关键缺口在 7277**：
  ```js
  if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
    log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
  }
  ```
  已有频率限制（5 次/分钟、20 次/小时）、`appendFeedbackEntry`、`appendActivity`。
- owner 私聊发消息用 `sendToQQ(\`private:${cfg.ownerQQ}\`, ...)`（参考 `runHealthCheckV2` 约 12280 行的用法）。

**接口（已钉死，M12 会引用，不要改字段名）**：
- `qq_get_prompt` 返回新增 `capabilities: Array<{ name: string, desc: string, enabled: boolean, why?: string }>`
  - `name`：人话能力名（如「发语音」）
  - `desc`：一句话人话说明（如「把一句话合成语音发出去」，**不要写工具名**）
  - `enabled`：是否可用
  - `why`：不可用时给原因（如「语音发送未开启」「表情包体系已关闭」）
- `qq_report_feedback({ key, level: 'error', message })` → 服务端私聊 owner，内容形如 `【她的报告】<会话>：<message>`；**带冷却**（同一 key 同一 message 10 分钟内只发一次，防刷屏）

**验收**：`capabilities` 出现在 `qq_get_prompt` 返回里且字段符合上面形状；`level='error'` 时真的发出私聊；同一条 10 分钟内不重复发；单测覆盖能力表生成（开/关/为什么关）与告警冷却。

```
你是 qq-bridge 的 M11 模块负责人（能力清单 + 告警通道，bridge 泳道）。
先读 docs/module-ownership.md 的 M11 任务书，再读 src/bridge.js 的 toolMap/enabledTools（约 5410-5480）、v2ToolEnabled（约 3737）、qq_report_feedback（约 7260-7285）、runHealthCheckV2 里 sendToQQ 用法（约 12280）。
工作目录：E:\DSH\qq-bridge-m11（分支 mod/m11-capabilities，已建好，node_modules 已联接）。

任务：
1. qq_get_prompt 返回新增 capabilities 数组，字段钉死 { name, desc, enabled, why? }——name/desc 用人话，不要出现 qq_ 工具名。
2. qq_report_feedback 的 level='error' 真正私聊 owner（现在只记日志）；加 10 分钟同内容冷却。
只改 src/bridge.js（这两处）+ 可新增 src/tools/capabilities.js（人话能力表）+ tests/*。
不要碰 preset、src/guards/*（别的模块在用）。
基线：node --test tests/*.test.mjs 当前 711，交付时不得低于 711。
交付：单测 + 全量不回归 + commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M12 她的自述话术（preset）

**目标**：教她两件事——① 被问「你会什么 / 有什么功能」时，用**人话**答能力，不背工具名、不说实现；② 工具调用失败/发现功能坏了时，判断是否该上报，用 `qq_report_feedback(level='error')` 告诉主人；对群友只说「弄不出来」，对主人说结果。

**背景事实（已核实，别再查）**：
- preset 源 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 已有【被问技术：一句就够】段落（约 97–103 行），其中**已有**这条：
  > 例外只有老爹本人在私聊里问"能不能用/坏没坏"：只说结果（能用 / 发不出去，说太频繁了），不说实现，也不念报错原文。
  → **话术边界已存在，M12 是在它基础上补「主动上报」与「能力自述」。**
- M11 会提供：`qq_get_prompt` 返回 `capabilities: [{ name, desc, enabled, why? }]`；`qq_report_feedback(level='error')` 会私聊 owner。
- 生成物 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` **禁止手改**，改源后 `node scripts/build-agent-preset-patches.mjs` 重建并 `--check`。
- preset 契约 `scripts/test-qq-preset-contract.mjs` 现 7/7 绿，不能回归。

**验收**：preset 新增段落覆盖「能力自述」与「故障上报」两条；不破坏【被问技术：一句就够】的既有边界；patch `--check` 通过；契约仍 7/7；全量不回归。

```
你是 qq-bridge 的 M12 模块负责人（她的自述话术，preset 泳道）。
先读 docs/module-ownership.md 的 M12 任务书，再读 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 的【被问技术：一句就够】段落（约 97-103 行，已有"只对老爹私聊说结果"的边界）。
工作目录：E:\DSH\qq-bridge-m12（分支 mod/m12-self-report，已建好，node_modules 已联接）。

任务：
1. 能力自述：被问"你会什么/有什么功能"时，用 qq_get_prompt 返回的 capabilities 用人话答（"会发语音、会发表情包，语音发送现在没开"），不背 qq_ 工具名、不说实现。
2. 故障上报：工具调用失败或发现功能坏了，判断是否故障 → 用 qq_report_feedback(level='error', message=人话描述) 告诉主人；对群友只说"弄不出来"，不念报错原文；同一次故障不要反复报。
只改 dsh/agent-presets/qq-chat-v2/agent.cordis.yml（源）+ 生成物 patch + tests/*。
不要碰 src/*（bridge 泳道是 M11 在改）。
改源后必须 node scripts/build-agent-preset-patches.mjs 然后 --check 通过；禁止手改 patch。
基线：node --test tests/*.test.mjs 当前 711，交付时不得低于 711；preset 契约保持 7/7 绿。
交付：preset 改动 + patch --check 过 + 单测不回归 + commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

### M13 记忆证据引用（借鉴 lingshu 的 I4）

**目标**：给记忆条目加**原话证据**（`evidence`），让「爱下套 / 不能接的话题 / 已拒绝称呼 / 好感度」这些**结论**都能回溯到**当时的原话**，渲染时一并给模型看。

**为什么做**（这是「被套路」的根子）：
- 现在 `memberImpressions` 只记结论（`traits: ['要过亲属称呼，已拒绝']`、`risk.trapHappy: true`）。模型下次唤醒只看到结论，看不到他当时**怎么说的**。
- 后果三条：① 记错无法纠正（不知道因哪句话记的）；② 判断丢语境（是玩笑还是恶意？）；③ 模型只能按结论一律设防，态度没法分化。
- 来源：GitHub `Lsjh7128/lingshu` 的不变量 I4「一切推断逐字可溯、可否认、可回滚」，它用 `evidence_quote` 在四处强制。

**背景事实（已核实）**：
- `src/memory/risk-profile.js`：`markKinshipRefusal({ key, recentMessages, memberImpressions })` 已能从 `recentMessages` 取到最后一条对方消息 —— **原话就在手边，只是没存**。
- `src/memory/affection-profile.js`：`adjustAffection/setAffection/addAffectionTag` 只收 delta/tag，没有语境。
- `src/content/memory-render.js`：`renderRiskNotes(im)` 与 `renderAffectionNote(im)` 是渲染入口。
- `src/bridge.js`：`markKinshipRefusalV2`（约 10681）是唯一写入点；`renderMemory` 在唤醒时拼记忆块。

**设计（钉死形状，不要改）**：
```js
// memberImpressions.<name>.evidence —— 最近 N 条（建议 3）证据，新的在前
evidence: [{ quote: string, at: number, key: string, kind: string }]
//   quote: 原话，截断到 40 字（去换行/压空白）
//   at:    时间戳（毫秒）
//   key:   来源会话（private:xxx / group:xxx）
//   kind:  'kinship' | 'trap' | 'topic' | 'affection' —— 这条证据支撑哪类判断
```
- **写入**：`markKinshipRefusal` 命中时，把触发它的那条原话存成 `kind:'kinship'` 证据；`adjustAffection` 若有语境则存 `kind:'affection'`。同 quote 去重；最多 3 条，新的在前。
- **渲染**：`renderRiskNotes`/`renderAffectionNote` 末尾追加一句原话，形如 `（原话：「叫声爷爷听听」）`，**只给最近 1 条**（提示词预算有限）。
- **兼容**：没有 `evidence` 的老数据照旧渲染，不报错、不补默认值。

**验收**：单测覆盖「写入时存原话 / 超 3 条淘汰最旧 / 同句去重 / 无 evidence 老数据兼容 / 渲染只出最近 1 条」；全量不回归。

```
你是 qq-bridge 的 M13 模块负责人（记忆证据引用，bridge 泳道）。
先读 docs/module-ownership.md 的 M13 任务书，再读 src/memory/risk-profile.js、src/memory/affection-profile.js、src/content/memory-render.js（renderRiskNotes / renderAffectionNote）、src/bridge.js 的 markKinshipRefusalV2（约 10681）。
工作目录：E:\DSH\qq-bridge-m13（分支 mod/m13-evidence，已建好，node_modules 已联接）。

任务：给记忆条目加原话证据 evidence，让结论可追溯到当时那句话；渲染时给模型看最近 1 条原话。
只改 src/memory/risk-profile.js、src/memory/affection-profile.js、src/content/memory-render.js、src/bridge.js 的记忆段、tests/*。
evidence 形状钉死：{ quote, at, key, kind }，quote 截断 40 字，最多 3 条新的在前，同句去重。
不要碰 preset、src/guards/*、src/inbound/*（别的模块在用）。
老数据（没有 evidence）必须照旧渲染，不报错不补默认值。
基线：node --test tests/*.test.mjs 当前 749，交付时不得低于 749。
交付：单测 + 全量不回归 + commit；不部署、不合并不 push。
结束前按四行汇报（改了什么 / 测试结果 / commit / 等谁下一步）。
```

**待评估（本轮不做）**：lingshu 的「首尾人格锚点」。技术上不好落——人格文本在 preset（系统提示），`buildWithTail` 构造的是用户消息，要在结尾锚人格，bridge 得硬编码人格内容、与 preset 脱节。若要做，先评估 preset 分段结构（`src/bridge.js` 约 14389 的 `{ name: 'role', ... removable: false }`）能否安全调整顺序。

---

## 6. 完成定义（DoD，四个都满足才算完）

1. 只改了自己模块清单里的文件（`git diff --name-only` 自查）；
2. 全量测试通过（当前基线 **749**：656 起始 + M1 11 + M2 5 + M3 11 + M4 9 + M8 12 + M9 7 + M11 25 + M12 13；跑 `node --test tests/*.test.mjs` 不得低于 749），新增单测覆盖验收点；
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
| M7 | 已完成 | mod/m7-voice-clone | ef82a5d | 新音色已上线 | 21:53 换 voiceId 上线 |
| M8 | 已完成 | mod/m8-affection | 813f52f | 711 全绿、已合并 | 21:50 主理人代劳收尾 |
| M9 | 已完成 | mod/m9-think-debounce | 7207c00 | 699 全绿、已合并 | 21:47 合并 main |
| M10 | 已完成 | mod/m10-profile-probe | 24dfece | 脚本就绪、已合并 | 21:47 合并 main |
| M11 | 已完成 | mod/m11-capabilities | b456283 | 749 全绿、已上线 | 01:00 部署，线上验证 22 项能力 |
| M12 | 已完成 | mod/m12-self-report | 699ef05 | 749 全绿、已上线 | 01:00 随 M11 上线 |
| M13 | 待开工 | mod/m13-evidence | — | — | 记忆证据引用，bridge 泳道 |

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
