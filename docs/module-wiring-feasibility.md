# 模块接线可行性表（v1）

截至 2026-10-28 13:50。已实现 33 个模块，其中 21 个已接入线上（含下午新增的 4 个影子/端点与 1 个真替换）。
本表记录**剩余 12 个模块为什么没接**，以及下次开工该怎么处理——避免重复评估。最终处置见第七节。

## 结论先行

新造模块的**可接线率约 50%**。原因不是模块质量，而是契约按「理想职责划分」设计，
而 `bridge.js` 里的存量实现有明显历史包袱（跨媒体累积预算、离散档位、固定优先级表、
按端口判健康）。**凡是需要"等价替换"的地方，几乎都对不上**。

因此后续策略调整为：
- **新能力** → 新模块 + 开关（默认关闭），例如 dedupe / split / rate / interval
- **存量搬迁** → 必须先写"特征测试"锁住现有行为，再替换；不能直接换

---

## 一、可直接替换（但目前收益不大）

| 模块 | 现状 | 阻碍 | 建议 |
|---|---|---|---|
| `session/key` | `canonicalV2Key` 用同一正则 + Number 校验 | 逻辑完全一致，替换是纯搬家 | 保留，等拆 `session` 域时一并处理 |
| `auth/verify` | `agentTokenOk` 已覆盖校验 | 无额外能力 | 保留 |
| `heal/retry` | `onebot-retry.js` 已有退避状态机 | 语义重复 | 保留；若要做 HTTP/模型退避可复用 |
| `session/queue` | `scheduleWakeV2` 已实现合并升级 | 逻辑重复 | 保留 |

---

## 二、语义不同，需先对齐再谈替换

| 模块 | 现状 | 冲突点 | 建议 |
|---|---|---|---|
| `observability/health` | `runHealthCheckV2` 按**端口 up/down + 在线 + token 限额**判定 | 模块按**事件陈旧 / 未读积压 / 成本占比**判定，输入不同 | 若要接入，需把两者合成一张判定表（改动 100+ 行），单独一轮 |
| `scheduler/wake-priority` | `wakePriorityV2(reason)` 查**固定优先级表** | 模块是多因素计算（triggers/message/isOwner/isBusy） | 保留；或另建"新触发策略"开关，与旧表并行 |
| `outbound/escape` | `escapeCqText` 只把 `[CQ:` 转成全角冒号 | 模块转义 `[ ] & ,` 四个字符，更激进 | **不要替换**；会改动正常标点 |
| `scheduler/triggers` | 触发判定散在 `scanForWake` 里，条件多 | 模块只覆盖五类基础触发 | 影子对比可行，但需先读出全部触发条件 |
| `auth/allow` | `allowed(kind, id, cfg)` 已存在 | 需核对 mode/白名单语义是否一致 | 影子对比可行 |
| `lifecycle/lock` | 单实例锁 + pid 存活判定 | 判定逻辑与 fs/process 耦合 | 需先把"pidAlive"抽成注入，再影子 |
| `lifecycle/shutdown` | 桥没有显式优雅退出流程（systemd 直接 SIGTERM） | 模块是"计划"而非"执行" | 保留；将来做退出编排时再用 |
| `observability/activity` | `appendActivity` 直接写文本 | 模块提供格式化 + 汇总 | 可用于新端点（如 `/api/activity/summary`），零风险 |

---

## 三、明确不适合替换（会改变行为）

| 模块 | 冲突 | 结论 |
|---|---|---|
| `content/persona-inject` | 合并 roleLine + identityLine 会改变唤醒提示词字节 → 缓存重建 + 人格表达可能变化 | 保留 |
| `inbound/media-plan` | `resolveMediaList` 是"跨媒体累积预算 + face/图片双异步分支"，模块是单条决策 | 保留，作为将来新类型媒体的决策表 |
| `inbound/command` | 现有是 `startsWith('/')` + isOwner 硬门 + 精确 `===`；模块引入别名表 → 权限边界变宽 | 保留；**权限相关不做替换** |
| `observability/log-format` | 接到 `log()` 会改所有日志行格式，影响排查| 保留 |

---

## 四、已接入的 18 个（供对照）

**真实生效**：`guards/chain`、`guards/length`、`guards/outbound-content`、`guards/sensitive`、
`guards/scorer`、`guards/anti-ai`、`content/memory-score`、`tools/module-switch`、
`cost/gate`、`cost/report`、`persist/atomic`、`inbound/gif`

**开关控制（默认关闭或按配置）**：`outbound/dedupe`（已开）、`outbound/split`（默认关）、
`outbound/rate`（默认关）、`scheduler/interval`（已开）

**影子模式（只记日志）**：`session/expiry`

---

## 五、下次开工的正确顺序

1. 先做 `observability/health` 与 `auth/allow` 的**影子对比**（各约 20 分钟，零风险）
2. 再做 `scheduler/triggers` 影子（需先完整读出 `scanForWake` 的触发条件）
3. `lifecycle` 域整体搬迁放到最后——它依赖模块接口稳定，且是装配根的前置
4. **任何存量替换前，先写特征测试**（用真实日志样本跑新旧两版比对），这是今天 13 个模块接不上的根本教训

---

## 六、2026-10-28 下午进度与今晚待观察

### 已完成

| 项 | 内容 | 关键结论 |
|---|---|---|
| `observability/health` 影子 | 三个入参接真实值：`lastIncomingAt` 最大值 / `unreadCountV2` 求和 / `tokenLedger.spentToday()` | 阈值必须对齐：事件陈旧 12h（默认 30min 会在 09:00 把夜间静默天天误报）、积压 200、成本 ¥10 预警 |
| `auth/allow` 影子 | 真实入站消息流过、0 分歧 | 入站主路径 `handleIncoming → modeAllowed → allowed`，每条消息必经，判定有效 |
| `scheduler/triggers` 影子 | 只比 nameMention / keyword / anyMessage | 修掉「配置含 probability 就整体跳过」——本群就配了 probability，原实现等于没接 |
| `session/key` 真替换 | `canonicalV2Key` 委托 `parseKey` | 16 样本对照，仅 >2^53 的超长 id 有差（现实不存在） |
| `observability/activity` | 新端点 `/api/activity/summary` | 审计日志只写 `HH:MM:SS` 不带日期，必须从尾部倒扫、按时间回绕推算跨天 |
| `rotation` 归档修复 | 记忆只在**确认进入 prompt 后**才标记 injected | 原实现构造 prompt 时就标记，而 archive 是首个裁剪段 → 一旦被裁就永久丢记忆 |

### 仍建议不接的 12 个

`outbound/escape`、`auth/token`、`auth/verify`、`content/persona-inject`、`scheduler/wake-priority`、
`session/queue`、`inbound/command`、`inbound/media-plan`、`lifecycle/lock`、`lifecycle/shutdown`、
`heal/retry`、`obs/log-format`——理由见第三节，未变。

### 今晚待观察（按时间顺序）

1. **21:32 之后**：owner 私聊首次轮换（`createdAt=1793107936516` ≈ 10-27 21:32，`maxAgeHours=24` + 空闲 10min）
   - 期望日志：`[rotation] 会话 ... 已超过驻留上限`、`[rotation] ... 记忆快照已归档`、`[rotation] 影子不一致`（若模块判定不同）
   - 重点确认：归档文件生成、下一次唤醒的 archive 段是否真的进了 prompt
2. **次日 09:00**：定时自检的 `[health] 影子` —— 放宽到 12h 后不应再因夜间静默报分歧
3. **任意群消息**：`[triggers] 影子已接入` 之后，5 分钟窗口汇总 `可比 N 次（一致 N / 分歧 N）`

---

## 七、12 个未接模块的最终处置（2026-10-28 定稿）

这一节是**结论**，不是待办。后续接手者**不需要重新评估**这 12 个；
要重新打开任何一项，必须先满足下表的触发条件，并在本节追加一条记录说明为什么条件已满足。

### A. 永久不接（7 个，接了是负收益）

| 模块 | 原因 |
|---|---|
| `outbound/escape` | 会把 `[ ] & ,` 等正常标点一并转义，改变对用户可见的文本 |
| `obs/log-format` | 会改掉所有日志行格式，现有排查脚本与习惯全部失效 |
| `inbound/command` | 模块引入别名表会让权限边界变宽；**安全相关的判定一律不做替换** |
| `auth/token` | 桥内 `consoleToken` + `tokenEq`（timingSafeEqual）已等价 |
| `auth/verify` | `agentTokenOk()` 已覆盖同样的校验 |
| `session/queue` | `scheduleWakeV2` 已实现同等的合并/升级语义 |
| `heal/retry` | `onebot-retry.js` 已有完整的退避状态机 |

### B. 待前置（5 个，条件满足才接）

| 模块 | 触发条件 |
|---|---|
| `lifecycle/lock` | 先把「pid 是否存活」抽成可注入依赖，并为单实例锁补回归测试。**未满足前不动**：锁失效会导致两个进程同时写 state |
| `lifecycle/shutdown` | 真正要做「优雅退出编排」时。当前 systemd 直接 SIGTERM，模块是计划而非执行，接上去没有落点 |
| `content/persona-inject` | 确定提示词缓存策略之后。合并 roleLine / identityLine 会改变提示词字节数 → 缓存全部重建，人格表达也可能漂移 |
| `scheduler/wake-priority` | 决定替换现有固定优先级表时，以**新策略开关 + 与旧表并行灰度**的方式接入，不做直接替换 |
| `inbound/media-plan` | 出现新的媒体类型需要决策时，作为决策表接入。现存实现是「跨媒体累积预算 + 双异步分支」，模块表达不了 |

### C. 判断口径（以后遇到类似情况直接用）

- 会改变**对外可见文本**或**所有日志格式** → 不接
- 涉及**权限/白名单/工具边界** → 不接
- 功能与桥内已有实现**重复** → 不接
- 需要先做**结构重构**（抽依赖、加回归测试）才能安全替换 → 待前置
- 需要**明确的产品决策**（换策略、改缓存口径）→ 待前置
