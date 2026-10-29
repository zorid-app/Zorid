import test from 'node:test';
import assert from 'node:assert/strict';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentMetadata, DocumentMetadataRowsItem, DocumentService, DocumentSnapshotId, DocumentTransport} from '../src/core/document-semantics.ts';
import type {DocumentRuntimeUpdate} from '../src/core/document-runtime.ts';
import type {VaultEntry} from '../src/core/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return {promise, resolve};
}
async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Expected completion before the metadata page gate was released');
}
const versions = {schema: 1, extraction: 'zorid-markdown-1:metadata-2', resolver: 'resolver-1', query: 'query-1'};
function row(path: string, id: string, revision = 'r1'): DocumentMetadataRowsItem {
  const metadata: DocumentMetadata = {schemaVersion: 2, dialectVersion: 'zorid-markdown-1', entryId: id,
    contentRevision: revision, sourceLength: {bytes: 0, utf16: 0},
    frontmatter: {state: 'absent', range: null, bodyStart: {byte: 0, utf16: 0}},
    properties: [], aliases: [], tags: [], tagOccurrences: [], headings: [], links: [], tasks: [],
    blocks: [], listItems: [], diagnostics: []};
  return {kind: 'file', value: {entry: {id, revision, path, kind: 'file', deleted: false}, metadata, exclusion: null}};
}
function startupFixture(count = 65) {
  const firstPage = deferred(), attachment = deferred();
  let waitForAttachment = false, attachmentError: unknown, pageError: unknown;
  let rows = Array.from({length: count}, (_, index) => row(`Note${index}.md`, `note-${index}`));
  let snapshot: DocumentSnapshotId = {localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions};
  let listener: ((update: DocumentRuntimeUpdate | null) => void) | undefined;
  const events: string[] = [], reads: string[] = [], requests: unknown[] = [];
  const pins = new Map<string, {snapshot: DocumentSnapshotId; rows: DocumentMetadataRowsItem[]}>();
  let nextPin = 0;
  const source = (value: DocumentSnapshotId) => ({localStoreId: value.localStoreId, watermark: value.generation});
  const update = (): DocumentRuntimeUpdate => ({lifetime: 'life', revision: snapshot.generation,
    source: source(snapshot), published: snapshot, freshness: 'current', phase: 'idle', progress: null,
    coverageComplete: true, hasForegroundDemand: false, error: null});
  const unused = async (): Promise<never> => { throw Error('Unexpected body or maintenance operation'); };
  const transport: DocumentTransport = {metadataRowsAvailable: true, status: unused, initialize: unused,
    rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused, metadata: unused,
    search: unused, backlinks: unused, base: unused,
    open: async () => {
      events.push('open');
      const pinId = `pin-${++nextPin}`;
      pins.set(pinId, {snapshot, rows});
      return {pinId, snapshot, source: source(snapshot), coverageComplete: true};
    },
    closePin: async id => { events.push(`close:${id}`); pins.delete(id); },
    metadataRows: async input => {
      requests.push(input);
      const pin = pins.get(input.pinId)!;
      await firstPage.promise;
      if (pageError) throw pageError;
      const offset = input.cursor ? Number(String(input.cursor).split('-')[1]) : 0;
      const selected = pin.rows.slice(offset, offset + 32);
      const cursor = offset + selected.length < pin.rows.length ? `offset-${offset + selected.length}` : null;
      return {result: {snapshot: pin.snapshot, source: source(pin.snapshot), coverageComplete: true,
        value: {snapshot: pin.snapshot, next: null, scanComplete: cursor === null, coverageComplete: true,
          complete: cursor === null, mode: 'reset', from: null, rows: selected, removedEntryIds: []}}, cursor};
    }};
  const service: DocumentService = {...createDocumentService(transport), maintenance: {
    observeAndSubscribe: async callback => {
      events.push('subscribe'); listener = callback;
      if (waitForAttachment) await attachment.promise;
      if (attachmentError) throw attachmentError;
      events.push('observe');
      return {snapshot: update(), unsubscribe: () => { events.push('unsubscribe'); listener = undefined; }};
    }, requestFreshness: () => { throw Error('Projection must not drive maintenance'); }}};
  class Adapter extends MemoryAdapter {
    readonly documentSemantics = service;
    identities = new Map(rows.map(item => {
      if (item.kind !== 'file') throw Error();
      return [item.value.entry.path, item.value.entry] as const;
    }));
    override async list(): Promise<VaultEntry[]> {
      return (await super.list()).map(entry => {
        const identity = this.identities.get(entry.path);
        return {...entry, ...(identity ? {entryId: identity.id, revision: identity.revision} : {})};
      });
    }
    override async read(path: string): Promise<string> { reads.push(path); return super.read(path); }
  }
  const adapter = new Adapter(Object.fromEntries(Array.from({length: count}, (_, index) => [`Note${index}.md`, `body ${index}`])));
  const vault = new Vault(adapter);
  return {adapter, vault, events, reads, requests, pins, firstPage, attachment,
    delayAttachment() { waitForAttachment = true; },
    failAttachment(error: unknown) { attachmentError = error; },
    failPage(error: unknown) { pageError = error; },
    publish(path: string, id: string, revision: string) {
      snapshot = {...snapshot, generation: String(Number(snapshot.generation) + 1)};
      rows = [row(path, id, revision)]; listener?.(update());
    }};
}

test('background initialization releases the namespace and foreground read before full-frame hydration', async () => {
  const h = startupFixture();
  let ready = false, initialized = false, read: string | undefined;
  h.vault.on('ready', () => { ready = true; });
  const initialization = h.vault.initialize({metadata: 'background'}).then(() => { initialized = true; });
  const foreground = h.vault.read('Note0.md').then(value => { read = value; });
  try {
    await until(() => h.requests.length === 1);
    await until(() => initialized && read !== undefined);
    assert.ok(ready);
    assert.equal(h.vault.entries.size, 65);
    assert.equal(read, 'body 0');
    assert.deepEqual(h.reads, ['Note0.md']);
    assert.deepEqual(h.events.slice(0, 3), ['subscribe', 'observe', 'open']);
    assert.deepEqual(h.vault.metadataFrame, {status: 'pending', frame: null});
    assert.equal(h.vault.metadata.get('Note0.md'), undefined);
    h.firstPage.resolve();
    await until(() => h.vault.metadataFrame?.status === 'current');
    assert.equal(h.requests.length, 3);
    assert.equal(h.pins.size, 1);
  } finally {
    h.firstPage.resolve(); h.attachment.resolve();
    await Promise.all([initialization, foreground]);
    await h.vault.closeMetadataProjection();
  }
  assert.equal(h.pins.size, 0);
});

test('default initialize and load retain full-frame await semantics', async () => {
  for (const kind of ['default', 'explicit', 'load'] as const) {
    const h = startupFixture(); let done = false;
    const initialization = (kind === 'load' ? h.vault.load() : kind === 'explicit'
      ? h.vault.initialize({metadata: 'await'}) : h.vault.initialize()).then(() => { done = true; });
    try {
      await until(() => h.requests.length === 1);
      assert.equal(done, false);
      h.firstPage.resolve(); await initialization;
      assert.equal(h.vault.metadataFrame?.status, 'current');
      assert.equal(h.requests.length, 3);
    } finally { h.firstPage.resolve(); await initialization; await h.vault.closeMetadataProjection(); }
  }
});

test('a later load joins background hydration without a second subscription or drain', async () => {
  const h = startupFixture();
  const initialization = h.vault.initialize({metadata: 'background'});
  try {
    await until(() => h.requests.length === 1);
    let initialized = false; void initialization.then(() => { initialized = true; });
    await until(() => initialized);
    let loaded = false; const load = h.vault.load().then(() => { loaded = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(loaded, false);
    h.firstPage.resolve(); await load;
    assert.equal(h.events.filter(value => value === 'subscribe').length, 1);
    assert.equal(h.events.filter(value => value === 'open').length, 1);
    assert.equal(h.requests.length, 3);
  } finally { h.firstPage.resolve(); await initialization; await h.vault.closeMetadataProjection(); }
});

test('namespace reload during hydration completes and the historical frame remains stale', async () => {
  const h = startupFixture(1), initialization = h.vault.initialize({metadata: 'background'});
  try {
    let initialized = false; void initialization.then(() => { initialized = true; });
    await until(() => initialized && h.requests.length === 1);
    await h.adapter.rename('Note0.md', 'Renamed.md');
    h.adapter.identities.delete('Note0.md');
    h.adapter.identities.set('Renamed.md', {id: 'note-0', revision: 'r2', path: 'Renamed.md', kind: 'file', deleted: false});
    await h.vault.reload();
    assert.ok(h.vault.entries.has('Renamed.md'));
    h.firstPage.resolve();
    await until(() => !!h.vault.metadataFrame?.frame);
    assert.equal(h.vault.metadataFrame?.status, 'stale');
    assert.equal(h.vault.metadata.get('Note0.md'), undefined);
    h.publish('Renamed.md', 'note-0', 'r2');
    await until(() => h.vault.metadataFrame?.status === 'current');
    assert.ok(h.vault.metadataFrame?.frame?.row('Renamed.md'));
  } finally { h.firstPage.resolve(); await initialization; await h.vault.closeMetadataProjection(); }
});

test('retirement joins a pending page and suppresses all late frame installation', async () => {
  const h = startupFixture(), initialization = h.vault.initialize({metadata: 'background'});
  try {
    await until(() => h.requests.length === 1);
    let updates = 0, closed = false; h.vault.onMetadata(() => { updates++; });
    const close = h.vault.closeMetadataProjection().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(h.events.filter(value => value === 'unsubscribe').length, 1);
    h.firstPage.resolve(); await close;
    assert.equal(updates, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.pins.size, 0);
    assert.deepEqual(h.vault.metadataFrame, {status: 'unavailable', frame: null});
  } finally { h.firstPage.resolve(); await initialization; await h.vault.closeMetadataProjection(); }
});

test('background initialization awaits attachment and retirement cancels a late attachment before opening pins', async () => {
  const h = startupFixture(); h.delayAttachment();
  let initialized = false;
  const initialization = h.vault.initialize({metadata: 'background'}).then(() => { initialized = true; });
  try {
    await until(() => h.events.includes('subscribe'));
    assert.equal(initialized, false);
    const close = h.vault.closeMetadataProjection();
    h.attachment.resolve(); await Promise.all([initialization, close]);
    assert.equal(h.events.filter(value => value === 'unsubscribe').length, 1);
    assert.equal(h.events.includes('open'), false);
    assert.equal(h.pins.size, 0);
  } finally { h.attachment.resolve(); h.firstPage.resolve(); await initialization; await h.vault.closeMetadataProjection(); }
});

test('attachment and hydration failures leave the usable namespace with an unavailable frame', async () => {
  for (const phase of ['attachment', 'page'] as const) {
    const h = startupFixture(1);
    if (phase === 'attachment') h.failAttachment(Error('subscription failed'));
    else h.failPage(Error('metadata page failed'));
    h.firstPage.resolve();
    try {
      await h.vault.initialize({metadata: 'background'});
      await until(() => h.vault.metadataFrame?.status === 'unavailable');
      assert.equal(h.vault.metadataFrame?.frame, null);
      assert.equal(await h.vault.read('Note0.md'), 'body 0');
      assert.equal(h.pins.size, 0);
    } finally { await h.vault.closeMetadataProjection(); }
  }
});

test('background policy preserves legacy adapters fully awaited metadata indexing', async () => {
  const vault = new Vault(new MemoryAdapter({'Note.md': '# Heading\n#legacy'}));
  await vault.initialize({metadata: 'background'});
  assert.equal(vault.metadataFrame, undefined);
  assert.deepEqual(vault.metadata.get('Note.md')?.tags, ['legacy']);
});
