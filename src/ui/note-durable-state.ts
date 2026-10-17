import type { Vault } from '../core/vault.ts';
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
  constructor(private vault:Vault,private writes:DurableWrites,private changed:()=>void){}
  get ready(){return !!this.state;}
  get text(){return this.state!.draft;}
  get base(){return this.state!.base;}
  get dirty(){return !!this.error||!!this.state&&(this.state.conflict||!!this.state.operation||!!this.uncertain||this.state.draft!==this.state.base.content);}
  private queue<T>(run:()=>Promise<T>):Promise<T>{const p=this.tail.then(run).catch(error=>{this.error=error instanceof Error?error:failure('operation failed');this.changed();throw this.error;});this.tail=p.catch(()=>{});return p;}
  private checkIdentity(value:DurableWritePlan|DurableWriteRef){const scope=this.writes.checkpoints.scope;if(value.vaultId!==scope.vaultId||value.clientId!==scope.clientId||value.entryId!==this.base.entryId||!value.operationId)throw failure('checkpoint identity mismatch');}
  private async persist():Promise<void>{
    if(this.uncertain){const result=await this.writes.checkpoints.compareAndSwap(this.uncertain);this.revision=result.revision;this.uncertain=undefined;}
    const encodedState=JSON.stringify(this.state);boundedUtf8(encodedState,32*1024*1024,'checkpoint_too_large');
    this.uncertain={key:this.key,expectedRevision:this.revision,nextRevision:crypto.randomUUID(),encodedState};
    const result=await this.writes.checkpoints.compareAndSwap(this.uncertain);this.revision=result.revision;this.uncertain=undefined;
  }
  load(path:string):Promise<void>{return this.queue(async()=>{
    const observed=await this.vault.readDurableText(path);this.key=`note/v1/${observed.entryId}`;
    const head=await this.writes.checkpoints.load(this.key);this.revision=head?.revision??null;
    this.state={version:1,writer:crypto.randomUUID(),generation:0,base:observed,draft:observed.content,conflict:false};
    if(head?.encodedState!==null&&head?.encodedState!==undefined){
      const raw=JSON.parse(head.encodedState) as State;
      if(raw.version!==1||typeof raw.writer!=='string'||!Number.isSafeInteger(raw.generation)||raw.generation<0||typeof raw.draft!=='string'||typeof raw.conflict!=='boolean'||!raw.base||raw.base.entryId!==observed.entryId||typeof raw.base.content!=='string'||typeof raw.base.revision!=='string'||typeof raw.base.path!=='string')throw failure('malformed or unsupported checkpoint; retained');
      this.state=raw;
      if(raw.operation){const op=raw.operation;if(!op.plan||op.plan.version!==1||typeof op.plan.encodedPlan!=='string'||typeof op.content!=='string')throw failure('invalid saved operation');this.checkIdentity(op.plan);boundedUtf8(op.plan.encodedPlan,8*1024*1024,'plan_too_large');if(op.ref){this.checkIdentity(op.ref);if(op.ref.operationId!==op.plan.operationId)throw failure('plan/ref mismatch');}}
      if(raw.operation?.ref)await this.resume(()=>{});
      else if(observed.revision!==raw.base.revision){if(raw.draft===raw.base.content){raw.base=observed;raw.draft=observed.content;}else raw.conflict=true;}
    }
    this.changed();
  });}
  update(text:string):void{this.state!.draft=text;this.state!.generation++;void this.queue(()=>this.persist()).catch(()=>{});}
  flush(validate:()=>void):Promise<void>{return this.queue(async()=>{
    if(this.state!.operation)await this.resume(validate);
    if(this.state!.conflict)throw failure('file advanced or write rejected; draft preserved');
    while(this.text!==this.base.content){
      validate();const base=this.base,content=this.text;
      const plan=await this.writes.planWrite({operationId:crypto.randomUUID(),path:base.path,expectedEntryId:base.entryId,expectedRevision:base.revision,expectedContent:base.content,content});
      this.checkIdentity(plan);boundedUtf8(plan.encodedPlan,8*1024*1024,'plan_too_large');
      this.state!.operation={plan,content};await this.persist();await this.resume(validate);
      if(this.state!.conflict)throw failure('file advanced or write rejected; draft preserved');
    }
    await this.persist();this.error=null;this.changed();
  });}
  private async resume(validate:()=>void):Promise<void>{
    const op=this.state!.operation!;
    // Resolve an uncertain checkpoint before authorizing its next phase.
    if(this.uncertain)await this.persist();
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
  reload():Promise<void>{return this.queue(async()=>{
    if(this.state!.operation)await this.resume(()=>{throw failure('pending write requires explicit flush');});
    const current=await this.vault.readDurableTextById(this.base.entryId);
    if(!current){this.state!.conflict=true;await this.persist();throw failure('entry missing');}
    if(this.text===this.base.content&&!this.state!.conflict){this.state!.base=current;this.state!.draft=current.content;}
    else if(current.revision!==this.base.revision){this.state!.conflict=true;await this.persist();throw failure('entry changed; draft retained');}
    await this.persist();this.changed();
  });}
}
