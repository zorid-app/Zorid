import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformAdapter} from '../src/platform/index.ts';

const scope={vaultId:'database-recovery-store',clientId:'database-window'};
const command=()=>({op:'set_entry' as const,operationId:'retained-edit',entryId:'entry-one',expectedRevision:'entry-before',expectedCollectionRevision:'collection-before',values:{rating000001:9}});
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Recovery did not settle the retained edit')),300);})]);}finally{clearTimeout(timer!);}}
async function fixture(t:TestContext){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:{admission:string;request:any}[]=[],receivers:{admission:string;retire:()=>void}[]=[],oldReply=held<any>(),receipts=new Map<string,string>();
 let mode:'pending'|'rejected'|'success'|'conflict'='pending',foreign=false,recoveryFailure=false,applied=0,freshFailure:string|undefined,releaseFailure=false,recoveryGate:ReturnType<typeof held<void>>|undefined,projectionPending=false,readFailure=false;
 const result=(rating=9)=>({databases:true,schemaVersion:1,ok:true,value:{collections:[{id:'collection01',name:'Recovery',revision:'collection-before',deleted:false,properties:[]}],entries:[{entryId:'entry-one',collectionId:'collection01',revision:'entry-after',fileRevision:'file-after',path:'One.md',values:{rating000001:rating},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}}});
 const failure=(code:string,commitUncertain=false)=>({databases:true,schemaVersion:1,ok:false,error:{code,source:'host',commitUncertain}});
 const binding=(admissionId:string)=>({admissionId,scope:{...scope},databases:true});
 const bridge={getVault:async()=>({path:'/database-recovery',name:'Recovery'}),getDurableContext:async()=>binding('old'),releaseDurableContext:async()=>{if(releaseFailure)throw Error('Release unavailable');},onChange:()=>()=>{},
  recoverDurableContext:async()=>{if(recoveryGate)await recoveryGate.promise;if(recoveryFailure)throw Error('Recovery unavailable');return{...binding('fresh'),scope:foreign?{...scope,clientId:'foreign-window'}:{...scope}};},
  onDocumentRuntimeNudge:(_root:string,admission:string,_listener:()=>void,retire:()=>void)=>{receivers.push({admission,retire});return()=>{};},
  durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
   assert.equal(method,'databaseCommand');const request=structuredClone(args[0]);calls.push({admission,request});
   if(request.command.op!=='set_entry')return readFailure?failure('client_not_admitted'):{databases:true,schemaVersion:1,ok:true,value:{collections:[],entries:[],projection:{pending:0,issues:[]}}};
   if(admission==='old'&&mode==='rejected')return failure('client_not_admitted');
   if(admission==='old'&&mode==='conflict')return failure('collection_stale');
   if(admission==='fresh'&&freshFailure)return failure(freshFailure);
   const wire=JSON.stringify(request),id=request.command.operationId,prior=receipts.get(id);if(prior)assert.equal(wire,prior,'native idempotency receipt requires the exact originally admitted request');else{receipts.set(id,wire);applied++;}
   if(admission==='old'&&mode==='pending')return oldReply.promise;
   const reply=result();if(projectionPending){reply.value.entries[0].pendingProjection=true;reply.value.projection.pending=1;}return reply;
  },
 };
 Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 const platform=(await createPlatformAdapter())!;
 return{platform,calls,oldReply,result,get applied(){return applied;},retire(){receivers.find(row=>row.admission==='old')!.retire();},mode(value:typeof mode){mode=value;},foreign(){foreign=true;},failRecovery(){recoveryFailure=true;},allowRecovery(){recoveryFailure=false;},failReplay(code:string){freshFailure=code;},failRelease(){releaseFailure=true;},holdRecovery(){recoveryGate=held<void>();return recoveryGate;},pendingProjection(value:boolean){projectionPending=value;},failReads(){readFailure=true;}};
}

test('retired pending Base edit replays before a held old renderer reply and adopts only the fresh exact receipt',async t=>{
 const f=await fixture(t),input=command(),pending=f.platform.databases!.request(input);let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
 assert.equal(f.platform.databases!.request(command()),pending,'duplicate identical pending edits join the admitted invocation');assert.equal(f.calls.length,1);f.retire();assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),true);
 const releaseClaim=f.platform.recovery!.claimCapturedSetEntry(input);t.after(releaseClaim);const fresh=await bounded(f.platform.recovery!.recover()),reply=await bounded(pending);assert.equal(reply.entries[0].values.rating000001,9);assert.equal(settled,true);assert.equal(f.applied,1);assert.equal(fresh===f.platform,false);
 assert.deepEqual(f.calls.map(call=>call.admission),['old','fresh']);assert.deepEqual(f.calls[1].request,f.calls[0].request);
 f.oldReply.resolve(f.result(1));await Promise.resolve();assert.equal(reply.entries[0].values.rating000001,9);
 const count=f.calls.length;await f.platform.databases!.request(command());assert.equal(f.calls.length,count,'an exact already settled capsule returns its verified receipt');
});

test('already rejected session edit remains an exact recovery capsule and can settle its original widget retry',async t=>{
 const f=await fixture(t);f.mode('rejected');const input=command();await assert.rejects(f.platform.databases!.request(input),{code:'client_not_admitted'});
 assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),true);t.after(f.platform.recovery!.claimCapturedSetEntry(input));f.retire();await f.platform.recovery!.recover();
 assert.equal((await f.platform.databases!.request(input)).entries[0].values.rating000001,9);assert.equal(f.applied,1);assert.equal(f.calls.filter(call=>call.admission==='fresh').length,1);
});

test('recovery revokes old reads, uncaptured mutations, and changed payloads even when an exact edit capsule exists',async t=>{
 const f=await fixture(t),input=command(),pending=f.platform.databases!.request(input);t.after(f.platform.recovery!.claimCapturedSetEntry(input));f.retire();await f.platform.recovery!.recover();await bounded(pending);const count=f.calls.length;
 for(const changed of [{...input,operationId:'new-edit'},{...input,values:{rating000001:10}},{op:'list' as const}])await assert.rejects(f.platform.databases!.request(changed),{code:'client_not_admitted'});
 assert.equal(f.platform.recovery!.containsCapturedSetEntry({...input,values:{rating000001:10}}),false);assert.equal(f.calls.length,count);
});

test('a caller mutation cannot alter the retained admitted payload and does not establish a matching capsule',async t=>{
 const f=await fixture(t),input=command(),original=structuredClone(input),pending=f.platform.databases!.request(input);input.values.rating000001=1;f.retire();
 assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),false);assert.equal(f.platform.recovery!.containsCapturedSetEntry(original),true);t.after(f.platform.recovery!.claimCapturedSetEntry(original));await f.platform.recovery!.recover();await bounded(pending);assert.deepEqual(f.calls[1].request.command,original);
});

test('foreign scope and failed repair never replay; failed original edit settles truthfully and remains available for exact repair',async t=>{
 const f=await fixture(t),input=command(),pending=f.platform.databases!.request(input),rejected=assert.rejects(pending,/Recovery unavailable/);f.retire();f.failRecovery();await assert.rejects(f.platform.recovery!.recover(),/Recovery unavailable/);await bounded(rejected);assert.equal(f.calls.length,1);assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),true);
 f.allowRecovery();t.after(f.platform.recovery!.claimCapturedSetEntry(input));await f.platform.recovery!.recover();assert.equal((await f.platform.databases!.request(input)).entries[0].values.rating000001,9);assert.equal(f.applied,1);
});

test('foreign identity cannot authorize any retained Base edit replay',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,/identity|scope/i);f.retire();f.foreign();await assert.rejects(f.platform.recovery!.recover(),/identity|scope/i);await bounded(rejected);assert.equal(f.calls.length,1);
});

test('ordinary success and definite collection validation failure are not admission recovery capsules',async t=>{
 const f=await fixture(t);f.mode('success');await f.platform.databases!.request(command());assert.equal(f.platform.recovery!.containsCapturedSetEntry(command()),false);
 f.mode('conflict');const stale={...command(),operationId:'stale-edit'};await assert.rejects(f.platform.databases!.request(stale),{code:'collection_stale'});assert.equal(f.platform.recovery!.containsCapturedSetEntry(stale),false);f.retire();await f.platform.recovery!.recover();assert.equal(f.calls.filter(call=>call.admission==='fresh').length,0);
});

test('ordinary release never leaves a captured mutation waiting for admission recovery',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,{code:'client_not_admitted'});f.retire();await f.platform.release!();await bounded(rejected);
 assert.equal(f.platform.recovery!.containsCapturedSetEntry(command()),false);assert.equal(f.calls.filter(call=>call.admission==='fresh').length,0);f.oldReply.resolve(f.result());
});

test('failed ordinary release settles the caller and preserves its exact capsule for later explicit repair',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,/Release unavailable/);f.retire();f.failRelease();await assert.rejects(f.platform.release!(),/Release unavailable/);await bounded(rejected);
 assert.equal(f.platform.recovery!.containsCapturedSetEntry(command()),true);t.after(f.platform.recovery!.claimCapturedSetEntry(command()));await f.platform.recovery!.recover();await f.platform.databases!.request(command());assert.equal(f.applied,1);
});

test('fresh replay conflict is reported to the original owner without replanning or admitting an alternate payload',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,{code:'collection_stale'});t.after(f.platform.recovery!.claimCapturedSetEntry(command()));f.retire();f.failReplay('collection_stale');await f.platform.recovery!.recover();await bounded(rejected);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].request,f.calls[0].request);assert.equal(f.applied,1);await assert.rejects(f.platform.databases!.request({...command(),values:{rating000001:10}}),{code:'client_not_admitted'});
});

test('a read accepted before retirement cannot adopt a delayed old result after repair',async t=>{
 const f=await fixture(t);f.mode('success');
 const read=f.platform.databases!.request({op:'list'});f.retire();await f.platform.recovery!.recover();await assert.rejects(read,{code:'client_not_admitted'});assert.equal(f.calls.length,1);
});

test('unclaimed rejected edits and canceled claims never replay during an unrelated session recovery',async t=>{
 const f=await fixture(t);f.mode('rejected');const input=command();await assert.rejects(f.platform.databases!.request(input),{code:'client_not_admitted'});
 const cancel=f.platform.recovery!.claimCapturedSetEntry(input);cancel();cancel();await f.platform.recovery!.recover();assert.equal(f.calls.length,1);assert.equal(f.applied,0);
 await assert.rejects(f.platform.databases!.request(input),{code:'client_not_admitted'});assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),false);
});

test('proof alone never selects an in-flight edit for replay and its old caller is released truthfully',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command()),rejected=assert.rejects(pending,{code:'client_not_admitted'});f.retire();assert.equal(f.platform.recovery!.containsCapturedSetEntry(command()),true);
 await f.platform.recovery!.recover();await bounded(rejected);assert.equal(f.calls.length,1);assert.equal(f.applied,1);f.oldReply.resolve(f.result());
});

test('a claim canceled while backend recovery is in flight cannot replay after the acknowledgment',async t=>{
 const f=await fixture(t);f.mode('rejected');await assert.rejects(f.platform.databases!.request(command()),{code:'client_not_admitted'});const cancel=f.platform.recovery!.claimCapturedSetEntry(command()),gate=f.holdRecovery(),repair=f.platform.recovery!.recover();
 cancel();gate.resolve();await repair;assert.equal(f.calls.length,1);assert.equal(f.applied,0);assert.equal(f.platform.recovery!.containsCapturedSetEntry(command()),false);
});

test('a pending publication result never becomes a permanent cached receipt for the retained edit',async t=>{
 const f=await fixture(t),pending=f.platform.databases!.request(command());t.after(f.platform.recovery!.claimCapturedSetEntry(command()));f.retire();f.pendingProjection(true);await f.platform.recovery!.recover();assert.equal((await pending).entries[0].pendingProjection,true);
 f.pendingProjection(false);assert.equal((await f.platform.databases!.request(command())).entries[0].pendingProjection,false);assert.equal(f.calls.length,3);assert.equal(f.applied,1);assert.deepEqual(f.calls[2].request,f.calls[0].request);
});

test('a known successful edit held through owner refresh can recover its widget without replaying the mutation',async t=>{
 const f=await fixture(t);f.mode('success');const input=command(),releaseReceipt=f.platform.recovery!.holdCapturedSetEntry(input),ack=f.platform.databases!.request(input),refresh=held<void>();t.after(releaseReceipt);
 const owner=ack.then(async value=>{await refresh.promise;await f.platform.databases!.request({op:'list'});return value;}),ownerRejected=assert.rejects(owner,{code:'client_not_admitted'});
 await ack;assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),true,'the concrete widget still owns its completed mutation while derived refresh is pending');f.retire();const releaseClaim=f.platform.recovery!.claimCapturedSetEntry(input);t.after(releaseClaim);await f.platform.recovery!.recover();
 refresh.resolve();await bounded(ownerRejected);assert.equal((await f.platform.databases!.request(input)).entries[0].values.rating000001,9);assert.equal(f.calls.length,1,'the verified original receipt is reused without another set_entry');assert.equal(f.applied,1);
 releaseClaim();releaseReceipt();assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),false,'completed receipts have an explicit owner-bounded lifetime');
});

test('a passive receipt hold neither proves admission nor selects a submitted failed edit for replay',async t=>{
 const f=await fixture(t),input=command(),release=f.platform.recovery!.holdCapturedSetEntry(input);t.after(release);assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),false);assert.throws(()=>f.platform.recovery!.claimCapturedSetEntry(input),{code:'client_not_admitted'});
 f.mode('rejected');await assert.rejects(f.platform.databases!.request(input),{code:'client_not_admitted'});await f.platform.recovery!.recover();assert.equal(f.applied,0);assert.equal(f.calls.length,1);
});

test('a known saved edit remains recoverable after its owner refresh already rejected before any retirement hint',async t=>{
 const f=await fixture(t);f.mode('success');const input=command(),releaseReceipt=f.platform.recovery!.holdCapturedSetEntry(input);t.after(releaseReceipt);
 const owner=f.platform.databases!.request(input).then(async()=>{f.failReads();await f.platform.databases!.request({op:'list'});});await assert.rejects(owner,{code:'client_not_admitted'});
 assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),true,'a failed derived refresh cannot discard its widget-owned positive receipt');assert.equal(f.calls.length,2);
 f.retire();const releaseClaim=f.platform.recovery!.claimCapturedSetEntry(input);t.after(releaseClaim);await f.platform.recovery!.recover();const receipt=await f.platform.databases!.request(input);assert.equal(receipt.entries[0].values.rating000001,9);assert.equal(f.calls.length,2);assert.equal(f.applied,1);
 releaseClaim();releaseReceipt();assert.equal(f.platform.recovery!.containsCapturedSetEntry(input),false);
});
