import assert from 'node:assert/strict';
import { MemoryAdapter } from '../../src/core/memory-adapter.ts';
import type { DurableWrites,DurableWriteRead } from '../../src/core/durable-writes.ts';
import type { Checkpoint,CheckpointChange } from '../../src/core/durable-checkpoints.ts';

export const recoveredDraft='Desktop draft before interruption.';
export const externalText='Newer independent CLI version.';
export async function durableRecoveryFixture(){
  const scope={vaultId:'recovery-authority',clientId:'recovery-window'};
  const original:DurableWriteRead={entryId:'retained-note',revision:'old-revision',path:'One.md',content:'Original base',stat:{ctime:1,mtime:1,size:13}};
  let current={...original,revision:'cli-revision',content:externalText,stat:{ctime:1,mtime:2,size:externalText.length}};
  const key='note/v1/retained-note';
  let checkpoint:Checkpoint={version:1,...scope,key,revision:'checkpoint-before-crash',sequence:'1',deleted:false,byteLength:0,
    encodedState:JSON.stringify({version:1,writer:'old-writer',generation:1,base:original,draft:recoveredDraft,conflict:false})};
  const others=new Map<string,Checkpoint>();
  let failCreate=false,holdCreate:Promise<void>|undefined,holdCheckpoint:Promise<void>|undefined;
  const copies:string[]=[];let plans=0;
  class Adapter extends MemoryAdapter {
    durableWrites!:DurableWrites;
    async createText(path:string,text:string){
      if(holdCreate)await holdCreate;
      if(failCreate)throw new Error('Recovery create failed');
      assert.equal(await this.stat(path),null,'recovery must never overwrite a file');
      await super.write(path,text);copies.push(path);
    }
    async list(){return(await super.list()).map(row=>row.path===current.path?{...row,...current.stat,revision:current.revision}:row);}
    async stat(path:string){const row=await super.stat(path);return row&&path===current.path?{...row,...current.stat,revision:current.revision}:row;}
  }
  const adapter=new Adapter({'One.md':externalText,'Other.md':'Another note'});
  const unsupported=async():Promise<never>=>{throw new Error('Unexpected durable write operation');};
  adapter.durableWrites={
    checkpoints:{scope,load:async requested=>structuredClone(requested===key?checkpoint:others.get(requested)??null),
      async compareAndSwap(change:CheckpointChange){
        if(holdCheckpoint)await holdCheckpoint;
        if(change.key!==key){const previous=others.get(change.key);assert.equal(change.expectedRevision,previous?.revision??null);const next:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:'1',deleted:false,byteLength:0};others.set(change.key,next);return structuredClone(next);}
        assert.equal(change.expectedRevision,checkpoint.revision,'checkpoint CAS preserves writer ownership');
        checkpoint={...checkpoint,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(Number(checkpoint.sequence)+1)};return structuredClone(checkpoint);
      },
      list:async()=>({items:[checkpoint],cursor:null,highWater:checkpoint.sequence}),
      changes:async()=>({items:[],cursor:null,highWater:checkpoint.sequence})},
    readText:async path=>path===current.path?structuredClone(current):{entryId:path,revision:'other-revision',path,content:await adapter.read(path),stat:{ctime:1,mtime:1,size:12}},
    readTextById:async id=>id===current.entryId?structuredClone(current):null,
    planWrite:async()=>{plans++;throw new Error('Must not rebase a conflict');},
    prepare:unsupported,commit:unsupported,query:unsupported,listUnacknowledged:async()=>[],acknowledge:unsupported,
  };
  return {adapter,copies,get plans(){return plans;},get checkpoint(){return checkpoint;},
    failCreate(){failCreate=true;},holdCreate(promise:Promise<void>){holdCreate=promise;},holdCheckpoint(promise:Promise<void>){holdCheckpoint=promise;}};
}
