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
