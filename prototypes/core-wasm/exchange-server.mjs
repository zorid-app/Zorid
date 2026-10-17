import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { native } from '../core-crdt/native-bridge.mjs';

const insert = (index, text) => ({ op: 'insert', index, text });
const remove = (index, length) => ({ op: 'delete', index, length });
const seed = native(1000, [], [insert(0, 'Hello 🦀 world\n')]);
const first = native(1001, [seed.snapshot], [insert(8, ' Rust')]);
const second = native(1002, [first.snapshot], [insert(13, '!')]);
const deletion = native(1003, [seed.snapshot], [remove(9, 5)], seed.state_vector);
assert.deepEqual(deletion.state_vector, seed.state_vector);
const yjs = JSON.parse(await readFile(new URL('../core-crdt/yjs13-fixture.json', import.meta.url), 'utf8'));
assert.equal(native(1004, [yjs.deleted, yjs.seed, yjs.deleted]).text, yjs.expected);
const input = {
  seed: seed.snapshot, first: first.diff, second: second.diff,
  deletion: deletion.diff, yjs,
};
const token = randomBytes(24).toString('hex');
const port = Number(process.env.ZORID_EXCHANGE_PORT ?? 8768);
let finalNative;
let complete = false;
const staticFiles = new Map([
  ['/exchange.html', ['exchange.html', 'text/html']],
  ['/exchange-worker.mjs', ['exchange-worker.mjs', 'text/javascript']],
  ['/pkg/zorid_wasm.js', ['pkg/zorid_wasm.js', 'text/javascript']],
  ['/pkg/zorid_wasm_bg.wasm', ['pkg/zorid_wasm_bg.wasm', 'application/wasm']],
]);
async function body(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 1024 * 1024) throw new Error('fixture request exceeds 1 MiB');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
function stop() {
  clearTimeout(deadline);
  server.close();
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [path, type] = staticFiles.get(url.pathname);
      const contents = await readFile(new URL(path, import.meta.url));
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(contents);
      return;
    }
    if (url.searchParams.get('token') !== token) return json(response, 403, { error: 'invalid fixture token' });
    if (request.method === 'GET' && url.pathname === '/input') return json(response, 200, input);
    if (request.method === 'POST' && url.pathname === '/verify') {
      assert.equal(complete, false);
      const result = await body(request);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.text, 'Hello 🦀 Rust! 世界\n');
      // Browser's second update depends on its first; deliver backwards twice.
      const merged = native(1010, [seed.snapshot, first.diff, second.diff, result.second, result.second, result.first, result.first]);
      assert.equal(merged.text, result.text);
      assert.equal(native(1011, [result.snapshot]).text, result.text);
      assert.deepEqual(result.delete_before, result.delete_after);
      assert.equal(native(1012, [result.deletion, seed.snapshot, result.deletion]).text, 'Hello 🦀 \n');
      // Native creates another update after consuming the actual browser bytes.
      finalNative = native(1013, [merged.snapshot], [insert(merged.text.length, '✓')], result.state_vector);
      assert.equal(finalNative.text, 'Hello 🦀 Rust! 世界\n✓');
      return json(response, 200, { ok: true, diff: finalNative.diff, snapshot: finalNative.snapshot, text: finalNative.text });
    }
    if (request.method === 'POST' && url.pathname === '/complete') {
      const result = await body(request);
      assert.ok(finalNative, 'native verification must complete first');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.text, finalNative.text);
      assert.equal(native(1014, [result.snapshot]).text, finalNative.text);
      complete = true;
      const evidence = {
        ok: true, text: finalNative.text, browser: result.browser, checks: result.checks,
        native_checks: ['browser dependent updates applied out of order and duplicated',
          'browser snapshot replayed natively', 'browser deletion-only update applied before target',
          'native post-merge edit returned to browser', 'final browser snapshot replayed natively'],
      };
      console.log(JSON.stringify(evidence, null, 2));
      json(response, 200, evidence);
      stop();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/failed') {
      const failure = await body(request);
      console.error(JSON.stringify({ ok: false, browser_failure: failure }));
      process.exitCode = 1;
      json(response, 200, { received: true });
      stop();
      return;
    }
    json(response, 404, { error: 'unknown fixture endpoint' });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    if (!response.headersSent) json(response, 500, { error: String(error) });
    else response.destroy(error);
  }
});
const deadline = setTimeout(() => {
  console.error('FAIL: no completed native/browser exchange within five minutes');
  process.exitCode = 1;
  stop();
}, 5 * 60 * 1000);
server.on('error', error => { console.error(error); process.exitCode = 1; clearTimeout(deadline); });
server.listen(port, '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${server.address().port}/exchange.html?token=${token}`);
});
