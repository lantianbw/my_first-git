import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, planOf } from '../src/inbound/media-plan.js';

const MB = 1024 * 1024;

test('spec：契约字段齐备且已冻结', () => {
  assert.equal(spec.name, 'inbound/media-plan');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.deps, []);
  assert.deepEqual(spec.optionalDeps, []);
  assert.deepEqual(spec.guards, []);
  assert.deepEqual(spec.toggle, { level: 'free', default: true, hot: true });
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.toggle));
});

test('图片类 kind（image / sticker / face）→ image，估算字节即原始字节', () => {
  for (const kind of ['image', 'sticker', 'face', 'mface']) {
    const p = planOf({ kind, mimeType: 'image/jpeg', bytes: 12345 });
    assert.deepEqual(p, { action: 'image', reason: 'image', estimatedBytes: 12345 }, kind);
  }

  // kind 大小写与空白不影响判定（OneBot 段类型偶有大小写差异）
  assert.equal(planOf({ kind: ' IMAGE ', mimeType: 'image/png', bytes: 1 }).action, 'image');
});

test('ocrEnabled 只改 reason，不改变 action', () => {
  const off = planOf({ kind: 'image', mimeType: 'image/png', bytes: 100 });
  const on = planOf({ kind: 'image', mimeType: 'image/png', bytes: 100, ocrEnabled: true });
  assert.equal(on.action, 'image', 'OCR 是增强，不影响是否发送');
  assert.equal(on.reason, 'image-ocr');
  assert.equal(off.reason, 'image');
  assert.equal(on.estimatedBytes, off.estimatedBytes);
});

test('语音（ptt / voice / record / audio）→ skip，交给上层转文字', () => {
  for (const kind of ['ptt', 'voice', 'record', 'audio']) {
    const p = planOf({ kind, mimeType: 'audio/amr', bytes: 4096 });
    assert.deepEqual(p, { action: 'skip', reason: 'voice-to-text', estimatedBytes: 0 }, kind);
  }
});

test('未知类型 → skip（不猜、不把无法识别的东西塞进上下文）', () => {
  for (const kind of ['video', 'file', 'hologram', '', undefined]) {
    const p = planOf({ kind, bytes: 1024 });
    assert.equal(p.action, 'skip', String(kind));
    assert.equal(p.reason, 'unsupported-kind', String(kind));
    assert.equal(p.estimatedBytes, 0);
  }
  // 完全不传参也不该抛
  assert.equal(planOf().action, 'skip');
});

test('超限：bytes > maxBytes → skip；恰好等于上限仍然放行', () => {
  const limit = 1 * MB;

  const over = planOf({ kind: 'image', mimeType: 'image/jpeg', bytes: limit + 1, maxBytes: limit });
  assert.deepEqual(over, { action: 'skip', reason: 'over-limit', estimatedBytes: 0 });

  const exact = planOf({ kind: 'image', mimeType: 'image/jpeg', bytes: limit, maxBytes: limit });
  assert.equal(exact.action, 'image', '现有实现用 > 判断，等于上限不跳过');

  // maxBytes 缺省按 8MB（与 bridge.js MAX_MEDIA_BYTES 默认一致）
  assert.equal(planOf({ kind: 'image', bytes: 8 * MB }).action, 'image');
  assert.equal(planOf({ kind: 'image', bytes: 8 * MB + 1 }).action, 'skip');

  // 超限判断先于 GIF 判定：9MB 的动图直接跳过，不会先去解码
  assert.equal(planOf({ kind: 'image', mimeType: 'image/gif', bytes: 9 * MB }).reason, 'over-limit');
});

test('GIF 且 gifEnabled → sheet（抽帧拼图）', () => {
  const p = planOf({ kind: 'image', mimeType: 'image/gif', bytes: 500_000, gifEnabled: true });
  assert.deepEqual(p, { action: 'sheet', reason: 'gif-sheet', estimatedBytes: 500_000 });

  // gifEnabled 缺省视为开（spec.toggle.default = true）
  assert.equal(planOf({ kind: 'sticker', mimeType: 'IMAGE/GIF', bytes: 1 }).action, 'sheet');
});

test('GIF 但 gifEnabled=false → image（按首帧处理，不抽帧也不加提示）', () => {
  const p = planOf({ kind: 'image', mimeType: 'image/gif', bytes: 500_000, gifEnabled: false });
  assert.deepEqual(p, { action: 'image', reason: 'gif-disabled', estimatedBytes: 500_000 });
});

test('有动图线索但字节不是 GIF（网关转码成首帧）→ gif-first-frame；关掉则退化为 image', () => {
  const hinted = planOf({ kind: 'image', mimeType: 'image/png', bytes: 80_000, gifHint: 'summary:动图' });
  assert.deepEqual(hinted, { action: 'gif-first-frame', reason: 'gif-hint-transcoded', estimatedBytes: 80_000 });

  const off = planOf({ kind: 'image', mimeType: 'image/png', bytes: 80_000, gifHint: 'summary:动图', gifEnabled: false });
  assert.equal(off.action, 'image');
  assert.equal(off.reason, 'gif-disabled');
});

test('纯函数：不修改入参、重复调用结果一致、每次返回新对象', () => {
  const input = Object.freeze({ kind: 'image', mimeType: 'image/gif', bytes: 1024, gifEnabled: true });
  const a = planOf(input);
  const b = planOf(input);
  assert.deepEqual(a, b, '同输入同输出');
  assert.notEqual(a, b, '不返回共享的缓存对象');
  assert.deepEqual(Object.keys(input), ['kind', 'mimeType', 'bytes', 'gifEnabled'], '入参未被增删字段');
  assert.deepEqual(Object.keys(a), ['action', 'reason', 'estimatedBytes'], '返回形状固定');
});
