import type { Vault } from '../core/vault.ts';
import {DurableWritePlanningError} from '../core/durable-writes.ts';
import type { DurableWrites, DurableWriteRead, DurableWritePlan, DurableWriteRef, DurableWriteOutcome, DurableWriteInput, ConditionalSavedSourceWitness, ConditionalSavedSourceRequest, ConditionalSavedSourceCapture, ConditionalSavedSourceStatus } from '../core/durable-writes.ts';
import type { Checkpoint,CheckpointChange } from '../core/durable-checkpoints.ts';
import { boundedUtf8,checkpointRevision,checkpointStateLimit,snapshotCheckpointChange } from '../core/checkpoint-input.ts';
import {NoteDraftProtection} from './note-draft-protection.ts';
import {NoteLoadSupervisor} from './note-load-supervisor.ts';
import {recoverNoteCaptureCapacity} from './note-capture-capacity.ts';
import {claimCaptureRequest,reserveCaptureRequestCleanup,retryCaptureRequestCleanups,captureRequestCleanupAdmissionAvailable} from './capture-request-cleanup.ts';
import type {CaptureRequestClaim} from './capture-request-cleanup.ts';
import type {NoteDraftCapture,NoteDraftProtectionStatus} from './note-draft-protection.ts';
import type {IndependentDraftReceipt,IndependentDraftCandidate,IndependentDraftRetirement,IndependentDraftScope} from '../core/independent-drafts.ts';
import type {DraftProtectionAcknowledgement} from './draft-protection.ts';
interface Operation { plan?:DurableWritePlan; input?:DurableWriteInput; content:string; ref?:DurableWriteRef; pendingAck?:DurableWriteOutcome; planningRejected?:string }
interface State {version:1;writer:string;generation:number;base:DurableWriteRead;draft:string;conflict:boolean;operation?:Operation}
interface CoreCoverage {writer:string;generation:number;base:DurableWriteRead;draft:string;clean:boolean;revision:string}
interface JournalCandidatePlan {canonical:State;exact?:CheckpointChange}
interface ProtectedCaptureRequest extends ConditionalSavedSourceRequest {readonly scope:IndependentDraftScope}
const journalError=(code:string)=>Object.assign(new Error('Independent draft inventory could not be verified; candidates were retained.'),{code});
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&!value.includes('\0');
const validGeneration=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const validCheckpointReference=(value:unknown):boolean=>{if(value===null)return true;try{checkpointRevision(value);return true;}catch{return false;}};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const sameBase=(a:Pick<DurableWriteRead,'entryId'|'path'|'revision'|'content'>,b:Pick<DurableWriteRead,'entryId'|'path'|'revision'|'content'>)=>a.entryId===b.entryId&&a.path===b.path&&a.revision===b.revision&&a.content===b.content;
function plainCheckpointState(encoded:string):State|undefined {
  try{const value=JSON.parse(encoded);
    if(!object(value)||value.version!==1||!validId(value.writer)||!validGeneration(value.generation)||typeof value.draft!=='string'||value.conflict!==false||value.operation!==undefined
      ||!object(value.base)||!validId(value.base.entryId)||!validId(value.base.revision)||typeof value.base.path!=='string'||typeof value.base.content!=='string'||!object(value.base.stat))return;
    const stat=value.base.stat;if(!['ctime','mtime','size'].every(key=>typeof stat[key]==='number'&&Number.isFinite(stat[key])&&stat[key]>=0)||!Number.isSafeInteger(stat.size))return;
    return value as unknown as State;
  }catch{return;}
}
/** Operation graphs contain small records and immutable strings. Copy records,
 * never encode their potentially large source/plan strings on the edit stack. */
function frozenPhase(value:unknown,depth=0):any {
  if(value===null||value===undefined||typeof value!=='object')return value;
  if(depth>8||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length>32)throw failure('invalid protection phase');
  const copy:Record<string,unknown>={};for(const key of Object.keys(value))copy[key]=frozenPhase((value as Record<string,unknown>)[key],depth+1);
  return Object.freeze(copy);
}
const failure=(message:string)=>new Error(`Durable note recovery: ${message}`);
/** Generated frontmatter can advance independently while the user keeps typing
 * in the body. Reconcile only an untouched submitted header; a concurrently
 * edited header is retained as a conflict rather than being guessed or lost. */
function canonicalDraft(submitted:string,canonical:string,current:string):string|undefined {
  if(current===submitted)return canonical;
  if(canonical===submitted)return current;
  const split=(source:string):{front:string;body:string}|undefined=>{
    const bom=source.startsWith('\uFEFF')?'\uFEFF':'',text=source.slice(bom.length);
    const opening=/^---[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(text);
    if(!opening)return{front:bom,body:text};
    const remainder=text.slice(opening[0].length),closing=/^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(remainder);
    if(!closing)return undefined;
    const end=bom.length+opening[0].length+closing.index+closing[0].length;
    return{front:source.slice(0,end),body:source.slice(end)};
  };
  const before=split(submitted),after=split(canonical),draft=split(current);
  if(!before||!after||!draft||before.body!==after.body||before.front!==draft.front)return undefined;
  return after.front+draft.body;
}
/** Editor-owned checkpoints; provider plans and operation identities stay exact. */
export class DurableNoteState {
  private state?:State;
  private revision:string|null=null;
  private confirmedState?:string|null;
  private uncertain?:CheckpointChange;
  private tail:Promise<unknown>=Promise.resolve();
  private key='';
  private captures=new WeakMap<ConditionalSavedSourceCapture,Exclude<ConditionalSavedSourceStatus,'foreign'>>();
  private activeCaptures=new Map<string,ConditionalSavedSourceCapture>();
  private abandonedCaptures=new Set<string>();
  private releasingCaptures=new WeakMap<ConditionalSavedSourceCapture,Promise<void>>();
  private captureRequests=new Map<string,ProtectedCaptureRequest>();
  private captureRequestsVersion=0;
  private captureClaims=new Map<string,CaptureRequestClaim>();
  private captureReleases=new Map<string,{supervisor:NoteLoadSupervisor;task:Promise<void>}>();
  private pendingCaptureOwners=new Map<string,{controller:AbortController;supervisor:NoteLoadSupervisor}>();
  error:Error|null=null;
  private vault:Vault;
  private writes:DurableWrites;
  private readonly noteScope:{readonly vaultId:string;readonly clientId:string};
  private changed:()=>void;
  private protection?:NoteDraftProtection;
  private protectionCaptureError:Error|null=null;
  private protectionAuthoringStarted=false;
  private protectionStopped=false;
  private protectionAdmitted=true;
  private deferredProtectionInventory?:{state:'ready'|'unknown'|'retained';error?:unknown};
  private recoveredIndependent=false;
  private recoveredJournalCandidate?:IndependentDraftCandidate;
  private sourceRetirement?:IndependentDraftRetirement;
  private sourceCleanupRunning?:Promise<void>;
  private sourceCleanupError:Error|null=null;
  private candidateCanonical?:State;
  private candidateTerminal=false;
  private candidateTerminalError:unknown;
  private candidateRetryStep=0;
  private candidateRetryTimer:ReturnType<typeof setTimeout>|undefined;
  private candidateRetryWake?:()=>void;
  private coreRecoveryPending=false;
  private phase?:{operation?:Operation;input?:DurableWriteInput;plan?:DurableWritePlan;ref?:DurableWriteRef;ack?:DurableWriteOutcome;rejected?:string;conflict:boolean;checkpoint?:CheckpointChange;requestsVersion:number;capture:Readonly<object>|null};
  private coverage?:CoreCoverage;
  private uncertainCoverage?:Omit<CoreCoverage,'revision'>;
  private loadPrepared=false;
  private stateValidated=false;
  private initialActor?:{entryId:string;path:string};
  private sourceRecovery?:{supervisor:NoteLoadSupervisor;check:()=>void;task?:Promise<void>};
  private sourceRecoveryTerminal?:Error;
  private sourceRecoveryRequired=false;
  constructor(vault:Vault,writes:DurableWrites,changed:()=>void){this.vault=vault;this.writes=writes;this.noteScope=Object.freeze({...writes.checkpoints.scope});this.changed=()=>{this.captureProtection();this.protection?.coreSettled();changed();};this.protectionChanged=changed;}
  private protectionChanged:()=>void;
  get ready(){return this.stateValidated;}
  get text(){return this.state!.draft;}
  get conflicted(){return !!this.state?.conflict;}
  get base(){return this.state!.base;}
  get dirty(){return !!this.error||!!this.state&&(this.state.conflict||!!this.state.operation||!!this.uncertain||this.state.draft!==this.state.base.content);}
  get draftProtectionStatus():NoteDraftProtectionStatus|undefined {
    const status=this.protection?.status;
    if(status&&this.protectionCaptureError)return Object.freeze({...status,currentProtected:false,pending:true,error:this.protectionCaptureError});
    return status&&this.sourceCleanupError?Object.freeze({...status,error:status.error??this.sourceCleanupError}):status;
  }
  async flushDraftProtection():Promise<void>{
    if(!this.protectionAdmitted)return;
    this.captureProtection();if(this.protectionCaptureError)throw this.protectionCaptureError;
    const owner=this.protection;
    try{await owner?.flush();}catch(error){if(this.protection===owner||this.protectionStopped)throw error;await this.protection?.flush();}
    await this.cleanupRecoveredSource(true);
  }
  stopDraftProtection():void{this.protectionStopped=true;this.candidateTerminal=true;this.candidateRetryWake?.();this.protection?.stop();this.sourceRecovery?.supervisor.stop();for(const claim of this.captureClaims.values())claim.release();this.captureClaims.clear();}
  draftProtectionAvailable():void{if(!this.protectionAdmitted)return;this.candidateRetryStep=0;this.candidateRetryWake?.();this.protection?.availability();}
  retryCanonicalRecovery():void{
    if(this.protectionStopped)return;
    this.sourceRecovery?.supervisor.wake();
    if(this.candidateCanonical&&this.candidateTerminal){this.candidateTerminal=false;void this.queue(()=>this.persist()).catch(()=>{});}
    this.draftProtectionAvailable();
  }
  get pendingCanonicalRecovery():boolean{return this.sourceRecoveryRequired||!!this.sourceRecovery?.task||!!this.candidateCanonical&&!this.candidateTerminal;}
  get terminalCanonicalRecovery():boolean{return !!this.sourceRecoveryTerminal;}
  assertLoadScope():void{
    if(this.vault.adapter.durableWrites!==this.writes||this.writes.checkpoints.scope.vaultId!==this.noteScope.vaultId||this.writes.checkpoints.scope.clientId!==this.noteScope.clientId)
      throw Object.assign(failure('selected note scope changed before admission'),{code:'intent_identity_mismatch',source:'host'});
  }
  /** Only a positively admitted SAME local authority may wake a retired source
   * wait. Independent-journal availability is not a replacement admission. */
  coreAdmissionAvailable(scope:{vaultId:string;clientId:string}):boolean{
    if(scope.vaultId!==this.noteScope.vaultId||scope.clientId!==this.noteScope.clientId||this.writes.checkpoints.scope.vaultId!==scope.vaultId||this.writes.checkpoints.scope.clientId!==scope.clientId)return false;
    this.sourceRecovery?.supervisor.admissionAvailable();
    for(const owner of this.pendingCaptureOwners.values())owner.supervisor.admissionAvailable();
    for(const release of this.captureReleases.values())release.supervisor.admissionAvailable();
    captureRequestCleanupAdmissionAvailable(this.noteScope);
    return true;
  }
  /** Called only AFTER NoteBuffer has made the validated raw draft usable. */
  startLoadRecovery(check:()=>void):void{
    if(this.sourceRecovery||!this.loadPrepared||this.protectionStopped)return;
    if(!this.sourceRecoveryRequired){if(this.recoveredIndependent)void this.queue(()=>this.persist()).catch(()=>{});this.admitProtection();return;}
    const owner={supervisor:new NoteLoadSupervisor(),check,task:undefined as Promise<void>|undefined};this.sourceRecovery=owner;
    const task=this.queue(async()=>{
      check();if(this.state!.operation?.ref)await this.resume(check);
      this.sourceRecoveryRequired=false;
      if(!this.state!.conflict)this.error=null;
      this.changed();
    });owner.task=task;
    void task.catch(error=>{this.sourceRecoveryTerminal=error instanceof Error?error:failure('source recovery stopped');this.changed();}).finally(()=>{owner.task=undefined;}).catch(()=>{});
    this.admitProtection();
  }
  private admitProtection():void{
    if(this.protectionStopped)return;
    this.protectionAdmitted=true;const pending=this.deferredProtectionInventory;this.deferredProtectionInventory=undefined;
    if(pending)this.protection?.markInventory(pending.state,pending.error);
    this.captureProtection();
  }
  private sourceIO<T>(operation:()=>Promise<T>):Promise<T>{
    const owner=this.sourceRecovery;
    if(!owner?.task)return operation();
    return owner.supervisor.run(operation,()=>{owner.check();if(this.writes.checkpoints.scope.vaultId!==this.noteScope.vaultId||this.writes.checkpoints.scope.clientId!==this.noteScope.clientId)throw failure('source recovery scope changed');},
      {onError:error=>{this.error=error instanceof Error?error:failure('source recovery is waiting');this.changed();}});
  }
  get coreCoversCurrentDraft():boolean{return !!this.state&&this.covered(this.state);}
  get recoveredIndependentDraft():boolean{return this.recoveredIndependent;}
  private coverageFor(state:State):Omit<CoreCoverage,'revision'> {return{writer:state.writer,generation:state.generation,base:{...state.base,stat:{...state.base.stat}},draft:state.draft,clean:!state.conflict&&!state.operation&&state.draft===state.base.content};}
  private covered(state:Pick<State,'writer'|'generation'|'base'|'draft'>):boolean {
    const current=this.state,confirmed=this.coverage;
    return !this.captureRequests.size&&!!current&&!!confirmed&&confirmed.clean&&!this.error&&!this.uncertain&&!current.operation&&!current.conflict&&this.revision===confirmed.revision
      &&state.writer===current.writer&&state.generation===current.generation&&state.draft===current.draft&&current.draft===current.base.content
      &&confirmed.writer===current.writer&&confirmed.generation===current.generation&&confirmed.draft===current.draft
      &&['entryId','path','revision','content'].every(key=>confirmed.base[key as keyof DurableWriteRead]===current.base[key as keyof DurableWriteRead])
      &&['entryId','path','revision','content'].every(key=>state.base[key as keyof DurableWriteRead]===current.base[key as keyof DurableWriteRead]);
  }
  private captureProtection():void {
    const state=this.state;if(!state||!this.protection||!this.protectionAdmitted)return;
    // An unopened clean baseline needs no independent body copy.
    if(!this.protection.status.sequence&&!this.captureRequests.size&&!state.operation&&!state.conflict&&state.draft===state.base.content
      &&(!this.uncertain||!this.protectionAuthoringStarted&&!this.recoveredIndependent))return;
    try{
      const op=state.operation,prior=this.phase;
      if(!prior||prior.operation!==op||prior.input!==op?.input||prior.plan!==op?.plan||prior.ref!==op?.ref||prior.ack!==op?.pendingAck
        ||prior.rejected!==op?.planningRejected||prior.conflict!==state.conflict||prior.checkpoint!==this.uncertain||prior.requestsVersion!==this.captureRequestsVersion){
        const common={conflict:state.conflict,operation:op?frozenPhase(op):null,checkpoint:this.uncertain?frozenPhase(this.uncertain):null};
        const capture=this.captureRequests.size?Object.freeze({schemaVersion:2,...common,captureRequests:Object.freeze([...this.captureRequests.values()])}):op||state.conflict||this.uncertain?Object.freeze({schemaVersion:1,...common}):null;
        this.phase={operation:op,input:op?.input,plan:op?.plan,ref:op?.ref,ack:op?.pendingAck,rejected:op?.planningRejected,conflict:state.conflict,checkpoint:this.uncertain,requestsVersion:this.captureRequestsVersion,capture};
      }
      this.protection.capture({writer:state.writer,snapshot:{generation:state.generation,baseline:{entryId:state.base.entryId,path:state.base.path,revision:state.base.revision,content:state.base.content},draft:state.draft,
        checkpointRevision:this.uncertain?this.uncertain.expectedRevision:this.revision,pendingOperation:this.phase!.capture}});this.protectionCaptureError=null;
    }catch{this.protectionCaptureError=failure('independent capture failed; current draft remains in memory');}
  }
  private async initializeProtection(validate:()=>void,deferRecovery=false):Promise<void>{
    const provider=this.vault.adapter.independentDrafts;if(!provider)return;
    if(provider.scope.vaultId!==this.writes.checkpoints.scope.vaultId||provider.scope.clientId!==this.writes.checkpoints.scope.clientId)throw journalError('draft_scope_mismatch');
    let initialReceipt:IndependentDraftReceipt|undefined,inventory:'ready'|'unknown'|'retained'='unknown',inventoryError:unknown;
    const inspect=async()=>{
      const initial=!this.protection,entryId=this.base.entryId;
      const live=()=>{if(this.protectionStopped||this.base.entryId!==entryId)throw journalError('draft_lease_revoked');if(initial)validate();};
      live();const rows=await provider.list({entryId});live();
      if(!Array.isArray(rows)||rows.some(row=>!this.validJournalReceipt(row)||row.deleted||row.entryId!==entryId))throw journalError('invalid_draft_response');
      inventory=rows.length?'retained':'ready';
      let mayAdopt=!this.protectionAuthoringStarted&&(!this.protection||this.protection.status.sequence===0);
      if(rows.length&&!initial&&mayAdopt){const observed=await this.vault.readDurableTextById(entryId);live();mayAdopt=!!observed&&sameBase(observed,this.base);}
      // Never partially rank a large or mixed-writer inventory. The explicit
      // recovery inventory retains every receipt and can inspect it separately.
      if(rows.length&&rows.length<=16&&mayAdopt&&(rows.length===1||this.revision!==null&&new Set(rows.map(row=>row.writer)).size===1)){
        const candidates:IndependentDraftCandidate[]=[];let verified=true,inspectedBytes=0;
        for(const listed of rows){
          const candidate=await provider.read({entryId,writer:listed.writer,incarnationId:listed.incarnationId});live();
          if(!candidate||candidate.deleted||!this.validJournalReceipt(candidate)||!['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'].every(key=>candidate[key as keyof IndependentDraftReceipt]===listed[key as keyof IndependentDraftReceipt])
            ||!object(candidate.baseline)||candidate.baseline.entryId!==entryId||!validId(candidate.baseline.revision)||typeof candidate.baseline.path!=='string'||typeof candidate.baseline.content!=='string'||typeof candidate.draft!=='string'
            ||!validCheckpointReference(candidate.checkpointRevision)||!(candidate.pendingOperation===null||typeof candidate.pendingOperation==='string')){verified=false;break;}
          inspectedBytes+=(candidate.baseline.content.length+candidate.draft.length+(candidate.pendingOperation?.length??0))*2;
          if(inspectedBytes>32*1024*1024){verified=false;break;}
          candidates.push(candidate);
        }
        const eligible=verified?candidates.filter(candidate=>!!this.planJournalCandidate(candidate)):[];
        if(eligible.length===1&&candidates.every(candidate=>candidate===eligible[0]||this.historicalJournalCandidate(candidate))){
          const candidate=eligible[0];
          const adopt=()=>this.adoptJournalCandidate(candidate,live);
          const adopted=initial?await adopt():await this.queue(adopt);
          live();if(adopted){inventory='ready';this.recoveredJournalCandidate=Object.freeze({...candidate,baseline:Object.freeze({...candidate.baseline})});this.recoveredIndependent=true;
            if(candidate.incarnationId===provider.scope.incarnationId)initialReceipt=candidate;
          }
        }
      }
      const own=await provider.read({entryId,writer:this.state!.writer});live();
      if(own&&(!this.validJournalReceipt(own)||own.entryId!==entryId||own.writer!==this.state!.writer||own.incarnationId!==provider.scope.incarnationId))throw journalError('invalid_draft_response');
      if(own?.deleted)initialReceipt=own;
      // Unknown inventory may have held local captures without issuing any CAS.
      // Rebuild only that unused lane when a verified current tombstone appears.
      if(this.protection&&!this.protection.status.protection&&initialReceipt){this.protection.stop();this.protection=undefined;create();}
      this.protection?.markInventory(inventory);this.captureProtection();
    };
    try{await inspect();}catch(error){inventory='unknown';inventoryError=error;}
    validate();if(this.protectionStopped)throw journalError('draft_lease_revoked');
    const create=()=>{this.protection=new NoteDraftProtection({provider,writesScope:this.writes.checkpoints.scope,initialReceipt,onStatus:()=>{this.protectionChanged();void this.cleanupRecoveredSource().catch(()=>{});},
      coreCovered:(capture:NoteDraftCapture)=>this.covered({writer:capture.writer,generation:capture.snapshot.generation,draft:capture.snapshot.draft,base:{...capture.snapshot.baseline,stat:this.base.stat}}),
      getCleanWitness:capture=>this.covered({writer:capture.writer,generation:capture.snapshot.generation,draft:capture.snapshot.draft,base:{...capture.snapshot.baseline,stat:this.base.stat}})
        ?{entryId:this.base.entryId,writer:this.state!.writer,generation:this.state!.generation,content:this.text,revision:this.base.revision}:undefined,
      retryInventory:inspect});};
    create();
    if(deferRecovery)this.deferredProtectionInventory={state:inventory,error:inventoryError};
    else{this.protection!.markInventory(inventory,inventoryError);this.captureProtection();}
    if(this.recoveredIndependent&&!deferRecovery)void this.queue(()=>this.persist()).catch(()=>{});
  }
  private validJournalReceipt(value:IndependentDraftReceipt):boolean {
    const scope=this.writes.checkpoints.scope;
    return object(value)&&value.vaultId===scope.vaultId&&value.clientId===scope.clientId&&validId(value.incarnationId)&&validId(value.entryId)&&validId(value.writer)
      &&typeof value.revision==='string'&&/^[1-9][0-9]{0,19}$/.test(value.revision)&&BigInt(value.revision)<=18446744073709551615n&&validGeneration(value.generation)&&typeof value.deleted==='boolean';
  }
  private async adoptJournalCandidate(candidate:IndependentDraftCandidate,validate:()=>void):Promise<boolean>{
    const before=this.state!;
    const current=()=>!this.protectionAuthoringStarted&&!this.protectionStopped&&this.state===before&&this.state.generation===beforeGeneration&&this.state.draft===beforeDraft;
    const beforeGeneration=before.generation,beforeDraft=before.draft;
    const plan=this.planJournalCandidate(candidate);if(!current()||!plan)return false;
    validate();if(!current())return false;
    if(plan.exact){this.uncertain=plan.exact;this.uncertainCoverage=this.coverageFor(plan.canonical);this.candidateCanonical=plan.canonical;this.candidateTerminal=false;}
    this.state={version:1,writer:candidate.writer,generation:candidate.generation,base:plan.canonical.base,draft:candidate.draft,conflict:false};
    // The validated raw draft is usable before this pure checkpoint replay.
    // Only revision metadata settles later; S1 must never replace visible D2/D3.
    this.error=null;this.phase=undefined;this.captureProtection();this.protectionChanged();
    if(this.protection)void this.queue(()=>this.persist()).catch(()=>{});
    return true;
  }
  /** V1 remains exact. V2 adds only a bounded, immutable request collection. */
  private captureCapsule(candidate:IndependentDraftCandidate):{conflict:boolean;operation:Record<string,any>|null;checkpoint:Record<string,any>|null;captureRequests:readonly ProtectedCaptureRequest[]}|undefined {
    if(candidate.pendingOperation===null)return;
    try{
      const value=JSON.parse(candidate.pendingOperation);
      if(!object(value)||!['schemaVersion','conflict','operation','checkpoint','captureRequests'].every(key=>Object.hasOwn(value,key))||Object.keys(value).length!==5
        ||value.schemaVersion!==2||typeof value.conflict!=='boolean'||!(value.operation===null||object(value.operation))||!(value.checkpoint===null||object(value.checkpoint))
        ||!Array.isArray(value.captureRequests)||!value.captureRequests.length||value.captureRequests.length>8)return;
      const ids=new Set<string>();
      for(const request of value.captureRequests){
        if(!object(request)||Object.keys(request).length!==3||typeof request.captureId!=='string'||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.captureId)||ids.has(request.captureId)
          ||!object(request.logicalWitness)||Object.keys(request.logicalWitness).length!==3||request.logicalWitness.entryId!==candidate.entryId||!validId(request.logicalWitness.revision)||typeof request.logicalWitness.path!=='string'
          ||!object(request.scope)||Object.keys(request.scope).length!==3||!['vaultId','clientId','incarnationId'].every(key=>request.scope[key]===candidate[key as keyof IndependentDraftCandidate]))return;
        ids.add(request.captureId);
      }
      return{conflict:value.conflict,operation:value.operation,checkpoint:value.checkpoint,captureRequests:value.captureRequests};
    }catch{return;}
  }
  /** Every unsettled serialized operation remains reachable, including an old
   * uncertain CAS and journal writes superseded in memory but not acknowledged. */
  private captureReferenced(id:string):boolean {
    const references=(value:unknown,depth=0):boolean=>{
      if(depth>20)return true;
      if(!value||typeof value!=='object')return false;
      if(Array.isArray(value))return value.some(item=>references(item,depth+1));
      const record=value as Record<string,unknown>;
      if(record.captureId===id)return true;
      return Object.values(record).some(item=>references(item,depth+1));
    };
    const encodedReferences=(encoded:string|null|undefined):boolean=>{if(!encoded)return false;try{return references(JSON.parse(encoded));}catch{return true;}};
    if(references(this.state?.operation)||encodedReferences(this.confirmedState)||encodedReferences(this.uncertain?.encodedState))return true;
    for(const write of this.protection?.retainedWriteRequests??[]){
      if(!write.pendingOperation)continue;
      try{const capsule=JSON.parse(write.pendingOperation);if(references(capsule.operation)||encodedReferences(capsule.checkpoint?.encodedState))return true;}catch{return true;}
    }
    return false;
  }
  private captureCleanup?:Promise<void>;
  /** Bounded pending discovery supplies entry IDs; no vault/index/body scan.
   * A matching old journal claim plus a trusted retired-owner certificate is
   * required. Missing, legacy, corrupt, or ambiguous evidence stays protected. */
  private cleanupAbandonedCaptureRequests():Promise<void>{
    if(this.captureCleanup)return this.captureCleanup;
    const provider=this.vault.adapter.independentDrafts;
    if(!provider?.isRetiredIncarnation||!this.writes.listSavedSourceRequests||!this.writes.releaseSavedSource)return Promise.resolve();
    const inspect=async(entryId:string,rows:readonly IndependentDraftReceipt[]):Promise<IndependentDraftCandidate[]|undefined>=>{
      if(!Array.isArray(rows)||rows.length>16||!rows.length||rows.some(row=>!this.validJournalReceipt(row)||row.entryId!==entryId||row.deleted))return;
      const candidates:IndependentDraftCandidate[]=[];let bytes=0;
      for(const row of rows){const value=await provider.read({entryId,writer:row.writer,incarnationId:row.incarnationId});
        if(!value||value.deleted||!this.validJournalReceipt(value)||!['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'].every(key=>value[key as keyof IndependentDraftReceipt]===row[key as keyof IndependentDraftReceipt])
          ||!object(value.baseline)||value.baseline.entryId!==entryId||!validId(value.baseline.revision)||typeof value.baseline.path!=='string'||typeof value.baseline.content!=='string'||typeof value.draft!=='string'
          ||!validCheckpointReference(value.checkpointRevision)||!(value.pendingOperation===null||typeof value.pendingOperation==='string'))return;
        bytes+=(value.baseline.content.length+value.draft.length+(value.pendingOperation?.length??0))*2;if(bytes>32*1024*1024)return;candidates.push(value);
      }
      return candidates;
    };
    const cleanup=(async()=>{
      this.assertLoadScope();await retryCaptureRequestCleanups(this.noteScope);const pending=await this.writes.listSavedSourceRequests!();
      if(!Array.isArray(pending)||pending.length>8)return;
      for(const request of pending){
        if(!object(request)||request.legacy!==false||!validId(request.captureId)||!object(request.logicalWitness)||!validId(request.logicalWitness.entryId)||!validId(request.logicalWitness.revision)||typeof request.logicalWitness.path!=='string'
          ||this.captureRequests.has(request.captureId)||this.captureReferenced(request.captureId))continue;
        const captureId=request.captureId,logicalWitness=Object.freeze({...request.logicalWitness});
        const reservation=reserveCaptureRequestCleanup(this.noteScope,captureId,()=>this.releaseCapture(captureId),()=>{this.assertLoadScope();this.captureReleases.get(captureId)?.supervisor.admissionAvailable();});if(!reservation)continue;
        try{
          const entryId=logicalWitness.entryId,rows=await provider.list({entryId});
          if(!Array.isArray(rows)||rows.length>16||!rows.length||rows.some(row=>!this.validJournalReceipt(row)||row.entryId!==entryId||row.deleted))continue;
          const certificates=new Map<string,boolean>();
          for(const row of rows)if(row.incarnationId!==provider.scope.incarnationId&&!certificates.has(row.incarnationId)){
            try{certificates.set(row.incarnationId,await provider.isRetiredIncarnation!(row.incarnationId)===true);}catch{certificates.set(row.incarnationId,false);}
          }
          // Every body/reference read follows Core drainage. Current or other
          // live rows are blocking evidence, never abandonment authority.
          const candidates=await inspect(entryId,rows);if(!candidates)continue;
          const matching=candidates.filter(candidate=>this.captureCapsule(candidate)?.captureRequests.some(claim=>claim.captureId===captureId));
          if(matching.length!==1)continue;const owner=matching[0];
          if(certificates.get(owner.incarnationId)!==true||!reservation.owns())continue;
          const head=await this.writes.checkpoints.load(`note/v1/${entryId}`);
          if(head!==null&&(!object(head)||head.vaultId!==this.noteScope.vaultId||head.clientId!==this.noteScope.clientId||head.key!==`note/v1/${entryId}`||head.version!==1
            ||Reflect.ownKeys(head).length!==9||!validCheckpointReference(head.revision)||head.revision===null||typeof head.sequence!=='string'||!/^[1-9][0-9]{0,19}$/.test(head.sequence)||BigInt(head.sequence)>18446744073709551615n
            ||!Number.isSafeInteger(head.byteLength)||head.byteLength<0||head.byteLength>checkpointStateLimit||!(head.encodedState===null||typeof head.encodedState==='string')||head.deleted!==(head.encodedState===null)
            ||(head.encodedState===null?head.byteLength!==0:boundedUtf8(head.encodedState,checkpointStateLimit)!==head.byteLength)))continue;
          const canonical=head?.encodedState?plainCheckpointState(head.encodedState):null;
          if(head?.encodedState&&!canonical||canonical&&canonical.base.entryId!==entryId)continue;
          let found=false,blocked=false;
          for(const candidate of candidates){
            if(candidate.pendingOperation===null)continue;
            let capsule:any;try{capsule=JSON.parse(candidate.pendingOperation);}catch{blocked=true;break;}
            const decoded=this.captureCapsule(candidate);
            if(!decoded&&(!object(capsule)||capsule.schemaVersion!==1||Object.keys(capsule).length!==4||typeof capsule.conflict!=='boolean'||!(capsule.operation===null||object(capsule.operation))||!(capsule.checkpoint===null||object(capsule.checkpoint)))){blocked=true;break;}
            // Current rows supply blocking references, never retirement authority.
            if(capsule.operation!==null){blocked=true;break;}
            if(capsule.checkpoint!==null){try{if(!object(capsule.checkpoint)||Object.keys(capsule.checkpoint).length!==4||capsule.checkpoint.key!==`note/v1/${entryId}`||!plainCheckpointState(capsule.checkpoint.encodedState)){blocked=true;break;}}catch{blocked=true;break;}}
            const claim=decoded?.captureRequests.find(value=>value.captureId===captureId);
            if(claim){
              if(found||candidate.writer!==owner.writer||candidate.incarnationId!==owner.incarnationId||!['entryId','revision','path'].every(key=>claim.logicalWitness[key as keyof ConditionalSavedSourceWitness]===logicalWitness[key as keyof ConditionalSavedSourceWitness])){blocked=true;break;}
              found=true;
            }
          }
          this.assertLoadScope();
          if(blocked||!found||this.captureRequests.has(captureId)||this.captureReferenced(captureId)||!reservation.seal())continue;
          // No await separates the sealed ownership check from exact dispatch.
          await reservation.release();
        }finally{reservation.finish();}
      }
    })().catch(()=>{/* Unknown evidence never grants release or blocks startup. */});
    this.captureCleanup=cleanup;void cleanup.finally(()=>{if(this.captureCleanup===cleanup)this.captureCleanup=undefined;});return cleanup;
  }
  private checkpointCapsule(candidate:IndependentDraftCandidate):JournalCandidatePlan|undefined {
    if(candidate.pendingOperation===null)return;
    let capsule:any;try{capsule=JSON.parse(candidate.pendingOperation);}catch{return;}
    const request=capsule?.checkpoint;
    if(!object(capsule)||!(capsule.schemaVersion===1&&Object.keys(capsule).length===4||!!this.captureCapsule(candidate))||capsule.conflict!==false||capsule.operation!==null||!object(request)
      ||Object.keys(request).length!==4||request.key!==this.key||request.expectedRevision!==candidate.checkpointRevision
      ||request.nextRevision===request.expectedRevision||typeof request.encodedState!=='string')return;
    let exact:CheckpointChange;
    try{exact=snapshotCheckpointChange(request as CheckpointChange).change;}catch{return;}
    const stored=plainCheckpointState(request.encodedState);
    if(!stored||stored.writer!==candidate.writer||!sameBase(stored.base,candidate.baseline)||stored.generation>candidate.generation||stored.generation===candidate.generation&&stored.draft!==candidate.draft)return;
    return{canonical:stored,exact};
  }
  private planJournalCandidate(candidate:IndependentDraftCandidate):JournalCandidatePlan|undefined {
    const before=this.state!;
    if(before.operation||before.conflict||!sameBase(candidate.baseline,before.base)||candidate.generation<before.generation||!object(before.base.stat)
      ||!['ctime','mtime','size'].every(key=>typeof before.base.stat[key as keyof typeof before.base.stat]==='number'&&Number.isFinite(before.base.stat[key as keyof typeof before.base.stat])&&before.base.stat[key as keyof typeof before.base.stat]>=0)
      ||!Number.isSafeInteger(before.base.stat.size))return;
    const capsule=this.captureCapsule(candidate);
    if(capsule&&(capsule.conflict||capsule.operation!==null))return;
    if(candidate.pendingOperation!==null&&!(capsule&&capsule.checkpoint===null)){
      const plan=this.checkpointCapsule(candidate);if(!plan?.exact)return;
      const exact=plan.exact,stored=plan.canonical;
      if(this.uncertain&&['key','expectedRevision','nextRevision','encodedState'].some(key=>this.uncertain![key as keyof CheckpointChange]!==exact[key as keyof CheckpointChange]))return;
      const already=this.revision===exact.nextRevision&&this.confirmedState===exact.encodedState;
      const expectedState=this.confirmedState?plainCheckpointState(this.confirmedState):undefined;
      const expected=this.revision===exact.expectedRevision&&(this.revision===null?this.confirmedState==null:
        !!expectedState&&expectedState.writer===candidate.writer&&sameBase(expectedState.base,stored.base)&&expectedState.generation<=stored.generation&&(expectedState.generation!==stored.generation||expectedState.draft===stored.draft));
      return already||expected?plan:undefined;
    }else{
      if(this.uncertain)return;
      const initial=this.revision===null&&this.confirmedState==null&&candidate.checkpointRevision===null&&before.generation===0&&before.draft===before.base.content;
      if(!initial&&(candidate.writer!==before.writer||candidate.checkpointRevision!==this.revision))return;
      if(candidate.generation===before.generation&&candidate.draft!==before.draft)return;
      return{canonical:before};
    }
  }
  private historicalJournalCandidate(candidate:IndependentDraftCandidate):boolean {
    const canonical=this.confirmedState?plainCheckpointState(this.confirmedState):undefined;
    return this.revision!==null&&!!canonical&&candidate.writer===canonical.writer&&candidate.generation<canonical.generation
      &&(candidate.checkpointRevision!==this.revision||!sameBase(candidate.baseline,canonical.base))
      &&(candidate.pendingOperation===null||!!this.checkpointCapsule(candidate));
  }
  private async settleCandidateCheckpoint():Promise<void>{
    const exact=this.uncertain!,canonical=this.candidateCanonical!;
    const scope=this.noteScope;this.candidateTerminal=false;
    for(;;){
      if(this.protectionStopped||this.uncertain!==exact||this.candidateCanonical!==canonical||this.key!==`note/v1/${this.base.entryId}`
        ||this.writes.checkpoints.scope.vaultId!==scope.vaultId||this.writes.checkpoints.scope.clientId!==scope.clientId){
        this.candidateTerminal=true;this.candidateTerminalError=journalError('draft_lease_revoked');throw this.candidateTerminalError;
      }
      try{
        const result=this.acceptCheckpoint(await this.writes.checkpoints.compareAndSwap(exact),exact);
        this.revision=result.revision;this.confirmedState=exact.encodedState;this.coverage={...this.coverageFor(canonical),revision:result.revision};this.uncertain=undefined;this.uncertainCoverage=undefined;
        this.candidateCanonical=undefined;this.candidateRetryStep=0;if(this.error===this.candidateTerminalError)this.error=null;this.candidateTerminalError=undefined;
        this.coreProtectionProgress();this.captureProtection();this.protectionChanged();return;
      }catch(error){
        const value=error&&typeof error==='object'?error as {code?:unknown;source?:unknown}:undefined,code=String(value?.code??'');
        const provenance=value?.source===undefined||value.source==='host'||value.source==='transport';
        const admission=provenance&&['host_exited','host_unavailable','client_not_admitted','client_ownership_lost','desktop_recovery_pending'].includes(code);
        const nativeTransient=value?.source==='host'&&['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout'].includes(code);
        const transportTransient=value?.source==='transport'&&code==='durable_transport_lost';
        const transient=nativeTransient||transportTransient||provenance&&['outcome_unknown','transport_io','host_timeout','transport_error','transport_lost','timeout','request_timeout',
          'busy','io','checkpoint_unavailable','temporarily_unavailable'].includes(code);
        if(!admission&&!transient){this.candidateTerminal=true;this.candidateTerminalError=error;throw error;}
        await this.waitForCandidateRetry(admission?undefined:[500,1500,4000,30000][Math.min(this.candidateRetryStep++,3)]);
      }
    }
  }
  private waitForCandidateRetry(delay?:number):Promise<void>{
    return new Promise(resolve=>{
      const wake=()=>{if(this.candidateRetryWake!==wake)return;if(this.candidateRetryTimer!==undefined)clearTimeout(this.candidateRetryTimer);this.candidateRetryTimer=undefined;this.candidateRetryWake=undefined;resolve();};
      this.candidateRetryWake=wake;if(delay!==undefined)this.candidateRetryTimer=setTimeout(wake,delay);
      this.protectionChanged();if(this.protectionStopped)wake();
    });
  }
  private cleanupRecoveredSource(retry=false):Promise<void>{
    if(this.sourceCleanupRunning)return this.sourceCleanupRunning;
    const candidate=this.recoveredJournalCandidate,provider=this.vault.adapter.independentDrafts,state=this.state;
    if(!candidate||!provider||!state||this.protectionStopped||!this.protectionAdmitted||candidate.incarnationId===provider.scope.incarnationId||this.sourceCleanupError&&!retry)return Promise.resolve();
    if(candidate.pendingOperation!==null){const capsule=this.captureCapsule(candidate);if(capsule?.captureRequests.length)return Promise.resolve();}
    if(!this.sourceRetirement){
      if(!this.covered(state)||!this.protection?.status.currentJournalAcknowledged||candidate.writer!==state.writer||candidate.generation!==state.generation||candidate.draft!==state.draft)return Promise.resolve();
      const next=BigInt(candidate.revision)+1n;if(next>18446744073709551615n)return Promise.resolve();
      this.sourceRetirement=Object.freeze({entryId:candidate.entryId,writer:candidate.writer,incarnationId:candidate.incarnationId,generation:candidate.generation,expectedRevision:candidate.revision,nextRevision:String(next)});
    }
    const request=this.sourceRetirement;
    const cleanup=(async()=>{
      const receipt=await provider.retire(request);
      if(!this.validJournalReceipt(receipt)||receipt.incarnationId!==candidate.incarnationId||receipt.entryId!==candidate.entryId||receipt.writer!==candidate.writer
        ||receipt.generation!==candidate.generation||receipt.revision!==request.nextRevision||!receipt.deleted)throw journalError('invalid_draft_response');
      if(this.recoveredJournalCandidate===candidate)this.recoveredJournalCandidate=undefined;
      this.sourceRetirement=undefined;this.sourceCleanupError=null;
    })().catch(error=>{this.sourceCleanupError=error instanceof Error?error:journalError('draft_storage_failure');throw error;});
    this.sourceCleanupRunning=cleanup;
    void cleanup.finally(()=>{if(this.sourceCleanupRunning===cleanup)this.sourceCleanupRunning=undefined;if(!this.protectionStopped)this.protectionChanged();}).catch(()=>{});
    return cleanup;
  }
  private queue<T>(run:()=>Promise<T>):Promise<T>{const p=this.tail.then(run).catch(error=>{this.error=error instanceof Error?error:failure('operation failed');this.coreRecoveryPending=true;this.changed();throw this.error;});this.tail=p.catch(()=>{});return p;}
  private coreProtectionProgress():void {
    // Only a failed-to-healthy transition signals availability. Healthy typing
    // checkpoints do not bypass the independent storage retry backoff.
    if(this.coreRecoveryPending){this.coreRecoveryPending=false;this.protection?.availability();}
    this.protection?.coreSettled();
  }
  private checkIdentity(value:DurableWritePlan|DurableWriteRef){const scope=this.writes.checkpoints.scope;if(value.vaultId!==scope.vaultId||value.clientId!==scope.clientId||value.entryId!==this.base.entryId||!value.operationId)throw failure('checkpoint identity mismatch');}
  private checkPlan(plan:DurableWritePlan):void {
    this.checkIdentity(plan);boundedUtf8(plan.encodedPlan,8*1024*1024,'plan_too_large');
    if(Object.hasOwn(plan,'canonicalContent')){
      if(typeof plan.canonicalContent!=='string')throw failure('invalid canonical write content');
      boundedUtf8(plan.canonicalContent,8*1024*1024,'plan_too_large');
    }
  }
  conditionalSavedSourceStatus(capture:ConditionalSavedSourceCapture):ConditionalSavedSourceStatus{return this.captures.get(capture)??'foreign';}
  private checkWitness(witness:ConditionalSavedSourceWitness):void {
    const base=this.base;
    if(!witness||witness.entryId!==base.entryId||witness.revision!==base.revision||witness.path!==base.path)throw failure('conditional source belongs to another logical baseline');
  }
  private captureRequestAcknowledged(ack:DraftProtectionAcknowledgement,request:ProtectedCaptureRequest):boolean {
    if(ack.receipt.vaultId!==request.scope.vaultId||ack.receipt.clientId!==request.scope.clientId||ack.receipt.incarnationId!==request.scope.incarnationId||ack.request.entryId!==request.logicalWitness.entryId||typeof ack.request.pendingOperation!=='string')return false;
    try{const capsule=JSON.parse(ack.request.pendingOperation);
      return object(capsule)&&capsule.schemaVersion===2&&Array.isArray(capsule.captureRequests)&&capsule.captureRequests.some((value:any)=>
        object(value)&&value.captureId===request.captureId&&object(value.logicalWitness)&&['entryId','revision','path'].every(key=>value.logicalWitness[key]===request.logicalWitness[key as keyof ConditionalSavedSourceWitness])
        &&object(value.scope)&&['vaultId','clientId','incarnationId'].every(key=>value.scope[key]===request.scope[key as keyof IndependentDraftScope]));
    }catch{return false;}
  }
  private claimCapture(id:string):void {if(!this.captureClaims.has(id))this.captureClaims.set(id,claimCaptureRequest(this.noteScope,id,this));}
  private async claimLoadedCapture(op:Operation,validate:()=>void):Promise<void>{
    const id=op.input?.conditionalSavedSource?.captureId;if(!id)return;
    for(;;){validate();if(this.protectionStopped)throw failure('the note actor stopped before capture adoption');try{this.claimCapture(id);return;}catch(error){
      if(!error||typeof error!=='object'||Object.getOwnPropertyDescriptor(error,'code')?.value!=='capture_cleanup_pending')throw error;
      const wait=Object.getOwnPropertyDescriptor(error,'wait')?.value;if(!(wait instanceof Promise))throw error;await wait;
    }}
  }
  private forgetCaptureRequest(id:string):void {
    this.captureClaims.get(id)?.release();this.captureClaims.delete(id);
    if(this.captureRequests.delete(id)){this.captureRequestsVersion++;this.captureProtection();}
  }
  /** Freeze and protect the identity before either serialized save lane. Only
   * Native dispatch joins those lanes; the independent ACK never waits for Rust. */
  captureConditionalSavedSource(witness:ConditionalSavedSourceWitness,validate:()=>void,serialize:<T>(run:()=>Promise<T>)=>Promise<T>=run=>run()):Promise<ConditionalSavedSourceCapture|undefined>{
    let request:ProtectedCaptureRequest,owner:{controller:AbortController;supervisor:NoteLoadSupervisor};
    try{
      validate();this.checkWitness(witness);
      if(!this.writes.captureSavedSource&&!this.writes.releaseSavedSource&&!this.writes.listSavedSourceRequests)return Promise.resolve(undefined);
      if(!this.writes.captureSavedSource||!this.writes.releaseSavedSource||!this.writes.listSavedSourceRequests)throw failure('conditional saved-source capability is incomplete');
      const provider=this.vault.adapter.independentDrafts;
      if(!provider||!this.protection||!this.protectionAdmitted||provider.scope.vaultId!==this.noteScope.vaultId||provider.scope.clientId!==this.noteScope.clientId)throw failure('conditional saved-source capture requires independent protection');
      if(this.captureRequests.size>=8)throw failure('too many retained capture requests');
      request=Object.freeze({captureId:crypto.randomUUID(),logicalWitness:Object.freeze({...witness}),scope:Object.freeze({...provider.scope})});
      this.claimCapture(request.captureId);
      owner={controller:new AbortController(),supervisor:new NoteLoadSupervisor()};this.pendingCaptureOwners.set(request.captureId,owner);
      this.captureRequests.set(request.captureId,request);this.captureRequestsVersion++;this.captureProtection();
      if(this.protectionCaptureError)throw this.protectionCaptureError;
    }catch(error){return Promise.reject(error);}
    const acknowledged=this.protection!.flushCapture(ack=>this.captureRequestAcknowledged(ack,request),{signal:owner.controller.signal});
    void acknowledged.catch(()=>{});
    const check=()=>{validate();this.assertLoadScope();this.checkWitness(request.logicalWitness);if(owner.controller.signal.aborted)throw failure('conditional source owner was cancelled');};
    const task=serialize(()=>this.queue(async()=>{
      let received=false,dispatched=false;
      try{
        await acknowledged;check();await owner.supervisor.run(()=>this.cleanupAbandonedCaptureRequests(),check,{signal:owner.controller.signal});check();
        for(const id of this.abandonedCaptures){await this.releaseCapture(id);this.abandonedCaptures.delete(id);this.forgetCaptureRequest(id);}
        if(this.state!.conflict||this.state!.operation)throw failure('settle the retained note write before capturing another conditional source');
        const claim=Object.freeze({captureId:request.captureId,logicalWitness:request.logicalWitness});
        const capture=await owner.supervisor.run(async()=>{
          try{dispatched=true;return await this.writes.captureSavedSource!(claim);}
          catch(error){if(error&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'source')?.value==='host'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='source_capture_capacity'){await this.cleanupAbandonedCaptureRequests();check();await recoverNoteCaptureCapacity(this.writes,this.base.entryId,check);}throw error;}
        },check,{signal:owner.controller.signal});
        received=true;check();
        if(!capture||capture.captureId!==request.captureId||typeof capture.source!=='string')throw failure('invalid conditional saved-source capture');
        boundedUtf8(capture.source,8*1024*1024,'capture_too_large');this.checkWitness(capture.logicalWitness);
        if(this.state!.conflict||this.state!.operation)throw failure('the note write changed during source capture');
        const owned=Object.freeze({...capture,logicalWitness:Object.freeze({...capture.logicalWitness})});
        this.captures.set(owned,'unattached');this.activeCaptures.set(owned.captureId,owned);return owned;
      }catch(error){
        // Unknown outcomes retain the original claim. Explicit cancellation and
        // invalid late replies fence that exact ID even if its first ACK was lost.
        let cancelled=owner.controller.signal.aborted;try{check();}catch(ownerError){cancelled=true;error=ownerError;}
        if(!dispatched||received||cancelled){
          try{await this.releaseCapture(request.captureId);this.forgetCaptureRequest(request.captureId);}
          catch(releaseError){this.abandonedCaptures.add(request.captureId);throw releaseError;}
        }
        throw error;
      }finally{owner.supervisor.stop();this.pendingCaptureOwners.delete(request.captureId);}
    }));
    return task;
  }
  cancelPendingConditionalSavedSources():void {for(const owner of this.pendingCaptureOwners.values())owner.controller.abort();}
  private releaseCapture(id:string):Promise<void>{
    const existing=this.captureReleases.get(id);if(existing)return existing.task;
    const supervisor=new NoteLoadSupervisor();
    const task=supervisor.run(()=>this.writes.releaseSavedSource!(id),()=>this.assertLoadScope());
    const owner={supervisor,task};this.captureReleases.set(id,owner);
    void task.finally(()=>{supervisor.stop();if(this.captureReleases.get(id)===owner)this.captureReleases.delete(id);}).catch(()=>{});return task;
  }
  releaseConditionalSavedSource(capture:ConditionalSavedSourceCapture):Promise<void>{
    const pending=this.releasingCaptures.get(capture);if(pending)return pending;
    if(this.conditionalSavedSourceStatus(capture)!=='unattached')return Promise.reject(failure('only an unattached conditional source can be released by its caller'));
    const releasing=(async()=>{await this.releaseCapture(capture.captureId);this.captures.set(capture,'settled');this.activeCaptures.delete(capture.captureId);this.forgetCaptureRequest(capture.captureId);})();
    this.releasingCaptures.set(capture,releasing);
    void releasing.finally(()=>{if(this.releasingCaptures.get(capture)===releasing)this.releasingCaptures.delete(capture);}).catch(()=>{});
    return releasing;
  }
  /** Retirement releases only proofs that have never entered a write intent.
   * Join an existing release; failed cleanup keeps this buffer owned/retryable. */
  releaseUnattachedConditionalSavedSources():Promise<void>{return this.queue(async()=>{
    for(const capture of this.activeCaptures.values())if(this.conditionalSavedSourceStatus(capture)==='unattached')await this.releaseConditionalSavedSource(capture);
    for(const request of this.captureRequests.values())if(!this.captureReferenced(request.captureId)){
      await this.releaseCapture(request.captureId);this.abandonedCaptures.delete(request.captureId);this.forgetCaptureRequest(request.captureId);
    }
  });}
  validateConditionalSavedSource(capture:ConditionalSavedSourceCapture):void {
    if(this.conditionalSavedSourceStatus(capture)!=='unattached')throw failure('conditional source was already attached or belongs to another buffer');
    if(this.releasingCaptures.has(capture))throw failure('conditional source release is pending');
    this.checkWitness(capture.logicalWitness);
    if(this.state!.conflict||this.state!.operation)throw failure('another retained note write owns this buffer');
  }
  private async releaseOperationCapture(op:Operation):Promise<void>{
    const guard=op.input?.conditionalSavedSource;if(!guard)return;
    if(!this.writes.releaseSavedSource)throw failure('conditional source release is unavailable');
    await this.sourceIO(()=>this.releaseCapture(guard.captureId));
    this.forgetCaptureRequest(guard.captureId);
    const capture=this.activeCaptures.get(guard.captureId);
    if(capture){this.captures.set(capture,'settled');this.activeCaptures.delete(guard.captureId);}
  }
  private checkInput(op:Operation):void {
    const input=op.input,guard=input?.conditionalSavedSource,witness=guard?.logicalWitness;
    if(!input||typeof input.operationId!=='string'||!input.operationId||input.expectedEntryId!==this.base.entryId||typeof input.expectedRevision!=='string'||typeof input.expectedContent!=='string'||typeof input.path!=='string'||input.content!==op.content||!guard||typeof guard.captureId!=='string'||!guard.captureId||!witness||witness.entryId!==input.expectedEntryId||witness.revision!==input.expectedRevision||witness.path!==input.path)throw failure('invalid saved conditional write input');
    boundedUtf8(JSON.stringify(input),32*1024*1024,'checkpoint_too_large');
    if(op.plan&&(op.plan.operationId!==input.operationId||op.plan.entryId!==input.expectedEntryId))throw failure('conditional input/plan mismatch');
    if(!op.pendingAck&&(input.path!==this.base.path||input.expectedRevision!==this.base.revision||input.expectedContent!==this.base.content))throw failure('saved conditional input does not match its retained baseline');
    if(op.planningRejected!==undefined&&(!['revision_conflict','source_capture_expired','conditional_source_changed'].includes(op.planningRejected)||op.ref))throw failure('invalid saved conditional planning rejection');
  }
  /** A returned revision alone proves neither this note's head nor the bytes
   * requested by a CAS. Validate the complete receipt before advancing any
   * local ownership/coverage state, including on an exact uncertain retry. */
  private acceptCheckpoint(value:unknown,change?:CheckpointChange):Checkpoint {
    try{
      const keys=['version','vaultId','clientId','key','revision','sequence','deleted','byteLength','encodedState'];
      if(!object(value)||Reflect.ownKeys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'))
        ||this.writes.checkpoints.scope.vaultId!==this.noteScope.vaultId||this.writes.checkpoints.scope.clientId!==this.noteScope.clientId
        ||value.version!==1||value.vaultId!==this.noteScope.vaultId||value.clientId!==this.noteScope.clientId||value.key!==this.key
        ||typeof value.deleted!=='boolean'||!Number.isSafeInteger(value.byteLength)||value.byteLength<0||value.byteLength>checkpointStateLimit
        ||typeof value.sequence!=='string'||!/^[1-9][0-9]{0,19}$/.test(value.sequence)||BigInt(value.sequence)>18446744073709551615n)throw Error();
      checkpointRevision(value.revision);
      if(value.encodedState===null?!value.deleted||value.byteLength!==0:value.deleted||boundedUtf8(value.encodedState,checkpointStateLimit)!==value.byteLength)throw Error();
      if(change&&(change.key!==this.key||value.revision!==change.nextRevision||value.encodedState!==change.encodedState||value.deleted!==(change.encodedState===null)))throw Error();
      return Object.freeze({version:1,...this.noteScope,key:this.key,revision:value.revision,sequence:value.sequence,deleted:value.deleted,byteLength:value.byteLength,encodedState:value.encodedState}) as Checkpoint;
    }catch{
      throw Object.assign(failure('checkpoint reply did not prove the requested note state; exact recovery retained'),{code:'invalid_durable_response',source:'protocol',commitUncertain:!!change});
    }
  }
  private async persist(state=this.state):Promise<void>{
    if(this.sourceRecoveryTerminal)throw this.sourceRecoveryTerminal;
    if(this.candidateCanonical&&this.candidateTerminal)throw this.candidateTerminalError;
    if(this.candidateCanonical&&this.uncertain)await this.settleCandidateCheckpoint();
    this.captureProtection();
    if(this.uncertain){const exact=this.uncertain,result=await this.sourceIO(async()=>this.acceptCheckpoint(await this.writes.checkpoints.compareAndSwap(exact),exact));this.revision=result.revision;this.confirmedState=exact.encodedState;
      if(this.uncertainCoverage)this.coverage={...this.uncertainCoverage,revision:result.revision};this.uncertain=undefined;this.uncertainCoverage=undefined;if(this.protectionAuthoringStarted)this.candidateCanonical=undefined;this.captureProtection();this.coreProtectionProgress();}
    const encodedState=JSON.stringify(state);boundedUtf8(encodedState,32*1024*1024,'checkpoint_too_large');
    // Unchanged drafts can reuse a confirmed checkpoint, but retained operations
    // must recheck ownership before authorizing any intent continuation.
    // An uncertain request above still settles under its original identity.
    if(!state?.operation&&encodedState===this.confirmedState)return;
    this.uncertain={key:this.key,expectedRevision:this.revision,nextRevision:crypto.randomUUID(),encodedState};
    if(state)this.uncertainCoverage=this.coverageFor(state);this.captureProtection();
    const exact=this.uncertain,result=await this.sourceIO(async()=>this.acceptCheckpoint(await this.writes.checkpoints.compareAndSwap(exact),exact));this.revision=result.revision;this.confirmedState=encodedState;
    if(this.uncertainCoverage)this.coverage={...this.uncertainCoverage,revision:result.revision};this.uncertain=undefined;this.uncertainCoverage=undefined;if(this.protectionAuthoringStarted)this.candidateCanonical=undefined;this.captureProtection();this.coreProtectionProgress();
  }
  private validateLoadedOperation(op:Operation):void{
    if(!object(op)||Object.keys(op).some(key=>!['input','plan','ref','content','pendingAck','planningRejected'].includes(key))||typeof op.content!=='string'||!op.plan&&!op.input)throw failure('invalid saved operation');
    if(op.input!==undefined)this.checkInput(op);
    if(op.plan!==undefined){if(!object(op.plan)||op.plan.version!==1||typeof op.plan.encodedPlan!=='string')throw failure('invalid saved operation');this.checkPlan(op.plan);}
    if(op.ref!==undefined){if(!object(op.ref)||Object.keys(op.ref).length!==5||!['vaultId','clientId','entryId','operationId','token'].every(key=>validId(op.ref![key as keyof DurableWriteRef])))throw failure('invalid saved reference');this.checkIdentity(op.ref);if(!op.plan||op.ref.operationId!==op.plan.operationId)throw failure('plan/ref mismatch');}
    if(op.planningRejected!==undefined&&(!op.input||!['revision_conflict','source_capture_expired','conditional_source_changed'].includes(op.planningRejected)||op.ref||op.pendingAck))throw failure('invalid saved planning rejection');
    if(op.pendingAck!==undefined){
      if(!object(op.pendingAck))throw failure('invalid pending acknowledgment');
      const ack=op.pendingAck,keys=ack.status==='committed'?['status','operationId','sequence']:['status','operationId','code'];
      if(!object(ack)||Object.keys(ack).length!==keys.length||!keys.every(key=>Object.hasOwn(ack,key))||!op.ref||ack.operationId!==op.ref.operationId
        ||!(ack.status==='committed'&&typeof ack.sequence==='string'&&/^[1-9][0-9]{0,19}$/.test(ack.sequence)&&BigInt(ack.sequence)<=18446744073709551615n
          ||ack.status==='rejected'&&typeof ack.code==='string'&&/^[a-z_]{1,64}$/.test(ack.code)))throw failure('invalid pending acknowledgment');
    }
  }
  load(path:string,expectedEntryId?:string,validate:()=>void=()=>{},options:{deferRecovery?:boolean}={}):Promise<void>{return this.queue(async()=>{
    validate();
    if(this.loadPrepared){if(path!==this.base.path||expectedEntryId!==undefined&&expectedEntryId!==this.base.entryId)throw failure('selected note changed before admission');return;}
    if(this.protection||this.protectionStopped)throw failure('the cancelled initial admission must be disposed before another load');
    this.protectionAdmitted=!options.deferRecovery;
    this.stateValidated=false;
    if(this.writes.checkpoints.scope.vaultId!==this.noteScope.vaultId||this.writes.checkpoints.scope.clientId!==this.noteScope.clientId)throw failure('selected note scope changed before admission');
    const selected=expectedEntryId??this.initialActor?.entryId;
    if(this.initialActor&&(this.initialActor.path!==path||selected!==this.initialActor.entryId))throw failure('selected note changed before admission');
    const observed=selected===undefined?await this.vault.readDurableText(path):await this.vault.readDurableTextById(selected);
    validate();
    // Check immutable identity BEFORE checkpoint adoption or resuming an intent.
    // A rename is retried by its caller, never admitted under an old path key.
    if(!observed||observed.path!==path||selected!==undefined&&observed.entryId!==selected)throw failure('selected note changed before admission');
    this.initialActor={entryId:observed.entryId,path};
    this.key=`note/v1/${observed.entryId}`;
    const loaded=await this.writes.checkpoints.load(this.key);validate();const head=loaded===null?null:this.acceptCheckpoint(loaded);this.revision=head?.revision??null;this.confirmedState=head?.encodedState;
    this.state={version:1,writer:crypto.randomUUID(),generation:0,base:observed,draft:observed.content,conflict:false};
    if(head?.encodedState!==null&&head?.encodedState!==undefined){
      const raw=JSON.parse(head.encodedState) as State;
      if(!object(raw)||raw.version!==1||!validId(raw.writer)||!validGeneration(raw.generation)||typeof raw.draft!=='string'||typeof raw.conflict!=='boolean'||!object(raw.base)||raw.base.entryId!==observed.entryId||typeof raw.base.content!=='string'||!validId(raw.base.revision)||typeof raw.base.path!=='string'
        ||!object(raw.base.stat)||!['ctime','mtime','size'].every(key=>typeof raw.base.stat[key as keyof typeof raw.base.stat]==='number'&&Number.isFinite(raw.base.stat[key as keyof typeof raw.base.stat])&&raw.base.stat[key as keyof typeof raw.base.stat]>=0)||!Number.isSafeInteger(raw.base.stat.size))throw failure('malformed or unsupported checkpoint; retained');
      if(options.deferRecovery&&raw.base.path!==path)throw failure('checkpoint belongs to another selected path; retained');
      this.state=raw;
      this.coverage={...this.coverageFor(raw),revision:head!.revision};
      if(raw.operation!==undefined){this.validateLoadedOperation(raw.operation);await this.claimLoadedCapture(raw.operation,validate);validate();}
      if(raw.operation?.ref){if(options.deferRecovery)this.sourceRecoveryRequired=true;else await this.resume(validate);}
      else if(observed.revision!==raw.base.revision){if(!raw.operation&&raw.draft===raw.base.content){raw.base=observed;raw.draft=observed.content;}else raw.conflict=true;}
    }
    this.error=this.state.conflict?failure('file changed elsewhere; your draft is retained'):null;
    this.stateValidated=true;
    await this.initializeProtection(validate,options.deferRecovery);validate();this.loadPrepared=true;
    this.changed();
  });}
  update(text:string,capture?:ConditionalSavedSourceCapture):void{
    if(capture){
      this.validateConditionalSavedSource(capture);this.claimCapture(capture.captureId);
      const base=this.base;
      // Freeze the original conditional request BEFORE any planning call. Later
      // typing changes only the draft, never this operation's content or proof.
      const input:DurableWriteInput=Object.freeze({operationId:crypto.randomUUID(),path:base.path,expectedEntryId:base.entryId,expectedRevision:base.revision,expectedContent:base.content,content:text,conditionalSavedSource:Object.freeze({captureId:capture.captureId,logicalWitness:Object.freeze({...capture.logicalWitness})})});
      this.state!.operation={input,content:text};this.captures.set(capture,'pending');
    }
    const changed=text!==this.state!.draft||!!capture;
    this.state!.draft=text;if(changed){this.state!.generation++;this.protectionAuthoringStarted=true;}
    this.captureProtection();if(!this.sourceRecoveryTerminal)void this.queue(()=>this.persist()).catch(()=>{});
  }
  flush(validate:()=>void):Promise<void>{if(this.sourceRecoveryTerminal)return Promise.reject(this.sourceRecoveryTerminal);return this.queue(async()=>{
    // A retained uncertain checkpoint must settle under its original identity
    // before a recovered admission may plan any new source mutation.
    if(this.uncertain)await this.persist();
    if(this.state!.operation)await this.resume(validate);
    if(this.state!.conflict)throw failure('file advanced or write rejected; draft preserved');
    while(this.text!==this.base.content){
      validate();const base=this.base,content=this.text;
      let plan:DurableWritePlan;
      try{plan=await this.writes.planWrite({operationId:crypto.randomUUID(),path:base.path,expectedEntryId:base.entryId,expectedRevision:base.revision,expectedContent:base.content,content});}
      catch(error){
        // A verified definite planning rejection has no prepared/committing
        // intent to settle. Preserve the original baseline and latest draft;
        // unknown transport/provider errors remain ordinary pending failures.
        if(error instanceof DurableWritePlanningError&&error.source==='host'&&['revision_conflict','collection_source_conflict'].includes(error.code)&&!error.commitUncertain){this.state!.conflict=true;await this.persist();this.changed();}
        throw error;
      }
      this.checkPlan(plan);
      this.state!.operation={plan,content};await this.persist();await this.resume(validate);
      if(this.state!.conflict)throw failure('file advanced or write rejected; draft preserved');
    }
    await this.persist();this.error=null;this.changed();
  });}
  /** Navigation may retain a conflict, but must durably checkpoint every edit. */
  preserveDraft():Promise<void>{return this.protection?this.flushDraftProtection():this.queue(()=>this.persist());}
  /** Refresh a completed collection-property operation without replacing later
   * body typing. In-flight intents retain their original plan and must settle
   * first; a UI refresh never reinterprets or retries them. */
  refreshManagedProjection(validate:()=>void):Promise<void>{return this.queue(async()=>{
    validate();
    if(!this.writes.composeNote)throw failure('managed projection composition is unavailable');
    if(this.state!.operation||this.state!.conflict)throw failure('settle the retained note write before refreshing managed properties');
    const base=this.base,submitted=this.text;
    const result=await this.writes.composeNote({entryId:base.entryId,path:base.path,expectedRevision:base.revision,baseline:base.content,proposed:submitted});
    validate();
    if(!result)throw failure('this note has no managed collection projection');
    if(result.current.entryId!==base.entryId||result.current.path!==base.path||typeof result.current.content!=='string'||typeof result.content!=='string')throw failure('managed projection identity mismatch');
    const draft=canonicalDraft(submitted,result.content,this.text);
    if(draft===undefined)throw failure('properties changed while refreshing; editor draft retained');
    this.state!.base=result.current;this.state!.draft=draft;
    await this.persist();this.error=null;this.changed();
  });}
  /** Save a separate file before adopting the original's latest version. Never
   * rebase a rejected draft, and never discard edits made during this operation. */
  saveRecoveryCopy():Promise<{path:string;resolved:boolean}>{return this.queue(async()=>{
    if(this.state!.operation)await this.resume(()=>{throw failure('pending write must settle before recovery');});
    if(!this.state!.conflict)throw failure('this note has no conflict to recover');
    if(!this.vault.adapter.createText)throw failure('safe recovery-copy creation is unavailable');
    const generation=this.state!.generation,draft=this.text,original=this.base.path;
    const dot=original.lastIndexOf('.'),slash=original.lastIndexOf('/');
    const stem=dot>slash?original.slice(0,dot):original,extension=dot>slash?original.slice(dot):'.md';
    const path=`${stem} (recovered draft ${crypto.randomUUID().slice(0,8)})${extension}`;
    // Vault.create checks destination absence; the durable create consumer also
    // rejects collisions atomically. A rejected/uncertain create leaves this draft.
    await this.vault.create(path,draft);
    const current=await this.vault.readDurableTextById(this.base.entryId);
    if(!current||this.state!.generation!==generation){this.changed();return{path,resolved:false};}
    const adopted={...this.state!,base:current,draft:current.content,conflict:false};
    // Keep the visible draft in place until the clean checkpoint is durable.
    await this.persist(adopted);
    if(this.state!.generation!==generation){await this.persist();this.changed();return{path,resolved:false};}
    this.state=adopted;this.error=null;this.changed();return{path,resolved:true};
  });}
  /** Capacity recovery may finish only this accepted operation. Unlike flush,
   * it must never plan a newer raw draft that arrived while it was settling. */
  resumeConditionalSavedSourceOperation(request:ConditionalSavedSourceRequest,operationId:string,validate:()=>void):Promise<boolean>{return this.queue(async()=>{
    validate();this.assertLoadScope();const op=this.state?.operation,guard=op?.input?.conditionalSavedSource;
    if(!op||op.ref||op.input?.operationId!==operationId||!guard||guard.captureId!==request.captureId||!['entryId','revision','path'].every(key=>guard.logicalWitness[key as keyof ConditionalSavedSourceWitness]===request.logicalWitness[key as keyof ConditionalSavedSourceWitness]))return false;
    await this.resume(validate);validate();this.changed();return true;
  });}
  private async resume(validate:()=>void):Promise<void>{
    if(this.sourceRecoveryTerminal)throw this.sourceRecoveryTerminal;
    const op=this.state!.operation!;
    // Persist the exact retained phase before any authorizing continuation.
    // Deterministic serialization/budget failures happen before `uncertain`
    // exists; a later retry must not prepare/commit that uncheckpointed state.
    await this.persist();
    if(op.planningRejected){await this.releaseOperationCapture(op);this.state!.operation=undefined;await this.persist();this.changed();return;}
    if(!op.plan){
      this.checkInput(op);validate();
      // Persist the exact original input before the first inert planning call.
      // A lost reply retries this same input, never a newly captured/rebased one.
      await this.persist();
      try{op.plan=await this.writes.planWrite(structuredClone(op.input!));}
      catch(error){
        if(error instanceof DurableWritePlanningError&&error.source==='host'&&!error.commitUncertain&&['revision_conflict','source_capture_expired','conditional_source_changed'].includes(error.code)){
          this.state!.conflict=true;op.planningRejected=error.code;await this.persist();await this.releaseOperationCapture(op);this.state!.operation=undefined;await this.persist();this.changed();
        }
        throw error;
      }
      this.checkPlan(op.plan);this.checkInput(op);await this.persist();
    }
    if(op.pendingAck){
      if(!op.ref||op.pendingAck.operationId!==op.ref.operationId||
        !(op.pendingAck.status==='committed'&&typeof op.pendingAck.sequence==='string'||op.pendingAck.status==='rejected'&&typeof op.pendingAck.code==='string'))throw failure('invalid pending acknowledgment');
      // Provider validates the exact terminal outcome and retries ACK idempotently.
      // No new reconciliation may reinterpret an already reconciled draft/base.
      const ref=op.ref,ack=op.pendingAck;await this.sourceIO(()=>this.writes.acknowledge(ref,ack));
      await this.releaseOperationCapture(op);
      this.state!.operation=undefined;await this.persist();this.changed();return;
    }
    if(!op.ref){const prepared=await this.writes.prepare(op.plan);this.checkIdentity(prepared.ref);if(prepared.ref.operationId!==op.plan.operationId)throw failure('prepare returned another operation');op.ref=prepared.ref;await this.persist();}
    const ref=op.ref;let outcome=await this.sourceIO(()=>this.writes.query(ref));
    if(!outcome)throw failure('checkpointed intent missing');
    if(outcome.state==='prepared'||outcome.state==='commit_requested'){validate();outcome=await this.sourceIO(()=>this.vault.commitDurableWrite(ref,{validate}));}
    if(outcome.state!=='committed'&&outcome.state!=='rejected')throw failure('outcome remains unknown');
    this.checkIdentity(outcome.ref);
    for(const key of ['vaultId','clientId','token','operationId','entryId'] as const)if(outcome.ref[key]!==op.ref[key])throw failure('terminal outcome mismatch');
    if(outcome.state==='committed'){
      const receipt=outcome.receipt,result=await this.sourceIO(()=>this.vault.reconcileDurableWrite(ref,receipt));
      if(result.status==='current'){
        this.state!.base=result.current;
        const canonical=op.plan!.canonicalContent;
        if(canonical!==undefined){
          const draft=result.current.content===canonical?canonicalDraft(op.content,canonical,this.text):undefined;
          if(draft===undefined)this.state!.conflict=true;
          else this.state!.draft=draft;
        }
      }else this.state!.conflict=true;
      op.pendingAck={status:'committed',operationId:outcome.receipt.operationId,sequence:outcome.receipt.sequence};
    }else{if(outcome.error.operationId!==op.ref.operationId)throw failure('rejection identity mismatch');this.state!.conflict=true;op.pendingAck={status:'rejected',operationId:outcome.error.operationId,code:outcome.error.code};}
    await this.persist();const ack=op.pendingAck;await this.sourceIO(()=>this.writes.acknowledge(ref,ack));
    await this.releaseOperationCapture(op);
    this.state!.operation=undefined;await this.persist();this.changed();
  }
  /** A known namespace move may advance only the same entry at its exact new path. */
  reload(relocatedPath?:string):Promise<void>{return this.queue(async()=>{
    if(this.state!.operation)await this.resume(()=>{throw failure('pending write requires explicit flush');});
    const current=await this.vault.readDurableTextById(this.base.entryId);
    if(!current){this.state!.conflict=true;await this.persist();throw failure('entry missing');}
    if(relocatedPath!==undefined&&current.path!==relocatedPath){this.state!.conflict=true;await this.persist();throw failure('entry moved elsewhere; draft retained');}
    if(this.text===this.base.content&&!this.state!.conflict){this.state!.base=current;this.state!.draft=current.content;}
    // Typing can precede adoption of an already committed rename. Preserve
    // that draft only when the stable entry moved and its baseline bytes did
    // not change. Ordinary reloads and existing conflicts remain strict.
    else if(relocatedPath!==undefined&&this.base.path!==relocatedPath&&current.content===this.base.content&&!this.state!.conflict)this.state!.base=current;
    else if(current.revision!==this.base.revision){this.state!.conflict=true;await this.persist();throw failure('entry changed; draft retained');}
    await this.persist();this.changed();
  });}
}
