/** One immutable committed namespace/facts frame. No source bodies or maintenance
 * policy live here; publication hints only wake bounded metadata-row reads. */
import {MetadataCache, admittedNote, readonlyMetadata} from './metadata.ts';
import type {ReadonlyMetadataCache} from './metadata.ts';
import type {DocumentCursor, DocumentEntry, DocumentMetadataRowsItem, DocumentPin, DocumentService, DocumentSnapshotId, DocumentSourceId} from './document-semantics.ts';
import type {DocumentRuntimeUpdate} from './document-runtime.ts';
import type {NoteMetadata} from './types.ts';

export const COMMITTED_METADATA_MEMBERS = 100_000, COMMITTED_METADATA_BYTES = 64 * 1024 * 1024;
export interface CommittedMetadataFrame {
  readonly snapshot: DocumentSnapshotId;
  readonly source: DocumentSourceId;
  readonly coverageComplete: boolean;
  entries(): IterableIterator<[string, DocumentEntry]>;
  row(path: string): DocumentMetadataRowsItem | undefined;
  readonly metadata: ReadonlyMetadataCache;
}
export interface CommittedMetadataState {
  readonly status: 'pending' | 'current' | 'stale' | 'unavailable';
  readonly frame: CommittedMetadataFrame | null;
}
function sameSnapshot(a:DocumentSnapshotId,b:DocumentSnapshotId):boolean {
  return a.localStoreId===b.localStoreId&&a.generationEpoch===b.generationEpoch&&a.generation===b.generation&&a.versions.schema===b.versions.schema&&a.versions.extraction===b.versions.extraction&&a.versions.resolver===b.versions.resolver&&a.versions.query===b.versions.query;
}
function sameSource(a:DocumentSourceId,b:DocumentSourceId):boolean{return a.localStoreId===b.localStoreId&&a.watermark===b.watermark;}
function fail():never {throw new Error('Committed metadata frame is unavailable');}
function entry(item:DocumentMetadataRowsItem):DocumentEntry{return item.kind==='folder'?item.entry:item.value.entry;}

/** Conservative retained-allocation charge, not a measurement of VM heap. Also
 * count canonical JSON bytes without allocating a whole-row serialization. The
 * strict wire decoder already bounded depth, field shapes and scalar values. */
function cost(value:unknown):{heap:number;encoded:number} {
  let heap=0,encoded=0;
  function add(h:number,b:number):void {heap+=h;encoded+=b;if(heap>COMMITTED_METADATA_BYTES||encoded>COMMITTED_METADATA_BYTES)fail();}
  function string(s:string):void {
    add(32+s.length*2,2);
    for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);add(0,c===34||c===92||[8,9,10,12,13].includes(c)?2:c<32?6:c<128?1:c<2048?2:c>=0xd800&&c<=0xdbff?(i++,4):3);}
  }
  function walk(v:unknown):void {
    add(32,0);
    if(v===null){add(0,4);return;}if(typeof v==='string'){string(v);return;}
    if(typeof v==='number'){add(8,String(v).length);return;}if(typeof v==='boolean'){add(0,v?4:5);return;}
    if(Array.isArray(v)){add(v.length*8,2+Math.max(0,v.length-1));for(const item of v)walk(item);return;}
    if(!v||typeof v!=='object')fail();add(0,2);let n=0;
    for(const key in v)if(Object.hasOwn(v,key)){add(24,n++?2:1);string(key);walk((v as Record<string,unknown>)[key]);}
  }
  walk(value);return {heap,encoded};
}
// Compatibility objects copy only array slots / property bindings. Strings and
// recursive values remain shared with the immutable admitted DTO. Reserve their
// containers before copying, without walking shared property values again.
function compatibilityHeap(item:DocumentMetadataRowsItem):number {
  const m=item.kind==='file'?item.value.metadata:null;
  return m?256+m.properties.length*80+(m.tags.length+m.aliases.length)*16+m.headings.length*128+m.links.length*256:0;
}
interface Retained {readonly pin:DocumentPin;readonly frame:CommittedMetadataFrame;readonly rows:ReadonlyMap<string,DocumentMetadataRowsItem>;readonly notes:ReadonlyMap<string,NoteMetadata>;readonly costs:ReadonlyMap<string,{heap:number;encoded:number}>}

export class CommittedMetadataProjection {
  private stateValue:CommittedMetadataState=Object.freeze({status:'pending',frame:null});
  private installed:Retained|undefined;
  private readonly held=new Set<DocumentPin>();
  private closed=false;
  private unsubscribe:(()=>void)|undefined;
  private attached:Promise<void>|undefined;
  private started:Promise<void>|undefined;
  private running:Promise<void>|undefined;
  private closing:Promise<void>|undefined;
  private dirty=0;
  private latest:DocumentRuntimeUpdate|null=null;
  private locallyStale=false;
  private invalidationOwner:object={};
  private invalidatedObservation:{lifetime:string;revision:string}|null=null;
  private loadOwner:object|undefined;
  private readonly service:DocumentService;
  private readonly active:()=>boolean;
  private readonly changed:(state:CommittedMetadataState)=>void;
  constructor(service:DocumentService,active:()=>boolean,changed:(state:CommittedMetadataState)=>void) {
    this.service=service;this.active=active;this.changed=changed;
  }
  get state():CommittedMetadataState{return this.active()?this.stateValue:Object.freeze({status:'unavailable',frame:null});}
  private alive():boolean{return !this.closed&&this.active();}
  private publish(status:CommittedMetadataState['status']):void {
    if(!this.alive())return;const frame=this.installed?.frame??null;
    if(this.stateValue.status===status&&this.stateValue.frame===frame)return;
    this.stateValue=Object.freeze({status,frame});this.changed(this.stateValue);
  }
  invalidate():void {
    if(!this.alive())return;this.invalidationOwner={};
    this.invalidatedObservation=this.latest?{lifetime:this.latest.lifetime,revision:this.latest.revision}:null;
    this.locallyStale=true;this.publish(this.installed?'stale':'pending');
  }
  start(options:{waitForFrame?:boolean}={}):Promise<void> {
    if(!this.alive())return Promise.resolve();
    if(!this.started){
      const attached=(async()=>{
        if(this.service.maintenance){
          const observed=await this.service.maintenance.observeAndSubscribe(update=>this.hint(update));
          if(!this.alive()){observed.unsubscribe();return;}this.unsubscribe=observed.unsubscribe;this.latest=observed.snapshot;
          if(this.freshObservation())this.locallyStale=false;
        }
      })();
      // Both callers share attachment and hydration ownership. Namespace-ready
      // startup may stop awaiting here; close still joins the complete task.
      this.attached=attached.catch(()=>{this.publish('unavailable');});
      this.started=(async()=>{
        await attached;
        if(this.alive())await this.request();
      })().catch(()=>{this.publish('unavailable');});
    }
    return options.waitForFrame===false?this.attached!:this.started;
  }
  private hint(update:DocumentRuntimeUpdate|null):void {
    if(!this.alive())return;this.latest=update;
    if(this.freshObservation())this.locallyStale=false;
    this.publish(this.installed?'stale':'pending');
    // Attach-before-observe is owned by DocumentMaintenance. Do not pump or
    // request freshness here; an update is only a coalesced read wake.
    if(this.unsubscribe) {
      const frame=this.installed?.frame;
      if(frame&&update?.published&&sameSnapshot(frame.snapshot,update.published)){this.publish(this.current(frame)?'current':'stale');return;}
      void this.request();
    }else this.dirty++;
  }
  private async closePin(pin:DocumentPin):Promise<void>{await pin.close();this.held.delete(pin);}
  private async cleanRetired():Promise<void>{
    for(const pin of this.held)if(pin!==this.installed?.pin)await this.closePin(pin);
  }
  request():Promise<void> {
    if(!this.alive())return Promise.resolve();this.dirty++;
    if(this.running)return this.running;
    const task=(async()=>{
      while(this.alive()&&this.dirty){this.dirty=0;try{await this.load();}catch(error){
        const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
        this.publish(code==='not_ready'||code==='index_not_ready'?(this.installed?'stale':'pending'):'unavailable');
      }}
    })().finally(()=>{if(this.running===task)this.running=undefined;});
    this.running=task;return task;
  }
  private async load():Promise<void> {
    await this.cleanRetired();if(!this.alive())return;
    const predecessor=this.installed,owner={},invalidation=this.invalidationOwner;this.loadOwner=owner;
    const valid=()=>this.alive()&&this.loadOwner===owner&&this.installed===predecessor;
    const pin=await this.service.open();this.held.add(pin);
    if(!this.alive()){await this.closePin(pin);return;}
    try {
      if(!pin.metadataRows)fail();
      if(predecessor&&sameSnapshot(pin.snapshot,predecessor.frame.snapshot)){
        if(!sameSource(pin.source,predecessor.frame.source)||pin.coverageComplete!==predecessor.frame.coverageComplete)fail();
        await this.closePin(pin);this.publish(this.current(predecessor.frame)?'current':'stale');return;
      }
      const baseline=predecessor?{pinId:predecessor.pin.pinId,snapshot:predecessor.frame.snapshot}:undefined;
      let cursor:DocumentCursor|null=null,profile:{mode:'reset'|'delta';from:DocumentSnapshotId|null}|undefined;
      let rows=new Map<string,DocumentMetadataRowsItem>(),notesById=new Map<string,NoteMetadata>(),costs=new Map<string,{heap:number;encoded:number}>(),heap=0,encoded=0;
      const touched=new Set<string>();
      do {
        const raw=await pin.metadataRows(cursor?{cursor,limit:32}:{...(baseline?{baseline}:{}),limit:32});
        if(!valid())fail();
        // DocumentPin.metadataRows is the admitted typed boundary: the common
        // facade already strictly validates and freezes the entire wire DTO.
        // Only transfer/frame invariants belong here, not another deep decoder.
        const page=raw,value=page.result.value;
        if(!sameSnapshot(page.result.snapshot,pin.snapshot)||!sameSnapshot(value.snapshot,pin.snapshot)||!sameSource(page.result.source,pin.source)||page.result.coverageComplete!==pin.coverageComplete||value.coverageComplete!==pin.coverageComplete)fail();
        if(profile&&(value.mode!==profile.mode||(value.from===null)!==(profile.from===null)||value.from&&profile.from&&!sameSnapshot(value.from,profile.from)))fail();
        if(value.mode==='reset'&&(value.from!==null||value.removedEntryIds.length))fail();
        if((page.cursor===null)!==value.scanComplete||value.complete!==(value.scanComplete&&value.coverageComplete))fail();
        if(!profile){
          profile={mode:value.mode,from:value.from};
          if(value.mode==='delta'){
            if(!predecessor||!value.from||!sameSnapshot(value.from,predecessor.frame.snapshot))fail();
            rows=new Map(predecessor.rows);notesById=new Map(predecessor.notes);costs=new Map(predecessor.costs);
            for(const c of costs.values()){heap+=c.heap;encoded+=c.encoded;}
          }
        }
        for(const id of value.removedEntryIds){
          if(touched.has(id)||!rows.has(id))fail();touched.add(id);
          const old=costs.get(id)!;heap-=old.heap;encoded-=old.encoded;rows.delete(id);notesById.delete(id);costs.delete(id);
        }
        for(const item of value.rows){
          const id=entry(item).id;if(touched.has(id))fail();touched.add(id);
          const charge=cost(item),old=costs.get(id);
          charge.heap+=compatibilityHeap(item);
          // Reserve conservative per-member Map/Set slots, path indexes and
          // compatibility namespace containers before retaining each member.
          charge.heap+=1024+entry(item).path.length*8;charge.encoded+=1;
          heap+=charge.heap-(old?.heap??0);encoded+=charge.encoded-(old?.encoded??0);
          if(rows.size+(rows.has(id)?0:1)>COMMITTED_METADATA_MEMBERS||heap>COMMITTED_METADATA_BYTES||encoded>COMMITTED_METADATA_BYTES)fail();
          const note=admittedNote(item);
          rows.set(id,item);costs.set(id,charge);if(note)notesById.set(id,note);else notesById.delete(id);
        }
        cursor=page.cursor;
      }while(cursor);
      if(!valid())fail();
      const paths=new Map<string,DocumentMetadataRowsItem>(),namespace=new Map<string,DocumentEntry>(),notes=new Map<string,NoteMetadata>();
      for(const item of rows.values()){
        const member=entry(item);if(paths.has(member.path))fail();paths.set(member.path,item);namespace.set(member.path,member);
        const note=notesById.get(member.id);if(note)notes.set(member.path,note);
      }
      const metadata=new MetadataCache();metadata.adopt(notes,[...namespace.values()].filter(member=>member.kind==='file').map(member=>member.path));
      const frame:CommittedMetadataFrame=Object.freeze({snapshot:pin.snapshot,source:pin.source,coverageComplete:pin.coverageComplete,entries:()=>namespace.entries(),row:(path:string)=>paths.get(path),metadata:readonlyMetadata(metadata)});
      this.installed={pin,frame,rows,notes:notesById,costs};this.locallyStale=this.invalidationOwner!==invalidation||!this.freshObservation();
      this.publish(this.current(frame)?'current':'stale');
      if(predecessor)await this.closePin(predecessor.pin);
    }catch(error){if(pin!==this.installed?.pin)await this.closePin(pin);throw error;}
  }
  private freshObservation():boolean {
    const now=this.latest,invalidated=this.invalidatedObservation;
    // A DTO re-delivery of the same runtime revision is not evidence that a
    // later local save was observed. Maintenance owns revision monotonicity.
    return !!now&&(!invalidated||now.lifetime!==invalidated.lifetime||BigInt(now.revision)>BigInt(invalidated.revision));
  }
  private current(frame:CommittedMetadataFrame):boolean {
    return !this.locallyStale&&this.freshObservation()&&!!this.latest&&this.latest.freshness==='current'&&!!this.latest.published&&sameSnapshot(frame.snapshot,this.latest.published)&&!!this.latest.source&&sameSource(frame.source,this.latest.source);
  }
  close():Promise<void> {
    this.closed=true;this.loadOwner=undefined;try{this.unsubscribe?.();}catch{/* Delivery teardown cannot restore ownership. */}finally{this.unsubscribe=undefined;}
    if(this.closing)return this.closing;
    const task=(async()=>{await this.started;await this.running;for(const pin of this.held)await this.closePin(pin);this.installed=undefined;this.stateValue=Object.freeze({status:'unavailable',frame:null});})().finally(()=>{if(this.closing===task)this.closing=undefined;});
    this.closing=task;return task;
  }
}
