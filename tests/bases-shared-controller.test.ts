import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { VaultEntry } from '../src/core/types.ts';
import type { DocumentBaseResult, DocumentPin, DocumentPinId, DocumentService } from '../src/core/document-semantics.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { baseDate, baseValueToString } from '../src/bases/expression.ts';
import { projectSharedBaseResult } from '../src/bases/shared-query.ts';
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
const base = '# Keep comment\npluginRoot: {custom: yes}\nviews:\n  - type: table\n    name: First\n    order: [file.path, Status]\n    unknownView: keep\n  - type: cards\n    name: Second\n';
class IdentityAdapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  revisions = new Map<string, number>();
  identify(entry: VaultEntry): VaultEntry { return { ...entry, entryId: entry.path, revision: `r${this.revisions.get(entry.path) ?? 1}` }; }
  override async list() { return (await super.list()).map(entry => this.identify(entry)); }
  override async stat(path: string) { const entry = await super.stat(path); return entry ? this.identify(entry) : null; }
  override async write(path: string, text: string) { await super.write(path, text); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1); }
}
function result(): DocumentBaseResult {
  return { snapshotId: snapshot, view: { type: 'table', name: 'First' }, rows: [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { 'note.Status': { type: 'string', value: 'From Rust' } } }],
    groups: [{ key: null, entryIds: ['One.md'] }], groupOptions: [], properties: ['note.Status'], availableProperties: ['note.Status'], counts: { scanned: 2, matched: 1, afterGroupOrder: 1, afterSearch: 1, returned: 1 }, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 9 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check()); }
async function fixture() {
  const adapter = new IdentityAdapter({ 'Work.base': base, 'One.md': '---\nStatus: From TypeScript\n---\nbody\n' });
  const edits: { path: string; witness?: { entryId: string; revision: string } }[] = [];
  const calls: Parameters<DocumentPin['base']>[0][] = [], pins: { closed: number }[] = [];
  let hold: ReturnType<typeof deferred<DocumentBaseResult>> | undefined, openGate: ReturnType<typeof deferred<void>> | undefined, closeFailures = 0, fail = false;
  const unused = async (): Promise<never> => { throw new Error('Unexpected index operation'); };
  const definition = async () => { const row = (await adapter.stat('Work.base'))!; return { id: row.entryId!, revision: row.revision!, path: row.path, kind: 'file' as const, deleted: false }; };
  adapter.documentSemantics = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: true }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => { const pin = { closed: 0 }; pins.push(pin); const opening = openGate; openGate = undefined; if (opening) await opening.promise; return { pinId: String(pins.length) as DocumentPinId, snapshot, source, coverageComplete: true,
      close: async () => { pin.closed++; if (closeFailures > 0) { closeFailures--; throw new Error('Close failed once'); } }, search: unused, backlinks: unused,
      metadata: async () => ({ snapshot, source, coverageComplete: true, value: { entry: await definition(), metadata: null, exclusion: null } }),
      base: async input => { calls.push(input); if (fail) throw new Error('Rust unavailable'); const gate = hold; hold = undefined; const value = gate ? await gate.promise : result();
        const document = BaseDocument.parse(await adapter.read('Work.base')); const index = input.options?.viewIndex ?? 0;
        return { snapshot, source, coverageComplete: true, value: { definition: await definition(), result: { ...value, view: document.views[index] } } }; },
    }; },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const published: string[][] = [];
  const controller = new BaseController({ vault, basePath: 'Work.base', query: { maxSteps: 123, now: () => new Date(42) }, delayMs: 1000,
    mutations: { async transform(path, transform, validate, _validateWrite, witness) { edits.push({ path, witness }); validate(); await vault.modify(path, transform(await vault.read(path))); } },
    onChange: state => { if (state.result) published.push(state.result.rows.map(row => row.path)); } });
  await controller.refresh(); assert.equal(controller.state.error, null);
  return { adapter, vault, controller, calls, pins, edits, published, hold() { hold = deferred<DocumentBaseResult>(); return hold; }, holdOpen() { openGate = deferred<void>(); return openGate; }, failCloseOnce() { closeFailures = 1; }, fail() { fail = true; } };
}
test('capable normal Base controller calls shared query with captured identity/options and preserves edits', async () => {
  const f = await fixture(); try {
    assert.deepEqual(f.controller.state.result?.rows[0].values['note.Status'], { type: 'string', value: 'From Rust' });
    assert.deepEqual(f.calls[0].options, { viewIndex: 0, searchTerms: undefined, ignorePaths: undefined, clockMs: 42, timezone: 'UTC', maxRows: 1000, currentEntryId: 'Work.base', maxSteps: 123 });
    assert.ok(f.pins.every(pin => pin.closed === 1));
    await f.controller.editProperty({ version: f.controller.state.version, path: 'One.md', property: 'Status', value: 'Edited' });
    assert.deepEqual(f.edits[0], { path: 'One.md', witness: { entryId: 'One.md', revision: 'r1' } });
    await f.controller.updateView(f.controller.state.version, { name: 'Edited' });
    assert.deepEqual(f.edits[1], { path: 'Work.base', witness: { entryId: 'Work.base', revision: 'r1' } });
    const saved = await f.vault.read('Work.base'); assert.match(saved, /# Keep comment/); assert.match(saved, /pluginRoot/); assert.match(saved, /unknownView: keep/);
    assert.equal(f.controller.state.result?.view.name, 'Edited');
    f.fail(); await f.controller.refresh(); assert.match(f.controller.state.error!.message, /Rust unavailable/); assert.ok(f.pins.every(pin => pin.closed === 1));
  } finally { f.controller.dispose(); }
});
test('shared projection retains Rust row/group order, typed values and exact shared diagnostic codes', () => {
  const r: DocumentBaseResult = { ...result(), rows: [ { entryId: 'b', revision: 'r1', path: 'B.md', values: { date: { type: 'date', timestamp: 123, hasTime: false }, nested: { type: 'object', value: [['z', { type: 'number', value: 1 }], ['a', { type: 'number', value: 2 }], ['__proto__', { type: 'number', value: 3 }]] }, list: { type: 'list', value: [{ type: 'null' }, { type: 'boolean', value: false }] }, error: { type: 'error', code: 'unavailable', message: 'No graph' }, file: { type: 'file', path: 'B.md' }, link: { type: 'link', path: 'Target', target: { entryId: 'target-id', revision: 'target-revision' }, display: null, external: false } } }, { entryId: 'a', revision: 'r1', path: 'A.md', values: {} } ],
  groups: [{ key: { type: 'number', value: 2 }, entryIds: ['a', 'b'] }],
  diagnostics: [{ phase: 'value', entryId: 'b', path: 'B.md', property: null, code: 'numeric-domain', message: 'Invalid number' }] };
  const actual = projectSharedBaseResult(r, 7, []);
  assert.deepEqual(actual.rows.map(row => row.path), ['B.md', 'A.md']); assert.deepEqual(actual.groups[0].rows.map(row => row.path), ['A.md', 'B.md']);
  assert.deepEqual(actual.rows[0].values.date, { type: 'date', timestamp: 123, hasTime: false, presentationTimezone: 'UTC' });
  assert.deepEqual(Object.keys((actual.rows[0].values.nested as any).value), ['z', 'a', '__proto__']); assert.equal((actual.rows[0].values.nested as any).value.__proto__.value, 3); assert.equal((actual.rows[0].values.error as any).error.code, 'unavailable');
  assert.equal((actual.rows[0].values.file as any).name, 'B.md'); assert.deepEqual((actual.rows[0].values.link as any).sharedValue.target, { entryId: 'target-id', revision: 'target-revision' }); assert.ok(Object.isFrozen(actual.view)); assert.equal(actual.diagnostics[0].code, 'numeric-domain'); assert.ok(Object.isFrozen(actual.rows[0].values));
});
test('view changes cancel stale shared results and retire pins before publishing the next selection', async () => {
  const f = await fixture(); try {
    const gate = f.hold(), pending = f.controller.refresh(); await until(() => f.calls.length === 2);
    const changed = f.controller.setView(1); await until(() => f.pins[1].closed === 1);
    gate.resolve({ ...result(), rows: [{ entryId: 'bad', revision: 'r1', path: 'Poison.md', values: {} }], groups: [{ key: null, entryIds: ['bad'] }] });
    await pending; await changed; assert.equal(f.controller.state.result?.view.name, 'Second'); assert.ok(f.published.every(paths => !paths.includes('Poison.md'))); assert.ok(f.pins.every(pin => pin.closed === 1));
  } finally { f.controller.dispose(); }
});
test('dispose during a shared query closes its pin and ignores completion', async () => {
  const f = await fixture(), before = f.controller.state;
  const gate = f.hold(), pending = f.controller.refresh(); await until(() => f.calls.length === 2);
  f.controller.dispose(); await until(() => f.pins[1].closed === 1); gate.resolve(result()); await pending; assert.equal(f.controller.state, before);
});

test('shared date-only display uses invocation timezone without shifting timestamps or legacy local dates', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const timestamp = Date.UTC(2024, 0, 15);
    const project = (instant: number, timezone: string) => projectSharedBaseResult({ ...result(), rows: [{ entryId: 'One.md', revision: 'r1', path: 'One.md', values: { date: { type: 'date', timestamp: instant, hasTime: false } } }] }, 1, [], timezone).rows[0].values.date;
    const shared = project(timestamp, 'UTC');
    assert.equal(baseValueToString(shared), '2024-01-15');
    assert.equal((shared as { timestamp: number }).timestamp, timestamp);
    assert.equal(baseValueToString(project(Date.UTC(2024, 0, 15, 5), 'America/New_York')), '2024-01-15');
    assert.equal(baseValueToString(project(Date.UTC(2024, 0, 14, 22), '+02:00')), '2024-01-15');
    assert.equal(baseValueToString(baseDate(timestamp, false)), '2024-01-14');
    assert.equal(baseValueToString(baseDate(new Date(2024, 0, 15), false)), '2024-01-15');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('a pin opened after dispose remains owned and gets one bounded close retry', async () => {
  const f = await fixture(), before = f.controller.state;
  const gate = f.holdOpen(); f.failCloseOnce(); const pending = f.controller.refresh(); await until(() => f.pins.length === 2);
  f.controller.dispose(); assert.equal(f.pins[1].closed, 0); gate.resolve(); await pending;
  assert.equal(f.pins[1].closed, 2); assert.equal(f.controller.state, before);
});

test('shared mutation admission rejects replacement/revision/missing identity before changing a draft', async () => {
  for (const saved of [undefined, { entryId: 'replacement', revision: 'r1', path: 'One.md' }, { entryId: 'original', revision: 'r2', path: 'One.md' }]) {
    let updates = 0, transforms = 0;
    const buffer = { path: 'One.md', text: 'original body', dirty: false, error: null, savedDurableWitness: saved, async load() {}, update() { updates++; }, async flush() {} };
    const host = createBaseMutationHost({ getBuffer: () => buffer as any, validate() {} });
    await assert.rejects(host.transform('One.md', text => { transforms++; return text + 'changed'; }, () => {}, undefined, { entryId: 'original', revision: 'r1' }), /stale|identity/);
    assert.equal(updates, 0); assert.equal(transforms, 0);
  }
});
test('admitted dirty drafts keep the stable identity through an acknowledged revision advance', async () => {
  let validator!: () => void, flushed = false;
  const buffer = { path: 'One.md', text: 'body plus unsaved typing', dirty: true, error: null, savedDurableWitness: { entryId: 'original', revision: 'r1', path: 'One.md' }, async load() {},
    update(text: string, options: { validateWrite: () => void }) { validator = options.validateWrite; validator(); this.text = text; },
    async flush() { validator(); this.savedDurableWitness = { ...this.savedDurableWitness, revision: 'r2' }; validator(); flushed = true; this.dirty = false; } };
  const host = createBaseMutationHost({ getBuffer: () => buffer as any, validate() {} });
  await host.transform('One.md', text => text + '\nproperty edit', () => {}, undefined, { entryId: 'original', revision: 'r1' });
  assert.ok(flushed); assert.match(buffer.text, /unsaved typing/);
  buffer.savedDurableWitness = { entryId: 'replacement', revision: 'r2', path: 'One.md' };
  assert.throws(validator, /replaced|moved/);
});
test('Vault witnessed rename rejects unseen revision changes and forwards the original pair', async () => {
  const adapter = new IdentityAdapter({ 'One.md': 'original' }), vault = new Vault(adapter); await vault.initialize();
  await adapter.write('One.md', 'external');
  await assert.rejects(vault.rename('One.md', 'Other.md', undefined, { entryId: 'One.md', revision: 'r1' }), { code: 'revision_conflict' });
  assert.equal(await adapter.read('One.md'), 'external'); assert.equal(await adapter.stat('Other.md'), null);
  let forwarded: unknown;
  const original = adapter.rename.bind(adapter);
  adapter.rename = async (oldPath: string, newPath: string, expected?: { entryId: string; revision: string }) => { forwarded = expected; await original(oldPath, newPath); };
  await vault.rename('One.md', 'Other.md', undefined, { entryId: 'One.md', revision: 'r2' });
  assert.deepEqual(forwarded, { entryId: 'One.md', revision: 'r2' }); assert.equal(await adapter.read('Other.md'), 'external');
});
