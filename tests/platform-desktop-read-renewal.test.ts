import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformAdapter} from '../src/platform/index.ts';
import type {DesktopDurableRequest} from '../src/platform/bridge';

function held<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const row={entryId:'entry-one',revision:'revision-one',path:'One.md',content:'Saved text',stat:{ctime:1,mtime:1,size:10}};
const scope={vaultId:'vault-authority',clientId:'retained-client'};
const failure=(code='host_exited',source='host',commitUncertain=true)=>({durableError:true,schemaVersion:1,error:{code,source,commitUncertain}});
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(check());}
async function fixture(t:TestContext,{databases=false}={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  let dead=false,code='host_exited',source='host',uncertain=true,recoveries=0,releaseCalls=0,currentRoot='/fixture',foreign=false;
  let repairGate:ReturnType<typeof held>|undefined,readGate:ReturnType<typeof held<any>>|undefined,releaseGate:ReturnType<typeof held>|undefined;
  let repairError:unknown,wrongEntry=false,allDead=false;
  let databaseGate:ReturnType<typeof held<any>>|undefined;
  const calls:{method:string;admission?:string;args?:readonly unknown[]}[]=[],receivers:{retire:()=>void}[]=[];
  const binding=(admissionId:string)=>({admissionId,scope:{...scope,...(foreign?{vaultId:'foreign-authority'}:{})},...(databases?{databases:true}:{})});
  const namespace=async(method:string,...args:unknown[])=>{calls.push({method,args});if(readGate){const gate=readGate;readGate=undefined;return gate.promise;}if(dead||allDead)throw Error('Legacy bridge lost custom error fields');
    if(method==='list')return[{path:'One.md',kind:'file',...row.stat}];if(method==='stat')return{path:'One.md',kind:'file',...row.stat};if(method==='readBinary')return new Uint8Array([1,2,255]);return row.content;};
  const bridge={getVault:async()=>({path:currentRoot,name:'Fixture'}),onChange:()=>()=>{},
    list:()=>namespace('list'),stat:(path:string)=>namespace('stat',path),read:(path:string)=>namespace('read',path),readBinary:(path:string)=>namespace('readBinary',path),
    onDocumentRuntimeNudge:(_root:string,_admission:string,_nudge:()=>void,retire:()=>void)=>{receivers.push({retire});return()=>{};},
    async durableRequest(request:DesktopDurableRequest){
      if(request.kind==='context')return binding('old');
      if(request.kind==='recover'){
        recoveries++;if(allDead&&recoveries>2)throw Error('Fixture stops an unbounded recovery loop');if(repairGate)await repairGate.promise;if(repairError)throw repairError;dead=false;return binding(recoveries===1?'new':`new-${recoveries}`);
      }
      if(request.kind==='release'){releaseCalls++;if(releaseGate)await releaseGate.promise;return;}
      if(request.kind!=='invoke')throw Error('unexpected request');
      calls.push({method:request.method,admission:request.admissionId,args:structuredClone(request.args)});
      if(request.admissionId==='old'&&dead||allDead){if(request.method==='databaseCommand')return{databases:true,schemaVersion:1,ok:false,error:{code,source,commitUncertain:uncertain}};return failure(code,source,uncertain);}
      if(request.method==='listUnacknowledged')return[];
      if(request.method==='readText'||request.method==='readTextById'){
        if(readGate){const gate=readGate;readGate=undefined;return gate.promise;}
        return{...row,...(wrongEntry?{entryId:'unrelated-entry'}:{})};
      }
      if(request.method==='databaseCommand'){
        if(request.admissionId==='old'&&databaseGate)return databaseGate.promise;
        return databaseReply();
      }
      throw Error('Unexpected mutation or derived command: '+request.method);
    },
  };
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  const platform=(await createPlatformAdapter())!;
  function databaseReply(){return{databases:true,schemaVersion:1,ok:true,value:{collections:[{id:'collection01',name:'Recovery',revision:'collection-before',deleted:false,properties:[]}],entries:[{entryId:'entry-one',collectionId:'collection01',revision:'entry-after',fileRevision:'file-after',path:'One.md',values:{rating000001:9},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}}};}
  return{platform,calls,receivers,databaseReply,holdDatabase(){return databaseGate=held<any>();},get recoveries(){return recoveries;},get releaseCalls(){return releaseCalls;},expire(){dead=true;},expireAll(){dead=true;allDead=true;},healthy(){dead=false;},
    error(nextCode:string,nextSource='host',nextUncertain=true){code=nextCode;source=nextSource;uncertain=nextUncertain;dead=true;},
    holdRepair(){return repairGate=held();},holdRead(){return readGate=held<any>();},holdRelease(){return releaseGate=held();},
    failRepair(error:unknown){repairError=error;},foreign(){foreign=true;},selectOther(){currentRoot='/other';},wrongEntry(){wrongEntry=true;}};
}

test('expired admitted note read repairs same scope once and retains requested entry identity',async t=>{
  const f=await fixture(t);f.expire();
  assert.deepEqual(await f.platform.adapter.durableWrites!.readTextById(row.entryId),row);
  assert.equal(f.recoveries,1);assert.deepEqual(f.platform.adapter.durableWrites!.checkpoints.scope,scope);
  assert.deepEqual(f.calls.filter(call=>call.method==='readTextById').map(call=>[call.admission,call.args]),[['old',[row.entryId]],['new',[row.entryId]]]);
});

for(const method of ['list','stat','read','readBinary'] as const)test(`expired legacy ${method} uses failure-only admitted health proof and retries exactly once`,async t=>{
  const f=await fixture(t);f.expire();
  const result=method==='list'?await f.platform.adapter.list():await f.platform.adapter[method]('One.md');
  assert.ok(result);assert.equal(f.recoveries,1);
  assert.equal(f.calls.filter(call=>call.method===method).length,2);
  assert.equal(f.calls.filter(call=>call.method==='listUnacknowledged').length,1);
});

test('healthy namespace and admitted reads add no health-probe or recovery traffic',async t=>{
  const f=await fixture(t);await f.platform.adapter.list();await f.platform.adapter.stat('One.md');await f.platform.adapter.read('One.md');
  assert.deepEqual(await f.platform.adapter.readBinary('One.md'),new Uint8Array([1,2,255]));await f.platform.adapter.durableWrites!.readText('One.md');
  assert.equal(f.recoveries,0);assert.equal(f.calls.filter(call=>call.method==='listUnacknowledged').length,0);
});

test('a healthy health proof preserves the exact original legacy read failure',async t=>{
  const f=await fixture(t),gate=f.holdRead(),original=Error('ordinary failed read');
  const read=f.platform.adapter.read('One.md'),rejected=assert.rejects(read,error=>error===original);gate.reject(original);await rejected;
  assert.equal(f.recoveries,0);assert.equal(f.calls.filter(call=>call.method==='listUnacknowledged').length,1);
});

test('concurrent expired and during-repair reads join one checked recovery',async t=>{
  const f=await fixture(t),gate=f.holdRepair();f.expire();
  const first=f.platform.adapter.durableWrites!.readText('One.md');await until(()=>f.recoveries===1);
  const second=f.platform.adapter.read('One.md'),third=f.platform.adapter.durableWrites!.readTextById(row.entryId);
  gate.resolve();const values=await Promise.all([first,second,third]);
  assert.deepEqual(values,[row,row.content,row]);assert.equal(f.recoveries,1);
  assert.equal(f.calls.filter(call=>call.method==='readTextById'&&call.admission==='old').length,0);
});

test('synchronous lifecycle listener recovery and read renewal share the same repair',async t=>{
  const f=await fixture(t);let notices=0;
  f.platform.recovery!.subscribe(async()=>{notices++;await f.platform.recovery!.recover();});f.expire();
  assert.deepEqual(await f.platform.adapter.durableWrites!.readText('One.md'),row);
  assert.equal(notices,1);assert.equal(f.recoveries,1);
});

test('a deferred lifecycle owner claims a live held Base edit before any read-triggered backend ACK',async t=>{
  const f=await fixture(t,{databases:true}),owner=held(),request={op:'set_entry' as const,operationId:'original-operation',entryId:'entry-one',expectedRevision:'entry-before',expectedCollectionRevision:'collection-before',values:{rating000001:9}};
  const releaseHold=f.platform.recovery!.holdCapturedSetEntry(request);
  // Capture the unchanged accepted command on the healthy admission first.
  const oldDatabase=f.holdDatabase(),pendingEdit=f.platform.databases!.request(request);
  let notices=0,claimed=false;
  f.platform.recovery!.subscribe(async()=>{notices++;await owner.promise;const releaseClaim=f.platform.recovery!.claimCapturedSetEntry(request);claimed=true;
    try{await f.platform.recovery!.recover();}finally{releaseClaim();}});
  f.expire();let settled=false;const read=f.platform.adapter.durableWrites!.readText('One.md').finally(()=>{settled=true;});
  await until(()=>notices===1);await Promise.resolve();assert.equal(settled,false);assert.equal(f.recoveries,0);assert.equal(claimed,false);
  owner.resolve();assert.deepEqual(await read,row);assert.equal(claimed,true);assert.equal(f.recoveries,1);
  assert.equal((await pendingEdit).entries[0].values.rating000001,9);
  const commands=f.calls.filter(call=>call.method==='databaseCommand');assert.deepEqual(commands.map(call=>call.admission),['old','new']);assert.deepEqual(commands[1].args,commands[0].args);
  oldDatabase.resolve(f.databaseReply());releaseHold();
});

test('observer-only or rejected retirement listeners cannot leave a read hanging or start unowned repair',async t=>{
  for(const rejects of [false,true]){
    const f=await fixture(t);f.platform.recovery!.subscribe(()=>{if(rejects)throw Error('owner could not prepare');});f.expire();
    await assert.rejects(f.platform.adapter.durableWrites!.readText('One.md'),{code:'host_exited'});assert.equal(f.recoveries,0);
  }
});

test('explicit release wakes a deferred owner waiter and rejects without renewing or forwarding',async t=>{
  const f=await fixture(t),owner=held();f.platform.recovery!.subscribe(()=>owner.promise);f.expire();
  const read=f.platform.adapter.durableWrites!.readText('One.md'),rejected=assert.rejects(read,{code:'client_not_admitted'});
  await until(()=>f.calls.some(call=>call.method==='readText'));await f.platform.release!();await rejected;owner.resolve();assert.equal(f.recoveries,0);
});

test('explicit release during repair rejects the waiting read and prevents fresh read dispatch',async t=>{
  const f=await fixture(t),gate=f.holdRepair();f.expire();
  const read=f.platform.adapter.durableWrites!.readText('One.md'),rejected=assert.rejects(read,{code:'client_not_admitted'});
  await until(()=>f.recoveries===1);let readRejected=false;void rejected.then(()=>{readRejected=true;});const closing=f.platform.release!();
  try{await until(()=>readRejected);}finally{gate.resolve();await closing;}await rejected;
  assert.equal(f.calls.filter(call=>call.method==='readText'&&call.admission==='new').length,0);
});

test('repeated dead replacement cannot reset one logical read retry budget',async t=>{
  const f=await fixture(t);f.expireAll();
  await assert.rejects(f.platform.adapter.durableWrites!.readText('One.md'),{code:'host_exited'});
  assert.equal(f.recoveries,1);assert.deepEqual(f.calls.filter(call=>call.method==='readText').map(call=>call.admission),['old','new']);
});

test('a read begun after a retirement hint still has only one replacement budget',async t=>{
  const f=await fixture(t);f.expireAll();f.receivers[0].retire();
  await assert.rejects(f.platform.adapter.durableWrites!.readText('One.md'),{code:'host_exited'});assert.equal(f.recoveries,1);
});

test('namespace forwarding also shares the same one-retry budget across replacements',async t=>{
  const f=await fixture(t);f.expireAll();
  await assert.rejects(f.platform.adapter.read('One.md'),/Legacy bridge lost custom error fields/);
  assert.equal(f.recoveries,1);assert.equal(f.calls.filter(call=>call.method==='read').length,2);
  assert.equal(f.calls.filter(call=>call.method==='listUnacknowledged').length,1);
});

test('a successful late old read is discarded and repeated on the checked fresh admission',async t=>{
  const f=await fixture(t),gate=f.holdRead(),read=f.platform.adapter.durableWrites!.readTextById(row.entryId);
  await f.platform.recovery!.recover();gate.resolve({...row,content:'Stale old generation'});
  assert.deepEqual(await read,row);assert.equal(f.recoveries,1);
});

test('a successful old read after retirement waits for deferred owner preparation before renewing',async t=>{
  const f=await fixture(t),gate=f.holdRead(),owner=held();let notices=0,settled=false;
  f.platform.recovery!.subscribe(async()=>{notices++;await owner.promise;await f.platform.recovery!.recover();});
  const read=f.platform.adapter.durableWrites!.readTextById(row.entryId).finally(()=>{settled=true;});
  f.receivers[0].retire();gate.resolve({...row,content:'Invalid old result after retirement'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(notices,1);assert.equal(settled,false);assert.equal(f.recoveries,0);
  owner.resolve();assert.deepEqual(await read,row);assert.equal(f.recoveries,1);
});

test('an observer-only retirement cannot admit an old successful namespace reply',async t=>{
  const f=await fixture(t),gate=f.holdRead();f.platform.recovery!.subscribe(()=>{});
  const read=f.platform.adapter.read('One.md'),rejected=assert.rejects(read,{code:'desktop_recovery_stale_reply'});
  f.receivers[0].retire();gate.resolve('Invalid stale namespace bytes');await rejected;assert.equal(f.recoveries,0);
});

test('a late old namespace result cannot cross explicit release',async t=>{
  const f=await fixture(t),gate=f.holdRead(),read=f.platform.adapter.read('One.md'),rejected=assert.rejects(read,{code:'client_not_admitted'});
  await f.platform.release!();await rejected;gate.reject(Error('Late underlying IO rejection remains observed'));await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.platform.adapter.list(),{code:'client_not_admitted'});assert.equal(f.recoveries,0);
});

test('failed explicit release permits later reads without reviving the cancelled old read',async t=>{
  const f=await fixture(t),gate=f.holdRelease(),closing=f.platform.release!(),rejected=assert.rejects(closing,{code:'durable_transport_lost'});
  await assert.rejects(f.platform.adapter.read('One.md'),{code:'client_not_admitted'});gate.reject(Error('Release transport failed'));await rejected;
  assert.equal(await f.platform.adapter.read('One.md'),row.content);assert.equal(f.recoveries,0);
});

for(const [code,source,uncertain] of [['durable_transport_lost','transport',true],['invalid_durable_response','protocol',true],['host_timeout','host',true],['revision_conflict','host',false],['host_exited','host',false]] as const)
  test(`${code}/${source}/${uncertain} does not authorize read admission renewal`,async t=>{
    const f=await fixture(t);f.error(code,source,uncertain);
    await assert.rejects(f.platform.adapter.durableWrites!.readText('One.md'),{code});assert.equal(f.recoveries,0);
  });

test('failed recovery rejects once without an automatic repair loop',async t=>{
  const f=await fixture(t);f.expire();f.failRepair(Error('Repair failed'));
  await assert.rejects(f.platform.adapter.durableWrites!.readText('One.md'),{code:'durable_transport_lost'});assert.equal(f.recoveries,1);
});

test('foreign recovery scope cannot receive any retried note or namespace IO',async t=>{
  const f=await fixture(t);f.expire();f.foreign();
  await assert.rejects(f.platform.adapter.read('One.md'),{code:'durable_recovery_scope_changed'});
  assert.equal(f.recoveries,1);assert.equal(f.calls.filter(call=>call.admission==='new').length,0);
});

test('a selected different vault is rejected before retrying read IO',async t=>{
  const f=await fixture(t),gate=f.holdRepair();f.expire();
  const read=f.platform.adapter.durableWrites!.readText('One.md'),rejected=assert.rejects(read,{code:'durable_recovery_scope_changed'});
  await until(()=>f.recoveries===1);f.selectOther();gate.resolve();await rejected;
  assert.equal(f.calls.filter(call=>call.method==='readText'&&call.admission==='new').length,0);
});

test('a different logical entry returned for readTextById fails closed without repair',async t=>{
  const f=await fixture(t);f.wrongEntry();
  await assert.rejects(f.platform.adapter.durableWrites!.readTextById(row.entryId),{code:'invalid_durable_response',source:'protocol'});assert.equal(f.recoveries,0);
});
