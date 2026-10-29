# qq-bridge 工作交接文档

> 2026-10-29 版。面向接管者：读完这一份即可接手日常运维与后续开发。
> 配套文档：`module-catalog.md`（模块目录）、`module-wiring-feasibility.md`（接线处置）、`roadmap.md`（后续任务）、`mod-system-draft.md`（mod 系统设计）。
> **本文不含任何令牌/密码**：远端为 SSH 密钥登录，凭据不在文档、也不在仓库里。

---

## 一、这是什么

一个 QQ 机器人桥接服务：**桥接（Node ESM）** 负责会话、记忆、调度与出站校验，
**DSH**（DeepSeek 的 agent 运行时）负责模型与工具循环，**SnowLuma**（网关）负责与 QQ 客户端收发。

```
QQ 客户端 ⇄ SnowLuma（ws://127.0.0.1:3001） ⇄ 桥接 bridge.js（:3100 控制台）
                                                     ⇄ DSH（http://127.0.0.1:8080）
```

桥接**不直接调模型**：模型选择、工具执行都在 DSH 侧。桥接只负责"什么时候唤醒、带什么上下文、发出去的文本过不过关"。

---

## 二、环境与连接

### 2.1 本地

| 项 | 值 |
| --- | --- |
| 仓库 | `E:\DSH\qq-bridge`（git，主分支 `main`） |
| Node | `C:\Users\18439\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| 单测 | `node --test tests/*.test.mjs`（当前 **618 通过**） |
| 老脚本测试 | `node scripts/test-voice.mjs` 等（另一套，见 3.3） |

### 2.2 远端服务器

| 项 | 值 |
| --- | --- |
| 主机 | `ssh root@175.178.200.118`（**密钥登录，无密码**） |
| 部署目录 | `/opt/qq-bridge` |
| 服务名 | `qq-bridge`（systemd；`ExecStart=/usr/bin/node /opt/qq-bridge/src/bridge.js`，`WorkingDirectory=/opt/qq-bridge`） |
| 进程查看 | `systemctl is-active qq-bridge` / `systemctl restart qq-bridge` |
| 控制台 | `http://127.0.0.1:3100`（仅本机；鉴权头 `x-console-token` 或 `?token=`，值在 `state/console-token`） |
| DSH | `http://127.0.0.1:8080` |
| SnowLuma | `/opt/snowluma`（docker-compose），`ws://127.0.0.1:3001` |
| 依赖组件 | `node`（`/usr/bin/node`）、`cron`（已有多个既有任务） |

### 2.3 日志在哪（**两套，别搞混**）

| 路径 | 谁写的 | 特点 |
| --- | --- | --- |
| `/root/dsh-run/bridge.log` | systemd stdout | 全量，含启动横幅与 `[wait]` 行 |
| `/opt/qq-bridge/state/bridge.log` | 桥自带日志（`obs/log` 轮转） | 满 2000 行轮转为 `.1` |
| `/root/dsh-run/daily-check-YYYYMMDD.log` | 每日巡检脚本 | 保留最近 14 份 |

**日志行不带日期**，只有 `HH:MM:SS`。按日期 grep 会一无所获；按时间来定位。

### 2.4 状态文件

`/opt/qq-bridge/state/` 下：`sessions.json`（会话映射与轮换元数据）、`social-v2.json`（话题/最近消息/未读水位）、
`token-usage.jsonl`（token 台账，`k:"turn"` 是增量、`k:"base"` 是累计快照）、`session-archive/`（轮换归档）、
`module-switches.json`（模块开关）、`bridge.lock`（单实例锁）、`config.json` 在 `/opt/qq-bridge/`。

---

## 三、日常操作

### 3.1 部署（唯一正确方式）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

六步：跑单测 → **md5 对账本地/远端 src** → 备份 `src.bak-HHMMSS` → 只传差异 → 重启 → 回读 `is-active`（失败自动回滚）。

- `-DryRun` 只对账不上传不重启；`-SkipTests` 跳过单测（紧急用）
- **历史事故**：2026-10-29 只传"改过的文件"，漏了 `bridge.js` 新 import 的 `outbound/send.js`，线上 `ERR_MODULE_NOT_FOUND` 重启循环约 2 分钟。对账就是为此加的。

### 3.2 回滚

```bash
ssh root@175.178.200.118 "rm -rf /opt/qq-bridge/src && cp -a /opt/qq-bridge/src.bak-<HHMMSS> /opt/qq-bridge/src && systemctl restart qq-bridge"
```

代码回滚优先用 git（本地仓库有完整历史），配置文件有 `config.json.bak-*`。

### 3.3 测试的两套体系

| 体系 | 位置 | 说明 |
| --- | --- | --- |
| 新式（主） | `tests/*.test.mjs` | 618 条，`node --test` 一把跑完 |
| 老式（保留） | `scripts/test-*.mjs` | 把 `bridge.js` 源码塞进 vm eval，跑真实链路桩。**不要删**，`package.json` 的 `test:*` 入口依赖它们 |

老式体系的坑：抽模块后沙箱里没有那些函数。`scripts/audit-bridge-harness.mjs` 已改为**按 bridge.js 的 import 语句自动注入**，新增模块无需改脚手架。

### 3.4 自动化任务

| 时间 | 谁 | 做什么 |
| --- | --- | --- |
| 09:00 | 桥自带定时器 | 自检写 `[health]` 行 |
| 09:05 | 服务器 crontab | `/opt/qq-bridge/scripts/ops-daily-check.sh` 生成巡检报告 |
| 10:30 | Trae 定时任务（ID `64240d86`） | 读取报告 + 对比基线 + 输出结论，**只读不改** |
| 每 10 分钟 | 服务器 crontab | `snowluma-health.sh`（既有） |
| 每 5 分钟 | 服务器 crontab | stargate 自启（云厂商既有） |

`crontab` 安装注意：`crontab -l | ... | crontab -` 在此环境不可靠，用"本地写文件 → scp → `crontab <file>`"。

---

## 四、代码结构速查

```
src/
  bridge.js            # 中枢（约 15k 行）：唯一持有状态与调度
  <domain>/<module>.js # 63 个域模块，14 个域（见 module-catalog.md）
  core/session-router.mjs
mods/<id>/             # mod 目录（loader 已就绪，挂点未接）
scripts/
  deploy.ps1           # 部署
  ops-daily-check.sh   # 巡检采集
  audit-bridge-harness.mjs  # 老测试的 vm 沙箱
  test-*.mjs           # 老测试
tests/<module>.test.mjs
docs/                  # 本文件 + 四份设计/目录文档
```

**模块五原则**（定稿，别违背）：中枢唯一状态与调度权 / 模块只提供能力 / 成本独立 / 守卫 fail open + 5 次熔断 / 每模块可单跑。

**硬约束**（契约 F 节 12 条，摘最常踩的）：不 import `bridge.js`、不读 `cfg`/`state`/`process.env`、
不写文件、不用 `Date.now()`/`Math.random()`、不 console.log、不起常驻定时器、不许空 catch。

---

## 五、当前状态（交接时）

| 项 | 值 |
| --- | --- |
| 线上版本 | 2026-10-29 12:37:29 起，`active` |
| 本地/远端 src | 94 / 94 文件，md5 完全一致 |
| 测试 | 618 通过；router 33 条；`test-voice` 83/0 |
| 模块 | 契约 63 个全部有处置：15 上线、8 判定不接（4 已删）、其余早已在跑；**无待接线** |
| 影子 | `session/router`、`inbound/message`、`scheduler/triggers` 均在跑，**分歧 0** |
| 历史裁剪 | `maxAgeHours=12`（原 24）；一次轮换把 owner 会话 460k → 41.6k（−91%） |
| 缓存 | 输入命中率 **98.8%** |

---

## 六、已知问题（都不影响运行，按需处理）

| 项 | 现象 | 备注 |
| --- | --- | --- |
| 轮换的 idle 闸时序 | 用户发消息**永远触发不了轮换**（`pushMessage` 先刷新 `lastIncomingAt`，判定再读它） | 目前靠主动唤醒触发；修法是用刷新前的旧值 |
| SnowLuma 抖动 | 约每 10 分钟 `good=false`，均 30 秒内自愈 | 抖动期间入站消息可能丢，属上游 |
| 归档 `topics` 为空 | 轮换快照里长期话题 0 条 | 可能 `activeTopics` 从未写入，影响长期记忆衔接 |
| 控制台令牌 | 启动日志"未配置，自动生成"；`/api/socialV2/rotation/preview` 401 | 进程内 token 与 `state/console-token` 不同步 |
| OCR 服务忙 | OneBot 返回 `code=200 msg=服务忙` | 桥已重试 3 次 |
| 双日志路径 | 见 2.3 | 排查时容易看错文件 |

---

## 七、待决策（需要产品判断）

1. 去掉「回复后立刻 `qq_wait_for_messages`」→ 省约 8% 调用，但她不再"等你补充"
2. 睡前观察 5 分钟 → 2 分钟 → 省 10~12%，但耐心变短
3. 是否扩大 `inbound/message` 影子（现在只比媒体归一）
4. 是否接 mod 挂点（`loader` 已就绪，空目录时是空转）

---

## 八、纪律（血泪换来的）

1. **改动前后都跑全量测试**；只改你用 `Read` 看过的文件。
2. **存量替换先写特征测试**，再影子（分歧只记日志不改行为），一致 24h 再切。
3. **会改判定语义的**（哪怕只差一个比较符）→ 不接；**收益趋零风险非零**的 → 不接。
4. **失败闭锁的路径**（`outbound/send`、`inbound/segments`、`auth/*`、`cost/gate`、`persist/atomic`）不给任何扩展点。
5. 部署只走 `deploy.ps1`；`crontab` 用 scp 文件方式；`.ps1` 带中文必须存 UTF-8 **带 BOM**（否则 PowerShell 5 解析失败）。
6. 影子只记分歧会导致"0 行日志"无法区分"一致"与"没跑"——接入时必须打一条"影子已接入（首条 …）"。

---

## 九、接手后第一小时建议做的三件事

```bash
ssh root@175.178.200.118 "systemctl is-active qq-bridge; tail -20 /root/dsh-run/bridge.log"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -DryRun -SkipTests   # 确认本地/远端一致
```

再读 `docs/roadmap.md` 的"每日观察节点"，对照今天的数据确认基线。
