import type { Vault } from '../core/vault.ts';
import {DurableWritePlanningError} from '../core/durable-writes.ts';
import type { DurableWrites, DurableWriteRead, DurableWritePlan, DurableWriteRef, DurableWriteOutcome, DurableWriteInput, ConditionalSavedSourceWitness, ConditionalSavedSourceCapture, ConditionalSavedSourceStatus } from '../core/durable-writes.ts';
import type { CheckpointChange } from '../core/durable-checkpoints.ts';
import { boundedUtf8 } from '../core/checkpoint-input.ts';
interface Operation { plan?:DurableWritePlan; input?:DurableWriteInput; content:string; ref?:DurableWriteRef; pendingAck?:DurableWriteOutcome; planningRejected?:string }
interface State {version:1;writer:string;generation:number;base:DurableWriteRead;draft:string;conflict:boolean;operation?:Operation}
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
  private uncertain?:CheckpointChange;
  private tail:Promise<unknown>=Promise.resolve();
  private key='';
  private captures=new WeakMap<ConditionalSavedSourceCapture,Exclude<ConditionalSavedSourceStatus,'foreign'>>();
  private activeCaptures=new Map<string,ConditionalSavedSourceCapture>();
  private abandonedCaptures=new Set<string>();
  private releasingCaptures=new WeakMap<ConditionalSavedSourceCapture,Promise<void>>();
  error:Error|null=null;
  private vault:Vault;
  private writes:DurableWrites;
  private changed:()=>void;
  constructor(vault:Vault,writes:DurableWrites,changed:()=>void){this.vault=vault;this.writes=writes;this.changed=changed;}
  get ready(){return !!this.state;}
  get text(){return this.state!.draft;}
  get conflicted(){return !!this.state?.conflict;}
  get base(){return this.state!.base;}
  get dirty(){return !!this.error||!!this.state&&(this.state.conflict||!!this.state.operation||!!this.uncertain||this.state.draft!==this.state.base.content);}
  private queue<T>(run:()=>Promise<T>):Promise<T>{const p=this.tail.then(run).catch(error=>{this.error=error instanceof Error?error:failure('operation failed');this.changed();throw this.error;});this.tail=p.catch(()=>{});return p;}
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
  captureConditionalSavedSource(witness:ConditionalSavedSourceWitness,validate:()=>void):Promise<ConditionalSavedSourceCapture|undefined>{return this.queue(async()=>{
    validate();this.checkWitness(witness);
    if(!this.writes.captureSavedSource&&!this.writes.releaseSavedSource)return undefined;
    if(!this.writes.captureSavedSource||!this.writes.releaseSavedSource)throw failure('conditional saved-source capability is incomplete');
    // A lost release reply must not consume one registry slot on every retry.
    for(const id of this.abandonedCaptures){await this.writes.releaseSavedSource(id);this.abandonedCaptures.delete(id);}
    if(this.state!.conflict||this.state!.operation)throw failure('settle the retained note write before capturing another conditional source');
    const capture=await this.writes.captureSavedSource({...witness});
    try{
      validate();this.checkWitness(witness);
      if(!capture||typeof capture.captureId!=='string'||!capture.captureId||typeof capture.source!=='string')throw failure('invalid conditional saved-source capture');
      boundedUtf8(capture.source,8*1024*1024,'capture_too_large');
      this.checkWitness(capture.logicalWitness);
      if(this.state!.conflict||this.state!.operation)throw failure('the note write changed during source capture');
      const owned=Object.freeze({...capture,logicalWitness:Object.freeze({...capture.logicalWitness})});
      this.captures.set(owned,'unattached');this.activeCaptures.set(owned.captureId,owned);return owned;
    }catch(error){
      if(capture&&typeof capture.captureId==='string')try{await this.writes.releaseSavedSource(capture.captureId);}catch(releaseError){this.abandonedCaptures.add(capture.captureId);throw releaseError;}
      throw error;
    }
  });}
  releaseConditionalSavedSource(capture:ConditionalSavedSourceCapture):Promise<void>{
    const pending=this.releasingCaptures.get(capture);if(pending)return pending;
    if(this.conditionalSavedSourceStatus(capture)!=='unattached')return Promise.reject(failure('only an unattached conditional source can be released by its caller'));
    const releasing=(async()=>{await this.writes.releaseSavedSource!(capture.captureId);this.captures.set(capture,'settled');this.activeCaptures.delete(capture.captureId);})();
    this.releasingCaptures.set(capture,releasing);
    void releasing.finally(()=>{if(this.releasingCaptures.get(capture)===releasing)this.releasingCaptures.delete(capture);}).catch(()=>{});
    return releasing;
  }
  /** Retirement releases only proofs that have never entered a write intent.
   * Join an existing release; failed cleanup keeps this buffer owned/retryable. */
  releaseUnattachedConditionalSavedSources():Promise<void>{return this.queue(async()=>{
    for(const capture of this.activeCaptures.values())if(this.conditionalSavedSourceStatus(capture)==='unattached')await this.releaseConditionalSavedSource(capture);
    for(const id of this.abandonedCaptures){await this.writes.releaseSavedSource!(id);this.abandonedCaptures.delete(id);}
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
    await this.writes.releaseSavedSource(guard.captureId);
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
  private async persist(state=this.state):Promise<void>{
    if(this.uncertain){const result=await this.writes.checkpoints.compareAndSwap(this.uncertain);this.revision=result.revision;this.uncertain=undefined;}
    const encodedState=JSON.stringify(state);boundedUtf8(encodedState,32*1024*1024,'checkpoint_too_large');
    this.uncertain={key:this.key,expectedRevision:this.revision,nextRevision:crypto.randomUUID(),encodedState};
    const result=await this.writes.checkpoints.compareAndSwap(this.uncertain);this.revision=result.revision;this.uncertain=undefined;
  }
  load(path:string,expectedEntryId?:string,validate:()=>void=()=>{}):Promise<void>{return this.queue(async()=>{
    validate();
    const observed=expectedEntryId===undefined?await this.vault.readDurableText(path):await this.vault.readDurableTextById(expectedEntryId);
    validate();
    // Check immutable identity BEFORE checkpoint adoption or resuming an intent.
    // A rename is retried by its caller, never admitted under an old path key.
    if(!observed||observed.path!==path||expectedEntryId!==undefined&&observed.entryId!==expectedEntryId)throw failure('selected note changed before admission');
    this.key=`note/v1/${observed.entryId}`;
    const head=await this.writes.checkpoints.load(this.key);validate();this.revision=head?.revision??null;
    this.state={version:1,writer:crypto.randomUUID(),generation:0,base:observed,draft:observed.content,conflict:false};
    if(head?.encodedState!==null&&head?.encodedState!==undefined){
      const raw=JSON.parse(head.encodedState) as State;
      if(raw.version!==1||typeof raw.writer!=='string'||!Number.isSafeInteger(raw.generation)||raw.generation<0||typeof raw.draft!=='string'||typeof raw.conflict!=='boolean'||!raw.base||raw.base.entryId!==observed.entryId||typeof raw.base.content!=='string'||typeof raw.base.revision!=='string'||typeof raw.base.path!=='string')throw failure('malformed or unsupported checkpoint; retained');
      this.state=raw;
      if(raw.operation){const op=raw.operation;if(typeof op.content!=='string'||!op.plan&&!op.input)throw failure('invalid saved operation');if(op.input!==undefined)this.checkInput(op);if(op.plan!==undefined){if(!op.plan||op.plan.version!==1||typeof op.plan.encodedPlan!=='string')throw failure('invalid saved operation');this.checkPlan(op.plan);}if(op.ref){this.checkIdentity(op.ref);if(!op.plan||op.ref.operationId!==op.plan.operationId)throw failure('plan/ref mismatch');}}
      if(raw.operation?.ref)await this.resume(validate);
      else if(observed.revision!==raw.base.revision){if(!raw.operation&&raw.draft===raw.base.content){raw.base=observed;raw.draft=observed.content;}else raw.conflict=true;}
    }
    if(this.state.conflict)this.error=failure('file changed elsewhere; your draft is retained');
    this.changed();
  });}
  update(text:string,capture?:ConditionalSavedSourceCapture):void{
    if(capture){
      this.validateConditionalSavedSource(capture);
      const base=this.base;
      // Freeze the original conditional request BEFORE any planning call. Later
      // typing changes only the draft, never this operation's content or proof.
      const input:DurableWriteInput=Object.freeze({operationId:crypto.randomUUID(),path:base.path,expectedEntryId:base.entryId,expectedRevision:base.revision,expectedContent:base.content,content:text,conditionalSavedSource:Object.freeze({captureId:capture.captureId,logicalWitness:Object.freeze({...capture.logicalWitness})})});
      this.state!.operation={input,content:text};this.captures.set(capture,'pending');
    }
    this.state!.draft=text;this.state!.generation++;void this.queue(()=>this.persist()).catch(()=>{});
  }
  flush(validate:()=>void):Promise<void>{return this.queue(async()=>{
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
  preserveDraft():Promise<void>{return this.queue(()=>this.persist());}
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
  private async resume(validate:()=>void):Promise<void>{
    const op=this.state!.operation!;
    // Resolve an uncertain checkpoint before authorizing its next phase.
    if(this.uncertain)await this.persist();
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
      await this.writes.acknowledge(op.ref,op.pendingAck);
      await this.releaseOperationCapture(op);
      this.state!.operation=undefined;await this.persist();this.changed();return;
    }
    if(!op.ref){const prepared=await this.writes.prepare(op.plan);this.checkIdentity(prepared.ref);if(prepared.ref.operationId!==op.plan.operationId)throw failure('prepare returned another operation');op.ref=prepared.ref;await this.persist();}
    let outcome=await this.writes.query(op.ref);
    if(!outcome)throw failure('checkpointed intent missing');
    if(outcome.state==='prepared'||outcome.state==='commit_requested'){validate();outcome=await this.vault.commitDurableWrite(op.ref,{validate});}
    if(outcome.state!=='committed'&&outcome.state!=='rejected')throw failure('outcome remains unknown');
    this.checkIdentity(outcome.ref);
    for(const key of ['vaultId','clientId','token','operationId','entryId'] as const)if(outcome.ref[key]!==op.ref[key])throw failure('terminal outcome mismatch');
    if(outcome.state==='committed'){
      const result=await this.vault.reconcileDurableWrite(op.ref,outcome.receipt);
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
    await this.persist();await this.writes.acknowledge(op.ref,op.pendingAck);
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
