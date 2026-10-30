import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {EditorHandle,EditorOptions} from '../src/ui/editor.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteInput,DurableWriteIntent} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftCandidate} from '../src/core/independent-drafts.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean,message='expected owned continuation'){for(let i=0;i<100&&!check();i++)await turn();assert.ok(check(),message);}
async function fixture(t:TestContext,other:'clean'|'dirty'|'operation'|'malformed'|'conflict'='clean',selectedRecovery:'canonical'|'independent'|'held'='canonical'){
  const dom=new JSDOM('<main></main>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const scope={vaultId:'deferred-vault',clientId:'deferred-client'},records=new Map<string,DurableWriteRead>(),heads=new Map<string,Checkpoint>();
  for(const path of ['Selected.md','Other.md']){const entryId=path.split('.')[0].toLowerCase();records.set(entryId,{entryId,path,revision:'file-1',content:`Saved ${entryId}`,stat:{ctime:1,mtime:1,size:14}});}
  class Adapter extends MemoryAdapter{durableWrites!:DurableWrites;independentDrafts!:IndependentDraftProvider;
    override async list(){return(await super.list()).map(row=>{const current=[...records.values()].find(record=>record.path===row.path);return current?{...row,entryId:current.entryId,revision:current.revision}:row;});}}
  const adapter=new Adapter(Object.fromEntries([...records.values()].map(row=>[row.path,row.content])));
  const plans=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>(),journal=new Map<string,IndependentDraftCandidate>(),loaded:string[]=[],queries:string[]=[],committed:string[]=[],planned:string[]=[];
  let serial=0,releases=0;const held=gate(),entered=gate();
  const writes:DurableWrites={checkpoints:{scope,load:async key=>{loaded.push(key);if(key==='note/v1/other'||selectedRecovery==='held'&&key==='note/v1/selected'){entered.resolve();await held.promise;}return structuredClone(heads.get(key)??null);},
    list:async()=>({items:[...heads.values()].map(({encodedState,...metadata})=>metadata),cursor:null,highWater:String(heads.size)}),changes:async()=>({items:[],cursor:null,highWater:String(heads.size)}),
    compareAndSwap:async change=>{const old=heads.get(change.key);if(old?.revision===change.nextRevision){assert.equal(old.encodedState,change.encodedState);return structuredClone(old);}assert.equal(change.expectedRevision,old?.revision??null);
      const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(++serial),deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??''),encodedState:change.encodedState};heads.set(change.key,row);return structuredClone(row);}},
    readText:async path=>structuredClone([...records.values()].find(row=>row.path===path)!),readTextById:async id=>structuredClone(records.get(id)??null),
    planWrite:async input=>{planned.push(input.operationId);plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:input.expectedEntryId,operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{const intent:DurableWriteIntent={ref:{...scope,entryId:plan.entryId,operationId:plan.operationId,token:plan.operationId},state:'prepared',acknowledged:false};intents.set(plan.operationId,intent);return structuredClone(intent);},
    query:async ref=>{queries.push(ref.operationId);return structuredClone(intents.get(ref.operationId)??null);},
    commit:async ref=>{committed.push(ref.operationId);const input=plans.get(ref.operationId)!,old=records.get(ref.entryId)!;assert.equal(input.expectedRevision,old.revision);assert.equal(input.expectedContent,old.content);
      const current={...old,content:input.content,revision:`file-${committed.length+1}`,stat:{...old.stat,size:input.content.length}};records.set(ref.entryId,current);await adapter.write(current.path,current.content);
      const intent:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:current.revision,sequence:String(committed.length)}};intents.set(ref.operationId,intent);return structuredClone(intent);},
    acknowledge:async ref=>{const value=intents.get(ref.operationId)!;if(value.state==='committed'||value.state==='rejected')intents.set(ref.operationId,{...value,acknowledged:true});},listUnacknowledged:async()=>[],};
  adapter.durableWrites=writes;
  const journalScope={...scope,incarnationId:'current-document'};
  adapter.independentDrafts={scope:journalScope,list:async options=>[...journal.values()].filter(row=>!options||row.entryId===options.entryId).map(({baseline,draft,pendingOperation,checkpointRevision,...receipt})=>receipt),
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
  const root=dom.window.document.querySelector<HTMLElement>('main')!,factory=(parent:HTMLElement,options:EditorOptions):EditorHandle=>{const input=dom.window.document.createElement('textarea');input.value=options.value;parent.append(input);input.oninput=()=>{options.validateChange?.(input.value);options.onChange(input.value);};return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:value=>{input.value+=value;options.onChange(input.value);}};};
  const workspace=new Workspace(root,factory);let started=false;
  const opening=workspace.start({adapter,id:platformId,label:'Deferred test',release:async()=>{releases++;}}).then(()=>{started=true;});void opening.catch(()=>{});
  t.after(async()=>{held.resolve();try{await opening;for(const[path,buffer]of workspace.buffers){if(buffer.hasRecoveryConflict){await buffer.closeMetadataProjection();workspace.buffers.delete(path);}}if(other==='malformed')heads.delete('note/v1/other');await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  return{dom,workspace,root,adapter,heads,journal,held,entered,opening,loaded,queries,committed,planned,plans,records,get started(){return started;},get releases(){return releases;}};
}

test('selected recovered editor and independent protection do not wait for an unrelated checkpoint body',async t=>{
  const ui=await fixture(t);await until(()=>ui.started,'the selected editor must open while the unrelated checkpoint remains held');
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>('textarea')!.value,'Recovered selected draft');assert.equal(ui.workspace.activePane.viewReady,true);
  assert.deepEqual(ui.loaded,['note/v1/selected'],'metadata discovery must not hydrate unrelated clean checkpoint bodies');
  const input=ui.root.querySelector<HTMLTextAreaElement>('textarea')!;input.value='New protected selected draft';input.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}));
  await ui.workspace.buffers.get('Selected.md')!.flushDraftProtection();assert.ok([...ui.journal.values()].some(row=>row.entryId==='selected'&&row.draft===input.value));
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
  assert.equal(ui.loaded.includes('note/v1/other'),false);
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
