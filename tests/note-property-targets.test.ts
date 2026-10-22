import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { DocumentService } from '../src/core/document-semantics.ts';
import type { PropertyTargetsInput, PropertyTargetsResult } from '../src/bases/property-targets.ts';
import { createNotePropertyTargets } from '../src/ui/note-property-targets.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
async function setup(query:(input:PropertyTargetsInput)=>Promise<PropertyTargetsResult>){
  const adapter=new MemoryAdapter({'Note.md':'body','Other.md':'other','Properties.yaml':'properties: {}'}),list=adapter.list.bind(adapter);
  adapter.list=async()=> (await list()).map(entry=>({...entry,entryId:`id:${entry.path}`,revision:'r1'}));
  Object.defineProperty(adapter,'documentSemantics',{value:{propertyTargetsAvailable:true} as DocumentService});
  const vault=new Vault(adapter);await vault.initialize();let current=true,changed=0,wake:(()=>void)|undefined,scheduled:(()=>void)|undefined;
  const manager=createNotePropertyTargets({vault,getPath:()=> 'Note.md',isCurrent:()=>current,onChange:()=>changed++,query,
    clock:{capture:()=>({clockMs:10,timezone:'UTC'}),isVisible:()=>true,subscribeWake:callback=>{wake=callback;return()=>{wake=undefined;};},scheduleAt:(_time,callback)=>{scheduled=callback;return()=>{scheduled=undefined;};}}});
  return{vault,manager,get changed(){return changed;},wake:()=>wake?.(),deadline:()=>scheduled?.(),retire:()=>{current=false;}};
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
