// Test-build replacement ONLY. The product registry exports an empty list.
export const browserManagedRecordConsumers = Object.freeze([{
  owner:'host-fixture',collection:'lifecycle',
  registration(scope){
    self.postMessage({event:'fixture-registration'});
    return new TextEncoder().encode(JSON.stringify({realm:scope.realm_id,vault:scope.vault_id,owner:'host-fixture',
      schema:{collection:'lifecycle',version:1,policy:'Synced',fields:{title:{kind:'String',required:false,nullable:false,default:null}}}}));
  },
  changed(changes){self.postMessage({event:'fixture-durable-changes',changes});},
}]);
