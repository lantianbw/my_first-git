// session/queue — 合并「已挂起的唤醒原因」与「新来的原因」，只留最高优先级的那一个
//
// 契约：docs/module-contract.md v1.1（B.1 spec / A.5 scheduler/wake 的 wakePriorityV2 语义 / H2）
// deps：无                       （optional：无）
// 失败策略：fail-open            （依据：D 表 scheduler/wake「漏一次唤醒，下条消息仍会触发投递」）
// 单测：tests/queue.test.mjs
//
// 为什么需要：桥每次只能给一个会话挂一个待唤醒原因（socialV2.pendingWakeReasons），但繁忙期间
// 新原因是会排队进来的：一条 @ 消息、一个 timeout 定时器、一次主动机会。现在的做法是数组 FIFO，
// 补发时逐条 shift 出来（bridge.js:14398 replayPendingWakeReasonsV2），低优先级的原因会在队列里
// 越堆越多、并且可能压住更重要的那条。这里把「留谁」这件事抽成一个纯函数：
// 给一组已挂起原因 + 一组新原因 + 一个优先级函数，得到唯一该保留的原因，以及被丢掉的是哪些。
//
// 边界：不调度、不排队、不存状态、不读时钟、不知道 reason 的业务含义（优先级完全由调用方注入）。
// 只回答「这一次合并之后留谁」。
//
// 语义细则（未在需求里定义的部分，这里显式定死）：
//   · 同优先级保留原值：两侧打平时留下先出现的那个，而 pending 排在前面，所以等价于"保留原"。
//   · 空 pending 不算升级：upgraded 表示"新原因把已有的抬高了"，没有已有时填槽不叫抬高；
//     reason 仍然会被填成新原因，调用方按 reason 是否变化决定要不要重排。
//   · priorityOf 抛错/返回非有限数 → 该原因优先级记为"未知"：未知不能顶掉已挂起的原因
//     （保留原值），但可以作为空槽的填充；它一定出现在 dropped 里，异常不会被静默吞掉。
//   · dropped 是「除最终 winner 之外的全部候选」（两侧合并、保序、去重），不是只有新来的那些。

export const spec = Object.freeze({
  name: 'session/queue',
  version: '1.0.0',
  deps: Object.freeze([]),
  optionalDeps: Object.freeze([]),
  guards: Object.freeze([]),
  toggle: Object.freeze({ level: 'owner', default: true, hot: true })
});

/** 归一成字符串数组：单值/数组都收，null/undefined/空串视为没有。 */
function toReasons(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const text = typeof item === 'string' ? item : String(item);
    if (text === '') continue;
    out.push(text);
  }
  return out;
}

/**
 * 取优先级；抛错或非有限数返回 null（= 未知）。
 * 这里刻意不向上抛：一个算不出优先级的原因不该让整次唤醒合并失败，
 * 后果（它没能顶上去）会通过 dropped 如实回传给调用方。
 */
function prioritySafe(priorityOf, reason) {
  try {
    const value = Number(priorityOf(reason));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 最高优先级的下标；同分取先出现的（pending 在前 ⇒ 自然"保留原"）。全未知返回 -1。 */
function bestIndexOf(prios) {
  let index = -1;
  let best = -Infinity;
  for (let i = 0; i < prios.length; i += 1) {
    const p = prios[i];
    if (p === null) continue;
    if (p > best) {
      best = p;
      index = i;
    }
  }
  return index;
}

/** 保序去重。 */
function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 合并待处理原因。
 *
 * @param {object}   input
 * @param {string|string[]|null} [input.pending]  已挂起的原因（通常一个，允许多个）
 * @param {string|string[]|null} [input.incoming] 新来的原因
 * @param {(reason: string) => number} input.priorityOf 理由 -> 数字，越大越重要
 * @returns {{ reason: string|null, upgraded: boolean, dropped: string[] }}
 */
export function mergePending({ pending, incoming, priorityOf } = {}) {
  if (typeof priorityOf !== 'function') {
    throw new TypeError('mergePending: 必须注入 priorityOf(reason)');
  }

  const pend = toReasons(pending);
  const inc = toReasons(incoming);
  const pendPrio = pend.map((r) => prioritySafe(priorityOf, r));
  const incPrio = inc.map((r) => prioritySafe(priorityOf, r));

  let winner = null;
  let upgraded = false;

  if (pend.length === 0) {
    // 空槽：新原因直接填入；没有可比的原值，所以不算"升级"
    const incBest = bestIndexOf(incPrio);
    winner = incBest >= 0 ? inc[incBest] : (inc.length > 0 ? inc[0] : null);
  } else {
    const pendBest = bestIndexOf(pendPrio);
    const baseIndex = pendBest >= 0 ? pendBest : 0; // 全未知时保住原值的第一个
    const basePrio = pendPrio[baseIndex];
    const incBest = bestIndexOf(incPrio);

    // 只有「新原因优先级严格更高」才升级；未知优先级（null）永远顶不掉已挂起的原因
    if (incBest >= 0 && basePrio !== null && incPrio[incBest] > basePrio) {
      winner = inc[incBest];
      upgraded = true;
    } else {
      winner = pend[baseIndex];
    }
  }

  const dropped = winner === null ? unique([...pend, ...inc]) : unique([...pend, ...inc].filter((r) => r !== winner));

  return { reason: winner, upgraded, dropped };
}
