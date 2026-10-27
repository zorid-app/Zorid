'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');
const {captureDatabaseRequest:capture,decodeDatabaseReply:decode,decodeDatabaseEnvelope,validateDatabaseValue,MAX_DATABASE_REQUEST,MAX_DATABASE_RESPONSE}=require('../desktop/databases.cjs');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {admitDesktopFixtureClient}=require('../desktop/client-admission.cjs');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const clientId='10000000-0000-4000-8000-000000000001',revision='20000000-0000-4000-8000-000000000001';
const collectionId='books0000001',fieldId='rating000001';
const req=(op,fields={})=>({schemaVersion:1,command:{op,...fields}});
const collection=()=>({id:collectionId,name:'Books',revision,deleted:false,properties:[{id:fieldId,name:'Rating',datatype:'number',options:[]}]});
const entry=()=>({entryId:'entry',collectionId,revision,fileRevision:revision,path:'Books/A.md',values:{[fieldId]:4},deleted:false,pendingProjection:false});
const snapshot=(op='get')=>({collections:[collection()],entries:op==='list'?[]:[entry()],projection:{pending:0,issues:[]}});
const wire=(op,value)=>{const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op,value}));return{result:{databases:true,schemaVersion:1,bytes:bytes.length},bytes};};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function fixture(){
 const host=Object.create(RustVaultService.prototype),calls=[];host.capabilities=['databases'];let owner=true,active=true,gate=null,notified=0;
 const lease={local_store_id:'store',client_id:clientId,token:revision};
 host.request=async(command,bytes,reference)=>{
  calls.push({command:structuredClone(command),bytes:bytes&&Buffer.from(bytes)});
  if(command.method==='claim_client'){active=true;return{result:{lease}};}
  if(command.method==='release_client'){active=false;return{result:{released:true,reference:command.reference}};}
  assert.deepEqual(reference,lease);assert.equal(active,true);
  if(command.method==='identity')return{result:{identity:{local_store_id:'store',realm_id:null,vault_id:null}},bytes:new Uint8Array()};
  assert.equal(command.method,'database_request');assert.equal(command.request.bytes,bytes.length);
  if(gate)await gate.promise;const request=JSON.parse(bytes.toString());return wire(request.command.op,snapshot(request.command.op));
 };
 const service={host,closed:false,root:'/vault',subscribe:()=>()=>{},databaseChanged(){notified++;},async close(){this.closed=true;}};
 return{host,service,calls,options:{fixture:true,clientId,assertOwner(){if(!owner)throw Object.assign(new Error('revoked'),{code:'grant_retired'});}},set owner(v){owner=v;},set gate(v){gate=v;},get active(){return active;},get notified(){return notified;}};
}

test('captures inert bounded requests, preserves identities and excludes import/move authority',()=>{
 const input=req('create',{operationId:'original',name:'Books',properties:[{name:'Labels',datatype:'multi-select',options:[{name:'One'}]}]}),copy=capture(input);
 input.command.operationId='changed';input.command.properties[0].name='Other';assert.equal(copy.command.operationId,'original');assert.equal(copy.command.properties[0].name,'Labels');
 let gets=0;const getter=req('create',{operationId:'op',name:'Books'});Object.defineProperty(getter.command,'properties',{enumerable:true,get(){gets++;return[];}});assert.throws(()=>capture(getter),{code:'invalid_database_request'});assert.equal(gets,0);
 const cyclic=req('create',{operationId:'op',name:'Books'});cyclic.command.properties=cyclic;
 for(const invalid of [cyclic,req('assign',{entryId:'entry',collectionId}),req('move',{entryId:'entry',collectionId}),req('import',{}),req('__proto__',{}),req('get',{collectionId:'wrong'}),req('create',{operationId:'op',name:'\ud800'}),req('create_entry',{operationId:'op',collectionId,expectedCollectionRevision:revision,entryId:'entry',path:'.zorid/vault.sqlite'}),req('set_entry',{operationId:'op',entryId:'entry',expectedRevision:revision,expectedCollectionRevision:revision,values:{[fieldId]:Infinity}})])assert.throws(()=>capture(invalid),error=>Boolean(error.code));
 const command=req('create_entry',{operationId:'op',collectionId,expectedCollectionRevision:revision,entryId:'entry',path:'A.md',body:'x'.repeat(2*1024*1024)});assert.equal(capture(command).command.body.length,2*1024*1024,'body is not constrained to control-header size');
 assert.throws(()=>capture({...command,command:{...command.command,body:'x'.repeat(MAX_DATABASE_REQUEST)}}),{code:'database_request_limit'});
});

test('snapshot reply is scoped and retains publication pending/issues independently of local commit',()=>{
 const request=capture(req('get',{collectionId})),pending=snapshot();pending.entries[0].pendingProjection=true;pending.projection={pending:1,issues:[{entryId:'entry',message:'External file changed'}]};
 const w=wire('get',pending);assert.deepEqual(decode(request,w.result,w.bytes),pending);
 const problems={...snapshot(),entries:[{...entry(),problems:{[fieldId]:'Value must be corrected'}}]};assert.equal(validateDatabaseValue(request,problems).entries[0].problems[fieldId],'Value must be corrected');
 for(const bad of [{...pending,entries:[{...entry(),collectionId:'other0000001'}]},{...pending,collections:[{...collection(),id:'other0000001'}]},{...pending,collections:[collection(),collection()]},{...pending,entries:[entry(),entry()]},{...pending,projection:{pending:1,issues:[{message:5}]}}])assert.throws(()=>validateDatabaseValue(request,bad),{code:'invalid_database_response',commitUncertain:false});
 for(const [marker,bytes]of[[{...w.result,extra:true},w.bytes],[{...w.result,bytes:MAX_DATABASE_RESPONSE+1},w.bytes],[w.result,Buffer.from([255])],[w.result,Buffer.from('{}')]])assert.throws(()=>decode(request,marker,bytes),{code:'invalid_database_response'});
 const composing=req('compose',{entryId:'entry',expectedRevision:revision,baseline:'before',proposed:'after'}),composed={...snapshot(),composition:{content:'canonical',currentSource:'before',currentFileRevision:revision,entryRevision:revision,collectionRevision:revision}};
 assert.equal(validateDatabaseValue(capture(composing),composed).composition.content,'canonical');assert.throws(()=>validateDatabaseValue(request,composed),{code:'invalid_database_response'});
});

test('admission exposes only advertised database capability, snapshots args, drains and fences late mutation replies',async()=>{
 const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);assert.equal(typeof context.databaseCommand,'function');
 const gate=deferred();f.gate=gate;
 const input=req('set_entry',{operationId:'same-operation',entryId:'entry',expectedRevision:revision,expectedCollectionRevision:revision,values:{[fieldId]:5}}),pending=context.databaseCommand(input);
 input.command.operationId='other';input.command.values[fieldId]=1;
 const sent=JSON.parse(f.calls.at(-1).bytes.toString());assert.equal(sent.command.operationId,'same-operation');assert.equal(sent.command.values[fieldId],5);
 let flushed=false;const closing=context.release(()=>{flushed=true;});await assert.rejects(context.databaseCommand(req('list')),{code:'client_not_admitted'});assert.equal(flushed,false);gate.resolve();await pending;await closing;assert.equal(f.notified,1);assert.equal(f.active,false);
 f.gate=null;const second=await admitDesktopFixtureClient(f.service,f.options),late=deferred();f.gate=late;const stale=second.databaseCommand(req('set_entry',{operationId:'op',entryId:'entry',expectedRevision:revision,expectedCollectionRevision:revision,values:{[fieldId]:5}}));f.owner=false;late.resolve();await assert.rejects(stale,{code:'client_ownership_lost',commitUncertain:true});await second.retire();
 const old=fixture();old.host.capabilities=[];const absent=await admitDesktopFixtureClient(old.service,old.options);assert.equal(absent.databaseCommand,undefined);await absent.retire();
});

test('queued native transport snapshots request body and rechecks lease before sending',async()=>{
 const host=Object.create(RustVaultService.prototype),gate=deferred(),frames=[];Object.assign(host,{capabilities:['databases'],sequence:0n,queuedCount:0,queuedBytes:0,tail:gate.promise,ready:Promise.resolve(),child:{stdin:{write:bytes=>frames.push(bytes)}},expect(){assert.fail('revoked dispatch');}});
 let owner=true;const scoped=host.withClientLease({local_store_id:'store',client_id:clientId,token:revision},()=>{if(!owner)throw Object.assign(new Error('revoked'),{code:'client_not_admitted'});});
 const pending=scoped.databaseCommand(clientId,req('delete',{operationId:'op',collectionId,expectedRevision:revision}));owner=false;gate.resolve();await assert.rejects(pending,{code:'client_not_admitted'});await host.tail;assert.deepEqual(frames,[]);assert.equal(host.queuedCount,0);
});

test('framed native receiver bounds body and rejects mismatched reply op or lost acknowledgement as uncertain',async()=>{
 for(const mode of['valid','oversize','wrong-op','lost']){
  const host=Object.create(RustVaultService.prototype),request=capture(req('delete',{operationId:'op',collectionId,expectedRevision:revision})),body=Buffer.from(JSON.stringify(request)),command={method:'database_request',client_id:clientId,request:{schemaVersion:1,bytes:body.length}};
  Object.assign(host,{timeoutMs:1000,prefix:Buffer.alloc(8),prefixUsed:0,frameUsed:0,child:{stdin:{destroy(){}},stdout:{destroy(){}},kill(){}},exited:true});
  const pending=host.expect('1',command,body);
  if(mode==='lost')host.abort(Object.assign(new Error('lost'),{code:'host_exited',commitUncertain:true}));
  else{const w=wire(mode==='wrong-op'?'restore':'delete',snapshot()),header=Buffer.from(JSON.stringify({version:1,request_id:'1',ok:true,result:w.result})),prefix=Buffer.alloc(8);prefix.writeUInt32BE(header.length);prefix.writeUInt32BE(mode==='oversize'?MAX_DATABASE_RESPONSE+1:w.bytes.length,4);host.receive(mode==='oversize'?prefix:Buffer.concat([prefix,header,w.bytes]));}
  if(mode==='valid')assert.equal((await pending).result.databases,true);else await assert.rejects(pending,error=>error.commitUncertain===true);
 }
});

test('preload preserves plain database errors across contextBridge, including transport uncertainty',async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../desktop/preload.cjs'),'utf8');let bridge,reply={ok:false,error:{code:'database_conflict',commitUncertain:false}},lost=false;
 vm.runInNewContext(source,{require(name){assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{invoke:async()=>{if(lost)throw new Error('lost');return reply;},on(){},removeListener(){}},webUtils:{}};}});
 let value=await bridge.durableInvoke('/vault','admission','databaseCommand',[req('list')]);assert.equal(value.databases,true);assert.equal(value.error.code,'database_conflict');assert.equal(value.error.commitUncertain,false);
 lost=true;value=await bridge.durableInvoke('/vault','admission','databaseCommand',[req('list')]);assert.equal(value.error.code,'database_transport_lost');assert.equal(value.error.commitUncertain,true);
 assert.throws(()=>decodeDatabaseEnvelope(req('list'),structuredClone(value)),{code:'database_transport_lost',commitUncertain:true});
});

test('real editor-core manager admits databases but fences other roots, windows and stale admissions',async()=>{
 const f=fixture(),filename=path.resolve(__dirname,'../desktop/editor-core.cjs'),nativeRequire=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,structuredClone,require(name){if(name==='node:fs/promises')return{realpath:async value=>value};if(name==='./vault-service.cjs')return{VaultService:{open:async()=>f.service}};if(name==='./host-location.cjs')return{resolveDesktopHost:async()=>'/trusted/host'};return nativeRequire(name);}});
 const manager=module.exports.createEditorCoreManager({}),broker=new WindowBroker({openVault:p=>manager.open(p),allowedURL:url=>url==='app://trusted'}),sender={id:1,isDestroyed:()=>false,mainFrame:{url:'app://trusted'}},window={webContents:sender,isDestroyed:()=>false};
 const record=broker.register(window);record.clientSlot={clientId};await broker.select(record,'/vault');record.persistedVaultRoot='/vault';const context=await manager.context(broker,record,'/vault'),event={sender,senderFrame:sender.mainFrame};assert.equal(context.databases,true);
 assert.equal((await manager.invoke(broker,record,event,'/vault',context.admissionId,'databaseCommand',[req('list')])).collections[0].id,collectionId);
 await assert.rejects(manager.invoke(broker,record,event,'/other',context.admissionId,'databaseCommand',[req('list')]));await assert.rejects(manager.invoke(broker,record,event,'/vault','stale','databaseCommand',[req('list')]));
 await manager.release(broker,record,event,'/vault',context.admissionId);await assert.rejects(manager.invoke(broker,record,event,'/vault',context.admissionId,'databaseCommand',[req('list')]));await manager.close();
});


test('packaged desktop includes the database boundary required by the native service',async()=>{
 const {desktopFiles}=await import('../scripts/stage-desktop.mjs');assert.ok(desktopFiles.includes('desktop/databases.cjs'));
});


test('safe collection errors use static domain messages and keep mutation uncertainty',()=>{
 const request=req('create',{operationId:'op',name:'Books'});
 for(const [code,fragment]of[
  ['collection_name_taken','Choose another name'],['collection_invalid_name','reserved characters'],['collection_stale','Refresh it'],
  ['collection_invalid_value','Correct the value'],['collection_not_found','no longer available'],['collection_deleted','Restore it'],
  ['collection_property_name_taken','unique name'],['collection_option_name_taken','unique label'],['collection_source_conflict','draft was kept'],
  ['invalid_mutation','Check the name'],['new_unknown_host_code','Refresh the collection'],['__proto__','Refresh the collection'],
 ]){
  const envelope={databases:true,schemaVersion:1,ok:false,error:{code,source:'host',commitUncertain:false}};
  assert.throws(()=>decodeDatabaseEnvelope(request,envelope),error=>error.code===code&&error.commitUncertain===false&&error.message.includes(fragment));
 }
 const envelope={databases:true,schemaVersion:1,ok:false,error:{code:'collection_name_taken',source:'host',commitUncertain:true}};
 assert.throws(()=>decodeDatabaseEnvelope(request,envelope),error=>error.code==='collection_name_taken'&&error.commitUncertain===true&&error.message.includes('retry this change rather than submitting a new one')&&!error.message.includes('Choose another name'));
});

test('preload ignores arbitrary native collection diagnostics instead of showing their paths or source',async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../desktop/preload.cjs'),'utf8');let bridge;
 const secret='PRIVATE /Users/someone/vault/secret.md '+ 'content'.repeat(20000);
 vm.runInNewContext(source,{require(name){assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},ipcRenderer:{invoke:async()=>({ok:false,error:{code:'collection_name_taken',commitUncertain:false,message:secret,path:secret,source:secret}}),on(){},removeListener(){}},webUtils:{}};}});
 const envelope=structuredClone(await bridge.durableInvoke('/vault','admission','databaseCommand',[req('create',{operationId:'op',name:'Books'})]));
 assert.deepEqual(Object.keys(envelope.error).sort(),['code','commitUncertain','source']);
 assert.throws(()=>decodeDatabaseEnvelope(req('create',{operationId:'op',name:'Books'}),envelope),error=>error.code==='collection_name_taken'&&error.message.includes('Choose another name')&&!error.message.includes('PRIVATE')&&!error.message.includes('/Users/'));
});
