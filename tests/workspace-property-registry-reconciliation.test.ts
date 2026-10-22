import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import type {NoteBuffer} from '../src/ui/note-buffer.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {ConditionalSavedSourceCapture, DurableWriteInput, DurableWriteIntent, DurableWriteRead, DurableWrites} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

const registry = 'Properties.yaml';
const original = '# registry\nproperties:\n  topics:\n    type: multiselect\n    options:\n      - value: Rust\n        label: Original label\n';
const external = original.replace('Original label', 'External label') + 'externalSentinel: keep\n';
const base = 'views:\n  - type: table\n    name: Table\n    order: [file.name, topics]\n';
async function until(check: () => boolean, label: string) {for (let i = 0; i < 150 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(check(), label);}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
/** Genuine Workspace + BaseSession listeners, shared NoteBuffer and durable save.
 * The explicit simulated boundary keeps physical bytes separate from logical
 * records until rescan() advances Store state and emits the real Vault event.
 * No native filesystem/rescan acceptance is claimed by this focused test. */
async function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div>', {url: 'https://zorid.test/', pretendToBeVisual: true});
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}});
  for (const [key, value] of Object.entries({window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  const files = {[registry]: original, 'Work.base': base, 'One.md': '---\ntopics: [Rust]\n---\nBody\n'};
  const records = new Map<string, DurableWriteRead>(Object.entries(files).map(([path, content]) => [path, {path, content, entryId: path, revision: 'r1', stat: {ctime: 1, mtime: 1, size: content.length}}]));
  let physical = original, serial = 1, captureCount = 0, losePrepare = false;
  const captures = new Map<string, ConditionalSavedSourceCapture>(), inputs = new Map<string, DurableWriteInput>(), intents = new Map<string, DurableWriteIntent>(), checkpoints = new Map<string, Checkpoint>();
  const planned: DurableWriteInput[] = [], released: string[] = [];
  const scope = {vaultId: 'reconciliation-store', clientId: 'reconciliation-client'};
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites;
    override async list() {return (await super.list()).map(row => {const record = records.get(row.path); return record ? {...row, ...record.stat, entryId: record.entryId, revision: record.revision} : row;});}
    override async stat(path: string) {const row = await super.stat(path), record = records.get(path); return row && record ? {...row, ...record.stat, entryId: record.entryId, revision: record.revision} : row;}
  }
  const adapter = new Adapter(files);
  adapter.durableWrites = {
    checkpoints: {scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      const old = checkpoints.get(change.key); assert.equal(change.expectedRevision, old?.revision ?? null);
      const next: Checkpoint = {version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1), deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '')};
      checkpoints.set(change.key, next); return structuredClone(next);
    }, list: async () => {assert.equal(checkpoints.size, 0); return {items: [], cursor: null, highWater: '0'};}, changes: async () => ({items: [], cursor: null, highWater: '0'})},
    readText: async path => structuredClone(records.get(path) ?? null), readTextById: async id => structuredClone([...records.values()].find(row => row.entryId === id) ?? null),
    captureSavedSource: async witness => {
      const current = records.get(witness.path)!; assert.deepEqual(witness, {entryId: current.entryId, revision: current.revision, path: current.path});
      const capture = {captureId: 'capture-' + ++captureCount, logicalWitness: {...witness}, source: physical}; captures.set(capture.captureId, capture); return structuredClone(capture);
    },
    releaseSavedSource: async id => {released.push(id); captures.delete(id);},
    planWrite: async input => {planned.push(structuredClone(input)); return {version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input)};},
    prepare: async plan => {
      let intent = intents.get(plan.operationId); if (!intent) {inputs.set(plan.operationId, JSON.parse(plan.encodedPlan)); intent = {state: 'prepared', acknowledged: false, ref: {...scope, operationId: plan.operationId, entryId: plan.entryId, token: plan.operationId}}; intents.set(plan.operationId, intent);}
      if (losePrepare) {losePrepare = false; throw Error('Prepare reply lost');} return structuredClone(intent);
    },
    commit: async ref => {
      const old = intents.get(ref.token)!; if (old.state === 'committed' || old.state === 'rejected') return structuredClone(old);
      const input = inputs.get(ref.operationId)!, current = records.get(input.path)!, held = input.conditionalSavedSource && captures.get(input.conditionalSavedSource.captureId);
      let outcome: DurableWriteIntent;
      if (input.conditionalSavedSource && (!held || held.source !== physical)) outcome = {ref, state: 'rejected', acknowledged: false, error: {operationId: ref.operationId, code: 'conditional_source_changed', message: 'Physical saved registry changed'}};
      else {
        assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContent, current.content);
        const next = {...current, content: input.content, revision: 'r' + ++serial, stat: {...current.stat, mtime: serial, size: input.content.length}};
        if (input.path === registry && physical === input.expectedContent) physical = input.content;
        records.set(input.path, next); await adapter.write(input.path, input.content);
        outcome = {ref, state: 'committed', acknowledged: false, receipt: {operationId: ref.operationId, entryId: ref.entryId, revision: next.revision, sequence: String(serial)}};
      }
      intents.set(ref.token, outcome); return structuredClone(outcome);
    },
    query: async ref => structuredClone(intents.get(ref.token) ?? null), listUnacknowledged: async () => [], acknowledge: async ref => {const intent = intents.get(ref.token)!; if (intent.state === 'committed' || intent.state === 'rejected') intents.set(ref.token, {...intent, acknowledged: true});},
  };
  const root = document.querySelector<HTMLElement>('#app')!;
  const workspace = new Workspace(root, (host, options) => {const input = document.createElement('textarea'); input.value = options.value; host.append(input); return {getValue: () => input.value, setValue(value) {input.value = value;}, focus() {input.focus();}, destroy() {input.remove();}, insert(value) {input.value += value; options.onChange(input.value);}};});
  t.after(async () => {try {
    // Only these disposable fixtures: cancel open forms; preserve pending writes
    // during assertions and explicitly discard their unresolved fixture afterward.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.bases-property-settings button')) if (button.textContent === 'Cancel') button.click();
    try {await workspace.destroy();} catch {}
  } finally {dom.window.close(); for (const [key, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}}});
  await workspace.start({adapter, id: 'test:registry-reconciliation', label: 'Registry reconciliation'}); await workspace.openNote('Work.base');
  const label = () => document.querySelector<HTMLInputElement>('.bases-property-settings [aria-label="Option label"]')!;
  const button = (text: string, scope: ParentNode = document) => {const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === text || item.textContent === text); assert.ok(value, text); value.click();};
  const settings = async () => {button('Properties', workspace.activePane.element); button('Configure property topics'); button('Property type'); await until(() => !!label(), 'property settings mounted');};
  const changeLabel = (value: string) => {label().value = value; label().dispatchEvent(new dom.window.Event('input', {bubbles: true}));};
  const apply = async () => {button('Apply', document.querySelector('.bases-property-settings')!); await tick(); await tick();};
  return {workspace, internal: workspace as any, dom, adapter, records, planned, released, captures, settings, label, button, changeLabel, apply,
    get physical() {return physical;}, get captureCount() {return captureCount;}, physicalChange() {physical = external;}, losePrepareReply() {losePrepare = true;},
    async rescan() {const current = records.get(registry)!; records.set(registry, {...current, content: physical, revision: 'r' + ++serial, stat: {...current.stat, mtime: serial, size: physical.length}}); await adapter.write(registry, physical); await workspace.vault.reload([registry]);},
    async registryBuffer(): Promise<NoteBuffer> {return workspace.buffers.get(registry) ?? await (workspace as any).baseBufferFor(registry, () => {});},
  };
}

test('genuine registry rescan refreshes its clean shared buffer before a fresh reopened Apply', async t => {
  const f = await setup(t); await f.settings(); f.changeLabel('Retained local label'); f.physicalChange(); await f.apply();
  const buffer = f.workspace.buffers.get(registry)!;
  assert.equal(f.label().value, 'Retained local label'); assert.equal(buffer.savedText, original); assert.equal(buffer.dirty, false); assert.equal(f.planned.length, 0); assert.equal(f.physical, external);
  f.button('Cancel', document.querySelector('.bases-property-settings')!);
  await f.rescan();
  await until(() => buffer.savedText === external, 'a genuine modify event must reconcile the existing clean registry buffer');
  assert.equal(f.workspace.buffers.get(registry), buffer); assert.equal(buffer.savedDurableWitness!.revision, 'r2');
  await f.settings(); assert.equal(f.label().value, 'External label'); f.changeLabel('Accepted fresh label'); await f.apply();
  assert.equal(document.querySelector('.bases-property-settings'), null); assert.match(f.physical, /Accepted fresh label/); assert.match(f.physical, /externalSentinel: keep/); assert.match(f.physical, /# registry/);
  assert.equal(f.planned.length, 1); assert.equal(f.planned[0].expectedContent, external); assert.equal(f.planned[0].expectedRevision, 'r2'); assert.equal(f.captureCount, 2);
});


test('registry rescan never reloads or discards an unrelated dirty shared source draft', async t => {
  const f = await setup(t), buffer = await f.registryBuffer();
  const draft = original + 'localDraft: retain\n'; buffer.update(draft);
  const reload = buffer.reload.bind(buffer); let reloads = 0; buffer.reload = async (...args) => {reloads++; return reload(...args);};
  f.physicalChange(); await f.rescan(); await tick(); await tick();
  assert.equal(reloads, 0); assert.equal(f.workspace.buffers.get(registry), buffer); assert.equal(buffer.text, draft); assert.equal(buffer.savedText, original); assert.equal(buffer.savedDurableWitness!.revision, 'r1');
  assert.equal(buffer.dirty, true); assert.equal(f.physical, external); assert.equal(f.records.get(registry)!.content, external); assert.equal(f.planned.length, 0);
});

test('registry rescan preserves an original pending guarded proof and its exact uncertain retry', async t => {
  const f = await setup(t); await f.settings(); f.changeLabel('Retained local label'); f.losePrepareReply(); await f.apply();
  const buffer = f.workspace.buffers.get(registry)!, draft = buffer.text, input = structuredClone(f.planned[0]);
  assert.match(document.querySelector('.bases-property-settings [role="alert"]')!.textContent!, /Prepare reply lost/); assert.ok(input.conditionalSavedSource);
  const proof = input.conditionalSavedSource!.captureId; assert.equal(f.captures.has(proof), true);
  const reload = buffer.reload.bind(buffer); let reloads = 0; buffer.reload = async (...args) => {reloads++; return reload(...args);};
  f.physicalChange(); await f.rescan(); await tick(); await tick();
  assert.equal(reloads, 0); assert.equal(f.workspace.buffers.get(registry), buffer); assert.equal(buffer.text, draft); assert.equal(buffer.savedText, original); assert.equal(buffer.savedDurableWitness!.revision, 'r1');
  assert.equal(f.captures.has(proof), true); assert.deepEqual(f.planned, [input]); assert.equal(f.captureCount, 1); assert.equal(f.label().value, 'Retained local label');
  // Retry must settle the old intent against the new source, not manufacture a
  // fresh capture or replace its input with the newly observed registry state.
  await f.apply(); assert.equal(f.planned.length, 1); assert.deepEqual(f.planned[0], input); assert.equal(f.captureCount, 1);
  assert.equal(buffer.hasRecoveryConflict, true); assert.equal(buffer.text, draft); assert.equal(f.physical, external); assert.equal(f.records.get(registry)!.content, external);
});

test('a draft accepted by a later modify listener before queued reconciliation prevents clean-buffer reload', async t => {
  const f = await setup(t), buffer = await f.registryBuffer(), draft = original + 'arrivedAfterEvent: retain\n';
  const reload = buffer.reload.bind(buffer); let reloads = 0; buffer.reload = async (...args) => {reloads++; return reload(...args);};
  // Workspace's listener first observes a clean buffer and queues its work.
  // This genuine later listener accepts input before that microtask runs.
  const stop = f.workspace.vault.on('modify', change => {if (change.path === registry) buffer.update(draft);});
  try {f.physicalChange(); await f.rescan(); await tick(); await tick();}
  finally {stop();}
  assert.equal(reloads, 0); assert.equal(buffer.text, draft); assert.equal(buffer.savedText, original); assert.equal(f.physical, external); assert.equal(f.records.get(registry)!.content, external);
});

test('rescan refreshes clean saved state without replacing a still-open stale settings form', async t => {
  const f = await setup(t); await f.settings(); f.changeLabel('Retained local label');
  const label = f.label(), buffer = await f.registryBuffer();
  f.physicalChange(); await f.rescan(); await until(() => buffer.savedText === external, 'clean baseline follows actual logical rescan');
  assert.equal(label.isConnected, true); assert.equal(label.value, 'Retained local label');
  await f.apply();
  assert.equal(label.isConnected, true); assert.equal(label.value, 'Retained local label'); assert.match(document.querySelector('.bases-property-settings [role="alert"]')!.textContent!, /definition changed/);
  assert.equal(buffer.text, external); assert.equal(f.physical, external); assert.equal(f.planned.length, 0);
  f.button('Cancel', document.querySelector('.bases-property-settings')!); await f.settings(); assert.equal(f.label().value, 'External label');
});
