import assert from 'node:assert/strict';
import { createDocumentMaintenance } from '../../src/core/document-runtime.ts';
import type { DocumentRuntimeControl, DocumentRuntimeDelivery, DocumentRuntimeFrame, DocumentRuntimeTransport, DocumentRuntimeUpdate } from '../../src/core/document-runtime.ts';
import type { DocumentService } from '../../src/core/document-semantics.ts';

export async function freshnessUntil(predicate:()=>boolean):Promise<void> {
  const end=Date.now()+2000;
  while(!predicate()){if(Date.now()>end)assert.fail('Timed out waiting for freshness delivery');await new Promise(resolve=>setTimeout(resolve,1));}
}
/** Real common facade with deliberately held request ACKs. It has no timer or
 * maintenance planner: tests explicitly release admission and deliver outcomes. */
export function heldDocumentFreshness(){
  const scope={localStoreId:'store',clientId:'consumer'},source={localStoreId:'store',watermark:'1'};
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'x',resolver:'r',query:'q'}};
  const update:DocumentRuntimeUpdate={lifetime:'lifetime',revision:'1',source,published:snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:true,hasForegroundDemand:false,error:null};
  const listeners=new Set<()=>void>(),outcomes=new Map<string,DocumentRuntimeDelivery>(),gates=new Map<string,()=>void>();
  const controls:DocumentRuntimeControl[]=[],outcomeAcks:string[]=[],active=new Set<string>();
  let sequence=0n,request=0n;
  const frame=():DocumentRuntimeFrame=>structuredClone({version:1,scope,update,outcomes:[...outcomes.values()]});
  const emit=()=>{for(const listener of [...listeners])listener();};
  const transport:DocumentRuntimeTransport={scope,allocateSequence:()=>String(++sequence),allocateRequestId:()=>String(++request),
    observe:async()=>frame(),
    async control(input){
      controls.push(input);const command=input.command;
      if(command.kind==='request'){
        active.add(command.id);const captured=frame();
        await new Promise<void>(resolve=>gates.set(command.id,resolve));
        return {...input,frame:captured};
      }
      active.delete(command.id);outcomes.set(command.id,{lifetime:command.lifetime,outcome:{kind:'cancelled',id:command.id}});emit();
      return {...input,frame:frame()};
    },
    ackControl:async()=>{},
    async ackOutcome({id}){outcomeAcks.push(id);outcomes.delete(id);emit();},
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
  };
  const maintenance=createDocumentMaintenance(transport),unexpected=async():Promise<never>=>{throw Error('Unexpected legacy maintenance or pin call');};
  const service:DocumentService={maintenance,status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),
    initialize:unexpected,rebuild:unexpected,begin:unexpected,pump:unexpected,publish:unexpected,discard:unexpected,open:unexpected};
  return {maintenance,service,controls,outcomeAcks,active,
    get requests(){return controls.filter(control=>control.command.kind==='request').map(control=>control.command.id);},
    get cancellations(){return controls.filter(control=>control.command.kind==='cancel').map(control=>control.command.id);},
    get subscriptions(){return listeners.size;},
    release(id:string){const release=gates.get(id);assert.ok(release,`Request ${id} has not reached admission`);gates.delete(id);release();},
    finish(id:string){active.delete(id);outcomes.set(id,{lifetime:update.lifetime,outcome:{kind:'finished',id,observation:{source,published:snapshot,current:true,rebuildRequired:false,coverageComplete:true}}});emit();},
  };
}
