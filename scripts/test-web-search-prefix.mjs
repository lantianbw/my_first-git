// 回归：web_search 默认带时效偏好（2026-10 需求：查近期热梗，别给三年前的答案）。
//
// 说明：src/web-search.js 用的是 node:https（不是 fetch），所以没法"假 fetch 拦请求体"。
// 这里改成给 deepseekSearch 注入假 transport（validate + post），仍然是在**真正组装请求体
// 的那一层**拦截：拿到 options.body 后解析成 JSON，断言 content 里的前缀与原 query。

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchPrompt, deepseekSearch, shanghaiDate } from '../src/web-search.js';

function captureBody() {
  const captured = { body: null, url: null };
  const transport = {
    validate: async () => ({ url: new URL('https://api.deepseek.com/anthropic/v1'), addresses: ['203.0.113.10'] }),
    post: async (endpoint, addresses, options) => {
      captured.url = endpoint.toString();
      captured.body = options.body;
      return {
        status: 200,
        text: JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [] }] })
      };
    }
  };
  return { captured, transport };
}

const promptOf = (body) => JSON.parse(body).messages[0].content[0].text;

test('请求体里带「当前日期」与「最近 30 天」，原 query 完整保留在末尾', async () => {
  const { captured, transport } = captureBody();
  const query = '2026 年 10 月最火的表情包梗';
  await deepseekSearch(query, { apiKey: 'test-key', recencyDays: 30 }, transport);

  const text = promptOf(captured.body);
  assert.match(text, /当前日期：\d{4}-\d{2}-\d{2}/);
  assert.ok(text.includes('最近 30 天'), text.slice(0, 120));
  assert.ok(text.includes('回答里注明时间'));
  assert.ok(text.endsWith(`Perform a web search for the query: ${query}`), '原 query 必须完整保留在末尾');

  const payload = JSON.parse(captured.body);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].role, 'user');
  assert.equal(payload.tools[0].name, 'web_search');
});

test('recencyDays 可被调用方覆盖：默认 30，传 7 就写 7', async () => {
  const { captured, transport } = captureBody();
  await deepseekSearch('近期热梗', { apiKey: 'k' }, transport);
  assert.match(promptOf(captured.body), /最近 30 天/);

  await deepseekSearch('近期热梗', { apiKey: 'k', recencyDays: 7 }, transport);
  const text = promptOf(captured.body);
  assert.match(text, /最近 7 天/);
  assert.ok(!text.includes('最近 30 天'));
});

test('buildSearchPrompt 的日期按 Asia/Shanghai 算（跨时区不漂）', () => {
  // 2026-10-26T16:30:00Z = 北京时间 10-27 00:30，UTC 那边还是 26 号。
  const at = Date.UTC(2026, 9, 26, 16, 30, 0);
  assert.equal(shanghaiDate(at), '2026-10-27');
  const prompt = buildSearchPrompt('测试', 30, at);
  assert.ok(prompt.startsWith('当前日期：2026-10-27。请优先检索最近 30 天的内容，回答里注明时间。'));
  assert.ok(prompt.endsWith('Perform a web search for the query: 测试'));
});
