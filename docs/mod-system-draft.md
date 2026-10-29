# qq-bridge mod 系统设计草案（v1）

> 2026-10-29 草案，未实现。目标：**像 Minecraft 装 mod 一样加能力**——丢一个目录、重启即生效，不改 `bridge.js` 一行。
> 与现有模块化的关系：`src/<域>/<模块>` 是**内置零件**（随主体发布、静态 import）；
> `mods/<id>` 是**外挂**（独立目录、动态加载、可单独开关与卸载）。

---

## 一、和 Minecraft 的对应关系

| MC 概念 | 本项目对应 | 现状 |
| --- | --- | --- |
| `mods/` 目录 | `mods/<mod-id>/` | 无 |
| `mod.json`（mod 元数据） | 同名清单：id/版本/依赖/入口/挂点 | 无（`spec` 只有模块自述，不参与加载） |
| Forge / Fabric 事件总线 | 扩展点（见第四节） | 无 |
| 依赖 `depends` + 加载顺序 | id + 版本区间 + 拓扑排序 | 无 |
| 模组配置 `config/` | `state/mod-config.json`（按 id 命名空间） | 无 |
| 启用/禁用模组 | 复用 `module-switch`（`mod:<id>` 为键） | ✅ 已有开关/审计/分级 |
| 资源包（纯数据） | `provide.content`（v2） | 无 |
| **Coremod / Mixin（改核心）** | **不允许** | 见第二节红线 |

---

## 二、第一条红线：mod 不能碰 fail-closed 路径

MC 里 mod 写崩了大不了游戏闪退重开；这里消息丢了收不回、权限漏了收不回。

**所以：**

- `outbound/send`、`inbound/segments`、`auth/*`、`cost/gate`、`persist/atomic` **不开放任何挂点**
- mod 挂点只允许出现在**观测 / 增强**位置，且默认行为是"失败即跳过"
- 每个挂点调用都包 `try/catch` + 超时；异常只 `ctx.log('warn')`，绝不向上抛
- mod **不得** import `bridge.js`、不得直接 `fs` 写 state、不得自建 socket（沿用契约 F 节全部 12 条）

一句话：**mod 可以让 AI 更好用，但不能让桥更容易坏。**

---

## 三、目录与清单

```
mods/
  weather-mood/
    mod.json
    index.js
    README.md          # 可选
```

`mod.json`：

```json
{
  "id": "weather-mood",
  "name": "天气影响心情",
  "version": "1.0.0",
  "apiVersion": "1",
  "entry": "./index.js",
  "depends": [{ "id": "content/mood", "version": ">=1.0.0" }],
  "hooks": ["tick.daily", "wake.before"],
  "level": "owner",
  "default": false,
  "config": {
    "city": { "type": "string", "default": "上海" },
    "influence": { "type": "number", "default": 0.3, "min": 0, "max": 1 }
  }
}
```

`index.js`：

```js
export default {
  setup(ctx) { /* 只做一次：读配置、预热缓存、声明副作用 */ },
  hooks: {
    'tick.daily': async (ctx, { now }) => { /* ... */ },
    'wake.before': (ctx, { key, prompt }) => ({ append: '今天下雨，说话可以懒一点' })
  }
};
```

**`apiVersion` 是硬门槛**：加载器只接受 `1`，其他值直接跳过并记账——避免以后改挂点签名时炸掉老 mod。

---

## 四、挂点（v1 只开 4 个）

| 挂点 | 时机 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| `inbound.observe` | 消息入库后 | 只读；返回 `{note}` 写审计 | 改文本、拦消息 |
| `outbound.observe` | 发送结果返回后 | 只读；记录成功/失败 | 重试、改内容 |
| `wake.before` | 组装唤醒提示时 | 返回 `{append}` 追加一段文本 | 删原文、超预算（超过 200 字截断） |
| `tick.daily` | 每日重置后 | 做自己的定时任务（单次 ≤ 200ms） | 常驻 `setInterval` |

**v2 候选（等 v1 稳定）**
- `provide.tool`：注册新的 MCP 工具。必须声明 `level`（free/owner/locked）与参数 schema，调用统一走 `ecoGate`——这也是 `tools/registry` 该建的那天
- `provide.content`：向 prompt 注入一段内容（新记忆源/新梗来源），受 token 预算与优先级约束
- `provide.guard`：新增出站守卫项，**只允许 fail open**

---

## 五、加载器行为（`src/mods/loader.js`，是内置能力模块，不是 mod）

启动时一次，顺序固定：

1. **扫描** `mods/*/mod.json`；JSON 坏了 → 跳过该 mod + `log('warn')`
2. **过滤**：`apiVersion !== '1'` → 跳过；`level: 'locked'` → 拒绝加载（locked 只属于内置）
3. **依赖解析**：按 `depends` 拓扑排序；缺依赖 → 跳过并在开关文件记 `offReason='missing-dep:<id>'`；成环 → 全部跳过并报一次
4. **开关判定**：读 `state/module-switches`（键 `mod:<id>`）；未记录时用 `mod.json` 的 `default`
5. **加载**：`await import(entry)`；`setup(ctx)` 抛错 → 跳过该 mod，已注册的挂点全部撤销
6. **注册挂点**：只注册 `hooks` 里声明过的名字；未声明的挂点即使 `index.js` 里有也不生效（防越权）

失败一律 **fail open**：少一个 mod ≠ 桥不能用。

---

## 六、隔离与预算

| 项 | 规则 |
| --- | --- |
| 单挂点异常 | 捕获 + 记账 + 该 mod 本次跳过，不影响其他 mod 与主链路 |
| 超时 | `tick.*` 单次 ≤ 200ms，超时记 `warn` 并跳过；`wake.before` 同步调用，不允许 async |
| 预算 | `wake.before` 追加文本合计 ≤ 200 字，超出截断并记账 |
| 频率 | `tick.daily` 每天一次；mod 自己不得起常驻定时器 |
| 卸载 | 从 `mods/` 删目录 + 重启；开关文件里残留条目按"已不存在"忽略（与 module-switch 现有规则一致） |

---

## 七、v1 明确不做

- **热加载**：ESM 模块缓存与"已注册工具的撤销"是两个坑，单独一轮再谈
- **mod 之间互相调用**：只能通过 `ctx` 与共享 state 命名空间，不允许 import 彼此
- **mod 改核心判定**：不开放 `send`/`segments`/`auth`/`cost` 挂点，没有 Mixin 等价物
- **mod 自带二进制/资源**：v1 只允许 JS + 纯数据 JSON

---

## 八、落地顺序（建议）

1. 写 `src/mods/loader.js` + 单测（发现、拓扑排序、缺依赖、apiVersion 拒绝、setup 抛错回滚、挂点白名单）
2. 中枢加 4 个挂点调用（每处 ≤ 3 行，外层 try/catch）
3. 用 1 个"示例 mod"验证全链路（建议选纯观测类，如"记录每天的发言数"）
4. 开关接进 `module-switch`（键 `mod:<id>`），控制台可列出
5. v2 再做 `provide.tool`（那天顺带建 `tools/registry`）与热加载
