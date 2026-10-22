import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { CommittedMetadataState } from '../src/core/committed-metadata-frame.ts';
import type { DocumentService } from '../src/core/document-semantics.ts';
import type { PropertyTargetsInput, PropertyTargetsResult } from '../src/bases/property-targets.ts';
import { createNotePropertyTargets } from '../src/ui/note-property-targets.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
async function setup(query:(input:PropertyTargetsInput)=>Promise<PropertyTargetsResult>,metadata?:CommittedMetadataState){
  const adapter=new MemoryAdapter({'Note.md':'body','Other.md':'other','Properties.yaml':'properties: {}'}),list=adapter.list.bind(adapter);
  adapter.list=async()=> (await list()).map(entry=>({...entry,entryId:`id:${entry.path}`,revision:'r1'}));
  Object.defineProperty(adapter,'documentSemantics',{value:{propertyTargetsAvailable:true} as DocumentService});
  const vault=new Vault(adapter);await vault.initialize();
  // Notification-only fixture for persistent states that the real projection
  // normally emits alongside separate runtime/vault invalidations.
  let metadataState=metadata;const metadataListeners=new Set<(state:CommittedMetadataState)=>void>();
  if(metadata){Object.defineProperty(vault,'metadataFrame',{get:()=>metadataState});vault.onMetadata=callback=>{metadataListeners.add(callback);return()=>metadataListeners.delete(callback);};}
  let current=true,changed=0,wake:(()=>void)|undefined,scheduled:(()=>void)|undefined;
  const manager=createNotePropertyTargets({vault,getPath:()=> 'Note.md',isCurrent:()=>current,onChange:()=>changed++,query,
    clock:{capture:()=>({clockMs:10,timezone:'UTC'}),isVisible:()=>true,subscribeWake:callback=>{wake=callback;return()=>{wake=undefined;};},scheduleAt:(_time,callback)=>{scheduled=callback;return()=>{scheduled=undefined;};}}});
  return{vault,manager,publishMetadata(state:CommittedMetadataState){metadataState=state;for(const listener of [...metadataListeners])listener(state);},get changed(){return changed;},wake:()=>wake?.(),deadline:()=>scheduled?.(),retire:()=>{current=false;}};
}
function result(label='Ada'):PropertyTargetsResult{return{relationTargets:{author:[{entryId:'ada',revision:'r1',path:'Ada.md',label}]},diagnostics:[],coverageComplete:true,refreshHint:{dependency:'day',timezone:'UTC',nextWakeMs:100},clockMs:10,timezone:'UTC'} as PropertyTargetsResult;}

test('ordinary note candidates invalidate immediately on vault changes and republish only after core query',async()=>{
  let calls=0;const f=await setup(async()=>result(`Core ${++calls}`));await tick();assert.equal(f.manager.get('author')?.[0].label,'Core 1');
  await f.vault.create('New.md','new');assert.equal(f.manager.get('author'),undefined);await tick();assert.equal(f.manager.get('author')?.[0].label,'Core 2');await f.manager.close();
});
test('late results after invalidation and destruction never replace newer candidates',async()=>{
  let release!:()=>void,calls=0;const held=new Promise<void>(resolve=>{release=resolve;});const f=await setup(async()=>{if(++calls===1)await held;return result(`Core ${calls}`);});
  await tick();f.manager.invalidate();await tick();release();await tick();assert.equal(f.manager.get('author')?.[0].label,'Core 2');
  f.manager.destroy();assert.equal(f.manager.get('author'),undefined);await f.manager.close();
});
test('core clock hints and wake events refresh candidates without a TypeScript predicate',async()=>{
  let calls=0;const f=await setup(async()=>result(`Core ${++calls}`));await tick();f.deadline();assert.equal(f.manager.get('author'),undefined);await tick();assert.equal(calls,2);
  f.wake();await tick();assert.equal(calls,3);await f.manager.close();
});
test('incomplete core coverage and filter diagnostics cannot masquerade as a complete target list',async()=>{
  let complete=false,invalid=false;const f=await setup(async()=>({...result(),coverageComplete:complete,diagnostics:invalid?[{property:'author',message:'Invalid core filter'}]:[]}));await tick();assert.equal(f.manager.get('author'),undefined);
  complete=true;f.manager.invalidate();await tick();assert.equal(f.manager.get('author')?.length,1);
  invalid=true;f.manager.invalidate();await tick();assert.equal(f.manager.get('author'),undefined);f.retire();assert.equal(f.manager.get('author'),undefined);await f.manager.close();
});

function withDisplay():PropertyTargetsResult{
 const display={type:'namespace' as const,name:'Ada',presentation:{kind:'link' as const,value:'People/Ada.md',target:{entryId:'ada',revision:'r3'}},get(){throw new Error('No TypeScript resolver may run');}};
 return{...result(),current:{id:'id:Note.md',revision:'r1',path:'Note.md',kind:'file',deleted:false},currentRelationValues:{witness:{entryId:'id:Note.md',revision:'r1'},values:{author:display,'note.author':display},editValues:{author:{type:'string',value:'[[People/Ada|Original spelling]]'},'note.author':{type:'list',value:[{type:'string',value:'[[Missing|Alias]]'}]}}}};
}

test('ordinary relation labels are shown only for the same saved actor and exact current raw property value',async()=>{
 const response=withDisplay(),f=await setup(async()=>response);try{await tick();
  const raw={type:'string' as const,value:'[[People/Ada|Original spelling]]'};assert.equal(f.manager.getDisplayValue('author',raw),response.currentRelationValues!.values.author);
  assert.equal(f.manager.getDisplayValue('author',{type:'string',value:'[[People/Ada|Edited alias]]'}),undefined);
  assert.equal(f.manager.getDisplayValue('author',{type:'list',value:[raw]}),undefined,'a singleton list is not the saved scalar');
  assert.equal(f.manager.getDisplayValue('author',{type:'namespace',name:'Ada',get(){throw new Error('Never called');}}),undefined);
  assert.equal(f.manager.getDisplayValue('note.author',{type:'list',value:[{type:'string',value:'[[Missing|Alias]]'}]}),response.currentRelationValues!.values['note.author']);
  assert.equal(f.manager.getDisplayValue('note.author',{type:'string',value:'[[Missing|Alias]]'}),undefined,'a scalar is not the saved singleton list');
  assert.equal(f.manager.getDisplayValue('missing',raw),undefined);
  const actor=f.vault.entries.get('Note.md')!;f.vault.entries.set('Note.md',{...actor,entryId:'replacement'});assert.equal(f.manager.getDisplayValue('author',raw),undefined);f.vault.entries.set('Note.md',{...actor,revision:'r2'});assert.equal(f.manager.getDisplayValue('author',raw),undefined);
 }finally{await f.manager.close();}
});

test('display baseline matching never coerces numeric, string or boolean raw properties',async()=>{
 const response=withDisplay();(response.currentRelationValues!.editValues as Record<string,unknown>).author={type:'number',value:1};const f=await setup(async()=>response);try{await tick();
  assert.ok(f.manager.getDisplayValue('author',{type:'number',value:1}));assert.equal(f.manager.getDisplayValue('author',{type:'string',value:'1'}),undefined);assert.equal(f.manager.getDisplayValue('author',{type:'boolean',value:true}),undefined);
 }finally{await f.manager.close();}
});

test('display baselines honor coverage, diagnostics, invalidation, destruction and older hosts',async()=>{
 let response=withDisplay();const f=await setup(async()=>response),raw={type:'string' as const,value:'[[People/Ada|Original spelling]]'};try{await tick();assert.ok(f.manager.getDisplayValue('author',raw));
  response={...withDisplay(),diagnostics:[{property:'author',message:'Invalid core relation'}]};f.manager.invalidate();assert.equal(f.manager.getDisplayValue('author',raw),undefined);await tick();assert.equal(f.manager.getDisplayValue('author',raw),undefined);
  response={...withDisplay(),coverageComplete:false};f.manager.invalidate();await tick();assert.equal(f.manager.getDisplayValue('author',raw),undefined);
  response=result();f.manager.invalidate();await tick();assert.equal(f.manager.getDisplayValue('author',raw),undefined);
  response=withDisplay();f.manager.invalidate();await tick();assert.ok(f.manager.getDisplayValue('author',raw));f.manager.destroy();assert.equal(f.manager.getDisplayValue('author',raw),undefined);
 }finally{await f.manager.close();}
});

test('formatted, accessor, cyclic and sparse raw inputs never supply relation display authority',async()=>{
 const f=await setup(async()=>withDisplay());try{await tick();let invoked=false;
  const accessor={type:'string',get value(){invoked=true;return'[[People/Ada|Original spelling]]';}};assert.equal(f.manager.getDisplayValue('author',accessor as never),undefined);assert.equal(invoked,false);
  const cycle:any={type:'list',value:[]};cycle.value.push(cycle);assert.equal(f.manager.getDisplayValue('author',cycle),undefined);
  const sparse:any=[];sparse.length=1;sparse.foo={type:'string',value:'[[Missing|Alias]]'};assert.equal(f.manager.getDisplayValue('note.author',{type:'list',value:sparse}),undefined);
  assert.equal(f.manager.getDisplayValue('author',{type:'date',timestamp:0,hasTime:false}),undefined);
 }finally{await f.manager.close();}
});

/** Only the admitted transport is a fixture. Vault, committed-frame publication
 * and the ordinary-note manager retain their production subscription ordering. */
async function projectionSetup(query:(input:PropertyTargetsInput,wake:()=>void)=>Promise<PropertyTargetsResult>){
 const files={'Note.md':'---\nauthor: "[[People/Ada|Original spelling]]"\n---\nBody','Other.md':'other','Properties.yaml':'properties: {}'};
 const adapter=new MemoryAdapter(files),list=adapter.list.bind(adapter);
 let namespaceRevision='r1',generation='1',watermark='1',coverageComplete=true,failOpen=false,revision=1;
 adapter.list=async()=> (await list()).map(entry=>({...entry,entryId:`id:${entry.path}`,revision:namespaceRevision}));
 const versions={schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'resolver-1',query:'query-1'};
 const snapshot=()=>({localStoreId:'store',generationEpoch:'epoch',generation,versions}),source=()=>({localStoreId:'store',watermark});
 const listeners=new Set<(update:import('../src/core/document-runtime.ts').DocumentRuntimeUpdate)=>void>();
 const update=():import('../src/core/document-runtime.ts').DocumentRuntimeUpdate=>({lifetime:'runtime',revision:String(revision),source:source(),published:snapshot(),freshness:'current',phase:'observing',progress:null,coverageComplete,hasForegroundDemand:true,error:null});
 const wake=()=>{revision++;for(const listener of [...listeners])listener(update());};
 let pinSequence=0;const pins=new Set<string>();
 const service={propertyTargetsAvailable:true,metadataRowsAvailable:true,
  maintenance:{async observeAndSubscribe(listener:(value:import('../src/core/document-runtime.ts').DocumentRuntimeUpdate|null)=>void){listeners.add(listener);return{snapshot:update(),unsubscribe:()=>listeners.delete(listener)};}},
  async open(){if(failOpen)throw new Error('Unavailable captured metadata');const pinId=`pin-${++pinSequence}`,captured=snapshot(),capturedSource=source(),complete=coverageComplete;pins.add(pinId);return{pinId,snapshot:captured,source:capturedSource,coverageComplete:complete,async close(){pins.delete(pinId);},async metadataRows(){return{cursor:null,result:{snapshot:captured,source:capturedSource,coverageComplete:complete,value:{snapshot:captured,mode:'reset',from:null,removedEntryIds:[],rows:(await adapter.list()).map(entry=>({kind:'file',value:{entry:{id:entry.entryId!,revision:entry.revision!,path:entry.path,kind:'file',deleted:false},metadata:null,exclusion:null}})),scanComplete:true,complete,coverageComplete:complete,next:null}}};}};},
 } as unknown as DocumentService;
 Object.defineProperty(adapter,'documentSemantics',{value:service});const vault=new Vault(adapter);await vault.initialize();
 const statuses:string[]=[];const stop=vault.onMetadata(state=>statuses.push(state.status));let changed=0,calls=0,alive=true;
 const manager=createNotePropertyTargets({vault,getPath:()=> 'Note.md',isCurrent:()=>alive,onChange:()=>changed++,query:input=>{calls++;return query(input,wake);},
  clock:{capture:()=>({clockMs:10,timezone:'UTC'}),isVisible:()=>true,subscribeWake:()=>()=>{},scheduleAt:()=>()=>{}}});
 return{vault,adapter,manager,statuses,wake,pins,get calls(){return calls;},get changed(){return changed;},
  next(options:{coverage?:boolean;unavailable?:boolean;namespaceRevision?:string}={}){generation=String(Number(generation)+1);watermark=String(Number(watermark)+1);coverageComplete=options.coverage??true;failOpen=options.unavailable??false;namespaceRevision=options.namespaceRevision??namespaceRevision;wake();},
  retire(){alive=false;},async close(){await manager.close();stop();await vault.closeMetadataProjection();assert.equal(pins.size,0);assert.equal(listeners.size,0);}};
}
const originalAuthor={type:'string' as const,value:'[[People/Ada|Original spelling]]'};

test('same-current runtime phase publication does not cancel its own ordinary property query',async()=>{
 let aborted=0;const f=await projectionSetup(async(input,wake)=>{wake();if(input.signal?.aborted)aborted++;await Promise.resolve();return withDisplay();});
 try{f.wake();f.statuses.length=0;await tick();await tick();assert.ok(f.statuses.includes('stale')&&f.statuses.includes('current'),'real committed projection emitted its transient pair');assert.equal(aborted,0);assert.equal(f.calls,1);assert.equal(f.changed,1);assert.ok(f.manager.getDisplayValue('author',originalAuthor));}
 finally{await f.close();}
});


function metadataFixture(status:CommittedMetadataState['status']='current'):CommittedMetadataState{
 // Only metadata notification witnesses are consumed by this manager; relation
 // facts still come from its independent sealed-query fixture, never this frame.
 return{status,frame:{source:{localStoreId:'store',watermark:'1'},snapshot:{localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'extract-1',resolver:'resolver-1',query:'query-1'}},coverageComplete:true} as CommittedMetadataState['frame']};
}
test('a lasting same-frame stale notification invalidates at the next microtask',async()=>{
 const initial=metadataFixture(),response=withDisplay(),f=await setup(async()=>response,initial);
 try{await tick();assert.equal(f.manager.getDisplayValue('author',originalAuthor),response.currentRelationValues!.values.author);
  f.publishMetadata({...initial,status:'stale'});assert.ok(f.manager.getDisplayValue('author',originalAuthor),'only the possible synchronous transient is deferred');
  await Promise.resolve();assert.equal(f.manager.getDisplayValue('author',originalAuthor),undefined);assert.equal(f.manager.get('author'),undefined);
 }finally{await f.manager.close();}
});
test('same-frame stale/current pairs retain an already published display without another query',async()=>{
 const initial=metadataFixture(),response=withDisplay();let calls=0;const f=await setup(async()=>{calls++;return response;},initial);
 try{await tick();const accepted=f.manager.getDisplayValue('author',originalAuthor);assert.ok(accepted);
  f.publishMetadata({...initial,status:'stale'});f.publishMetadata(initial);await Promise.resolve();await tick();
  assert.equal(f.manager.getDisplayValue('author',originalAuthor),accepted);assert.equal(calls,1);assert.equal(f.changed,1);
 }finally{await f.manager.close();}
});
test('unavailable after transient stale invalidates immediately and rejects a late pending result',async()=>{
 const initial=metadataFixture();let release!:(value:PropertyTargetsResult)=>void,pending:PropertyTargetsInput|undefined,calls=0;
 const held=new Promise<PropertyTargetsResult>(resolve=>{release=resolve;});const f=await setup(async input=>{if(++calls>1)throw new Error('Unavailable transport');pending=input;return held;},initial);
 try{await tick();assert.ok(pending);f.publishMetadata({...initial,status:'stale'});assert.equal(pending.signal?.aborted,false);
  f.publishMetadata({...initial,status:'unavailable'});assert.equal(pending.signal?.aborted,true,'unavailable cannot be hidden by a queued stale transition');
  release(withDisplay());await tick();assert.equal(f.manager.getDisplayValue('author',originalAuthor),undefined);assert.equal(f.manager.get('author'),undefined);
 }finally{release(withDisplay());await f.manager.close();}
});
test('source, snapshot, semantic versions and coverage changes invalidate without a microtask delay',async()=>{
 const initial=metadataFixture(),frame=initial.frame!;
 const changes=[{...frame,source:{...frame.source,watermark:'2'}},{...frame,snapshot:{...frame.snapshot,generation:'2'}},{...frame,snapshot:{...frame.snapshot,versions:{...frame.snapshot.versions,resolver:'resolver-2'}}},{...frame,coverageComplete:false}];
 for(const next of changes){const f=await setup(async()=>withDisplay(),initial);try{await tick();assert.ok(f.manager.getDisplayValue('author',originalAuthor));f.publishMetadata({status:'stale',frame:next});assert.equal(f.manager.getDisplayValue('author',originalAuthor),undefined);}finally{await f.manager.close();}}
});
test('destroyed and retired panels ignore queued same-frame stale invalidation',async()=>{
 for(const action of ['destroy','retire'] as const){const initial=metadataFixture();let calls=0;const f=await setup(async()=>{calls++;return withDisplay();},initial);
  try{await tick();const changed=f.changed;f.publishMetadata({...initial,status:'stale'});if(action==='destroy')f.manager.destroy();else f.retire();await Promise.resolve();await tick();assert.equal(calls,1);assert.equal(f.changed,changed);assert.equal(f.manager.getDisplayValue('author',originalAuthor),undefined);}finally{await f.manager.close();}
 }
});
