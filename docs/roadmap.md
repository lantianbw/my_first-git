# qq-bridge 后续任务与观察清单

> 2026-10-29 收口版。模块的域/职责/现状见 `docs/module-catalog.md`；
> 处置理由见 `docs/module-wiring-feasibility.md` 第七节 A/B 与 D 节。
> 本文件只回答三个问题：**做完了什么、还欠什么决策、每天该看什么。**

---

## 一、已完成（2026-10-28 ~ 10-29）

### 1.1 模块化

| 项 | 结果 |
| --- | --- |
| 契约里 30 个"需合并"模块 | 15 个接线并上线、8 个判定不接（其中 4 个文件已删）、7 个未动（安全/提示词相关） |
| 契约 63 个域模块 | 全部有处置结论，无"待接线"项 |
| 单测 | 630 条（新式）+ `scripts/test-*.mjs` 老脚本全绿 |
| 桥接体积 | 删掉约 2.3k 行内联实现，`bridge.js` 只剩 IO 与能力注入 |

**落地顺序**：`persist/atomic` + `obs/log`（地基）→ 纯函数批（length / outbound-content / health / tool-log / batch / recheck / migrations / heal-token / segments）→ 调度批（wake / chain）→ 会话批（判定不接）→ `outbound/send`（单行化 + 超长拆分）→ 影子批（`session/router`、`inbound/message`）。

### 1.2 token 优化

| 杠杆 | 结论 |
| --- | --- |
| 换厂商（商汤/百炼） | ❌ 否决：缓存命中 98.8%，换掉等于全价，同量约涨 9 倍；窗口装不下 460K 历史 |
| 压历史 | ✅ 已落地：`maxAgeHours` 24→12；实测一次轮换 460k→41.6k（−91%） |
| 砍步数 | ⚠️ 查完无配置项（DSH 无 `maxSteps`）；`wait` 仅占 13.5%，纯推理步 73% |

### 1.3 工程设施

- `scripts/deploy.ps1`：单测 → md5 对账 → 备份 → 上传差异 → 重启 → 校验（非 active 自动回滚）
- `scripts/ops-daily-check.sh` + crontab 09:05：只读采集，报告留存 14 份
- Trae 定时任务（10:30）：解读报告，含 router / inbound-message / triggers 影子分歧
- `scripts/audit-bridge-harness.mjs`：改为按 `bridge.js` 的 import 语句自动注入沙箱，以后再抽模块不用改脚手架；`NodeApiClient` 桩固定在自动注入之后覆盖，防止测试访问真实 DSH
- 轮换 idle 闸：用户消息触发的唤醒使用入库前 `lastIncomingAt`，修掉“超龄会话永远无法被用户消息轮换”的时序问题
- mod 系统 v1：`mods/loader` + `mods/host`，接通 `inbound.observe / outbound.observe / wake.before / tick.daily`；异常隔离、200 字预算、200ms tick 超时，空目录零行为（630 条单测）

---

## 二、待决策（需要产品判断，不是技术债）

| # | 事项 | 收益 | 代价 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 去掉「回复后立刻 `qq_wait_for_messages`」，只留睡前观察 | 调用量 ≈ −8% | 发完消息后不再"等你补充"，等下次唤醒才接 | 未动 |
| 2 | 睡前观察 5 分钟 → 2 分钟 | ≈ −10~12% | "陪一会儿"的耐心变短 | 未动 |
| 3 | 是否给 `inbound/message` 扩大影子（现在只比媒体归一） | 更快暴露 DTO 分歧 | 需要改三处构造点 | 只比媒体 |
| 4 | ~~是否接 mod 挂点~~ | 加 mod 不用改中枢 | 4 个挂点要维护；空目录时是空转 | ✅ v1 已完成 |

**决策原则**：动到她说话方式的（1、2）由 owner 拍板；纯观测的（3、4）可以随时做。

---

## 三、暂缓（无消费者，先不建）

| 项 | 为什么暂缓 | 什么条件满足再做 |
| --- | --- | --- |
| `tools/registry` | 现在没有"工具类"新模块，建出来是空表 | 第一个 mod 工具出现时（那天顺手建，一出生就有真实条目） |
| 热加载 / 控制台 mod 列表 | ESM 缓存失效 + 已注册挂点撤销是两个坑；当前只能重启生效、开关直接读 `module-switches.json` | v2；先让静态加载稳定运行一段时间 |

---

## 四、判定不接（结论，不需重新评估）

`lifecycle/boot`、`lifecycle/shutdown`、`scheduler/tick`（装配根与定时器，抽了只剩空壳）、
`inbound/media`（预算与 fetch/GIF 解码交织）、以及 A 节 7 个安全相关模块、
D.2 里已删文件的 4 个（`session/store`、`session/social-state`、`session/lifecycle`、`lifecycle/lock`）。

新增判断口径：
- 会改变既有判定语义（哪怕差一个边界比较符）→ 不接
- 收益趋零、风险非零 → 不接

---

## 五、每日观察节点

| 时间 | 看什么 | 判据 |
| --- | --- | --- |
| 00:05 | mod `tick.daily` | 有 mod 时应出现 `[mods] 每日 tick`；失败只应 warn |
| 09:00 | 定时自检 `[health]` | 必须存在且 OK；影子分歧累计应为 0 |
| 09:05 | 服务器 cron 生成报告 | 服务 active、fatal-errors=0、warn 只来自上游 |
| 10:30 | Trae 定时解读 | 与基线对比：`inputMiss`、owner 单次 `cacheHit` |
| 每次轮换（约 12h） | `[rotation]` 三行 + 归档文件 | 归档落盘、`injected:true`、历史回落至 ~40k |
| 随时 | `[inbound/message]` / `[router]` 影子 | 应只有"已接入"，不应出现"不一致" |

---

## 六、停车场（不影响运行，暂不处理）

| 项 | 说明 |
| --- | --- |
| idle 闸时序 | **已修复**：用户消息触发的唤醒沿链携带入库前 `lastIncomingAt`；主动唤醒仍按当前时间判定 |
| 两套日志路径 | `/root/dsh-run/bridge.log`（systemd stdout）与 `/opt/qq-bridge/state/bridge.log`（桥自带轮转）。查日志时注意区分 |
| SnowLuma 抖动 | 约每 10 分钟一次 `good=false`，均自愈；抖动期间入站消息可能丢，属上游 |
| 控制台令牌 | 启动日志显示"未配置，自动生成"；`/api/socialV2/rotation/preview` 401 是进程内 token 与 state 文件不同步 |
| 归档 `topics` 为空 | 轮换快照里长期话题为 0 条，可能 `activeTopics` 从未写入；影响长期记忆衔接 |
| OCR「服务忙」 | OneBot 上游返回 code=200，桥已重试 3 次 |
| `slang` session not-found | 曾出现一次，需确认是否 DSH 重启导致 `slang-session.json` 失效 |

---

## 七、事故与教训（都已在代码或脚本里修掉）

1. **只传改动文件导致漏传** → 线上 `ERR_MODULE_NOT_FOUND` 重启约 2 分钟。现由 `deploy.ps1` 强制对账 + 自动回滚。
2. **抽模块打断老测试** → `scripts/test-*.mjs` 把 `bridge.js` 源码塞进 vm eval，抽出函数在沙箱里不存在。现已改为按 import 自动注入。
3. **影子只记分歧无法判断是否在跑** → 增加"影子已接入（首条 …）"日志，0 行分歧时也能确认路径被走到。
