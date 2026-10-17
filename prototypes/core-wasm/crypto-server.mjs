import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headerFor, contextFor, nonce, same, distinct, tampered, payload } from './crypto-cases.mjs';
const binary = process.env.ZORID_CRYPTO_INTEROP_BIN ?? fileURLToPath(new URL('../../target/debug/examples/crypto-interop', import.meta.url));
function invoke(request) {
  const process = spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (process.error || process.status !== 0) throw new Error('native crypto fixture process failed; diagnostics redacted');
  try { return JSON.parse(process.stdout); }
  catch { throw new Error('invalid native fixture response; diagnostics redacted'); }
}
function native(request) { const result = invoke(request); if (!result.ok) throw new Error('native crypto operation rejected'); return result.result; }
const key = native({ op: 'generate' }).key;
const seal = update => native({ op: 'seal', key, header: headerFor(update, 'native'), plaintext: Array.from(payload) }).wire;
const first = seal('native-a');
const second = seal('native-b');
distinct(nonce(first), nonce(second), 'native nonce collision');
const token = randomBytes(24).toString('hex');
const files = new Map([
  ['/crypto.html', ['crypto.html', 'text/html']], ['/crypto-worker.mjs', ['crypto-worker.mjs', 'text/javascript']],
  ['/crypto-cases.mjs', ['crypto-cases.mjs', 'text/javascript']], ['/pkg/zorid_wasm.js', ['pkg/zorid_wasm.js', 'text/javascript']],
  ['/pkg/zorid_wasm_bg.wasm', ['pkg/zorid_wasm_bg.wasm', 'application/wasm']],
]);
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
async function body(request) {
  const parts = []; let size = 0;
  for await (const part of request) { size += part.length; if (size > 1024 * 1024) throw new Error('fixture bound'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function stop() { clearTimeout(deadline); key.fill(0); server.close(); }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (request.method === 'GET' && files.has(url.pathname)) {
      const [path, type] = files.get(url.pathname);
      const content = await readFile(new URL(path, import.meta.url));
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(content); return;
    }
    if (url.searchParams.get('token') !== token) return json(response, 403, { error: 'invalid fixture token' });
    if (request.method === 'GET' && url.pathname === '/input') return json(response, 200, { key, first, second });
    if (request.method === 'POST' && url.pathname === '/verify') {
      const result = await body(request);
      if (!result.ok) throw new Error('browser validation failed');
      const open = (wire, context = contextFor('browser-a'), candidate = result.key) => ({ op: 'open', key: candidate, context, wire: Array.from(wire) });
      same(native(open(result.first)).plaintext, payload, 'browser seal/native open bytes');
      same(native(open(result.second, contextFor('browser-b'))).plaintext, payload, 'browser second envelope bytes');
      distinct(nonce(result.first), nonce(result.second), 'browser nonce collision');
      for (const [, wire] of tampered(result.first)) if (invoke(open(wire)).ok) throw new Error('native accepted tampering');
      for (const override of [{ realm_id: 'other' }, { vault_id: 'other' }, { update_id: 'other' }, { key_epoch: 2 }]) {
        if (invoke(open(result.first, contextFor('browser-a', override))).ok) throw new Error('native accepted wrong context');
      }
      const wrongKey = result.key.slice(); wrongKey[0] ^= 1;
      if (invoke(open(result.first, contextFor('browser-a'), wrongKey)).ok) throw new Error('native accepted wrong key');
      wrongKey.fill(0); result.key.fill(0);
      const evidence = { ok: true, browser: result.browser, checks: result.checks,
        native_checks: ['browser-generated ciphertext/key opens natively preserving all bytes',
          'native rejects altered header/nonce/ciphertext/tag, wrong key and all context substitutions'],
        limitations: 'Disposable key provisioning fixture, not production enrollment, persistent key storage or encrypted backend sync' };
      console.log(JSON.stringify(evidence, null, 2)); json(response, 200, evidence); stop(); return;
    }
    if (request.method === 'POST' && url.pathname === '/failed') { process.exitCode = 1; json(response, 200, { ok: false }); stop(); return; }
    json(response, 404, { error: 'unknown fixture endpoint' });
  } catch {
    process.exitCode = 1;
    console.error('FAIL: native/browser crypto validation failed; payloads redacted');
    if (!response.headersSent) json(response, 500, { error: 'fixture validation failed' });
    else response.destroy();
    stop();
  }
});
const deadline = setTimeout(() => { process.exitCode = 1; console.error('FAIL: crypto fixture timed out'); stop(); }, 5 * 60 * 1000);
server.on('error', () => { process.exitCode = 1; console.error('crypto fixture server failed'); clearTimeout(deadline); key.fill(0); });
server.listen(Number(process.env.ZORID_CRYPTO_PORT ?? 8769), '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${server.address().port}/crypto.html?token=${token}`);
});
