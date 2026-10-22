import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {createBasePropertyDefinitionSaver} from '../src/bases/property-definition-save.ts';
import {createBasePropertySettingsPanel} from '../src/bases/property-settings-panel.ts';
import {parseBasePropertyDefinitions} from '../src/bases/property-definitions.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {ConditionalSavedSourceCapture, DurableWrites, DurableWriteInput, DurableWriteIntent, DurableWriteRead, DurableWriteRef} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

const path = 'Properties.yaml';
const original = '# registry comment\nproperties:\n  topics:\n    type: multiselect\n    options:\n      - value: Rust\n        label: Original label\n';
const changed = original.replace('Original label', 'External label') + 'externalSentinel: keep\n';
const next: BasePropertyDefinition = {type: 'multiselect', options: [{value: 'Rust', label: 'Local label'}]};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

/** Actual shared Vault/NoteBuffer/panel with a simulated native boundary. Physical
 * saved bytes deliberately diverge from the logical record WITHOUT any rescan.
 * This is a consumer regression, not a native Store/filesystem acceptance test. */
async function fixture() {
  let physical = original, serial = 1, capturesTaken = 0;
  let current: DurableWriteRead = {entryId: 'registry-id', revision: 'r1', path, content: original, stat: {ctime: 1, mtime: 1, size: original.length}};
  const checkpoints = new Map<string, Checkpoint>(), captures = new Map<string, ConditionalSavedSourceCapture>();
  const intents = new Map<string, DurableWriteIntent>(), inputs = new Map<string, DurableWriteInput>();
  const planned: DurableWriteInput[] = [], prepared: unknown[] = [], committed: DurableWriteRef[] = [], released: string[] = [];
  let beforeCapture: (() => Promise<void>) | undefined, beforeCommit: (() => Promise<void>) | undefined, beforeRelease: (() => Promise<void>) | undefined;
  let prepareUnknown = false, commitUnknown = false, releaseFailures = 0, releaseFailure: unknown = Error('Release reply lost');
  const scope = {vaultId: 'registry-store', clientId: 'registry-client'};
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites;
    override async list() { return (await super.list()).map(row => row.path === path ? {...row, ...current.stat, entryId: current.entryId, revision: current.revision} : row); }
    override async stat(target: string) { const row = await super.stat(target); return row && target === path ? {...row, ...current.stat, entryId: current.entryId, revision: current.revision} : row; }
  }
  const adapter = new Adapter({[path]: original});
  const unused = async (): Promise<never> => { throw Error('Unexpected fixture operation'); };
  adapter.durableWrites = {
    checkpoints: {scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      const old = checkpoints.get(change.key); assert.equal(change.expectedRevision, old?.revision ?? null);
      const value: Checkpoint = {version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1), deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '')};
      checkpoints.set(change.key, value); return structuredClone(value);
    }, list: unused, changes: unused},
    readText: async () => structuredClone(current), readTextById: async id => id === current.entryId ? structuredClone(current) : null,
    captureSavedSource: async witness => {
      assert.deepEqual(witness, {entryId: current.entryId, revision: current.revision, path});
      const capture = {captureId: 'capture-' + ++capturesTaken, logicalWitness: {...witness}, source: physical}; captures.set(capture.captureId, capture);
      await beforeCapture?.(); return structuredClone(capture);
    },
    releaseSavedSource: async id => { released.push(id); await beforeRelease?.(); if (releaseFailures-- > 0) throw releaseFailure; captures.delete(id); },
    planWrite: async input => { planned.push(structuredClone(input)); return {version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input)}; },
    prepare: async plan => {
      prepared.push(structuredClone(plan));
      let intent = intents.get(plan.operationId);
      if (!intent) { inputs.set(plan.operationId, JSON.parse(plan.encodedPlan)); intent = {ref: {...scope, operationId: plan.operationId, entryId: plan.entryId, token: plan.operationId}, state: 'prepared', acknowledged: false}; intents.set(plan.operationId, intent); }
      if (prepareUnknown) { prepareUnknown = false; throw Error('Prepare reply lost'); }
      return structuredClone(intent);
    },
    commit: async ref => {
      committed.push(structuredClone(ref)); await beforeCommit?.();
      let intent = intents.get(ref.token)!;
      if (intent.state !== 'committed' && intent.state !== 'rejected') {
        const input = inputs.get(ref.operationId)!;
        const capture = input.conditionalSavedSource && captures.get(input.conditionalSavedSource.captureId);
        if (input.conditionalSavedSource && (!capture || capture.source !== physical)) {
          intent = {ref, state: 'rejected', acknowledged: false, error: {operationId: ref.operationId, code: 'conditional_source_changed', message: 'Physical saved source changed'}};
        } else {
          assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContent, current.content);
          const project = physical === input.expectedContent;
          current = {...current, content: input.content, revision: 'r' + ++serial, stat: {...current.stat, mtime: serial, size: input.content.length}};
          await adapter.write(path, input.content); if (project) physical = input.content;
          intent = {ref, state: 'committed', acknowledged: false, receipt: {operationId: ref.operationId, entryId: ref.entryId, revision: current.revision, sequence: String(serial)}};
        }
        intents.set(ref.token, intent);
      }
      if (commitUnknown) { commitUnknown = false; throw Error('Commit reply lost'); }
      return structuredClone(intent);
    },
    query: async ref => structuredClone(intents.get(ref.token) ?? null), listUnacknowledged: async () => [],
    acknowledge: async ref => { const intent = intents.get(ref.token)!; if (intent.state === 'committed' || intent.state === 'rejected') intents.set(ref.token, {...intent, acknowledged: true}); },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const buffer = new NoteBuffer(vault, path, {debounceMs: 60000}); await buffer.load();
  const saver = createBasePropertyDefinitionSaver();
  const save = (property: string, definition: BasePropertyDefinition | null, expected?: BasePropertyDefinition | null) => saver.save(buffer, property, definition, expected, () => {});
  return {vault, buffer, planned, prepared, committed, released, captures, save, get capturesTaken() {return capturesTaken;}, get physical() {return physical;}, get logical() {return current.content;}, get revision() {return current.revision;},
    external(source = changed) {physical = source;}, beforeCapture(fn: typeof beforeCapture) {beforeCapture = fn;}, beforeCommit(fn: typeof beforeCommit) {beforeCommit = fn;}, beforeRelease(fn: typeof beforeRelease) {beforeRelease = fn;},
    losePrepareReply() {prepareUnknown = true;}, loseCommitReply() {commitUnknown = true;}, failRelease() {releaseFailures++; releaseFailure = Error('Release reply lost');}, failReleaseWith(error: unknown) {releaseFailures++; releaseFailure = error;},
    async prepareBase() {await adapter.write('Work.base', 'views:\n  - type: table\n    name: Registry\n    order: [file.name, topics]\n'); await vault.reload(['Work.base']);},
    async reloadExternal() {current = {...current, content: physical, revision: 'r' + ++serial}; await adapter.write(path, physical); await buffer.reload();},
    async close() {beforeCapture = beforeCommit = beforeRelease = undefined; try {await buffer.dispose();} catch {}},
  };
}
function panelFor(f: Awaited<ReturnType<typeof fixture>>) {
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), doc = dom.window.document;
  const failures: unknown[] = [];
  const panel = createBasePropertySettingsPanel(doc.querySelector('main')!, {
    definitions: () => parseBasePropertyDefinitions(f.buffer.savedText), properties: () => ['note.topics'], preflight() {}, onDraftChange() {}, onError(error) {failures.push(error);}, save: f.save,
  });
  panel.open('topics'); const label = doc.querySelector<HTMLInputElement>('[aria-label="Option label"]')!;
  label.value = 'Local label'; label.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  return {dom, doc, panel, failures, label, async apply() {doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true})); await tick(); await tick();}, close() {panel.destroy(); dom.window.close();}};
}

test('Apply rejects pre-rescan physical registry divergence and retains the exact form and logical baseline', async () => {
  const f = await fixture(), ui = panelFor(f);
  try {
    f.external(); await ui.apply();
    assert.equal(ui.panel.hasDraft(), true, 'Apply must not false-ACK and close the local draft');
    assert.equal(ui.label.isConnected, true); assert.equal(ui.label.value, 'Local label'); assert.match(ui.doc.querySelector('[role="alert"]')!.textContent!, /saved.*changed|external/i);
    assert.equal(f.logical, original); assert.equal(f.revision, 'r1'); assert.equal(f.buffer.text, original); assert.equal(f.buffer.savedText, original); assert.equal(f.physical, changed);
    assert.equal(f.planned.length, 0); assert.equal(f.capturesTaken, 1); assert.deepEqual(f.released, ['capture-1']);
  } finally {ui.close(); await f.close();}
});

test('a physical race after capture rejects authorship and keeps both the form and recoverable shared draft', async () => {
  const f = await fixture(), ui = panelFor(f);
  try {
    f.beforeCommit(async () => {f.external();}); await ui.apply();
    assert.equal(ui.panel.hasDraft(), true); assert.equal(ui.label.value, 'Local label'); assert.equal(ui.label.isConnected, true);
    assert.equal(f.logical, original); assert.equal(f.revision, 'r1'); assert.equal(f.physical, changed);
    assert.equal(f.buffer.savedText, original); assert.match(f.buffer.text, /Local label/); assert.equal(f.buffer.hasRecoveryConflict, true);
    assert.equal(f.planned.length, 1); assert.ok(f.planned[0].conditionalSavedSource); assert.equal(f.capturesTaken, 1); assert.deepEqual(f.released, ['capture-1']);
  } finally {ui.close(); await f.close();}
});

for (const phase of ['prepare', 'commit'] as const) test(`lost ${phase} reply retries the exact original proof, operation, plan and draft`, async () => {
  const f = await fixture(), ui = panelFor(f);
  try {
    if (phase === 'prepare') f.losePrepareReply(); else f.loseCommitReply();
    await ui.apply(); assert.equal(ui.panel.hasDraft(), true); assert.equal(f.planned.length, 1); assert.equal(f.capturesTaken, 1);
    const input = structuredClone(f.planned[0]), plan = structuredClone(f.prepared[0]);
    await ui.apply();
    assert.equal(ui.panel.hasDraft(), false); assert.equal(ui.doc.querySelector('[role="dialog"]'), null);
    assert.equal(f.planned.length, 1); assert.deepEqual(f.planned[0], input); assert.ok(f.prepared.every(value => JSON.stringify(value) === JSON.stringify(plan)));
    assert.equal(f.capturesTaken, 1); assert.equal(f.logical, f.physical); assert.match(f.logical, /Local label/); assert.match(f.logical, /# registry comment/);
    assert.equal(f.buffer.dirty, false); assert.equal(f.buffer.error, null); assert.deepEqual(f.released, ['capture-1']);
  } finally {ui.close(); await f.close();}
});

test('reopening after a genuine logical reload preserves external registry keys on fresh Apply', async () => {
  const f = await fixture(); let ui = panelFor(f);
  try {
    f.external(); await ui.apply(); assert.equal(ui.panel.hasDraft(), true); ui.close();
    await f.reloadExternal(); ui = panelFor(f); await ui.apply();
    assert.equal(ui.panel.hasDraft(), false); assert.equal(f.logical, f.physical); assert.match(f.logical, /externalSentinel: keep/); assert.match(f.logical, /# registry comment/); assert.match(f.logical, /Local label/);
    assert.equal(f.capturesTaken, 2); assert.equal(f.planned.length, 1);
  } finally {ui.close(); await f.close();}
});

test('different Base sessions and ordinary-note controls cannot replace another pending registry attempt', async () => {
  const f = await fixture(), other = createBasePropertyDefinitionSaver();
  const expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    f.losePrepareReply(); await assert.rejects(f.save('topics', next, expected), /Prepare reply lost/);
    const retained = f.buffer.text, input = structuredClone(f.planned[0]);
    await assert.rejects(other.save(f.buffer, 'topics', next, expected, () => {}), /original shared draft|pending/);
    await assert.rejects(other.save(f.buffer, 'another', {type: 'number'}, undefined, () => {}), /original shared draft|pending/);
    assert.equal(f.buffer.text, retained); assert.equal(f.planned.length, 1); assert.equal(f.capturesTaken, 1); assert.deepEqual(f.planned[0], input);
    await f.save('topics', next, expected); assert.equal(f.buffer.dirty, false); assert.equal(f.physical, retained);
    await other.save(f.buffer, 'another', {type: 'number'}, undefined, () => {}); assert.equal(parseBasePropertyDefinitions(f.physical).properties.another.type, 'number');
  } finally {await f.close();}
});

test('failed unused-proof release remains owned, retries that same release, and never recaptures while unresolved', async () => {
  const f = await fixture(), other = createBasePropertyDefinitionSaver();
  const expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    f.external(); f.failRelease(); await assert.rejects(f.save('topics', next, expected), /Releasing.*also failed/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.captures.size, 1); assert.equal(f.planned.length, 0); assert.equal(f.buffer.text, original);
    await assert.rejects(other.save(f.buffer, 'topics', next, expected, () => {}), /pending/); assert.deepEqual(f.released, ['capture-1']);
    await assert.rejects(f.save('topics', next, expected), /saved source changed/);
    assert.equal(f.capturesTaken, 1); assert.deepEqual(f.released, ['capture-1', 'capture-1']); assert.equal(f.captures.size, 0);
    await f.reloadExternal(); await other.save(f.buffer, 'topics', next, parseBasePropertyDefinitions(changed).properties.topics, () => {});
    assert.equal(f.capturesTaken, 2); assert.match(f.physical, /externalSentinel: keep/);
  } finally {await f.close();}
});

test('request definitions are deep snapshots and latest shared unrelated draft is preserved', async () => {
  const f = await fixture();
  const definition = structuredClone(next), expected = structuredClone(parseBasePropertyDefinitions(original).properties.topics);
  let finish!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  f.beforeCapture(async () => {enter(); await new Promise<void>(resolve => {finish = resolve;});});
  try {
    const saving = f.save('topics', definition, expected); await entered;
    (definition.options![0] as {label: string}).label = 'Mutated UI label'; (expected.options![0] as {label: string}).label = 'Mutated expected';
    f.buffer.update(original + 'localUnrelated: retain\n'); finish(); await saving;
    assert.match(f.physical, /Local label/); assert.doesNotMatch(f.physical, /Mutated/); assert.match(f.physical, /localUnrelated: retain/);
    assert.equal(f.planned[0].expectedContent, original); assert.equal(f.planned[0].conditionalSavedSource!.logicalWitness.revision, 'r1');
  } finally {finish?.(); await f.close();}
});

test('a selected definition changed in the latest shared draft is independently rejected without losing that draft', async () => {
  const f = await fixture(), expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    const local = original.replace('Original label', 'Other shared label'); f.buffer.update(local);
    await assert.rejects(f.save('topics', next, expected), /definition changed/);
    assert.equal(f.buffer.text, local); assert.equal(f.buffer.savedText, original); assert.equal(f.physical, original); assert.equal(f.logical, original); assert.equal(f.planned.length, 0); assert.deepEqual(f.released, ['capture-1']);
  } finally {await f.close();}
});

test('newer typing cannot be silently resubmitted as the original uncertain registry command', async () => {
  const f = await fixture(), expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    f.losePrepareReply(); await assert.rejects(f.save('topics', next, expected), /Prepare reply lost/);
    const retained = f.buffer.text + 'newerLocalDraft: retain\n'; f.buffer.update(retained);
    await assert.rejects(f.save('topics', next, expected), /pending/);
    assert.equal(f.buffer.text, retained); assert.equal(f.planned.length, 1); assert.equal(f.capturesTaken, 1);
  } finally {await f.close();}
});


test('a no-op Apply holds a failed release until explicit retry without a hidden second call', async () => {
  const f = await fixture(), other = createBasePropertyDefinitionSaver();
  const expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    f.failRelease(); await assert.rejects(f.save('topics', expected, expected), /Release reply lost/);
    assert.deepEqual(f.released, ['capture-1']); assert.equal(f.capturesTaken, 1); assert.equal(f.captures.size, 1); assert.equal(f.planned.length, 0);
    await assert.rejects(other.save(f.buffer, 'topics', expected, expected, () => {}), /pending/);
    assert.deepEqual(f.released, ['capture-1']);
    await f.save('topics', expected, expected);
    assert.deepEqual(f.released, ['capture-1', 'capture-1']); assert.equal(f.capturesTaken, 1); assert.equal(f.captures.size, 0);
    assert.equal(f.planned.length, 0); assert.equal(f.logical, original); assert.equal(f.physical, original);
  } finally {await f.close();}
});


test('actual Base session retains its separate shared-buffer host guard across physical capture', async () => {
  const f = await fixture(); await f.prepareBase();
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true}), doc = dom.window.document;
  let hostCurrent = true, hostChecks = 0; const errors: unknown[] = [];
  const session = createBaseSession(doc.querySelector('main')!, {vault: f.vault, basePath: 'Work.base', validate() {}, openFile() {},
    buffers: {getBuffer(target) {assert.equal(target, path); return f.buffer;}, validate() {hostChecks++; if (!hostCurrent) throw Error('Shared registry buffer host retired');}}, onError(error) {errors.push(error);}});
  const click = (label: string) => {const button = doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(button, label); button.click();};
  try {
    await session.ready; assert.equal(session.state.error, null);
    click('Properties'); click('Configure property topics');
    const propertyType = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Property type'); assert.ok(propertyType); propertyType.click();
    const label = doc.querySelector<HTMLInputElement>('[aria-label="Option label"]')!; assert.ok(label);
    label.value = 'Local label'; label.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    f.beforeCapture(async () => {hostCurrent = false;});
    doc.querySelector('.bases-property-settings form')!.dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true})); await tick(); await tick();
    assert.ok(hostChecks > 1); assert.equal(label.isConnected, true); assert.equal(label.value, 'Local label'); assert.match(doc.querySelector('.bases-property-settings [role="alert"]')!.textContent!, /buffer host retired/);
    assert.equal(f.logical, original); assert.equal(f.physical, original); assert.equal(f.buffer.text, original); assert.equal(f.planned.length, 0); assert.deepEqual(f.released, ['capture-1']);
  } finally {
    hostCurrent = true;
    [...doc.querySelectorAll<HTMLButtonElement>('.bases-property-settings button')].find(button => button.textContent === 'Cancel')?.click();
    try {await session.close();} catch {}
    dom.window.close(); await f.close();
  }
});


for (const rejection of [undefined, null, false, 0, '']) test(`unused-proof cleanup ownership does not depend on rejection truthiness (${String(rejection)})`, async () => {
  const f = await fixture(), other = createBasePropertyDefinitionSaver();
  const expected = parseBasePropertyDefinitions(original).properties.topics;
  try {
    f.failReleaseWith(rejection);
    await assert.rejects(f.save('topics', expected, expected), error => error === rejection);
    assert.deepEqual(f.released, ['capture-1']); assert.equal(f.capturesTaken, 1);
    await assert.rejects(other.save(f.buffer, 'topics', expected, expected, () => {}), /pending/);
    await f.save('topics', expected, expected);
    assert.deepEqual(f.released, ['capture-1', 'capture-1']); assert.equal(f.capturesTaken, 1); assert.equal(f.planned.length, 0);
  } finally {await f.close();}
});

for (const retry of [false, true]) test(`no-op Apply revalidates its host after awaited unused-proof release (${retry ? 'explicit retry' : 'first attempt'})`, async () => {
  const f = await fixture(), saver = createBasePropertyDefinitionSaver();
  const expected = parseBasePropertyDefinitions(original).properties.topics;
  let valid = true; const validate = () => {if (!valid) throw Error('Registry owner retired during release');};
  try {
    if (retry) {f.failRelease(); await assert.rejects(saver.save(f.buffer, 'topics', expected, expected, validate), /Release reply lost/);}
    f.beforeRelease(async () => {await Promise.resolve(); valid = false;});
    await assert.rejects(saver.save(f.buffer, 'topics', expected, expected, validate), /retired during release/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.captures.size, 0); assert.equal(f.planned.length, 0); assert.equal(f.logical, original); assert.equal(f.physical, original);
    valid = true; f.beforeRelease(undefined);
    // Completed cleanup must not leave a ghost owner blocking other controls.
    await createBasePropertyDefinitionSaver().save(f.buffer, 'topics', expected, expected, validate);
    assert.equal(f.capturesTaken, 2);
  } finally {valid = true; await f.close();}
});
