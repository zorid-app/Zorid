import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {EditorHandle,EditorOptions} from '../src/ui/editor.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteInput,DurableWriteIntent,DurableWriteRef} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftCandidate} from '../src/core/independent-drafts.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean,message='expected owned continuation'){for(let i=0;i<100&&!check();i++)await turn();assert.ok(check(),message);}
async function fixture(t:TestContext,other:'clean'|'dirty'|'operation'|'malformed'|'conflict'|'unavailable'='clean',selectedRecovery:'canonical'|'independent'|'held'='canonical',pendingConditional=0,otherNamespace:'known'|'unknown'|'foreign'='known'){
  const dom=new JSDOM('<main></main>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const scope={vaultId:'deferred-vault',clientId:'deferred-client'},records=new Map<string,DurableWriteRead>(),heads=new Map<string,Checkpoint>();
  for(const path of ['Selected.md','Other.md',...Array.from({length:pendingConditional},(_,i)=>`Pending${i+1}.md`)]){const entryId=path.split('.')[0].toLowerCase();records.set(entryId,{entryId,path,revision:'file-1',content:`Saved ${entryId}`,stat:{ctime:1,mtime:1,size:14}});}
  class Adapter extends MemoryAdapter{durableWrites!:DurableWrites;independentDrafts!:IndependentDraftProvider;
    override async list(){return(await super.list()).map(row=>{const current=[...records.values()].find(record=>record.path===row.path);return current?{...row,entryId:current.entryId==='other'&&otherNamespace!=='known'?(otherNamespace==='unknown'?undefined:'foreign-other'):current.entryId,revision:current.revision}:row;});}}
  const adapter=new Adapter(Object.fromEntries([...records.values()].map(row=>[row.path,row.content])));
  const sourceReads:string[]=[],plans=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>(),journal=new Map<string,IndependentDraftCandidate>(),loaded:string[]=[],queries:string[]=[],committed:string[]=[],planned:string[]=[];
  const captures=new Map<string,{captureId:string;logicalWitness:{entryId:string;path:string;revision:string};source:string}>();let captureAttempts=0;
  let beforeCommit:((ref:DurableWriteRef)=>void|Promise<void>)|undefined,beforeRead:((entryId:string)=>void|Promise<void>)|undefined;
  let otherUnavailable=other==='unavailable';
  let serial=0,releases=0;const held=gate(),entered=gate();
  const writes:DurableWrites={checkpoints:{scope,load:async key=>{loaded.push(key);if(key==='note/v1/other'||selectedRecovery==='held'&&key==='note/v1/selected'){entered.resolve();if(key==='note/v1/other'&&otherUnavailable)throw Error('Other checkpoint unavailable');await held.promise;}return structuredClone(heads.get(key)??null);},
    list:async()=>({items:[...heads.values()].map(({encodedState,...metadata})=>metadata),cursor:null,highWater:String(heads.size)}),changes:async()=>({items:[],cursor:null,highWater:String(heads.size)}),
    compareAndSwap:async change=>{const old=heads.get(change.key);if(old?.revision===change.nextRevision){assert.equal(old.encodedState,change.encodedState);return structuredClone(old);}assert.equal(change.expectedRevision,old?.revision??null);
      const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(++serial),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??''),encodedState:change.encodedState};heads.set(change.key,row);return structuredClone(row);}},
    readText:async path=>{const row=[...records.values()].find(row=>row.path===path)!;sourceReads.push(row.entryId);return structuredClone(row);},readTextById:async id=>{sourceReads.push(id);const value=structuredClone(records.get(id)??null);await beforeRead?.(id);return value;},
    planWrite:async input=>{planned.push(input.operationId);plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:input.expectedEntryId,operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{const input=plans.get(plan.operationId);if(input?.conditionalSavedSource)captures.delete(input.conditionalSavedSource.captureId);const intent:DurableWriteIntent={ref:{...scope,entryId:plan.entryId,operationId:plan.operationId,token:plan.operationId},state:'prepared',acknowledged:false};intents.set(plan.operationId,intent);return structuredClone(intent);},
    query:async ref=>{queries.push(ref.operationId);return structuredClone(intents.get(ref.operationId)??null);},
    commit:async ref=>{await beforeCommit?.(ref);committed.push(ref.operationId);const input=plans.get(ref.operationId)!,old=records.get(ref.entryId)!;assert.equal(input.expectedRevision,old.revision);assert.equal(input.expectedContent,old.content);
      const current={...old,content:input.content,revision:`file-${committed.length+1}`,stat:{...old.stat,size:input.content.length}};records.set(ref.entryId,current);await adapter.write(current.path,current.content);
      const intent:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:current.revision,sequence:String(committed.length)}};intents.set(ref.operationId,intent);return structuredClone(intent);},
    acknowledge:async ref=>{const value=intents.get(ref.operationId)!;if(value.state==='committed'||value.state==='rejected')intents.set(ref.operationId,{...value,acknowledged:true});},listUnacknowledged:async()=>[],};
  if(pendingConditional){
    writes.listSavedSourceRequests=async()=>[...captures.values()].map(({source,...request})=>({...request,legacy:false}));
    writes.releaseSavedSource=async id=>{captures.delete(id);};
    writes.captureSavedSource=async request=>{captureAttempts++;if(captures.size>=8&&!captures.has(request.captureId))throw Object.assign(Error('Conditional capture quota is occupied'),{source:'host',code:'source_capture_capacity'});
      const prior=captures.get(request.captureId);if(prior)return structuredClone(prior);const row={...structuredClone(request),source:records.get(request.logicalWitness.entryId)!.content};captures.set(row.captureId,row);return row;};
  }
  adapter.durableWrites=writes;
  for(let i=1;i<=pendingConditional;i++){
    const entryId=`pending${i}`,base=records.get(entryId)!,captureId=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,logicalWitness={entryId,path:base.path,revision:base.revision};
    captures.set(captureId,{captureId,logicalWitness,source:base.content});
    const input:DurableWriteInput={operationId:`original-pending-${i}`,path:base.path,expectedEntryId:entryId,expectedRevision:base.revision,expectedContent:base.content,content:`Original conditional ${i}`,conditionalSavedSource:{captureId,logicalWitness}};
    const operation={input,content:input.content},encodedState=JSON.stringify({version:1,writer:`saved-${entryId}`,generation:1,base,draft:input.content,conflict:false,operation});
    heads.set(`note/v1/${entryId}`,{version:1,...scope,key:`note/v1/${entryId}`,revision:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,sequence:String(++serial),deleted:false,byteLength:Buffer.byteLength(encodedState),encodedState});
    journal.set(`previous-document:${entryId}:old-${entryId}`,{...scope,incarnationId:'previous-document',entryId,writer:`old-${entryId}`,revision:'1',generation:1,deleted:false,baseline:base,draft:input.content,checkpointRevision:null,
      pendingOperation:JSON.stringify({schemaVersion:2,conflict:false,operation,checkpoint:null,captureRequests:[{captureId,logicalWitness,scope:{...scope,incarnationId:'previous-document'}}]})});
  }
  const journalScope={...scope,incarnationId:'current-document'};
  adapter.independentDrafts={scope:journalScope,isRetiredIncarnation:async()=>true,list:async options=>[...journal.values()].filter(row=>!options||row.entryId===options.entryId).map(({baseline,draft,pendingOperation,checkpointRevision,...receipt})=>receipt),
    read:async address=>structuredClone(journal.get(`${address.incarnationId??journalScope.incarnationId}:${address.entryId}:${address.writer}`)??null),
    compareAndSwap:async change=>{const receipt={...journalScope,entryId:change.entryId,writer:change.writer,revision:change.nextRevision,generation:change.generation,deleted:false as const};journal.set(`${journalScope.incarnationId}:${change.entryId}:${change.writer}`,{...receipt,baseline:structuredClone(change.baseline),draft:change.draft,pendingOperation:change.pendingOperation,checkpointRevision:change.checkpointRevision});return receipt;},
    retire:async change=>{journal.delete(`${change.incarnationId??journalScope.incarnationId}:${change.entryId}:${change.writer}`);return{...journalScope,incarnationId:change.incarnationId??journalScope.incarnationId,entryId:change.entryId,writer:change.writer,revision:change.nextRevision,generation:change.generation,deleted:true};}};
  for(const id of ['other','selected']){const base=records.get(id)!;let operation:unknown;
    if(id==='other'&&other==='operation'){const input:DurableWriteInput={operationId:'original-operation',path:base.path,expectedEntryId:id,expectedRevision:base.revision,expectedContent:base.content,content:'Original pending source'};
      plans.set(input.operationId,input);const plan={version:1,...scope,entryId:id,operationId:input.operationId,encodedPlan:JSON.stringify(input)},ref={...scope,entryId:id,operationId:input.operationId,token:'original-token'};
      intents.set(input.operationId,{ref,state:'commit_requested',acknowledged:false});operation={plan,ref,content:input.content};}
    const draft=id==='selected'?'Recovered selected draft':(other==='dirty'||other==='conflict')?'Recovered other draft':other==='operation'?'Original pending source':base.content;
    const encodedState=id==='other'&&other==='malformed'?'not JSON':JSON.stringify({version:1,writer:`saved-${id}`,generation:draft===base.content?0:1,base,draft,conflict:id==='other'&&other==='conflict',...(operation?{operation}:{})});
    heads.set(`note/v1/${id}`,{version:1,...scope,key:`note/v1/${id}`,revision:`00000000-0000-4000-8000-${id==='other'?'000000000001':'000000000002'}`,sequence:String(++serial),deleted:false,byteLength:Buffer.byteLength(encodedState),encodedState});}
  if(selectedRecovery==='independent'){
    heads.delete('note/v1/selected');journal.set('previous-document:selected:independent-writer',{...scope,incarnationId:'previous-document',entryId:'selected',writer:'independent-writer',revision:'1',generation:1,deleted:false,
      baseline:{...records.get('selected')!},draft:'Recovered independent selected draft',checkpointRevision:null,pendingOperation:null});
  }
  const platformId='test:deferred-startup';dom.window.localStorage.setItem(`zorid:workspace:${platformId}`,JSON.stringify({activePaneId:'pane',panes:[{id:'pane',active:0,tabs:[{id:'selected-tab',path:'Selected.md',kind:'note',mode:'live'}]}]}));
  let editorFrame=false;
  const root=dom.window.document.querySelector<HTMLElement>('main')!,factory=(parent:HTMLElement,options:EditorOptions):EditorHandle=>{dom.window.requestAnimationFrame(()=>{editorFrame=true;});const input=dom.window.document.createElement('textarea');input.value=options.value;parent.append(input);input.oninput=()=>{options.validateChange?.(input.value);options.onChange(input.value);};return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:value=>{input.value+=value;options.onChange(input.value);}};};
  const workspace=new Workspace(root,factory);let started=false;
  const opening=workspace.start({adapter,id:platformId,label:'Deferred test',release:async()=>{releases++;}}).then(()=>{started=true;});void opening.catch(()=>{});
  t.after(async()=>{otherUnavailable=false;held.resolve();try{await opening;for(const[path,buffer]of workspace.buffers){if(buffer.hasRecoveryConflict){await buffer.closeMetadataProjection();workspace.buffers.delete(path);}}if(other==='malformed')heads.delete('note/v1/other');await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  return{dom,workspace,root,adapter,heads,journal,held,entered,opening,loaded,queries,committed,planned,plans,records,captures,sourceReads,setReadHook(hook:(entryId:string)=>void|Promise<void>){beforeRead=hook;},restoreOtherCheckpoint(){otherUnavailable=false;},setCommitHook(hook:(ref:DurableWriteRef)=>void|Promise<void>){beforeCommit=hook;},get captureAttempts(){return captureAttempts;},get editorFrame(){return editorFrame;},get started(){return started;},get releases(){return releases;}};
}

test('selected recovered editor and independent protection do not wait for an unrelated checkpoint body',async t=>{
  const ui=await fixture(t);await until(()=>ui.started,'the selected editor must open while the unrelated checkpoint remains held');
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered selected draft');assert.equal(ui.workspace.activePane.viewReady,true);
  assert.equal(ui.loaded[0],'note/v1/selected','the selected checkpoint is admitted before unrelated background classification');assert.equal(ui.workspace.buffers.has('Other.md'),false,'a held unrelated checkpoint cannot block or replace the selected actor');
  const input=ui.root.querySelector<HTMLTextAreaElement>('textarea')!;input.value='New protected selected draft';input.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}));
  await ui.workspace.buffers.get('Selected.md')!.flushDraftProtection();assert.ok([...ui.journal.values()].some(row=>row.entryId==='selected'&&row.draft===input.value));
  await ui.entered.promise;assert.equal(ui.editorFrame,true,'unrelated checkpoint classification must allow the selected editor its first animation frame');
});

test('global flush recovers an unopened original pending operation before releasing the lease',async t=>{
  const ui=await fixture(t,'operation');await until(()=>ui.started);let closed=false;
  const closing=ui.workspace.destroy().then(()=>{closed=true;});await ui.entered.promise;await turn();assert.equal(closed,false);assert.equal(ui.releases,0);
  ui.held.resolve();await closing;assert.equal(ui.releases,1);assert.equal(ui.records.get('other')!.content,'Original pending source');
  assert.ok(ui.queries.includes('original-operation'));assert.equal(ui.committed.filter(id=>id==='original-operation').length,1);assert.equal(ui.planned.includes('original-operation'),false);
});

test('the selected canonical checkpoint still gates editable content',async t=>{
  const ui=await fixture(t,'clean','held');await ui.entered.promise;await turn();
  assert.equal(ui.started,false);assert.equal(ui.root.querySelector('textarea'),null);
  ui.held.resolve();await ui.opening;assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered selected draft');
});

test('independent selected recovery is adopted before authoring without unrelated hydration',async t=>{
  const ui=await fixture(t,'clean','independent');await until(()=>ui.started);
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered independent selected draft');
  assert.equal(ui.workspace.buffers.get('Selected.md')!.text,'Recovered independent selected draft');
  assert.equal(ui.workspace.buffers.has('Other.md'),false);
});

test('a later open joins the registry while an unopened dirty checkpoint remains held',async t=>{
  const ui=await fixture(t,'dirty');await until(()=>ui.started);
  const opening=ui.workspace.openNote('Other.md',true);await ui.entered.promise;await turn();
  const pending=ui.workspace.buffers.get('Other.md')!;assert.ok(pending);assert.equal(pending.hasAdmittedContent,false);
  ui.held.resolve();await opening;assert.equal(ui.workspace.buffers.get('Other.md'),pending);
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered other draft');
  await ui.workspace.flush();assert.equal(ui.records.get('other')!.content,'Recovered other draft');
});

test('malformed unopened canonical data remains intact and prevents unsafe release',async t=>{
  const ui=await fixture(t,'malformed');await until(()=>ui.started);const before=ui.heads.get('note/v1/other')!.encodedState;
  ui.held.resolve();await assert.rejects(ui.workspace.destroy(),/Malformed durable note recovery checkpoint; retained/);
  assert.equal(ui.releases,0);assert.equal(ui.heads.get('note/v1/other')!.encodedState,before);
  assert.equal(ui.workspace.buffers.get('Selected.md')!.text,'Recovered selected draft');
  ui.heads.delete('note/v1/other');await ui.workspace.destroy();assert.equal(ui.releases,1);
});

test('later opening a conflicted checkpoint retains its draft and rejects a global flush without new planning',async t=>{
  const ui=await fixture(t,'conflict');await until(()=>ui.started);ui.held.resolve();const before=ui.heads.get('note/v1/other')!.encodedState;
  await ui.workspace.openNote('Other.md',true);const other=ui.workspace.buffers.get('Other.md')!;
  assert.equal(other.hasRecoveryConflict,true);assert.equal(other.text,'Recovered other draft');
  await assert.rejects(ui.workspace.flush(),/file advanced|conflict|draft preserved/);assert.equal(ui.heads.get('note/v1/other')!.encodedState,before);
  assert.equal(ui.records.get('other')!.content,'Saved other');assert.equal([...ui.plans.values()].filter(plan=>plan.expectedEntryId==='other').length,0);assert.equal(ui.releases,0);
});


test('eight unopened conditional checkpoints do not strand a selected capture behind Native capacity',async t=>{
  const ui=await fixture(t,'clean','canonical',8);await until(()=>ui.started);const buffer=ui.workspace.buffers.get('Selected.md')!,witness=buffer.savedDurableWitness!;
  assert.equal(ui.captures.size,8);assert.equal(ui.committed.length,0);
  let capture:Awaited<ReturnType<typeof buffer.captureConditionalSavedSource>>;
  const saving=buffer.captureConditionalSavedSource(witness).then(value=>{capture=value;});void saving.catch(()=>{});
  try{
    for(let i=0;i<250&&!capture;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(capture,'selected capture must resume retained unopened operations automatically, without opening those notes or closing the vault');
    await saving;assert.ok(capture);assert.equal(ui.sourceReads.includes('other'),false,'clean background history must not read unrelated source bodies');
    assert.ok(ui.committed.some(id=>id.startsWith('original-pending-')));assert.ok([...ui.plans.values()].every(input=>input.operationId.startsWith('original-pending-')));
    await buffer.releaseConditionalSavedSource(capture);
  }finally{await buffer.dispose().catch(()=>{});await saving.catch(()=>{});}
});


test('capacity recovery settles only the original accepted operation while newer body typing stays dirty',async t=>{
  const ui=await fixture(t,'clean','canonical',8);await until(()=>ui.started);const selected=ui.workspace.buffers.get('Selected.md')!,entered=gate(),held=gate();
  ui.setCommitHook(async ref=>{if(ref.operationId==='original-pending-1'){entered.resolve();await held.promise;}});
  let captured:Awaited<ReturnType<typeof selected.captureConditionalSavedSource>>;
  const capturing=selected.captureConditionalSavedSource(selected.savedDurableWitness!).then(value=>{captured=value;});void capturing.catch(()=>{});
  try{
    await entered.promise;const old=ui.workspace.buffers.get('Pending1.md')!;assert.ok(old);old.update('Newer body typing');held.resolve();
    await until(()=>ui.records.get('pending1')!.content==='Original conditional 1');await turn();
    assert.equal(old.text,'Newer body typing');assert.equal(old.dirty,true);assert.deepEqual([...ui.plans.values()].filter(input=>input.expectedEntryId==='pending1').map(input=>input.operationId),['original-pending-1']);
    await capturing;assert.ok(captured);await selected.releaseConditionalSavedSource(captured);
  }finally{held.resolve();await selected.dispose().catch(()=>{});await capturing.catch(()=>{});}
});

for(const source of ['renderer','transport'])test(`untrusted ${source} capacity codes cannot trigger unopened-note recovery`,async t=>{
  const ui=await fixture(t,'clean','canonical',8);await until(()=>ui.started);ui.adapter.durableWrites.captureSavedSource=async()=>{throw Object.assign(Error('untrusted capacity'),{code:'source_capture_capacity',source});};
  const selected=ui.workspace.buffers.get('Selected.md')!;await assert.rejects(selected.captureConditionalSavedSource(selected.savedDurableWitness!),/untrusted capacity/);
  assert.deepEqual(ui.planned,[]);assert.deepEqual(ui.committed,[]);assert.equal(ui.captures.size,8);
});

test('capacity-owned actors retry their original operation after a temporary planning failure',async t=>{
  const ui=await fixture(t,'clean','canonical',8);await until(()=>ui.started);const selected=ui.workspace.buffers.get('Selected.md')!,attempts:string[]=[],seen=new Set<string>(),plan=ui.adapter.durableWrites.planWrite;
  ui.adapter.durableWrites.planWrite=async input=>{attempts.push(input.operationId);if(!seen.has(input.operationId)){seen.add(input.operationId);throw Object.assign(Error('temporary planning storage'),{source:'host',code:'storage_busy'});}return plan(input);};
  let captured:Awaited<ReturnType<typeof selected.captureConditionalSavedSource>>;
  const capturing=selected.captureConditionalSavedSource(selected.savedDurableWitness!).then(value=>{captured=value;});void capturing.catch(()=>{});
  try{
    for(let i=0;i<300&&!captured;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(captured,'a helper-admitted actor must retain exact retry ownership after its temporary failure');await capturing;
    assert.ok(attempts.every(id=>id.startsWith('original-pending-')));assert.equal(attempts.filter(id=>id==='original-pending-1').length,2);
    assert.equal(ui.records.get('pending1')!.content,'Original conditional 1');await selected.releaseConditionalSavedSource(captured);
  }finally{ui.adapter.durableWrites.planWrite=plan;await selected.dispose().catch(()=>{});await capturing.catch(()=>{});}
});

test('a host capacity code with a terminal cause cannot resume another accepted operation',async t=>{
  const ui=await fixture(t,'clean','canonical',8);await until(()=>ui.started);const terminal=Object.assign(Error('invalid protocol'),{source:'host',code:'invalid_response'});
  ui.adapter.durableWrites.captureSavedSource=async()=>{throw Object.assign(Error('ambiguous capacity wrapper'),{code:'source_capture_capacity',source:'host',cause:terminal});};
  const selected=ui.workspace.buffers.get('Selected.md')!;await assert.rejects(selected.captureConditionalSavedSource(selected.savedDurableWitness!),/ambiguous capacity wrapper/);
  assert.deepEqual(ui.planned,[]);assert.deepEqual(ui.committed,[]);assert.equal(ui.captures.size,8);
});


test('background recovery automatically resumes a retained ref after the protected selected editor is usable',async t=>{
  const ui=await fixture(t,'operation');await until(()=>ui.started);assert.equal(ui.committed.length,0);
  const selected=ui.workspace.buffers.get('Selected.md')!;selected.update('Protected while background ref waits');await selected.flushDraftProtection();
  assert.ok([...ui.journal.values()].some(row=>row.entryId==='selected'&&row.draft===selected.text));assert.equal(ui.committed.length,0);
  ui.held.resolve();for(let n=0;n<400&&!ui.committed.includes('original-operation');n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(ui.committed.filter(id=>id==='original-operation').length,1);assert.equal(ui.records.get('other')!.content,'Original pending source');assert.equal(ui.planned.includes('original-operation'),false);
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered selected draft','background recovery does not remount the active editor');
});

test('an unrelated background checkpoint read failure cannot fail or unprotect the selected editor',async t=>{
  const ui=await fixture(t,'unavailable');await until(()=>ui.started);await ui.entered.promise;
  const selected=ui.workspace.buffers.get('Selected.md')!;selected.update('Protected despite unrelated head error');await selected.flushDraftProtection();
  assert.equal(ui.workspace.activePane.viewReady,true);assert.ok([...ui.journal.values()].some(row=>row.entryId==='selected'&&row.draft===selected.text));assert.equal(selected.error,null);
  await assert.rejects(ui.workspace.flush(),/Other checkpoint unavailable/);assert.equal(ui.releases,0);ui.restoreOtherCheckpoint();ui.held.resolve();
});

test('a background dirty raw draft is admitted for recovery without automatically authoring it',async t=>{
  const ui=await fixture(t,'dirty');await until(()=>ui.started);ui.held.resolve();for(let n=0;n<400&&!ui.workspace.buffers.get('Other.md')?.hasAdmittedContent;n++)await new Promise(resolve=>setTimeout(resolve,5));
  const other=ui.workspace.buffers.get('Other.md')!;assert.ok(other);assert.equal(other.text,'Recovered other draft');assert.equal(other.dirty,true);
  await new Promise(resolve=>setTimeout(resolve,450));assert.equal(ui.records.get('other')!.content,'Saved other');assert.equal([...ui.plans.values()].some(plan=>plan.expectedEntryId==='other'),false);
});


test('dirty recovery can identify a missing namespace ID only through the exact coherent actor',async t=>{
  const ui=await fixture(t,'dirty','canonical',0,'unknown');await until(()=>ui.started);ui.held.resolve();
  for(let n=0;n<400&&!ui.workspace.buffers.get('Other.md')?.hasAdmittedContent;n++)await new Promise(resolve=>setTimeout(resolve,5));
  const other=ui.workspace.buffers.get('Other.md')!;assert.ok(other);assert.equal(other.savedDurableWitness?.entryId,'other');assert.equal(other.text,'Recovered other draft');assert.deepEqual(ui.planned,[]);
});

test('an unknown namespace path replacement during the coherent recovery read fences the late actor',async t=>{
  const ui=await fixture(t,'dirty','canonical',0,'unknown');await until(()=>ui.started);const entered=gate(),held=gate(),original=ui.records.get('other')!,slot=ui.workspace.vault.entries.get('Other.md')!;
  ui.setReadHook(async id=>{if(id==='other'){entered.resolve();await held.promise;}});ui.held.resolve();
  try{
    await entered.promise;ui.records.delete('other');ui.records.set('replacement-other',{...original,entryId:'replacement-other',content:'Replacement source'});ui.workspace.vault.entries.set('Other.md',{...slot});held.resolve();
    for(let n=0;n<10;n++)await turn();assert.equal(ui.workspace.buffers.has('Other.md'),false);assert.equal(ui.workspace.activePane.viewReady,true);assert.deepEqual(ui.planned,[]);
    await assert.rejects(ui.workspace.flush(),/missing or replaced|changed/);assert.equal(ui.releases,0);
  }finally{held.resolve();ui.setReadHook(()=>{});ui.records.delete('replacement-other');ui.records.set('other',original);ui.workspace.vault.entries.set('Other.md',slot);}
});

test('a known foreign namespace ID refuses dirty recovery without reading or binding that actor',async t=>{
  const ui=await fixture(t,'dirty','canonical',0,'foreign');await until(()=>ui.started);ui.held.resolve();
  try{
    await assert.rejects(ui.workspace.flush(),/missing or replaced/);assert.equal(ui.sourceReads.includes('other'),false);assert.equal(ui.workspace.buffers.has('Other.md'),false);assert.deepEqual(ui.planned,[]);assert.equal(ui.releases,0);
  }finally{const slot=ui.workspace.vault.entries.get('Other.md')!;ui.workspace.vault.entries.set('Other.md',{...slot,entryId:'other'});}
});

test('clean recovery history with an unknown namespace ID never reads a source body or creates an actor',async t=>{
  const ui=await fixture(t,'clean','canonical',0,'unknown');await until(()=>ui.started);ui.held.resolve();await ui.workspace.flush();
  assert.equal(ui.sourceReads.includes('other'),false);assert.equal(ui.workspace.buffers.has('Other.md'),false);
});
