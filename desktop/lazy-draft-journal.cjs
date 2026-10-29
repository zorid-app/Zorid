'use strict';
const failure=code=>Object.assign(new Error('Independent draft storage is unavailable.'),{code,commitUncertain:false});

/** Main owns a single private profile journal. Grants exist independently of
 * filesystem availability; only actual storage operations acknowledge drafts.
 * Failed opening retries on the next owned request without changing its scope.
 */
function createLazyDraftJournal(open){
  let opening,owner,closed=false;
  const wrappers=new Set();
  function opened(){
    if(closed)return Promise.reject(failure('draft_lease_revoked'));
    if(!opening){
      const pending=Promise.resolve().then(open).then(value=>{owner=value;return value;}).catch(()=>{if(opening===pending)opening=undefined;throw failure('draft_storage_failure');});
      opening=pending;
    }
    return opening;
  }
  return Object.freeze({
    bind(scope,assertOwner){
      const bound=Object.freeze({...scope});let revoked=false,lease;
      const check=()=>{if(closed||revoked)throw failure('draft_lease_revoked');const valid=assertOwner();if(valid===false)throw failure('draft_lease_revoked');if(valid&&typeof valid.then==='function'){Promise.resolve(valid).catch(()=>{});throw failure('invalid_draft_owner_check');}};
      check();
      const revoke=()=>{revoked=true;lease?.revoke();wrappers.delete(revoke);};wrappers.add(revoke);
      async function run(method,args){
        check();
        // Copy small metadata layers before opening can yield. Body strings are
        // immutable and stay shared, without serialization or hashing here.
        const captured=args.map(value=>value&&typeof value==='object'?{...value,...(value.baseline?{baseline:{...value.baseline}}:{})}:value);
        const journal=await opened();check();
        if(!lease)lease=journal.bind(bound,check);
        check();const value=await lease[method](...captured);
        try{check();}catch(error){if(method==='compareAndSwap'||method==='retire')error.commitUncertain=true;throw error;}
        return value;
      }
      return Object.freeze({scope:bound,revoke,
        list:(...args)=>run('list',args),read:value=>run('read',[value]),compareAndSwap:value=>run('compareAndSwap',[value]),retire:value=>run('retire',[value])});
    },
    async close(){closed=true;for(const revoke of [...wrappers])revoke();await opening?.catch(()=>{});await owner?.close();},
  });
}
module.exports={createLazyDraftJournal};
