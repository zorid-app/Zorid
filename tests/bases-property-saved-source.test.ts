import test from 'node:test';
import assert from 'node:assert/strict';
import {BaseController, createBaseMutationHost} from '../src/bases/controller.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {readProperties} from '../src/core/properties.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
import type {ConditionalSavedSourceCapture, DurableWrites, DurableWriteInput, DurableWriteIntent, DurableWriteRead} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {DocumentService, DocumentBaseResult} from '../src/core/document-semantics.ts';

const note9 = '---\nscore: 9\nuntouched: keep\n---\nSaved body 😀\n';
const note2 = note9.replace('score: 9', 'score: 2');
const path = 'Work.base';
const original = '# keep comment\nplugin: {z: [one, 2]}\nviews:\n  - type: table\n    name: First\n    order: [file.name, score]\n    extension: {unknown: true}\n  - {type: list, name: Second}\n';
/** Real Vault/NoteBuffer/mutation host/shared query, with an explicit native-boundary
 * model: physical bytes can change independently of the logical Store record.
 * This tests the consumer contract, not native filesystem/CRDT correctness. */
async function fixture(referenceNotes: Record<string, string> = {'A.md': note9, 'B.md': note2}) {
  let generation = 1, physical = original, captureCount = 0;
  let current: DurableWriteRead = {path, entryId: 'base-id', revision: 'r1', content: original, stat: {ctime: 1, mtime: 1, size: original.length}};
  const notes = new Map<string, DurableWriteRead>(), physicalNotes = new Map<string, string>();
  for (const [target, content] of Object.entries(referenceNotes)) {
    notes.set(target, {path: target, content, entryId: 'ref-' + target, revision: 'r1', stat: {ctime: 1, mtime: 1, size: content.length}}); physicalNotes.set(target, content);
  }
  const savedRecord = (target: string) => target === path ? current : notes.get(target)!;
  const physicalSource = (target: string) => target === path ? physical : physicalNotes.get(target);
  let backlinkCalls = 0;
  const renamed: string[] = [];
  const checkpoints = new Map<string, Checkpoint>(), captures = new Map<string, ConditionalSavedSourceCapture>();
  const intents = new Map<string, DurableWriteIntent>(), inputs = new Map<string, {input: DurableWriteInput; source?: string}>();
  const planned: DurableWriteInput[] = [], committed: string[] = [], released: string[] = [];
  let onPlan: ((input: DurableWriteInput) => Promise<void>) | undefined, onCommit: (() => Promise<void>) | undefined, onCapture: (() => Promise<void>) | undefined;
  const scope = {vaultId: 'config-store', clientId: 'config-client'};
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites; documentSemantics!: DocumentService;
    override async list() { return (await super.list()).map(row => savedRecord(row.path) ? {...row, ...savedRecord(row.path).stat, entryId: savedRecord(row.path).entryId, revision: savedRecord(row.path).revision} : row); }
    override async stat(target: string) { const row = await super.stat(target); return row && savedRecord(target) ? {...row, ...savedRecord(target).stat, entryId: savedRecord(target).entryId, revision: savedRecord(target).revision} : row; }
  }
  const adapter = new Adapter({[path]: original, ...referenceNotes});
  const unused = async (): Promise<never> => { throw Error('Unexpected fixture operation'); };
  adapter.durableWrites = {
    checkpoints: {scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      const old = checkpoints.get(change.key); assert.equal(change.expectedRevision, old?.revision ?? null);
      const next: Checkpoint = {version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1), deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '')};
      checkpoints.set(change.key, next); return structuredClone(next);
    }, list: unused, changes: unused},
    readText: async target => structuredClone(savedRecord(target)), readTextById: async id => structuredClone([current, ...notes.values()].find(row => row.entryId === id) ?? null),
    captureSavedSource: async witness => {
      const row = savedRecord(witness.path); assert.deepEqual(witness, {entryId: row.entryId, revision: row.revision, path: witness.path});
      const capture = {captureId: 'capture-' + ++captureCount, logicalWitness: {...witness}, source: physicalSource(witness.path)!}; captures.set(capture.captureId, capture);
      await onCapture?.(); return structuredClone(capture);
    },
    releaseSavedSource: async id => { released.push(id); captures.delete(id); },
    planWrite: async input => { planned.push(structuredClone(input)); await onPlan?.(input); return {version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input)}; },
    prepare: async plan => {
      const old = intents.get(plan.operationId); if (old) return structuredClone(old);
      const input = JSON.parse(plan.encodedPlan) as DurableWriteInput;
      inputs.set(plan.operationId, {input, source: input.conditionalSavedSource && captures.get(input.conditionalSavedSource.captureId)?.source});
      const row: DurableWriteIntent = {state: 'prepared', acknowledged: false, ref: {...scope, operationId: plan.operationId, entryId: plan.entryId, token: plan.operationId}};
      intents.set(plan.operationId, row); return structuredClone(row);
    },
    commit: async ref => {
      committed.push(ref.token); await onCommit?.(); const old = intents.get(ref.token)!; if (old.state === 'committed' || old.state === 'rejected') return structuredClone(old);
      const held = inputs.get(ref.operationId)!, input = held.input, saved = savedRecord(input.path); let outcome: DurableWriteIntent;
      if (input.conditionalSavedSource && held.source !== physicalSource(input.path)) outcome = {ref, state: 'rejected', acknowledged: false, error: {operationId: ref.operationId, code: 'conditional_source_changed', message: 'Physical saved source changed'}};
      else {
        assert.equal(input.expectedEntryId, saved.entryId); assert.equal(input.expectedRevision, saved.revision); assert.equal(input.expectedContent, saved.content);
        const canProject = physicalSource(input.path) === input.expectedContent;
        const next = {...saved, content: input.content, revision: 'r' + ++generation, stat: {...saved.stat, mtime: generation, size: input.content.length}};
        if (input.path === path) current = next; else notes.set(input.path, next);
        await adapter.write(input.path, input.content); if (canProject) { if (input.path === path) physical = input.content; else physicalNotes.set(input.path, input.content); }
        outcome = {ref, state: 'committed', acknowledged: false, receipt: {operationId: ref.operationId, entryId: ref.entryId, revision: next.revision, sequence: String(generation)}};
      }
      intents.set(ref.token, outcome); return structuredClone(outcome);
    },
    query: async ref => structuredClone(intents.get(ref.token) ?? null), listUnacknowledged: async () => [],
    acknowledge: async ref => { const row = intents.get(ref.token)!; if (row.state === 'committed' || row.state === 'rejected') intents.set(ref.token, {...row, acknowledged: true}); },
  };
  const snapshot = () => ({localStoreId: 'config-store', generationEpoch: 'epoch', generation: String(generation), versions: {schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1'}});
  const watermark = () => ({localStoreId: 'config-store', watermark: String(generation)});
  adapter.documentSemantics = {
    status: async () => ({source: watermark(), snapshot: snapshot(), coveredSource: watermark(), current: true, rebuildRequired: false, coverageComplete: true}), initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const saved = structuredClone(current), savedNotes = structuredClone(notes), snap = snapshot(), source = watermark(), entry = {id: saved.entryId, revision: saved.revision, path, kind: 'file' as const, deleted: false};
      return {pinId: 'pin' as never, snapshot: snap, source, coverageComplete: true, close: async () => {}, search: unused,
        backlinks: async () => {
          backlinkCalls++; const edges = [...savedNotes.values()].flatMap(row => {
            const destination = 'Work.base#First', start = row.content.indexOf(destination); if (start < 0) return [];
            const range = (a: number, b: number) => ({utf16: [a, b] as [number, number], bytes: [a, b] as [number, number]});
            return [{source: {id: row.entryId, revision: row.revision, path: row.path, kind: 'file' as const, deleted: false}, target: entry, linkIndex: 0,
              link: {kind: 'wiki' as const, embed: false, target: path, fragment: '#First', destination, targetRange: range(start, start + path.length), range: range(start, start + destination.length), definitionRange: null}}];
          });
          return {result: {source, snapshot: snap, coverageComplete: true, value: {snapshot: snap, edges, next: null, scanComplete: true, coverageComplete: true, complete: true}}, cursor: null};
        },
        metadata: async () => ({source, snapshot: snap, coverageComplete: true, value: {entry, metadata: null, exclusion: null}}),
        base: async request => {
          const view = BaseDocument.parse(saved.content).views[request.options?.viewIndex ?? 0];
          const rows = [...savedNotes.values()].map(row => {
            const raw = readProperties(row.content).find(item => item.key.toLowerCase() === 'score')?.value;
            const value = raw == null ? {type: 'null' as const} : typeof raw === 'number' ? {type: 'number' as const, value: raw} : {type: 'string' as const, value: String(raw)};
            return {entryId: row.entryId, revision: row.revision, path: row.path, values: {'note.score': value}, editValues: {'note.score': value}};
          });
          const result: DocumentBaseResult = {snapshotId: snap, view, rows, groups: [{key: null, keyId: null, entryIds: rows.map(row => row.entryId)}], groupOptions: [], properties: ['note.score'], availableProperties: ['note.score'], counts: {scanned: rows.length, matched: rows.length, afterGroupOrder: rows.length, afterSearch: rows.length, returned: rows.length}, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1};
          return {source, snapshot: snap, coverageComplete: true, value: {definition: entry, result}};
        }};
    },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const buffers = new Map<string, NoteBuffer>(); const getBuffer = async (target: string) => { let value = buffers.get(target); if (!value) { value = new NoteBuffer(vault, target, {debounceMs: 60000}); buffers.set(target, value); } await value.load(); return value; };
  const buffer = await getBuffer(path); let alive = true;
  const controller = new BaseController({vault, basePath: path, mutations: createBaseMutationHost({getBuffer, validate() { if (!alive) throw Error('Retired config host'); }}), onViewRenamed: event => renamed.push(event.to), delayMs: 1000});
  await controller.refresh(); assert.equal(controller.state.error, null);
  return {vault, adapter, buffer, controller, getBuffer, physicalSource, planned, committed, released, captures, renamed, get backlinkCalls() { return backlinkCalls; },
    get physical() { return physical; }, get logical() { return current.content; }, get capturesTaken() { return captureCount; },
    externalPhysical(target: string, content: string) { physicalNotes.set(target, content); },
    async externalReference(target: string, content: string) { const old = notes.get(target); notes.set(target, {path: target, content, entryId: old?.entryId ?? 'ref-' + target, revision: old ? 'external-revision' : 'r1', stat: {ctime: 1, mtime: 2, size: content.length}}); physicalNotes.set(target, content); await adapter.write(target, content); },
    external(source: string) { physical = source; }, retire() { alive = false; },
    setPlan(fn: typeof onPlan) { onPlan = fn; }, setCommit(fn: typeof onCommit) { onCommit = fn; }, setCapture(fn: typeof onCapture) { onCapture = fn; },
    async close() { controller.dispose(); onPlan = undefined; onCommit = undefined; for (const value of buffers.values()) { try { await value.dispose(); } catch {} } },
  };
}


test('physical score7 against pinned logical9 rejects ordinary clear before any draft or commit', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'); const dirty = note9 + 'Retained local body\n'; a.update(dirty);
    const physical = note9.replace('score: 9', 'score: 7'); f.externalPhysical('A.md', physical);
    await assert.rejects(f.controller.editProperties([{version: f.controller.state.version, path: 'A.md', property: 'score', value: null}]), /physical saved source changed/);
    assert.equal(a.text, dirty); assert.equal(a.savedText, note9); assert.equal(f.physicalSource('A.md'), physical); assert.equal(await f.vault.read('A.md'), note9);
    assert.equal(f.planned.length, 0); assert.equal(f.committed.length, 0); assert.equal(f.capturesTaken, 1); assert.deepEqual(f.released, ['capture-1']);
  } finally { await f.close(); }
});

test('raw-only physical property formatting changes are guarded despite equal parsed number', async () => {
  const f = await fixture(); try {
    const physical = note9.replace('score: 9', 'score: 9.0'); assert.equal(readProperties(physical)[0].value, 9); f.externalPhysical('A.md', physical);
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null}), /physical saved source changed/);
    assert.equal(f.physicalSource('A.md'), physical); assert.equal(await f.vault.read('A.md'), note9); assert.equal(f.planned.length, 0); assert.equal(f.capturesTaken, 1);
  } finally { await f.close(); }
});

test('ordinary guarded property edit preserves the latest dirty body and records reversible history', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'); a.update(note9 + 'Dirty body 😀\n');
    await f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null});
    assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: null') + 'Dirty body 😀\n');
    assert.equal(f.planned[0].expectedContent, note9); assert.ok(f.planned[0].conditionalSavedSource);
    await f.controller.undo(); assert.equal(f.physicalSource('A.md'), note9 + 'Dirty body 😀\n'); assert.equal(f.capturesTaken, 2);
  } finally { await f.close(); }
});

test('a touched local property draft is preserved after physical admission, without an authored write', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'), draft = note9.replace('score: 9', 'score: 7') + 'Dirty body\n'; a.update(draft);
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null}), /touched property changed in the shared draft/);
    assert.equal(a.text, draft); assert.equal(f.physicalSource('A.md'), note9); assert.equal(f.planned.length, 0); assert.deepEqual(f.released, ['capture-1']);
  } finally { await f.close(); }
});

test('a physical race after capture rejects the original ordinary property intent before logical authorship', async () => {
  const f = await fixture(); try {
    f.setCommit(async () => f.externalPhysical('A.md', note9.replace('score: 9', 'score: 7')));
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null}), /draft preserved/);
    assert.equal(await f.vault.read('A.md'), note9); assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: 7'));
    assert.equal((await f.getBuffer('A.md')).hasRecoveryConflict, true); assert.equal(f.planned.length, 1); assert.ok(f.planned[0].conditionalSavedSource);
  } finally { await f.close(); }
});

test('uncertain retry retains the original physical proof and exact input when a later physical branch appears', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    const edit = {version: f.controller.state.version, path: 'A.md', property: 'score', value: null};
    await assert.rejects(f.controller.editProperty(edit), /could not be planned/);
    f.externalPhysical('A.md', note9.replace('score: 9', 'score: 7'));
    await assert.rejects(f.controller.editProperty(edit), /draft preserved/);
    assert.equal(f.capturesTaken, 1); assert.deepEqual(f.planned[0], f.planned[1]); assert.equal(await f.vault.read('A.md'), note9);
    assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: 7'));
  } finally { await f.close(); }
});

test('generic shared-buffer Save settles the original property command before a fresh edit and undo', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    const edit = {version: f.controller.state.version, path: 'A.md', property: 'score', value: null};
    await assert.rejects(f.controller.editProperty(edit), /could not be planned/);
    await (await f.getBuffer('A.md')).flush(); await f.controller.refresh();
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: 4}), /Retry the original Base property command/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.planned.length, 2);
    await f.controller.editProperty({...edit, version: f.controller.state.version});
    assert.equal(f.capturesTaken, 1); assert.deepEqual(f.planned[0], f.planned[1]); assert.equal(f.planned.length, 2);
    await f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: 4}); assert.equal(f.capturesTaken, 2);
    await f.controller.undo(); assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: null'));
    await f.controller.undo(); assert.equal(f.physicalSource('A.md'), note9); assert.equal(f.capturesTaken, 4);
  } finally { await f.close(); }
});

test('a clean stale buffer reloads only a genuinely reconciled logical query witness before authoring', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'); assert.equal(a.savedText, note9);
    const reconciled = note9.replace('score: 9', 'score: 7'); await f.externalReference('A.md', reconciled); await f.vault.reload(['A.md']); await f.controller.refresh();
    assert.equal(a.savedText, note9, 'the fixture intentionally has no Workspace notification reload');
    await f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null});
    assert.equal(f.planned[0].expectedContent, reconciled); assert.equal(f.planned[0].expectedRevision, 'external-revision');
    assert.equal(f.physicalSource('A.md'), reconciled.replace('score: 7', 'score: null')); assert.equal(f.capturesTaken, 1);
  } finally { await f.close(); }
});

test('a fresh query cannot reload or overwrite an older dirty shared buffer', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'), draft = note9 + 'Retained dirty body\n'; a.update(draft);
    const reconciled = note9.replace('score: 9', 'score: 7'); await f.externalReference('A.md', reconciled); await f.vault.reload(['A.md']); await f.controller.refresh();
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null}), /stale|durable edit identity/);
    assert.equal(a.text, draft); assert.equal(a.savedText, note9); assert.equal(f.physicalSource('A.md'), reconciled); assert.equal(f.planned.length, 0); assert.equal(f.capturesTaken, 0);
  } finally { await f.close(); }
});

test('clean reload rechecks the original host after its await and cannot author for a retired owner', async () => {
  const f = await fixture(); try {
    const a = await f.getBuffer('A.md'), reload = a.reload.bind(a);
    await f.externalReference('A.md', note9.replace('score: 9', 'score: 7')); await f.vault.reload(['A.md']); await f.controller.refresh();
    a.reload = async () => { await reload(); f.retire(); };
    await assert.rejects(f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null}), /Retired config host/);
    assert.equal(f.planned.length, 0); assert.equal(f.capturesTaken, 0); assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: 7'));
  } finally { await f.close(); }
});

test('typing delivered during capture retains its body while a newly touched property draft still blocks the edit', async () => {
  for (const touched of [false, true]) {
    const f = await fixture(); try {
      const a = await f.getBuffer('A.md'); f.setCapture(async () => a.update((touched ? note9.replace('score: 9', 'score: 7') : note9) + 'Typed during capture\n'));
      const edit = f.controller.editProperty({version: f.controller.state.version, path: 'A.md', property: 'score', value: null});
      if (touched) { await assert.rejects(edit, /touched property changed/); assert.equal(f.planned.length, 0); assert.equal(f.physicalSource('A.md'), note9); }
      else { await edit; assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: null') + 'Typed during capture\n'); assert.equal(f.planned[0].expectedContent, note9); }
      assert.match(a.text, /Typed during capture/); assert.equal(f.capturesTaken, 1);
    } finally { await f.close(); }
  }
});

test('bulk guard reports the successful prefix honestly and undo never touches the rejected physical branch', async () => {
  const f = await fixture(); try {
    const bPhysical = note2.replace('score: 2', 'score: 7'); f.externalPhysical('B.md', bPhysical);
    await assert.rejects(f.controller.editProperties(['A.md', 'B.md'].map(path => ({version: f.controller.state.version, path, property: 'score', value: null}))), error => {
      assert.deepEqual((error as any).completedPaths, ['A.md']); assert.equal((error as any).failedPath, 'B.md'); return true;
    });
    assert.equal(f.physicalSource('A.md'), note9.replace('score: 9', 'score: null')); assert.equal(f.physicalSource('B.md'), bPhysical); assert.equal(f.planned.length, 1);
    await f.controller.refresh(); await f.controller.undo(); assert.equal(f.physicalSource('A.md'), note9); assert.equal(f.physicalSource('B.md'), bPhysical); assert.equal(f.capturesTaken, 3);
  } finally { await f.close(); }
});
