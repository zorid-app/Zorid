'use strict';
const failure=code=>Object.assign(new Error('Independent draft storage is unavailable.'),{code,commitUncertain:false});

/** Main owns a single private profile journal. Grants exist independently of
 * filesystem availability; only actual storage operations acknowledge drafts.
 * Failed opening retries on the next owned request without changing its scope.
 */
function createLazyDraftJournal(open,{clock={now:Date.now,setTimeout,clearTimeout},onMaintenanceError}={}){
  let opening,owner,closed=false,closing;
  const wrappers=new Set();
  let timer,timerEpoch=0,foreground=0,lastActivity=0,graceUntil=Infinity,nextUnitAt=0;
  let cleanupEpoch=0,completedEpoch=0,passEpoch,maintenance,blocked=false;
  const cancelTimer=()=>{timerEpoch++;if(timer!==undefined){clock.clearTimeout(timer);timer=undefined;}};
  const diagnostic=errors=>{try{onMaintenanceError?.(errors.slice(0,8).map(code=>typeof code==='string'&&/^(?:draft_|invalid_draft_)[a-z_]{1,64}$/.test(code)?code:'draft_storage_failure'));}catch{/* Diagnostics never fail journal operations. */}};
  function arm(){
    cancelTimer();
    if(closed||!owner||typeof owner.maintain!=='function'||foreground||maintenance||blocked||cleanupEpoch<=completedEpoch)return;
    const epoch=timerEpoch,delay=Math.max(0,graceUntil-clock.now(),lastActivity+250-clock.now(),nextUnitAt-clock.now());
    timer=clock.setTimeout(()=>{if(epoch!==timerEpoch||closed)return;timer=undefined;runMaintenance();},delay);timer?.unref?.();
  }
  function activity(){lastActivity=clock.now();blocked=false;arm();}
  function wake(){if(closed)return;cleanupEpoch++;activity();}
  function runMaintenance(){
    if(closed||foreground||maintenance||blocked||clock.now()<Math.max(graceUntil,lastActivity+250,nextUnitAt)){arm();return;}
    // A revoke may make an already-scanned branch eligible. Complete only the
    // epoch at PASS start, then coalesce all midpass wakes into one fresh pass.
    if(passEpoch===undefined)passEpoch=cleanupEpoch;
    const started=passEpoch;
    let pending;try{pending=owner.maintain({maxUnits:1});}catch(error){pending=Promise.reject(error);}
    maintenance=Promise.resolve(pending).then(result=>{
      if(closed)return;
      if(!result||![0,1].includes(result.examined)||![0,1].includes(result.removed)||typeof result.done!=='boolean'||!Array.isArray(result.errors)||result.errors.length>8)throw failure('draft_storage_failure');
      if(result.errors.length){blocked=true;diagnostic(result.errors);}
      else if(result.done){completedEpoch=started;passEpoch=undefined;}
    }).catch(error=>{if(!closed){blocked=true;diagnostic([error?.code]);}}).finally(()=>{maintenance=undefined;nextUnitAt=clock.now()+25;arm();});
  }
  function opened(){
    if(closed)return Promise.reject(failure('draft_lease_revoked'));
    if(!opening){
      const pending=Promise.resolve().then(open).then(value=>{owner=value;if(!closed){graceUntil=clock.now()+5000;wake();}return value;}).catch(()=>{if(opening===pending)opening=undefined;throw failure('draft_storage_failure');});
      opening=pending;
    }
    return opening;
  }
  return Object.freeze({
    bind(scope,assertOwner){
      const bound=Object.freeze({...scope});let revoked=false,lease;
      const check=()=>{if(closed||revoked)throw failure('draft_lease_revoked');const valid=assertOwner();if(valid===false)throw failure('draft_lease_revoked');if(valid&&typeof valid.then==='function'){Promise.resolve(valid).catch(()=>{});throw failure('invalid_draft_owner_check');}};
      check();
      const revoke=()=>{if(revoked)return;revoked=true;lease?.revoke();wrappers.delete(revoke);wake();};wrappers.add(revoke);
      async function run(method,args){
        check();foreground++;activity();
        try{
        // Copy small metadata layers before opening can yield. Body strings are
        // immutable and stay shared, without serialization or hashing here.
        const captured=args.map(value=>value&&typeof value==='object'?{...value,...(value.baseline?{baseline:{...value.baseline}}:{})}:value);
        const journal=await opened();check();
        if(!lease)lease=journal.bind(bound,check);
        check();const value=await lease[method](...captured);
        try{check();}catch(error){if(method==='compareAndSwap'||method==='retire')error.commitUncertain=true;throw error;}
        return value;
        }finally{foreground--;activity();}
      }
      return Object.freeze({scope:bound,revoke,
        list:(...args)=>run('list',args),read:value=>run('read',[value]),compareAndSwap:value=>run('compareAndSwap',[value]),retire:value=>run('retire',[value])});
    },
    close(){
      if(closing)return closing;
      closed=true;cancelTimer();for(const revoke of [...wrappers])revoke();const issued=maintenance;
      closing=(async()=>{await opening?.catch(()=>{});await issued;await owner?.close();})();return closing;
    },
  });
}
module.exports={createLazyDraftJournal};
