import {captureWebRoute} from '../platform/mobile-web-routing.ts';
import type {WebDocumentRoute} from '../platform/mobile-web-routing.ts';

/** A web-issued visit distinguishes independent cursors/undo for A -> B -> A.
 * It never authorizes a file. The host validates immutable file/store witnesses. */
export interface MobileDocumentVisit {id:string;entryId:string}
export interface MobileDocumentSnapshot {route:WebDocumentRoute;content:string}
export interface MobileDocumentView {
  readonly visitId:string;
  /** active true + denied canMutate freezes the current keyboard owner. */
  setInteractionState(state:{active:boolean}):void;
}
export interface MobileViewWindowHost<V extends MobileDocumentView> {
  isCurrent():boolean;
  /** Passive reads must never load NoteBuffer or resume checkpoints/intents. */
  read(entryId:string,check:()=>void):Promise<MobileDocumentSnapshot>;
  /** Construct initially inactive, with the live pure mutation guard supplied. */
  render(visit:MobileDocumentVisit,snapshot:MobileDocumentSnapshot,canMutate:()=>boolean):Promise<V>;
  flush(view:V):Promise<MobileDocumentSnapshot|void>;
  /** Active target admission, including expected-ID BEFORE recovery. */
  admit(view:V,entryId:string,check:()=>void):Promise<WebDocumentRoute>;
  dispose(view:V):Promise<void>;
  /** Only transforms/attachment. Never publish edits, focus or destroy a view. */
  present(source:V|undefined,target:V|undefined,direction:-1|1,fraction:number):void;
}
interface RecordView<V> {visit:MobileDocumentVisit;snapshot:MobileDocumentSnapshot;view:V}
export interface MobileViewLoan {readonly id:string;readonly sourceVisitId:string|null;readonly targetVisitId:string;readonly direction:-1|1}
interface Loan<V> {token:MobileViewLoan;source?:RecordView<V>;target:RecordView<V>;sequence:bigint;epoch:number}

/** Bounded live resources, independent of user tabs and native presentation.
 * Caller serializes asynchronous transitions; progress has no queue or I/O.
 * No source/target is an authored writer during a loan. */
export class MobileDocumentViewWindow<V extends MobileDocumentView> {
  private records=new Map<string,RecordView<V>>();
  private currentId?:string;
  private writerId?:string;
  private loan?:Loan<V>;
  private epoch=0;
  private disposed=false;
  private destruction?:Promise<void>;
  private interactionBlocked=false;
  private suspended=false;
  private issued=new WeakSet<MobileViewLoan>();
  private host:MobileViewWindowHost<V>;
  constructor(host:MobileViewWindowHost<V>){this.host=host;}
  get size(){return this.records.size;}
  get currentVisitId(){return this.currentId;}
  get hasLoan(){return !!this.loan;}
  get writerVisitId(){return this.writerId;}
  get blocked(){return this.interactionBlocked;}
  private check(epoch=this.epoch):void{if(this.disposed||epoch!==this.epoch||!this.host.isCurrent())throw new Error('Stale document view window');}
  private setWriter(record?:RecordView<V>):void{
    this.writerId=undefined;
    for(const other of this.records.values())other.view.setInteractionState({active:false});
    if(record&&!this.suspended){this.writerId=record.visit.id;record.view.setInteractionState({active:true});}
  }
  private freeze():void{
    this.writerId=undefined;
    for(const record of this.records.values())record.view.setInteractionState({active:!this.suspended&&record.visit.id===this.currentId});
  }
  private async remove(id:string):Promise<void>{
    const record=this.records.get(id);if(!record)return;
    if(id===this.writerId)throw new Error('Cannot evict the active writer');
    await this.host.dispose(record.view);
    if(this.records.get(id)===record)this.records.delete(id);
  }
  private async ensure(visit:MobileDocumentVisit,retain:Set<string>,check:()=>void):Promise<RecordView<V>>{
    check();const prior=this.records.get(visit.id);
    if(prior&&prior.visit.entryId!==visit.entryId)throw new Error('Visit identity changed');
    const snapshot=await this.host.read(visit.entryId,check);check();captureWebRoute(snapshot.route);
    if(snapshot.route.entryId!==visit.entryId)throw new Error('Passive snapshot identity changed');
    if(prior){
      // Do not replace an old editor/undo state with an unseen document snapshot.
      if(prior.snapshot.route.path!==snapshot.route.path||prior.snapshot.route.revision!==snapshot.route.revision)throw new Error('Prepared document changed');
      return prior;
    }
    // Await disposal BEFORE allocating the replacement; failed cleanup keeps
    // its record accounted and prevents a fourth live runtime.
    while(this.records.size>=3){
      const victim=[...this.records.keys()].find(id=>!retain.has(id)&&id!==this.currentId);
      if(!victim)throw new Error('Document view window is full');
      await this.remove(victim);check();
    }
    let record:RecordView<V>|undefined;
    const view=await this.host.render(visit,snapshot,()=>!!record&&this.records.get(visit.id)===record&&this.writerId===visit.id&&!this.suspended&&!this.loan&&!this.disposed&&this.host.isCurrent());
    // Account the resource before checking cancellation: stale allocation must
    // be drained rather than disappearing from memory/ownership accounting.
    record={visit:{...visit},snapshot,view};this.records.set(visit.id,record);
    check();return record;
  }
  async prepare(visits:readonly MobileDocumentVisit[]):Promise<void>{
    this.check();if(this.loan)throw new Error('Gesture owns the view window');
    if(visits.length>3||new Set(visits.map(v=>v.id)).size!==visits.length)throw new Error('Invalid document view plan');
    const epoch=this.epoch,check=()=>this.check(epoch),retain=new Set(visits.map(v=>v.id));
    for(const id of [...this.records.keys()])if(!retain.has(id)&&id!==this.currentId){await this.remove(id);check();}
    for(const visit of visits)await this.ensure(visit,retain,check);
  }
  async begin(id:string,target:MobileDocumentVisit,direction:-1|1):Promise<MobileViewLoan>{
    this.check();if(this.loan)throw new Error('A gesture is already pending');
    if(target.id===this.currentId)throw new Error('Target is already current');
    const epoch=this.epoch,check=()=>this.check(epoch),source=this.currentId?this.records.get(this.currentId):undefined;
    this.freeze();
    try{
      if(source){const saved=await this.host.flush(source.view);check();if(saved){if(saved.route.entryId!==source.visit.entryId)throw new Error('Flushed source identity changed');source.snapshot=saved;}}
      const targetRecord=await this.ensure(target,new Set([...(this.currentId?[this.currentId]:[]),target.id]),check);check();
      const token=Object.freeze({id,sourceVisitId:this.currentId??null,targetVisitId:target.id,direction});
      this.issued.add(token);this.loan={token,source,target:targetRecord,sequence:-1n,epoch};
      this.host.present(source?.view,targetRecord.view,direction,0);return token;
    }catch(error){
      // The original record still owns its unchanged view. The router reports
      // failure only after this synchronous rollback and cleanup have settled.
      if(!this.disposed&&epoch===this.epoch&&this.host.isCurrent()){this.host.present(source?.view,undefined,direction,0);await this.resume();}
      throw error;
    }
  }
  private exact(token:MobileViewLoan):Loan<V>{
    this.check();const loan=this.loan;
    if(!this.issued.has(token)||!loan||loan.token!==token||loan.epoch!==this.epoch)throw new Error('Stale document view loan');
    return loan;
  }
  progress(token:MobileViewLoan,sequence:bigint,fraction:number):boolean{
    const loan=this.exact(token);
    if(sequence<0n||sequence<=loan.sequence||!Number.isFinite(fraction)||fraction<0||fraction>1)return false;
    loan.sequence=sequence;this.host.present(loan.source?.view,loan.target.view,token.direction,fraction);return true;
  }
  async cancel(token:MobileViewLoan):Promise<void>{
    const loan=this.exact(token);this.loan=undefined;
    this.host.present(loan.source?.view,undefined,token.direction,0);await this.resume();
  }
  /** Admit/render validation first. Logical router commit must run synchronously
   * in accept before enabling the incoming writer. No native receipt is a gate. */
  async commit(token:MobileViewLoan,accept:(route:WebDocumentRoute)=>void):Promise<WebDocumentRoute>{
    const loan=this.exact(token),check=()=>{this.exact(token);};
    try{
      const route=await this.host.admit(loan.target.view,loan.target.visit.entryId,check);check();
      captureWebRoute(route);
      if(route.entryId!==loan.target.visit.entryId)throw new Error('Admitted document identity changed');
      this.host.present(loan.target.view,undefined,token.direction,0);
      accept(route); // Must contain no await and no fallible post-commit work.
      loan.target.snapshot={...loan.target.snapshot,route};this.currentId=loan.target.visit.id;this.loan=undefined;this.suspended=false;
      // A failed interaction reconfiguration after logical commit is fenced,
      // not reclassified as a failed/cancelled navigation.
      try{this.setWriter(loan.target);this.interactionBlocked=false;}
      catch{this.writerId=undefined;this.interactionBlocked=true;}
      return route;
    }catch(error){if(this.loan?.token===token)await this.cancel(token);throw error;}
  }
  async home(accept:()=>void):Promise<void>{
    this.check();if(this.loan)await this.cancel(this.loan.token);
    const epoch=this.epoch,source=this.currentId?this.records.get(this.currentId):undefined;this.freeze();
    let accepted=false;
    try{if(source)await this.host.flush(source.view);this.check(epoch);this.host.present(undefined,undefined,1,0);accept();accepted=true;this.currentId=undefined;this.setWriter();}
    catch(error){if(accepted){this.writerId=undefined;this.interactionBlocked=true;return;}if(!this.disposed&&epoch===this.epoch&&this.host.isCurrent()){this.host.present(source?.view,undefined,1,0);this.setWriter(source);}throw error;}
  }
  invalidate():void{this.epoch++;this.loan=undefined;this.freeze();}
  /** Retained native overlays quiesce without dropping the host/client/history.
   * Returning requires fresh source admission before any writer is restored. */
  async setPresentation(active:boolean,accept:(route?:WebDocumentRoute)=>void):Promise<void>{
    if(!active)await this.drain();else this.check();
    const epoch=this.epoch,check=()=>this.check(epoch),source=this.currentId?this.records.get(this.currentId):undefined;
    let route:WebDocumentRoute|undefined;
    if(active&&source){route=await this.host.admit(source.view,source.visit.entryId,check);check();captureWebRoute(route);
      if(route.entryId!==source.visit.entryId)throw new Error('Restored source identity changed');}
    check();accept(route);this.suspended=!active;
    if(route&&source)source.snapshot={...source.snapshot,route};
    try{this.setWriter(active?source:undefined);this.interactionBlocked=false;}catch{this.writerId=undefined;this.interactionBlocked=true;}
  }
  /** Revoke immediately, then drain before native may hide/release the host. */
  async drain():Promise<void>{
    this.epoch++;const source=this.currentId?this.records.get(this.currentId):undefined;
    this.loan=undefined;this.freeze();this.host.present(source?.view,undefined,1,0);
    if(source)await this.host.flush(source.view);
  }
  async resume(accept?:(route?:WebDocumentRoute)=>void):Promise<void>{
    this.check();if(this.loan)throw new Error('Cannot resume during gesture');
    const epoch=this.epoch,sourceId=this.currentId,source=sourceId?this.records.get(sourceId):undefined;
    const check=()=>{this.check(epoch);if(this.loan||this.currentId!==sourceId||sourceId&&this.records.get(sourceId)!==source)throw new Error('Resumed source view changed');};
    let route:WebDocumentRoute|undefined;
    if(!this.suspended&&source){route=await this.host.admit(source.view,source.visit.entryId,check);check();captureWebRoute(route);
      if(route.entryId!==source.visit.entryId)throw new Error('Resumed source identity changed');}
    check();accept?.(route);if(route&&source)source.snapshot={...source.snapshot,route};this.setWriter(source);
  }
  destroy():Promise<void>{
    if(this.destruction)return this.destruction;
    if(this.disposed&&!this.records.size)return Promise.resolve();
    const task=Promise.resolve().then(async()=>{
      if(!this.disposed){await this.drain();this.disposed=true;this.writerId=undefined;}
      for(const id of [...this.records.keys()])await this.remove(id);
    });
    this.destruction=task;void task.finally(()=>{if(this.destruction===task)this.destruction=undefined;}).catch(()=>{});return task;
  }
}
