import test from 'node:test';
import assert from 'node:assert/strict';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {BinaryCommandSchema,BinaryResultSchema,ErrorCode} from '../src/generated/zorid/stream/v1/binary_pb.ts';
import type {BinaryResult,StageLocator} from '../src/generated/zorid/stream/v1/binary_pb.ts';
import {createDesktopBinaryStreams} from '../src/platform/desktop.ts';
import type {Checkpoint,DurableCheckpoints} from '../src/core/durable-checkpoints.ts';
const digest=new Uint8Array(32).fill(3);
const input={operationId:'operation',target:{kind:'create' as const,entryId:'entry',path:'new.bin'},expectedLength:'3'};
function fixture(){
  const pins=new Map<string,string>(),readRequests:string[]=[];let pinSequence=0,dropOpen=false,dropClose=false;
  const scope={vaultId:'local-store',clientId:'client'},heads=new Map<string,Checkpoint>(),commands:string[]=[],payloads:Uint8Array[]=[];
  let phase='receiving',length=0n,active=true,dropCommit=false,dropBegin=false,dropQuery=false,dropSeal=false,rejectCommit=false,hold:Promise<void>|undefined,checkpointGate:Promise<void>|undefined,commits=0;
  const stage={$typeName:'zorid.stream.v1.StageLocator' as const,localStoreId:scope.vaultId,clientId:scope.clientId,operationId:'operation',stageId:'stage'};
  const manifest={$typeName:'zorid.common.v1.Manifest' as const,bytes:3n,digest,pages:[]};
  const outcome={$typeName:'zorid.stream.v1.StageCommitted' as const,receipt:{$typeName:'zorid.common.v1.CommitReceipt' as const,operationId:'operation',sequence:1n,changes:[{$typeName:'zorid.common.v1.EntryChange' as const,after:{$typeName:'zorid.common.v1.EntryState' as const,id:'entry',path:'new.bin',kind:1 as const,revision:'revision',deleted:false}}]},projection:{$typeName:'zorid.stream.v1.ProjectionStatus' as const,status:{case:'projected' as const,value:{$typeName:'zorid.stream.v1.Projected' as const}}}};
  const checkpoints:DurableCheckpoints={scope,
    async load(key){if(checkpointGate)await checkpointGate;return structuredClone(heads.get(key)??null);},
    async compareAndSwap(change){const prior=heads.get(change.key);assert.equal(prior?.revision??null,change.expectedRevision);const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(heads.size+1),encodedState:change.encodedState,deleted:change.encodedState===null,byteLength:change.encodedState?.length??0};heads.set(change.key,row);return structuredClone(row);},
    async list(){return{items:[...heads.values()],cursor:null,highWater:'1'};},async changes(){return{items:[],cursor:null,highWater:'1'};},
  };
  async function invoke(bytes:Uint8Array){
    assert.ok(active,'dispatch cannot use retired ownership');const command=fromBinary(BinaryCommandSchema,bytes);assert.equal(command.schemaVersion,1);commands.push(command.command.case!);if(hold)await hold;
    let result:BinaryResult['result'];
    switch(command.command.case){
      case 'begin':assert.ok([...heads.values()].some(row=>JSON.parse(row.encodedState!).phase==='receiving'),'request checkpoint precedes stage begin');if(dropBegin){dropBegin=false;throw Object.assign(new Error('lost begin'),{commitUncertain:true});}result={case:'begun',value:{$typeName:'zorid.stream.v1.StageBegun',stage}};break;
      case 'append':{const chunk=command.command.value;payloads.push(new Uint8Array(chunk.data));assert.ok(chunk.data.length<=131072);length=chunk.offset+BigInt(chunk.data.length);result={case:'appended',value:{$typeName:'zorid.stream.v1.ChunkReceipt',sequence:chunk.sequence,offset:chunk.offset,bytes:chunk.data.length,digest,acceptedLength:length}};break;}
      case 'seal':assert.equal(JSON.parse(heads.get('binary-command/v1/operation')!.encodedState!).phase,'seal_requested');phase='sealed';if(dropSeal){dropSeal=false;throw new Error('lost seal');}result={case:'sealed',value:{$typeName:'zorid.stream.v1.StageSealed',stage,diagnostic:{$typeName:'zorid.stream.v1.SealedStage',manifest}}};break;
      case 'commit':assert.equal(JSON.parse(heads.get('binary-command/v1/operation')!.encodedState!).phase,'commit_requested');if(rejectCommit){phase='rejected';result={case:'failure',value:{$typeName:'zorid.stream.v1.Failure',code:ErrorCode.REVISION_CONFLICT,message:'rejected'}};break;}if(phase!=='committed')commits++;phase='committed';if(dropCommit){dropCommit=false;throw Object.assign(new Error('lost commit'),{commitUncertain:true});}result={case:'committed',value:outcome};break;
      case 'query':if(dropQuery){dropQuery=false;throw new Error('query unavailable');}result={case:'status',value:{$typeName:'zorid.stream.v1.StageStatus',stage,acceptedLength:length,nextSequence:1,sealRequested:phase!=='receiving',state:phase==='committed'?{case:'committed',value:outcome}:phase==='rejected'?{case:'rejected',value:{$typeName:'zorid.stream.v1.Failure',code:ErrorCode.REVISION_CONFLICT,message:'rejected'}}:phase==='sealed'?{case:'sealed',value:{$typeName:'zorid.stream.v1.Sealed'}}:{case:'receiving',value:{$typeName:'zorid.stream.v1.Receiving'}},...(['sealed','committed'].includes(phase)?{finalized:{$typeName:'zorid.stream.v1.SealedStage' as const,manifest}}:{})}};break;
      case 'openRead':{const requested=command.command.value.readId;assert.ok(requested);readRequests.push(requested);const saved=heads.get('binary-read/v1/'+requested);assert.equal(JSON.parse(saved!.encodedState!).phase,'opening');let pin=pins.get(requested);if(!pin){pin='pin-'+(++pinSequence);pins.set(requested,pin);}if(dropOpen){dropOpen=false;throw Object.assign(new Error('lost open'),{commitUncertain:true});}result={case:'readOpened',value:{$typeName:'zorid.stream.v1.ReadOpened',read:{$typeName:'zorid.stream.v1.ReadLocator',owner:{$typeName:'zorid.stream.v1.StageOwner',localStoreId:scope.vaultId,clientId:scope.clientId},readId:pin},entryRevision:'revision',content:{$typeName:'zorid.stream.v1.BinaryContent',scope:{$typeName:'zorid.common.v1.Scope',realmId:'realm',vaultId:'vault'},entry:{$typeName:'zorid.common.v1.EntryIdentity',entryId:'entry',bootstrapId:'bootstrap'},selectedEvent:'event',manifest}}};break;}
      case 'readChunk':result={case:'readChunk',value:{$typeName:'zorid.stream.v1.ReadChunkResult',offset:command.command.value.offset,data:new Uint8Array([1,2,3]),eof:true}};break;
      case 'closeRead':{const pin=command.command.value.read!.readId;for(const [requested,token]of pins)if(token===pin)pins.delete(requested);if(dropClose){dropClose=false;throw Object.assign(new Error('lost close'),{commitUncertain:true});}result={case:'readClosed',value:{$typeName:'zorid.stream.v1.ReadClosed'}};break;}
      default:throw new Error('Unexpected command '+command.command.case);
    }
    return toBinary(BinaryResultSchema,create(BinaryResultSchema,{schemaVersion:1,result}));
  }
  const options={scope,checkpoints,limits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'16777216'},invoke,assertActive(){if(!active)throw Object.assign(new Error('retired'),{code:'client_ownership_lost'});}};
  return{options,heads,commands,payloads,pins,readRequests,dropOpen(){dropOpen=true;},dropClose(){dropClose=true;},make:()=>createDesktopBinaryStreams(options),get commits(){return commits;},dropBegin(){dropBegin=true;},dropQuery(){dropQuery=true;},dropSeal(){dropSeal=true;},rejectCommit(){rejectCommit=true;},dropCommit(){dropCommit=true;},hold(value:Promise<void>|undefined){hold=value;},gateCheckpoints(value:Promise<void>){checkpointGate=value;},retire(){active=false;}};
}
test('desktop binary stages checkpoint phases and retain exact commit identity through lost acknowledgment/restart',async()=>{
  const f=fixture(),first=f.make(),ref=await first.streams.begin(input),bytes=new Uint8Array([1,2,3]);
  const append=first.streams.append(ref,{sequence:0,offset:'0',bytes});bytes.fill(9);await append;assert.deepEqual([...f.payloads[0]],[1,2,3]);
  await first.streams.seal(ref,{finalLength:'3'});f.dropCommit();f.dropQuery();await assert.rejects(first.streams.commit(ref),/lost commit/);
  assert.equal(JSON.parse(f.heads.get('binary-command/v1/operation')!.encodedState!).phase,'commit_requested');
  const reopened=f.make();assert.equal(await reopened.recover(),true);assert.equal(f.commits,1);
  assert.equal((await reopened.streams.query(ref)).phase,'committed');
  const serialized=[...f.heads.values()].map(row=>row.encodedState!).join('');assert.doesNotMatch(serialized,/base64|data|bytes/);assert.equal(JSON.parse(serialized).phase,'committed');
});
test('receiving/sealed stages remain inert on recovery and begin retries the original immutable request',async()=>{
  const f=fixture(),first=f.make();f.dropBegin();await assert.rejects(first.streams.begin(input),/lost begin/);assert.equal(await f.make().recover(),false);
  const ref=await first.streams.begin(input);await first.streams.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});await first.streams.seal(ref,{finalLength:'3'});
  assert.equal(await f.make().recover(),false);assert.equal(f.commands.includes('commit'),false);
  await assert.rejects(f.make().streams.begin({...input,target:{kind:'create',entryId:'entry',path:'other.bin'}}),{code:'idempotency_conflict'});
});
test('one chunk is admitted at a time and an overlapping rejection cannot unlock its pending owner',async()=>{
  const f=fixture(),consumer=f.make(),ref=await consumer.streams.begin(input);let release!:()=>void;f.hold(new Promise(resolve=>{release=resolve;}));
  const pending=consumer.streams.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<2;i++)await assert.rejects(consumer.streams.query(ref),{code:'binary_busy'});assert.equal(f.commands.filter(value=>value==='append').length,1);release();await pending;
  f.hold(undefined);await assert.rejects(consumer.streams.append(ref,{sequence:1,offset:'3',bytes:new Uint8Array(131073)}),{code:'request_limit'});
});
test('retired dispatch after checkpoint await cannot send begin or authorize binary mutation',async()=>{
  const f=fixture(),consumer=f.make();let release!:()=>void;f.gateCheckpoints(new Promise(resolve=>{release=resolve;}));const pending=consumer.streams.begin(input);f.retire();release();await assert.rejects(pending,{code:'client_ownership_lost'});assert.deepEqual(f.commands,[]);
});
test('pinned reads check event/revision and close stale selections without returning their bytes',async()=>{
  const f=fixture(),consumer=f.make();await assert.rejects(consumer.streams.openRead({entryId:'entry',expectedContentEvent:'other-event'}),{code:'revision_conflict'});assert.equal(f.commands.at(-1),'closeRead');
  const ref=await consumer.streams.openRead({entryId:'entry',expectedRevision:'revision',expectedContentEvent:'event'});const read=await consumer.streams.read(ref,{offset:'0',maxBytes:3});assert.deepEqual([...read.bytes],[1,2,3]);assert.equal(read.eof,true);await consumer.streams.closeRead(ref);
});

test('authoritative terminal rejection settles the checkpoint and never poisons startup recovery',async()=>{
  const f=fixture(),consumer=f.make(),ref=await consumer.streams.begin(input);
  await consumer.streams.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});await consumer.streams.seal(ref,{finalLength:'3'});
  f.rejectCommit();await assert.rejects(consumer.streams.commit(ref),{code:'revision_conflict'});
  assert.equal(JSON.parse(f.heads.get('binary-command/v1/operation')!.encodedState!).phase,'rejected');
  assert.equal(await f.make().recover(),false);assert.equal(f.commits,0);
});
test('lost seal acknowledgment supports normalized exact retry and query reconciliation without authorization',async()=>{
  const f=fixture(),consumer=f.make(),ref=await consumer.streams.begin(input),hash='03'.repeat(32);
  await consumer.streams.append(ref,{sequence:0,offset:'0',bytes:new Uint8Array([1,2,3])});f.dropSeal();
  await assert.rejects(consumer.streams.seal(ref,{finalLength:'3',expectedDigest:hash}),/lost seal/);
  await consumer.streams.seal(ref,{expectedDigest:hash,finalLength:'3'});assert.equal(f.commands.includes('commit'),false);
  const saved=f.heads.get('binary-command/v1/operation')!;const state=JSON.parse(saved.encodedState!);state.phase='seal_requested';delete state.finalized;saved.encodedState=JSON.stringify(state);
  assert.equal((await f.make().streams.query(ref)).phase,'sealed');assert.equal(JSON.parse(f.heads.get(saved.key)!.encodedState!).phase,'sealed');
  assert.equal(f.commands.includes('commit'),false);
});


test('lost open acknowledgment resumes the persisted lookup ID and closes its distinct server pin on restart',async()=>{
  const f=fixture(),consumer=f.make();f.dropOpen();await assert.rejects(consumer.streams.openRead({entryId:'entry',expectedRevision:'revision'}),/lost open/);
  const opening=[...f.heads.values()].find(row=>row.key.startsWith('binary-read/v1/'))!;
  const requested=JSON.parse(opening.encodedState!).requestedReadId;assert.equal(f.readRequests[0],requested);assert.equal(f.pins.size,1);
  assert.equal(await f.make().recover(),false);assert.deepEqual(f.readRequests,[requested,requested]);assert.equal(f.pins.size,0);
  const closed=JSON.parse(f.heads.get(opening.key)!.encodedState!);assert.equal(closed.phase,'closed');assert.notEqual(closed.ref.readId,requested);
});
test('close acknowledgment loss remains recoverable without closing another active pin',async()=>{
  const f=fixture(),consumer=f.make(),first=await consumer.streams.openRead({entryId:'entry'}),second=await consumer.streams.openRead({entryId:'entry'});
  assert.equal(f.pins.size,2);f.dropClose();await assert.rejects(consumer.streams.closeRead(first),/lost close/);
  const third=await consumer.streams.openRead({entryId:'entry'});assert.equal(f.pins.size,2);assert.ok([...f.pins.values()].includes(second.readId));
  await consumer.streams.closeRead(second);await consumer.streams.closeRead(third);assert.equal(f.pins.size,0);
  assert.ok([...f.heads.values()].filter(row=>row.key.startsWith('binary-read/v1/')).every(row=>JSON.parse(row.encodedState!).phase==='closed'));
});
test('oversized UTF8 destination is rejected before checkpoint or host dispatch',async()=>{
  const f=fixture();await assert.rejects(f.make().streams.begin({...input,target:{kind:'create',entryId:'entry',path:'é'.repeat(2049)}}),{code:'invalid_request'});assert.equal(f.heads.size,0);assert.deepEqual(f.commands,[]);
});
