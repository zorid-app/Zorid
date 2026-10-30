// Protocol mechanics only: this Node peer is deliberately simulated. Passing
// this test is never a genuine Rust receipt, native recovery or app result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createNativeRelay} from './control.mjs';
import {Frames,digest} from './protocol.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const encode=(header,body=Buffer.alloc(0))=>{const json=Buffer.from(JSON.stringify(header)),prefix=Buffer.alloc(8);prefix.writeUInt32BE(json.length);prefix.writeUInt32BE(body.length,4);return Buffer.concat([prefix,json,body]);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check){const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await pause(10);}throw Error('Simulated relay unit timed out');}
test('simulated stdio peer verifies byte-exact forwarding and clean EOF after dropped success', {timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-relay-unit-')),peer=path.join(directory,'SIMULATED-peer'),script=path.join(directory,'peer.mjs');
 let child,relay;const chunks=[],errors=[];
 try{
  const protocol=fileURLToPath(new URL('./protocol.mjs',import.meta.url));
  await fs.writeFile(script,`import {Frames} from ${JSON.stringify(protocol)};
const encode=${encode.toString()};
process.stdout.write(encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}));
const parser=new Frames();for await(const chunk of process.stdin)for(const frame of parser.push(chunk)){
 const request=frame.header.command.family?.request;
 if(!request){process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:{echo:true}},frame.body));continue;}
 const mutation=request.mutation,receipt={operation_id:request.operation_id,sequence:'7',changes:[{before:null,after:{id:mutation.id,path:mutation.path,kind:'file',revision:'mock-r1',deleted:false}}]};
 process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:{commit:receipt}}));
}parser.end();
`);
  await fs.writeFile(peer,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});
  relay=await createNativeRelay({native:peer,directory:path.join(directory,'control')});
  child=spawn(relay.executable,['--vault',directory],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const initial=encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}});
  await wait(()=>Buffer.concat(chunks).length===initial.length);assert.deepEqual(Buffer.concat(chunks),initial);
  const body=Buffer.from([0,255,128,10]),ping=encode({version:1,request_id:'1',command:{method:'unit-echo'}},body);
  child.stdin.write(ping);
  const echo=encode({version:1,request_id:'1',ok:true,result:{echo:true}},body);
  await wait(()=>Buffer.concat(chunks).length===initial.length+echo.length);assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,echo]));
  const payload=Buffer.from('simulated-unit-body'),token=await relay.arm({mode:'drop',path:'Created/Unit.md',bodySha256:digest(payload)});
  child.stdin.write(encode({version:1,request_id:'2',command:{method:'file_command',client_id:'mock-client',family:{version:1,request:{operation_id:'mock-operation',mutation:{type:'create',id:'mock-entry',path:'Created/Unit.md',kind:'file'}},create_mode:'text'}}},payload));
  const [code,signal]=await closed;assert.equal(code,0,Buffer.concat(errors).toString());assert.equal(signal,null);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,echo]),'The selected simulated success frame never reached main');
  const events=await relay.events();assert.equal(events.filter(value=>value.kind==='dropped'&&value.token===token).length,1);
  const dispatched=events.filter(value=>value.kind==='native-write-request');assert.equal(dispatched.length,1);assert.equal(dispatched[0].method,'file_command');assert.equal(dispatched[0].operationId,'mock-operation');assert.equal(dispatched[0].bodySha256,digest(payload));assert.match(dispatched[0].commandSha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(dispatched[0]).includes(payload.toString()),false,'Request evidence logs a digest, never source bytes');assert.ok(events.indexOf(dispatched[0])<events.findIndex(value=>value.kind==='dropped'));
  assert.ok(events.some(value=>value.kind==='drop-child-closed'&&value.exitCode===0&&value.signal===null));
  assert.ok(events.some(value=>value.kind==='closed'&&value.dropped===true&&value.failed===false));
  assert.deepEqual(events.filter(value=>value.kind==='relay-failed'),[]);
  assert.equal(await fs.stat(path.join(directory,'control','arm.json')).catch(error=>error.code),'ENOENT');
  new Frames().push(Buffer.concat(chunks));
 }finally{
  await relay?.dispose().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}
  await fs.rm(directory,{recursive:true,force:true});
 }
});

test('simulated child death during a prepared hold exposes real EOF without the withheld reply', {timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-relay-death-unit-')),peer=path.join(directory,'SIMULATED-peer'),script=path.join(directory,'peer.mjs');
 let child,relay;const chunks=[],errors=[];
 const entry={id:'mock-entry',path:'AutoHost.base',kind:'file',revision:'before',deleted:false};
 const intent={token:'SIMULATED-secret-intent',client_id:'mock-client',operation_id:'mock-operation',entry_id:entry.id,state:'prepared'};
 try{
  const protocol=fileURLToPath(new URL('./protocol.mjs',import.meta.url));
  await fs.writeFile(script,`import {Frames} from ${JSON.stringify(protocol)};
const encode=${encode.toString()};
const entry=${JSON.stringify(entry)},intent=${JSON.stringify(intent)};
process.stdout.write(encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}));
const parser=new Frames();for await(const chunk of process.stdin)for(const frame of parser.push(chunk)){
 process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:frame.header.command.method==='stat_path'?{entry}:{intent}}));
}parser.end();
`);
  await fs.writeFile(peer,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});
  relay=await createNativeRelay({native:peer,directory:path.join(directory,'control')});
  child=spawn(relay.executable,['--vault',directory],{stdio:['pipe','pipe','pipe']});const closed=once(child,'close');
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const initial=encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}),stat=encode({version:1,request_id:'1',ok:true,result:{entry}});
  await wait(()=>Buffer.concat(chunks).length===initial.length);
  child.stdin.write(encode({version:1,request_id:'1',command:{method:'stat_path',path:entry.path}}));
  await wait(()=>Buffer.concat(chunks).length===initial.length+stat.length);
  const body=Buffer.from('SIMULATED original A'),token=await relay.arm({mode:'hold',phase:'prepared',path:entry.path,entryId:entry.id,bodySha256:digest(body)});
  child.stdin.write(encode({version:1,request_id:'2',command:{method:'prepare_intent',client_id:intent.client_id,operation_id:intent.operation_id,mutation:{type:'write',id:entry.id,expected:entry.revision},source_capture:'SIMULATED-capture'}},body));
  const held=await wait(async()=>(await relay.events()).find(row=>row.kind==='held'&&row.token===token));
  process.kill(held.nativePid,'SIGKILL');
  let timer;const result=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1200);})]);clearTimeout(timer);
  assert.ok(result,'Actual child death must expose EOF without waiting for the hold watchdog or manual release');
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,stat]),'Neither a stale successful prepare ACK nor a synthetic failure reaches main');
  assert.equal(result[1],null,'The relay exits itself after observing its genuine child exit');
  const events=await relay.events(),exited=events.find(row=>row.kind==='held-child-closed');
  assert.equal(exited.token,token);assert.equal(exited.exitCode,null);assert.equal(exited.signal,'SIGKILL');assert.equal(exited.withheldResponseSha256,held.responseSha256);
  assert.deepEqual(events.filter(row=>['released','watchdog-released','relay-failed'].includes(row.kind)),[]);
  assert.ok(events.some(row=>row.kind==='closed'&&row.nativeTerminatedDuringHold===true&&row.exitCode===null&&row.signal==='SIGKILL'));
 }finally{
  await relay?.dispose().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}
  await fs.rm(directory,{recursive:true,force:true});
 }
});

test('simulated prepared hold forwards the original checkpoint error and byte-exact CAS replay', {timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-relay-prepared-unit-')),peer=path.join(directory,'SIMULATED-peer'),script=path.join(directory,'peer.mjs');
 let child,relay;const chunks=[],errors=[];
 const entry={id:'mock-entry',path:'Failures/Live.base',kind:'file',revision:'before',deleted:false};
 const intent={token:'mock-token',client_id:'mock-client',operation_id:'mock-operation',entry_id:entry.id,state:'prepared'};
 const negative={code:'filesystem_failed',commit_uncertain:true};
 try{
  const protocol=fileURLToPath(new URL('./protocol.mjs',import.meta.url));
  await fs.writeFile(script,`import {Frames} from ${JSON.stringify(protocol)};
const encode=${encode.toString()};
const entry=${JSON.stringify(entry)},intent=${JSON.stringify(intent)},negative=${JSON.stringify(negative)};
process.stdout.write(encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}));
let attempts=0;const parser=new Frames();for await(const chunk of process.stdin)for(const frame of parser.push(chunk)){
 const method=frame.header.command.method;
 const header=method==='stat_path'?{ok:true,result:{entry}}:method==='prepare_intent'?{ok:true,result:{intent}}:attempts++===0?{ok:false,error:negative}:{ok:true,result:{checkpoint:{SIMULATED:true}}};
 process.stdout.write(encode({version:1,request_id:frame.header.request_id,...header}));
}parser.end();
`);
  await fs.writeFile(peer,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});
  relay=await createNativeRelay({native:peer,directory:path.join(directory,'control')});
  child=spawn(relay.executable,['--vault',directory],{stdio:['pipe','pipe','pipe']});const closed=once(child,'close');
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const initial=encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}),stat=encode({version:1,request_id:'1',ok:true,result:{entry}});
  await wait(()=>Buffer.concat(chunks).length===initial.length);
  child.stdin.write(encode({version:1,request_id:'1',command:{method:'stat_path',path:entry.path}}));
  await wait(()=>Buffer.concat(chunks).length===initial.length+stat.length);
  const body=Buffer.from('SIMULATED exact A'),token=await relay.arm({mode:'hold',phase:'prepared',path:entry.path,entryId:entry.id,bodySha256:digest(body)});
  child.stdin.write(encode({version:1,request_id:'2',command:{method:'prepare_intent',client_id:'mock-client',operation_id:'mock-operation',mutation:{type:'write',id:entry.id,expected:entry.revision},source_capture:'mock-capture'}},body));
  const held=await wait(async()=>(await relay.events()).find(event=>event.kind==='held'&&event.token===token));
  assert.equal(held.phase,'prepared');assert.equal(held.nativeState,'prepared');assert.equal(held.nativeIntentToken,intent.token);assert.equal(held.sequence,undefined);
  assert.equal(held.nativeIntentTokenSha256,digest(Buffer.from(intent.token)));
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,stat]),'No inert reply leaked before explicit release');
  const prepared=encode({version:1,request_id:'2',ok:true,result:{intent}});
  await relay.release(token);await wait(()=>Buffer.concat(chunks).length===initial.length+stat.length+prepared.length);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,stat,prepared]));
  const command={method:'checkpoint_cas',key:'note/v1/'+entry.id,expected_revision:'mock-before',next_revision:'mock-after',has_state:true},checkpointBody=Buffer.from('SIMULATED opaque checkpoint A with original reference');
  child.stdin.write(encode({version:1,request_id:'3',command},checkpointBody));
  const rejected=encode({version:1,request_id:'3',ok:false,error:negative});
  await wait(()=>Buffer.concat(chunks).length===initial.length+stat.length+prepared.length+rejected.length);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,stat,prepared,rejected]),'Negative bytes came only from the explicitly simulated peer');
  child.stdin.write(encode({version:1,request_id:'4',command},checkpointBody));
  const replayed=encode({version:1,request_id:'4',ok:true,result:{checkpoint:{SIMULATED:true}}});
  await wait(()=>Buffer.concat(chunks).length===initial.length+stat.length+prepared.length+rejected.length+replayed.length);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,stat,prepared,rejected,replayed]),'Replayed success is also the unmodified simulated peer frame');
  child.stdin.end();const [code,signal]=await closed;assert.equal(code,0,Buffer.concat(errors).toString());assert.equal(signal,null);
  const events=await relay.events(),checkpointEvents=events.filter(event=>event.kind==='native-checkpoint-response');
  assert.equal(checkpointEvents.length,2);const[failure,success]=checkpointEvents;
  const dispatched=events.filter(value=>value.kind==='native-write-request');assert.deepEqual(dispatched.map(value=>value.method),['prepare_intent','checkpoint_cas','checkpoint_cas']);
  assert.equal(dispatched[0].entryId,entry.id);assert.equal(dispatched[0].expectedRevision,entry.revision);assert.equal(dispatched[0].clientIdSha256,digest(Buffer.from(intent.client_id)));assert.equal(dispatched[0].sourceCaptureSha256,digest(Buffer.from('mock-capture')));assert.equal(dispatched[0].mutationSha256,digest(Buffer.from(JSON.stringify({type:'write',id:entry.id,expected:entry.revision}))));
  assert.equal(events.find(row=>row.kind==='native-prepared-write').nativeIntentTokenSha256,held.nativeIntentTokenSha256);
  for(const request of dispatched.slice(1)){assert.equal(request.key,command.key);assert.equal(request.expectedRevision,command.expected_revision);assert.equal(request.nextRevision,command.next_revision);assert.equal(request.commandSha256,digest(Buffer.from(JSON.stringify(command))));assert.equal(request.bodySha256,digest(checkpointBody));assert.equal(JSON.stringify(request).includes(checkpointBody.toString()),false);}
  assert.ok(events.indexOf(dispatched[0])<events.findIndex(value=>value.kind==='native-prepared-write'));assert.ok(events.indexOf(dispatched[1])<events.indexOf(failure));assert.ok(events.indexOf(dispatched[2])<events.indexOf(success));
  assert.equal(failure.ok,false);assert.equal(failure.errorCode,'filesystem_failed');assert.equal(failure.commitUncertain,true);assert.equal(success.ok,true);
  for(const row of checkpointEvents){assert.equal(row.key,command.key);assert.equal(row.commandSha256,digest(Buffer.from(JSON.stringify(command))));assert.equal(row.bodySha256,digest(checkpointBody));}
  assert.equal(failure.responseSha256,digest(rejected));assert.equal(success.responseSha256,digest(replayed));
  assert.notEqual(failure.requestSha256,success.requestSha256,'Transport request IDs may change while the identical CAS command/body replay');
  assert.deepEqual(events.filter(event=>['watchdog-released','relay-failed'].includes(event.kind)),[]);
 }finally{
  await relay?.dispose().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}
  await fs.rm(directory,{recursive:true,force:true});
 }
});

test('simulated admission and saved-source observations hash secrets without changing genuine frames', {timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-relay-observation-unit-')),peer=path.join(directory,'SIMULATED-peer'),script=path.join(directory,'peer.mjs');
 let child,relay;const chunks=[],errors=[];
 const lease={local_store_id:'mock-store',client_id:'mock-client',token:'SIMULATED-SECRET-LEASE'},capture={capture_id:'SIMULATED-CAPTURE',logical_witness:{entry_id:'mock-entry',revision:'mock-rev',path:'AutoHost.base'}},intent={token:'SIMULATED-SECRET-REFERENCE',operation_id:'mock-operation',entry_id:'mock-entry',state:'prepared'},source=Buffer.from('SIMULATED saved S0');
 try{
  const protocol=fileURLToPath(new URL('./protocol.mjs',import.meta.url));
  await fs.writeFile(script,`import {Frames} from ${JSON.stringify(protocol)};
const encode=${encode.toString()};
const lease=${JSON.stringify(lease)},capture=${JSON.stringify(capture)},intent=${JSON.stringify(intent)},source=Buffer.from(${JSON.stringify([...source])});
process.stdout.write(encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}}));
const parser=new Frames();for await(const chunk of process.stdin)for(const frame of parser.push(chunk)){
 const method=frame.header.command.method;process.stdout.write(encode({version:1,request_id:frame.header.request_id,ok:true,result:method==='claim_client'?{lease}:method==='query_intent'?{intent}:{capture}},method==='capture_saved_source'?source:Buffer.alloc(0)));
}parser.end();
`);
  await fs.writeFile(peer,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});
  relay=await createNativeRelay({native:peer,directory:path.join(directory,'control')});
  child=spawn(relay.executable,['--vault',directory],{stdio:['pipe','pipe','pipe']});const closed=once(child,'close');child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const initial=encode({version:1,request_id:'0',ok:true,result:{SIMULATED:true}});await wait(()=>Buffer.concat(chunks).length===initial.length);
  const claim=encode({version:1,request_id:'1',command:{method:'claim_client',client_id:lease.client_id}}),claimed=encode({version:1,request_id:'1',ok:true,result:{lease}});
  child.stdin.write(claim);await wait(()=>Buffer.concat(chunks).length===initial.length+claimed.length);
  const command={method:'capture_saved_source',client_id:lease.client_id,capture_id:capture.capture_id,...capture.logical_witness},captured=encode({version:1,request_id:'2',ok:true,result:{capture}},source);
  child.stdin.write(encode({version:1,request_id:'2',command}));await wait(()=>Buffer.concat(chunks).length===initial.length+claimed.length+captured.length);
  const query=encode({version:1,request_id:'3',command:{method:'query_intent',reference:{token:intent.token,client_id:lease.client_id}}}),queried=encode({version:1,request_id:'3',ok:true,result:{intent}});
  child.stdin.write(query);await wait(()=>Buffer.concat(chunks).length===initial.length+claimed.length+captured.length+queried.length);
  assert.deepEqual(Buffer.concat(chunks),Buffer.concat([initial,claimed,captured,queried]));child.stdin.end();assert.deepEqual(await closed,[0,null],Buffer.concat(errors).toString());
  const events=await relay.events();assert.ok(events.every(row=>row.generation===events[0].generation));assert.match(events[0].generation,/^[a-f0-9-]{36}$/);
  const requests=events.filter(row=>row.kind==='native-request');assert.deepEqual(requests.map(row=>row.method),['claim_client','capture_saved_source','query_intent']);assert.deepEqual(requests.map(row=>row.requestId),['1','2','3']);
  assert.equal(requests[1].entryId,capture.logical_witness.entry_id);assert.equal(requests[1].commandSha256,digest(Buffer.from(JSON.stringify(command))));assert.equal(requests[1].bodySha256,digest(Buffer.alloc(0)));
  const admission=events.find(row=>row.kind==='native-admission-response');assert.ok(admission,'A real successful peer claim must be passively observable');
  assert.equal(admission.method,'claim_client');assert.equal(admission.ok,true);assert.equal(admission.clientIdSha256,digest(Buffer.from(lease.client_id)));assert.equal(admission.localStoreIdSha256,digest(Buffer.from(lease.local_store_id)));assert.equal(admission.leaseTokenSha256,digest(Buffer.from(lease.token)));assert.equal(admission.requestSha256,digest(claim));assert.equal(admission.responseSha256,digest(claimed));
  const saved=events.find(row=>row.kind==='native-source-capture-response');assert.ok(saved);assert.equal(saved.captureIdSha256,digest(Buffer.from(capture.capture_id)));assert.equal(saved.clientIdSha256,admission.clientIdSha256);assert.equal(saved.logicalWitnessSha256,digest(Buffer.from(JSON.stringify({entryId:capture.logical_witness.entry_id,revision:capture.logical_witness.revision,path:capture.logical_witness.path}))));assert.equal(saved.bodySha256,digest(source));assert.equal(saved.responseSha256,digest(captured));
  const observed=events.find(row=>row.kind==='native-intent-query-response');assert.ok(observed);assert.equal(observed.referenceTokenSha256,digest(Buffer.from(intent.token)));assert.equal(observed.nativeIntentTokenSha256,observed.referenceTokenSha256);assert.equal(observed.operationId,intent.operation_id);assert.equal(observed.state,'prepared');assert.equal(observed.responseSha256,digest(queried));assert.deepEqual(events.filter(row=>row.kind==='native-mutation-response'),[],'An observed query is not a new commit');
  for(const secret of [lease.token,capture.capture_id,intent.token,source.toString()])assert.equal(JSON.stringify(events).includes(secret),false,'New passive evidence must never log authentication/capture secrets or source bytes');
 }finally{await relay?.dispose().catch(()=>{});if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}await fs.rm(directory,{recursive:true,force:true});}
});
