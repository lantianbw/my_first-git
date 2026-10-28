// lifecycle/shutdown — 把「收尾任务清单」排成一个执行计划（纯函数，不执行任何任务）
//
// 契约：docs/module-contract.md v1.1（A.1 lifecycle/shutdown / B.1 spec / D 表 lifecycle/shutdown「fail open（尽力）」/ H2 locked）
// deps：无                       （optional：无）
// 失败策略：fail-open            （依据：D 表 lifecycle/shutdown「释放锁失败只影响下次启动的 PID 校验」）
// 单测：tests/shutdown.test.mjs
//
// 为什么需要：现在的 SIGINT/SIGTERM 是写死的三行（saveState → releaseLock → process.exit(0)，
// bridge.js:15998），谁先谁后只能靠读代码确认；以后再加「先停 WS 再存盘」「等队列排空」时，
// 顺序会散落在各处的事件回调里。这里把顺序变成可单测的数据：给一组 {name, phase, timeoutMs}，
// 得到执行顺序 + 总超时预算，以及一个「你是不是把注册顺序当成了执行顺序」的信号。
//
// 边界：不注册信号、不调用 process.exit、不执行任务、不读时钟、不写日志。只排计划。
//
// 阶段（phase 小的先跑）：
//   1 network  —— 先断开进站连接，别让新消息继续涌进来
//   2 session  —— 等在途会话收尾（发完最后一条、释放会话锁）
//   3 persist  —— 落盘（state / socialV2 / 审计），此时已没有并发写
//   4 exit     —— 释放 PID 锁、决定退出码
//   缺省与越界：phase 缺失/非数字 → 4（不知道归哪段就放最后，不抢在落盘前面）；
//   越界一律夹到 1~4，而不是丢弃该任务。
//
// inverted：入参顺序恰好是执行顺序的倒序时置 true —— 说明调用方是按「注册即入栈、
// 退出时出栈」（LIFO）的习惯传的。它不是错误，只是让接线处不必再猜方向；长度 ≤ 1 时
// 无所谓正逆，恒为 false。

const MIN_PHASE = 1;
const MAX_PHASE = 4;
const DEFAULT_PHASE = 4;

export const spec = Object.freeze({
  name: 'lifecycle/shutdown',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'locked', default: true, hot: true })
});

/** phase 归一：非数字走缺省，越界夹紧，小数四舍五入。 */
function phaseOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PHASE;
  return Math.min(MAX_PHASE, Math.max(MIN_PHASE, Math.round(n)));
}

/** 超时归一：非法/负数按 0 计，不让一条坏数据把总预算变成 NaN。 */
function timeoutOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const sameOrder = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * 排出收尾执行计划。
 *
 * @param {Array<{name?: string, phase?: number, timeoutMs?: number}>} tasks
 * @returns {{ order: string[], totalTimeoutMs: number, inverted: boolean }}
 */
export function planShutdown(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('planShutdown: tasks 必须是数组');
  }

  const items = [];
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return;
    const name = typeof task.name === 'string' && task.name !== '' ? task.name : `#${index}`;
    items.push({
      name,
      phase: phaseOf(task.phase),
      timeoutMs: timeoutOf(task.timeoutMs),
      index
    });
  });

  // 显式用 index 做次级键：不依赖引擎的 sort 是否稳定（同 phase 必须保持入参顺序）
  const order = items
    .slice()
    .sort((a, b) => a.phase - b.phase || a.index - b.index)
    .map((item) => item.name);

  const totalTimeoutMs = items.reduce((sum, item) => sum + item.timeoutMs, 0);
  const names = items.map((item) => item.name);
  const inverted = names.length > 1 && sameOrder(names.slice().reverse(), order);

  return { order, totalTimeoutMs, inverted };
}
