import {decodeDocumentRuntimeControl,documentRuntimeCounter} from '../core/document-runtime.ts';
import type {DocumentRuntimeFrame,DocumentRuntimeControlAck,DocumentRuntimePublicCommand} from '../core/document-runtime.ts';
import {BrowserVaultError} from '../core/browser-vault.ts';
import type {BrowserDocumentIndexMaintenance,DocumentRuntimeCommand,DocumentRuntimeOutcome,DocumentRuntimeReduction,DocumentRuntimeSnapshot} from '../core/browser-document-runtime.ts';

type Timer=ReturnType<typeof setTimeout>;
export interface BrowserDocumentRuntimeHost {
  /** Trusted owner activation only; listeners never control liveness. */
  start():void;wake():void;sourceHint():void;
  request(input:{id:string;maxPumps:number;maxRestarts:number;forceRebuild:boolean}):DocumentRuntimeReduction;
  cancel(id:string):DocumentRuntimeReduction;
  snapshot():DocumentRuntimeSnapshot|null;
  /** True only around the one already admitted raw maintenance effect. */
  executing():boolean;
  /** A command/source upload is a wake hint, never a scheduling decision. */
  draftsChanged?():void;
  retire():void;drain():Promise<void>;
}
export interface BrowserDocumentRuntimeHostOptions {
  maintenance:BrowserDocumentIndexMaintenance;
  assertActive():void;
  local<T>(operation:()=>Promise<T>):Promise<T>;
  changed(snapshot:DocumentRuntimeSnapshot,outcomes:readonly DocumentRuntimeOutcome[]):void;
  failed(error:unknown):void;
  draftChanged?():void;
  now?():number;
  /** Same30s repair cadence as the existing native rescan default. A repair
   * submits Wake, not another journal scan or feature-owned index loop. */
  repairMs?:number;
  schedule?:(callback:()=>void,ms:number)=>Timer;
  cancelTimer?:(timer:Timer)=>void;
}
/** Execution/admission only. Rust selects every effect, retry, budget, rebuild
 * and Yield. One later task joins the local tail for exactly one issued effect. */
export function createBrowserDocumentRuntimeHost(options:BrowserDocumentRuntimeHostOptions):BrowserDocumentRuntimeHost {
  const schedule=options.schedule??setTimeout,cancel=options.cancelTimer??clearTimeout,repairMs=options.repairMs??30000;
  if(!Number.isSafeInteger(repairMs)||repairMs<1000||repairMs>3600000)throw new BrowserVaultError('invalid_request','Invalid owner repair cadence');
  let started=false,retired=false,executing=false,task:Timer|undefined,repair:Timer|undefined;
  let active:Promise<void>|undefined,adoptedStep='';
  let hintTimer:Timer|undefined,firstHintAt:number|undefined;
  let draining:Promise<void>|undefined,resolveDrain:(()=>void)|undefined,rejectDrain:((error:unknown)=>void)|undefined;
  let closeAttempt:Promise<void>|undefined;
  function guard(){options.assertActive();if(retired)throw new BrowserVaultError('document_runtime_retired','Document owner is retiring');}
  function clock(){const value=Math.floor(options.now?.()??performance.now());if(!Number.isSafeInteger(value)||value<0)throw new BrowserVaultError('invalid_request','Invalid captured monotonic time');return value;}
  function failure(error:unknown){try{options.failed(error);}catch{/* An observer cannot change effect settlement. */}}
  function notify(snapshot:DocumentRuntimeSnapshot,outcomes:readonly DocumentRuntimeOutcome[]){try{options.changed(snapshot,outcomes);}catch(error){failure(error);}}
  function adopt(reduction?:DocumentRuntimeReduction){
    const snapshot=options.maintenance.snapshot();if(!snapshot)return;
    const outcomes:DocumentRuntimeOutcome[]=[...(reduction?.requestOutcomes??[])];
    if(snapshot.lastStep){const key=snapshot.lastStep.lifetime+'/'+snapshot.lastStep.effectId;
      if(key!==adoptedStep){adoptedStep=key;
        // A direct step reply already contains these outcomes. The saved ACK is
        // the recovery path when the original IO error was thrown instead.
        if(!reduction)outcomes.push(...snapshot.lastStep.reduction.requestOutcomes);
      }
    }
    notify(snapshot,outcomes);return snapshot;
  }
  function command(input:DocumentRuntimeCommand){const reduction=options.maintenance.command(input);const snapshot=adopt(reduction);queue(snapshot);return reduction;}
  const composite=()=>options.maintenance.workSnapshot?.().work??null;
  function completeDrain(){
    if(!retired||!draining||active||task!==undefined||closeAttempt)return;
    const work=composite();if(work&&!work.close_ready)return;
    const attempt=options.maintenance.close().then(()=>{resolveDrain?.();resolveDrain=undefined;rejectDrain=undefined;},error=>{rejectDrain?.(error);draining=undefined;resolveDrain=undefined;rejectDrain=undefined;}).finally(()=>{if(closeAttempt===attempt)closeAttempt=undefined;});closeAttempt=attempt;
  }
  function queue(snapshot?:DocumentRuntimeSnapshot,force=false){
    const work=composite();
    if(retired&&!work||!started||task!==undefined||active)return;
    if(retired&&work?.close_ready){completeDrain();return;}
    const current=snapshot??options.maintenance.snapshot();
    if(!force&&!work?.selected&&(!current||!current.inFlight&&current.execution!=='yield'))return;
    task=schedule(()=>{task=undefined;if(retired&&!composite())return;
      let continueWork=false;
      const accepted=options.local(async()=>{
        if(retired&&!composite())return;options.assertActive();
        if(composite()){
          executing=true;
          try{const turn=await options.maintenance.workTurn!(value=>{adopt(value);});continueWork=turn.state==='ready';if(continueWork)options.draftChanged?.();if(turn.error!==undefined)failure(turn.error);}
          catch(error){try{adopt();}catch(admission){failure(admission);}failure(error);rejectDrain?.(error);draining=undefined;resolveDrain=undefined;rejectDrain=undefined;}
          finally{executing=false;}
          return;
        }
        guard();let current=options.maintenance.snapshot();
        if(current&&!current.inFlight&&current.execution==='yield'){const continued=options.maintenance.command({kind:'continue'});current=adopt(continued)??null;}
        const issued=current?.inFlight;if(!issued)return;
        executing=true;
        try{adopt(await options.maintenance.step({lifetime:issued.lifetime,effectId:issued.effectId}));}
        catch(error){
          // An exception is not rollback. Recover only the actual ACK/outcomes
          // and current descriptor; never repeat a guessed effect or policy.
          try{adopt();}catch(admission){failure(admission);}failure(error);
        }finally{executing=false;}
      });
      const finished=accepted.catch(error=>{failure(error);rejectDrain?.(error);draining=undefined;resolveDrain=undefined;rejectDrain=undefined;}).finally(()=>{if(active===finished)active=undefined;try{queue(undefined,continueWork);completeDrain();}catch(error){failure(error);rejectDrain?.(error);draining=undefined;}});active=finished;
    },0);
  }
  function clearHints(){if(hintTimer!==undefined){cancel(hintTimer);hintTimer=undefined;}firstHintAt=undefined;}
  // Source hints are lossy advisory notifications, not commits or index policy.
  // Batch only their delivery: Rust still selects every actual maintenance effect.
  // Foreground observations and draft execution never wait for this timer.
  function scheduleHint(){
    const at=clock();firstHintAt??=at;if(hintTimer!==undefined)cancel(hintTimer);
    const delay=Math.max(0,Math.min(500,1000-(at-firstHintAt)));
    hintTimer=schedule(()=>{hintTimer=undefined;firstHintAt=undefined;if(retired||!started)return;
      try{guard();command({kind:'sourceHint'});}catch(error){failure(error);}
    },delay);
  }
  function repairLater(){if(retired||repair!==undefined)return;repair=schedule(()=>{repair=undefined;if(retired)return;try{host.wake();}catch(error){failure(error);}repairLater();},repairMs);}
  const host:BrowserDocumentRuntimeHost={
    start(){guard();if(started)return;started=true;command({kind:'wake',monotonicMs:clock()});repairLater();},
    wake(){guard();if(!started)return;command({kind:'wake',monotonicMs:clock()});clearHints();},
    sourceHint(){guard();if(!started)return;scheduleHint();},
    request(input){guard();if(!started)throw new BrowserVaultError('document_runtime_unavailable','Document owner has not been activated');const reduction=command({kind:'request',id:input.id,maxPumps:input.maxPumps,maxRestarts:input.maxRestarts,forceRebuild:input.forceRebuild});clearHints();return reduction;},
    cancel(id){guard();return command({kind:'cancelRequest',id});},
    snapshot(){options.assertActive();return options.maintenance.snapshot();},
    executing:()=>executing,
    draftsChanged(){guard();if(!started)throw new BrowserVaultError('document_runtime_unavailable','Document owner has not been activated');options.draftChanged?.();queue(undefined,true);},
    retire(){if(retired)return;retired=true;clearHints();if(task!==undefined){cancel(task);task=undefined;}if(repair!==undefined){cancel(repair);repair=undefined;}
      // No future effect is dispatched. A step already admitted on the local
      // tail may settle, and the caller adopts these explicit Retired outcomes.
      if(started){try{if(composite()){
        const frame=options.maintenance.releaseDrafts!();if(frame.committed)adopt(frame.committed);queue(undefined,true);
      }else adopt(options.maintenance.command({kind:'retire'}));}catch(error){failure(error);}}
    },
    drain(){host.retire();if(draining)return draining;
      if(!composite())return (async()=>{await active;await options.maintenance.close();})();
      if(!composite()!.closing){const frame=options.maintenance.releaseDrafts!();if(frame.committed)adopt(frame.committed);}
      draining=new Promise<void>((resolve,reject)=>{resolveDrain=resolve;rejectDrain=reject;});
      try{queue(undefined,true);completeDrain();}catch(error){rejectDrain?.(error);draining=undefined;}
      return draining??Promise.reject(new BrowserVaultError('document_runtime_unavailable','Document owner could not drain'));
    },
  };return host;
}

/** One lease owns this channel. IDs are local to that admitted consumer; unlike
 * native multi-client dispatch, a Worker never accepts a caller-selected scope. */
type BrowserDocumentRuntimeFrame=DocumentRuntimeFrame;
type FeatureCommand=DocumentRuntimePublicCommand;
type BrowserDocumentRuntimeAck=DocumentRuntimeControlAck;
const rejected=(code='invalid_request')=>new BrowserVaultError(code,'Document maintenance request is not admitted');
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw rejected();return value as Record<string,unknown>;
}
function counter(value:unknown):string {try{return documentRuntimeCounter(value);}catch{throw rejected();}}
/** Bounded delivery state, not a second lifecycle reducer. Active and terminal
 * requests share32 slots until explicit outcome ACK; one control ACK is retained
 * independently of the Rust update revision and replaces no accepted outcome. */
export function createBrowserDocumentRuntimeChannel(options:{scope:{localStoreId:string;clientId:string};assertActive():void;host:BrowserDocumentRuntimeHost;nudge():void}) {
  const scope=Object.freeze({...options.scope});
  const slots=new Map<string,{lifetime:string;command:Extract<FeatureCommand,{kind:'request'}>;outcome?:DocumentRuntimeOutcome}>();
  let highwater=-1n,sequenceFloor=-1n,ack:BrowserDocumentRuntimeAck|undefined,lifetime:string|null|undefined;
  function reconcile(state:DocumentRuntimeSnapshot|null){const next=state?.update.lifetime??null;if(next!==lifetime){lifetime=next;slots.clear();ack=undefined;}}
  const live=()=>{options.assertActive();};
  const snapshot=()=>{const state=options.host.snapshot();reconcile(state);return state;};
  function frame():BrowserDocumentRuntimeFrame {live();return Object.freeze({version:1,scope,update:snapshot()?.update??null,outcomes:Object.freeze([...slots.values()].flatMap(row=>row.outcome?[Object.freeze({lifetime:row.lifetime,outcome:row.outcome})]:[]))});}
  function adopt(state:DocumentRuntimeSnapshot,outcomes:readonly DocumentRuntimeOutcome[]){
    reconcile(state);
    for(const outcome of outcomes){const slot=slots.get(outcome.id);if(slot&&slot.lifetime===state.update.lifetime&&!slot.outcome)slot.outcome=outcome;}
    // Even equal update.revision can contain a new Cancelled outcome.
    options.nudge();
  }
  return {
    adopt,observe:frame,
    control(value:unknown):BrowserDocumentRuntimeAck {
      live();let input;try{input=decodeDocumentRuntimeControl(value);}catch{throw rejected();}const number=BigInt(input.sequence),current=snapshot();
      if(ack){if(input.sequence===ack.sequence&&JSON.stringify(input.command)===JSON.stringify(ack.command))return ack;throw rejected('document_runtime_busy');}
      if(number<=sequenceFloor)throw rejected('document_runtime_expired');
      if(!current||current.update.lifetime!==input.command.lifetime)throw rejected('document_runtime_expired');
      const command=input.command,key=command.id,old=slots.get(key);
      if(command.kind==='request'){
        if(old){if(old.lifetime!==command.lifetime||JSON.stringify(old.command)!==JSON.stringify(command))throw rejected('invalid_request');}
        else{
          if(BigInt(key)<=highwater)throw rejected('document_runtime_expired');if(slots.size>=32)throw rejected('document_runtime_capacity');
          // Install before synchronous Rust dispatch so an immediate terminal
          // outcome can be attached to the actual admitted request.
          slots.set(key,{lifetime:command.lifetime,command});
          try{options.host.request(command);}catch(error){slots.delete(key);throw error;}highwater=BigInt(key);
        }
      }else{
        if(!old||old.lifetime!==command.lifetime)throw rejected('document_runtime_expired');
        if(!old.outcome)options.host.cancel(key);
      }
      sequenceFloor=number;ack=Object.freeze({sequence:input.sequence,command,frame:frame()});return ack;
    },
    ackControl(value:unknown):void {live();const row=fields(value,['sequence']),sequence=counter(row.sequence);if(ack){if(sequence!==ack.sequence)throw rejected('document_runtime_expired');ack=undefined;}else if(BigInt(sequence)!==sequenceFloor)throw rejected('document_runtime_expired');},
    ackOutcome(value:unknown):void {live();const row=fields(value,['lifetime','id']),id=counter(row.id);if(typeof row.lifetime!=='string')throw rejected();const current=snapshot();if(!current||row.lifetime!==current.update.lifetime)throw rejected('document_runtime_expired');const slot=slots.get(id);if(slot){if(slot.lifetime!==row.lifetime||!slot.outcome)throw rejected('document_runtime_busy');slots.delete(id);}else if(BigInt(id)>highwater)throw rejected('document_runtime_expired');},
  };
}
