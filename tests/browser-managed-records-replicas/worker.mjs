import {openBrowserStreamingVault} from '../../src/core/browser-streaming-vault.ts';
import {BrowserSyncWorker} from '../../src/platform/browser-sync-worker.ts';
import {claimBrowserClient} from '../../src/platform/browser-client-lease.ts';

// Dedicated fixture protocol only. Every collection/schema/operation is fixed
// here; no product Worker or public registration/authoring API is changed.
const scope={realm_id:'replica-realm',vault_id:'replica-vault'};
const owner='replica-fixture',encoder=new TextEncoder(),decoder=new TextDecoder();
const bytes=value=>encoder.encode(JSON.stringify(value));
let vault,lease,sync,closing=false,tail=Promise.resolve();
const handles=new Map();
const transactions={begun:0,strict:0,complete:0,abort:0};
const transaction=IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction=function(...args){
  const tx=transaction.apply(this,args);
  if(args[1]==='readwrite'){
    transactions.begun++;if(args[2]?.durability==='strict'&&tx.durability==='strict')transactions.strict++;
    tx.addEventListener('complete',()=>transactions.complete++,{once:true});tx.addEventListener('abort',()=>transactions.abort++,{once:true});
  }
  return tx;
};
const active=()=>{if(closing||!lease)throw new Error('Fixture worker closed');lease.assertActive();};
function local(operation){const task=tail.catch(()=>{}).then(()=>{active();return operation();});tail=task.catch(()=>{});return task;}
const policy=record=>record==='local'?'Local':record==='cache'?'Cache':'Synced';
function target(record){return {realm:scope.realm_id,vault:scope.vault_id,owner,collection:policy(record).toLowerCase(),record,generation:record+'-root',restores:null};}
const write=(field,value)=>({action:'Write',field,cell:{state:'Value',value:{type:'String',value}}});
const cases={
  'separate-root':{record:'separate',command:{command:'Create',actions:[write('left','base-left'),write('right','base-right'),write('title','base')]}},
  'separate-left':{record:'separate',command:{command:'Patch',actions:[write('left','left-offline')]}},
  'separate-right':{record:'separate',command:{command:'Patch',actions:[write('right','right-offline')]}},
  'conflict-root':{record:'conflict',command:{command:'Create',actions:[write('title','base')]}},
  'conflict-left':{record:'conflict',command:{command:'Patch',actions:[write('title','red-offline')]}},
  'conflict-right':{record:'conflict',command:{command:'Patch',actions:[write('title','blue-offline')]}},
  'race-root':{record:'race',command:{command:'Create',actions:[write('title','base')]}},
  'race-delete':{record:'race',command:{command:'Delete'}},
  'race-edit':{record:'race',command:{command:'Patch',actions:[write('title','edited-offline')]}},
  'race-after':{record:'race',command:{command:'Patch',actions:[write('title','after-delete')]}},
  'local-root':{record:'local',command:{command:'Create',actions:[write('title','local-only')]}},
  'cache-root':{record:'cache',command:{command:'Create',actions:[write('title','cache-only')]}},
};
async function snapshot(record){
  if(!['separate','conflict','race','local','cache'].includes(record))throw new Error('Unknown fixture record');
  const result=await vault.managedRecords.snapshot(handles.get(policy(record)),target(record));active();
  return {state:result.state?decoder.decode(result.state):null,projection:result.projection?decoder.decode(result.projection):null,metadata:result.metadata,unresolved:result.unresolved};
}
async function mutate(operation,expected){
  const scenario=cases[operation];if(!scenario)throw new Error('Unknown fixed fixture operation');
  const expectedRevision=expected?new Uint8Array(expected):new Uint8Array(JSON.parse((await snapshot(scenario.record)).metadata).revision);
  const result=await vault.managedRecords.apply(handles.get(policy(scenario.record)),{scope:target(scenario.record),operation,expectedRevision,command:bytes(scenario.command)});active();
  return {result:decoder.decode(result.result),replay:result.replay,localDurable:result.localDurable,expected:[...expectedRevision]};
}
async function inspect(){
  const inspected=await vault.sync.inspect(),pending=await vault.sync.pending(64);active();
  return {authorityId:vault.authorityId,cursor:inspected.cursor,pending:pending.map(row=>row.metadata.key.update_id),transactions:{...transactions}};
}
async function sealPending(){
  const pending=await vault.sync.pending(64),key=sync.recordsSession().key,result=[];
  for(const row of pending){const id=row.metadata.key.update_id,wire=await vault.sync.seal(id,key);active();result.push({id,wire:[...wire]});}
  return result;
}
async function open(input){
  if(vault||!input.name.startsWith('zorid-core-vault:replicas-'))throw new Error('Invalid fixture database');
  const wasm=await import('/target/browser-wasm/generated/zorid_wasm.js');await wasm.default();
  vault=await openBrowserStreamingVault({name:input.name,wasm,clientId:input.clientId,assertActive:active,managedRecordsSession:()=>sync?.recordsSession()});
  lease=await claimBrowserClient(navigator.locks,{vaultId:vault.authorityId,clientId:input.clientId},()=>{closing=true;sync?.revoke();vault.close();});
  await vault.validateStorage();
  sync=new BrowserSyncWorker({storage:vault.sync,wasm,assertOwner:active,local,fatal(){closing=true;vault.close();},async changed(check){check();self.postMessage({event:'durable-receive'});}});
  await sync.configure({endpoint:input.endpoint,realmId:scope.realm_id,vaultId:scope.vault_id,serverEpoch:'replica-epoch',keyEpoch:1,
    bearerToken:'synthetic-replicas-only',keyBytes:new Uint8Array(32).fill(41),allowLoopbackHttp:true,enrollEmpty:true});
  for(const policy of ['Synced','Local','Cache']){
    const fields=Object.fromEntries(['left','right','title'].map(name=>[name,{kind:'String',required:false,nullable:false,default:null}]));
    const handle=await vault.managedRecords.register({realmId:scope.realm_id,vaultId:scope.vault_id,owner,collection:policy.toLowerCase()},bytes({realm:scope.realm_id,vault:scope.vault_id,owner,schema:{collection:policy.toLowerCase(),version:1,policy,fields}}));
    handles.set(policy,handle);
  }
  return inspect();
}
async function dispatch(operation,payload){
  switch(operation){
    case 'mutate':return mutate(payload.operation,payload.expected);
    case 'snapshot':return snapshot(payload);
    case 'inspect':return inspect();
    case 'seal-pending':return sealPending();
    case 'duplicate':{
      if(!cases[payload.id])throw new Error('Unknown fixture duplicate');
      const result=await vault.sync.receive(payload.id,new Uint8Array(payload.wire),sync.recordsSession().key);active();return result;
    }
    default:throw new Error('Unknown fixture command');
  }
}
self.onmessage=({data:{id,operation,payload}})=>{
  const execute=async()=>{
    if(operation==='open')return open(payload);
    if(operation==='once'){active();return sync.once();}
    if(operation==='close'){
      closing=true;sync?.revoke();await tail;for(const handle of handles.values())handle.dispose();vault.close();await lease.release();return;
    }
    return local(()=>dispatch(operation,payload));
  };
  void execute().then(result=>self.postMessage({id,ok:true,result}),error=>self.postMessage({id,ok:false,error:{code:error?.code,message:String(error?.message??error),source:error?.source}}));
};
