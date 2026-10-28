// scheduler/wake — 唤醒原因的优先级表与纯查表判定
//
// 契约：docs/module-contract.md v1.1（export spec + handle）
// deps：cfg, now        （optional：none）
// 失败策略：fail-open         （依据：D 表 `scheduler/wake` 行）
// 单测：tests/scheduler-wake.test.mjs
//
// 为什么需要：唤醒优先级表决定「同一合并窗口里先概率后 @ 会不会被降级成概率唤醒」，
// 表与查表规则原本内嵌在中枢，改一个数字没有任何测试拦得住；抽出后可单测。
// 边界：不排定时器、不写 state、不发消息——只回答"这个唤醒原因值多少分"。

export const spec = Object.freeze({
  name: 'scheduler/wake',
  version: '1.0.0',
  deps: ['cfg', 'now'],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

/**
 * 唤醒原因 → 优先级（数值越大越优先）。
 *
 * 语义：合并窗口内已有待发唤醒时，只有**更高**优先级的原因才会覆盖上一个，
 * 避免「先概率唤醒、后 @ 唤醒」被合并成概率（那样 @ 就白丢了）。
 * 0 表示未登记的基名，永远不覆盖任何已登记原因。
 */
export const WAKE_PRIORITY = Object.freeze({
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  diarySettle: 38,
  lifeMorning: 35,
  timeout: 30,
  weeklyDigest: 26,
  lifeDiscovery: 25,
  proactiveCheck: 20
});

/**
 * 与「未读消息」无关的唤醒原因（定时器 / 引导）。
 *
 * 这些原因在会话繁忙时被暂存后，不能用「unread 里还有没有对应 seq」判断是否补发：
 * 那一轮很可能已经把未读全部标读，结果 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
 */
export const TIMER_WAKE_REASONS = Object.freeze([
  'timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin',
  'lifeMorning', 'lifeDiscovery', 'diarySettle', 'weeklyDigest'
]);

/** 唤醒原因可能带子类型（如 `keyword:小鲸鱼`、`speaker:昵称`）：一律只取冒号前的基名。 */
export function wakeReasonBase(reason) {
  return String(reason ?? '').split(':')[0];
}

/** 查优先级；未登记返回 0（不覆盖任何已登记原因）。 */
export function wakePriority(reason) {
  const p = WAKE_PRIORITY[wakeReasonBase(reason)];
  return typeof p === 'number' ? p : 0;
}

/** 是否为定时器类唤醒原因。 */
export function isTimerWakeReason(reason) {
  return TIMER_WAKE_REASONS.includes(wakeReasonBase(reason));
}

/**
 * 合并窗口内的升级判定：incoming 是否应替换 current。
 *
 * @returns {{ reason: string, upgraded: boolean }} upgraded=false 时 reason 为原值
 */
export function mergeWakeReason(current, incoming) {
  return wakePriority(incoming) > wakePriority(current)
    ? { reason: incoming, upgraded: true }
    : { reason: current, upgraded: false };
}

/** 契约门面。 */
export function handle(ctx, args = {}) {
  const action = String(args.action ?? 'priority');
  if (action === 'priority') return { ok: true, value: wakePriority(args.reason) };
  if (action === 'timer') return { ok: true, value: isTimerWakeReason(args.reason) };
  if (action === 'merge') {
    const merged = mergeWakeReason(args.current, args.incoming);
    return { ok: true, value: merged };
  }
  return { ok: false, code: 'INVALID_ARGS', error: `未知 action：${action}` };
}
