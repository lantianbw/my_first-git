// P1 能力回归：本地发图路径约束（纯函数）与控制台清空梗库（HTTP）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveImageFile } from '../src/image-path.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ADMIN = { 'x-console-token': 'fixture-console-token' };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

await test('发图路径：目录外/不存在/非图片/超大小/合法', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-'));
  try {
    const dir = path.join(root, 'images');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.png'), PIXEL);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'not an image');
    fs.writeFileSync(path.join(root, 'outside.png'), PIXEL);
    fs.writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(2048));

    const outside = resolveImageFile({ root, dir: 'images', file: '../outside.png' });
    assert.equal(outside.status, 403);
    assert.match(outside.error, /只允许/);

    const missing = resolveImageFile({ root, dir: 'images', file: 'missing.png' });
    assert.equal(missing.status, 404);

    const wrongType = resolveImageFile({ root, dir: 'images', file: 'note.txt' });
    assert.equal(wrongType.status, 400);

    const tooBig = resolveImageFile({ root, dir: 'images', file: 'big.png', maxBytes: 1024 });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.error, /过大/);

    const ok = resolveImageFile({ root, dir: 'images', file: 'ok.png', maxBytes: 1024 * 1024 });
    assert.equal(ok.ok, true);
    assert.ok(ok.uri.startsWith('file:///'));
    assert.ok(ok.uri.endsWith('/images/ok.png'));
    assert.equal(ok.size, PIXEL.length);

    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'n.png'), PIXEL);
    assert.equal(resolveImageFile({ root, dir: 'images', file: 'sub/n.png' }).ok, true, '子目录内文件允许');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('清空梗库：console 可用，agent token 403，缺 confirm 400', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const st = h.getSocialV2State('private:123');
    await withServer(h, async (port) => {
      const missingConfirm = await call(port, '/api/socialV2/memes/clear', {
        method: 'POST', headers: ADMIN, body: {}
      });
      assert.equal(missingConfirm.status, 400, missingConfirm.body);

      const asAgent = await call(port, '/api/socialV2/memes/clear', {
        method: 'POST',
        headers: { ...ADMIN, 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
        body: { confirm: 'clear' }
      });
      assert.equal(asAgent.status, 403, asAgent.body);

      const ok = await call(port, '/api/socialV2/memes/clear', {
        method: 'POST', headers: ADMIN, body: { confirm: 'clear' }
      });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json.cleared, true);
    });
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
