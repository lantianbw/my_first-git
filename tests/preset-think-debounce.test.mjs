// M9 思维链防抖（preset 层）：钉住 qq-chat-v2 人格里「逐条思考再回」的节奏约束。
//
// 为什么单独一个文件：这段是纯文案，删掉或改软都不会让代码测试变红，但它决定了模型
// 收到一串消息时是「逐条想 → 挑着回」，还是「逐条都应」或「整串装死」。
// 同时断言生成物 patch 里逐字带着——只改源不重建 patch，线上还是老提示词。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET = path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const PATCH = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-v2.patch.yml');

const rows = yaml.load(fs.readFileSync(PRESET, 'utf8'));
const PREFIX = rows.find((row) => row.id === 'persona').config.prefix;
const SECTION_START = PREFIX.indexOf('【逐条思考再回（防抖）】');
const SECTION_END = PREFIX.indexOf('【分条与节奏】', SECTION_START);
const SECTION = SECTION_START >= 0 && SECTION_END > SECTION_START
  ? PREFIX.slice(SECTION_START, SECTION_END)
  : '';

test('新增「逐条思考再回（防抖）」小节，且排在「分条与节奏」之前', () => {
  assert.ok(SECTION_START >= 0, 'preset 应包含【逐条思考再回（防抖）】小节');
  assert.ok(SECTION_END > SECTION_START, '该小节应在【分条与节奏】之前（先想清楚，再决定怎么拆）');
  assert.ok(SECTION.length > 100, '小节内容不能只剩标题');
});

test('逐条过脑子：每条只留一句大白话，不写完整句、不列清单、不做总结', () => {
  for (const text of [
    '一条一条过脑子',
    '每条心里只留一句大白话',
    '别在心里写完整句、别列清单、别给自己做总结',
    '想完这条再看下一条',
  ]) assert.ok(SECTION.includes(text), `missing think rule: ${text}`);
});

test('思考不外泄：心里想，聊天框只出现要说的话', () => {
  for (const text of [
    '思考只留在心里',
    '不把“我看看”“想想怎么回”“先捋一下”发出去',
    '见【发送与汇报禁令】',
  ]) assert.ok(SECTION.includes(text), `missing no-leak rule: ${text}`);
});

test('防抖：碎片合并、同一件事只回一次，不逐条应声也不整串装死', () => {
  for (const text of [
    '逐条想完再决定回不回',
    '值得接的挑一两条，其余划走',
    '既不逐条应声，也不整串装死',
    '等他停一下再一起回，别追着碎片一条条应',
    '同一件事只回一次',
    '这叫防抖，不是漏看',
  ]) assert.ok(SECTION.includes(text), `missing debounce rule: ${text}`);
});

test('不抢答、不挨个点评（否则变成客服工单）', () => {
  for (const text of [
    '回的顺序跟着读的顺序：没看完的话不抢答',
    '先等那半句（见【等下文】）',
    '一串里只挑一个人、一个点接，别挨个点评',
    '挨个回就成客服工单了',
    '见【群聊不是客服队列】',
  ]) assert.ok(SECTION.includes(text), `missing reply-order rule: ${text}`);
});

test('思考风格跟着人设走：懒时两三个字，来劲时多想一句，都不写进消息', () => {
  for (const text of [
    '想法跟着人设走',
    '懒的时候心里就两三个字',
    '但都不往消息里写',
    '真没懂就问一句短的',
    '不硬猜',
  ]) assert.ok(SECTION.includes(text), `missing persona-flavored thought style: ${text}`);
});

test('生成的 patch 与源逐字一致，新小节能随部署上线', () => {
  const patch = yaml.load(fs.readFileSync(PATCH, 'utf8'));
  const persona = patch[0].insert[0].config.plugins.find((row) => row.id === 'persona');
  assert.equal(persona.config.prefix, PREFIX, 'patch 必须与源逐字一致（先跑 build-agent-preset-patches.mjs）');
  assert.ok(persona.config.prefix.includes('【逐条思考再回（防抖）】'), 'patch 里应带上新小节');
});
