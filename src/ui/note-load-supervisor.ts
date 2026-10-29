const delays=[500,1500,4000,30_000] as const;
const transientHostCodes=new Set(['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout']);
const admissionCodes=new Set(['host_exited','client_not_admitted','client_ownership_lost','desktop_recovery_pending','desktop_recovery_stale_reply']);
const cancelled=()=>Object.assign(new Error('The note load owner was cancelled.'),{code:'note_load_cancelled'});
const own=(value:object,key:string):unknown=>{const field=Object.getOwnPropertyDescriptor(value,key);return field&&Object.hasOwn(field,'value')?field.value:undefined;};
function disposition(error:unknown):'transient'|'admission'|undefined {
  const seen=new Set<unknown>();
  for(let depth=0;depth<8;depth++){
    if(!error||typeof error!=='object'||seen.has(error))return;
    seen.add(error);
    const causeField=Object.getOwnPropertyDescriptor(error,'cause');
    if('cause'in error&&(!causeField||!Object.hasOwn(causeField,'value')))return;
    const code=own(error,'code'),source=own(error,'source'),cause=own(error,'cause');
    // Vault's one recognized wrapper preserves the original commit failure.
    // Unknown wrappers and protocol/foreign provenance cannot authorize retry.
    if(code==='outcome_unknown'&&source==='host'&&cause!==undefined){error=cause;continue;}
    if(cause!==undefined)return;
    if(source==='host'&&typeof code==='string'){
      if(transientHostCodes.has(code))return 'transient';
      if(admissionCodes.has(code))return 'admission';
    }
    if(source==='transport'&&code==='durable_transport_lost')return 'transient';
    return;
  }
}
export interface NoteLoadRunOptions {
  readonly signal?:AbortSignal;
  readonly onError?:(error:unknown)=>void;
  readonly onSuccess?:()=>void;
}
interface Run {
  aborted:boolean;retrying:boolean;cancel:()=>void;
  waiting?:{kind:'transient'|'admission';finish:()=>void;timer?:ReturnType<typeof setTimeout>};
}

/** Retries ONE exact IO closure, never its surrounding load/reconciliation.
 * Callers capture immutable request identities and retain the original async
 * continuation. This helper neither observes storage nor claims a new lease.
 * `validate` is synchronous owner validation and runs outside retry policy.
 * A positive, same-scope admission owner alone may call admissionAvailable().
 * Retirement errors wait for that event without timers or health probes.
 */
export class NoteLoadSupervisor {
  private active?:Run;
  private stopped=false;
  private admissionWitness={};
  get pending():boolean{return !this.stopped&&!this.active?.aborted&&!!this.active?.retrying;}
  stop():void{this.stopped=true;this.active?.cancel();}
  wake():void{if(this.active?.waiting?.kind==='transient')this.active.waiting.finish();}
  admissionAvailable():void{
    if(this.stopped)return;
    this.admissionWitness={};
    if(this.active?.waiting?.kind==='admission')this.active.waiting.finish();
  }
  run<T>(operation:()=>Promise<T>,validate:()=>void=()=>{},options:NoteLoadRunOptions={}):Promise<T>{
    if(this.stopped||options.signal?.aborted)return Promise.reject(cancelled());
    if(this.active)return Promise.reject(Object.assign(new Error('A note IO continuation is already running.'),{code:'note_load_in_progress'}));
    let rejectCancellation!:(error:Error)=>void;
    const cancellation=new Promise<never>((_resolve,reject)=>{rejectCancellation=reject;});
    // Cancellation can arrive between an IO result and installing its wait.
    // Every abandoned/late IO is observed by race, including late rejection.
    void cancellation.catch(()=>{});
    const active:Run={aborted:false,retrying:false,cancel:()=>{if(!active.aborted){active.aborted=true;rejectCancellation(cancelled());}}};
    this.active=active;
    const check=()=>{if(this.stopped||active.aborted||options.signal?.aborted)throw cancelled();validate();};
    const clearWait=()=>{if(active.waiting?.timer!==undefined)clearTimeout(active.waiting.timer);active.waiting=undefined;};
    const wait=(kind:'transient'|'admission',delay?:number)=>{
      const waiting=new Promise<void>(resolve=>{
        const slot={kind,finish:()=>{if(active.waiting!==slot)return;clearWait();resolve();},timer:undefined as ReturnType<typeof setTimeout>|undefined};
        active.waiting=slot;if(delay!==undefined)slot.timer=setTimeout(slot.finish,delay);
      });
      return Promise.race([waiting,cancellation]);
    };
    const abort=()=>active.cancel();options.signal?.addEventListener('abort',abort,{once:true});
    const execute=async()=>{
      let retry=0;
      for(;;){
        check();const witness=this.admissionWitness;
        let value:T;
        try{
          // Invoke adjacent to the owner check, without a microtask gap that
          // could dispatch an obsolete request after a synchronous revocation.
          value=await Promise.race([operation(),cancellation]);
        }catch(error){
          check();const kind=disposition(error);if(!kind)throw error;
          active.retrying=true;options.onError?.(error);check();
          if(kind==='admission'){
            if(witness===this.admissionWitness)await wait(kind);
          }else await wait(kind,delays[Math.min(retry++,delays.length-1)]);
          continue;
        }
        check();active.retrying=false;options.onSuccess?.();check();return value;
      }
    };
    return execute().finally(()=>{clearWait();options.signal?.removeEventListener('abort',abort);if(this.active===active)this.active=undefined;});
  }
}
