# 模块接线可行性表（v1）

截至 2026-10-28 12:30。已实现 31 个模块，其中 18 个已接入线上。
本表记录**剩余 13 个模块为什么没接**，以及下次开工该怎么处理——避免重复评估。

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
