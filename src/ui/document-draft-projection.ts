/** One exact-text display projection. Rust owns semantic work and scheduling;
 * this owner only prepares bounded input, transfers facts, and retires its lease. */
import type {DocumentDraftJob,DocumentDraftOutcome,DocumentDraftReply,DocumentDraftService} from '../core/document-drafts.ts';
import {DOCUMENT_DRAFT_CHUNK_BYTES,DOCUMENT_DRAFT_SOURCE_BYTES} from '../core/document-drafts.ts';
import {prepareDocumentDraftFacts,DocumentDraftFactsError,DOCUMENT_DRAFT_FACTS_WIRE_BYTES} from '../core/document-draft-facts.ts';
import {noteFromFacts,parseMetadata} from '../core/metadata.ts';
import type {NoteMetadata} from '../core/types.ts';

export const DOCUMENT_DRAFT_FRONTEND_BYTES=96*1024*1024;
export interface DraftMetadataState {
  readonly status:'pending'|'current'|'unavailable'|'unsupported';
  readonly origin:'core'|'legacy';
  readonly bufferLifetime:string;
  readonly textRevision:string;
  /** Retained older views may accompany pending/unavailable, never current. */
  readonly view?:NoteMetadata;
  readonly code?:'resource'|'invalid_text'|'invalid_facts'|'unavailable';
}
interface Budget {used:number;components:Map<string,number>}
const budgets=new WeakMap<object,Budget>();
class Resource extends Error {}
class Obsolete extends Error {}
class Unavailable extends Error {}
class InvalidText extends Error {}
function budgetFor(owner:object):Budget {let value=budgets.get(owner);if(!value){value={used:0,components:new Map()};budgets.set(owner,value);}return value;}
function reserve(budget:Budget,component:string,bytes:number):()=>void {
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>DOCUMENT_DRAFT_FRONTEND_BYTES-budget.used)throw new Resource();
  budget.used+=bytes;budget.components.set(component,(budget.components.get(component)??0)+bytes);let active=true;
  return()=>{if(!active)return;active=false;budget.used-=bytes;const left=(budget.components.get(component)??0)-bytes;if(left)budget.components.set(component,left);else budget.components.delete(component);};
}
/** Logical component accounting for diagnostics/tests, not process heap usage. */
export function documentDraftProjectionUsage(owner:object):Readonly<{bytes:number;components:Readonly<Record<string,number>>}>{
  const budget=budgetFor(owner);return Object.freeze({bytes:budget.used,components:Object.freeze(Object.fromEntries(budget.components))});
}
function sameJob(a:DocumentDraftJob,b:DocumentDraftJob):boolean{return a.lifetime===b.lifetime&&a.id===b.id&&a.buffer_lifetime===b.buffer_lifetime&&a.text_revision===b.text_revision;}
function jobKey(job:DocumentDraftJob):string{return job.lifetime+':'+job.id;}
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

interface Run {epoch:number;revision:string;text:string;path:string;releaseText:()=>void;slot?:Slot}
interface Slot {job:DocumentDraftJob;retired:boolean;outcome?:DocumentDraftOutcome;acking?:Promise<void>;ackFailed?:boolean;cancelling?:Promise<void>}
interface WireLease {id:string;lastRevision?:string;needsRenewal:boolean;retired:boolean;start?:Promise<void>;releasing?:Promise<void>;releaseAllocation:()=>void}
export interface DocumentDraftProjectionOptions {
  /** The admitted service itself is the shared allocation owner. Legacy uses Vault. */
  readonly owner:object;
  readonly service?:DocumentDraftService;
  readonly capable:boolean;
  readonly onChange?:(state:DraftMetadataState)=>void;
}

export class DocumentDraftProjection {
  readonly bufferLifetime=crypto.randomUUID();
  private readonly service:DocumentDraftService|undefined;
  private readonly budget:Budget;
  private readonly options:DocumentDraftProjectionOptions;
  private epoch=0;
  private revision=0n;
  private text:string|undefined;
  private path='';
  private demanded=false;
  private next?:Run;
  private running?:Promise<void>;
  private closed=false;
  private providerRetired=false;
  private subscriptionFailed=false;
  private closing?:Promise<void>;
  private unsubscribe?:()=>void;
  private hint=0;
  private observing?:Promise<void>;
  private observationFailed=false;
  private ownerLost=false;
  private slots=new Map<string,Slot>();
  private wireLeases=new Map<string,WireLease>();
  private wireLeaseId=this.bufferLifetime;
  private wireLeaseRetired=false;
  private calls=new Set<Promise<unknown>>();
  private waiters=new Set<()=>void>();
  private viewRelease?:()=>void;
  private installed?:NoteMetadata;
  private installedRevision?:string;
  private stateValue:DraftMetadataState;

  constructor(options:DocumentDraftProjectionOptions){
    this.options=options;this.service=options.service;this.budget=budgetFor(options.service??options.owner);
    this.stateValue=Object.freeze({status:'unsupported',origin:options.capable?'core':'legacy',bufferLifetime:this.bufferLifetime,textRevision:'0'});
    if(options.capable&&options.service){
      try{const stop=options.service.subscribe(()=>this.observeHint(),()=>this.retireProvider());
      this.unsubscribe=stop;if(this.providerRetired){this.unsubscribe=undefined;try{stop();}catch{/* Already retired. */}}}
      catch{this.subscriptionFailed=true;this.publish('unavailable','unavailable');}
    }
  }
  get state():DraftMetadataState{return this.stateValue;}
  /** Synchronous consumers use this only; an older retained view is not exact. */
  get current():NoteMetadata|undefined{return !this.closed&&this.stateValue.status==='current'?this.stateValue.view:undefined;}
  /** Observe the NoteBuffer's borrowed current string; only requested snapshots
   * are retained/charged independently through preparation. No clean preload. */
  update(path:string,text:string,options:{readonly demand:boolean}):void {
    if(this.closed)return;
    const changed=this.text!==text;
    if(!changed&&this.demanded===options.demand){if(this.path!==path){this.path=path;if(this.installed)this.installPath(path);}return;}
    if(changed){if(this.revision===18446744073709551615n){this.publish('unavailable','resource');return;}this.revision++;}
    this.text=text;this.path=path;this.demanded=options.demand;this.epoch++;this.wake();this.next?.releaseText();this.next=undefined;
    for(const slot of this.slots.values())this.retireSlot(slot);
    if(!options.demand){const lease=this.wireLeases.get(this.wireLeaseId);if(lease)void this.releaseLease(lease).catch(()=>{});this.publish('unsupported');return;}
    if(this.ownerLost){this.publish('unavailable','unavailable');return;}
    // Demand is not a text revision. Reuse the exact already-owned view even
    // after its core terminal ACK, in both the core and legacy paths.
    if(this.installed&&this.installedRevision===String(this.revision)){if(this.installed.path!==path)this.installPath(path);this.publish('current');return;}
    const previousLease=this.wireLeases.get(this.wireLeaseId);
    if(this.options.capable&&this.wireLeases.size>=32&&(!previousLease||previousLease.retired||previousLease.needsRenewal||previousLease.lastRevision===String(this.revision))){this.publish('unavailable','resource');return;}
    let releaseText:()=>void;
    try{if(text.length>DOCUMENT_DRAFT_SOURCE_BYTES)throw new Resource();releaseText=reserve(this.budget,'captured-text',text.length*2);}catch{this.publish('unavailable','resource');return;}
    const run:Run={epoch:this.epoch,revision:String(this.revision),text,path,releaseText};this.next=run;this.publish('pending');
    if(!this.options.capable){this.next=undefined;this.legacy(run);return;}
    if(!this.service||this.subscriptionFailed){this.next=undefined;releaseText();this.publish('unavailable','unavailable');return;}
    this.drive();
  }
  private publish(status:DraftMetadataState['status'],code?:DraftMetadataState['code']):void {
    this.stateValue=Object.freeze({status,origin:this.options.capable?'core':'legacy',bufferLifetime:this.bufferLifetime,textRevision:String(this.revision),...(this.installed?{view:this.installed}:{}),...(code?{code}:{})});
    if(!this.closed)try{this.options.onChange?.(this.stateValue);}catch{/* Display listeners cannot own transport cleanup. */}
  }
  private check(run:Run):void {if(this.closed||run.epoch!==this.epoch)throw new Obsolete();if(this.ownerLost)throw new Unavailable();}
  private wake():void {for(const resolve of [...this.waiters]){this.waiters.delete(resolve);resolve();}}
  private track<T>(promise:Promise<T>):Promise<T>{this.calls.add(promise);void promise.then(()=>this.calls.delete(promise),()=>this.calls.delete(promise));return promise;}
  private invoke<T>(operation:()=>Promise<T>):Promise<T>{try{return this.track(operation());}catch(error){return this.track(Promise.reject(error));}}
  private accept(reply:DocumentDraftReply):void {
    const lifetime=reply.state?.admitted?.lifetime??reply.state?.outcomes[0]?.job.lifetime;
    if((reply.state===null&&this.slots.size)||lifetime!==undefined&&[...this.slots.values()].some(slot=>slot.job.lifetime!==lifetime)){
      // A null owner after admission, or an actual different-lifetime outcome,
      // expires old jobs. An empty non-null frame alone proves no lifetime.
      this.slots.clear();this.ownerLost=true;this.observationFailed=true;this.wake();return;
    }
    for(const outcome of reply.state?.outcomes??[]){
      const slot=this.slots.get(jobKey(outcome.job));if(!slot||!sameJob(slot.job,outcome.job))continue;
      slot.outcome=outcome;if(slot.retired&&!slot.ackFailed&&!this.closed)void this.ackSlot(slot).catch(()=>{});
    }
    this.wake();
  }
  private observeHint():void {
    if(this.closed||!this.service)return;this.hint++;
    if(this.observing)return;
    if(!this.ownerLost)this.observationFailed=false;
    let seen=-1;
    this.observing=Promise.resolve().then(async()=>{
      do{seen=this.hint;try{this.accept(await this.track(this.service!.snapshot()));}
      catch{this.observationFailed=true;this.wake();}}while(!this.closed&&seen!==this.hint);
    }).finally(()=>{this.observing=undefined;if(!this.closed&&seen!==this.hint)this.observeHint();});
  }
  private retireProvider():void {
    if(this.providerRetired)return;this.providerRetired=true;this.closed=true;this.epoch++;this.next?.releaseText();this.next=undefined;this.text=undefined;this.wake();
    const stop=this.unsubscribe;this.unsubscribe=undefined;try{stop?.();}catch{/* Authoritative retirement still releases local ownership. */}this.installed=undefined;this.viewRelease?.();this.viewRelease=undefined;
    this.publish('unavailable','unavailable');try{this.options.onChange?.(this.stateValue);}catch{/* Retire display ownership even if a listener fails. */}
  }
  private retireSlot(slot:Slot):void {
    slot.retired=true;if(this.closed)return;
    if(slot.outcome){if(!slot.ackFailed)void this.ackSlot(slot).catch(()=>{});return;}
    if(slot.cancelling||!this.service)return;
    slot.cancelling=this.invoke(()=>this.service!.cancel(slot.job)).then(reply=>{this.accept(reply);}).finally(()=>{slot.cancelling=undefined;});
    void slot.cancelling.catch(()=>{});
  }
  private ackSlot(slot:Slot):Promise<void>{
    if(slot.acking)return slot.acking;
    if(!this.service||this.closed)return Promise.resolve();
    const lease=this.wireLeases.get(slot.job.buffer_lifetime);if(lease)lease.needsRenewal=true;
    const operation=this.invoke(()=>this.service!.acknowledge(slot.job)).then(reply=>{this.slots.delete(jobKey(slot.job));this.accept(reply);},error=>{slot.ackFailed=true;throw error;});
    slot.acking=operation.finally(()=>{slot.acking=undefined;});return slot.acking;
  }
  private drive():void {
    if(this.running||this.closed)return;
    this.running=(async()=>{
      while(this.next&&!this.closed){const run=this.next;this.next=undefined;await this.analyze(run);}
    })().finally(()=>{this.running=undefined;if(this.next&&!this.closed)this.drive();});
    void this.running.catch(()=>{});
  }
  private legacy(run:Run):void {
    // Compatibility only when the positive core capability is absent. Reserve
    // a conservative source-derived parsing envelope before invoking old code.
    let release:(()=>void)|undefined;
    try{
      release=reserve(this.budget,'legacy-analysis',run.text.length*16+4096);
      const view=parseMetadata(run.path,run.text);this.check(run);
      const keep=reserve(this.budget,'view',this.viewAllocation(view));
      this.replaceView(view,keep);this.publish('current');
    }catch(error){if(!(error instanceof Obsolete))this.publish('unavailable',error instanceof Resource?'resource':'invalid_text');}
    finally{run.text='';run.releaseText();release?.();}
  }
  private viewAllocation(view:NoteMetadata):number {
    // Frontmatter values are shared with decoded facts. Charge them separately
    // here so dropping the full facts wrapper does not free retained strings.
    const seen=new Set<object>();let bytes=0;
    const walk=(value:unknown,depth:number)=>{if(depth>73)throw new Resource();if(typeof value==='string'){bytes+=64+value.length*2;return;}if(value&&typeof value==='object'){if(seen.has(value))return;seen.add(value);bytes+=256;for(const [key,child]of Object.entries(value)){bytes+=64+key.length*2;walk(child,depth+1);}}else bytes+=32;if(bytes>DOCUMENT_DRAFT_FRONTEND_BYTES)throw new Resource();};
    walk(view,0);return bytes;
  }
  private replaceView(view:NoteMetadata,release:()=>void):void {
    const previous=this.viewRelease;this.installed=view;this.installedRevision=String(this.revision);this.viewRelease=release;previous?.();
  }
  private leaseFor(run:Run):WireLease {
    let lease=this.wireLeases.get(this.wireLeaseId);
    if(!lease&&this.wireLeaseRetired){if(this.wireLeases.size>=32)throw new Resource();this.wireLeaseId=crypto.randomUUID();this.wireLeaseRetired=false;}
    if(lease&&(lease.retired||lease.needsRenewal||lease.lastRevision===run.revision)){
      void this.releaseLease(lease).catch(()=>{});
      // Failed old releases remain charged and bounded. Rapid demand toggles
      // cannot grow an unbounded collection of renewable nonces.
      if(this.wireLeases.size>=32)throw new Resource();
      this.wireLeaseId=crypto.randomUUID();this.wireLeaseRetired=false;lease=undefined;
    }
    if(!lease){if(this.wireLeases.size>=32)throw new Resource();const releaseAllocation=reserve(this.budget,'wire-lease',1024);lease={id:this.wireLeaseId,needsRenewal:false,retired:false,releaseAllocation};this.wireLeases.set(lease.id,lease);}
    lease.lastRevision=run.revision;return lease;
  }
  private releaseLease(lease:WireLease):Promise<void>{
    lease.retired=true;if(lease.id===this.wireLeaseId)this.wireLeaseRetired=true;if(lease.releasing)return lease.releasing;
    if(this.providerRetired)return Promise.resolve();
    // Capture a pending admission before the early buffer-scoped release. Its
    // delayed ACK may expose a job only after the first release settled.
    const start=lease.start;
    const releasing=(async()=>{
      await this.invoke(()=>this.service!.releaseBuffer(lease.id));
      if(start){await start;if(!this.providerRetired)await this.invoke(()=>this.service!.releaseBuffer(lease.id));}
      if(this.wireLeases.get(lease.id)===lease){this.wireLeases.delete(lease.id);lease.releaseAllocation();}
      for(const [key,slot]of this.slots)if(slot.job.buffer_lifetime===lease.id)this.slots.delete(key);
      this.wake();
    })().finally(()=>{if(lease.releasing===releasing)lease.releasing=undefined;});lease.releasing=releasing;return releasing;
  }
  private installPath(path:string):void {
    if(!this.installed)return;
    let release:(()=>void)|undefined;
    try{release=reserve(this.budget,'view-path',256+path.length*2);const view=Object.freeze({...this.installed,path});const previous=this.viewRelease;this.installed=view;this.viewRelease=()=>{previous?.();release?.();};this.publish(this.stateValue.status,this.stateValue.code);}
    catch{release?.();this.publish('unavailable','resource');}
  }
  private async source(run:Run):Promise<{bytes:Uint8Array;descriptor:{bytes:number;utf16:number;sha256:string};release:()=>void}>{
    let length=0;
    for(let start=0;start<run.text.length;){
      const end=Math.min(run.text.length,start+32768);
      while(start<end){const c=run.text.charCodeAt(start++);if(c>=0xd800&&c<=0xdbff){const low=run.text.charCodeAt(start++);if(!(low>=0xdc00&&low<=0xdfff))throw new InvalidText();length+=4;}else if(c>=0xdc00&&c<=0xdfff)throw new InvalidText();else length+=c<128?1:c<2048?2:3;if(length>DOCUMENT_DRAFT_SOURCE_BYTES)throw new Resource();}
      await turn();this.check(run);
    }
    const releases:(()=>void)[]=[];
    try{
      releases.push(reserve(this.budget,'source',length));let bytes=new Uint8Array(length),written=0,read=0;const encoder=new TextEncoder();
      while(read<run.text.length){let end=Math.min(run.text.length,read+32768);if(end<run.text.length&&run.text.charCodeAt(end-1)>=0xd800&&run.text.charCodeAt(end-1)<=0xdbff)end--;
        // The bounded substring and encoder output coexist with original text.
        const partRelease=reserve(this.budget,'encoding-window',(end-read)*2);
        try{const part=run.text.slice(read,end),result=encoder.encodeInto(part,bytes.subarray(written));if(result.read!==part.length)throw new Resource();written+=result.written;read=end;}finally{partRelease();}
        await turn();this.check(run);
      }
      const hashRelease=reserve(this.budget,'hash-copy',length);
      let hash:ArrayBuffer;try{hash=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);}finally{hashRelease();}
      this.check(run);const sha256=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
      const captured={bytes,descriptor:{bytes:length,utf16:run.text.length,sha256},release:()=>{captured.bytes=new Uint8Array();bytes=new Uint8Array();for(const free of releases.splice(0))free();}};return captured;
    }catch(error){for(const free of releases)free();throw error;}
  }
  private async analyze(run:Run):Promise<void>{
    let source:Awaited<ReturnType<DocumentDraftProjection['source']>>|undefined;
    try{
      source=await this.source(run);this.check(run);
      const lease=this.leaseFor(run);let settled!:()=>void;lease.start=new Promise<void>(resolve=>{settled=resolve;});
      let job:DocumentDraftJob,slot:Slot;
      try{const reply=await this.track(this.service!.request({buffer_lifetime:lease.id,text_revision:run.revision,source:source.descriptor}));
      if(!reply.state?.admitted)throw new Error();job=reply.state.admitted;
      slot={job,retired:false};run.slot=slot;this.slots.set(jobKey(job),slot);this.accept(reply);
      }finally{lease.start=undefined;settled();}
      this.check(run);
      this.accept(await this.track(this.service!.uploadBegin(job)));this.check(run);
      for(let offset=0;offset<source.bytes.length;offset+=DOCUMENT_DRAFT_CHUNK_BYTES){
        const chunk=source.bytes.subarray(offset,Math.min(source.bytes.length,offset+DOCUMENT_DRAFT_CHUNK_BYTES));
        const release=reserve(this.budget,'upload-copy',chunk.byteLength*2);
        try{this.accept(await this.track(this.service!.uploadChunk({job,offset:String(offset)},chunk)));}finally{release();}
        this.check(run);
      }
      this.accept(await this.track(this.service!.uploadSeal(job)));this.check(run);source.release();run.text='';run.releaseText();
      this.observeHint();
      while(!slot.outcome){this.check(run);if(this.observationFailed)throw new Unavailable();await new Promise<void>(resolve=>this.waiters.add(resolve));}
      this.check(run);if(slot.outcome.kind!=='ready'){this.publish('unavailable',slot.outcome.reason==='resource'?'resource':'unavailable');return;}
      await this.facts(run,slot,source.descriptor);this.check(run);await this.ackSlot(slot);
    }catch(error){if(!(error instanceof Obsolete)&&!this.closed&&run.epoch===this.epoch)this.publish('unavailable',error instanceof Resource||error instanceof DocumentDraftFactsError&&error.code==='resource'?'resource':error instanceof InvalidText?'invalid_text':error instanceof Unavailable?'unavailable':'invalid_facts');}
    finally{source?.release();run.text='';run.releaseText();if(run.slot&&this.slots.has(jobKey(run.slot.job)))this.retireSlot(run.slot);}
  }
  private async facts(run:Run,slot:Slot,descriptor:{bytes:number;utf16:number}):Promise<void>{
    const prepared=await this.track(this.service!.prepareFacts(slot.job));this.accept(prepared);this.check(run);
    const total=prepared.transfer?.facts_bytes;if(total===null||total===undefined||total>DOCUMENT_DRAFT_FACTS_WIRE_BYTES)throw new Resource();
    let wireRelease=reserve(this.budget,'facts-wire',total),textRelease:(()=>void)|undefined,parsedRelease:(()=>void)|undefined;
    try{
      let wire=new Uint8Array(total),offset=0;
      do{
        const release=reserve(this.budget,'facts-read',DOCUMENT_DRAFT_CHUNK_BYTES);
        try{const chunk=await this.track(this.service!.readFacts({job:slot.job,offset:String(offset),maximum:DOCUMENT_DRAFT_CHUNK_BYTES}));this.check(run);if(chunk.result.total_bytes!==total||chunk.result.offset!==String(offset)||offset+chunk.bytes.length>total)throw new Error();wire.set(chunk.bytes,offset);offset+=chunk.bytes.length;if(chunk.result.eof!==(offset===total)||!chunk.result.eof&&chunk.bytes.length===0)throw new Error();}finally{release();}
      }while(offset<total);
      textRelease=reserve(this.budget,'facts-text',total*2);let text=new TextDecoder('utf-8',{fatal:true}).decode(wire);wire=new Uint8Array();wireRelease();
      const preparedFacts=prepareDocumentDraftFacts(text),allocation=preparedFacts.allocation;parsedRelease=reserve(this.budget,'facts-decoded-and-indices',allocation);
      const facts=preparedFacts.decode(descriptor);text='';textRelease();this.check(run);
      // Mapping only projects supplied fields; retained full facts and its view
      // overlap stay charged until the old installed view is disposed.
      const mappingRelease=reserve(this.budget,'view-mapping',allocation+this.path.length*2+1024);
      let view:NoteMetadata;try{view=noteFromFacts(this.path,facts);}catch(error){mappingRelease();throw error;}
      const keepParsed=parsedRelease;parsedRelease=undefined;this.replaceView(view,()=>{keepParsed();mappingRelease();});this.publish('current');
    }finally{wireRelease();textRelease?.();parsedRelease?.();}
  }
  /** Retire immediately; join encoding/hash/upload/read settlement, then release
   * this exact buffer lease. A failed ACK retains owner/view charges for retry.
   * Authoritative onRetire hands remaining core Drop work to the platform close
   * barrier; it does not claim ignored frontend work actually stopped.
   * Save-state ownership is deliberately outside this API. */
  close():Promise<void>{
    this.closed=true;this.epoch++;this.next?.releaseText();this.next=undefined;this.text=undefined;this.wake();
    if(this.closing)return this.closing;
    // Buffer-scoped release is available before a delayed request ACK exposes
    // its job token. The final release below also catches a late admission.
    const early=this.service&&!this.providerRetired?[...this.wireLeases.values()].map(lease=>this.releaseLease(lease)):[];
    for(const promise of early)void promise.catch(()=>{});
    const closing=(async()=>{
      await this.running;await this.observing;await Promise.allSettled(early);while(this.calls.size)await Promise.allSettled([...this.calls]);
      if(this.service&&!this.providerRetired)for(const lease of [...this.wireLeases.values()])await this.releaseLease(lease);
      for(const lease of this.wireLeases.values())lease.releaseAllocation();this.wireLeases.clear();
      const stop=this.unsubscribe;this.unsubscribe=undefined;try{stop?.();}catch{/* The core release ACK already transferred ownership. */}this.slots.clear();this.installed=undefined;this.viewRelease?.();this.viewRelease=undefined;this.publish('unsupported');
    })().finally(()=>{if(this.closing===closing)this.closing=undefined;});this.closing=closing;return closing;
  }
}
