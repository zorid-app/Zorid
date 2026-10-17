const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WindowBroker } = require('../desktop/window-broker.cjs');
const { VaultService } = require('../desktop/vault-service.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let nextId = 1;
function windowStub() {
  const messages = [];
  const webContents = { id: nextId++, mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false, send: (...args) => messages.push(args) };
  return { webContents, isDestroyed: () => false, messages };
}
function event(record) { return { sender: record.window.webContents, senderFrame: record.window.webContents.mainFrame }; }
function fixture() {
  const services = new Map();
  const broker = new WindowBroker({ allowedURL: url => url === 'file:///app/index.html', openVault: async root => {
    if (!services.has(root)) services.set(root, { root, text: 'base', watchers: new Set(), writes: [],
      async read() { return this.text; }, async write(file, text) { this.text = text; this.writes.push([file, text]); },
      subscribe(callback) { this.watchers.add(callback); return () => this.watchers.delete(callback); } });
    return services.get(root);
  } });
  const a = broker.register(windowStub(), { primary: true, initialState: 'restore' });
  const b = broker.register(windowStub());
  return { broker, services, a, b };
}
test('window identities, main frame and page grants cannot be supplied by renderer', () => {
  const { broker, a, b } = fixture();
  assert.deepEqual(broker.info(a), { id: 'main', initialState: 'restore' });
  assert.notEqual(b.id, a.id);
  assert.equal(broker.info(b).initialState, 'empty');
  assert.equal(broker.authenticate(event(a)), a);
  assert.throws(() => broker.authenticate({ ...event(a), senderFrame: {} }), /Untrusted sender/);
  assert.throws(() => broker.authenticate({ ...event(a), sender: { ...a.window.webContents } }), /Untrusted sender/);
  a.window.webContents.mainFrame.url = 'https://foreign.test/';
  assert.throws(() => broker.authenticate(event(a)), /Untrusted page/);
  broker.remove(a);
  assert.throws(() => broker.authenticate(event(a)), /Untrusted sender/);
});
test('closed windows release grants and watchers without reading destroyed webContents', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  const originalId = b.window.webContents.id;
  b.window.isDestroyed = () => true;
  Object.defineProperty(b.window, 'webContents', { get() { throw new TypeError('Object has been destroyed'); } });
  assert.throws(() => broker.assertLive(b), /Window is no longer available/);
  assert.doesNotThrow(() => broker.remove(b));
  assert.equal(broker.windows.has(originalId), false);
  assert.equal(b.vault, null);
  assert.equal(services.get('/one').watchers.size, 1, 'surviving window keeps the shared watcher');
  assert.doesNotThrow(() => broker.remove(b), 'repeated close is harmless');
  await broker.dispatch(a, '/one', 'write', ['a.md', 'still usable']);
  a.window.isDestroyed = () => true;
  Object.defineProperty(a.window, 'webContents', { get() { throw new TypeError('Object has been destroyed'); } });
  assert.doesNotThrow(() => broker.dispose());
  assert.equal(broker.windows.size, 0);
  assert.equal(services.get('/one').watchers.size, 0);
  assert.doesNotThrow(() => broker.dispose());
});
test('vault selection and broadcasts remain window scoped; same-vault watchers are shared', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  assert.equal(services.get('/one').watchers.size, 1);
  await broker.dispatch(a, '/one', 'write', ['a.md', 'changed']);
  assert.equal(b.window.messages.length, 1);
  assert.equal(b.window.messages[0][1].vault, '/one');
  await broker.select(b, '/two');
  assert.equal(broker.describe(a).path, '/one');
  assert.throws(() => broker.dispatch(b, '/one', 'write', ['a.md', 'bad']), /selected vault changed/);
  await broker.dispatch(a, '/one', 'write', ['a.md', 'new']);
  assert.equal(b.window.messages.length, 1);
  broker.remove(a); assert.equal(services.get('/one').watchers.size, 0);
  broker.dispose(); assert.equal(services.get('/two').watchers.size, 0);
});
test('same-vault concurrent comparisons serialize; conflict leaves winning content intact and queue usable', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  const results = await Promise.allSettled([
    broker.dispatch(a, '/one', 'compareAndWrite', ['a.md', 'base', 'first']),
    broker.dispatch(b, '/one', 'compareAndWrite', ['a.md', 'base', 'second']),
  ]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /File changed outside/);
  assert.equal(services.get('/one').text, 'first');
  await broker.dispatch(b, '/one', 'compareAndWrite', ['a.md', 'first', 'next']);
  assert.equal(services.get('/one').text, 'next');
});
test('queued writes recheck selection and live sender after waiting', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  let release;
  a.vault.tail = new Promise(resolve => { release = resolve; });
  const stale = broker.dispatch(a, '/one', 'write', ['a.md', 'stale']);
  const closed = broker.dispatch(b, '/one', 'write', ['a.md', 'closed']);
  await broker.select(a, '/two'); broker.remove(b); release();
  await assert.rejects(stale, /selected vault changed/);
  await assert.rejects(closed, /no longer available/);
  assert.deepEqual(services.get('/one').writes, []);
});
test('ordinary writes share CAS queue and captured binary payloads do not mutate while queued', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  const write = broker.dispatch(a, '/one', 'write', ['a.md', 'ordinary']);
  const cas = broker.dispatch(b, '/one', 'compareAndWrite', ['a.md', 'base', 'stale']);
  await write; await assert.rejects(cas, /File changed outside/);
  let payload;
  services.get('/one').writeBinary = async (_path, bytes) => { payload = bytes; };
  const bytes = new Uint8Array([1, 2]);
  const pending = broker.dispatch(a, '/one', 'writeBinary', ['image.png', bytes]); bytes[0] = 9;
  await pending; assert.deepEqual([...payload], [1, 2]);
});
test('actual filesystem service survives cross-window compare race without lost update', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-window-cas-'));
  const broker = new WindowBroker({ allowedURL: () => true, openVault: root => VaultService.open(root) });
  t.after(async () => { broker.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'a.md'), 'base');
  const a = broker.register(windowStub()); const b = broker.register(windowStub());
  await broker.select(a, directory); await broker.select(b, directory);
  assert.equal(a.vault, b.vault);
  const root = broker.describe(a).path;
  const results = await Promise.allSettled(['first', 'second'].map((text, i) => broker.dispatch(i ? b : a, root, 'compareAndWrite', ['a.md', 'base', text])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await fs.readFile(path.join(directory, 'a.md'), 'utf8'), 'first');
});

test('broadcasts skip untrusted pages and isolate failed recipients after a successful save', async () => {
  const { broker, services, a, b } = fixture();
  const c = broker.register(windowStub());
  await broker.select(a, '/one'); broker.bind(b, a.vault); broker.bind(c, a.vault);
  b.window.webContents.mainFrame.url = 'https://foreign.test/';
  a.window.webContents.send = () => { throw new Error('renderer disappeared'); };
  await broker.dispatch(c, '/one', 'compareAndWrite', ['a.md', 'base', 'committed']);
  assert.equal(services.get('/one').text, 'committed');
  assert.deepEqual(b.window.messages, []);
  assert.equal(c.window.messages.length, 1);
  for (const watcher of services.get('/one').watchers) watcher({ type: 'external', path: 'secret.md' });
  assert.deepEqual(b.window.messages, []);
  assert.equal(c.window.messages.length, 2);
});

test('permanent removal rechecks queued grants and broadcasts only successful scoped operations', async () => {
  const { broker, services, a, b } = fixture();
  await broker.select(a, '/one'); broker.bind(b, a.vault);
  const removals = [];
  services.get('/one').remove = async (...args) => removals.push(args);
  let release;
  a.vault.tail = new Promise(resolve => { release = resolve; });
  const stale = broker.dispatch(a, '/one', 'remove', ['Keep.md', true]);
  await broker.select(a, '/two'); release();
  await assert.rejects(stale, /selected vault changed/);
  assert.deepEqual(removals, []);
  assert.deepEqual(b.window.messages, []);
  await broker.dispatch(b, '/one', 'remove', ['Gone.md', false]);
  assert.deepEqual(removals, [['Gone.md', false]]);
  assert.deepEqual(b.window.messages, [['zorid:change', { type: 'change', path: 'Gone.md', vault: '/one' }]]);
  assert.deepEqual(a.window.messages, []);
  broker.dispose();
});

test('reconciliation retry stays root scoped and diagnostics are copied when describing a vault',async()=>{
  const {broker,a,b}=fixture();await broker.select(a,'/one');await broker.select(b,'/two');
  const status={complete:false};a.vault.service.reconciliation=status;
  const described=broker.describe(a);described.reconciliation.complete=true;assert.equal(status.complete,false);
  let retries=0;a.vault.service.retryReconciliation=async()=>{retries++;return status;};
  await broker.dispatch(a,'/one','retryReconciliation',[]);assert.equal(retries,1);
  assert.throws(()=>broker.dispatch(a,'/two','retryReconciliation',[]),/vault|grant|authorized/i);assert.equal(retries,1);
});
