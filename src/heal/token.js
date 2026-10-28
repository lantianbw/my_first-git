// heal/token — SnowLuma 令牌自愈：应用自愈结果、写回 config.json、带节流的自愈入口
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：cfg, log, now, discover   （optional：bot, persist, persistEndpoint）
// 失败策略：fail-open            （依据：D 表 heal/token「自愈失败只记日志，令牌由人处理」）
// 单测：tests/heal-token.test.mjs
//
// 为什么搬：这三段代码原本内联在 bridge.js 的 SnowLuma 启动段，和 cfg / bot / 日志 / config.json
// 路径搅在一起，于是「HTTP token 与 WS token 是两个值」「端点跟随要能关」「写盘失败不能影响连接」
// 这三条硬经验只活在一个 900KB 的文件里，谁也不敢动。搬到模块后接缝变成「结果进、写盘出」，
// 时钟（now）、发现器（discover）、写盘器（persist / persistEndpoint）全部可注入，
// 于是「节流」「幂等」「写盘失败只记日志」都能用 `node --test` 单跑验证，不需要真连 SnowLuma。
//
// 为什么需要（事故面，逐条对应代码）：
//   ① SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），换账号后旧 token 直接 401，
//      而 SDK 的重连会用**构造时**那个 token 无限重试 —— 表现为「桥接活着但收发全废」。
//   ② **HTTP token 与 WS token 是两个不同的值**：cfg.snowluma.accessToken 供 HTTP 调用（发语音、
//      fetch_ptt_text、get_msg）并写回 config.json；bot.accessToken 供 WebSocket。只修一个仍会 1006。
//   ③ 端口也是 per-account 的（换账号后 WS 从 3001 变到别的端口），只换 token 不换 URL 会一直重连。
//   ④ 端点覆盖必须可关（snowluma.followDiscoveredEndpoint=false）：否则「我就是要指向 B」会被
//      自愈静默改回 A，表现为「消息发到了另一个账号」，极难归因。
//   ⑤ 日志会被贴进 issue / 截图，**前 4 个字符同样是凭据的一部分**（CWE-532，见 PR #13）：
//      只允许打印 `xxxx…`，本模块任何日志都不出现完整令牌。
//
// 边界：不自己联网（discover 由中枢注入，默认委托 src/snowluma-conn.js）、不自己拼 config 路径
// （configPath 由中枢注入）、不 import bridge.js、不在 import 时产生副作用、不注册定时器。
// 节流状态只活在本实例的闭包里（一个进程一个实例），不写 state 文件。

import {
  discoverSnowLumaConnection,
  persistSnowLumaEndpoint,
  persistToken
} from '../snowluma-conn.js';

/** close 事件会连续触发，10s 内的重复自愈一律不跑（与旧实现同值）。 */
const THROTTLE_MS = 10_000;

/** 发现超时：4s 足够覆盖「端口没起」的快速失败，又不至于把启动拖长。 */
const DISCOVER_TIMEOUT_MS = 4_000;

/** 日志里允许出现的令牌前缀长度（CWE-532：只留 4 位 + 省略号）。 */
const TOKEN_PREFIX = 4;

export const spec = Object.freeze({
  name: 'heal/token',
  version: '1.0.0',
  deps: Object.freeze(['cfg', 'log', 'now', 'discover']),
  optionalDeps: Object.freeze(['bot', 'persist', 'persistEndpoint']),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** 令牌一律当字符串看：null/undefined 归一成空串，首尾空白不算内容。 */
const clean = (value) => (value == null ? '' : String(value).trim());

/** 只给日志看的掩码：`abcd…`；空令牌给 `(空)`。 */
const mask = (value) => {
  const token = clean(value);
  return token ? `${token.slice(0, TOKEN_PREFIX)}…` : '(空)';
};

/**
 * 造一个自愈实例。
 *
 * 之所以是工厂而不是模块级函数：节流时间戳（lastHealAt）必须跟着实例走，
 * 模块级 `let` 会跨调用/跨测试泄漏状态（F.2），且无法注入假时钟验证节流。
 *
 * @param {object}        opts
 * @param {object}        opts.cfg             中枢配置（只读写 snowluma.* 这几项）
 * @param {object|null}   [opts.bot]           SnowLuma SDK 客户端（缺了只改 cfg，不碰连接）
 * @param {Function}      [opts.log]           `log(message)`，单参数（与 onebot-retry 同口径）
 * @param {Function}      [opts.now]           `() => ms`，默认 Date.now；测试注入假时钟
 * @param {Function}      [opts.discover]      `({cfg, timeoutMs}) => Promise<结果>`，默认 snowluma-conn
 * @param {Function}      [opts.persist]       `(cfgPath, token) => {updated}`，默认 snowluma-conn
 * @param {Function}      [opts.persistEndpoint] `(cfgPath, {accessToken,wsUrl,httpUrl}) => {updated,changed}`
 * @param {string}        [opts.configPath]    写回目标；为空则跳过所有写盘（降级）
 * @param {number}        [opts.throttleMs]    自愈节流窗口，默认 10000
 * @returns {{ applyHealedTokens: Function, syncTokenToFile: Function, healTokenIfStale: Function,
 *            resetThrottle: Function, handle: Function, throttleMs: number }}
 */
export function createTokenHeal({
  cfg = null,
  bot = null,
  log = null,
  now = () => Date.now(),
  discover = discoverSnowLumaConnection,
  persist = persistToken,
  persistEndpoint = persistSnowLumaEndpoint,
  configPath = '',
  throttleMs = THROTTLE_MS
} = {}) {
  if (!cfg || typeof cfg !== 'object') {
    throw new TypeError('createTokenHeal: cfg 必填（需要一个可读写的配置对象）');
  }
  if (typeof discover !== 'function') {
    throw new TypeError('createTokenHeal: discover 必填（deps: discover）');
  }

  const clock = typeof now === 'function' ? now : () => Date.now();
  const window = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : THROTTLE_MS;

  // 上次自愈时刻。用 -Infinity 而不是 0：假时钟从 0 开始时，`0 - 0 < 10000` 会把第一次自愈吞掉。
  let lastHealAt = Number.NEGATIVE_INFINITY;

  /** 日志降级：日志自身抛错绝不能带走自愈（F.5 的例外，与 obs/log 同一条理由）。 */
  function emit(message) {
    if (typeof log !== 'function') return;
    try {
      log(message);
    } catch {
      // 日志坏了也不能让自愈链断在这里；没有第二个地方可记，只能咽下。
    }
  }

  /** cfg.snowluma 缺了就地补一个空对象（只碰这一个字段，不动其它配置）。 */
  function snowluma() {
    if (!cfg.snowluma || typeof cfg.snowluma !== 'object') cfg.snowluma = {};
    return cfg.snowluma;
  }

  /**
   * 应用一次自愈结果。
   *
   * 返回值是「WS 连接参数是否变了」——变了才会 close/connect，没变就一个动作都不做，
   * 这样 close 事件连续触发时不会把连接反复掐断（幂等的关键）。
   *
   * @param {object} result discover 的返回：{ok, token, wsToken, wsUrl, baseUrl, source, self}
   * @returns {Promise<boolean>} 是否重连过
   */
  async function applyHealedTokens(result) {
    const r = result && typeof result === 'object' ? result : {};
    const sl = snowluma();

    // 空令牌保护：上游没给出可用令牌时**绝不覆盖**现有配置。旧实现在这里会把
    // cfg.snowluma.accessToken 写成 undefined，一次误判就把能用的凭据抹掉了。
    const httpToken = clean(r.token);
    if (!httpToken) {
      emit('⚠️ token 自愈结果为空（上游没有给出可用令牌），保持原值不动');
      return false;
    }
    const wsToken = clean(r.wsToken) || httpToken;

    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL：
    // 否则「我就是要指向另一份 SnowLuma」会被自愈持久化地抹掉。
    const followEndpoint = sl.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (clean(r.wsUrl) || clean(sl.wsUrl)) : clean(sl.wsUrl);

    const wsChanged = !!bot && (bot.accessToken !== wsToken || bot.url !== wsUrl);
    if (bot) {
      bot.accessToken = wsToken || undefined;
      // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
      // 只换 token 不换 URL 会一直 1006 重连。
      bot.url = wsUrl;
      if (wsChanged) emit(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${mask(wsToken)}）`);
    } else {
      emit('   （未注入 bot：只更新 cfg.snowluma.accessToken，连接对象由调用方自行刷新）');
    }

    if (clean(sl.accessToken) !== httpToken) {
      emit(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source ?? '未知'}）：${mask(sl.accessToken)} → ${mask(httpToken)}`);
      sl.accessToken = httpToken;
    }
    if (!followEndpoint && clean(r.wsUrl) && clean(r.wsUrl) !== clean(sl.wsUrl)) {
      emit(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${sl.wsUrl}）`);
    }

    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // 写文件时对照的是**文件里**的旧值，所以这里显式传 wsUrl，不拿 cfg 的内存值当判据；
    // 关掉端点跟随时不传 URL，且写完把内存值还原，保证「用户设的别处」不被抹掉。
    const previousWsUrl = sl.wsUrl;
    sl.wsUrl = wsUrl;
    if (!configPath || typeof persistEndpoint !== 'function') {
      emit('   （未注入写回能力，跳过 config.json 写回）');
    } else {
      try {
        const written = persistEndpoint(configPath, {
          accessToken: httpToken,
          ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
        });
        if (written?.updated) emit(`   已写回 config.json：${Object.keys(written.changed ?? {}).join(' / ')}`);
        else emit('   config.json 端点已是最新，无需改写');
      } catch (error) {
        // 写盘失败只影响「下次启动要不要再自愈一遍」，连接已经用新参数了，不能抛。
        emit(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
      }
    }
    if (!followEndpoint && previousWsUrl !== wsUrl) sl.wsUrl = previousWsUrl;

    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try {
        bot.close(1000, 'token-refresh');
      } catch (error) {
        emit(`   ⚠️ 关闭旧连接失败：${error?.message ?? error}`);
      }
      try {
        bot.connect();
      } catch (error) {
        emit(`   ⚠️ 用新参数重连失败：${error?.message ?? error}`);
      }
    }
    return wsChanged;
  }

  /**
   * 只写文件、不动物件（连接已成功时用）。
   *
   * 失败策略 fail-open：写不进去等于「下次启动可能要多自愈一遍」，绝不能把 open 事件带崩。
   *
   * @returns {Promise<boolean>} 是否真的改写了文件
   */
  async function syncTokenToFile() {
    const token = clean(snowluma().accessToken);
    if (!token) {
      emit('⚠️ 当前没有可写回的 token（snowluma.accessToken 为空），跳过');
      return false;
    }
    if (!configPath || typeof persist !== 'function') {
      emit('   （未注入写回能力，跳过 token 写回）');
      return false;
    }
    try {
      const written = persist(configPath, token);
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图（CWE-532，见 PR #13）。
      if (written?.updated) emit('🔄 已把当前 token 写回 config.json');
      return written?.updated === true;
    } catch (error) {
      emit(`⚠️ 写回 config.json 失败（不影响连接）：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 自愈一次 token：成功 true；失败或被节流 false。重试由 onebot-retry 统一排。
   *
   * @param {string} [reason] 触发原因（`retry` / `close code=1006` / `error ...`），只进日志
   * @returns {Promise<boolean>}
   */
  async function healTokenIfStale(reason = 'unspecified') {
    const at = Number(clock());
    const stamp = Number.isFinite(at) ? at : 0;
    if (stamp - lastHealAt < window) return false;   // 节流：close/error 事件会连续触发
    lastHealAt = stamp;
    try {
      const r = await discover({ cfg, timeoutMs: DISCOVER_TIMEOUT_MS });
      if (!r?.ok) {
        emit(`⚠️ token 自愈失败（${reason}）：${r?.error ?? '上游未返回原因'}`);
        return false;
      }
      await applyHealedTokens(r);
      emit(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
      return true;
    } catch (error) {
      emit(`⚠️ token 自愈异常：${error?.message ?? error}`);
      return false;
    }
  }

  /** 清零节流：到点的重试必须真跑一次，否则「到点」会被节流吞掉（bridge 的 retryOnebot 用）。 */
  function resetThrottle() {
    lastHealAt = Number.NEGATIVE_INFINITY;
    return true;
  }

  /**
   * 契约门面（B.1/B.2）。四个动作：apply / sync / heal / reset。
   *
   * @param {object} _ctx
   * @param {{ action?: 'apply'|'sync'|'heal'|'reset', result?: object, reason?: string }} args
   * @returns {Promise<{ok:true, value:boolean}|{ok:false, code:string, error:string}>}
   */
  async function handle(_ctx, args = {}) {
    const action = args?.action ?? 'heal';
    if (action === 'apply') return { ok: true, value: await applyHealedTokens(args?.result) };
    if (action === 'sync') return { ok: true, value: await syncTokenToFile() };
    if (action === 'heal') return { ok: true, value: await healTokenIfStale(args?.reason ?? 'handle') };
    if (action === 'reset') return { ok: true, value: resetThrottle() };
    return { ok: false, code: 'INVALID_ARGS', error: `未知动作：${String(action)}（只支持 apply / sync / heal / reset）` };
  }

  return { applyHealedTokens, syncTokenToFile, healTokenIfStale, resetThrottle, handle, throttleMs: window };
}
