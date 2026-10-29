import type {CheckpointScope} from '../core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftReceipt} from '../core/independent-drafts.ts';
import {DraftProtection} from './draft-protection.ts';
import type {DraftCleanWitness,DraftProtectionSnapshot,DraftProtectionStatus} from './draft-protection.ts';

export interface NoteDraftCapture {readonly writer:string;readonly snapshot:DraftProtectionSnapshot}
export type NoteDraftInventory='ready'|'unknown'|'retained';
export interface NoteDraftProtectionStatus {
  /** Local capture sequence, including snapshots not yet offered during backoff. */
  readonly sequence:number;
  readonly currentProtected:boolean;
  /** Real journal acknowledgement of this exact latest capture, even if retired.
   * Core coverage alone and an older generic acknowledgement do not satisfy it. */
  readonly currentJournalAcknowledged:boolean;
  readonly pending:boolean;
  readonly inventory:NoteDraftInventory;
  readonly inventoryError:Error|null;
  readonly error:Error|null;
  readonly protection:DraftProtectionStatus|undefined;
  readonly retryPending:boolean;
}
export interface NoteDraftProtectionOptions {
  readonly provider:IndependentDraftProvider;
  readonly writesScope:CheckpointScope;
  readonly initialReceipt?:IndependentDraftReceipt;
  readonly onStatus?:(status:NoteDraftProtectionStatus)=>void;
  /** Only an exact confirmed latest core capture may suppress protection retries. */
  readonly coreCovered:(capture:NoteDraftCapture)=>boolean;
  readonly getCleanWitness?:(capture:NoteDraftCapture)=>DraftCleanWitness|undefined;
  /** The owner validates candidates and calls markInventory; this never adopts one. */
  readonly retryInventory?:()=>Promise<void>;
  readonly encodePendingOperation?:(capture:Readonly<object>)=>string;
}

const delays=[500,1500,4000,30_000] as const;
const transientCodes=new Set(['draft_storage_failure','draft_journal_busy','draft_transport_lost']);
type JournalFailureSource='main'|'transport'|'protocol'|'untrusted';
type JournalFailure=Error&{code?:string;source?:JournalFailureSource};
const failure=(code:string)=>Object.assign(new Error('Independent note draft protection is incomplete; the draft is retained.'),{code});
function sourceOf(value:object):JournalFailureSource|undefined {
  const descriptor=Object.getOwnPropertyDescriptor(value,'source');
  if(!descriptor)return 'source'in value?'untrusted':undefined;
  const source=Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
  return source==='main'||source==='transport'||source==='protocol'?source:'untrusted';
}
function transientFailure(error:Error):boolean {
  const source=sourceOf(error),code=Object.getOwnPropertyDescriptor(error,'code')?.value;
  return (source===undefined||source==='main'||source==='transport')&&typeof code==='string'&&transientCodes.has(code);
}
function asError(value:unknown):Error {
  if(value instanceof Error)return value;
  const error:JournalFailure=failure('draft_protection_failed');
  if(value&&typeof value==='object'){
    const code=Object.getOwnPropertyDescriptor(value,'code')?.value,source=sourceOf(value);
    if(typeof code==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(code))error.code=code;
    if(source!==undefined)error.source=source;
  }
  return error;
}
function sameCapture(left:NoteDraftCapture,right:NoteDraftCapture):boolean {
  const a=left.snapshot,b=right.snapshot,x=a.baseline,y=b.baseline;
  return left.writer===right.writer&&a.generation===b.generation&&a.draft===b.draft&&a.checkpointRevision===b.checkpointRevision
    &&a.pendingOperation===b.pendingOperation&&x.entryId===y.entryId&&x.path===y.path&&x.revision===y.revision&&x.content===y.content;
}

/** A note-local protection lane. Its acknowledgement never clears core dirty or
 * save errors. Only failures schedule a timer; healthy captures coalesce in the
 * journal queue, and failed captures stay local until the next retry boundary. */
export class NoteDraftProtection {
  private readonly options:NoteDraftProtectionOptions;
  private latest?:NoteDraftCapture;
  private sequence=0;
  private offered?:{capture:NoteDraftCapture;sequence:number};
  private protection?:DraftProtection;
  private inventory:NoteDraftInventory='unknown';
  private inventoryError:Error|null=null;
  private errorValue:Error|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private retryStep=0;
  private running?:Promise<void>;
  private explicitRequested=false;
  private scheduled=false;
  private stopped=false;

  constructor(options:NoteDraftProtectionOptions){
    this.options=options;
    if(options.provider.scope.vaultId!==options.writesScope.vaultId||options.provider.scope.clientId!==options.writesScope.clientId)throw failure('draft_scope_mismatch');
  }
  get status():NoteDraftProtectionStatus {
    const protection=this.protection?.status,currentJournalAcknowledged=!!this.latest&&this.offered?.capture===this.latest
      &&!!protection&&protection.acknowledgedSequence>=this.offered.sequence;
    const currentProtected=!this.latest||this.covered(this.latest)||currentJournalAcknowledged;
    return Object.freeze({sequence:this.sequence,currentProtected,currentJournalAcknowledged,pending:this.inventory==='unknown'||!currentProtected,
      inventory:this.inventory,inventoryError:this.inventoryError,error:this.errorValue??protection?.error??null,protection,retryPending:this.timer!==undefined});
  }
  capture(input:NoteDraftCapture):void {
    if(this.stopped)return;
    if(this.latest&&(input.writer!==this.latest.writer||input.snapshot.baseline.entryId!==this.latest.snapshot.baseline.entryId))throw failure('draft_owner_changed');
    const snapshot=input.snapshot;
    if(snapshot.pendingOperation!==null&&typeof snapshot.pendingOperation==='object'&&!Object.isFrozen(snapshot.pendingOperation))throw failure('invalid_draft_operation_capture');
    const captured=Object.freeze({writer:input.writer,snapshot:Object.freeze({...snapshot,baseline:Object.freeze({...snapshot.baseline})})});
    if(this.latest&&sameCapture(this.latest,captured))return;
    this.latest=captured;this.sequence++;
    if(this.covered(captured)&&this.inventory!=='unknown'){this.cancelTimer();this.retryStep=0;this.kick();}
    else if(this.failureError())this.scheduleRetry();
    else if(this.inventory!=='unknown')this.kick();
    this.notify();
  }
  markInventory(state:NoteDraftInventory,error?:unknown):void {
    if(this.stopped)return;
    this.inventory=state;this.inventoryError=state==='unknown'&&error!==undefined?asError(error):null;
    if(state==='unknown')this.scheduleRetry();
    else {this.cancelTimer();this.kick();}
    this.notify();
  }
  /** Explicit barrier retries the retained original CAS before protecting latest. */
  flush():Promise<void> {return this.startFlush(true);}
  private startFlush(explicit:boolean):Promise<void> {
    if(this.stopped)return Promise.reject(failure('draft_protection_stopped'));
    this.cancelTimer();
    if(this.running){this.explicitRequested ||= explicit;return this.running;}
    this.explicitRequested=explicit;
    const operation=this.run();this.running=operation;
    void operation.then(()=>this.finished(operation),error=>this.finished(operation,error));
    return operation;
  }
  coreSettled():void {
    if(this.stopped)return;
    if(this.latest&&this.covered(this.latest)&&this.inventory!=='unknown'){this.cancelTimer();this.retryStep=0;this.kick();}
    else if(!this.failureError()&&this.inventory!=='unknown')this.kick();
    this.notify();
  }
  availability():void {if(!this.stopped){const error=this.failureError();if(error&&!transientFailure(error))return;this.cancelTimer();this.kick();}}
  stop():void {this.stopped=true;this.cancelTimer();}

  private covered(capture:NoteDraftCapture):boolean {return this.options.coreCovered(capture);}
  private failureError():Error|null {return this.inventory==='unknown'?this.inventoryError:this.errorValue??this.protection?.status.error??null;}
  private cancelTimer():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  private scheduleRetry():void {
    if(this.stopped||this.timer!==undefined)return;
    const error=this.failureError();
    if(!error||!transientFailure(error))return;
    if(this.inventory!=='unknown'&&(!this.latest||this.status.currentProtected))return;
    const delay=delays[Math.min(this.retryStep++,delays.length-1)];
    this.timer=setTimeout(()=>{this.timer=undefined;if(!this.stopped)void this.startFlush(false).catch(()=>{});},delay);
  }
  private kick():void {
    if(this.stopped||this.scheduled)return;
    const error=this.failureError();if(error&&!transientFailure(error))return;
    this.scheduled=true;
    queueMicrotask(()=>{this.scheduled=false;if(!this.stopped)void this.startFlush(false).catch(()=>{});});
  }
  private createProtection(capture:NoteDraftCapture):DraftProtection {
    const provider=this.options.provider;
    return new DraftProtection({entryId:capture.snapshot.baseline.entryId,writer:capture.writer,initialReceipt:this.options.initialReceipt,
      transport:{scope:provider.scope,compareAndSwap:async request=>{this.assertActive();try{return await provider.compareAndSwap(request);}catch(error){throw asError(error);}},
        retire:async request=>{this.assertActive();try{return await provider.retire(request);}catch(error){throw asError(error);}}},
      encodePendingOperation:this.options.encodePendingOperation??JSON.stringify,
      onStatus:()=>{if(this.stopped)return;this.scheduleRetry();this.notify();}});
  }
  private async run():Promise<void> {
    this.assertActive();
    if(this.inventory==='unknown'){
      if(!this.explicitRequested&&this.inventoryError&&!transientFailure(this.inventoryError))return;
      if(this.options.retryInventory){
        try{await this.options.retryInventory();}catch(error){if(!this.stopped)this.markInventory('unknown',error);throw error;}
        this.assertActive();
      }
      if(this.inventory==='unknown')throw this.inventoryError??failure('draft_inventory_unknown');
    }
    for(;;){
      this.assertActive();const capture=this.latest;if(!capture)return;
      const error=this.errorValue??this.protection?.status.error;if(!this.explicitRequested&&error&&!transientFailure(error))return;
      if(this.covered(capture)){
        await this.retireClean(capture);this.assertActive();
        if(this.latest===capture)return;
        continue;
      }
      const protection=this.protection??=this.createProtection(capture);
      if(this.offered?.capture!==capture){const sequence=protection.offer(capture.snapshot);this.offered={capture,sequence};}
      await protection.flushThrough(this.offered.sequence);this.assertActive();this.errorValue=null;
      if(this.latest===capture)return;
    }
  }
  private async retireClean(capture:NoteDraftCapture):Promise<void> {
    const protection=this.protection;
    // A real core commit changes the baseline/checkpoint and clears its operation
    // capsule. Protect that exact final state before retiring an older raw draft.
    // A clean startup with no existing journal lane needs no redundant write.
    if(!protection||capture.snapshot.pendingOperation!==null)return;
    if(this.offered?.capture!==capture){const sequence=protection.offer(capture.snapshot);this.offered={capture,sequence};}
    const offered=this.offered;
    if(protection.status.retiredSequence>=offered.sequence)return;
    const ack=await protection.flushThrough(offered.sequence);this.assertActive();
    if(!ack||this.latest!==capture||!this.covered(capture))return;
    const witness=this.options.getCleanWitness?.(capture);
    if(!witness||this.latest!==capture||!this.covered(capture))return;
    const retired=await protection.retireKnownClean(ack,witness);this.assertActive();
    if(retired&&this.latest===capture&&this.covered(capture))this.errorValue=null;
  }
  private finished(operation:Promise<void>,error?:unknown):void {
    if(this.running===operation)this.running=undefined;
    if(this.stopped)return;
    if(error!==undefined){
      if(this.inventory!=='unknown'&&this.protection?.status.error!==error)this.errorValue=asError(error);
      this.scheduleRetry();
    }else if(!this.status.pending){this.retryStep=0;this.cancelTimer();}
    this.notify();
    if(error===undefined&&this.latest&&!this.covered(this.latest)&&this.offered?.capture!==this.latest)this.kick();
  }
  private assertActive():void {if(this.stopped)throw failure('draft_protection_stopped');}
  private notify():void {if(!this.stopped)try{this.options.onStatus?.(this.status);}catch{/* Status cannot change journal ownership. */}}
}
