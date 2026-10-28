// inbound/command — 解析管理命令前缀（/role /silent /active /reset /status）
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-closed          （依据：D 表 inbound/command「命令解析错 = 越权执行」）
// 单测：tests/command.test.mjs
//
// 为什么需要：bridge.js 里那 5 个命令是逐条 `=== '/xxx'` 硬编码的，加一个命令就要改中枢，
// 而且 `/role 学姐` 与 `/reset` 的「带参数 / 不带参数」判定各写各的。这里把「这到底是不是
// 管理命令、规范名是什么、参数是什么」收敛成一个纯函数，中枢只负责执行。
// 边界：只解析，不鉴权（是否主人仍由中枢判定）、不执行、不读写 state、不 import bridge。

export const spec = Object.freeze({
  name: 'inbound/command',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

/** 规范命令名（大小写敏感，只认这些字面量）。 */
const COMMANDS = Object.freeze({
  role: 'role',
  silent: 'silent',
  active: 'active',
  reset: 'reset',
  status: 'status'
});

/** bridge.js 现有等价别名，折叠到规范名，避免 `/quiet` 被当成未知命令漏到 DSH。 */
const ALIASES = Object.freeze({ new: 'reset', quiet: 'silent', speak: 'active' });

function parseArgs(rest) {
  const text = rest.trim();
  return text ? text.split(/\s+/) : [];
}

/**
 * @pure 解析一条入站文本的管理命令。
 * - 只认行首 `/`：前导空格、正文里带斜杠都不算命令；
 * - 命令名大小写敏感，不做前缀/模糊匹配（`/rol` `/ROLE` 都是未知命令）；
 * - 参数按空白切分、顺序原样保留，不做语义校验（用不用得上由调用方决定）。
 * 返回 { isCommand:false } 或 { isCommand:true, cmd, args, error? }。
 */
export function parseCommand(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.startsWith('/')) return { isCommand: false };

  const matched = /^(\S*)(?:\s+([\s\S]*))?$/.exec(raw.slice(1));
  const name = matched?.[1] ?? '';
  const args = parseArgs(matched?.[2] ?? '');
  if (!name) return { isCommand: true, cmd: '', args, error: '缺少命令名' };

  const canonical = Object.hasOwn(ALIASES, name)
    ? ALIASES[name]
    : (Object.hasOwn(COMMANDS, name) ? name : '');
  if (!canonical) return { isCommand: true, cmd: name, args, error: `未知命令：/${name}` };
  return { isCommand: true, cmd: canonical, args };
}
