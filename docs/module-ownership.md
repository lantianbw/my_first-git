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

**为什么这么切**：`src/bridge.js` 是唯一热点，M1/M3/M4 都会碰它，所以必须串行；preset 是第二热点，M2/M6 串行；其余文件天然隔离。

---

## 2. 三条泳道（决定你能同时开几个对话）

```
Lane A（代码 / bridge 串行）:  M1 ──→ M3 ──→ M4
Lane B（提示词 / preset）:      M2 ──→ M6（若改 preset）
Lane C（运维 / 只读）:          M5 ──────────────────→（24h 后出观察结论）
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
| M3 | `E:\DSH\qq-bridge-m3` | `mod/m3-memory-risk` | 待开工 |
| M4 | `E:\DSH\qq-bridge-m4` | `mod/m4-mention-gate` | 阻塞（等 M3） |

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

---

## 6. 完成定义（DoD，四个都满足才算完）

1. 只改了自己模块清单里的文件（`git diff --name-only` 自查）；
2. 全量测试通过（当前基线 **672**：656 起始 + M1 11 + M2 5；跑 `node --test tests/*.test.mjs` 不得低于 672），新增单测覆盖验收点；
3. 已提交到自己的分支，报告 commit hash；
4. 没有部署、没有合并、没有重启线上服务。

---

## 7. 状态看板（开工/收工都来改这一行）

| 模块 | 状态 | 分支 | commit | 验收 | 备注 |
| --- | --- | --- | --- | --- | --- |
| M1 | 已完成 | mod/m1-inbound-files | ab6542a | 线上判定已验 | 17:23 上线 |
| M2 | 已完成 | mod/m2-preset-boundaries | a2573b3 | patch --check 过 | 17:24 上线 |
| M3 | 已完成 | mod/m3-memory-risk | 635154b | 683 全绿、已合并 | 18:38 合并 main |
| M4 | 待开工 | mod/m4-mention-gate | — | — | 已解阻（M3 已合并） |
| M5 | 已完成 | mod/m5-ops-metrics | 841b51c | 三行指标已出 | 24h 观察待补 |
| M6 | 已完成 | mod/m6-preset-contract | b0b1b76 | 契约 7/7 转绿 | 已合并 main，无需部署 |

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
