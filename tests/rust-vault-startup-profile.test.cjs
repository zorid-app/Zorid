'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');

function profileScope(t, flag = '1', profile = {
  version: 1, timeOrigin: performance.timeOrigin, moduleEntryUptimeMs: process.uptime() * 1000,
  phases: [{ phase: 'module.entry', atMs: performance.now() }], truncated: false,
}) {
  const previousFlag = process.env.ZORID_PROFILE_STARTUP;
  const previousProfile = Object.getOwnPropertyDescriptor(globalThis, '__zoridStartupProfile');
  if (flag === undefined || flag === null) delete process.env.ZORID_PROFILE_STARTUP;
  else process.env.ZORID_PROFILE_STARTUP = flag;
  globalThis.__zoridStartupProfile = profile;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.ZORID_PROFILE_STARTUP;
    else process.env.ZORID_PROFILE_STARTUP = previousFlag;
    if (previousProfile) Object.defineProperty(globalThis, '__zoridStartupProfile', previousProfile);
    else delete globalThis.__zoridStartupProfile;
  });
  return profile;
}

// Real child/stdin/stdout/stderr transport; the fake host deliberately knows no
// vault semantics. Request-triggered writes let the test fence split chunks by
// observing stderr delivery, without a sleep or a timing-based acceptance rule.
async function fixture(t, { startup = '', invalidHello = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-startup-profile-'));
  const executable = path.join(root, 'host');
  await fs.writeFile(executable, `#!${process.execPath}
function send(id,result,body=Buffer.alloc(0)) {
 const header=Buffer.from(JSON.stringify({version:1,request_id:id,ok:true,result})),prefix=Buffer.alloc(8);
 prefix.writeUInt32BE(header.length,0);prefix.writeUInt32BE(body.length,4);
 process.stdout.write(prefix.subarray(0,3));process.stdout.write(prefix.subarray(3));process.stdout.write(header);process.stdout.write(body);
}
const hello={transport:${JSON.stringify(invalidHello ? 'wrong' : 'zorid-native-stdio')},max_header:1048576,max_body:16777216,capabilities:[]};
process.stderr.write(${JSON.stringify(startup)},()=>send('0',hello));
let pending=Buffer.alloc(0);
process.stdin.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=8){
 const h=pending.readUInt32BE(0),b=pending.readUInt32BE(4);if(pending.length<8+h+b)return;
 const request=JSON.parse(pending.subarray(8,8+h)),body=Buffer.from(pending.subarray(8+h,8+h+b));pending=pending.subarray(8+h+b);
 const reply=()=>send(request.request_id,request.command.method==='binary'?{binary:true}:{pending_outbox:'0',pending_projection:'0',attempts:[],observations:[]},body);
 if(request.command.stderrBytes)process.stderr.write(Buffer.from(request.command.stderrBytes,'base64'),reply);else reply();
}});
process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o700 });
  let host;
  t.after(async () => {
    try {
      if (host) {
        await host.close();
        assert.equal(host.exited, true);
        assert.equal(host.child.exitCode, 0);
        assert.equal(host.child.signalCode, null);
        assert.equal(host.fatal, null);
        assert.equal(host.child.stderr.listenerCount('data'), 0);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  host = await RustVaultService.open(root, { executable, timeoutMs: 2000 });
  return host;
}

async function emit(host, bytes) {
  const delivered = once(host.child.stderr, 'data');
  const body = new Uint8Array([0, 255, 128, 10]);
  const reply = await host.request({ method: 'binary', stderrBytes: Buffer.from(bytes).toString('base64') }, body);
  await delivered;
  assert.deepEqual([...reply.bytes], [0, 255, 128, 10]);
}

test('opt-in Native phases survive partial/private stderr without changing framed bytes', async t => {
  const profile = profileScope(t);
  const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
  await emit(host, 'zorid_startup phase=vault_');
  await emit(host, 'open elapsed_ms=1.250\nprivate /Users/secret/Note.md 🔒\n');
  await emit(host, 'x'.repeat(300) + 'zorid_startup phase=recovery_ready elapsed_ms=2.000\n');
  await emit(host, 'zorid_startup phase=recovery_ready elapsed_ms=2.000\n');
  await host.close();
  const events = profile.nativeEvents;
  assert.ok(Array.isArray(events), 'opt-in observer exposes bounded sanitized phase rows');
  assert.deepEqual(events.filter(row => row.kind === 'native_phase').map(row => [row.phase, row.elapsedMs]), [
    ['entry', 0.125], ['vault_open', 1.25], ['recovery_ready', 2],
  ]);
  assert.equal(events.filter(row => row.kind === 'spawn').length, 1);
  assert.equal(events.filter(row => row.kind === 'hello').length, 1);
  assert.ok(events.every(row => row.pid === host.child.pid && row.hostIndex === 0 && Number.isFinite(row.atMs)));
  for (const row of events) assert.deepEqual(Object.keys(row).sort(), (row.kind === 'native_phase'
    ? ['kind', 'hostIndex', 'pid', 'atMs', 'phase', 'elapsedMs'] : ['kind', 'hostIndex', 'pid', 'atMs']).sort());
  assert.equal(profile.nativeEventsTruncated, false);
  assert.doesNotMatch(JSON.stringify(profile), /secret|Note\.md|private|🔒|xxx/);
});

test('ordinary launches and invalid Main profiles keep stderr private and transport live', async t => {
  for (const [flag, valid] of [[null, true], ['0', true], ['1', false]]) {
    await t.test(`${flag ?? 'unset'} / ${valid ? 'valid' : 'invalid'} profile`, async t => {
      const profile = profileScope(t, flag);
      if (!valid) profile.version = 2;
      const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
      await emit(host, 'private /Users/secret/Note.md\n'.repeat(3000));
      await host.close();
      assert.equal(Object.hasOwn(profile, 'nativeEvents'), false);
      assert.equal(Object.hasOwn(profile, 'nativeEventsTruncated'), false);
    });
  }
});

test('Native phase whitelist, exact grammar, order and elapsed guards reject malformed stderr', async t => {
  const profile = profileScope(t);
  const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
  await emit(host, Buffer.from([0xf0, 0x9f]));
  await emit(host, Buffer.concat([Buffer.from([0x94, 0x92]), Buffer.from('\n' + [
    'zorid_startup phase=private elapsed_ms=0.500',
    'zorid_startup phase=vault_open elapsed_ms=Infinity',
    'zorid_startup phase=vault_open elapsed_ms=-1.000',
    'zorid_startup phase=vault_open elapsed_ms=1.250 /private/secret',
    'zorid_startup phase=vault_open elapsed_ms=1.250',
    'zorid_startup phase=recovery_ready elapsed_ms=1.000',
    'zorid_startup phase=recovery_ready elapsed_ms=86400000.001',
    'zorid_startup phase=recovery_ready elapsed_ms=2.000',
    'zorid_startup phase=entry elapsed_ms=9.000',
    'zorid_startup phase=document_cache_ready elapsed_ms=1.500',
    'zorid_startup phase=document_cache_ready elapsed_ms=3.000',
    'zorid_startup phase=sync_ready elapsed_ms=4.000',
    'zorid_startup phase=reconciliation_yielded elapsed_ms=5.000',
    'zorid_startup phase=reconciliation_yielded elapsed_ms=6.000',
  ].join('\n') + '\n')]));
  await host.close();
  assert.deepEqual(profile.nativeEvents.filter(row => row.kind === 'native_phase').map(row => [row.phase, row.elapsedMs]), [
    ['entry', 0.125], ['vault_open', 1.25], ['recovery_ready', 2], ['document_cache_ready', 3], ['sync_ready', 4], ['reconciliation_yielded', 5],
  ]);
  assert.doesNotMatch(JSON.stringify(profile), /secret|private|Infinity|🔒/);
});

test('bounded stderr examination stops capture while continuing ordinary framed IO', async t => {
  const profile = profileScope(t);
  const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
  await emit(host, 'x'.repeat(20000) + '\nzorid_startup phase=vault_open elapsed_ms=1.000\n');
  await emit(host, 'zorid_startup phase=recovery_ready elapsed_ms=2.000\n');
  await host.close();
  assert.equal(profile.nativeEventsTruncated, true);
  assert.deepEqual(profile.nativeEvents.filter(row => row.kind === 'native_phase').map(row => row.phase), ['entry']);
  assert.equal(profile.nativeEvents.length, 3);
});

test('the shared event cap bounds additional hosts without affecting their protocol', async t => {
  const profile = profileScope(t);
  // A public diagnostic snapshot may already contain earlier hosts. Fill its
  // remaining budget without creating 127 unnecessary fixture subprocesses.
  profile.nativeEvents = Array.from({ length: 127 }, (_, hostIndex) => ({
    kind: 'spawn', hostIndex, pid: process.pid, atMs: 0,
  }));
  profile.nativeEventsTruncated = false;
  const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
  await emit(host, 'zorid_startup phase=vault_open elapsed_ms=1.000\n');
  await host.close();
  assert.equal(profile.nativeEvents.length, 128);
  assert.equal(profile.nativeEventsTruncated, true);
  assert.equal(profile.nativeEvents[127].kind, 'spawn');
  assert.equal(profile.nativeEvents[127].hostIndex, 127);
  assert.equal(profile.nativeEvents[127].pid, host.child.pid);
});

test('a rejected product handshake never gains a validated-hello diagnostic', async t => {
  const profile = profileScope(t);
  await assert.rejects(fixture(t, { invalidHello: true, startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' }), { code: 'invalid_handshake' });
  assert.equal(profile.nativeEvents.filter(row => row.kind === 'spawn').length, 1);
  assert.equal(profile.nativeEvents.some(row => row.kind === 'hello'), false);
});

test('an observer-only failure cannot reject or abort the product transport', async t => {
  const profile = profileScope(t);
  Object.defineProperty(profile, 'nativeEvents', { get() { throw Error('private observer failure'); } });
  const host = await fixture(t, { startup: 'zorid_startup phase=entry elapsed_ms=0.125\n' });
  await emit(host, 'zorid_startup phase=vault_open elapsed_ms=1.000\n');
  await host.close();
  assert.equal(host.fatal, null);
});

test('a recording failure detaches only the observer while framed work still completes', async t => {
  const profile = profileScope(t);
  const host = await fixture(t);
  Object.freeze(profile.nativeEvents);
  await emit(host, 'zorid_startup phase=entry elapsed_ms=0.125\n');
  await emit(host, 'zorid_startup phase=vault_open elapsed_ms=1.000\n');
  await host.close();
  assert.equal(profile.nativeEvents.some(row => row.kind === 'native_phase'), false);
  assert.equal(host.fatal, null);
});
