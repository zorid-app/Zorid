import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {inlineBaseRequest,replaceInlineBaseSource} from '../src/bases/inline-base.ts';
import type {BaseSession,BaseSessionOptions} from '../src/bases/session.ts';
import type {BaseSourceStorageCustody} from '../src/bases/controller.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead,ConditionalSavedSourceCapture} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftRead,IndependentDraftReceipt} from '../src/core/independent-drafts.ts';
const path='Parent.md';
const original='\ufeff# Before 🌱\r\n\r\n```base\r\nviews: []\r\n```\r\n\r\nAfter α remains exact.\r\n';
const nextSource='views:\n  - type: table\n    name: Collection\n    source: {kind: collection, id: eeeeeeeeeeee}\n';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
/** Consumer-contract Native boundary: physical bytes are independent from the
 * logical record, with actual bound independent journal CAS and original refs.
 * This neither launches Native nor claims filesystem/CRDT parity. */
async function nativeBoundary(initialSource = original) {
  const referenceNotes:Record<string,string>={};
  let generation = 1, physical = initialSource, captureCount = 0;
  let current: DurableWriteRead = {path, entryId: 'base-id', revision: 'r1', content: initialSource, stat: {ctime: 1, mtime: 1, size: Buffer.byteLength(initialSource)}};
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
  let onPlan: ((input: DurableWriteInput) => Promise<void>) | undefined, onCommit: (() => Promise<void>) | undefined, onCapture: (() => Promise<void>) | undefined, onAccepted:(()=>Promise<void>)|undefined;
  const scope = {vaultId: 'config-store', clientId: 'config-client'};
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites; independentDrafts!:IndependentDraftProvider;
    override async list() { return (await super.list()).map(row => savedRecord(row.path) ? {...row, ...savedRecord(row.path).stat, entryId: savedRecord(row.path).entryId, revision: savedRecord(row.path).revision} : row); }
    override async stat(target: string) { const row = await super.stat(target); return row && savedRecord(target) ? {...row, ...savedRecord(target).stat, entryId: savedRecord(target).entryId, revision: savedRecord(target).revision} : row; }
  }
  const adapter = new Adapter({[path]: initialSource, ...referenceNotes});
  const unused = async (): Promise<never> => { throw Error('Unexpected fixture operation'); };
  adapter.durableWrites = {
    checkpoints: {scope, load: async key => structuredClone(checkpoints.get(key) ?? null), compareAndSwap: async change => {
      const old = checkpoints.get(change.key),attempt=JSON.stringify([change.key,change.nextRevision]),fingerprint=JSON.stringify(change);
      if(checkpointRequests.has(attempt)){assert.equal(checkpointRequests.get(attempt),fingerprint,'exact Core checkpoint replay retains its original expected revision and payload');assert.equal(old?.revision,change.nextRevision,'a completed checkpoint identity cannot be resurrected after a later head');return structuredClone(old!);}
      assert.equal(change.expectedRevision, old?.revision ?? null);
      const next: Checkpoint = {version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: String(Number(old?.sequence ?? 0) + 1), deleted: change.encodedState === null, byteLength: Buffer.byteLength(change.encodedState ?? '')};
      checkpoints.set(change.key, next);checkpointRequests.set(attempt,fingerprint);return structuredClone(next);
    }, list: async()=>({items:[],cursor:null,highWater:'0'}), changes:async()=>({items:[],cursor:null,highWater:'0'})},
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
        const next = {...saved, content: input.content, revision: 'r' + ++generation, stat: {...saved.stat, mtime: generation, size: Buffer.byteLength(input.content)}};
        if (input.path === path) current = next; else notes.set(input.path, next);
        await adapter.write(input.path, input.content); if (canProject) { if (input.path === path) physical = input.content; else physicalNotes.set(input.path, input.content); }
        outcome = {ref, state: 'committed', acknowledged: false, receipt: {operationId: ref.operationId, entryId: ref.entryId, revision: next.revision, sequence: String(generation)}};
      }
      intents.set(ref.token, outcome);await onAccepted?.();return structuredClone(outcome);
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
  return {adapter,planned,committed,requestIds,captures,released,journal,checkpoints,
    get physical(){return physical;},get logical(){return current.content;},
    external(text:string){physical=text;},setCommit(fn:typeof onCommit){onCommit=fn;},setAccepted(fn:typeof onAccepted){onAccepted=fn;},
    clearHooks(){onPlan=undefined;onCommit=undefined;onCapture=undefined;onAccepted=undefined;}};
}
async function fixture(t:TestContext){
 const native=await nativeBoundary(),dom=new JSDOM('<body><main></main>',{url:'https://inline-custody.test/',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};t.mock.method(console,'error',()=>{});
 let options!:BaseSessionOptions,published=0,live=true;
 const workspace=new Workspace(document.querySelector<HTMLElement>('main')!,(host,config)=>{const input=document.createElement('textarea');input.value=config.value;host.append(input);return{getValue:()=>input.value,setValue(value){input.value=value;},focus(){},destroy(){input.remove();},insert(value){input.value+=value;config.onChange(input.value);}};},{base:(_host,input)=>{options=input;return {ready:Promise.resolve(),state:{},flush:async()=>{},close:async()=>{},refresh:async()=>{},selectView:async()=>{},setCurrentFile(){},hasPendingChanges:()=>false} as unknown as BaseSession;}});
 await workspace.start({adapter:native.adapter,id:'test:inline-custody',label:'Inline custody'});await workspace.openNote(path);
 const internal=workspace as any,buffer=workspace.buffers.get(path)!,unblockers=new Set<()=>void>();
 const request=inlineBaseRequest(original,original.indexOf('```base'),original.indexOf('```',original.indexOf('```base')+3)+3)!;assert.ok(request);
 const host=document.createElement('section');workspace.activePane.element.append(host);
 const session=internal.createWorkspaceBaseSession(host,path,()=>workspace.activePane,()=>{if(!live)throw Error('The Workspace owner changed');},undefined,undefined,request,undefined,()=>{published++;return true;});
 assert.ok(options.inlineSource,'the actual Workspace factory supplies the inline IO owner');
 const expected=replaceInlineBaseSource(original,request,nextSource);
 t.after(async()=>{for(const unblock of unblockers)unblock();native.clearHooks();try{await session.close().catch(()=>{});await workspace.destroy().catch(()=>{});}finally{dom.window.close();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
 return {native,workspace,buffer,unblock(fn:()=>void){unblockers.add(fn);},source:options.inlineSource!,expected,get published(){return published;},retire(){live=false;}};
}

function custody(publication:()=>void=()=>{}){
 let submitted=0,accepted=0,acknowledged:(()=>boolean)|undefined;
 const callbacks:BaseSourceStorageCustody={submitted(proof){submitted++;acknowledged=proof;},accepted(){assert.equal(acknowledged?.(),true,'custody acceptance needs the real original NoteBuffer acknowledgment');accepted++;},validatePublication:publication};
 return{callbacks,get submitted(){return submitted;},get accepted(){return accepted;},proof:()=>acknowledged?.()};
}

test('actual inline factory acknowledges accepted whole-parent storage once while retiring old renderer publication',async t=>{
 const f=await fixture(t),entered=gate(),reply=gate();let publication=true;const held=custody(()=>{if(!publication)throw Object.assign(Error('Old collection renderer retired'),{code:'collection_publication_retired'});});
 f.native.setAccepted(async()=>{entered.resolve();await reply.promise;});f.unblock(reply.resolve);
 const operation=f.source.transform('views: []\n',nextSource,()=>{},()=>{},held.callbacks),outcome=operation.then(()=>null,error=>error);
 await entered.promise;assert.equal(f.native.logical,f.expected);assert.equal(f.native.physical,f.expected);assert.equal(f.buffer.dirty,true);assert.equal(held.submitted,1);assert.equal(held.accepted,0);assert.equal(held.proof(),false);
 publication=false;reply.resolve();assert.equal((await outcome)?.code,'collection_publication_retired');assert.equal(held.accepted,1);assert.equal(f.published,0);assert.equal(f.buffer.dirty,false);assert.equal(f.buffer.error,null);
 assert.equal(f.native.planned.length,1);assert.equal(f.native.committed.length,1);assert.equal(f.native.requestIds.length,1);assert.equal(f.native.planned[0].expectedContent,original);assert.equal(f.native.planned[0].content,f.expected);assert.equal(f.buffer.savedText,f.expected);assert.match(f.native.physical,/After α remains exact\./);
});

test('typed temporary source failure keeps original capture/ref and stable write custody across a retired attempt',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();let first=true,attempt=true;const held=custody(()=>{if(!attempt)throw Object.assign(Error('Old collection renderer retired'),{code:'collection_publication_retired'});});
 f.native.setCommit(async()=>{if(first){first=false;entered.resolve();await release.promise;throw Object.assign(Error('Temporary source IO'),{code:'storage_busy',source:'host',commitUncertain:false});}});f.unblock(release.resolve);
 const operation=f.source.transform('views: []\n',nextSource,()=>{if(!attempt)throw Error('Old attempt');},()=>{},held.callbacks),failure=operation.catch(error=>error);
 await entered.promise;t.mock.timers.enable({apis:['setTimeout']});attempt=false;release.resolve();await failure;const retry=f.source.captureSaveRetry?.();assert.ok(retry,'the original source operation owns an exact retry capsule');
 const retried=retry!().catch(error=>error);for(let n=0;n<12;n++)await tick();t.mock.timers.tick(500);for(let n=0;n<12;n++)await tick();t.mock.timers.reset();
 assert.equal((await retried)?.code,'collection_publication_retired');assert.equal(f.buffer.dirty,false);assert.equal(f.native.logical,f.expected);assert.equal(f.native.physical,f.expected);assert.equal(held.submitted,1);assert.equal(held.accepted,1);assert.equal(f.published,0);
 assert.equal(f.native.planned.length,1);assert.equal(f.native.requestIds.length,1);assert.ok(f.native.committed.length>=2);assert.equal(new Set(f.native.committed).size,1,'the same original Native prepared ref is retried');
});

test('newer parent input is retained and cannot acknowledge or reauthor the old inline source after its held ACK',async t=>{
 const f=await fixture(t),entered=gate(),reply=gate(),held=custody();f.native.setAccepted(async()=>{entered.resolve();await reply.promise;});f.unblock(reply.resolve);
 const operation=f.source.transform('views: []\n',nextSource,()=>{},()=>{},held.callbacks).catch(error=>error);await entered.promise;
 const newer=f.expected+'\r\nNewer body draft must remain.\r\n';f.buffer.update(newer);reply.resolve();assert.ok(await operation);assert.equal(f.buffer.text,newer);assert.equal(held.accepted,0);assert.equal(f.published,0);
 const plans=f.native.planned.length,retry=f.source.captureSaveRetry?.();if(retry)await assert.rejects(retry(),/containing note changed|retained inline/);assert.equal(f.native.planned.length,plans);assert.equal(f.buffer.text,newer);
});

for(const race of ['before-capture','after-capture']as const)test(`external physical parent motion ${race} cannot be overwritten or acknowledged`,async t=>{
 const f=await fixture(t),external=original+'\r\nExternal physical bytes.\r\n',held=custody();
 if(race==='before-capture')f.native.external(external);else f.native.setCommit(async()=>{f.native.external(external);});
 await assert.rejects(f.source.transform('views: []\n',nextSource,()=>{},()=>{},held.callbacks),/saved containing note changed|draft preserved|physical|source changed/i);
 assert.equal(f.native.physical,external);assert.equal(f.native.logical,original);assert.equal(held.accepted,0);assert.equal(f.published,0);
 if(race==='before-capture'){assert.equal(f.native.planned.length,0);assert.equal(f.buffer.text,original);assert.equal(f.native.released.length,1);}
 else{assert.equal(f.native.planned.length,1);assert.equal(f.buffer.text,f.expected);assert.equal(f.buffer.hasRecoveryConflict,true);}
});
