import test from 'node:test';
import assert from 'node:assert/strict';
import {BaseController, createBaseMutationHost} from '../src/bases/controller.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
import type {ConditionalSavedSourceCapture, DurableWrites, DurableWriteInput, DurableWriteIntent, DurableWriteRead} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftRead,IndependentDraftReceipt} from '../src/core/independent-drafts.ts';
import type {DocumentService, DocumentBaseResult} from '../src/core/document-semantics.ts';

const path = 'Work.base';
const original = '# keep comment\nplugin: {z: [one, 2]}\nviews:\n  - type: table\n    name: First\n    order: [file.name]\n    extension: {unknown: true}\n  - {type: list, name: Second}\n';
/** Real Vault/NoteBuffer/mutation host/shared query, with an explicit native-boundary
 * model: physical bytes can change independently of the logical Store record.
 * This tests the consumer contract, not native filesystem/CRDT correctness. */
async function fixture(referenceNotes: Record<string, string> = {}, initialSource = original, failCollectionQuery = false) {
  let generation = 1, physical = initialSource, captureCount = 0;
  let current: DurableWriteRead = {path, entryId: 'base-id', revision: 'r1', content: initialSource, stat: {ctime: 1, mtime: 1, size: initialSource.length}};
  const notes = new Map<string, DurableWriteRead>(), physicalNotes = new Map<string, string>();
  for (const [target, content] of Object.entries(referenceNotes)) {
    notes.set(target, {path: target, content, entryId: 'ref-' + target, revision: 'r1', stat: {ctime: 1, mtime: 1, size: content.length}}); physicalNotes.set(target, content);
  }
  const savedRecord = (target: string) => target === path ? current : notes.get(target)!;
  const physicalSource = (target: string) => target === path ? physical : physicalNotes.get(target);
  let backlinkCalls = 0;
  const renamed: string[] = [];
  const checkpoints = new Map<string, Checkpoint>(), checkpointRequests=new Map<string,string>(), captures = new Map<string, ConditionalSavedSourceCapture>();
  const intents = new Map<string, DurableWriteIntent>(), inputs = new Map<string, {input: DurableWriteInput; source?: string}>();
  const planned: DurableWriteInput[] = [], committed: string[] = [], released: string[] = [], requestIds:string[]=[];
  const releasedRequests=new Set<string>(),attachedRequests=new Set<string>();
  let onPlan: ((input: DurableWriteInput) => Promise<void>) | undefined, onCommit: (() => Promise<void>) | undefined, onCapture: (() => Promise<void>) | undefined;
  const scope = {vaultId: 'config-store', clientId: 'config-client'};
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites; documentSemantics!: DocumentService; independentDrafts!:IndependentDraftProvider;
    override async list() { return (await super.list()).map(row => savedRecord(row.path) ? {...row, ...savedRecord(row.path).stat, entryId: savedRecord(row.path).entryId, revision: savedRecord(row.path).revision} : row); }
    override async stat(target: string) { const row = await super.stat(target); return row && savedRecord(target) ? {...row, ...savedRecord(target).stat, entryId: savedRecord(target).entryId, revision: savedRecord(target).revision} : row; }
  }
  const adapter = new Adapter({[path]: initialSource, ...referenceNotes});
  const unused = async (): Promise<never> => { throw Error('Unexpected fixture operation'); };
  adapter.durableWrites = {
    checkpoints: {scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      const old = checkpoints.get(change.key),attempt=JSON.stringify([change.key,change.nextRevision]),fingerprint=JSON.stringify(change);
      if(old?.revision===change.nextRevision){assert.equal(checkpointRequests.get(attempt),fingerprint,'exact Core checkpoint replay retains its original expected revision and payload');return structuredClone(old);}
      assert.equal(change.expectedRevision, old?.revision ?? null);
      const next: Checkpoint = {version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1), deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '')};
      checkpoints.set(change.key, next);checkpointRequests.set(attempt,fingerprint);return structuredClone(next);
    }, list: unused, changes: unused},
    readText: async target => structuredClone(savedRecord(target)), readTextById: async id => structuredClone([current, ...notes.values()].find(row => row.entryId === id) ?? null),
    captureSavedSource: async request => {
      captureCount++;requestIds.push(request.captureId);
      assert.match(request.captureId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,'the caller owns the capture UUID');
      const witness=request.logicalWitness,prior=captures.get(request.captureId);
      const acknowledged=[...journal.values()].filter(row=>!row.deleted&&row.entryId===witness.entryId).flatMap(row=>{
        assert.equal(row.vaultId,scope.vaultId);assert.equal(row.clientId,scope.clientId);assert.equal(row.incarnationId,journalScope.incarnationId);
        const capsule=row.pendingOperation===null?null:JSON.parse(row.pendingOperation);
        return capsule?.schemaVersion===2?capsule.captureRequests??[]:[];
      }).filter(claim=>claim.captureId===request.captureId);
      assert.equal(acknowledged.length,1,'Native capture follows the exact independently acknowledged caller request');
      assert.deepEqual(acknowledged[0].scope,journalScope);assert.deepEqual(acknowledged[0].logicalWitness,witness);
      if(prior){assert.deepEqual(witness,prior.logicalWitness,'capture replay retains its original witness');return structuredClone(prior);}
      assert.equal(releasedRequests.has(request.captureId),false,'a released request cannot recapture newer physical bytes');
      const row = savedRecord(witness.path); assert.deepEqual(witness, {entryId: row.entryId, revision: row.revision, path: witness.path});
      const capture = {captureId:request.captureId, logicalWitness:structuredClone(witness), source:physicalSource(witness.path)!}; captures.set(capture.captureId,capture);
      await onCapture?.(); return structuredClone(capture);
    },
    releaseSavedSource: async id => { released.push(id);releasedRequests.add(id);captures.delete(id);attachedRequests.delete(id); },
    listSavedSourceRequests:async()=>[...captures.values()].filter(capture=>!attachedRequests.has(capture.captureId)).map(({captureId,logicalWitness})=>({captureId,logicalWitness:structuredClone(logicalWitness),legacy:false})),
    planWrite: async input => { planned.push(structuredClone(input)); await onPlan?.(input); return {version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input)}; },
    prepare: async plan => {
      const old = intents.get(plan.operationId); if (old) return structuredClone(old);
      const input = JSON.parse(plan.encodedPlan) as DurableWriteInput;
      if(input.conditionalSavedSource){const capture=captures.get(input.conditionalSavedSource.captureId);assert.ok(capture,'prepare needs its original retained physical capture');assert.deepEqual(input.conditionalSavedSource.logicalWitness,capture.logicalWitness);attachedRequests.add(capture.captureId);}
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
  // Bound independent storage is a separate CAS authority. Domain checkpoints
  // never substitute for a positive journal receipt or grant a different scope.
  const journalScope=Object.freeze({...scope,incarnationId:'config-renderer'}),journal=new Map<string,Exclude<IndependentDraftRead,null>>(),journalRequests=new Map<string,string>();
  const journalKey=(entryId:string,writer:string)=>JSON.stringify([entryId,writer]);
  const journalReceipt=(row:Exclude<IndependentDraftRead,null>):IndependentDraftReceipt=>{
    const {vaultId,clientId,incarnationId,entryId,writer,revision,generation,deleted}=row;
    return{vaultId,clientId,incarnationId,entryId,writer,revision,generation,deleted};
  };
  adapter.independentDrafts={scope:journalScope,
    list:async options=>[...journal.values()].filter(row=>!row.deleted&&(!options||row.entryId===options.entryId)).map(row=>structuredClone(journalReceipt(row))),
    read:async address=>{assert.ok(address.incarnationId===undefined||address.incarnationId===journalScope.incarnationId);return structuredClone(journal.get(journalKey(address.entryId,address.writer))??null);},
    compareAndSwap:async request=>{
      const key=journalKey(request.entryId,request.writer),old=journal.get(key),fingerprint=JSON.stringify(request),attempt=JSON.stringify([key,request.nextRevision]);
      assert.equal(request.baseline.entryId,request.entryId);assert.ok(Number.isSafeInteger(request.generation)&&request.generation>=0);
      if(journalRequests.has(attempt)){assert.equal(journalRequests.get(attempt),fingerprint,'uncertain journal CAS replays its exact request');assert.equal(old?.revision,request.nextRevision);return structuredClone(journalReceipt(old!));}
      assert.equal(request.expectedRevision,old?.revision??null);
      const row={...journalScope,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted:false as const,baseline:structuredClone(request.baseline),draft:request.draft,checkpointRevision:request.checkpointRevision,pendingOperation:request.pendingOperation};
      journal.set(key,row);journalRequests.set(attempt,fingerprint);return structuredClone(journalReceipt(row));
    },
    retire:async request=>{
      assert.equal(request.incarnationId,journalScope.incarnationId);
      const key=journalKey(request.entryId,request.writer),old=journal.get(key),fingerprint=JSON.stringify(request),attempt=JSON.stringify([key,request.nextRevision]);
      if(journalRequests.has(attempt)){assert.equal(journalRequests.get(attempt),fingerprint,'uncertain journal retirement replays its exact request');assert.equal(old?.revision,request.nextRevision);return structuredClone(journalReceipt(old!));}
      assert.ok(old);assert.equal(request.expectedRevision,old.revision);
      const row={...journalScope,entryId:request.entryId,writer:request.writer,revision:request.nextRevision,generation:request.generation,deleted:true as const};
      journal.set(key,row);journalRequests.set(attempt,fingerprint);return structuredClone(row);
    },
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
          if (failCollectionQuery && view.source && typeof view.source === 'object' && !Array.isArray(view.source) && view.source.kind === 'collection') throw new Error('collection_deleted');
          const result: DocumentBaseResult = {snapshotId: snap, view, rows: [], groups: [], groupOptions: [], properties: ['file.name'], availableProperties: ['file.name'], counts: {scanned: 0, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0}, diagnostics: [], relationshipsAvailable: true, metadataComplete: true, metadataIssues: [], stepsUsed: 1};
          return {source, snapshot: snap, coverageComplete: true, value: {definition: entry, result}};
        }};
    },
  };
  const vault = new Vault(adapter); await vault.initialize();
  const buffers = new Map<string, NoteBuffer>(); const getBuffer = async (target: string) => { let value = buffers.get(target); if (!value) { value = new NoteBuffer(vault, target, {debounceMs: 60000}); buffers.set(target, value); } await value.load(); return value; };
  const buffer = await getBuffer(path); let alive = true;
  const controller = new BaseController({vault, basePath: path, mutations: createBaseMutationHost({getBuffer, validate() { if (!alive) throw Error('Retired config host'); }}), onViewRenamed: event => renamed.push(event.to), delayMs: 1000});
  await controller.refresh(); if (!failCollectionQuery) assert.equal(controller.state.error, null);
  return {vault, adapter, buffer, controller, planned, committed, released, captures, requestIds, renamed, get backlinkCalls() { return backlinkCalls; },
    get physical() { return physical; }, get logical() { return current.content; }, get capturesTaken() { return captureCount; },
    async externalReference(target: string, content: string) { const old = notes.get(target); notes.set(target, {path: target, content, entryId: old?.entryId ?? 'ref-' + target, revision: old ? 'external-revision' : 'r1', stat: {ctime: 1, mtime: 2, size: content.length}}); physicalNotes.set(target, content); await adapter.write(target, content); },
    async configuration(source: string) { current = {...current,content:source,revision:'r'+ ++generation,stat:{...current.stat,mtime:generation,size:source.length}};physical=source;await adapter.write(path,source);await vault.reload();await controller.refresh(); },
    replaceLogical(source: string, entryId = current.entryId) { current = {...current,entryId,content:source,revision:'r'+ ++generation,stat:{...current.stat,mtime:generation,size:source.length}};physical=source; },
    external(source: string) { physical = source; }, retire() { alive = false; },
    setPlan(fn: typeof onPlan) { onPlan = fn; }, setCommit(fn: typeof onCommit) { onCommit = fn; }, setCapture(fn: typeof onCapture) { onCapture = fn; },
    async close() { controller.dispose(); onPlan = undefined; onCommit = undefined; for (const value of buffers.values()) { try { await value.dispose(); } catch {} } },
  };
}

test('standalone config rejects physically changed whole source before any shared draft or logical write', async () => {
  const f = await fixture(); try {
    const external = original + '# external only\n'; f.external(external);
    await assert.rejects(f.controller.updateConfiguration(f.controller.state.version, {root: {filters: 'file.name == "One"'}}), /saved source changed|external edit/);
    assert.equal(f.buffer.text, original); assert.equal(f.buffer.savedText, original); assert.equal(f.logical, original); assert.equal(f.physical, external);
    assert.equal(f.planned.length, 0); assert.equal(f.committed.length, 0); assert.equal(f.capturesTaken, 1); assert.deepEqual(f.released, [f.requestIds[0]]);
  } finally { await f.close(); }
});

test('a saved-source race after capture rejects durable authorship and keeps the exact recovery draft', async () => {
  const f = await fixture(); try {
    f.setCommit(async () => { f.external(original + '# changed after capture\n'); });
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /draft preserved/);
    assert.equal(f.logical, original); assert.equal(f.physical, original + '# changed after capture\n'); assert.equal(f.buffer.hasRecoveryConflict, true);
    assert.equal(BaseDocument.parse(f.buffer.text).views[0].limit, 12); assert.equal(f.planned.length, 1); assert.ok(f.planned[0].conditionalSavedSource);
  } finally { await f.close(); }
});

test('configuration command retry resumes the same original physical capture and planning input', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    const version = f.controller.state.version;
    await assert.rejects(f.controller.addView(version, 'list', 'Third'), /could not be planned/);
    await f.controller.addView(version, 'list', 'Third');
    assert.equal(f.capturesTaken, 1); assert.deepEqual(f.planned[0], f.planned[1]); assert.equal(BaseDocument.parse(f.logical).views.length, 3);
    assert.equal(f.physical, f.logical); assert.match(f.logical, /# keep comment/); assert.match(f.logical, /extension:/); assert.match(f.logical, /plugin:/);
  } finally { await f.close(); }
});

test('generic shared-buffer Save and config acknowledgement retire only the exact clean original attempt', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    await assert.rejects(f.controller.addView(f.controller.state.version, 'list', 'Third'), /could not be planned/);
    await f.buffer.flush(); assert.equal(await f.controller.acknowledgeConfigurationRetry(), true); assert.equal(f.controller.selectedViewIndex, 2);
    await f.controller.updateView(f.controller.state.version, {limit: 17});
    assert.equal(f.capturesTaken, 2); assert.equal(f.planned.length, 3); assert.deepEqual(f.planned[0], f.planned[1]);
    assert.equal(BaseDocument.parse(f.logical).views[2].limit, 17); assert.equal(BaseDocument.parse(f.logical).views.length, 3); assert.equal(f.physical, f.logical);
  } finally { await f.close(); }
});

test('initial physical text equal to desired still cannot substitute for the original expected source', async () => {
  const f = await fixture(); try {
    const document = BaseDocument.parse(original); document.updateView(0, {limit: 12}); f.external(document.toString());
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /physical saved source changed/);
    assert.equal(f.buffer.text, original); assert.equal(f.logical, original); assert.equal(f.planned.length, 0); assert.equal(f.capturesTaken, 1);
  } finally { await f.close(); }
});

test('an unrelated local config draft is retained and its unattached physical capture is released', async () => {
  const f = await fixture(); try {
    const draft = original + '# local unsaved config\n'; f.buffer.update(draft);
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /unsaved or external edit/);
    assert.equal(f.buffer.text, draft); assert.equal(f.buffer.savedText, original); assert.equal(f.logical, original); assert.equal(f.physical, original);
    assert.equal(f.planned.length, 0); assert.deepEqual(f.released, [f.requestIds[0]]);
  } finally { await f.close(); }
});

test('capture awaited across host retirement or view selection cannot transform the original shared draft', async () => {
  for (const changed of ['host', 'selection']) {
    const f = await fixture(); try {
      f.setCapture(async () => { if (changed === 'host') f.retire(); else await f.controller.setView(1); });
      await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /Retired config host|selected view changed|stale/);
      assert.equal(f.buffer.text, original); assert.equal(f.buffer.savedText, original); assert.equal(f.planned.length, 0); assert.deepEqual(f.released, [f.requestIds[0]]);
    } finally { await f.close(); }
  }
});

test('a different command cannot recapture or replace an uncertain original configuration attempt', async () => {
  const f = await fixture(); try {
    f.setPlan(async () => { throw new DurableWritePlanningError('transport_lost', true); });
    const version = f.controller.state.version; await assert.rejects(f.controller.addView(version, 'list', 'Third'), /could not be planned/);
    const retained = f.buffer.text;
    await assert.rejects(f.controller.updateView(version, {limit: 12}), /original conditional Base command/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.buffer.text, retained); assert.equal(f.planned.length, 1);
    f.setPlan(undefined); await f.buffer.flush(); await f.controller.acknowledgeConfigurationRetry();
    await f.controller.updateView(f.controller.state.version, {limit: 12}); assert.equal(f.capturesTaken, 2);
  } finally { await f.close(); }
});

test('generic settlement with a newer dirty draft cannot retire the old attempt or recapture', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    await assert.rejects(f.controller.addView(f.controller.state.version, 'list', 'Third'), /could not be planned/);
    await f.buffer.flush(); await f.controller.acknowledgeConfigurationRetry();
    const draft = f.buffer.text + '# newer unsaved draft\n'; f.buffer.update(draft);
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /original conditional Base command/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.buffer.text, draft); assert.equal(f.buffer.dirty, true);
  } finally { await f.close(); }
});

test('a terminal rejected guard cannot be retired to admit a new configuration', async () => {
  const f = await fixture(); try {
    f.setCommit(async () => f.external(original + '# external race\n'));
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /draft preserved/);
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 13}), /original conditional Base command/);
    assert.equal(f.capturesTaken, 1); assert.equal(f.buffer.hasRecoveryConflict, true); assert.equal(f.logical, original);
    assert.equal(BaseDocument.parse(f.buffer.text).views[0].limit, 12);
  } finally { await f.close(); }
});

test('uncertain prepared commit retries the original ref and authors the non-idempotent command once', async () => {
  const f = await fixture(); try {
    let first = true; f.setCommit(async () => { if (first) { first = false; throw Error('Original commit reply unavailable'); } });
    const version = f.controller.state.version;
    await assert.rejects(f.controller.addView(version, 'list', 'Third'), error => error instanceof Error && error.message === 'Commit did not return a validated terminal outcome; retain its original ref' && error.cause instanceof Error && error.cause.message === 'Original commit reply unavailable');
    await f.controller.addView(version, 'list', 'Third');
    assert.equal(f.planned.length, 1); assert.equal(f.committed.length, 2); assert.equal(f.committed[0], f.committed[1]); assert.equal(f.capturesTaken, 1);
    assert.equal(BaseDocument.parse(f.logical).views.length, 3); assert.equal(f.physical, f.logical);
  } finally { await f.close(); }
});

test('after generic settlement a new command captures again and rejects newer external config bytes', async () => {
  const f = await fixture(); try {
    let first = true; f.setPlan(async () => { if (first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    await assert.rejects(f.controller.addView(f.controller.state.version, 'list', 'Third'), /could not be planned/);
    await f.buffer.flush(); await f.controller.acknowledgeConfigurationRetry(); const saved = f.logical;
    const external = saved + '# external after acknowledgement\n'; f.external(external);
    await assert.rejects(f.controller.updateView(f.controller.state.version, {limit: 12}), /physical saved source changed/);
    assert.equal(f.capturesTaken, 2); assert.equal(f.planned.length, 2); assert.equal(f.logical, saved); assert.equal(f.buffer.text, saved); assert.equal(f.physical, external);
  } finally { await f.close(); }
});

test('standalone view, root, formula and summary commands all use the same physical whole-file admission', async () => {
  const changes: [string, (controller: BaseController, version: number) => Promise<unknown>][] = [
    ['view settings', (c, v) => c.updateView(v, {columnSize: {'file.name': 140}})],
    ['atomic config', (c, v) => c.updateConfiguration(v, {root: {filters: 'true'}, view: {limit: 12}})],
    ['new view', (c, v) => c.addView(v, 'list', 'Third')],
    ['duplicate view', (c, v) => c.duplicateView(v, 0, 'Copy')],
    ['delete view', (c, v) => c.removeView(v, 1)],
    ['reorder view', (c, v) => c.moveView(v, 0, 1)],
    ['default view', (c, v) => c.setDefaultView(v, 1)],
    ['root setting', (c, v) => c.updateRoot(v, {properties: {'note.rating': {displayName: 'Stars'}}})],
    ['formula', (c, v) => c.setFormula(v, 'Answer', '42')],
    ['formula editor', (c, v) => c.editFormula(v, undefined, 'Answer', '42')],
    ['summary editor', (c, v) => c.editSummary(v, undefined, 'Total', 'values.sum()')],
  ];
  for (const [label, change] of changes) {
    const f = await fixture(); try {
      const external = original + '# external before ' + label + '\n'; f.external(external);
      await assert.rejects(change(f.controller, f.controller.state.version), /physical saved source changed/, label);
      assert.equal(f.buffer.text, original, label); assert.equal(f.logical, original, label); assert.equal(f.physical, external, label);
      assert.equal(f.capturesTaken, 1, label); assert.equal(f.planned.length, 0, label);
    } finally { await f.close(); }
  }
});

test('direct named rename retry returns the original reference outcome and excludes late-created references', async () => {
  const f = await fixture({'One.md': '[[Work.base#First]]'}); try {
    let first = true; f.setPlan(async input => { if (input.path === path && first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    const version = f.controller.state.version;
    await assert.rejects(f.controller.renameView(version, 0, 'Renamed'), /could not be planned/);
    await f.externalReference('Late.md', '[[Work.base#First]]');
    const report = await f.controller.renameView(version, 0, 'Renamed');
    assert.equal(f.backlinkCalls, 1); assert.equal(f.capturesTaken, 1); assert.equal(report.references, 1); assert.deepEqual(report.completedPaths, ['One.md']);
    assert.equal(await f.vault.read('One.md'), '[[Work.base#Renamed]]'); assert.equal(await f.adapter.read('Late.md'), '[[Work.base#First]]'); assert.deepEqual(f.renamed, ['Renamed']);
    const basePlans = f.planned.filter(input => input.path === path); assert.equal(basePlans.length, 2); assert.deepEqual(basePlans[0], basePlans[1]);
  } finally { await f.close(); }
});

test('direct named rename retry keeps the original reference witness rather than adopting a late edit', async () => {
  const f = await fixture({'One.md': '[[Work.base#First]]'}); try {
    let first = true; f.setPlan(async input => { if (input.path === path && first) { first = false; throw new DurableWritePlanningError('transport_lost', true); } });
    const version = f.controller.state.version;
    await assert.rejects(f.controller.renameView(version, 0, 'Renamed'), /could not be planned/);
    await f.externalReference('One.md', 'Changed [[Work.base#First]]'); await f.externalReference('Late.md', '[[Work.base#First]]');
    await assert.rejects(f.controller.renameView(version, 0, 'Renamed'), error => { const report = (error as any).report; assert.deepEqual(report.failedPaths, ['One.md']); assert.deepEqual(report.completedPaths, []); return true; });
    assert.equal(f.backlinkCalls, 1); assert.equal(f.capturesTaken, 1); assert.equal(await f.adapter.read('One.md'), 'Changed [[Work.base#First]]');
    assert.equal(await f.adapter.read('Late.md'), '[[Work.base#First]]'); assert.deepEqual(f.renamed, ['Renamed']); assert.equal(f.controller.hasPendingViewReferences, true);
  } finally { await f.close(); }
});


const deletedSource = 'filters: legacy == true\nviews:\n  - type: table\n    name: Books\n    id: aaaaaaaaaaaa\n    source: {kind: collection, id: books0123456}\n    filters: Status == "Done"\n    order: [file.name, Status]\n    groupBy: {property: Status, direction: ASC}\n';

test('initial genuine collection query failure exposes coherent parsed source and permits only source repair',async()=>{
  const f=await fixture({},deletedSource,true);try{
    assert.match(f.controller.state.error?.message??'',/collection_deleted/);assert.equal(f.controller.state.result,null);
    const read=f.controller.configurationRead;assert.ok(read);assert.equal(read.source,deletedSource);assert.equal(read.entryId,'base-id');assert.equal(read.revision,'r1');assert.equal(read.viewIndex,0);assert.equal(read.viewId,'aaaaaaaaaaaa');
    await assert.rejects(f.controller.updateView(f.controller.state.version,{limit:2}),/stale/);await assert.rejects(f.controller.editProperty({version:f.controller.state.version,path:'One.md',property:'Status',value:'Done'}),/stale/);
    await f.controller.repairViewSource(read,{kind:'untyped'});
    const saved=BaseDocument.parse(f.logical);assert.deepEqual(saved.views[0].source,{kind:'untyped'});assert.equal(saved.views[0].filters,undefined);assert.equal(saved.views[0].groupBy,undefined);assert.equal(saved.views[0].order,undefined);assert.equal(saved.getRoot('filters'),'legacy == true');assert.equal(f.controller.state.error,null);assert.ok(f.controller.state.result);assert.equal(f.physical,f.logical);
  }finally{await f.close();}
});

test('query failure publishes fresh independent read proof while old successful result stays retained; parse failure retires proof',async()=>{
  const f=await fixture({},original,true);try{
    const old=f.controller.state.result;await f.configuration(deletedSource);
    const read=f.controller.configurationRead;assert.ok(read);assert.equal(read.source,deletedSource);assert.equal(f.controller.state.source,original);assert.equal(f.controller.state.result,old);assert.ok(f.controller.state.error);
    await f.configuration('views: [');assert.equal(f.controller.configurationRead,undefined);await assert.rejects(f.controller.repairViewSource(read,{kind:'untyped'}),/changed/);
  }finally{await f.close();}
});

test('source repair rejects forged/stale receipts, replaced durable witnesses and unrelated dirty drafts',async()=>{
  const f=await fixture({},deletedSource,true);try{
    const old=f.controller.configurationRead;assert.ok(old);await assert.rejects(f.controller.repairViewSource({...old},{kind:'untyped'}),/changed/);
    await f.controller.refresh();const current=f.controller.configurationRead;assert.ok(current);assert.notEqual(current,old);await assert.rejects(f.controller.repairViewSource(old,{kind:'untyped'}),/changed/);
    f.buffer.update(deletedSource+'# retained draft\n');await assert.rejects(f.controller.repairViewSource(current,{kind:'untyped'}),/unsaved|external/);assert.equal(f.buffer.text,deletedSource+'# retained draft\n');assert.equal(f.logical,deletedSource);
    f.buffer.update(deletedSource);await f.buffer.flush();
    f.replaceLogical(deletedSource,'replacement-id');await assert.rejects(f.controller.repairViewSource(current,{kind:'untyped'}),/changed/);assert.equal(f.logical,deletedSource);assert.equal(f.planned.length,0);
  }finally{await f.close();}
});

test('source repair preserves external physical changes and refuses selection/epoch motion across admission',async()=>{
  const f=await fixture({},deletedSource,true);try{
    const read=f.controller.configurationRead;assert.ok(read);f.external(deletedSource+'# external\n');
    await assert.rejects(f.controller.repairViewSource(read,{kind:'untyped'}),/physical saved source changed/);assert.equal(f.logical,deletedSource);assert.equal(f.physical,deletedSource+'# external\n');assert.equal(f.buffer.text,deletedSource);
    f.external(deletedSource);f.setCapture(async()=>{await f.controller.refresh();});await assert.rejects(f.controller.repairViewSource(read,{kind:'untyped'}),/changed|retired|stale/);assert.equal(f.logical,deletedSource);assert.equal(f.planned.length,0);
  }finally{await f.close();}
});
