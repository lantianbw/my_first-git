// content/persona-inject — 拼装唤醒提示词开头的「角色 + 身份」两段
//
// 契约：docs/module-contract.md v1.1（B.1 spec）
// deps：无                      （optional：无）
// 失败策略：fail-open            （依据：D 表 A.13/A.14「15 个内容模块一律 fail open」）
// 单测：tests/persona-inject.test.mjs
//
// 为什么需要：buildWakePromptV2 / buildWakeReminderPromptV2 里各写了一遍
// `roleState.role ? 【当前角色】…\n\n : ''` 与 selfIdentityTextV2() 的拼接，
// 角色卡附注、空行、超长截断散在两处。这里收成一个纯函数，两处都只调它。
// 边界：不做 IO（角色卡是否存在由调用方给 hasRoleCard）、不读角色文件、不加身份文案
// （identity 直接用 selfIdentityTextV2() 的成品），只负责拼接与截断。

export const spec = Object.freeze({
  name: 'content/persona-inject',
  version: '1.0.0',
  deps: [],
  optionalDeps: [],
  guards: [],
  toggle: { level: 'owner', default: true, hot: true }
});

const DEFAULT_MAX_CHARS = 400;
const ROLE_NOTE = '（完整角色卡请调用 qq_get_prompt 查看）';

/** 严格受字数上限保护：先拼两段，再按码点截断（不切坏代理对），总长不超过 maxChars。 */
export function buildPersonaBlock({ role, identity, hasRoleCard, maxChars } = {}) {
  const roleName = String(role ?? '').trim();
  const identityText = String(identity ?? '').trim();

  const sections = [];
  if (roleName) sections.push(`【当前角色】${roleName}${hasRoleCard ? ROLE_NOTE : ''}`);
  if (identityText) sections.push(identityText);

  const full = sections.join('\n\n');
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : DEFAULT_MAX_CHARS;

  const chars = [...full];
  if (chars.length <= limit) return { text: full, truncated: false };
  if (limit <= 1) return { text: '…'.slice(0, limit), truncated: true };
  return { text: `${chars.slice(0, limit - 1).join('')}…`, truncated: true };
}
