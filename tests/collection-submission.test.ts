import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionSubmission} from '../src/databases/collection-submission.ts';
import type {CollectionSubmission} from '../src/databases/collection-submission.ts';
import type {DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

function gate<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const command=(operationId='original-operation'):DatabaseRequest=>({op:'delete',operationId,collectionId:'abcdefghijkl',expectedRevision:'schema-1'});
const reply=():DatabaseResponse=>({collections:[{id:'abcdefghijkl',name:'Books',revision:'schema-2',deleted:true,properties:[]}],entries:[],projection:{pending:0,issues:[]}});
const retired=()=>Object.assign(new Error('Host retired'),{code:'host_exited',source:'host',commitUncertain:true});
const definite=()=>Object.assign(new Error('Rejected before commit'),{code:'invalid_database_request',source:'host',commitUncertain:false});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(request:(command:DatabaseRequest)=>Promise<DatabaseResponse>){
 const order:string[]=[],calls:DatabaseRequest[]=[];let live=true,holdReleased=0,claimReleased=0,captures=0,receipts=0;
 const options={service:{request:(value:DatabaseRequest)=>{order.push('request');calls.push(value);return request(value);}},validate(){assert.ok(live,'original component lifetime');},contains:()=>true,
  hold(){order.push('hold');return()=>{holdReleased++;};},claim(){order.push('claim');return()=>{claimReleased++;};},capture(){order.push('capture');captures++;},receipt(){order.push('receipt');receipts++;}};
 const owner=createCollectionSubmission(options);
 return{owner,options,order,calls,retire(){live=false;},get holdReleased(){return holdReleased;},get claimReleased(){return claimReleased;},get captures(){return captures;},get receipts(){return receipts;}};
}

test('submission freezes its original command before hold/RPC and owns whole completion',async()=>{
 const native=gate<DatabaseResponse>(),finish=gate(),f=setup(()=>native.promise),original=command() as any;
 const saving=f.owner.submit(original,async()=>{f.order.push('complete');await finish.promise;});original.expectedRevision='changed';
 assert.deepEqual(f.order,['capture','hold','request']);assert.equal(f.calls[0].op,'delete');assert.equal((f.calls[0] as any).expectedRevision,'schema-1');assert.ok(Object.isFrozen(f.calls[0]));
 native.resolve(reply());await turn();assert.equal(f.owner.pending,true);assert.equal(f.holdReleased,0);assert.deepEqual(f.order,['capture','hold','request','receipt','complete']);finish.resolve();await saving;assert.equal(f.owner.pending,false);assert.equal(f.holdReleased,1);
});
test('pending exact submissions coalesce and another command cannot replace their continuation',async()=>{
 const native=gate<DatabaseResponse>(),f=setup(()=>native.promise);let completed=0;
 const saving=f.owner.submit(command(),async()=>{completed++;});assert.equal(f.owner.submit(command(),async()=>{throw Error('replacement continuation');}),saving);
 await assert.rejects(f.owner.submit(command('new-operation'),async()=>{}),{code:'collection_submission_pending'});assert.equal(f.calls.length,1);native.resolve(reply());await saving;assert.equal(completed,1);assert.equal(f.captures,1);
});
test('a lifecycle observer inside synchronous RPC dispatch joins the already installed original task',async()=>{
 const native=gate<DatabaseResponse>();let owner!:CollectionSubmission,observed:Promise<void>|undefined,calls=0;
 owner=createCollectionSubmission({service:{request:()=>{calls++;observed=owner.waitForCompletion();return native.promise;}},validate(){},contains:()=>true,hold:()=>()=>{},claim:()=>()=>{}});
 const saving=owner.submit(command(),async()=>{});assert.equal(observed,saving);assert.equal(owner.waitForCompletion(),saving);assert.equal(calls,1);native.resolve(reply());await observed;await saving;await owner.waitForCompletion();assert.equal(calls,1);
});
test('positive settlement retries the exact selected command without awaiting a lost old reply',async()=>{
 const old=gate<DatabaseResponse>(),f=setup(async()=>f.calls.length===1?old.promise:reply()),seen:boolean[]=[];
 const saving=f.owner.submit(command(),async(_reply,recovering)=>{seen.push(recovering);});assert.equal(f.owner.canRecover(),true);const prepared=f.owner.prepareAdmissionRecovery()!;
 await prepared.settle();await saving;assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.deepEqual(seen,[true]);assert.equal(f.claimReleased,1);old.resolve(reply());await turn();assert.deepEqual(seen,[true]);
});
test('known published receipt bypasses native replay while a losing old derived refresh stays fenced',async()=>{
 const oldRefresh=gate(),f=setup(async()=>reply()),seen:boolean[]=[];
 const saving=f.owner.submit(command(),async(_reply,recovering)=>{seen.push(recovering);if(!recovering)await oldRefresh.promise;});await turn();assert.ok(f.owner.currentReceipt);
 await f.owner.prepareAdmissionRecovery()!.settle();await saving;assert.equal(f.calls.length,1);assert.deepEqual(seen,[false,true]);oldRefresh.reject(retired());await turn();assert.equal(f.owner.pending,false);assert.equal(f.holdReleased,1);
});
test('a first definite no-commit host rejection allows a later explicitly authored correction',async()=>{
 const f=setup(async()=>{if(f.calls.length===1)throw definite();return reply();});await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.pending,false);
 await f.owner.submit(command('explicit-correction'),async()=>{});assert.equal(f.captures,2);assert.equal(f.calls.length,2);assert.equal(f.holdReleased,2);
});
test('a later definite rejection cannot erase uncertainty from the original attempt',async()=>{
 const f=setup(async()=>{throw f.calls.length===1?retired():definite();});await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.canRecover(),true);
 await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.pending,true);await assert.rejects(f.owner.submit(command('replacement'),async()=>{}),{code:'collection_submission_pending'});assert.equal(f.calls.length,2);assert.equal(f.captures,1);f.owner.close();
});
for(const kind of ['unknown','protocol','plain','own-cause','inherited-cause','accessor-cause'] as const)test(`${kind} failure cannot authorize automatic recovery`,async()=>{
 let reads=0;const error=kind==='unknown'?Error('Reply lost'):kind==='plain'?{code:'host_exited',source:'host',commitUncertain:true}:retired();
 if(kind==='protocol')Object.assign(error,{source:'protocol'});
 if(kind==='own-cause')Object.assign(error,{cause:Object.assign(Error('Bad protocol'),{source:'protocol'})});
 if(kind==='inherited-cause')Object.setPrototypeOf(error,Object.assign(Object.create(Error.prototype),{cause:Error('Bad protocol')}));
 if(kind==='accessor-cause')Object.defineProperty(error,'cause',{get(){reads++;throw Error('getter');}});
 const f=setup(async()=>{throw error;});await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.canRecover(),false);assert.equal(reads,0);assert.equal(f.owner.pending,true);f.owner.close();
});
test('receipt validator failures remain terminal even when they mimic a retirement code',async()=>{
 const f=setup(async()=>reply());f.options.receipt=()=>{throw retired();};await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.canRecover(),false);assert.equal(f.owner.currentReceipt,undefined);assert.equal(f.calls.length,1);f.owner.close();
});
test('a coercible code object cannot forge typed host retirement authority',async()=>{
 let reads=0;const error=Object.assign(Error('Untrusted metadata'),{source:'host',commitUncertain:true,code:{toString(){reads++;return'client_not_admitted';}}}),f=setup(async()=>{throw error;});
 await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.canRecover(),false);assert.equal(reads,0);f.owner.close();
});
for(const code of [undefined,{}])test(`an untyped no-commit error (${code===undefined?'absent':'object'} code) cannot release the original command`,async()=>{
 const error=Object.assign(Error('Untrusted no-commit metadata'),{source:'host',commitUncertain:false,...(code===undefined?{}:{code})}),f=setup(async()=>{throw error;});
 await assert.rejects(f.owner.submit(command(),async()=>{}));assert.equal(f.owner.pending,true);await assert.rejects(f.owner.submit(command('replacement'),async()=>{}),{code:'collection_submission_pending'});assert.equal(f.calls.length,1);f.owner.close();
});
test('structured publication failure does not start an automatic native loop',async()=>{
 const value=reply();(value.projection as any).pending=1;const f=setup(async()=>value);
 f.options.receipt=()=>{throw Object.assign(Error('Publication incomplete'),{code:'collection_publication_pending'});};await assert.rejects(f.owner.submit(command(),async()=>{}));await turn();assert.equal(f.calls.length,1);assert.equal(f.owner.canRecover(),false);f.owner.close();
});
test('trusted failed settlement retains its original outer promise for the next positive attempt',async()=>{
 const old=gate<DatabaseResponse>(),f=setup(async()=>{if(f.calls.length===1)return old.promise;if(f.calls.length===2)throw retired();return reply();});let settled=false;
 const saving=f.owner.submit(command(),async()=>{}).then(()=>{settled=true;},error=>{settled=true;throw error;});const prepared=f.owner.prepareAdmissionRecovery()!;
 await assert.rejects(prepared.settle());await turn();assert.equal(settled,false);assert.equal(f.owner.canRecover(),true);await prepared.settle();await saving;assert.equal(f.calls.length,3);assert.deepEqual(f.calls[0],f.calls[2]);old.resolve(reply());
});
test('external close cancels a selected task without blocking admission settlement or publishing late work',async()=>{
 const native=gate<DatabaseResponse>(),f=setup(()=>native.promise);let completed=0;
 const saving=f.owner.submit(command(),async()=>{completed++;}),rejected=assert.rejects(saving,{code:'collection_submission_cancelled'}),prepared=f.owner.prepareAdmissionRecovery()!,settling=prepared.settle();f.owner.close();await rejected;await settling;
 assert.equal(f.holdReleased,1);assert.equal(f.claimReleased,1);native.resolve(reply());await turn();assert.equal(completed,0);assert.equal(f.owner.currentCommand,undefined);
});
test('synchronous lifetime loss during capture or hold cannot dispatch an RPC',async()=>{
 for(const phase of ['capture','hold'] as const){let owner!:CollectionSubmission,calls=0,released=0;owner=createCollectionSubmission({service:{request:async()=>{calls++;return reply();}},validate(){},contains:()=>true,claim:()=>()=>{},capture(){if(phase==='capture')owner.close();},hold(){if(phase==='hold')owner.close();return()=>{released++;};}});await assert.rejects(owner.submit(command(),async()=>{}));assert.equal(calls,0);assert.equal(released,phase==='hold'?1:0);}
});
test('lifetime loss inside proof or claim cannot leak replay selection',async()=>{
 for(const phase of ['contains','claim'] as const){let owner!:CollectionSubmission,released=0;const native=gate<DatabaseResponse>();owner=createCollectionSubmission({service:{request:()=>native.promise},validate(){},contains(){if(phase==='contains')owner.close();return true;},claim(){owner.close();return()=>{released++;};},hold:()=>()=>{}});const rejected=assert.rejects(owner.submit(command(),async()=>{}));if(phase==='contains')assert.equal(owner.canRecover(),false);else assert.equal(owner.prepareAdmissionRecovery(),undefined);await rejected;assert.equal(released,phase==='claim'?1:0);native.resolve(reply());}
});
for(const closingValidation of [1,2,3,4,5])test(`validation ${closingValidation} cannot continue work after closing its owner`,async()=>{
 let owner!:CollectionSubmission,validations=0,requests=0,receipts=0,completions=0,releases=0,captures=0;
 owner=createCollectionSubmission({service:{request:async()=>{requests++;return reply();}},validate(){if(++validations===closingValidation)owner.close();},contains:()=>true,hold:()=>()=>{releases++;},claim:()=>()=>{},receipt(){receipts++;},capture(){captures++;}});
 await assert.rejects(owner.submit(command(),async()=>{completions++;}),{code:'collection_submission_cancelled'});await turn();
 assert.equal(captures,closingValidation===1?0:1);assert.equal(requests,closingValidation<=2?0:1);assert.equal(receipts,closingValidation<=3?0:1);assert.equal(completions,closingValidation<=4?0:1);assert.equal(releases,closingValidation===1?0:1);
});
test('an attempt-bound proof prevents a successful losing old completion from publishing after handoff',async()=>{
 const oldRefresh=gate(),f=setup(async()=>reply()),published:string[]=[];
 const saving=f.owner.submit(command(),async(_reply,recovering,validateAttempt)=>{if(!recovering)await oldRefresh.promise;validateAttempt?.();published.push(recovering?'fresh':'old');});await turn();
 await f.owner.prepareAdmissionRecovery()!.settle();await saving;assert.deepEqual(published,['fresh']);oldRefresh.resolve();await turn();assert.deepEqual(published,['fresh'],'a successful late old read cannot publish into its replacement');assert.equal(f.calls.length,1);
});
