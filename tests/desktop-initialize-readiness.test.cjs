'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');

const capabilities=['read_path','list_snapshot','changes_after','rescan','prepare_intent','commit_intent','query_intent','list_intents','acknowledge_intent','local_family_status','reconciliation_status'];
function fixture(t,{missing,helloFailure,initializeLocal=true}={}){
  const calls=[],watchers=[];
  const localStatus={scope:{realm_id:'local-realm',vault_id:'local-vault'},pending_projection:'0'};
  const host={
    root:'/unused-initialize-readiness',capabilities:[...capabilities,'fixture_family_status'],
    reconciliation:{complete:true,scanComplete:true,finished:true},
    async localFamilyStatus(){calls.push('local-status');return localStatus;},
    async fixtureFamilyStatus(){calls.push('fixture-status');return localStatus;},
    async listSnapshot(){calls.push('snapshot');return{entries:[],cursor:'0'};},
    async rescan(){calls.push('rescan');return{finished:true,complete:true};},
    async close(){calls.push('host-close');},
  };
  if(missing==='reconciliation')delete host.reconciliation;
  else if(missing)host.capabilities=host.capabilities.filter(value=>value!==missing);
  const original=RustVaultService.open;
  RustVaultService.open=async(root,options)=>{
    calls.push('host-open');assert.equal(root,host.root);assert.equal(options.initializeLocal,initializeLocal);
    if(helloFailure)throw helloFailure;
    return host;
  };
  let service;
  t.after(async()=>{try{await service?.close();}finally{RustVaultService.open=original;}});
  return{host,calls,watchers,localStatus,async open(){
    service=await CoreVaultFixtureService.open(host.root,{
      fixture:true,familyMode:true,initializeLocal,documentRuntime:false,
      watchRootIdentity:async path=>({path,identity:'stable-root-identity'}),
      watchFactory(root,options,callback){
        assert.equal(root,host.root);assert.equal(options.recursive,true);
        calls.push('watch');const watcher=new EventEmitter();watcher.callback=callback;watcher.closed=false;
        watcher.close=()=>{watcher.closed=true;calls.push('watch-close');watcher.emit('close');};
        watchers.push(watcher);return watcher;
      },
    });
    return service;
  }};
}

test('initialized local startup uses admitted hello readiness without a full status RPC; explicit status remains available',async t=>{
  const f=fixture(t),service=await f.open();
  assert.equal(f.calls.filter(call=>call==='local-status').length,0,'initializeLocal must not request unused full status');
  assert.deepEqual(f.calls,['watch','host-open','snapshot']);
  assert.equal(service.host,f.host);assert.equal(service.familyMode,true);assert.equal(service.documentRuntimeEnabled,false);
  assert.deepEqual(service.reconciliation,f.host.reconciliation);assert.equal(service.cursor,'0');
  assert.equal(await service.host.localFamilyStatus(),f.localStatus);
  assert.equal(f.calls.filter(call=>call==='local-status').length,1,'explicit status API still makes its requested RPC');
  assert.equal(f.calls.includes('fixture-status'),false);assert.equal(f.calls.includes('rescan'),false);
  await service.close();assert.equal(f.watchers[0].closed,true);assert.equal(f.calls.filter(call=>call==='host-close').length,1);
});

for(const missing of ['local_family_status','reconciliation_status','reconciliation']){
  test(`initialized local startup still fails closed without ${missing}`,async t=>{
    const f=fixture(t,{missing});
    await assert.rejects(f.open(),reason=>reason?.code==='unsupported_host_capability');
    assert.deepEqual(f.calls,['watch','host-open','watch-close','host-close']);
    assert.equal(f.watchers.length,1);assert.equal(f.watchers[0].closed,true);
  });
}

test('a rejected native hello propagates unchanged and closes the pre-startup watcher without a fallback scan',async t=>{
  const reason=Object.assign(Error('synthetic rejected hello'),{code:'invalid_response'});
  const f=fixture(t,{helloFailure:reason});
  await assert.rejects(f.open(),actual=>actual===reason);
  assert.deepEqual(f.calls,['watch','host-open','watch-close']);
  assert.equal(f.watchers.length,1);assert.equal(f.watchers[0].closed,true);
});

test('legacy family fixture startup still requests fixture status through its existing branch',async t=>{
  const f=fixture(t,{initializeLocal:false});
  f.host.capabilities=f.host.capabilities.filter(value=>value!=='local_family_status'&&value!=='reconciliation_status');
  delete f.host.reconciliation;
  const service=await f.open();
  assert.deepEqual(f.calls,['watch','host-open','fixture-status','snapshot']);
  assert.equal(service.reconciliation,null);
  assert.equal(f.calls.includes('local-status'),false);assert.equal(f.calls.includes('rescan'),false);
});
