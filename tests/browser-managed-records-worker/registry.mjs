// Test-build replacement ONLY. The product registry exports an empty list.
// Hold one REAL abortable IDB transaction to observe release while a durable
// candidate is in flight. This changes scheduling only, never admission/results.
const put=IDBObjectStore.prototype.put;
let held=false;
IDBObjectStore.prototype.put=function(...args){
  const request=put.apply(this,args);
  if(!held&&this.name==='managed_records'&&args[0]?.record==='drain'){
    held=true;const tx=this.transaction;
    request.addEventListener('success',()=>{
      const until=Date.now()+120;
      const pulse=()=>{if(Date.now()>=until)return;try{const next=tx.objectStore('control').get('local-store-id');next.addEventListener('success',pulse,{once:true});}catch{}};
      pulse();self.postMessage({event:'fixture-held-write'});
    },{once:true});
    tx.addEventListener('complete',()=>self.postMessage({event:'fixture-held-finished',outcome:'complete'}),{once:true});
    tx.addEventListener('abort',()=>self.postMessage({event:'fixture-held-finished',outcome:'abort'}),{once:true});
  }
  return request;
};
export const browserManagedRecordConsumers = Object.freeze([{
  owner:'host-fixture',collection:'lifecycle',
  registration(scope){
    self.postMessage({event:'fixture-registration'});
    return new TextEncoder().encode(JSON.stringify({realm:scope.realm_id,vault:scope.vault_id,owner:'host-fixture',
      schema:{collection:'lifecycle',version:1,policy:'Synced',fields:{title:{kind:'String',required:false,nullable:false,default:null}}}}));
  },
  changed(changes){self.postMessage({event:'fixture-durable-changes',changes});},
}]);
