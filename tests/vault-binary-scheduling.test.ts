import {test} from 'node:test';
import assert from 'node:assert/strict';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {BinaryCommandSchema,BinaryResultSchema,ErrorCode} from '../src/generated/zorid/stream/v1/binary_pb.ts';
import {createDesktopBinaryStreams} from '../src/platform/desktop.ts';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {blobBinarySource} from '../src/core/binary-transfer.ts';
import {scheduleBinaryTransfer} from '../src/core/binary-transfer-queue.ts';
import type {Checkpoint,DurableCheckpoints} from '../src/core/durable-checkpoints.ts';
import type {VaultAdapter} from '../src/core/types.ts';

function gate(){
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  return {entered,release,async pause(){enter();await wait;}};
}

// Real desktop command consumer and busy guard; the protobuf backend is a
// bounded in-memory fixture, not evidence of Rust persistence or crash safety.
async function fixture(){
  const files=new Map([
    ['One.png',{id:'one',revision:'one-revision',bytes:Uint8Array.of(1,2,3)}],
    ['Two.png',{id:'two',revision:'two-revision',bytes:Uint8Array.of(4,5)}],
  ]);
  const memory=new MemoryAdapter({'Home.md':''}),scope={vaultId:'local-store',clientId:'client'};
  const checkpoints=new Map<string,Checkpoint>(),pins=new Map<string,Uint8Array>(),stages=new Map<string,any>();
  const commands:string[]=[];
  let hold:ReturnType<typeof gate>|undefined,failRead=false,commitCount=0;
  const provider:DurableCheckpoints={scope,
    async load(key){return structuredClone(checkpoints.get(key)??null);},
    async compareAndSwap(change){
      assert.equal(checkpoints.get(change.key)?.revision??null,change.expectedRevision);
      const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(checkpoints.size+1),encodedState:change.encodedState,deleted:change.encodedState===null,byteLength:change.encodedState?.length??0};
      checkpoints.set(change.key,row);return structuredClone(row);
    },
    async list(){return {items:[...checkpoints.values()],cursor:null,highWater:'0'};},
    async changes(){return {items:[],cursor:null,highWater:'0'};},
  };
  const digest=new Uint8Array(32).fill(3);
  const manifest=(bytes:number)=>({bytes:BigInt(bytes),digest,pages:[]});
  const binary=createDesktopBinaryStreams({scope,checkpoints:provider,
    limits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'16777216'},assertActive(){},
    async invoke(bytes){
      const command=fromBinary(BinaryCommandSchema,bytes).command;commands.push(command.case!);
      let result:any;
      switch(command.case){
        case 'openRead':{
          const input=command.value,file=[...files.values()].find(file=>file.id===input.id)!;
          if(!file){result={case:'failure',value:{code:ErrorCode.NOT_FOUND}};break;}
          if(input.expectedRevision!==undefined&&input.expectedRevision!==file.revision){result={case:'failure',value:{code:ErrorCode.REVISION_CONFLICT}};break;}
          const readId='pin-'+input.readId;pins.set(readId,new Uint8Array(file.bytes));
          result={case:'readOpened',value:{read:{owner:{localStoreId:scope.vaultId,clientId:scope.clientId},readId},entryRevision:file.revision,content:{entry:{entryId:file.id,bootstrapId:'bootstrap'},selectedEvent:'event-'+file.id,manifest:manifest(file.bytes.length)}}};break;
        }
        case 'readChunk':{
          const pause=hold;hold=undefined;if(pause)await pause.pause();
          if(failRead){failRead=false;throw Object.assign(new Error('read failed'),{code:'io'});}
          const input=command.value,all=pins.get(input.read!.readId)!;
          const data=all.slice(Number(input.offset),Number(input.offset)+input.maxBytes);
          result={case:'readChunk',value:{offset:input.offset,data,eof:Number(input.offset)+data.length===all.length}};break;
        }
        case 'closeRead':pins.delete(command.value.read!.readId);result={case:'readClosed',value:{}};break;
        case 'begin':{
          const input=command.value,stage={...scope,localStoreId:scope.vaultId,operationId:input.operationId,stageId:'stage-'+input.operationId};
          delete (stage as any).vaultId;
          stages.set(stage.stageId,{stage,target:input.target!.target,bytes:new Uint8Array()});
          result={case:'begun',value:{stage}};break;
        }
        case 'append':{
          const input=command.value,stage=stages.get(input.stage!.stageId)!;
          const combined=new Uint8Array(stage.bytes.length+input.data.length);combined.set(stage.bytes);combined.set(input.data,stage.bytes.length);stage.bytes=combined;
          result={case:'appended',value:{sequence:input.sequence,offset:input.offset,bytes:input.data.length,digest,acceptedLength:BigInt(combined.length)}};break;
        }
        case 'seal':{
          const stage=stages.get(command.value.stage!.stageId)!;
          result={case:'sealed',value:{stage:stage.stage,diagnostic:{manifest:manifest(stage.bytes.length)}}};break;
        }
        case 'commit':{
          const stage=stages.get(command.value.stage!.stageId)!,target=stage.target.value;
          assert.equal(stage.target.case,'create');files.set(target.path,{id:target.id,revision:'created-revision',bytes:new Uint8Array(stage.bytes)});commitCount++;
          result={case:'committed',value:{receipt:{operationId:stage.stage.operationId,sequence:1n,changes:[{after:{id:target.id,path:target.path,kind:1,revision:'created-revision',deleted:false}}]},projection:{status:{case:'projected',value:{}}}}};break;
        }
        default:throw new Error('Unexpected fixture command '+command.case);
      }
      return toBinary(BinaryResultSchema,create(BinaryResultSchema,{schemaVersion:1,result}));
    },
  });
  const stat=async(path:string)=>{const file=files.get(path);return file?{path,type:'file' as const,entryId:file.id,revision:file.revision,size:file.bytes.length,mtime:1}:memory.stat(path);};
  const adapter:VaultAdapter={binaryStreams:binary.streams,async list(){return [...await memory.list(),...await Promise.all([...files.keys()].map(path=>stat(path)))].filter(item=>item!==null);},stat,
    read:path=>memory.read(path),write:(path,text)=>memory.write(path,text),mkdir:path=>memory.mkdir(path),rename:(from,to)=>memory.rename(from,to),trash:path=>memory.trash(path),
  };
  const vault=new Vault(adapter);await vault.initialize();
  return {vault,adapter,binary,files,pins,commands,checkpoints,holdRead(){return hold=gate();},failRead(){failRead=true;},commits:()=>commitCount};
}

test('two simultaneous image reads share the desktop consumer without binary_busy',async()=>{
  const f=await fixture(),held=f.holdRead();
  const first=f.vault.readBinary('One.png');await held.entered;
  const second=f.vault.readBinary('Two.png');
  const combined=Promise.allSettled([first,second]);held.release();
  const result=await combined;
  assert.equal(result[0].status,'fulfilled');
  assert.equal(result[1].status,'fulfilled',result[1].status==='rejected'?String((result[1].reason as any).code):'');
  assert.deepEqual(result.map(value=>value.status==='fulfilled'?[...value.value]:null),[[1,2,3],[4,5]]);
  assert.equal(f.pins.size,0);
});

test('pasting an attachment while another image is loading preserves exact upload and read bytes',async()=>{
  const f=await fixture(),held=f.holdRead();
  const reading=f.vault.readBinary('One.png');await held.entered;
  const upload=f.vault.createBinaryStream('Pasted.png',blobBinarySource(new Blob([Uint8Array.of(7,8,9)])));
  const combined=Promise.allSettled([reading,upload]);held.release();
  const result=await combined;
  for(const value of result)assert.equal(value.status,'fulfilled',value.status==='rejected'?String((value.reason as any).code):'');
  assert.deepEqual([...f.files.get('Pasted.png')!.bytes],[7,8,9]);
  assert.equal(f.commits(),1);assert.equal(f.pins.size,0);
});

test('multiple Vault wrappers share the reservation for the same desktop stream consumer',async()=>{
  const f=await fixture(),alias=new Vault({...f.adapter});await alias.initialize();
  const held=f.holdRead(),first=f.vault.readBinary('One.png');await held.entered;
  const second=alias.readBinary('Two.png'),combined=Promise.all([first,second]);held.release();
  assert.deepEqual((await combined).map(bytes=>[...bytes]),[[1,2,3],[4,5]]);
  assert.equal(f.pins.size,0);
});

test('queued upload captures source function, declared length and guard before waiting',async()=>{
  const f=await fixture(),held=f.holdRead(),reading=f.vault.readBinary('One.png');await held.entered;
  const source=blobBinarySource(new Blob([Uint8Array.of(7,8,9)])),options={validate(){}};
  const upload=f.vault.createBinaryStream('Captured.png',source,options);
  Object.assign(source,{length:'0',read:async()=>{throw new Error('replacement source');}});
  options.validate=()=>{throw new Error('replacement guard');};
  const combined=Promise.all([reading,upload]);held.release();await combined;
  assert.deepEqual([...f.files.get('Captured.png')!.bytes],[7,8,9]);
  assert.equal(f.commits(),1);
});

test('queued read captures sink methods and byte limit before waiting',async()=>{
  const f=await fixture(),held=f.holdRead(),first=f.vault.readBinary('One.png');await held.entered;
  const received:number[]=[];let finished=false,aborted=0;
  const sink={async write(bytes:Uint8Array){received.push(...bytes);},async finish(){finished=true;},async abort(){aborted++;}};
  const options={maxBytes:'2',validate(){}};
  const second=f.vault.readBinaryStream('Two.png',sink,options);
  sink.write=async()=>{throw new Error('replacement sink');};sink.finish=async()=>{throw new Error('replacement finish');};
  options.maxBytes='0';options.validate=()=>{throw new Error('replacement guard');};
  const combined=Promise.all([first,second]);held.release();await combined;
  assert.deepEqual(received,[4,5]);assert.equal(finished,true);assert.equal(aborted,0);
});

test('queued read and modification retain their original identity when the path is replaced',async()=>{
  const f=await fixture(),held=f.holdRead(),first=f.vault.readBinary('One.png');await held.entered;
  let pulled=0;
  const reading=f.vault.readBinary('Two.png');
  const writing=f.vault.modifyBinaryStream('Two.png',{length:'1',async read(){pulled++;return Uint8Array.of(9);}});
  // Drain the already selected metadata, then simulate an independent replacement.
  await f.vault.read('Home.md');
  f.files.set('Two.png',{id:'replacement',revision:'replacement-revision',bytes:Uint8Array.of(99)});
  const combined=Promise.allSettled([first,reading,writing]);held.release();const result=await combined;
  assert.equal(result[0].status,'fulfilled');
  for(const value of result.slice(1)){
    assert.equal(value.status,'rejected');
    if(value.status==='rejected')assert.ok(['not_found','revision_conflict'].includes(value.reason.code));
  }
  assert.equal(pulled,0);assert.equal(f.commits(),0);assert.equal(f.commands.includes('begin'),false);
  assert.deepEqual([...f.files.get('Two.png')!.bytes],[99]);assert.equal(f.pins.size,0);
});

test('retired queued work aborts its captured sink once without pulling a source or opening another pin',async()=>{
  const f=await fixture(),held=f.holdRead(),first=f.vault.readBinary('One.png');await held.entered;
  let aborted=0,pulled=0;
  const sink={async write(){assert.fail('retired sink received bytes');},async finish(){assert.fail('retired output published');},async abort(){aborted++;}};
  const reading=f.vault.readBinaryStream('Two.png',sink);
  const writing=f.vault.createBinaryStream('Retired.png',{length:'1',async read(){pulled++;return Uint8Array.of(9);}});
  sink.abort=async()=>{assert.fail('replacement abort method');};
  f.vault.adapter=new MemoryAdapter();
  const combined=Promise.allSettled([first,reading,writing]);held.release();
  for(const value of await combined){assert.equal(value.status,'rejected');if(value.status==='rejected')assert.equal(value.reason.code,'intent_identity_mismatch');}
  assert.equal(aborted,1);assert.equal(pulled,0);assert.equal(f.commands.filter(command=>command==='openRead').length,1);assert.equal(f.pins.size,0);
  f.vault.adapter=f.adapter;assert.deepEqual([...await f.vault.readBinary('Two.png')],[4,5]);
});

test('read failure closes its pin, aborts once and releases the next transfer',async()=>{
  const f=await fixture();let aborted=0;f.failRead();
  const failed=f.vault.readBinaryStream('One.png',{async write(){assert.fail('failed output received bytes');},async finish(){assert.fail('failed output published');},async abort(){aborted++;}});
  const next=f.vault.readBinary('Two.png'),result=await Promise.allSettled([failed,next]);
  assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
  assert.equal(aborted,1);assert.equal(f.pins.size,0);
});

test('recovery and release reservations wait for the active transfer to close its pin',async()=>{
  const f=await fixture(),held=f.holdRead(),reading=f.vault.readBinary('One.png');await held.entered;
  const recovering=scheduleBinaryTransfer(f.binary.streams,()=>f.binary.recover());
  const releasing=scheduleBinaryTransfer(f.binary.streams,()=>f.binary.release());
  const combined=Promise.all([reading,recovering,releasing]);held.release();await combined;
  assert.equal(f.pins.size,0);assert.equal(f.commands.filter(command=>command==='closeRead').length,1);
});
