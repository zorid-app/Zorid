import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { DocumentService } from '../src/core/document-semantics.ts';
import type { VaultEntry } from '../src/core/types.ts';
import { closePropertyTargetQueries, queryPropertyTargets } from '../src/bases/property-targets.ts';

const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '7' };
const { captureDocumentRequest } = createRequire(import.meta.url)('../desktop/document-semantics.cjs');
const settingsText = '\uFEFF# exact saved bytes\r\nproperties:\r\n  author: {type: relation, filter: \'file.hasTag("person")\'}\r\n';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class IdentityAdapter extends MemoryAdapter {
  documentSemantics?: DocumentService;
  changes = new Map<string, string>();
  override async list(): Promise<VaultEntry[]> { return (await super.list()).map(entry => ({ ...entry, entryId: `id:${entry.path}`, revision: this.changes.get(entry.path) ?? 'r1' })); }
}
async function fixture(settings = true) {
  const adapter = new IdentityAdapter({ 'One.md': '---\nauthor: []\n---\nordinary note', ...(settings ? { 'Properties.yaml': settingsText } : {}) });
  const calls: any[] = [], events: string[] = [];
  let current = true, capability = true, method = true, staleStatus = false, closeFailures = 0, phase = '', gate: ReturnType<typeof deferred> | undefined;
  let failCore: Error | undefined;
  const pause = async (at: string) => { events.push(at); if (phase === at) { phase = ''; await gate!.promise; } };
  const report = <T>(value: T) => ({ snapshot, source, coverageComplete: true, value });
  const entry = (path: string) => ({ id: `id:${path}`, revision: adapter.changes.get(path) ?? 'r1', path, kind: 'file' as const, deleted: false });
  const value = { definition: settings ? entry('Properties.yaml') : null, relationTargets: { author: [{ entryId: 'id:People/Ada.md', revision: 'ada-r3', path: 'People/Ada.md', label: 'Ada' }] },
    propertyDefinitionDiagnostics: [{ property: 'bad', code: 'configuration', message: 'Saved diagnostic' }], refreshHint: { dependency: 'day' as const, timezone: 'UTC', nextWakeMs: 86400000 } };
  const unused = async (): Promise<never> => { throw new Error('Unexpected operation'); };
  const service = {
    get propertyTargetsAvailable() { return capability; },
    async status() { await pause('status'); return { source, snapshot, coveredSource: source, current: !staleStatus, rebuildRequired: false, coverageComplete: true }; },
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    async open() { await pause('open'); return { pinId: 'pin', snapshot, source, coverageComplete: true,
      async close() { await pause('close'); if (closeFailures-- > 0) throw new Error('Close unavailable'); },
      async metadata(id: string) { await pause(`metadata:${id}`); return report({ entry: entry(id.slice(3)), metadata: null, exclusion: null }); },
      ...(method ? { async propertyTargets(input: unknown) { calls.push(input); await pause('query'); if (failCore) throw failCore; return report(value); } } : {}),
      search: unused, backlinks: unused, base: unused,
    }; },
  } as unknown as DocumentService;
  const vault = new Vault(adapter); await vault.initialize(); adapter.documentSemantics = service;
  const input = { service, vault, current: Object.freeze({ ...vault.entries.get('One.md')! }), isCurrent: () => current,
    readFile: async (path: string) => { await pause('read'); assert.equal(path, 'Properties.yaml'); return adapter.read(path); },
    clock: { capture: () => ({ clockMs: 42, timezone: 'UTC' }), scheduleAt: unused, subscribeWake: unused, isVisible: () => true }, maxSteps: 123 };
  return { adapter, service, input, calls, events, value,
    stale() { current = false; }, unavailable() { capability = false; }, missingMethod() { method = false; }, staleStatus() { staleStatus = true; },
    failClose(count = 1) { closeFailures = count; }, failCore(error: Error) { failCore = error; },
    hold(at: string) { phase = at; gate = deferred(); return gate; },
  };
}
async function until(check: () => boolean) { for (let n = 0; n < 200 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(check()); }

test('ordinary saved note queries only core with exact pinned Properties.yaml source and stable cache witnesses', async () => {
  const f = await fixture();
  const actual = await queryPropertyTargets(f.input);
  assert.deepEqual(f.calls, [{ options: { propertyDefinitionsSource: { id: 'id:Properties.yaml', source: settingsText }, currentEntryId: 'id:One.md', clockMs: 42, timezone: 'UTC', maxRows: 10000, maxSteps: 123 } }]);
  assert.deepEqual(actual.relationTargets, f.value.relationTargets); assert.deepEqual(actual.diagnostics, f.value.propertyDefinitionDiagnostics);
  assert.equal(actual.current.id, 'id:One.md'); assert.equal(actual.settings?.id, 'id:Properties.yaml'); assert.deepEqual(actual.snapshot, snapshot); assert.deepEqual(actual.source, source);
  assert.deepEqual(actual.refreshHint, f.value.refreshHint); assert.equal(actual.coverageComplete, true); assert.equal(actual.clockMs, 42);
  assert.equal(f.events.filter(event => event === 'close').length, 1);
  assert.ok(Object.isFrozen(actual.relationTargets.author[0])); assert.ok(Object.isFrozen(actual.snapshot.versions));
  f.value.relationTargets.author[0].label = 'mutated host object'; assert.equal(actual.relationTargets.author[0].label, 'Ada');
  assert.equal([...f.input.vault.entries.keys()].some(path => path.endsWith('.base')), false);
});
test('no saved property definitions sends no synthetic settings and returns core empty/diagnostic result honestly', async () => {
  const f = await fixture(false);
  f.value.relationTargets = {} as typeof f.value.relationTargets;
  const actual = await queryPropertyTargets(f.input);
  assert.equal(f.calls[0].options.propertyDefinitionsSource, undefined); assert.equal(actual.settings, null); assert.deepEqual(actual.relationTargets, {});
  assert.ok(!f.events.includes('read'));
});
test('default target options omit absent own keys accepted by strict desktop option admission', async () => {
  const f = await fixture(false);
  await queryPropertyTargets({ ...f.input, maxSteps: undefined });
  const options = f.calls[0].options;
  assert.equal(Object.hasOwn(options, 'propertyDefinitionsSource'), false);
  assert.equal(Object.hasOwn(options, 'maxSteps'), false);
  // Both endpoints use the desktop baseOptions validator. The older host in
  // this isolated branch exposes base only; the common shape must pass it too.
  assert.doesNotThrow(() => captureDocumentRequest({ schemaVersion: 1, command: { op: 'base', pinId: '1', id: 'base', options: { ...options, currentEntryId: 'note' } } }));
});
test('absent service or advertised method is unavailable without a local filter fallback', async () => {
  const f = await fixture(); f.unavailable();
  await assert.rejects(queryPropertyTargets(f.input), { code: 'property_targets_unavailable' }); assert.ok(!f.events.includes('open'));
  await assert.rejects(queryPropertyTargets({ ...f.input, service: null }), { code: 'property_targets_unavailable' });
  const g = await fixture(); g.missingMethod();
  await assert.rejects(queryPropertyTargets(g.input), { code: 'property_targets_unavailable' }); assert.equal(g.events.filter(event => event === 'close').length, 1);
});
test('stale await completions never return candidates and retire any acquired pin', async () => {
  for (const phase of ['status', 'open', 'metadata:id:One.md', 'metadata:id:Properties.yaml', 'read', 'query', 'close']) {
    const f = await fixture(), gate = f.hold(phase);
    const pending = queryPropertyTargets(f.input); await until(() => f.events.includes(phase)); f.stale(); gate.resolve();
    await assert.rejects(pending, { code: 'document_request_cancelled' });
    assert.equal(f.events.filter(event => event === 'close').length, phase === 'status' ? 0 : 1, phase);
  }
});
test('failed close rejects successful data and remains owned until acknowledged before next open', async () => {
  const f = await fixture(); f.failClose(2);
  await assert.rejects(queryPropertyTargets(f.input), /Close unavailable/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(queryPropertyTargets(f.input), /Close unavailable/);
  assert.equal(f.events.filter(event => event === 'open').length, 1);
  await closePropertyTargetQueries(f.service);
  await queryPropertyTargets(f.input);
  assert.equal(f.events.filter(event => event === 'close').length, 4); assert.equal(f.calls.length, 2);
});
test('core settings-source mismatch is propagated and never re-evaluated with guessed settings', async () => {
  const f = await fixture(), error = Object.assign(new Error('Saved source does not match pin'), { code: 'index_property_source_mismatch' }); f.failCore(error);
  await assert.rejects(queryPropertyTargets(f.input), candidate => candidate === error);
  assert.equal(f.calls.length, 1); assert.equal(f.events.filter(event => event === 'close').length, 1);
});
test('saved note/settings replacements and revision changes reject before or after core reads', async () => {
  for (const path of ['One.md', 'Properties.yaml']) {
    const f = await fixture(), gate = f.hold('query'), pending = queryPropertyTargets(f.input);
    await until(() => f.events.includes('query')); f.adapter.changes.set(path, 'r2'); gate.resolve();
    await assert.rejects(pending, { code: 'property_targets_stale' }); assert.equal(f.events.filter(event => event === 'close').length, 1);
  }
  const f = await fixture(); f.adapter.changes.set('One.md', 'r2');
  await assert.rejects(queryPropertyTargets(f.input), { code: 'property_targets_stale' }); assert.ok(!f.events.includes('open'));
});
test('source motion across candidate evaluation is stale even when note and settings remain unchanged', async () => {
  const f = await fixture(), gate = f.hold('query'), pending = queryPropertyTargets(f.input);
  await until(() => f.events.includes('query')); f.staleStatus(); gate.resolve();
  await assert.rejects(pending, { code: 'property_targets_stale' }); assert.equal(f.events.filter(event => event === 'close').length, 1);
});
