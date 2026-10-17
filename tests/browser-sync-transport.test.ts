import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSyncTransport, SYNC_CONTROL_BYTES, SYNC_WIRE_BYTES, SYNC_PAGE_BYTES } from '../src/platform/browser-sync-transport.ts';
import type { BrowserSyncTransportOptions } from '../src/platform/browser-sync-transport.ts';
const config: BrowserSyncTransportOptions = { endpoint: 'https://relay.example', vaultId: 'vault', bearerToken: 'secret-token' };
const bytes = (s: string) => new TextEncoder().encode(s);
const response = (body = '{}', init: ResponseInit = {}) => new Response(body, { headers: {'Content-Type':'application/json'}, ...init });
const code = (value: string) => (e: unknown) => { assert.equal((e as Error).message, value); return true; };
const transport = (fetcher: (url: string, init: RequestInit) => Promise<Response>, options = config) =>
  createBrowserSyncTransport(options, fetcher as typeof fetch);

test('exact wire snapshot, pinned URLs, request policy, raw duplicate JSON response', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const raw = '{"a":1,"a":2}';
  const t = transport(async (url, init) => { calls.push({url,init}); return response(raw); });
  assert.deepEqual(await t.hello(), bytes(raw));
  const wire = new Uint8Array([1,2,3]);
  const upload = t.upload('update_1', wire); wire[0] = 9;
  assert.deepEqual(await upload, bytes(raw));
  const cursor = '{"server_epoch":"epoch","after":"9007199254740993","extensions":{}}';
  await t.pull(cursor, '18446744073709551615');
  assert.equal(calls[0].url, 'https://relay.example/v1/hello');
  assert.equal((calls[0].init.headers as Record<string,string>).Authorization, undefined);
  assert.equal(calls[1].url, 'https://relay.example/v1/vaults/vault/updates/update_1');
  assert.deepEqual(calls[1].init.body, new Uint8Array([1,2,3]));
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal((calls[1].init.headers as Record<string,string>).Authorization, 'Bearer secret-token');
  const url = new URL(calls[2].url);
  assert.equal(url.searchParams.get('cursor'), cursor);
  assert.equal(url.searchParams.get('through'), '18446744073709551615');
  assert.equal(url.searchParams.get('limit'), '64');
  for (const {url,init} of calls) {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(!url.includes('secret-token'));
  }
  t.close();
});
test('rejects unsafe endpoints, credentials, scope and deadlines before fetch', () => {
  for (const endpoint of ['http://relay.example','https://a.example/path','https://u:p@a.example','https://a.example/?x=1','https://a.example/#x','file:///','https://localhost.evil/path']) {
    assert.throws(() => createBrowserSyncTransport({...config,endpoint,allowLoopbackHttp:true}), code('sync_invalid_configuration'));
  }
  for (const patch of [{vaultId:'../other'},{vaultId:'vault\n'},{vaultId:'a'.repeat(129)},{bearerToken:'x\ny'},{bearerToken:'x\n'},{timeoutMs:0},{timeoutMs:60001}]) {
    assert.throws(() => createBrowserSyncTransport({...config,...patch}), code('sync_invalid_configuration'));
  }
  for (const endpoint of ['http://localhost:1234','http://127.0.0.1:1234','http://[::1]:1234']) {
    assert.throws(() => createBrowserSyncTransport({...config,endpoint}), code('sync_invalid_configuration'));
    createBrowserSyncTransport({...config,endpoint,allowLoopbackHttp:true}).close();
  }
});
test('invalid outgoing IDs, wire sizes and cursor bounds never perform HTTP', async () => {
  let calls = 0;
  const t = transport(async () => { calls++; return response(); });
  await assert.rejects(t.upload('../x', bytes('x')), code('sync_invalid_request'));
  await assert.rejects(t.upload('x', new Uint8Array(SYNC_WIRE_BYTES+1)), code('sync_limit'));
  for (const through of ['01','-1','1.0','1\n','18446744073709551616']) await assert.rejects(t.pull('{}', through), code('sync_invalid_request'));
  await assert.rejects(t.pull('a'.repeat(SYNC_CONTROL_BYTES+1)), code('sync_invalid_request'));
  assert.equal(calls,0);
});
test('streamed cap applies without Content-Length and when it lies; stream is cancelled', async () => {
  for (const length of [undefined,'1']) {
    let cancelled = false;
    const t = transport(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(SYNC_CONTROL_BYTES)); c.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    }), {headers: {'Content-Type':'application/json', ...(length ? {'Content-Length':length}: {})}}));
    await assert.rejects(t.hello(),code('sync_response_limit'));
    assert.equal(cancelled,true);
  }
});
test('status, MIME and declared length failures are sanitized and cancel response', async () => {
  for (const [status, expected] of [[401,'sync_authorization_failed'],[403,'sync_authorization_failed'],[409,'sync_relay_conflict'],[413,'sync_limit'],[302,'sync_transport'],[500,'sync_transport']] as const) {
    const t = transport(async () => response('secret echoed', {status}));
    await assert.rejects(t.hello(), code(expected));
  }
  for (const headers of [{'Content-Type':'text/html'}, {'Content-Type':'application/json','Content-Length':'9000'}, {'Content-Type':'application/json','Content-Length':'bad'}]) {
    const t = transport(async () => response('{}',{headers}));
    await assert.rejects(t.hello(),code(headers['Content-Length']==='9000'?'sync_response_limit':'sync_invalid_response'));
  }
  const t = transport(async () => { throw new Error('secret-token at secret URL'); });
  await assert.rejects(t.hello(),code('sync_transport'));
});
test('deadline bounds hanging fetch and hanging response streams', async () => {
  for (const fetcher of [async () => new Promise<Response>(()=>{}), async () => new Response(new ReadableStream(),{headers:{'Content-Type':'application/json'}})]) {
    const t = transport(fetcher, {...config,timeoutMs:5});
    await assert.rejects(t.hello(),code('sync_timeout'));
  }
});
test('caller abort and close interrupt active fetch; close rejects later requests', async () => {
  let calls = 0;
  const t = transport(async () => { calls++; return new Promise<Response>(()=>{}); });
  const controller = new AbortController();
  const request = t.hello(controller.signal); controller.abort();
  await assert.rejects(request,code('sync_aborted'));
  await assert.rejects(t.hello(controller.signal),code('sync_aborted'));
  const pending = t.hello(); t.close();
  await assert.rejects(pending,code('sync_closed'));
  await assert.rejects(t.hello(),code('sync_closed'));
  assert.equal(calls,2);
});
test('fixed response caps differ for controls and pull pages', async () => {
  assert.equal(SYNC_WIRE_BYTES,1052720); assert.equal(SYNC_PAGE_BYTES,2840024);
  const body = ' '.repeat(SYNC_CONTROL_BYTES+1);
  const t = transport(async () => response(body));
  await assert.rejects(t.hello(),code('sync_response_limit'));
  assert.equal((await t.pull('{}')).length,body.length);
});
