# 「被套路」加固交接（2026-10-29）

> 面向：接手运维、继续加固的人。
> 先读 `docs/handover.md`（环境、部署、日常操作），再看本文（本轮改了什么、怎么验、还剩什么）。
> 问题背景与方案出处：`docs/chat-trap-review.md`（§1~§11 复盘，§12 AI 味体检）。
> 本文不含任何令牌；远端仍是 SSH 密钥登录。

---

## 0. 启动提示（新对话可直接粘贴）

```
读 E:\DSH\qq-bridge\docs\trap-hardening-handover.md，按第 6 节待办继续。
先用三句话复述：本轮改了什么、线上回滚点在哪、还剩哪几项没做，然后再动手。
只加硬约束，不要重写人格风格；不要引入每条消息额外的模型调用。
```
> 多对话并行、一个对话负责一个模块时，先读 `docs/module-ownership.md` 认领模块；不要在未认领的情况下直接改 `src/bridge.js`。

---

## 1. 一页纸结论

| 项 | 状态 |
| --- | --- |
| E1 复述敏感人物名 | ✅ 出站硬拦，已上线 |
| E2 亲属称呼施压 | ✅ 出站硬拦 + 记忆边界，已上线 |
| 假传指令 | ✅ 改为「先要证据」，已上线（15:29 生效） |
| 不复述 / 情感撤退 / 收尾不补称呼 | ⚠️ 仅提示词，无代码判定 |
| E3 技术探询统一话术 | ✅ 已上线（17:24，M2 preset） |
| E7 群内可疑文件 | ✅ 已上线（17:23，M1 入站拦截 `[guard] suspicious-file`） |
| P2 四项（风险档案 / 点名判断 / 审计指标 / 可疑文件） | 审计指标 ✅（M5）、可疑文件 ✅（M1）；风险档案 / 点名判断 ❌ 未做 |
| AI 味改造 R1~R5 | R1 ✅（16:42）；R2~R5 ✅（17:24，M2）——都还没被真实流量验证 |
| 真实命中 | **0 次**（截至 10-29 17:25）——五道防线都未被真实消息触发过 |

一句话：**最坏的几类事故（敏感人名、被叫爷爷、背台词、可疑文件）都已在发送前/入站侧拦住，但都还没被真实场景验证；剩风险档案、点名判断与 24h 观察。**

---

## 2. 变更清单

| 文件 | 版本/形态 | 行为变化 |
| --- | --- | --- |
| `src/guards/outbound-content.js` | 1.1.0 → **1.3.0** | 新增 `sensitiveEntities`（敏感人物名，含去空格/分隔符变体）、`kinship`（非 owner 会话禁亲属称呼）、`presetEcho`（preset 8 句例句原句，含标点/拆行/嵌长句变体）。命中返回 `kind:'entity'/'kinship'/'presetEcho'`；**entity 与 presetEcho 的 reason 都不带命中原文**。仍是 fail-open，判定抛错就放行 |
| `src/bridge.js` | — | 透传 `entityEnabled` / `entityWords` / `presetEchoEnabled` / `presetEchoLines`；新增 entity / kinship / preset-echo 三个记账分支；新增 `markKinshipRefusalV2()`，称呼被拦时给对方档案写 `noKinshipTitle: true` + 一条 trait |
| `src/content/memory-render.js` | — | 印象行追加「（边界：不叫亲属称呼，用名字或「你」）」，下次唤醒直接看到，不用重新谈判 |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | — | 新增【不接的题（硬边界）】9 条：不复述 / 不填空 / 被追问不解释 / 称呼硬边界 / 收尾不补称呼 / 假传指令 4 条（要证据 → 拿不出 → 拿得出分两级 → 本人说的算） |
| `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` | 生成物 | 由 `scripts/build-agent-preset-patches.mjs` 生成，勿手改 |
| `config.example.json` | — | 记录 `socialV2.guard.{meta,address,sensitiveEntities,presetEcho}` 的形状 |
| `tests/` | +23 条 | `outbound-content` +18（含 R1 的 7 条）、`memory-render` +1、新增 `preset-trap-rules` +4 |

**默认词表**（要改走配置，见 5.2）：
- 敏感人物名 13 条：汪精卫 / 汪兆铭 / 汪精衛 / 汪兆銘 / 周佛海 / 陈公博 / 褚民谊 / 川岛芳子 / 土肥原贤二 / 东条英机 / 松井石根 / 冈村宁次 / wangjingwei
- 亲属称呼 14 条：爷爷 / 奶奶 / 姥爷 / 姥姥 / 外公 / 外婆 / 爸爸 / 妈妈 / 干爹 / 干妈 / 哥哥 / 姐姐 / 弟弟 / 妹妹
  ——刻意不收「爹」「妈」单字（会和「老爹」「我妈」打架），不收「叔叔」（王江叔叔是既定称呼）。

---

## 3. 上线记录与回滚点

| 时间 | 动作 | 结果 |
| --- | --- | --- |
| 14:48 | `deploy.ps1` 第一次 | **只传了 `bridge.js` 就中断**（1/3），未传两个模块。已用 md5 对账发现——这是交接文档里那次事故的同款形状 |
| 14:49–14:55 | scp preset patch、校验 md5、重启 `dsh-web` | 14:55:24 起生效 |
| 14:53 | `deploy.ps1 -SkipTests` | 补传 2 个文件，重启，`active`；备份 `src.bak-145349` |
| 15:29 | 第二次 patch（假传指令改版）+ 重启 `dsh-web` | 15:29:16 起生效 |
| 16:42 | `deploy.ps1` 第三次：R1 例句拦截（`bridge.js` + `guards/outbound-content.js`） | 2/2 文件上传，`active`；备份 `src.bak-164220` |
| 17:22–17:24 | 第四次发布：合并 M1 `ab6542a` / M2 `a2573b3` / M5 `841b51c` → `deploy.ps1`（M1 src）+ scp patch（M2）+ 重启 `dsh-web`（M5 纯脚本无需上线） | 全绿 672；备份 `src.bak-172224`、patch 备份 `qq-chat-v2.patch.yml.bak-1723`；部署锁 `.deploy-lock` 已释放 |
| 18:58–18:59 | 第五次发布：合并 M3 `635154b` / M4 `e148c5d` → `deploy.ps1`（M3 `bridge.js`+`memory/risk-profile.js`+`content/memory-render.js`；M4 只改 `bridge.js` 与 tests，tests 不上线） | 全绿 692；备份 `src.bak-185849`；部署锁 `.deploy-lock` 已释放；`qq-bridge` active、NRestarts=0、无错误日志 |
| 21:50–21:51 | 第六次发布：合并 M8 `813f52f` / M9 `7207c00` / M10 `24dfece` → `deploy.ps1`（M8 `bridge.js`+`memory/affection-profile.js`+`content/memory-render.js`）+ scp patch（M9）+ 重启 `dsh-web`（M10 只读脚本无需上线） | 全绿 711；备份 `src.bak-215008`、patch 备份 `qq-chat-v2.patch.yml.bak-2150`；部署锁已释放；`qq-bridge`/`dsh-web` 均 active、NRestarts=0、无错误 |
| 21:53 | 第七次发布（M7 音色换声上线）：远端 `config.json` 的 `socialV2.voice.tts.voiceId` 从旧音色换成 M7 复刻的新音色 `cosyvoice-v3.5-plus-m7-1d808330...`，重启 `qq-bridge` | 备份 `config.json.bak-2153`；重启后 active、NRestarts=0；远端 `tts-batch` 实测新音色 4 个语气均正常合成（wav 1.8~2.6s） |

**回滚点（记清楚，别搞错）**

| 目的 | 用什么 | 说明 |
| --- | --- | --- |
| 代码整轮回滚（含 M8） | `/opt/qq-bridge/src.bak-215008` | **M8 上线前的完整快照**，当前最新回滚点 |
| 代码整轮回滚（含 M3+M4） | `/opt/qq-bridge/src.bak-185849` | M3+M4 上线前的完整快照 |
| preset 回滚（含 M9） | `.../presets/qq-chat-v2.patch.yml.bak-2150` | M9 上线前的 patch |
| 代码整轮回滚（含 M1） | `/opt/qq-bridge/src.bak-172224` | M1 上线前的完整快照 |
| 代码整轮回滚（含 R1） | `/opt/qq-bridge/src.bak-164220` | R1 上线前的完整快照 |
| 代码整轮回滚（到本轮加固前） | `/opt/qq-bridge/src.bak-144829` | 本轮改动前的完整快照 |
| （陷阱） | `/opt/qq-bridge/src.bak-145349` | 是「只传了 bridge.js」的**半传状态**快照，用它回滚会得到「新 bridge + 旧模块」的错配，别用 |
| preset 回滚 | `.../presets/qq-chat-v2.patch.yml.bak-1449` | 本轮改动前的 patch（14:08 版） |
| git | `git revert 247bc5c ccc8262` | 本地有完整历史；线上回滚优先用 git 重部署 |

```bash
# 代码回滚（会重启，约 3 秒）
ssh root@175.178.200.118 "rm -rf /opt/qq-bridge/src && cp -a /opt/qq-bridge/src.bak-144829 /opt/qq-bridge/src && systemctl restart qq-bridge"
# preset 回滚
ssh root@175.178.200.118 "cp -a /opt/qq-bridge/plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml.bak-1449 /opt/qq-bridge/plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml && systemctl restart dsh-web"
```

当前一致状态（可用来对账）：

| 文件 | md5 |
| --- | --- |
| `src/guards/outbound-content.js` | `d7d2c989e9726bbfb5e22c1f46975c93` |
| `src/content/memory-render.js` | `7067dd908a2b0fb6a3eebdc0646c9386` |
| `src/bridge.js` | `e3eb27d15051f2ce6b1d623b286a639e` |
| `src/memory/risk-profile.js` | `c52b6d57d69d54a49af28b81f6415bbd` |
| `src/memory/affection-profile.js` | `ca5f5af4ce39b51fd38a8331d1e15e40` |
| `plugins/.../qq-chat-v2.patch.yml` | `8fe29193a24f15ec027384b5af6617ac` |

---

## 4. 验收证据

| 项 | 证据 |
| --- | --- |
| 单测 | `node --test tests/*.test.mjs` → **711 通过 / 0 失败**（692 + M8 的 12 + M9 的 7） |
| preset 契约 | `node scripts/test-agent-preset-patches.mjs` → 通过 |
| 线上模块 | 在服务器跑 `evaluateContent`：实体命中→拦、称呼命中→拦、owner 私聊→放行（`entity false entity / kinship false kinship / owner true`） |
| R1 线上判定 | `床以外都是远方`→`presetEcho` 拦；`行吧，床以外都是远方，睡`→拦；`今天的运动量还行`→放行 |
| M1 线上判定 | `PC电脑资源大合集打开即可下载 .txt`→可疑（3 命中）；`毕业照.jpg`→放行；正文「我去下载个东西」→放行 |
| M3 线上判定 | `src/memory/risk-profile.js` 已随 deploy 上线，md5 本地/远端一致；`markKinshipRefusalV2` 改为薄门面调纯函数，行为不变（单测覆盖私聊记/群聊不记/重复不叠加）；`renderMemory` 印象行渲染风险档案（爱下套/不能接话题/已拒绝称呼） |
| M4 线上判定 | `evaluateWakeTriggerV2` 接入「点名门」：同一人连续点名 ≥3 次（期间 AI 未回）时 @/名字 不再单独唤醒，落回关键词/提问等触发；单测 9 条覆盖换人重置、AI 回话重置、阈值钉死为 3 |
| M8 线上判定 | `memberImpressions` 增 `affection`（好感度/关系温度，-100~100 有符号分 + 标签）；`markKinshipRefusalV2` 拒绝称呼时连带下调 10 分（`KINSHIP_COOLING_DELTA`）；`renderMemory` 印象行渲染好感度（没写过的不渲染，老数据兼容）；单测 12 条覆盖增减/夹断/去重/防原型污染/纯函数 |
| M9 线上判定 | preset 增「逐条思考再回（防抖）」整段（合并碎片、同一件事只回一次、回的顺序跟读的顺序）；patch 已重建 `--check` 过、md5 一致；契约 7/7 绿 |
| M10 线上判定 | 新增只读探针 `scripts/probe-qq-profile.mjs`（用「非法类型参数」探测改资料动作是否存在，1400=支持/1404=不支持，绝不真改）；**结论待 SnowLuma 在线时在远端跑一次** |
| 文件一致 | src + patch 的 md5 本地/远端完全一致 |
| 服务 | `qq-bridge` / `dsh-web` 均 `active` |
| 真实拦截 | **0 次**（`entity-blocked` 0、`kinship-blocked` 0、`preset-echo` 0、`suspicious-file` 0）——见第 7 节 |

---

## 5. 运维手册

### 5.1 怎么确认它还在工作

```bash
ssh root@175.178.200.118
systemctl is-active qq-bridge dsh-web
grep -c '\[guard\] entity-blocked'  /opt/qq-bridge/state/qq-activity.log
grep -c '\[guard\] kinship-blocked' /opt/qq-bridge/state/qq-activity.log
grep -c '\[guard\] preset-echo'     /opt/qq-bridge/state/qq-activity.log
tail -20 /opt/qq-bridge/state/qq-activity.log
```

命中一次会各写一行：`[guard] entity-blocked (group:…): 汪精卫`、`[guard] kinship-blocked (private:…): 爷爷`、`[guard] preset-echo (group:…)`。
前两个词只落在本机 activity（owner 可见），**不会回显到群里**；preset-echo 连原句都不记。

### 5.2 加词 / 收词

改 `/opt/qq-bridge/config.json`（**`config.json` 不热加载，改完要 `systemctl restart qq-bridge`**）：

```json
"socialV2": {
  "guard": {
    "sensitiveEntities": { "enabled": true, "words": ["…"] },
    "presetEcho": { "enabled": true, "lines": ["…"] },
    "address": { "enabled": true }
  }
}
```

- `words` / `lines` 都是**整表覆盖**，不是追加：写了就丢掉内置表（敏感人物 13 条 / 例句 8 条），记得复制全。
- `words: []`、`lines: []` 或省略 = 用内置表。
- 亲属称呼词表目前只能改代码里的 `DEFAULT_KINSHIP_TITLES`（模块支持 `kinshipWords` 入参，但中枢没接配置——要接的话在 `guardOutboundV2` 里补一行）。

### 5.3 边界记忆怎么清

`noKinshipTitle` 不会自动过期（设计如此：不再重新谈判）。要清：

- 单条：`qq_memory_remove(category="memberImpression", target="对方名字")`（会连整条印象一起删）；
- 批量/精确：编辑 `/opt/qq-bridge/state/social-v2.json` 的 `conversations.<key>.memberImpressions.<名字>`，删掉 `noKinshipTitle` 字段。

### 5.4 观察窗口（T7）

至少 24 小时，看三件事：

1. 命中即拦：出现 `entity-blocked` 时，群里那条确实没发出去；
2. 称呼复发：`kinship-blocked` 出现后，对方不再拿到「爷爷」（看 `social-v2.json` 最近消息）；
3. 副作用：有没有「连续被拦 → 模型反复重写 → 这轮不说话」的情况（看 `bridge.log` 的 `自动回复被出站守卫拦截` 与发送失败率）。

### 5.5 观察记录（T7）

#### A. 2026-10-29 17:09 —— 中期快照，**窗口未满 24h**

| 项 | 事实 | 判读 |
| --- | --- | --- |
| 守卫生效 | entity/kinship `14:55:24`；presetEcho(R1) `16:42:28`（`systemctl show qq-bridge -p ActiveEnterTimestamp`） | 到采集时只过了 **2h14m**（R1 只有 27 分钟） |
| 采集方式 | `scripts/ops-daily-check.sh` 只读跑一次，`OPS_OUT_DIR=/tmp/m5-check`，没覆盖当天的正式报告 | 无部署、无重启 |
| 经过守卫的流量 | 3 次出站（15:22 群 `成功 1/1`、16:32 私 `2/2`、16:43 私 `2/2`）＝**5 条消息**；模型发言 **3 回合**（群 1 / 私 2） | 样本量太小，说明不了问题 |
| 三道防线命中 | `entity-blocked` **0** / `kinship-blocked` **0** / `preset-echo` **0**（窗口 10-29 00:17:57→16:43:49，含 `.log`+`.log.1`） | 仍是「0 次真实命中」 |
| 称呼复发 | 命中会话 0、复发 0 次；`noKinshipTitle` **0 人**（共 4 个会话） | 没人施压，也就谈不上复发 |
| 群发言占比 | 近 24h 发言 **47 回合**：群 **13（27.7%）** / 私聊 34（`private:1843979560` 27、`private:2966799271` 4、`private:2453753245` 3） | 群是少数，私聊才是主战场——群里的称呼施压样本会更慢攒 |
| 副作用 | `自动回复被出站守卫拦截` **0**；activity 里 `失败` **0**；activity 里仅有的 2 条 `[guard]` 是 07:58 的 `length-nudge`（既有的长度提示，与三道防线无关） | 没观察到「反复重写 → 这轮不说话」 |

**只能这么下结论**：2h14m、5 条出站、0 次命中。**0 命中不等于 0 风险，也不等于防线有效**——它只说明这 2 小时里没人下套。按 §7-1，没看到命中之前不宣布问题解决。

顺带一条边界：15:22 那条对可疑 `.txt` 的群回复正常出站了。三道防线只查**话术**、不查**入站文件**，这条归 E7/M1，不算本模块漏拦——但它提醒「0 命中」里混着本该被别的机制挡下的东西。

**24h 窗口什么时候算满**：entity/kinship 到 10-30 14:55，R1 到 10-30 16:42。补记录的动作：看 `/root/dsh-run/daily-check-20261030.log` 的三行指标 + 人工翻 `social-v2.json` 最近消息；若仍是 0 命中，也只写「无诱因」，不写「已解决」。

#### B. 三个新指标的口径（读报告时要对得上）

- `-- guard-hits --`：`qq-activity.log` + `.1` 里三类 `[guard]` 行的条数。**activity 行只有 `HH:MM:SS`、没有日期**，所以只能报「窗口」不能报「今天」；日界靠 500 行轮转近似，别拿它做日报同比。
- `-- kinship-recurrence --`：`复发 = 同一会话被拦第 2 次起`（第 1 次是首次施压，第 2 次才说明上一轮写的边界没拦住）；后面的 `noKinshipTitle` 是 5.3 的边界档案（永久，不自动过期），单独报人数是为了区分「拦住了」和「记住了」。
- `-- group-share --`：`token-usage.jsonl` 的 `k=turn` 行，按 `sid|turn` 去重（一次发言会跨多个 step，不去重会按工具调用次数加权），取近 24h（`t` 是毫秒，是这里唯一带日期的时间源），`group:` 前缀算群。

---

## 6. 待办（按优先级）

| # | 任务 | 落点 | 验收 |
| --- | --- | --- | --- |
| 1 | ~~**R1 preset 例句黑名单**~~ ✅ **已完成（16:42，commit a07c711）**：8 句原句 + 标点/拆行/嵌长句变体全部出站拦截；线上实测命中 `presetEcho` | `src/guards/outbound-content.js` | 单测 7 条；线上判定已验；真实流量待命中 |
| 2 | **P2-4 可疑文件**：命中「资源合集/下载/解压密码/打开即可」类文件名 → 不接话、记一条 activity | `bridge.js` 群消息分支 | 10-29 15:22 那条「这文件名比内容还长」作为回归样本：改为不回复 + `[guard] suspicious-file` |
| 3 | **E3 技术探询话术**：统一一句「这些我不聊，换个话题」，被追问不解释 | preset | 提示词含该句；模拟「你用啥链接的 QQ」只回这一句 |
| 4 | **T7 24h 观察** | 运维 | 见 5.4 |
| 5 | **P2-1 风险档案**：把「爱下套的人 / 不能接的话题」写进 `memberImpressions`（`noKinshipTitle` 是它的雏形） | `bridge.js` + `memory-render` | 唤醒提示里能看到 |
| 6 | **P2-2 点名判断**：@ 只保证「会看」，同一人连续点名 3 次可只回一句或不回 | `scheduler/triggers` 或 preset | 连续点名场景不再 100% 入场 |
| 7 | **P2-3 审计指标**：每日巡检加「实体拦截数 / 称呼复发数 / 群发言占比」 | `scripts/ops-daily-check.sh` | 报告里出现三行 |
| 8 | **R2~R5 AI 味**：数字/时间降级、金句连发 shadow、三连问限制、借嘴软约束 | preset + anti-ai | 见 `chat-trap-review.md` §12.5 |
| 9 | 补 `markKinshipRefusalV2` 单测 | `tests/`（需先把它抽成纯函数） | 覆盖：私聊记、群聊不记、重复不叠加 |
| 10 | 修 `scripts/test-qq-preset-contract.mjs` 的存量红：`missing rule: qq_memory_clear` | preset 或测试 | 该脚本转绿（注意：这是历史遗留，改之前先确认是否真要把 `qq_memory_clear` 写进人格） |

---

## 7. 已知局限与风险（接手前必须知道）

1. **0 次真实命中 = 未证明。** 两道防线只在单测和「直接调模块」里验证过。真实 QQ 流量里一次都没触发——可能是没再犯，也可能是还没遇到诱因。别在没看到命中前宣布「问题解决」。
2. **词表覆盖有限。** 13 条只覆盖本次事故词及其常见变体；谐音（旺京卫）、日文名、其它敏感人物一律漏。`sensitiveEntities` 是「至少挡住已知的最坏情况」，不是「敏感人物过滤器」。
3. **拦截 = 让模型重写，不是静默丢弃。** 模型若坚持，会连续被拒、这轮可能不说话。观察时要同时看「拦截数」和「该说话却没说的次数」。
4. **亲属称呼会误伤正常叙事。** 群聊里讲「我爷爷那辈」也会被拦（然后被要求重写）。这是有意的取舍：宁可让它换句话，也不让它练成「爷爷」的条件反射。
5. **群聊不记 `noKinshipTitle`。** 群里分不清是谁在要称呼，宁可不记；所以群里的称呼施压只能靠当轮拦截。
6. **边界标记不衰减。** 一旦写进档案就一直在，直到手工清。若对方后来关系缓和、或本来就是玩笑，需要人工清（见 5.3）。
7. **记忆块只渲染最后 10 个印象**（`renderMemory` 的 `impressionLimit`）。被标记的人如果不在最近 10 个里，唤醒提示里看不到这条边界——人数多的群要注意。
8. **AI 味只治了「背台词」这一种。** R1 已拦掉 preset 8 句原句；「复述+升华」「报精确账」「金句连发」「三连问」仍在（R2~R5 未做）。

---

## 8. 不要做的事

1. **不要为了让拦截「少误伤」去放宽 `kinship` 的词表**——「爷爷」就是这次被磨穿的入口，放宽等于回滚。
2. **不要用 `src.bak-145349` 回滚代码**（半传状态，见第 3 节）。
3. **不要手工改 `plugins/.../qq-chat-v2.patch.yml`**——它是生成物，下次 build 会被覆盖；改源再 build。
4. **不要在群里解释这两道守卫**（提「提示词/权限/设定」会触发 meta 拦截，也给对方新抓手）。
5. **不要引入「每条消息多一次模型调用」的方案**——成本按缓存命中率敏感，日均 200~600 次调用。
