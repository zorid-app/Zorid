'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');
const {captureWorkBlockRequest:capture,decodeWorkBlockReply:decode,MAX_WORKBLOCK_RESPONSE}=require('../desktop/workblocks.cjs');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const clientId='10000000-0000-4000-8000-000000000001';
const revision=Array.from({length:32},(_,i)=>255-i),range={start_ms:'-62135596800000',end_ms:'-62135596799000',timezone:'America/Toronto'};
const target={record:'block:Case',generation:'g/Exact'},mutation={...target,operation:'operation:Exact',expectedRevision:revision};
const req=(op,input={})=>({schemaVersion:1,command:{op,...input}});
const read=()=>({...target,revision,created:true,deleted:false,block:{ranges:[{operation:'range:1',range}],titles:[{operation:'title:1',title:'你好😀'}],taskRefs:['Entry_Case']},unresolved:{future_status:'9007199254740993'}});
const commit=operation=>({operation,revision,sequence:'9007199254740993'});
function wire(op,value){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op,value}));return{result:{workblocks:true,schemaVersion:1,bytes:bytes.length},bytes};}
function decodeValue(request,value){const w=wire(request.command.op,value);return decode(request,w.result,w.bytes);}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function fixture(){
  const host=Object.create(RustVaultService.prototype),calls=[];
  host.capabilities=['workblocks'];let owner=true,active=true,gate=null;
  const lease={local_store_id:'store',client_id:clientId,token:'10000000-0000-4000-8000-000000000002'};
  host.request=async(command,bytes,reference)=>{
    calls.push(structuredClone(command));
    if(command.method==='claim_client'){active=true;return{result:{lease}};}
    if(command.method==='release_client'){active=false;return{result:{released:true,reference:command.reference}};}
    assert.deepEqual(reference,lease,'actual withClientLease carries native owner');assert.equal(active,true);
    if(command.method==='identity')return{result:{identity:{local_store_id:'store',realm_id:null,vault_id:null}},bytes:new Uint8Array()};
    assert.equal(command.method,'workblocks');if(gate)await gate.promise;
    return wire(command.request.command.op,command.request.command.op==='read'?read():commit(command.request.command.operation));
  };
  const service={host,closed:false,root:'/vault',subscribe:()=>()=>{},async close(){this.closed=true;}};
  return{host,service,calls,options:{fixture:true,clientId,assertOwner(){if(!owner)throw Object.assign(new Error('revoked'),{code:'grant_retired'});}},set owner(v){owner=v;},set gate(v){gate=v;},get active(){return active;}};
}

test('semantic capture preserves identities, signed decimal times and revision bytes before enqueue',()=>{
  const input=req('move',{...mutation,range}),snapshot=capture(input);
  input.command.expectedRevision[0]=0;input.command.range.start_ms='1';
  assert.equal(snapshot.command.expectedRevision[0],255);assert.equal(snapshot.command.range.start_ms,'-62135596800000');
  revision[0]=255;range.start_ms='-62135596800000';
  assert.equal(snapshot.command.record,'block:Case');assert.equal(snapshot.command.generation,'g/Exact');
  for(const invalid of [req('enroll',{}),req('read',{...target,owner:'x'}),req('create',{...target,operation:'op',range,title:'😀'.repeat(129)}),req('move',{...mutation,expectedRevision:new Array(32),range}),req('move',{...mutation,expectedRevision:revision.slice(1),range}),req('add_ref',{...mutation,task:'bad:Entry'}),req('window',{fromMs:'0',untilMs:'2678400001',limit:64,byteLimit:1}),req('window',{fromMs:'0',untilMs:'1',limit:65,byteLimit:1}),req('window',{fromMs:'0',untilMs:'1',limit:64,byteLimit:1048577}),req('changes',{after:'01',limit:1}),...['-0','01','9223372036854775808',1].map(start_ms=>req('create',{...target,operation:'op',range:{...range,start_ms}}))])assert.throws(()=>capture(invalid),error=>Boolean(error.code));
});

test('strict reply rejects malformed/oversized results and preserves exact structured missing reads',()=>{
  const request=capture(req('read',target)),value=read();
  assert.deepEqual(decodeValue(request,value),value);
  assert.deepEqual(decodeValue(request,{...value,created:false,block:null}).revision,revision);
  for(const invalid of [null,{...value,record:'other'},{...value,revision:[1]},{...value,unresolved:{future:'x'.repeat(2049)}},{...value,block:{...value.block,taskRefs:Array(65).fill('entry')}}])assert.throws(()=>decodeValue(request,invalid),{code:'invalid_workblock_response'});
  const {result,bytes}=wire('read',value);
  for(const [m,b] of [[{...result,extra:true},bytes],[{...result,bytes:MAX_WORKBLOCK_RESPONSE+1},bytes],[result,Buffer.from([255])],[{...result,bytes:1},bytes]])assert.throws(()=>decode(request,m,b),{code:'invalid_workblock_response'});
  assert.throws(()=>decodeValue(capture(req('title',{...mutation,title:null})),{...commit('other')}),{code:'invalid_workblock_response',commitUncertain:true});
  const query=capture(req('window',{fromMs:'-62135596800000',untilMs:'-62135596798000',limit:1,byteLimit:10000}));
  const page={blocks:[value],cursor:'cursor:Exact',incomplete:true,watermark:'9007199254740993',scanned:1,bytes:1000};assert.deepEqual(decodeValue(query,page),page);
  for(const bad of [{...page,blocks:[value,value]},{...page,scanned:65},{...page,bytes:10001},{...page,incomplete:false},{...page,watermark:9007199254740993}])assert.throws(()=>decodeValue(query,bad),{code:'invalid_workblock_response'});
  const changes=capture(req('changes',{after:'9007199254740992',limit:1}));
  const change={sequence:'9007199254740993',record_key:'["opaque","key"]',update_id:'opaque:update',status:'future_status'};
  assert.deepEqual(decodeValue(changes,{changes:[change],next:change.sequence}).changes[0],change);
  assert.throws(()=>decodeValue(changes,{changes:[change],next:'9007199254740992'}),{code:'invalid_workblock_response'});
});

test('real client admission snapshots args, drains work and rejects stale owner responses with mutation uncertainty',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options),gate=deferred();f.gate=gate;
  const input=req('move',{...mutation,expectedRevision:[...revision],range:{...range}}),pending=context.workblockCommand(input);
  input.command.range.start_ms='1';input.command.expectedRevision[0]=0;
  assert.equal(f.calls.at(-1).request.command.range.start_ms,range.start_ms);
  let flushed=false;const releasing=context.release(()=>{flushed=true;});
  await assert.rejects(context.workblockCommand(req('read',target)),{code:'client_not_admitted'});
  assert.equal(flushed,false);assert.equal(f.active,true);gate.resolve();assert.deepEqual(await pending,commit(mutation.operation));await releasing;assert.equal(f.active,false);
  f.gate=null;const second=await admitDesktopFixtureClient(f.service,f.options),late=deferred();f.gate=late;
  const stale=second.workblockCommand(req('move',{...mutation,range}));f.owner=false;late.resolve();
  await assert.rejects(stale,{code:'client_ownership_lost',commitUncertain:true});await second.retire();
});

test('queued real process transport rechecks revoked lease before any frame leaves',async()=>{
  const host=Object.create(RustVaultService.prototype),gate=deferred(),frames=[];
  Object.assign(host,{sequence:0n,queuedCount:0,queuedBytes:0,tail:gate.promise,ready:Promise.resolve(),child:{stdin:{write:b=>frames.push(b)}},expect(){assert.fail('revoked dispatch');}});
  let owner=true;const scoped=host.withClientLease({local_store_id:'store',client_id:clientId,token:'token'},()=>{if(!owner)throw Object.assign(new Error('revoked'),{code:'client_not_admitted'});});
  const pending=scoped.workblockCommand(clientId,req('move',{...mutation,range}));owner=false;gate.resolve();
  await assert.rejects(pending,{code:'client_not_admitted'});await host.tail;assert.deepEqual(frames,[]);assert.equal(host.queuedCount,0);
});

test('actual framed receiver rejects oversized body prefix and malformed mutation acknowledgements as uncertain',async()=>{
  for(const malformed of ['oversize','wrong-operation','lost']){
    const host=Object.create(RustVaultService.prototype),request=capture(req('title',{...mutation,title:null}));
    Object.assign(host,{timeoutMs:1000,prefix:Buffer.alloc(8),prefixUsed:0,frameUsed:0,child:{stdin:{destroy(){}},stdout:{destroy(){}},kill(){}},exited:true});
    const pending=host.expect('1',{method:'workblocks',request});
    if(malformed==='lost')host.abort(Object.assign(new Error('lost'),{code:'host_exited',commitUncertain:true}));
    else{
      const w=wire('title',commit('other')),header=Buffer.from(JSON.stringify({version:1,request_id:'1',ok:true,result:w.result})),prefix=Buffer.alloc(8);prefix.writeUInt32BE(header.length);prefix.writeUInt32BE(malformed==='oversize'?MAX_WORKBLOCK_RESPONSE+1:w.bytes.length,4);
      host.receive(malformed==='oversize'?prefix:Buffer.concat([prefix,header,w.bytes]));
    }
    await assert.rejects(pending,error=>error.commitUncertain===true);assert.ok(host.fatal);
  }
});

test('real WindowBroker + editor-core + client admission fences sender/window/vault/admission generations',async()=>{
  const f=fixture(),filename=path.resolve(__dirname,'../desktop/editor-core.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,structuredClone,require(name){
    if(name==='node:fs/promises')return{realpath:async value=>value};
    if(name==='./vault-service.cjs')return{VaultService:{open:async()=>f.service}};
    if(name==='./host-location.cjs')return{resolveDesktopHost:async()=>'/trusted/host'};
    return nativeRequire(name);
  }});
  const manager=module.exports.createEditorCoreManager({}),broker=new WindowBroker({openVault:p=>manager.open(p),allowedURL:url=>url==='app://trusted'});
  const sender={id:1,isDestroyed:()=>false,mainFrame:{url:'app://trusted'}},window={webContents:sender,isDestroyed:()=>false};
  const record=broker.register(window);record.clientSlot={clientId};await broker.select(record,'/vault');record.persistedVaultRoot='/vault';
  const context=await manager.context(broker,record,'/vault'),event={sender,senderFrame:sender.mainFrame};assert.equal(context.workBlocks,true);
  const call=(root='/vault',admission=context.admissionId,e=event)=>manager.invoke(broker,record,e,root,admission,'workblockCommand',[req('read',target)]);
  assert.equal((await call()).record,target.record);
  const before=f.calls.length;
  await assert.rejects(call('/other'),{code:'durable_scope_changed'});await assert.rejects(call('/vault','stale'),{code:'durable_scope_changed'});
  await assert.rejects(call('/vault',context.admissionId,{sender,senderFrame:{url:'app://trusted'}}),/Untrusted sender/);
  sender.mainFrame.url='app://evil';await assert.rejects(call(),/Untrusted page/);sender.mainFrame.url='app://trusted';
  record.generation++;await assert.rejects(call(),{code:'durable_scope_changed'});assert.equal(f.calls.length,before);
  broker.remove(record);await assert.rejects(call(),/Untrusted sender/);await manager.retire(broker,record,f.service);await manager.close();
});

test('capability is absent on old native hosts and semantic methods fail closed',async()=>{
  const f=fixture();f.host.capabilities=[];const context=await admitDesktopFixtureClient(f.service,f.options);
  assert.equal(context.workblockCommand,undefined);await context.release(()=>{});
});

test('preload sanitizes lost WorkBlock IPC without leaking native details or dispatching a replay',async()=>{
  let bridge,calls=0;const filename=require.resolve('../desktop/preload.cjs');
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require(name){assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{async invoke(){calls++;throw new Error('private /vault/native path');}},webUtils:{}};}});
  const envelope=await bridge.durableInvoke('/vault','admission','workblockCommand',[req('create',{...target,operation:'op',range})]);
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)),{workblocks:true,schemaVersion:1,ok:false,error:{code:'workblock_transport_lost',source:'host',commitUncertain:true}});assert.equal(JSON.stringify(envelope).includes('/vault'),false);assert.equal(calls,1);
});

test('admission rejects own accessors, toJSON and nonplain requests before any transport',async()=>{
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options),before=f.calls.length;
  let gets=0;const command={op:'read',generation:'g'};Object.defineProperty(command,'record',{enumerable:true,get(){gets++;return gets===1?'safe':'bad record';}});
  for(const input of [{schemaVersion:1,command},{schemaVersion:1,command:{...target,op:'read',toJSON(){assert.fail('must not call toJSON');}}},Object.assign(Object.create({schemaVersion:1}),{command:{...target,op:'read'}})])await assert.rejects(context.workblockCommand(input),{code:'invalid_workblock_request'});
  assert.equal(gets,0);assert.equal(f.calls.length,before);
  const query=capture(req('window',{fromMs:range.start_ms,untilMs:range.end_ms,limit:1,byteLimit:1000}));
  for(const bad of [{blocks:[{...read(),created:false,block:null}],cursor:null,incomplete:false,watermark:'1',scanned:1,bytes:0},{blocks:[read()],cursor:null,incomplete:false,watermark:'1',scanned:1,bytes:0}])assert.throws(()=>decodeValue(query,bad),{code:'invalid_workblock_response'});
  await context.release(()=>{});
});

test('WorkBlock-only preload envelopes survive cloning and renderer decoder restores safe typed errors',async()=>{
  const {decodeWorkBlockEnvelope}=require('../desktop/workblocks.cjs');
  let bridge,reply={ok:false,error:{code:'stale_revision',commitUncertain:false,message:'/private/native/details'}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'),'utf8'),{require(){return{contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{async invoke(){return reply;}},webUtils:{}};}});
  const request=capture(req('title',{...mutation,title:null}));
  let envelope=structuredClone(await bridge.durableInvoke('/vault','admission','workblockCommand',[request]));
  assert.deepEqual(envelope,{workblocks:true,schemaVersion:1,ok:false,error:{code:'stale_revision',source:'host',commitUncertain:false}});
  assert.throws(()=>decodeWorkBlockEnvelope(request,envelope),{code:'stale_revision',source:'host',commitUncertain:false});
  reply={ok:true,result:commit(mutation.operation)};envelope=structuredClone(await bridge.durableInvoke('/vault','admission','workblockCommand',[request]));
  assert.deepEqual(decodeWorkBlockEnvelope(request,envelope),commit(mutation.operation));
  for(const bad of [undefined,{ok:false},{ok:false,error:{code:'stale_revision',commitUncertain:'false'}},{ok:false,error:{code:'unsafe /path',commitUncertain:false}}]){
    reply=bad;envelope=structuredClone(await bridge.durableInvoke('/vault','admission','workblockCommand',[request]));
    assert.throws(()=>decodeWorkBlockEnvelope(request,envelope),{code:'invalid_workblock_response',commitUncertain:true});
  }
  reply={ok:false,error:{code:'old_api',commitUncertain:false}};
  await assert.rejects(bridge.getDurableContext('/vault'),{code:'old_api'},'other durable API still rejects as before');
});

test('post-bridge decoder rejects malformed envelope/version/error metadata as mutation-uncertain',()=>{
  const {decodeWorkBlockEnvelope}=require('../desktop/workblocks.cjs'),request=capture(req('title',{...mutation,title:null}));
  const rejected={workblocks:true,schemaVersion:1,ok:false,error:{code:'stale_revision',source:'host',commitUncertain:false}};
  for(const invalid of [null,{...rejected,extra:true},{...rejected,schemaVersion:2},{...rejected,ok:0},{...rejected,error:{...rejected.error,source:'native'}},{...rejected,error:{...rejected.error,commitUncertain:undefined}},{...rejected,error:{...rejected.error,code:'x'.repeat(65)}},{...rejected,error:{...rejected.error,message:'secret'}},{workblocks:true,schemaVersion:1,ok:true,value:commit('wrong')}])assert.throws(()=>decodeWorkBlockEnvelope(request,invalid),{code:'invalid_workblock_response',commitUncertain:true});
  assert.throws(()=>decodeWorkBlockEnvelope(capture(req('read',target)),null),{code:'invalid_workblock_response',commitUncertain:false});
});
