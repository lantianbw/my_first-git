import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { spec, createChain } from '../src/guards/chain.js';

// 固定假时钟：本模块不读 Date.now()，所有时间都由 now 注入。
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** 测试台：假时钟 + 日志探针，全部经注入提供。 */
function harness({ tripAfter = 5, halfOpenMs = 300_000 } = {}) {
  let t = NOW;
  const logs = [];
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    }
  };
  const chain = createChain({
    log: (level, message, meta) => logs.push({ level, message, meta, at: t }),
    now: clock.now,
    tripAfter,
    halfOpenMs
  });
  return { chain, clock, logs, warns: () => logs.filter((l) => l.level === 'warn') };
}

const boom = () => {
  throw new Error('boom');
};

test('spec：契约字段齐备且已冻结（B.1 / H2 locked）', () => {
  assert.equal(spec.name, 'guards/chain');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, ['log', 'now']);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'locked', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
});

test('缺依赖：log / now 缺失或非法参数一律不装配（B.3 规则 1）', () => {
  const ok = () => {};
  assert.throws(() => createChain({ now: ok }), /缺少必需依赖 log/);
  assert.throws(() => createChain({ log: ok }), /缺少必需依赖 now/);
  assert.throws(() => createChain({ log: ok, now: ok, tripAfter: 0 }), /tripAfter/);
  assert.throws(() => createChain({ log: ok, now: ok, tripAfter: 2.5 }), /tripAfter/);
  assert.throws(() => createChain({ log: ok, now: ok, halfOpenMs: -1 }), /halfOpenMs/);
  assert.throws(() => createChain({ log: ok, now: ok, halfOpenMs: NaN }), /halfOpenMs/);
});

test('正常路径：原样返回结果、失败计数为零、不产生 warn', () => {
  const { chain, warns } = harness();

  assert.equal(chain.run('outbound.length', () => 'ok', 'fallback'), 'ok');

  const st = chain.status('outbound.length');
  assert.equal(st.state, 'closed');
  assert.equal(st.failures, 0);
  assert.equal(st.tripped, false);
  assert.equal(chain.isTripped('outbound.length'), false);
  assert.equal(warns().length, 0);

  // 未知 name 的只读查询不建槽、不报错
  assert.equal(chain.isTripped('never.called'), false);
  assert.equal(chain.status('never.called').state, 'closed');
});

test('单项失败跳过：只降级该 name，返回 fallback，不连坐其它项', () => {
  const { chain, warns } = harness();
  let calls = 0;
  const fail = () => {
    calls += 1;
    throw new Error('redis down');
  };

  assert.equal(chain.run('outbound.cache', fail, 'MISS'), 'MISS');
  assert.equal(calls, 1);

  const st = chain.status('outbound.cache');
  assert.equal(st.failures, 1);
  assert.equal(st.state, 'closed', '未达阈值不熔断');
  assert.equal(st.lastError, 'redis down');

  // 隔壁守卫照常工作，且不受本项失败影响
  assert.equal(chain.run('outbound.length', () => 'ok', 'MISS'), 'ok');
  assert.equal(chain.status('outbound.length').failures, 0);
  assert.equal(chain.status('outbound.cache').failures, 1);

  assert.equal(warns().length, 1);
  assert.match(warns()[0].message, /outbound\.cache/);
  assert.match(warns()[0].message, /1\/5/);
});

test('连续 5 次失败触发熔断，之后 run 直接返回 fallback 且不再调用 fn', () => {
  const { chain, warns } = harness({ tripAfter: 5 });
  let calls = 0;
  const fail = () => {
    calls += 1;
    throw new Error('502');
  };

  for (let i = 1; i <= 5; i += 1) assert.equal(chain.run('outbound.content', fail, 'DEGRADED'), 'DEGRADED');
  assert.equal(calls, 5);
  assert.equal(chain.isTripped('outbound.content'), true);

  const tripped = chain.status('outbound.content');
  assert.equal(tripped.state, 'open');
  assert.equal(tripped.failures, 5);
  assert.equal(tripped.trips, 1);
  assert.equal(tripped.retryInMs, 300_000);

  // 熔断后 fn 即使能成功也不允许被调用
  const wouldSucceed = () => {
    calls += 1;
    return 'ok';
  };
  assert.equal(chain.run('outbound.content', wouldSucceed, 'DEGRADED'), 'DEGRADED');
  assert.equal(chain.run('outbound.content', wouldSucceed, 'DEGRADED'), 'DEGRADED');
  assert.equal(calls, 5, '熔断期间 fn 一次都不应被调用');
  assert.equal(chain.status('outbound.content').trips, 1, '重复拒绝不重复累计熔断次数');

  // 5 次失败 warn + 1 次熔断 warn + 2 次熔断期拒绝 warn
  assert.equal(warns().length, 8);
  assert.equal(warns().filter((l) => /失败（\d\/5），跳过/.test(l.message)).length, 5);
  assert.equal(warns().filter((l) => /熔断 300000ms/.test(l.message)).length, 1);
  assert.equal(warns().filter((l) => /熔断中，跳过/.test(l.message)).length, 2);
});

test("policy:'closed'：失败与熔断都返回 { blocked, reason }，不静默降级", () => {
  const { chain } = harness({ tripAfter: 2 });
  let calls = 0;
  const fail = () => {
    calls += 1;
    throw new Error('payment refused');
  };

  // 首次失败（未熔断）→ 被拒绝
  const first = chain.run('auth.silent', fail, 'FALLBACK', 'closed');
  assert.equal(typeof first, 'object');
  assert.equal(first.blocked, true);
  assert.equal(first.reason, 'exec-error: payment refused');
  assert.notEqual(first, 'FALLBACK', '不得返回 fallback');
  assert.equal(calls, 1);

  // 达到阈值 → 熔断，本次仍是被拒绝
  assert.equal(chain.run('auth.silent', fail, 'FALLBACK', 'closed').blocked, true);
  assert.equal(chain.isTripped('auth.silent'), true);
  assert.equal(calls, 2);

  // 熔断后 → 直接拒绝，且 fn 不再被调用
  assert.deepEqual(chain.run('auth.silent', () => 'should-not-run', 'FALLBACK', 'closed'), {
    blocked: true,
    reason: 'circuit-open'
  });
  assert.equal(calls, 2);

  // 同 name 换回默认策略 → 回到静默 fallback
  assert.equal(chain.run('auth.silent', () => 'x', 'FALLBACK'), 'FALLBACK');
  assert.equal(calls, 2);
});

test('半开：熔断满 halfOpenMs 后试探成功 → 解除熔断并清零计数', () => {
  const { chain, clock } = harness({ tripAfter: 5, halfOpenMs: 300_000 });
  let healthy = false;
  let calls = 0;
  const fn = () => {
    calls += 1;
    if (!healthy) throw new Error('timeout');
    return 'recovered';
  };

  for (let i = 0; i < 5; i += 1) chain.run('outbound.content', fn, 'FB');
  assert.equal(chain.isTripped('outbound.content'), true);
  assert.equal(calls, 5);

  // 差 1ms：仍是熔断态，不放行
  clock.advance(299_999);
  assert.equal(chain.status('outbound.content').state, 'open');
  assert.equal(chain.status('outbound.content').retryInMs, 1);
  assert.equal(chain.run('outbound.content', fn, 'FB'), 'FB');
  assert.equal(calls, 5, '窗口未满不得试探');

  // 恰好满窗口：转 half-open，放行一次试探
  clock.advance(1);
  assert.equal(chain.status('outbound.content').state, 'half-open');
  healthy = true;
  assert.equal(chain.run('outbound.content', fn, 'FB'), 'recovered');
  assert.equal(calls, 6, '试探真实调用了一次 fn');

  const st = chain.status('outbound.content');
  assert.equal(st.tripped, false);
  assert.equal(st.state, 'closed');
  assert.equal(st.failures, 0, '试探成功清零失败计数');
  assert.equal(chain.isTripped('outbound.content'), false);

  // 完全恢复：后续照常调用
  assert.equal(chain.run('outbound.content', fn, 'FB'), 'recovered');
  assert.equal(calls, 7);
});

test('半开：试探失败 → 保持熔断并按该次失败重新计时', () => {
  const { chain, clock } = harness({ tripAfter: 5, halfOpenMs: 300_000 });
  let calls = 0;
  const fail = () => {
    calls += 1;
    throw new Error('still broken');
  };

  for (let i = 0; i < 5; i += 1) chain.run('outbound.content', fail, 'FB');
  assert.equal(calls, 5);
  assert.equal(chain.status('outbound.content').retryInMs, 300_000);

  // 满窗口 → 试探一次，失败
  clock.advance(300_000);
  assert.equal(chain.run('outbound.content', fail, 'FB'), 'FB');
  assert.equal(calls, 6, '失败前确实试探了一次');
  assert.equal(chain.isTripped('outbound.content'), true, '试探失败不得解除熔断');

  const afterProbe = chain.status('outbound.content');
  assert.equal(afterProbe.state, 'open');
  assert.equal(afterProbe.failures, 6);
  assert.equal(afterProbe.retryInMs, 300_000, '以本次失败时刻重新计时');

  // 旧窗口早已过期，新窗口还差 1ms → 不许试探
  clock.advance(299_999);
  assert.equal(chain.run('outbound.content', fail, 'FB'), 'FB');
  assert.equal(calls, 6, '重新计时未满不得试探');

  // 新窗口满 → 再次放行试探
  clock.advance(1);
  assert.equal(chain.status('outbound.content').state, 'half-open');
  assert.equal(chain.run('outbound.content', fail, 'FB'), 'FB');
  assert.equal(calls, 7, '重新计时结束后允许下一次试探');
});

test('禁用清单：源码不碰真实时间/随机数/console，import 无副作用（F.7 F.8 F.12）', () => {
  const src = readFileSync(new URL('../src/guards/chain.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(/Date\.now\s*\(/.test(code), false, '不得使用 Date.now()');
  assert.equal(/new Date\s*\(/.test(code), false, '不得直接读系统时间');
  assert.equal(/Math\.random\s*\(/.test(code), false, '不得使用 Math.random()');
  assert.equal(/console\s*\./.test(code), false, '不得使用 console');
  assert.equal(/from\s+['"][^'"]*bridge\.js['"]/.test(code), false, '不得 import bridge.js');
  assert.equal(/process\.env/.test(code), false, '不得直接读 process.env');
  assert.deepEqual(Object.keys({ spec, createChain }).sort(), ['createChain', 'spec']);
});
