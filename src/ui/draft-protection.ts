import type {IndependentDraftScope,IndependentDraftBaseline,IndependentDraftChange,IndependentDraftReceipt,IndependentDraftRetirement,IndependentDraftProvider} from '../core/independent-drafts.ts';
export type DraftJournalScope=IndependentDraftScope;
export type DraftJournalReceipt=IndependentDraftReceipt;
export type DraftJournalChange=IndependentDraftChange;
export type DraftJournalRetirement=IndependentDraftRetirement;
export type DraftProtectionTransport=Pick<IndependentDraftProvider,'scope'|'compareAndSwap'|'retire'>;
export interface DraftProtectionSnapshot {
  readonly generation:number;
  readonly baseline:IndependentDraftBaseline;
  readonly draft:string;readonly checkpointRevision:string|null;
  /** Object captures must be deeply owned/immutable by the caller. Freeze each
   * small metadata layer and reuse immutable body strings; mint a new object
   * identity whenever the submitted operation phase changes. */
  readonly pendingOperation:string|null|Readonly<object>;
}
export interface DraftProtectionAcknowledgement {
  readonly sequence:number;readonly receipt:DraftJournalReceipt;
  /** Exact immutable encoded request acknowledged by storage, never the latest
   * offered snapshot. A coalesced sequence alone cannot prove capsule contents. */
  readonly request:DraftJournalChange;
}
export interface DraftCleanWitness {readonly entryId:string;readonly writer:string;readonly generation:number;readonly content:string;readonly revision:string}
export interface DraftProtectionStatus {
  readonly sequence:number;readonly acknowledgedSequence:number;readonly retiredSequence:number;readonly pending:boolean;readonly error:Error|null;
}
export interface DraftProtectionOptions {
  readonly transport:DraftProtectionTransport;readonly entryId:string;readonly writer:string;
  readonly initialReceipt?:DraftJournalReceipt;
  /** Runs only on the asynchronous send lane; never receives mutable state. */
  readonly encodePendingOperation?:(capture:Readonly<object>)=>string;
  readonly onStatus?:(status:DraftProtectionStatus)=>void;
}

const maximumRevision=18446744073709551615n,textLimit=64*1024*1024;
const fail=(code:string)=>Object.assign(new Error('Draft protection did not finish; the captured draft is retained.'),{code});
function id(value:unknown):string{if(typeof value!=='string'||!value||value.length>256||value.includes('\0'))throw fail('invalid_draft_identity');return value;}
function generation(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||Object.is(value,-0))throw fail('invalid_draft_generation');return value;}
function revision(value:unknown):string{if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>maximumRevision)throw fail('invalid_draft_revision');return value;}
function body(value:unknown):string{if(typeof value!=='string'||value.length*2>textLimit)throw fail('draft_size_limit');return value;}
function record(value:unknown,keys:readonly string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)
  &&[null,Object.prototype].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));}
type Captured={sequence:number;snapshot:DraftProtectionSnapshot};
type PendingWrite={kind:'write';sequence:number;request:DraftJournalChange};
type PendingRetirement={kind:'retire';sequence:number;request:DraftJournalRetirement;issued:boolean};
type FlushWaiter={sequence:number;resolve:(ack:DraftProtectionAcknowledgement)=>void;reject:(error:Error)=>void};

/** Independent protection acknowledgements never mean the note itself saved.
 * Bodies remain immutable strings. Capture never encodes, hashes or serializes
 * them, and this queue has no dependency on the domain save queue or Rust. */
export class DraftProtection {
  private readonly scope:DraftJournalScope;
  private readonly entryId:string;
  private readonly writer:string;
  private readonly compareAndSwap:DraftProtectionTransport['compareAndSwap'];
  private readonly retire:DraftProtectionTransport['retire'];
  private readonly onStatus?:DraftProtectionOptions['onStatus'];
  private readonly encodePendingOperation?:DraftProtectionOptions['encodePendingOperation'];
  private readonly encodedOperations=new WeakMap<object,string>();
  private sequence=0;
  private currentRevision:string|null=null;
  private lastGeneration=0;
  private latest?:Captured;
  private pending?:PendingWrite|PendingRetirement;
  private acknowledged?:DraftProtectionAcknowledgement;
  private readonly tokens=new WeakSet<object>();
  private waiters:FlushWaiter[]=[];
  private retirementWaiters:{pending:PendingRetirement;resolve:(retired:boolean)=>void;reject:(error:Error)=>void}[]=[];
  private retiredSequence=0;
  private scheduled=false;
  private running=false;
  private errorValue:Error|null=null;
  constructor(options:DraftProtectionOptions){
    const scope=options.transport.scope;
    this.scope=Object.freeze({vaultId:id(scope.vaultId),clientId:id(scope.clientId),incarnationId:id(scope.incarnationId)});
    this.entryId=id(options.entryId);this.writer=id(options.writer);this.onStatus=options.onStatus;this.encodePendingOperation=options.encodePendingOperation;
    if(typeof options.transport.compareAndSwap!=='function'||typeof options.transport.retire!=='function')throw fail('invalid_draft_transport');
    this.compareAndSwap=options.transport.compareAndSwap.bind(options.transport);this.retire=options.transport.retire.bind(options.transport);
    if(options.initialReceipt){const initial=this.captureReceipt(options.initialReceipt);this.currentRevision=initial.revision;this.lastGeneration=initial.generation;}
  }
  get status():DraftProtectionStatus{return Object.freeze({sequence:this.sequence,acknowledgedSequence:this.acknowledged?.sequence??0,retiredSequence:this.retiredSequence,
    pending:!!this.pending||!!this.latest&&this.latest.sequence>(this.acknowledged?.sequence??0),error:this.errorValue});}
  /** Actual retained storage responsibility, not an unencoded latest offer.
   * Known retirement removes its old acknowledged write from reachability. */
  get retainedWriteRequests():readonly DraftJournalChange[]{
    const result:DraftJournalChange[]=[];
    if(this.acknowledged&&this.acknowledged.sequence>this.retiredSequence)result.push(this.acknowledged.request);
    if(this.pending?.kind==='write'&&!result.includes(this.pending.request))result.push(this.pending.request);
    return Object.freeze(result);
  }
  /** Local sequence is independent of edit generation and journal revision. */
  offer(input:DraftProtectionSnapshot):number{
    if(!record(input,['generation','baseline','draft','checkpointRevision','pendingOperation'])||!record(input.baseline,['entryId','path','revision','content']))throw fail('invalid_draft_snapshot');
    const nextGeneration=generation(input.generation),base=input.baseline;
    if(nextGeneration<this.lastGeneration||base.entryId!==this.entryId||typeof base.path!=='string'||typeof base.revision!=='string')throw fail('invalid_draft_snapshot');
    if(base.path.length*2>65536||base.revision.length*2>65536)throw fail('draft_size_limit');
    const baseline=Object.freeze({entryId:this.entryId,path:base.path,revision:base.revision,content:body(base.content)});
    const draft=body(input.draft);let pendingOperation:DraftProtectionSnapshot['pendingOperation'];
    if(input.pendingOperation!==null&&typeof input.pendingOperation==='object'){
      if(!Object.isFrozen(input.pendingOperation)||!this.encodePendingOperation)throw fail('invalid_draft_operation_capture');
      pendingOperation=input.pendingOperation;
    }else pendingOperation=input.pendingOperation===null?null:body(input.pendingOperation);
    const checkpointRevision=input.checkpointRevision===null?null:id(input.checkpointRevision);
    if((baseline.content.length+draft.length+(typeof pendingOperation==='string'?pendingOperation.length:0))*2>128*1024*1024)throw fail('draft_size_limit');
    if(this.sequence===Number.MAX_SAFE_INTEGER)throw fail('draft_sequence_exhausted');
    const snapshot=Object.freeze({generation:nextGeneration,baseline,draft,checkpointRevision,pendingOperation});
    this.latest={sequence:++this.sequence,snapshot};this.lastGeneration=nextGeneration;
    if(this.pending?.kind==='retire'&&!this.pending.issued){this.pending=undefined;
      const waiters=this.retirementWaiters;this.retirementWaiters=[];for(const waiter of waiters)waiter.resolve(false);}
    this.schedule();this.notify();return this.sequence;
  }
  /** Coalesced newer snapshots can satisfy an older barrier. A close owner must
   * capture/recheck the latest sequence; this does not fence future edits. */
  flushThrough(sequence:number):Promise<DraftProtectionAcknowledgement|null>{
    if(!Number.isSafeInteger(sequence)||sequence<0||Object.is(sequence,-0)||sequence>this.sequence)return Promise.reject(fail('invalid_draft_sequence'));
    if(sequence===0)return Promise.resolve(null);
    if(this.acknowledged&&this.acknowledged.sequence>=sequence)return Promise.resolve(this.acknowledged);
    const result=new Promise<DraftProtectionAcknowledgement>((resolve,reject)=>{this.waiters.push({sequence,resolve,reject});});
    this.schedule();return result;
  }
  /** The caller must supply a confirmed logical save witness, not an optimistic
   * editor state. This module does not establish native save authority. Success
   * retires only that snapshot; a newer offer still needs its own flush barrier. */
  async retireKnownClean(ack:DraftProtectionAcknowledgement,witness:DraftCleanWitness):Promise<boolean>{
    const latest=this.latest;
    if(!ack||!this.tokens.has(ack)||ack!==this.acknowledged||!latest||latest.sequence!==ack.sequence||latest.snapshot.pendingOperation!==null
      ||!record(witness,['entryId','writer','generation','content','revision'])||witness.entryId!==this.entryId||witness.writer!==this.writer
      ||witness.generation!==latest.snapshot.generation||witness.content!==latest.snapshot.draft)return false;
    try{id(witness.revision);generation(witness.generation);}catch{return false;}
    if(this.pending&&this.pending.kind!=='retire')return false;
    try{
      if(!this.pending)this.pending={kind:'retire',sequence:ack.sequence,issued:false,request:Object.freeze({entryId:this.entryId,writer:this.writer,
        incarnationId:this.scope.incarnationId,generation:ack.receipt.generation,expectedRevision:this.currentRevision!,nextRevision:this.nextRevision()})};
    }catch(error){this.errorValue=error instanceof Error?error:fail('draft_retirement_failed');this.notify();throw this.errorValue;}
    const pending=this.pending as PendingRetirement;
    const result=new Promise<boolean>((resolve,reject)=>{this.retirementWaiters.push({pending,resolve,reject});});
    this.schedule();this.notify();return result;
  }
  private nextRevision(){const next=this.currentRevision===null?1n:BigInt(this.currentRevision)+1n;if(next>maximumRevision)throw fail('draft_revision_exhausted');return String(next);}
  private captureReceipt(value:unknown):DraftJournalReceipt{
    if(!record(value,['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'])
      ||value.vaultId!==this.scope.vaultId||value.clientId!==this.scope.clientId||value.incarnationId!==this.scope.incarnationId
      ||value.entryId!==this.entryId||value.writer!==this.writer||typeof value.deleted!=='boolean')throw fail('invalid_draft_receipt');
    return Object.freeze({...this.scope,entryId:this.entryId,writer:this.writer,revision:revision(value.revision),generation:generation(value.generation),deleted:value.deleted});
  }
  private schedule(){if(this.scheduled||this.running)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;void this.publish();});}
  private encodeOperation(capture:DraftProtectionSnapshot['pendingOperation']):string|null{
    if(capture===null||typeof capture==='string')return capture;
    const cached=this.encodedOperations.get(capture);if(cached!==undefined)return cached;
    const encoded=body(this.encodePendingOperation!(capture));this.encodedOperations.set(capture,encoded);return encoded;
  }
  private async publish(){
    if(this.running||!this.pending&&(!this.latest||this.latest.sequence<=(this.acknowledged?.sequence??0)))return;
    this.running=true;
    try{
      if(!this.pending){
        const latest=this.latest!,pendingOperation=this.encodeOperation(latest.snapshot.pendingOperation);
        if((latest.snapshot.baseline.content.length+latest.snapshot.draft.length+(pendingOperation?.length??0))*2>128*1024*1024)throw fail('draft_size_limit');
        this.pending={kind:'write',sequence:latest.sequence,request:Object.freeze({entryId:this.entryId,writer:this.writer,
          expectedRevision:this.currentRevision,nextRevision:this.nextRevision(),...latest.snapshot,pendingOperation})};
      }
      const pending=this.pending;
      if(pending.kind==='retire')pending.issued=true;
      const receipt=this.captureReceipt(await(pending.kind==='write'?this.compareAndSwap(pending.request):this.retire(pending.request)));
      if(receipt.deleted!==(pending.kind==='retire')||receipt.revision!==pending.request.nextRevision||receipt.generation!==pending.request.generation)throw fail('invalid_draft_receipt');
      this.currentRevision=receipt.revision;
      if(pending.kind==='write'){
        this.acknowledged=Object.freeze({sequence:pending.sequence,receipt,request:pending.request});this.tokens.add(this.acknowledged);
      }else{
        this.retiredSequence=pending.sequence;if(this.latest?.sequence===pending.sequence)this.latest=undefined;
        const waiters=this.retirementWaiters;this.retirementWaiters=[];for(const waiter of waiters)waiter.resolve(true);
      }
      this.pending=undefined;this.errorValue=null;
      const acknowledged=this.acknowledged;
      if(acknowledged){const ready=this.waiters.filter(waiter=>waiter.sequence<=acknowledged.sequence);this.waiters=this.waiters.filter(waiter=>waiter.sequence>acknowledged.sequence);
        for(const waiter of ready)waiter.resolve(acknowledged);}
    }catch(error){
      this.errorValue=error instanceof Error?error:fail('draft_transport_failed');
      const waiters=this.waiters;this.waiters=[];for(const waiter of waiters)waiter.reject(this.errorValue);
      const retiring=this.retirementWaiters;this.retirementWaiters=[];for(const waiter of retiring)waiter.reject(this.errorValue);
    }finally{
      this.running=false;this.notify();
      if(!this.errorValue&&this.latest&&this.latest.sequence>(this.acknowledged?.sequence??0))this.schedule();
    }
  }
  private notify(){try{this.onStatus?.(this.status);}catch{/* Observation cannot change journal authority. */}}
}
