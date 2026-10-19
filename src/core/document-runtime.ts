import type { DocumentSnapshotId, DocumentSourceId } from './document-semantics.ts';

/** Readonly wire projections of the shared Rust runtime. Internal effect and
 * completion controls are never part of DocumentMaintenance's feature API. */
export type DocumentRuntimeFailure='staleSource'|'staleIndex'|'snapshotExpired'|'rebuildRequired'|'uncertain'|'unavailable'|'invalidData'|'fatal';
export interface DocumentRuntimeProgress {readonly prepared:number;readonly total:number;readonly ready:boolean}
export interface DocumentRuntimeStage {readonly source:DocumentSourceId;readonly snapshot:DocumentSnapshotId;readonly progress:DocumentRuntimeProgress|null}
export interface DocumentRuntimeObservation {readonly source:DocumentSourceId;readonly published:DocumentSnapshotId|null;readonly current:boolean;readonly rebuildRequired:boolean;readonly coverageComplete:boolean|null}
export type DocumentRuntimeCommand=
  |{readonly kind:'wake';readonly monotonicMs:number}|{readonly kind:'continue'|'sourceHint'|'retire'}
  |{readonly kind:'request';readonly id:string;readonly maxPumps:number;readonly maxRestarts:number;readonly forceRebuild:boolean}
  |{readonly kind:'cancelRequest';readonly id:string};
export type DocumentRuntimeEffect=
  |{readonly kind:'observe'|'recoverStage'|'initialize'|'begin'|'rebuild'}
  |{readonly kind:'pump'|'publish'|'discard';readonly snapshot:DocumentSnapshotId};
export interface DocumentRuntimeIssued {readonly lifetime:string;readonly effectId:string;readonly priority:'foreground'|'background';readonly targetSource:DocumentSourceId|null;readonly effect:DocumentRuntimeEffect}
export interface DocumentRuntimeUpdate {
  readonly lifetime:string;readonly revision:string;readonly source:DocumentSourceId|null;readonly published:DocumentSnapshotId|null;
  readonly freshness:'unknown'|'current'|'lagging'|'unavailable';
  readonly phase:'idle'|'observing'|'initializing'|'recovering'|'indexing'|'publishing'|'rebuilding'|'releasing';
  readonly progress:DocumentRuntimeProgress|null;readonly coverageComplete:boolean|null;readonly hasForegroundDemand:boolean;readonly error:DocumentRuntimeFailure|null;
}
export type DocumentRuntimeOutcome=
  |{readonly kind:'finished';readonly id:string;readonly observation:DocumentRuntimeObservation}
  |{readonly kind:'failed';readonly id:string;readonly failure:DocumentRuntimeFailure}
  |{readonly kind:'cancelled'|'retired';readonly id:string};
export interface DocumentRuntimeReduction {readonly effect:DocumentRuntimeIssued|null;readonly update:DocumentRuntimeUpdate;readonly requestOutcomes:readonly DocumentRuntimeOutcome[];readonly execution:'dispatch'|'yield'|'waitForWake'|'quiesced'}
export interface DocumentRuntimeSnapshot {readonly execution:DocumentRuntimeReduction['execution'];readonly update:DocumentRuntimeUpdate;readonly inFlight:DocumentRuntimeIssued|null;readonly lastStep:{readonly lifetime:string;readonly effectId:string;readonly reduction:DocumentRuntimeReduction}|null}

export interface DocumentRuntimeScope {readonly localStoreId:string;readonly clientId:string}
export interface DocumentFreshnessOptions {readonly maxPumps?:number;readonly maxRestarts?:number;readonly forceRebuild?:boolean}
export interface DocumentFreshnessHandle {readonly result:Promise<DocumentRuntimeObservation>;cancel():Promise<void>}
export interface DocumentMaintenance {
  observeAndSubscribe(listener:(update:DocumentRuntimeUpdate|null)=>void):Promise<{readonly snapshot:DocumentRuntimeUpdate|null;unsubscribe():void}>;
  requestFreshness(options?:DocumentFreshnessOptions):DocumentFreshnessHandle;
}
export interface DocumentRuntimeDelivery {readonly lifetime:string;readonly outcome:DocumentRuntimeOutcome}
export interface DocumentRuntimeFrame {readonly version:1;readonly scope:DocumentRuntimeScope;readonly update:DocumentRuntimeUpdate|null;readonly outcomes:readonly DocumentRuntimeDelivery[]}
export type DocumentRuntimePublicCommand=
  |{readonly kind:'request';readonly lifetime:string;readonly id:string;readonly maxPumps:number;readonly maxRestarts:number;readonly forceRebuild:boolean}
  |{readonly kind:'cancel';readonly lifetime:string;readonly id:string};
export interface DocumentRuntimeControl {readonly sequence:string;readonly command:DocumentRuntimePublicCommand}
export interface DocumentRuntimeControlAck extends DocumentRuntimeControl {readonly frame:DocumentRuntimeFrame}
/** Already admitted provider. Allocators and release callbacks belong to that
 * exact client admission and survive facade reconstruction. ACKs are distinct. */
export interface DocumentRuntimeTransport {
  readonly scope:DocumentRuntimeScope;
  allocateSequence():string;
  allocateRequestId():string;
  observe():Promise<unknown>;
  control(input:DocumentRuntimeControl):Promise<unknown>;
  ackControl(input:{readonly sequence:string}):Promise<void>;
  ackOutcome(input:{readonly lifetime:string;readonly id:string}):Promise<void>;
  subscribe(listener:()=>void,onRetire:()=>void):()=>void;
}
export const DOCUMENT_RUNTIME_BYTES=64*1024,DOCUMENT_RUNTIME_SLOTS=32;
export class DocumentRuntimeError extends Error {
  readonly code:string;
  constructor(code:string){super('Shared document maintenance is unavailable.');this.code=code;this.name='DocumentRuntimeError';}
}
function invalid():never {throw new DocumentRuntimeError('document_runtime_invalid_result');}
const encoder=new TextEncoder(),MAX_U64=18446744073709551615n;
function scalar(value:unknown,maximum=128):string {
  if(typeof value!=='string'||!value.length||value.length>maximum)invalid();
  for(let index=0;index<value.length;index++){
    const unit=value.charCodeAt(index);
    if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++index);if(!(next>=0xdc00&&next<=0xdfff))invalid();}
    else if(unit>=0xdc00&&unit<=0xdfff)invalid();
  }
  if(encoder.encode(value).byteLength>maximum)invalid();return value;
}
function identity(value:unknown):string {const text=scalar(value);if(!/^[A-Za-z0-9_-]+$/.test(text))invalid();return text;}
export function documentRuntimeCounter(value:unknown):string {const text=scalar(value,20);if(!/^(0|[1-9][0-9]*)$/.test(text)||BigInt(text)>MAX_U64)invalid();return text;}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))invalid();
  const result=value as Record<string,unknown>;if(Object.keys(result).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(result,key)))invalid();return result;
}
function boolean(value:unknown):boolean {if(typeof value!=='boolean')invalid();return value;}
function integer(value:unknown,maximum=0xffffffff):number {if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>maximum)invalid();return value;}
function enumeration<T extends string>(value:unknown,allowed:readonly T[]):T {if(!allowed.includes(value as T))invalid();return value as T;}
const failures:readonly DocumentRuntimeFailure[]=['staleSource','staleIndex','snapshotExpired','rebuildRequired','uncertain','unavailable','invalidData','fatal'];
function bounded(value:unknown):void {
  let encoded:string;try{encoded=JSON.stringify(value);}catch{return invalid();}
  if(typeof encoded!=='string'||encoded.length>DOCUMENT_RUNTIME_BYTES||encoder.encode(encoded).byteLength>DOCUMENT_RUNTIME_BYTES)throw new DocumentRuntimeError('document_runtime_capacity');
}
function source(value:unknown,store?:string):DocumentSourceId {const row=object(value,['localStoreId','watermark']),localStoreId=identity(row.localStoreId);if(store!==undefined&&localStoreId!==store)invalid();return Object.freeze({localStoreId,watermark:documentRuntimeCounter(row.watermark)});}
function versionSchema(value:unknown):number {const result=integer(value);if(!result)invalid();return result;}
function version(value:unknown):string {const result=scalar(value);if(!/^[A-Za-z0-9_.:-]+$/.test(result))invalid();return result;}
function snapshot(value:unknown,store?:string):DocumentSnapshotId {
  const row=object(value,['localStoreId','generationEpoch','generation','versions']),localStoreId=identity(row.localStoreId),v=object(row.versions,['schema','extraction','resolver','query']);
  if(store!==undefined&&localStoreId!==store||row.generation==='0')invalid();return Object.freeze({localStoreId,generationEpoch:identity(row.generationEpoch),generation:documentRuntimeCounter(row.generation),versions:Object.freeze({schema:versionSchema(v.schema),extraction:version(v.extraction),resolver:version(v.resolver),query:version(v.query)})});
}
function progress(value:unknown):DocumentRuntimeProgress|null {
  if(value===null)return null;const row=object(value,['prepared','total','ready']),prepared=integer(row.prepared),total=integer(row.total),ready=boolean(row.ready);if(prepared>total||ready&&prepared!==total)invalid();return Object.freeze({prepared,total,ready});
}
function observation(value:unknown,store?:string):DocumentRuntimeObservation {
  const row=object(value,['source','published','current','rebuildRequired','coverageComplete']),observed=source(row.source,store),published=row.published===null?null:snapshot(row.published,observed.localStoreId),current=boolean(row.current),rebuildRequired=boolean(row.rebuildRequired),coverageComplete=row.coverageComplete===null?null:boolean(row.coverageComplete);
  if(current&&(!published||rebuildRequired)||!published&&coverageComplete!==null)invalid();return Object.freeze({source:observed,published,current,rebuildRequired,coverageComplete});
}
function update(value:unknown,store?:string):DocumentRuntimeUpdate {
  const row=object(value,['lifetime','revision','source','published','freshness','phase','progress','coverageComplete','hasForegroundDemand','error']);
  const observed=row.source===null?null:source(row.source,store),published=row.published===null?null:snapshot(row.published,store??observed?.localStoreId);
  const freshness=enumeration(row.freshness,['unknown','current','lagging','unavailable'] as const),coverageComplete=row.coverageComplete===null?null:boolean(row.coverageComplete);
  if(observed&&published&&observed.localStoreId!==published.localStoreId||freshness==='current'&&(!observed||!published)||!published&&coverageComplete!==null)invalid();
  return Object.freeze({lifetime:identity(row.lifetime),revision:documentRuntimeCounter(row.revision),source:observed,published,freshness,phase:enumeration(row.phase,['idle','observing','initializing','recovering','indexing','publishing','rebuilding','releasing'] as const),progress:progress(row.progress),coverageComplete,hasForegroundDemand:boolean(row.hasForegroundDemand),error:row.error===null?null:enumeration(row.error,failures)});
}
function outcome(value:unknown,store?:string):DocumentRuntimeOutcome {
  if(!value||typeof value!=='object')invalid();const kind=(value as {kind?:unknown}).kind;
  if(kind==='finished'){const row=object(value,['kind','id','observation']);return Object.freeze({kind,id:documentRuntimeCounter(row.id),observation:observation(row.observation,store)});}
  if(kind==='failed'){const row=object(value,['kind','id','failure']);return Object.freeze({kind,id:documentRuntimeCounter(row.id),failure:enumeration(row.failure,failures)});}
  if(kind==='cancelled'||kind==='retired'){const row=object(value,['kind','id']);return Object.freeze({kind,id:documentRuntimeCounter(row.id)});}
  return invalid();
}
export function decodeDocumentRuntimeObservation(value:unknown,store?:string):DocumentRuntimeObservation {bounded(value);return observation(value,store);}
export function decodeDocumentRuntimeUpdate(value:unknown,store?:string):DocumentRuntimeUpdate {bounded(value);return update(value,store);}
export function decodeDocumentRuntimeOutcome(value:unknown,store?:string):DocumentRuntimeOutcome {bounded(value);return outcome(value,store);}

function scope(value:unknown,expected?:DocumentRuntimeScope):DocumentRuntimeScope {
  const row=object(value,['localStoreId','clientId']),result={localStoreId:identity(row.localStoreId),clientId:identity(row.clientId)};
  if(expected&&(result.localStoreId!==expected.localStoreId||result.clientId!==expected.clientId))invalid();return Object.freeze(result);
}
function frame(value:unknown,expected:DocumentRuntimeScope):DocumentRuntimeFrame {
  const row=object(value,['version','scope','update','outcomes']);if(row.version!==1)invalid();const admitted=scope(row.scope,expected);
  const rawOutcomes=row.outcomes;
  if(!Array.isArray(rawOutcomes)||rawOutcomes.length>DOCUMENT_RUNTIME_SLOTS)invalid();
  const current=row.update===null?null:update(row.update,admitted.localStoreId);
  if(!current&&rawOutcomes.length)invalid();
  const keys=new Set<string>(),outcomes=rawOutcomes.map(value=>{
    const item=object(value,['lifetime','outcome']),lifetime=identity(item.lifetime),result=outcome(item.outcome,admitted.localStoreId),key=`${lifetime}:${result.id}`;
    if(lifetime!==current?.lifetime||keys.has(key))invalid();keys.add(key);return Object.freeze({lifetime,outcome:result});
  });
  return Object.freeze({version:1,scope:admitted,update:current,outcomes:Object.freeze(outcomes)});
}
function command(value:unknown):DocumentRuntimePublicCommand {
  if(!value||typeof value!=='object')invalid();const kind=(value as {kind?:unknown}).kind;
  if(kind==='request'){
    const row=object(value,['kind','lifetime','id','maxPumps','maxRestarts','forceRebuild']),maxPumps=integer(row.maxPumps,128);if(!maxPumps)invalid();
    return Object.freeze({kind,lifetime:identity(row.lifetime),id:documentRuntimeCounter(row.id),maxPumps,maxRestarts:integer(row.maxRestarts,2),forceRebuild:boolean(row.forceRebuild)});
  }
  if(kind==='cancel'){const row=object(value,['kind','lifetime','id']);return Object.freeze({kind,lifetime:identity(row.lifetime),id:documentRuntimeCounter(row.id)});}
  return invalid();
}
function sameCommand(a:DocumentRuntimePublicCommand,b:DocumentRuntimePublicCommand):boolean {
  return a.kind===b.kind&&a.lifetime===b.lifetime&&a.id===b.id&&(a.kind!=='request'||b.kind==='request'&&a.maxPumps===b.maxPumps&&a.maxRestarts===b.maxRestarts&&a.forceRebuild===b.forceRebuild);
}
export function decodeDocumentRuntimeFrame(value:unknown,expected:DocumentRuntimeScope):DocumentRuntimeFrame {bounded(value);return frame(value,scope(expected));}
export function decodeDocumentRuntimeControl(value:unknown):DocumentRuntimeControl {
  bounded(value);const row=object(value,['sequence','command']);return Object.freeze({sequence:documentRuntimeCounter(row.sequence),command:command(row.command)});
}
export function decodeDocumentRuntimeControlAck(value:unknown,expected:DocumentRuntimeScope,input:DocumentRuntimeControl):DocumentRuntimeControlAck {
  bounded(value);const row=object(value,['sequence','command','frame']),sequence=documentRuntimeCounter(row.sequence),captured=command(row.command);
  if(sequence!==input.sequence||!sameCommand(captured,input.command))invalid();return Object.freeze({sequence,command:captured,frame:frame(row.frame,scope(expected))});
}
function defer<T>() {
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((accept,deny)=>{resolve=accept;reject=deny;});
  // A handle may be cancelled before its caller attaches to result. Keep the
  // promise rejected for that caller without an unrelated unhandled rejection.
  void promise.catch(()=>{});return {promise,resolve,reject};
}
function failureCode(value:unknown):DocumentRuntimeError {
  if(value instanceof DocumentRuntimeError)return value;
  return new DocumentRuntimeError('document_runtime_unavailable');
}
function options(value:DocumentFreshnessOptions|undefined):Required<DocumentFreshnessOptions> {
  if(value===undefined)return Object.freeze({maxPumps:8,maxRestarts:1,forceRebuild:false});
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['maxPumps','maxRestarts','forceRebuild'].includes(key)))throw new DocumentRuntimeError('invalid_request');
  const {maxPumps=8,maxRestarts=1,forceRebuild=false}=value;
  if(!Number.isInteger(maxPumps)||maxPumps<1||maxPumps>128||!Number.isInteger(maxRestarts)||maxRestarts<0||maxRestarts>2||typeof forceRebuild!=='boolean')throw new DocumentRuntimeError('invalid_request');
  return Object.freeze({maxPumps,maxRestarts,forceRebuild});
}

/** Delivery ownership only. The host runtime owns all maintenance decisions;
 * this facade never pumps, retries a stage, rebuilds or fabricates source proof. */
export function createDocumentMaintenance(transport:DocumentRuntimeTransport):DocumentMaintenance {
  const admitted=scope(transport?.scope);
  for(const key of ['allocateSequence','allocateRequestId','observe','control','ackControl','ackOutcome','subscribe'] as const)if(typeof transport[key]!=='function')throw new DocumentRuntimeError('document_runtime_unavailable');
  type Entry={owner?:object;id:string;options:Required<DocumentFreshnessOptions>;lifetime?:string;sent:boolean;admitted:boolean;done:boolean;cancelRequested:boolean;cancelAcknowledged:boolean;outcomeAcknowledged:boolean;
    result:ReturnType<typeof defer<DocumentRuntimeObservation>>;terminal:ReturnType<typeof defer<void>>;
    request?:DocumentRuntimeControl;cancelControl?:DocumentRuntimeControl;outcome?:DocumentRuntimeOutcome;
    outcomeAck?:Promise<void>;cancelPending?:Promise<void>};
  type Pending={owner:object;input:DocumentRuntimeControl;done:()=>boolean;onAck:()=>void;reply?:DocumentRuntimeControlAck};
  const entries=new Map<string,Entry>(),listeners=new Set<(update:DocumentRuntimeUpdate|null)=>void>();
  let latest:DocumentRuntimeUpdate|null=null,closed:DocumentRuntimeError|undefined,unsubscribe:(()=>void)|undefined;
  let registering=false,observing:Promise<DocumentRuntimeUpdate|null>|undefined,dirty=0,controlTail:Promise<void>=Promise.resolve(),pending:Pending|undefined;
  let lastRequest=0n,lastSequence=0n,owner:object={};
  const active=()=>{if(closed)throw closed;};
  function detach():void {const stop=unsubscribe;unsubscribe=undefined;try{stop?.();}catch{/* Provider teardown must not resurrect this receiver. */}}
  function maybeDetach():void {if(!entries.size&&!listeners.size&&!observing&&!registering&&!pending)detach();}
  function reject(entry:Entry,error:DocumentRuntimeError):void {if(!entry.done){entry.done=true;entry.result.reject(error);}}
  function retire():void {
    if(closed)return;closed=new DocumentRuntimeError('document_runtime_retired');
    for(const entry of entries.values()){reject(entry,closed);entry.terminal.reject(closed);}entries.clear();listeners.clear();pending=undefined;detach();
  }
  function attach():void {
    active();if(unsubscribe||registering)return;registering=true;
    try{const stop=transport.subscribe(()=>{if(closed)return;dirty++;if(!registering)void observe().catch(()=>{});},retire);if(typeof stop!=='function')invalid();if(closed)stop();else unsubscribe=stop;}
    finally{registering=false;}active();
  }
  function allocate(kind:'request'|'sequence'):string {
    active();const value=documentRuntimeCounter(kind==='request'?transport.allocateRequestId():transport.allocateSequence()),number=BigInt(value);
    if(number===0n||number<=(kind==='request'?lastRequest:lastSequence))invalid();if(kind==='request')lastRequest=number;else lastSequence=number;return value;
  }
  function acknowledge(entry:Entry):Promise<void> {
    if(entry.outcomeAcknowledged)return Promise.resolve();if(entry.outcomeAck)return entry.outcomeAck;if(!entry.outcome||!entry.lifetime)return Promise.resolve();
    const lifetime=entry.lifetime,id=entry.id;
    const task=Promise.resolve().then(()=>{active();if(entry.owner!==owner||entries.get(id)!==entry)throw new DocumentRuntimeError('document_runtime_expired');return transport.ackOutcome({lifetime,id});}).then(()=>{
      active();if(entry.owner!==owner||entries.get(id)!==entry)throw new DocumentRuntimeError('document_runtime_expired');entry.outcomeAcknowledged=true;if(entries.get(id)===entry){entries.delete(id);entry.terminal.resolve();maybeDetach();}
    }).catch(error=>{entry.terminal.reject(failureCode(error));throw failureCode(error);}).finally(()=>{if(entry.outcomeAck===task)entry.outcomeAck=undefined;});
    entry.outcomeAck=task;void task.catch(()=>{});return task;
  }
  function adopt(value:DocumentRuntimeFrame,origin:'observe'|'control'):void {
    active();
    const next=value.update;
    if(origin==='observe'&&(next?.lifetime??null)!==(latest?.lifetime??null)){
      // An authoritative observation retires the old provider ledger, including
      // active/terminal slots and its control ACK. Keep only transport counters.
      owner={};const expired=new DocumentRuntimeError('document_runtime_expired');
      for(const entry of entries.values())if(entry.lifetime!==undefined&&entry.lifetime!==next?.lifetime){reject(entry,expired);entry.terminal.reject(expired);entries.delete(entry.id);}
      if(pending&&pending.input.command.lifetime!==next?.lifetime){pending=undefined;controlTail=Promise.resolve();}
    }
    // Admit the entire immutable delivery before settling any continuation.
    if(latest&&next&&latest.lifetime===next.lifetime&&latest.revision===next.revision&&JSON.stringify(latest)!==JSON.stringify(next))invalid();
    for(const delivery of value.outcomes){const entry=entries.get(delivery.outcome.id);if(!entry||entry.lifetime!==delivery.lifetime)continue;
      if(!entry.sent||entry.outcome&&JSON.stringify(entry.outcome)!==JSON.stringify(delivery.outcome))invalid();}
    // Outcomes have their own identity/ACK ownership. They are consumed even
    // when cancelling one demand leaves RuntimeUpdate.revision unchanged.
    for(const delivery of value.outcomes){
      const result=delivery.outcome,entry=entries.get(result.id);
      if(!entry||entry.lifetime!==delivery.lifetime)continue;
      if(!entry.sent)invalid();
      if(entry.outcome&&JSON.stringify(entry.outcome)!==JSON.stringify(result))invalid();
      entry.outcome=result;
      if(!entry.done){entry.done=true;if(result.kind==='finished')entry.result.resolve(result.observation);
        else entry.result.reject(new DocumentRuntimeError(result.kind==='failed'?`document_runtime_${result.failure}`:`document_runtime_${result.kind}`));}
      void acknowledge(entry).catch(()=>{});
    }
    if(next===null){
      if(latest&&origin==='control'){dirty++;void observe().catch(()=>{});return;}
      latest=null;notify(null);return;
    }
    if(latest&&next.lifetime!==latest.lifetime){
      if(origin!=='observe'){dirty++;void observe().catch(()=>{});return;}
    }else if(latest){
      const before=BigInt(latest.revision),after=BigInt(next.revision);
      if(after<before){if(origin==='control'){dirty++;void observe().catch(()=>{});}return;}
      if(after===before){if(JSON.stringify(next)!==JSON.stringify(latest))invalid();return;}
      if(origin==='control'&&after>before+1n){dirty++;void observe().catch(()=>{});}
    }
    latest=next;notify(next);
  }
  function notify(value:DocumentRuntimeUpdate|null):void {for(const listener of [...listeners])try{listener(value);}catch{/* A view cannot break another demand's delivery. */}}
  function observe():Promise<DocumentRuntimeUpdate|null> {
    active();attach();if(observing)return observing;
    const task=(async()=>{let seen:number;do{seen=dirty;const raw=await transport.observe();active();adopt(decodeDocumentRuntimeFrame(raw,admitted),'observe');}while(seen!==dirty);return latest;})();
    observing=task.catch(error=>{const safe=failureCode(error);for(const entry of entries.values())reject(entry,safe);throw safe;}).finally(()=>{if(observing===accepted)observing=undefined;maybeDetach();});const accepted=observing;void accepted.catch(()=>{});return accepted;
  }
  async function flushControl():Promise<void> {
    const owned=pending;if(!owned)return;active();
    if(!owned.reply){const entry=entries.get(owned.input.command.id);if(entry&&owned.input.command.kind==='request')entry.sent=true;const raw=await transport.control(owned.input);active();if(pending!==owned||owned.owner!==owner)throw new DocumentRuntimeError('document_runtime_expired');owned.reply=decodeDocumentRuntimeControlAck(raw,admitted,owned.input);adopt(owned.reply.frame,'control');}
    if(pending!==owned||owned.owner!==owner)throw new DocumentRuntimeError('document_runtime_expired');await transport.ackControl({sequence:owned.input.sequence});active();if(pending!==owned||owned.owner!==owner)throw new DocumentRuntimeError('document_runtime_expired');owned.onAck();if(pending===owned)pending=undefined;maybeDetach();
  }
  function submit(input:DocumentRuntimeControl,done:()=>boolean,onAck:()=>void):Promise<void> {
    const submittedOwner=owner;const task=controlTail.catch(()=>{}).then(async()=>{
      active();if(submittedOwner!==owner)throw new DocumentRuntimeError('document_runtime_expired');await flushControl();if(submittedOwner!==owner)throw new DocumentRuntimeError('document_runtime_expired');if(done()){maybeDetach();return;}if(input.command.lifetime!==latest?.lifetime)throw new DocumentRuntimeError('document_runtime_expired');pending={owner,input,done,onAck};await flushControl();
    });controlTail=task;void task.catch(()=>{});return task;
  }
  async function admit(entry:Entry):Promise<void> {
    active();if(entry.admitted)return;
    if(!entry.request){
      await observe();active();if(entries.get(entry.id)!==entry)return;
      if(!latest)throw new DocumentRuntimeError('document_runtime_not_started');entry.lifetime=latest.lifetime;entry.owner=owner;
      entry.request=Object.freeze({sequence:allocate('sequence'),command:Object.freeze({kind:'request',lifetime:entry.lifetime,id:entry.id,...entry.options})});
    }
    await submit(entry.request,()=>entry.admitted||entries.get(entry.id)!==entry,()=>{entry.admitted=true;});
  }
  function cancel(entry:Entry):Promise<void> {
    if(entry.cancelPending)return entry.cancelPending;
    if(closed)return Promise.reject(closed);if(entry.sent&&entry.owner!==owner)return Promise.reject(new DocumentRuntimeError('document_runtime_expired'));entry.cancelRequested=true;
    // Cancellation before any admission is local: no backend work was sent.
    if(!entry.sent){reject(entry,new DocumentRuntimeError('document_runtime_cancelled'));entries.delete(entry.id);entry.terminal.resolve();maybeDetach();return Promise.resolve();}
    const task=(async()=>{
      await admit(entry);active();if(entry.owner!==owner)throw new DocumentRuntimeError('document_runtime_expired');
      if(!entry.cancelControl&&!entry.outcome)entry.cancelControl=Object.freeze({sequence:allocate('sequence'),command:Object.freeze({kind:'cancel',lifetime:entry.lifetime!,id:entry.id})});
      if(entry.cancelControl)await submit(entry.cancelControl,()=>entry.cancelAcknowledged,()=>{entry.cancelAcknowledged=true;});
      if(entry.outcome)await acknowledge(entry);else await entry.terminal.promise;
    })().catch(error=>{throw failureCode(error);}).finally(()=>{if(entry.cancelPending===task)entry.cancelPending=undefined;});
    entry.cancelPending=task;void task.catch(()=>{});return task;
  }
  return {
    async observeAndSubscribe(listener){
      active();if(typeof listener!=='function')throw new DocumentRuntimeError('invalid_request');const registered=(value:DocumentRuntimeUpdate|null)=>listener(value);listeners.add(registered);
      try{attach();const snapshot=await observe();active();let stopped=false;return Object.freeze({snapshot,unsubscribe(){if(stopped)return;stopped=true;listeners.delete(registered);maybeDetach();}});}
      catch(error){listeners.delete(registered);maybeDetach();throw failureCode(error);}
    },
    requestFreshness(input){
      active();const captured=options(input);if(entries.size>=DOCUMENT_RUNTIME_SLOTS)throw new DocumentRuntimeError('document_runtime_capacity');
      const id=allocate('request'),entry:Entry={id,options:captured,sent:false,admitted:false,done:false,cancelRequested:false,cancelAcknowledged:false,outcomeAcknowledged:false,result:defer(),terminal:defer()};entries.set(id,entry);
      void Promise.resolve().then(async()=>{
        if(entries.get(id)!==entry)return;attach();
        // Set sent at the actual control invocation, after the observation and
        // any earlier exact control ACK have completed.
        await admit(entry);
      }).catch(error=>{const safe=failureCode(error);reject(entry,safe);if(!entry.sent){entries.delete(id);entry.terminal.reject(safe);maybeDetach();}});
      return Object.freeze({result:entry.result.promise,cancel:()=>cancel(entry)});
    },
  };
}
