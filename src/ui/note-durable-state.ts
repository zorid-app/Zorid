import type { Vault } from '../core/vault.ts';
import {DurableWritePlanningError} from '../core/durable-writes.ts';
import type { DurableWrites, DurableWriteRead, DurableWritePlan, DurableWriteRef, DurableWriteOutcome } from '../core/durable-writes.ts';
import type { CheckpointChange } from '../core/durable-checkpoints.ts';
import { boundedUtf8 } from '../core/checkpoint-input.ts';
interface Operation { plan:DurableWritePlan; content:string; ref?:DurableWriteRef; pendingAck?:DurableWriteOutcome }
interface State {version:1;writer:string;generation:number;base:DurableWriteRead;draft:string;conflict:boolean;operation?:Operation}
const failure=(message:string)=>new Error(`Durable note recovery: ${message}`);
/** Editor-owned checkpoints; provider plans and operation identities stay exact. */
export class DurableNoteState {
  private state?:State;
  private revision:string|null=null;
  private uncertain?:CheckpointChange;
  private tail:Promise<unknown>=Promise.resolve();
  private key='';
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
      if(raw.operation){const op=raw.operation;if(!op.plan||op.plan.version!==1||typeof op.plan.encodedPlan!=='string'||typeof op.content!=='string')throw failure('invalid saved operation');this.checkIdentity(op.plan);boundedUtf8(op.plan.encodedPlan,8*1024*1024,'plan_too_large');if(op.ref){this.checkIdentity(op.ref);if(op.ref.operationId!==op.plan.operationId)throw failure('plan/ref mismatch');}}
      if(raw.operation?.ref)await this.resume(validate);
      else if(observed.revision!==raw.base.revision){if(raw.draft===raw.base.content){raw.base=observed;raw.draft=observed.content;}else raw.conflict=true;}
    }
    if(this.state.conflict)this.error=failure('file changed elsewhere; your draft is retained');
    this.changed();
  });}
  update(text:string):void{this.state!.draft=text;this.state!.generation++;void this.queue(()=>this.persist()).catch(()=>{});}
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
        if(error instanceof DurableWritePlanningError&&error.source==='host'&&error.code==='revision_conflict'&&!error.commitUncertain){this.state!.conflict=true;await this.persist();this.changed();}
        throw error;
      }
      this.checkIdentity(plan);boundedUtf8(plan.encodedPlan,8*1024*1024,'plan_too_large');
      this.state!.operation={plan,content};await this.persist();await this.resume(validate);
      if(this.state!.conflict)throw failure('file advanced or write rejected; draft preserved');
    }
    await this.persist();this.error=null;this.changed();
  });}
  /** Navigation may retain a conflict, but must durably checkpoint every edit. */
  preserveDraft():Promise<void>{return this.queue(()=>this.persist());}
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
    if(op.pendingAck){
      if(!op.ref||op.pendingAck.operationId!==op.ref.operationId||
        !(op.pendingAck.status==='committed'&&typeof op.pendingAck.sequence==='string'||op.pendingAck.status==='rejected'&&typeof op.pendingAck.code==='string'))throw failure('invalid pending acknowledgment');
      // Provider validates the exact terminal outcome and retries ACK idempotently.
      // No new reconciliation may reinterpret an already reconciled draft/base.
      await this.writes.acknowledge(op.ref,op.pendingAck);
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
      if(result.status==='current')this.state!.base=result.current;else this.state!.conflict=true;
      op.pendingAck={status:'committed',operationId:outcome.receipt.operationId,sequence:outcome.receipt.sequence};
    }else{if(outcome.error.operationId!==op.ref.operationId)throw failure('rejection identity mismatch');this.state!.conflict=true;op.pendingAck={status:'rejected',operationId:outcome.error.operationId,code:outcome.error.code};}
    await this.persist();await this.writes.acknowledge(op.ref,op.pendingAck);
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
