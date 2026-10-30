import type {CheckpointScope} from '../core/durable-checkpoints.ts';

export interface CaptureRequestClaim {release():void}
export interface CaptureRequestCleanup {
  /** Seal immediately before Native release, without an intervening await. */
  seal():boolean;
  owns():boolean;
  settled():void;
  release():Promise<void>;
  admissionAvailable():void;
  finish():void;
}
interface Reservation {contended:boolean;sealed:boolean;failed:boolean;done:Promise<void>;resolve:()=>void;reject:(error:Error)=>void;task?:Promise<void>}
interface Entry {claims:Map<object,CaptureRequestClaim>;reservation?:Reservation;released:boolean}
const scopes=new Map<string,Map<string,Entry>>();
// Only unsettled sealed releases are enumerated; terminal history is never scanned.
const outstanding=new Map<string,Map<string,CaptureRequestCleanup>>();
const key=(scope:CheckpointScope)=>JSON.stringify([scope.vaultId,scope.clientId]);
const failure=(code:string,wait?:Promise<void>)=>Object.assign(new Error('The saved-source request is reserved for exact cleanup.'),{code,...(wait?{wait}:{})});
function lane(scope:CheckpointScope):Map<string,Entry>{const id=key(scope);let value=scopes.get(id);if(!value){value=new Map();scopes.set(id,value);}return value;}
function forget(scope:CheckpointScope,id:string,entries:Map<string,Entry>,entry:Entry):void {
  if(!entry.released&&!entry.claims.size&&!entry.reservation&&entries.get(id)===entry){entries.delete(id);if(!entries.size)scopes.delete(key(scope));}
}

/** Note actors share request ownership, never source authority. A contender
 * during proof invalidates cleanup. A sealed release stays fenced through an
 * uncertain ACK, with one retained exact release continuation and no recapture.
 */
export function claimCaptureRequest(scope:CheckpointScope,id:string,owner:object):CaptureRequestClaim {
  const entries=lane(scope);let entry=entries.get(id);
  if(!entry){entry={claims:new Map(),released:false};entries.set(id,entry);}
  if(entry.released)throw failure('capture_request_released');
  if(entry.reservation){
    if(entry.reservation.failed)throw failure('capture_cleanup_unsettled');
    if(!entry.reservation.sealed)entry.reservation.contended=true;
    throw failure('capture_cleanup_pending',entry.reservation.done);
  }
  const existing=entry.claims.get(owner);if(existing)return existing;
  const selected=entry;let live=true;
  const claim={release:()=>{if(!live)return;live=false;selected.claims.delete(owner);forget(scope,id,entries,selected);}};
  entry.claims.set(owner,claim);return claim;
}
export function reserveCaptureRequestCleanup(scope:CheckpointScope,id:string,release?:()=>Promise<void>,admission?:()=>void):CaptureRequestCleanup|undefined {
  const entries=lane(scope);let entry=entries.get(id);
  if(!entry){entry={claims:new Map(),released:false};entries.set(id,entry);}
  if(entry.released||entry.claims.size||entry.reservation)return;
  if((outstanding.get(key(scope))?.size??0)>=8){forget(scope,id,entries,entry);return;}
  let resolve!:()=>void,reject!:(error:Error)=>void;
  const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
  const reservation:Reservation={contended:false,sealed:false,failed:false,done,resolve,reject};
  entry.reservation=reservation;const selected=entry,scopeKey=key(scope);
  const owns=()=>entries.get(id)===selected&&selected.reservation===reservation&&!reservation.contended&&!selected.claims.size&&!selected.released;
  const owner:CaptureRequestCleanup={owns,admissionAvailable:()=>{try{admission?.();}catch{/* A stale bound owner cannot receive an admission grant. */}},
    seal:()=>{if(!owns())return false;let jobs=outstanding.get(scopeKey);if(!jobs){jobs=new Map();outstanding.set(scopeKey,jobs);}if(!jobs.has(id)&&jobs.size>=8)return false;reservation.sealed=true;jobs.set(id,owner);return true;},
    settled:()=>{if(!reservation.sealed||!owns())throw failure('capture_cleanup_owner_changed');selected.released=true;},
    release:()=>{
      if(reservation.task)return reservation.task;
      if(!reservation.sealed||!owns()||!release)return Promise.reject(failure('capture_cleanup_owner_changed'));
      const task=(async()=>{try{await release();owner.settled();owner.finish();}catch(error){owner.finish();throw error;}})();reservation.task=task;
      void task.finally(()=>{if(reservation.task===task)reservation.task=undefined;}).catch(()=>{});return task;
    },
    finish:()=>{
      if(selected.reservation!==reservation)return;
      // An escaped protocol/unknown failure can follow an accepted Native release.
      // Keep its seal and original callback even if pending discovery is now empty.
      if(reservation.sealed&&!selected.released){reservation.failed=true;reservation.reject(failure('capture_cleanup_unsettled'));return;}
      selected.reservation=undefined;const jobs=outstanding.get(scopeKey);jobs?.delete(id);if(jobs&&!jobs.size)outstanding.delete(scopeKey);
      reservation.resolve();forget(scope,id,entries,selected);
    }};
  return owner;
}
export async function retryCaptureRequestCleanups(scope:CheckpointScope):Promise<void>{
  for(const owner of [...(outstanding.get(key(scope))?.values()??[])])try{await owner.release();}catch{/* Exact release remains sealed and retryable. */}
}

/** Only a positively admitted same-scope owner may route this event. A routine
 * cleanup retry does not grant admission to an already waiting IO supervisor. */
export function captureRequestCleanupAdmissionAvailable(scope:CheckpointScope):void {
  for(const owner of [...(outstanding.get(key(scope))?.values()??[])]){owner.admissionAvailable();void owner.release().catch(()=>{});}
}
