/** Shared read-only transport contract for Rust-owned document semantics.
 * IDs and decimal counters are canonical wire values validated by Rust/host
 * admission. A path is never an entry ID, revision, cursor or snapshot identity.
 * No parser, resolver, Base evaluator or source writer belongs in this module. */
export interface DocumentVersions {readonly schema:number;readonly extraction:string;readonly resolver:string;readonly query:string}
export interface DocumentSnapshotId {readonly localStoreId:string;readonly generationEpoch:string;readonly generation:string;readonly versions:DocumentVersions}
export interface DocumentSourceId {readonly localStoreId:string;readonly watermark:string}
declare const pinBrand:unique symbol,cursorBrand:unique symbol,stageBrand:unique symbol;
export type DocumentPinId=string&{readonly[pinBrand]:true};
export type DocumentCursor=string&{readonly[cursorBrand]:true};
export type DocumentStageId=string&{readonly[stageBrand]:true};
export interface DocumentEntry {readonly id:string;readonly revision:string;readonly path:string;readonly kind:'file'|'folder';readonly deleted:boolean}
export interface DocumentRange {readonly bytes:readonly[number,number];readonly utf16:readonly[number,number]}
export type DocumentValue=null|boolean|number|string|readonly DocumentValue[]|{readonly[key:string]:DocumentValue};
export type DocumentPropertyType='text'|'list'|'number'|'checkbox'|'date'|'datetime'|'tags'|'unknown';
export interface DocumentProperty {readonly key:string;readonly value:DocumentValue;readonly type:DocumentPropertyType;readonly keyRange:DocumentRange}
export interface DocumentDiagnostic {readonly code:string;readonly severity:'error'|'warning';readonly range:DocumentRange}
export interface DocumentHeading {readonly text:string;readonly level:number;readonly line:number;readonly range:DocumentRange}
export interface DocumentLink {readonly kind:'wiki'|'markdown';readonly embed:boolean;readonly target:string;readonly fragment:string;readonly destination:string;readonly range:DocumentRange;readonly targetRange:DocumentRange;readonly definitionRange:DocumentRange|null}
export interface DocumentTask {readonly status:string;readonly checked:boolean;readonly completed:boolean;readonly text:string;readonly line:number;readonly range:DocumentRange;readonly statusRange:DocumentRange;readonly textRange:DocumentRange}
export interface DocumentMetadata {
  readonly schemaVersion:number;readonly dialectVersion:string;readonly entryId:string;readonly contentRevision:string;
  readonly sourceLength:{readonly bytes:number;readonly utf16:number};
  readonly frontmatter:{readonly state:'absent'|'valid'|'invalid'|'unclosed';readonly range:DocumentRange|null;readonly bodyStart:{readonly byte:number;readonly utf16:number}};
  readonly properties:readonly DocumentProperty[];readonly aliases:readonly string[];readonly tags:readonly string[];
  readonly tagOccurrences:readonly{readonly name:string;readonly range:DocumentRange}[];
  readonly headings:readonly DocumentHeading[];readonly links:readonly DocumentLink[];readonly tasks:readonly DocumentTask[];readonly diagnostics:readonly DocumentDiagnostic[];
}
export type DocumentExclusion='binary'|'unreadable'|'sourceLimit'|'extractionLimit';
export interface DocumentMetadataRow {readonly entry:DocumentEntry;readonly metadata:DocumentMetadata|null;readonly exclusion:DocumentExclusion|null}
export interface DocumentQueryResult<T> {readonly snapshot:DocumentSnapshotId;readonly source:DocumentSourceId;readonly coverageComplete:boolean;readonly value:T}
export interface DocumentLiteralHit {readonly entry:DocumentEntry;readonly line:number;readonly range:DocumentRange;readonly snippet:string;readonly snippetTruncated:boolean}
export interface DocumentRelationship {readonly source:DocumentEntry;readonly target:DocumentEntry;readonly linkIndex:number;readonly link:DocumentLink}
export interface DocumentPageStatus {readonly snapshot:DocumentSnapshotId;readonly next:null;readonly scanComplete:boolean;readonly coverageComplete:boolean;readonly complete:boolean}
export interface DocumentLiteralPage extends DocumentPageStatus {readonly hits:readonly DocumentLiteralHit[];readonly sourceBytes:number;readonly documents:number}
export interface DocumentRelationshipPage extends DocumentPageStatus {readonly edges:readonly DocumentRelationship[]}
/** Only this outer cursor is a continuation. The inner Rust page.next is null. */
export interface DocumentPage<T extends DocumentPageStatus> {readonly result:DocumentQueryResult<T>;readonly cursor:DocumentCursor|null}
export type DocumentBaseValue=
  |{readonly type:'null'}|{readonly type:'boolean';readonly value:boolean}|{readonly type:'number';readonly value:number}|{readonly type:'string';readonly value:string}
  |{readonly type:'list';readonly value:readonly DocumentBaseValue[]}|{readonly type:'object';readonly value:readonly(readonly[string,DocumentBaseValue])[]}
  |{readonly type:'date';readonly timestamp:number;readonly hasTime:boolean}
  |{readonly type:'duration';readonly years:number;readonly months:number;readonly weeks:number;readonly days:number;readonly hours:number;readonly minutes:number;readonly seconds:number;readonly milliseconds:number}
  |{readonly type:'file';readonly path:string}|{readonly type:'link';readonly path:string;readonly target:{readonly entryId:string;readonly revision:string}|null;readonly display:string|null;readonly external:boolean}
  |{readonly type:'error';readonly code:string;readonly message:string};
export interface DocumentBaseResult {
  readonly snapshotId:DocumentSnapshotId;readonly view:DocumentValue;
  readonly rows:readonly{readonly entryId:string;readonly revision:string;readonly path:string;readonly values:Readonly<Record<string,DocumentBaseValue>>}[];
  readonly groups:readonly{readonly keyId:string|null;readonly key:DocumentBaseValue|null;readonly entryIds:readonly string[]}[];
  readonly groupOptions:readonly{readonly keyId:string;readonly key:DocumentBaseValue;readonly count:number;readonly listed:boolean}[];
  readonly properties:readonly string[];readonly availableProperties:readonly string[];
  readonly counts:{readonly scanned:number;readonly matched:number;readonly afterGroupOrder:number;readonly afterSearch:number;readonly returned:number};
  readonly diagnostics:readonly{readonly phase:string;readonly entryId:string;readonly path:string;readonly property:string|null;readonly code:string;readonly message:string}[];
  readonly relationshipsAvailable:boolean;readonly metadataComplete:boolean;
  readonly metadataIssues:readonly{readonly witness:{readonly entryId:string;readonly revision:string};readonly exclusion:DocumentExclusion|null;readonly diagnostics:readonly DocumentDiagnostic[];readonly propertiesUnavailable:boolean}[];
  readonly stepsUsed:number;
}
/** Shared normal-vault calls capture clockMs once per invocation and default maxRows to 1000. */
export interface DocumentBaseOptions {readonly viewIndex?:number;readonly searchTerms?:readonly string[];readonly ignorePaths?:readonly string[];readonly clockMs?:number;readonly timezone?:string;readonly maxRows?:number;readonly currentEntryId?:string;readonly maxSteps?:number}
export interface DocumentBaseRead {readonly definition:DocumentEntry;readonly result:DocumentBaseResult}
export type DocumentTaskFilter='all'|'today'|'unscheduled';
export type DocumentStatusCategory='not_started'|'working'|'done';
export interface DocumentTaskOptions {readonly filter?:DocumentTaskFilter;readonly clockMs?:number;readonly timezone?:string;readonly showDone?:boolean;readonly maxRows?:number}
export interface DocumentTaskWitness {readonly entryId:string;readonly revision:string}
export interface DocumentTypeProperty {readonly id:string;readonly key:string;readonly label:string;readonly datatype:string;readonly options:readonly{readonly id:string;readonly label:string;readonly category:DocumentStatusCategory|null}[];readonly default:DocumentValue}
export interface DocumentTaskType {readonly witness:DocumentTaskWitness;readonly typeId:string;readonly label:string;readonly status:DocumentTypeProperty;readonly plannedDay:DocumentTypeProperty|null;readonly deadline:DocumentTypeProperty|null;readonly captureDefaults:readonly(readonly[string,DocumentValue])[]}
export interface DocumentTaskRow {readonly witness:DocumentTaskWitness;readonly path:string;readonly title:string;readonly typeId:string;readonly statusId:string|null;readonly statusLabel:string|null;readonly category:DocumentStatusCategory|null;readonly statusDefaulted:boolean;readonly plannedDay:string|null;readonly deadline:string|null}
export interface DocumentTasksRead {
  readonly definitions:readonly DocumentEntry[];readonly types:readonly DocumentTaskType[];
  readonly result:{readonly snapshotId:DocumentSnapshotId;readonly typeWitnesses:readonly DocumentTaskWitness[];readonly coverageComplete:boolean;readonly rows:readonly DocumentTaskRow[];readonly groups:readonly{readonly typeId:string;readonly category:DocumentStatusCategory|null;readonly statusId:string|null;readonly entryIds:readonly string[]}[];readonly matched:number;readonly truncated:boolean;readonly diagnostics:readonly{readonly witness:DocumentTaskWitness;readonly property:string;readonly code:string}[];readonly typeDiagnostics:readonly{readonly witness:DocumentTaskWitness;readonly code:string;readonly yaml?:{readonly code:string;readonly range:DocumentRange}}[];readonly metadataIssues:DocumentBaseResult['metadataIssues']};
}
export interface DocumentStatus {
  readonly source:DocumentSourceId;readonly snapshot:DocumentSnapshotId|null;readonly coveredSource:DocumentSourceId|null;
  /** Exact host capture comparison, not sequence equality alone. */
  readonly current:boolean;readonly rebuildRequired:boolean;readonly coverageComplete:boolean|null;
}
export interface DocumentStage {readonly stageId:DocumentStageId;readonly snapshot:DocumentSnapshotId;readonly progress:null|{readonly prepared:number;readonly total:number;readonly reused:number|null;readonly ready:boolean}}
export interface DocumentPin {
  readonly pinId:DocumentPinId;readonly snapshot:DocumentSnapshotId;readonly source:DocumentSourceId;readonly coverageComplete:boolean;
  close():Promise<void>;
  metadata(id:string):Promise<DocumentQueryResult<DocumentMetadataRow>>;
  search(input:{readonly query:string;readonly cursor?:DocumentCursor|null;readonly limit?:number}):Promise<DocumentPage<DocumentLiteralPage>>;
  backlinks(input:{readonly targetId:string;readonly cursor?:DocumentCursor|null;readonly limit?:number}):Promise<DocumentPage<DocumentRelationshipPage>>;
  tasks?(input:{readonly typeIds:readonly string[];readonly options?:DocumentTaskOptions}):Promise<DocumentQueryResult<DocumentTasksRead>>;
  base(input:{readonly id:string;readonly viewName?:string|null;readonly options?:DocumentBaseOptions}):Promise<DocumentQueryResult<DocumentBaseRead>>;
}
/** Optional normal-vault capability. Closing a pin never releases its vault.
 * Every read stays on its retained generation. Expiry requires explicit reopen;
 * callers must never silently retry against a different generation. */
export interface DocumentService {
  status():Promise<DocumentStatus>;initialize():Promise<void>;open():Promise<DocumentPin>;rebuild():Promise<void>;
  begin():Promise<DocumentStage>;pump(stageId:DocumentStageId):Promise<DocumentStage>;publish(stageId:DocumentStageId):Promise<DocumentSnapshotId>;discard(stageId:DocumentStageId):Promise<void>;
}
export interface DocumentSemanticsCapability {readonly documentSemantics?:DocumentService}
export const DOCUMENT_REQUEST_BYTES=64*1024,DOCUMENT_RESPONSE_BYTES=16*1024*1024,DOCUMENT_PAGE_LIMIT=1000;
export class DocumentSemanticsError extends Error {
  readonly code:string;
  constructor(code:string){super('Shared document semantics are unavailable.');this.code=code;this.name='DocumentSemanticsError';}
}


/** Already-admitted host transport. Query payloads come directly from Rust JSON.
 * This seam adds lifecycle ownership and validates retained generation headers. */
export interface DocumentTransport {
  status():Promise<unknown>;initialize():Promise<void>;rebuild():Promise<void>;
  begin():Promise<unknown>;pump(stageId:string):Promise<unknown>;publish(stageId:string):Promise<unknown>;discard(stageId:string):Promise<void>;
  open():Promise<unknown>;closePin(pinId:string):Promise<void>;
  metadata(input:{pinId:string;id:string}):Promise<unknown>;
  search(input:{pinId:string;query:string;cursor?:string;limit?:number}):Promise<unknown>;
  backlinks(input:{pinId:string;targetId:string;cursor?:string;limit?:number}):Promise<unknown>;
  tasks?(input:{pinId:string;typeIds:string[];options?:DocumentTaskOptions}):Promise<unknown>;
  base(input:{pinId:string;id:string;viewName?:string|null;options?:{viewIndex?:number;searchTerms?:string[];ignorePaths?:string[];clockMs?:number;timezone?:string;maxRows?:number;currentEntryId?:string;maxSteps?:number}}):Promise<unknown>;
}
const invalid=():never=>{throw new DocumentSemanticsError('invalid_document_response');};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return invalid();return value as Record<string,unknown>;}
function text(value:unknown):string{if(typeof value!=='string'||!value.length)return invalid();return value;}
function bool(value:unknown):boolean{if(typeof value!=='boolean')return invalid();return value;}
function counter(value:unknown):string{const result=text(value);if(!/^(0|[1-9][0-9]*)$/.test(result)||result.length>20||BigInt(result)>18446744073709551615n)return invalid();return result;}
function integer(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)return invalid();return value;}
export function documentSource(value:unknown):DocumentSourceId{const row=object(value);return Object.freeze({localStoreId:text(row.localStoreId),watermark:counter(row.watermark)});}
export function documentSnapshot(value:unknown):DocumentSnapshotId{
  const row=object(value),v=object(row.versions);
  return Object.freeze({localStoreId:text(row.localStoreId),generationEpoch:text(row.generationEpoch),generation:counter(row.generation),versions:Object.freeze({schema:integer(v.schema),extraction:text(v.extraction),resolver:text(v.resolver),query:text(v.query)})});
}
function sameSource(a:DocumentSourceId,b:DocumentSourceId):boolean{return a.localStoreId===b.localStoreId&&a.watermark===b.watermark;}
function sameSnapshot(a:DocumentSnapshotId,b:DocumentSnapshotId):boolean{return a.localStoreId===b.localStoreId&&a.generationEpoch===b.generationEpoch&&a.generation===b.generation&&a.versions.schema===b.versions.schema&&a.versions.extraction===b.versions.extraction&&a.versions.resolver===b.versions.resolver&&a.versions.query===b.versions.query;}
function bounded(value:unknown,maximum:number,request=false):void{
  if(request){
    const inspect=(part:unknown,depth:number):void=>{if(depth>8)throw new DocumentSemanticsError('invalid_request');if(typeof part==='string'){for(let i=0;i<part.length;i++){const c=part.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=part.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new DocumentSemanticsError('invalid_request');}else if(c>=0xdc00&&c<=0xdfff)throw new DocumentSemanticsError('invalid_request');}}else if(part&&typeof part==='object'){for(const child of Object.values(part))inspect(child,depth+1);}};inspect(value,0);
  }
  const encoded=JSON.stringify(value);if(typeof encoded!=='string'||encoded.length>maximum||new TextEncoder().encode(encoded).byteLength>maximum)throw new DocumentSemanticsError(request?'request_too_large':'response_too_large');
}
export function documentErrorCode(error:unknown):string|undefined{return error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:undefined;}
export function createDocumentService(transport:DocumentTransport):DocumentService{
  const call=async<T>(input:unknown,action:()=>Promise<T>):Promise<T>=>{bounded(input,DOCUMENT_REQUEST_BYTES,true);const value=await action();if(value!==undefined)bounded(value,DOCUMENT_RESPONSE_BYTES);return value;};
  const stage=(value:unknown):DocumentStage=>{const row=object(value),p=row.progress===null?null:object(row.progress);return Object.freeze({stageId:text(row.stageId) as DocumentStageId,snapshot:documentSnapshot(row.snapshot),progress:p===null?null:Object.freeze({prepared:integer(p.prepared),total:integer(p.total),reused:p.reused===null?null:integer(p.reused),ready:bool(p.ready)})});};
  return {
    async status(){const row=object(await call({},()=>transport.status()));const source=documentSource(row.source),snapshot=row.snapshot===null?null:documentSnapshot(row.snapshot),coveredSource=row.coveredSource===null?null:documentSource(row.coveredSource);if(snapshot&&snapshot.localStoreId!==source.localStoreId||coveredSource&&coveredSource.localStoreId!==source.localStoreId)return invalid();return {source,snapshot,coveredSource,current:bool(row.current),rebuildRequired:bool(row.rebuildRequired),coverageComplete:row.coverageComplete===null?null:bool(row.coverageComplete)};},
    initialize:()=>call({},()=>transport.initialize()),rebuild:()=>call({},()=>transport.rebuild()),
    async begin(){return stage(await call({},()=>transport.begin()));},async pump(stageId){return stage(await call({stageId},()=>transport.pump(stageId)));},
    async publish(stageId){return documentSnapshot(await call({stageId},()=>transport.publish(stageId)));},discard:stageId=>call({stageId},()=>transport.discard(stageId)),
    async open(){
      const row=object(await call({},()=>transport.open())),pinId=text(row.pinId) as DocumentPinId,snapshot=documentSnapshot(row.snapshot),source=documentSource(row.source),coverageComplete=bool(row.coverageComplete);
      if(snapshot.localStoreId!==source.localStoreId)return invalid();let closed=false,closing:Promise<void>|undefined;
      const live=()=>{if(closed||closing)throw new DocumentSemanticsError('snapshot_expired');};
      const report=<T>(value:unknown):DocumentQueryResult<T>=>{const result=object(value);if(!sameSnapshot(documentSnapshot(result.snapshot),snapshot)||!sameSource(documentSource(result.source),source)||bool(result.coverageComplete)!==coverageComplete)return invalid();return result as unknown as DocumentQueryResult<T>;};
      const page=<T extends DocumentPageStatus>(value:unknown):DocumentPage<T>=>{const row=object(value),result=report<T>(row.result),p=object(result.value);if(!sameSnapshot(documentSnapshot(p.snapshot),snapshot)||p.next!==null||bool(p.coverageComplete)!==coverageComplete)return invalid();bool(p.complete);bool(p.scanComplete);if(row.cursor!==null)text(row.cursor);return {result,cursor:row.cursor as DocumentCursor|null};};
      const limit=(value:number|undefined)=>{if(value!==undefined&&(!Number.isInteger(value)||value<1||value>DOCUMENT_PAGE_LIMIT))throw new DocumentSemanticsError('invalid_request');};
      return Object.freeze({pinId,snapshot,source,coverageComplete,
        close(){if(closed)return Promise.resolve();if(closing)return closing;closing=call({pinId},()=>transport.closePin(pinId)).then(()=>{closed=true;}).finally(()=>{closing=undefined;});return closing;},
        async metadata(id:string){live();return report<DocumentMetadataRow>(await call({pinId,id},()=>transport.metadata({pinId,id})));},
        async search(input:{query:string;cursor?:DocumentCursor|null;limit?:number}){live();limit(input.limit);const request={pinId,query:input.query,...(input.cursor==null?{}:{cursor:input.cursor}),limit:input.limit};return page<DocumentLiteralPage>(await call(request,()=>transport.search(request)));},
        async backlinks(input:{targetId:string;cursor?:DocumentCursor|null;limit?:number}){live();limit(input.limit);const request={pinId,targetId:input.targetId,...(input.cursor==null?{}:{cursor:input.cursor}),limit:input.limit};return page<DocumentRelationshipPage>(await call(request,()=>transport.backlinks(request)));},
        ...(transport.tasks?{async tasks(input:{typeIds:readonly string[];options?:DocumentTaskOptions}){
          live();
          if(!Array.isArray(input.typeIds)||input.typeIds.length>128||input.typeIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))||new Set(input.typeIds).size!==input.typeIds.length)throw new DocumentSemanticsError('invalid_request');
          if(input.options===null)throw new DocumentSemanticsError('invalid_request');
          const supplied=input.options??{};
          if(typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).some(key=>!['filter','clockMs','timezone','showDone','maxRows'].includes(key)))throw new DocumentSemanticsError('invalid_request');
          const options=Object.fromEntries(Object.entries(supplied).filter(([,value])=>value!==undefined)) as DocumentTaskOptions;
          if(options.clockMs!==undefined&&!Number.isSafeInteger(options.clockMs)||options.maxRows!==undefined&&(!Number.isInteger(options.maxRows)||options.maxRows<1||options.maxRows>10000)||options.filter!==undefined&&!['all','today','unscheduled'].includes(options.filter)||options.timezone!==undefined&&(typeof options.timezone!=='string'||new TextEncoder().encode(options.timezone).length>128)||options.showDone!==undefined&&typeof options.showDone!=='boolean')throw new DocumentSemanticsError('invalid_request');
          const request={pinId,typeIds:[...input.typeIds],options};
          const value=report<DocumentTasksRead>(await call(request,()=>transport.tasks!(request)));live();
          if(!sameSnapshot(documentSnapshot(value.value.result.snapshotId),snapshot)||value.value.definitions.length!==request.typeIds.length||value.value.definitions.some((entry,index)=>entry.id!==request.typeIds[index])||typeof value.value.result.coverageComplete!=='boolean'||value.value.result.coverageComplete&&!coverageComplete)return invalid();
          return value;
        }}:{}),
        async base(input:{id:string;viewName?:string|null;options?:DocumentBaseOptions}){live();if(input.options?.currentEntryId!==undefined&&(typeof input.options.currentEntryId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.options.currentEntryId)))throw new DocumentSemanticsError('invalid_request');if(input.options?.maxSteps!==undefined&&(!Number.isInteger(input.options.maxSteps)||input.options.maxSteps<1||input.options.maxSteps>2000000))throw new DocumentSemanticsError('invalid_request');const {searchTerms,ignorePaths,...scalars}=input.options??{};const definedScalars=Object.fromEntries(Object.entries(scalars).filter(([,value])=>value!==undefined));const options:NonNullable<Parameters<DocumentTransport['base']>[0]['options']>={...definedScalars,clockMs:scalars.clockMs===undefined?Date.now():scalars.clockMs,maxRows:scalars.maxRows===undefined?1000:scalars.maxRows};if(searchTerms)options.searchTerms=[...searchTerms];if(ignorePaths)options.ignorePaths=[...ignorePaths];const request={pinId,id:input.id,viewName:input.viewName,options};return report<DocumentBaseRead>(await call(request,()=>transport.base(request)));},
      });
    },
  };
}

export interface DocumentIndexProgress {readonly phase:'initialize'|'rebuild'|'indexing'|'publish';readonly prepared?:number;readonly total?:number}
export interface CatchUpDocumentOptions {readonly isCurrent:()=>boolean;readonly onProgress?:(progress:DocumentIndexProgress)=>void;readonly maxPumps?:number;readonly maxRestarts?:number;readonly rebuild?:boolean}
interface Maintenance {stage?:DocumentStage;running?:Promise<DocumentStatus>;rebuildAttempted:boolean;rebuilding:boolean;explicitRebuild:boolean;listeners:Set<CatchUpDocumentOptions>}
const maintenance=new WeakMap<DocumentService,Maintenance>();
const cancelled=()=>new DocumentSemanticsError('document_request_cancelled');
const staleCodes=new Set(['stale_source','stale_index','source_changed','index_source_changed','index_head_changed']);
const rebuildCodes=new Set(['rebuild_required','index_rebuild_required']);
/** One maintenance owner per service; every caller owns only its UI continuation.
 * Partial stages survive bounded returns and cancellation. No pin is opened,
 * closed or silently replaced. A rebuild explicitly invalidates existing pins. */
export async function catchUpDocumentIndex(service:DocumentService,options:CatchUpDocumentOptions):Promise<DocumentStatus>{
  if(!options.isCurrent())throw cancelled();
  const pumps=options.maxPumps??8,restarts=options.maxRestarts??1;
  if(!Number.isInteger(pumps)||pumps<1||pumps>128||!Number.isInteger(restarts)||restarts<0||restarts>2)throw new DocumentSemanticsError('invalid_request');
  let state=maintenance.get(service);if(!state){state={rebuildAttempted:false,rebuilding:false,explicitRebuild:false,listeners:new Set()};maintenance.set(service,state);}
  const owned=state;owned.listeners.add(options);if(options.rebuild&&!owned.rebuilding)owned.explicitRebuild=true;
  const active=()=>{if(![...owned.listeners].some(listener=>listener.isCurrent()))throw cancelled();};
  const progress=(value:DocumentIndexProgress)=>{for(const listener of owned.listeners)if(listener.isCurrent())listener.onProgress?.(value);};
  const step=async<T>(action:()=>Promise<T>):Promise<T>=>{active();const result=await action();active();return result;};
  const reset=async()=>{owned.rebuilding=true;try{progress({phase:'rebuild'});active();await service.rebuild();owned.stage=undefined;active();}finally{owned.rebuilding=false;}};
  if(!owned.running){
    owned.running=(async()=>{
      let attempts=0,used=0;
      maintenanceLoop:for(;;){
        try{
          if(owned.explicitRebuild){owned.explicitRebuild=false;owned.rebuildAttempted=true;await reset();}
          let status=await step(()=>service.status());
          // A publication may commit before its transport acknowledgment is
          // lost. The exact published identity is a witness even when newer
          // source changes have already made that generation lag behind.
          if(owned.stage&&status.snapshot&&sameSnapshot(owned.stage.snapshot,status.snapshot))owned.stage=undefined;
          if(owned.explicitRebuild)continue maintenanceLoop;
          if(status.current){if(owned.stage){active();await service.discard(owned.stage.stageId);owned.stage=undefined;active();}if(owned.explicitRebuild)continue maintenanceLoop;owned.rebuildAttempted=false;return status;}
          if(status.rebuildRequired){
            if(owned.rebuildAttempted)throw new DocumentSemanticsError('rebuild_required');
            owned.rebuildAttempted=true;await reset();
            status=await step(()=>service.status());
            if(status.rebuildRequired)throw new DocumentSemanticsError('rebuild_required');
          }
          if(!status.snapshot&&!owned.stage){progress({phase:'initialize'});await step(()=>service.initialize());}
          if(!owned.stage){active();owned.stage=await service.begin();active();}
          while(used<pumps){
            if(!owned.stage.progress?.ready){
              // Assign the returned checkpoint before checking caller liveness;
              // a cancelled subscriber cannot lose the helper's known stage.
              active();owned.stage=await service.pump(owned.stage.stageId);active();used++;
              const p=owned.stage.progress;progress({phase:'indexing',...(p?{prepared:p.prepared,total:p.total}:{})});if(owned.explicitRebuild)continue maintenanceLoop;
            }
            if(owned.stage.progress?.ready){
              progress({phase:'publish'});active();await service.publish(owned.stage.stageId);owned.stage=undefined;active();
              const result=await step(()=>service.status());if(owned.explicitRebuild)continue maintenanceLoop;if(result.current)owned.rebuildAttempted=false;return result;
            }
            await step(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));
          }
          const result=await step(()=>service.status());if(owned.explicitRebuild)continue maintenanceLoop;return result;
        }catch(error){
          const code=documentErrorCode(error);
          if(code&&staleCodes.has(code)&&attempts<restarts){
            if(owned.stage){active();await service.discard(owned.stage.stageId);owned.stage=undefined;active();}
            attempts++;await step(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));continue;
          }
          // Corruption reported by a bounded operation is handled once by the
          // same visible policy as a status report; source motion never resets.
          if(code&&rebuildCodes.has(code)&&!owned.rebuildAttempted){
            owned.rebuildAttempted=true;await reset();continue;
          }
          throw error;
        }
      }
    })().finally(()=>{owned.running=undefined;});
  }
  try{const result=await owned.running;if(!options.isCurrent())throw cancelled();return result;}
  finally{owned.listeners.delete(options);}
}
