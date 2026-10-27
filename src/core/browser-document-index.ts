import {createBrowserDocumentPreview,browserPreviewCall} from './browser-document-preview.ts';
import type {PreviewWasm,PreviewOwner,PreviewBuilder,PreviewCandidate,PreviewReadReply} from './browser-document-preview.ts';
import {previewRequest} from './document-preview.ts';
import {documentSnapshot} from './document-semantics.ts';
import {browserDocumentRuntime} from './browser-document-runtime.ts';
import type {BrowserDocumentIndexMaintenance,BrowserDocumentRuntimeWasm,DocumentRuntimeStage} from './browser-document-runtime.ts';
import {searchSpec,richToken,richPreparation,richPage as decodeRichPage,searchCompileDiagnostic} from './document-search-validation.ts';
import type {SearchSpec} from './document-search-types.ts';
import type {DocumentTaskOptions,DocumentParseCacheCounters,DocumentSnapshotId} from './document-semantics.ts';
import type {DocumentTransport,DocumentSourceId} from './document-semantics.ts';
import {metadataRowsRequest,metadataRowsPage,METADATA_ROWS_BYTES,METADATA_ROWS_LIMIT} from './document-metadata-projection.ts';
import {browserDocumentParseCache} from './browser-document-parse-cache.ts';
import type {BrowserParseCachePolicy,BrowserParseCacheAdmission} from './browser-document-parse-cache.ts';
import {BrowserVaultError} from './browser-vault.ts';
import type {BrowserVaultPresentation, EntryState} from './browser-vault.ts';
import {decimalU64, normalizedTransact} from './browser-normalized-idb.ts';
import type {StreamingPublication} from './browser-sync-streaming.ts';

/** Disposable, local-only rows in the existing authority DB. Source writes never
 * consult these keys. No source envelopes, receipts or sync exports contain them. */
const PREFIX='document-index:v1/', CATALOG=PREFIX+'catalog';
const LIMITS=Object.freeze({header:16*1024*1024,row:16*1024*1024,text:16*1024*1024,records:100000,
  metadata:64*1024*1024,baseRecords:50000,baseFacts:8*1024*1024,projection:256*1024*1024,cache:512*1024*1024,pins:4,metadataCursors:8,stages:4,generations:3});
const fail=(code:string,details?:unknown)=>new BrowserVaultError(code,'Disposable document index is unavailable; source files remain authoritative',details);
const size=(text:string)=>new TextEncoder().encode(text).byteLength;
// Rust Manifest orders valid UTF8 strings by Unicode scalar value. JavaScript's
// default UTF16 ordering differs for BMP/astral paths; locale ordering also differs.
function manifestStringOrder(a:string,b:string):number {
  for(let at=0;at<Math.min(a.length,b.length);){
    const left=a.codePointAt(at)!,right=b.codePointAt(at)!;
    if(left!==right)return left-right;
    at+=left>0xffff?2:1;
  }
  return a.length-b.length;
}
function equal(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a)&&Array.isArray(b)&&a.length!==b.length)return false;
  const left=Object.keys(a).sort(),right=Object.keys(b).sort(),leftRow=a as Record<string,unknown>,rightRow=b as Record<string,unknown>;
  return left.length===right.length&&left.every((key,index)=>key===right[index]&&equal(leftRow[key],rightRow[key]));
}
interface Free {free():void}
export interface BrowserIndexSource {localStoreId:string;watermark:string}
export interface BrowserIndexSnapshot {localStoreId:string;generationEpoch:string;generation:string;versions:unknown}
export interface BrowserIndexHeader {source:{localStoreId:string;watermark:string};entries:EntryState[];expectedIndex:BrowserIndexSnapshot|null;nextIndex:BrowserIndexSnapshot}
interface Builder extends Free, Partial<PreviewBuilder> {headerJson():string;pendingJson():string;beginPump():void;addText(id:string,bytes:Uint8Array):void;cacheKeyJson(id:string,bytes:Uint8Array):string;addCachedText(id:string,key:string,payload:string):string;extractText(id:string,bytes:Uint8Array):string;addBinary(id:string):void;addUnreadable(id:string):void;addPersisted(id:string,row:string):void;rowJson(id:string):string;ready():boolean;finish():Generation}
interface Generation extends Free {headerJson():string;snapshotJson():string;rowJson(id:string):string;coverageComplete():boolean;metadataJson(id:string):string;tasksJson(sources:string,options:string):string;baseJson(id:string,bytes:Uint8Array,facts:string,options:string,viewName?:string|null):string;propertyTargetsJson?(facts:string,options:string):string;resolveJson(id:string,destination:string):string;backlinksJson(id:string,token:string,limit:number):string;openLiteral(query:string,token:string,limit:number):LiteralPage}
interface PreparationCache extends Free {clear():void;baseJson(generation:Generation,id:string,bytes:Uint8Array,facts:string,options:string,monotonicMs:number,viewName?:string|null):string}
interface LiteralPage extends Free {nextReadJson():string;accept(bytes:Uint8Array):void;finishJson():string}
interface RichPrepared extends Free {}
interface RichDrive extends Free {nextActionJson():string;accept(bytes:Uint8Array):void;finish():RichPrepared}
interface RichOwner extends Free {clear():void;startQuery(generation:Generation,spec:string,facts:string):string;prepareJson(query:string):string;openDrive(query:string,cursor:string):RichDrive;commitJson(prepared:RichPrepared):string;closeQuery(query:string):void}
interface MetadataScan extends Free {fork():MetadataScan;sameCheckpoint(other:MetadataScan):boolean;isNextCheckpointOf(other:MetadataScan):boolean;usesBaseline():boolean;pageJson(nextOpaqueCursor:string):string;retire():void}
interface MetadataScanConstructor {new(destination:Generation,limit:number):MetadataScan;readonly prototype:MetadataScan;withBaseline(destination:Generation,baseline:Generation,limit:number):MetadataScan}
export interface BrowserDocumentIndexWasm extends BrowserDocumentRuntimeWasm,PreviewWasm {WasmDocumentIndexGeneration?:{prototype:{propertyTargetsJson?:unknown}};documentIndexAllocateJson(input:string):string;documentIndexVersionsJson():string;documentParseCachePolicyJson():string;documentParseCacheAdmissionJson(input:string):string;WasmDocumentIndexBuilder:new(input:string)=>Builder;WasmDocumentIndexPreparationCache:new()=>PreparationCache;WasmDocumentRichSearchOwner:new(nonce:string)=>RichOwner;WasmDocumentMetadataRowsScan?:MetadataScanConstructor}
export interface BrowserDocumentIndexHost {
  db:IDBDatabase;authorityId:string;clientId:string;wasm:BrowserDocumentIndexWasm;assertActive():void;
  readPublication(tx:IDBTransaction,done:(value:StreamingPublication)=>void,abort:(error:unknown)=>void):void;
}
export interface BrowserIndexStage {stageId:string;snapshot:BrowserIndexSnapshot;progress:{prepared:number;total:number;reused:number;ready:boolean;parseCache:DocumentParseCacheCounters};prepared:number;total:number;ready:boolean}
export interface BrowserIndexPin {pinId:string;snapshot:BrowserIndexSnapshot;source:BrowserIndexSource;coverageComplete:boolean}
export interface BrowserDocumentIndex extends Pick<DocumentTransport,'metadataRowsAvailable'|'metadataRows'> {
  readonly basePreviewAvailable?:boolean;previewOpen?(input:{previewId:string}):Promise<unknown>;previewBase?(input:{previewId:string;id:string;viewName?:string|null;options?:unknown}):Promise<PreviewReadReply>;previewClose?(input:{previewId:string}):Promise<unknown>;
  initialize():Promise<void>;discard(stageId:string):Promise<void>;
  status():Promise<{sourceWatermark:string;snapshot:BrowserIndexSnapshot|null;coveredWatermark:string|null;rebuildRequired:boolean;current:boolean;source:BrowserIndexSource;coveredSource:BrowserIndexSource|null;coverageComplete:boolean|null}>;
  begin():Promise<BrowserIndexStage>;pump(stageId:string):Promise<BrowserIndexStage>;publish(stageId:string):Promise<BrowserIndexSnapshot>;
  open():Promise<BrowserIndexPin>;closePin(pinId:string):Promise<void>;
  search(input:{pinId:string;query:string;cursor?:string;limit?:number}):Promise<unknown>;
  resolve(input:{pinId:string;sourceId:string;destination:string}):Promise<unknown>;
  backlinks(input:{pinId:string;targetId:string;cursor?:string;limit?:number}):Promise<unknown>;
  metadata(input:{pinId:string;id:string}):Promise<unknown>;
  tasks(input:{pinId:string;typeIds:string[];options?:DocumentTaskOptions}):Promise<unknown>;
  readonly propertyTargetsAvailable?:boolean;
  propertyTargets?(input:{pinId:string;options?:{propertyDefinitionsSource?:{id:string;source:string};currentEntryId?:string;clockMs?:number;timezone?:string;maxRows?:number;maxSteps?:number}}):Promise<unknown>;
  base(input:{pinId:string;id:string;viewName?:string|null;options?:{viewIndex?:number;searchTerms?:string[];ignorePaths?:string[];clockMs?:number;timezone?:string;maxRows?:number;currentEntryId?:string;maxSteps?:number;inlineSource?:{source:string;startByte:number;endByte:number};propertyDefinitionsSource?:{id:string;source:string};summaryPreviewProperty?:string;summaryPreviewGroupKeyId?:string;randomSeed?:number}}):Promise<unknown>;
  richStart(input:{pinId:string;spec:SearchSpec}):Promise<unknown>;
  richPrepare(input:{pinId:string;queryId:string}):Promise<unknown>;
  richPage(input:{pinId:string;queryId:string;cursor:string}):Promise<unknown>;
  richClose(input:{pinId:string;queryId:string}):Promise<void>;
  rebuild():Promise<void>;close():Promise<void>;
}
interface Catalog {rebuilding?:string;version:2;localStoreId:string;epoch:string;allocated:string;head:string|null;generations:Descriptor[];pins:{id:string;clientId:string;generation:string}[]}
interface Descriptor {id:string;clientId:string;state:'staging'|'published'|'deleting';snapshot:BrowserIndexSnapshot;sourceWatermark:string;coverageComplete:boolean;wasPublished:boolean;rows:number;bytes:number;metadataBytes:number}
interface CachedRow {sourceDescriptor:unknown;entry:EntryState;presentation:BrowserVaultPresentation;record:string;projection?:Uint8Array}
interface SourceCapture {publication:StreamingPublication;descriptors:{id:string;content:any}[]}
interface StoredHeader {rust:string;capture:SourceCapture}
interface PreviewStamp {sequence:string;configuration:unknown;head:unknown}
interface StagePreview {stamp:PreviewStamp;configured:boolean;seen:number;candidate?:PreviewCandidate;error?:unknown}
interface Stage {preview?:StagePreview;failed?:boolean;capture:SourceCapture;id:string;previous:string|null;header:BrowserIndexHeader;builder?:Builder;generation?:Generation;prepared:number;total:number;reused:number;parseCache:{hits:number;misses:number;unavailable:number;corrupt:number;unsupported:number}}
type ParseCacheOutcome='hit'|'miss'|'unavailable'|'corrupt'|'unsupported';
const root=(id:string)=>PREFIX+'g/'+id+'/';
const rowKey=(id:string,entryId:string)=>root(id)+'row/'+entryId;
const headerKey=(id:string)=>root(id)+'header';
const hex=(bytes:Uint8Array)=>Array.from(bytes).map(n=>n.toString(16).padStart(2,'0')).join('');
const byteDigest=async(bytes:Uint8Array):Promise<string>=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)));
const digest=(value:string):Promise<string>=>byteDigest(new TextEncoder().encode(value));
function pageLimit(value:unknown):number{if(value===undefined)return 100;if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>1000)throw fail('index_invalid_budget');return value;}
function baseOptions(input:unknown,targets=false):string {
  if(input===undefined)input={};if(!input||typeof input!=='object'||Array.isArray(input))throw fail('index_invalid_request');
  const value=input as Record<string,unknown>,allowed=new Set(targets?['propertyDefinitionsSource','currentEntryId','clockMs','timezone','maxRows','maxSteps']:['viewIndex','searchTerms','ignorePaths','clockMs','timezone','maxRows','currentEntryId','maxSteps','inlineSource','propertyDefinitionsSource','summaryPreviewProperty','summaryPreviewGroupKeyId','randomSeed']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw fail('index_invalid_request');
  const result:Record<string,unknown>={};
  for(const key of ['viewIndex','maxRows','clockMs','maxSteps','randomSeed'])if(value[key]!==undefined){const n=value[key];if(typeof n!=='number'||!Number.isSafeInteger(n)||(key!=='clockMs'&&n<0))throw fail('index_invalid_request');result[key]=n;}
  if(value.maxSteps!==undefined&&(Number(value.maxSteps)<1||Number(value.maxSteps)>2000000))throw fail('index_invalid_request');
  if(value.currentEntryId!==undefined){if(!validId(value.currentEntryId))throw fail('index_invalid_request');result.currentEntryId=value.currentEntryId;}
  const clock=value.clockMs===undefined?Date.now():value.clockMs;if(typeof clock!=='number'||!Number.isSafeInteger(clock))throw fail('index_invalid_request');result.clockMs=clock;
  result.maxRows=value.maxRows===undefined?(targets?10000:1000):value.maxRows;
  if(value.timezone!==undefined)result.timezone=inputText(value.timezone,256);
  for(const key of ['searchTerms','ignorePaths'])if(value[key]!==undefined){const array=value[key];if(!Array.isArray(array)||array.length>1000)throw fail('index_input_limit');result[key]=array.map(item=>inputText(item,4096));}
  if(value.summaryPreviewProperty!==undefined)result.summaryPreviewProperty=inputText(value.summaryPreviewProperty,65536);
  if(value.summaryPreviewGroupKeyId!==undefined){const group=inputText(value.summaryPreviewGroupKeyId,8*1024*1024);if(!group.length||typeof result.summaryPreviewProperty!=='string')throw fail('index_invalid_request');result.summaryPreviewGroupKeyId=group;}
  if(value.inlineSource!==undefined){const inline=value.inlineSource as Record<string,unknown>;if(!inline||typeof inline!=='object'||Array.isArray(inline)||Object.keys(inline).length!==3||!['source','startByte','endByte'].every(key=>Object.hasOwn(inline,key))||!Number.isSafeInteger(inline.startByte)||!Number.isSafeInteger(inline.endByte)||Number(inline.startByte)<0||Number(inline.endByte)>LIMITS.text||Number(inline.endByte)<=Number(inline.startByte))throw fail('index_invalid_request');result.inlineSource={source:inputText(inline.source,262144),startByte:inline.startByte,endByte:inline.endByte};}
  // Keep the legacy key recognized only to return a clear unsupported-input
  // error. It can no longer attach a global schema to arbitrary files.
  if(value.propertyDefinitionsSource!==undefined){if(value.propertyDefinitionsSource===null)throw fail('index_invalid_request');throw fail('index_unsupported_property_definitions');}
  const raw=JSON.stringify(result);if(size(raw)>1024*1024-16*1024)throw fail('index_input_limit');return raw;
}
function taskOptions(input:unknown):string {
  if(input===undefined)input={};if(!input||typeof input!=='object'||Array.isArray(input))throw fail('index_invalid_request');
  const value=input as Record<string,unknown>,allowed=new Set(['filter','clockMs','timezone','showDone','maxRows']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw fail('index_invalid_request');
  const result:Record<string,unknown>={};
  if(value.filter!==undefined){if(!['all','today','unscheduled'].includes(value.filter as string))throw fail('index_invalid_request');result.filter=value.filter;}
  const clock=value.clockMs===undefined?Date.now():value.clockMs;if(typeof clock!=='number'||!Number.isSafeInteger(clock))throw fail('index_invalid_request');result.clockMs=clock;
  if(value.timezone!==undefined)result.timezone=inputText(value.timezone,128);
  if(value.showDone!==undefined){if(typeof value.showDone!=='boolean')throw fail('index_invalid_request');result.showDone=value.showDone;}
  if(value.maxRows!==undefined){if(typeof value.maxRows!=='number'||!Number.isInteger(value.maxRows)||value.maxRows<1||value.maxRows>10000)throw fail('index_invalid_request');result.maxRows=value.maxRows;}
  return JSON.stringify(result);
}
/** Bound task requests before structured-cloning them into the normal worker. */
export function captureBrowserTaskQuery(input:Parameters<BrowserDocumentIndex['tasks']>[0]):Parameters<BrowserDocumentIndex['tasks']>[0] {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['pinId','typeIds','options'].includes(key))||!validId(input.pinId)||!Array.isArray(input.typeIds)||input.typeIds.length>128||input.typeIds.some(id=>!validId(id))||new Set(input.typeIds).size!==input.typeIds.length)throw fail('index_invalid_request');
  return {pinId:input.pinId,typeIds:[...input.typeIds],options:JSON.parse(taskOptions(input.options)) as DocumentTaskOptions};
}
/** Capture and bound the complete request before posting it to the worker. */
export function captureBrowserMetadataRows(input:Parameters<NonNullable<DocumentTransport['metadataRows']>>[0]):Parameters<NonNullable<DocumentTransport['metadataRows']>>[0] {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(key=>!['pinId','baseline','cursor','limit'].includes(key))||Object.values(Object.getOwnPropertyDescriptors(input)).some(field=>!('value'in field)||!field.enumerable)||!validId(input.pinId))throw fail('index_invalid_request');
  try {
    const {pinId,...page}=input,checked=metadataRowsRequest(page),captured={pinId,...(checked.baseline?{baseline:checked.baseline}:{}),...(checked.cursor==null?{}:{cursor:checked.cursor}),...(checked.limit===undefined?{}:{limit:checked.limit})};
    if(size(JSON.stringify(captured))>65536)throw fail('index_invalid_request');
    return captured;
  } catch {throw fail('index_invalid_request');}
}
function inputText(value:unknown,maxBytes:number):string{if(typeof value!=='string'||value.length>maxBytes||size(value)>maxBytes)throw fail('index_invalid_request');for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw fail('index_invalid_request');}else if(code>=0xdc00&&code<=0xdfff)throw fail('index_invalid_request');}return value;}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function json<T>(raw:string,max=LIMITS.header):T {if(typeof raw!=='string'||size(raw)>max)throw fail('index_rebuild_required');try{return JSON.parse(raw) as T;}catch{throw fail('index_rebuild_required');}}
function rust<T>(action:()=>T):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;let code='index_rebuild_required',details:unknown;try{const parsed=JSON.parse(String(error));if(typeof parsed.code==='string'&&parsed.code.startsWith('index_'))code=parsed.code;details=parsed.diagnostic;}catch{}throw new BrowserVaultError(code,'Shared Rust document engine rejected the operation',details,'rust');}}

const richFail=(code:string)=>new BrowserVaultError(code,'Rich document search is unavailable');
function captureRichRequest(input:unknown,keys:readonly string[]):Record<string,unknown>&{pinId:string} {
  if(!input||typeof input!=='object'||Array.isArray(input)||(Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null)||Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(input,key)))throw richFail('invalid_request');
  const row=input as Record<string,unknown>;let encoded:string;try{encoded=JSON.stringify(row);}catch{throw richFail('invalid_request');}if(size(encoded)>65536)throw richFail('search_resource');
  if(!validId(row.pinId))throw richFail('invalid_request');const result:Record<string,unknown>&{pinId:string}={pinId:row.pinId};
  for(const key of keys){if(key==='pinId')continue;try{result[key]=key==='spec'?searchSpec(row[key]):richToken(row[key]);}catch{throw richFail('invalid_request');}}
  return result;
}
function richRust<T>(action:()=>T,query:string):T {try{return action();}catch(error){if(error instanceof BrowserVaultError)throw error;
  let parsed:{code?:unknown;diagnostic?:unknown};try{const raw=String(error);if(size(raw)>65536)throw error;parsed=JSON.parse(raw);}catch{throw fail('index_rebuild_required');}
  if(parsed.code==='search_compile'){let diagnostic;try{diagnostic=searchCompileDiagnostic(parsed.diagnostic,query);}catch{throw fail('index_rebuild_required');}throw new BrowserVaultError('search_compile','The search query could not be compiled',{diagnostic},'rust');}
  if(typeof parsed.code==='string'&&(['search_resource','search_busy','search_expired','cancelled','invalid_request'].includes(parsed.code)||parsed.code.startsWith('index_')))throw new BrowserVaultError(parsed.code,'Shared Rust document search rejected the operation',undefined,'rust');
  throw fail('index_rebuild_required');
}}
function richAction(raw:string,snapshot:BrowserIndexSnapshot,entries:ReadonlyMap<string,EntryState>):{kind:'yield'|'done'}|{kind:'readText';entry:EntryState;bytes:number} {
  const value=json<Record<string,unknown>>(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw fail('index_rebuild_required');
  if(value.kind==='yield'||value.kind==='done'){if(Object.keys(value).length!==1)throw fail('index_rebuild_required');return {kind:value.kind};}
  if(value.kind!=='readText'||Object.keys(value).length!==5||!['kind','entry','snapshot','digest','bytes'].every(key=>Object.hasOwn(value,key))||!equal(value.snapshot,snapshot))throw fail('index_rebuild_required');
  const entry=value.entry as EntryState;if(!entry||!equal(entries.get(entry.id),entry)||!Array.isArray(value.digest)||value.digest.length!==32||value.digest.some(n=>typeof n!=='number'||!Number.isInteger(n)||n<0||n>255)||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<0||Number(value.bytes)>LIMITS.text)throw fail('index_rebuild_required');
  return {kind:'readText',entry,bytes:Number(value.bytes)};
}
export function createBrowserDocumentIndexBackend(host:BrowserDocumentIndexHost):{index:BrowserDocumentIndex;maintenance:BrowserDocumentIndexMaintenance} {
  const stages=new Map<string,Stage>(),pins=new Map<string,{generation:string;value:Generation;header:BrowserIndexHeader;capture:SourceCapture;coverageComplete:boolean}>();
  type Pin=ReturnType<typeof pins.get> & {};
  interface MetadataBinding {pinId:string;pin:Pin;baseline?:{pinId:string;pin:Pin};requested?:NonNullable<Parameters<NonNullable<DocumentTransport['metadataRows']>>[0]['baseline']>;limit:number;initial:boolean;scan:MetadataScan}
  const metadataCursors=new Map<string,Map<string,MetadataBinding>>(),metadataBusy=new Set<string>();
  const propertyTargetsAvailable=typeof host.wasm.WasmDocumentIndexGeneration?.prototype.propertyTargetsJson==='function';
  const Preview=host.wasm.WasmDocumentPreviewOwner;
  const previewParts:[unknown,readonly string[]][]=[
    [Preview,['clear','retireStage','free']],[host.wasm.WasmDocumentPreview,['descriptorJson','sameCapture','beginBase','free']],
    [host.wasm.WasmDocumentPreviewQuery,['descriptorJson','prepareBase','cancel','free']],
    [host.wasm.WasmDocumentPreviewReply,['encodedLength','writeInto','free']],
    [host.wasm.WasmDocumentIndexBuilder,['configurePreview','commitPreviewRowsJson','capturePreview','retirePreview']],
  ];
  if(Preview!==undefined&&previewParts.some(([ctor,methods])=>typeof ctor!=='function'||methods.some(method=>typeof (ctor as {prototype?:Record<string,unknown>}).prototype?.[method]!=='function')))throw fail('index_rebuild_required');
  let previewOwner:PreviewOwner|undefined;
  const retirePreviewStage=(stage:Stage)=>{const owned=stage.preview;if(!owned)return;try{try{stage.builder?.retirePreview?.();}finally{previewOwner?.retireStage(stage.id);}}finally{owned.candidate?.value.free();owned.candidate=undefined;}};
  const retirePreviews=()=>{previews.clear();for(const stage of stages.values())retirePreviewStage(stage);if(previewOwner){try{previewOwner.clear();}finally{previewOwner.free();previewOwner=undefined;}}};
  const MetadataRows=host.wasm.WasmDocumentMetadataRowsScan;
  if(MetadataRows!==undefined&&(typeof MetadataRows!=='function'||typeof MetadataRows.withBaseline!=='function'||(['fork','pageJson','sameCheckpoint','isNextCheckpointOf','usesBaseline','retire','free'] as const).some(method=>typeof MetadataRows.prototype?.[method]!=='function')))throw fail('index_rebuild_required');
  function releaseMetadata(){for(const slots of metadataCursors.values())for(const binding of slots.values()){binding.scan.retire();binding.scan.free();}metadataCursors.clear();}
  function retireMetadataPin(pinId:string){for(const [destination,slots]of metadataCursors){for(const [cursor,binding]of slots)if(destination===pinId||binding.baseline?.pinId===pinId){binding.scan.retire();binding.scan.free();slots.delete(cursor);}if(!slots.size)metadataCursors.delete(destination);}}
  interface RichSession {value:RichOwner;alive:boolean}
  interface RichQueryBinding {pinId:string;pin:Pin;session:RichSession;core:string;spec:SearchSpec;entries:ReadonlyMap<string,EntryState>;retired:boolean;busy:boolean}
  const richQueries=new Map<string,RichQueryBinding>();let richOwner:RichSession|undefined;
  const releaseRich=()=>{const session=richOwner;richOwner=undefined;for(const query of richQueries.values())query.retired=true;richQueries.clear();if(session){session.alive=false;try{session.value.clear();}finally{session.value.free();}}};
  let closed=false,preparation:PreparationCache|undefined;let maintenance:BrowserDocumentIndexMaintenance|undefined;
  const releasePreparation=()=>{const owned=preparation;preparation=undefined;owned?.free();};
  const releaseQueryOwners=()=>{retirePreviews();releaseMetadata();releaseRich();releasePreparation();for(const pin of pins.values())pin.value.free();pins.clear();};
  const active=()=>{if(closed)throw fail('index_closed');try{host.assertActive();}catch(error){void maintenance?.close().catch(()=>{});try{releaseMetadata();}catch{/* Preserve the owner/lease error. */}try{releasePreparation();}catch{/* Preserve the owner/lease error. */}try{releaseRich();}catch{/* Preserve the owner/lease error. */}try{retirePreviews();}catch{/* Preserve the owner/lease error. */}throw error;}};
  const monotonicMs=()=>{const value=Math.floor(performance.now());if(!Number.isSafeInteger(value)||value<0)throw fail('index_invalid_budget');return value;};
  const richSession=()=>{active();if(!richOwner)richOwner={value:new host.wasm.WasmDocumentRichSearchOwner(crypto.randomUUID()),alive:true};return richOwner;};
  function admittedRichPin(pinId:string,pin:Pin,session:RichSession){active();if(pins.get(pinId)!==pin||richOwner!==session||!session.alive)throw richFail('search_expired');}
  function admittedRichQuery(id:string,query:RichQueryBinding){admittedRichPin(query.pinId,query.pin,query.session);if(query.retired||richQueries.get(id)!==query)throw richFail('search_expired');}
  function getRichQuery(pinId:string,id:string){const query=richQueries.get(id);if(!query||query.pinId!==pinId)throw richFail('search_expired');admittedRichQuery(id,query);return query;}
  function retireRichQuery(id:string,query:RichQueryBinding){if(query.retired)return;if(query.session.alive&&richOwner===query.session)richRust(()=>query.session.value.closeQuery(query.core),query.spec.query);query.retired=true;richQueries.delete(id);}
  function quietRetireRich(id:string,query:RichQueryBinding){try{retireRichQuery(id,query);}catch{/* Preserve the failed operation's original admission/encoding error. */query.retired=true;richQueries.delete(id);}}
  async function assertRichQuery(id:string,query:RichQueryBinding){try{await assertPin(query.pinId);admittedRichQuery(id,query);}catch(error){quietRetireRich(id,query);throw error;}}
  function retireRichPin(pinId:string){for(const [id,query]of richQueries)if(query.pinId===pinId)retireRichQuery(id,query);}
  const parseCache=browserDocumentParseCache({db:host.db,authorityId:host.authorityId,assertActive:active,
    policy:json<BrowserParseCachePolicy>(rust(()=>host.wasm.documentParseCachePolicyJson())),
    admit:(usage,replaced,incoming,evicted)=>json<BrowserParseCacheAdmission>(rust(()=>host.wasm.documentParseCacheAdmissionJson(JSON.stringify({usage,replacedPayloadBytes:replaced,incomingPayloadBytes:incoming,evictedRows:evicted}))))});
  const countCache=(stage:Stage,outcome:ParseCacheOutcome)=>{const field=outcome==='hit'?'hits':outcome==='miss'?'misses':outcome;stage.parseCache[field]++;};
  const run=<T>(mode:IDBTransactionMode,stores:readonly string[],start:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void)=>void)=>
    normalizedTransact(host.db,{authorityId:host.authorityId,stores,mode,assertActive:active},start);
  const on=<T>(request:IDBRequest<T>,action:(result:T)=>void,abort:(error:unknown)=>void)=>{request.onsuccess=()=>{try{active();action(request.result);}catch(error){abort(error);}};};
  const empty=(epoch:string):Catalog=>({version:2,localStoreId:host.authorityId,epoch,allocated:'0',head:null,generations:[],pins:[]});
  function catalog(value:any):Catalog {
    if(value===undefined)return empty(crypto.randomUUID());
    if(value?.key!==CATALOG||size(JSON.stringify(value))>16384)throw fail('index_rebuild_required');
    const c=value.value as Catalog;
    if(!c||c.version!==2||c.localStoreId!==host.authorityId||!validId(c.epoch)||!Array.isArray(c.generations)||c.generations.length>LIMITS.generations+LIMITS.stages||!Array.isArray(c.pins)||c.pins.length>LIMITS.pins)throw fail('index_rebuild_required');
    let highwater:bigint;try{highwater=BigInt(decimalU64(c.allocated));}catch{throw fail('index_rebuild_required');}
    const ids=new Set<string>(),snapshots=new Set<string>();let bytes=0;
    for(const g of c.generations){let snapshot:DocumentSnapshotId;try{snapshot=documentSnapshot(g.snapshot);}catch{throw fail('index_rebuild_required');}if(!validId(g.id)||ids.has(g.id)||!validId(g.clientId)||!['staging','published','deleting'].includes(g.state)||snapshot.localStoreId!==host.authorityId||snapshot.generationEpoch!==c.epoch||BigInt(snapshot.generation)===0n||BigInt(snapshot.generation)>highwater||snapshots.has(snapshot.generation)||typeof g.coverageComplete!=='boolean'||typeof g.wasPublished!=='boolean'||g.state==='published'&&!g.wasPublished||g.state==='staging'&&g.wasPublished||![g.rows,g.bytes,g.metadataBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||g.rows>LIMITS.records||g.bytes>LIMITS.projection||g.metadataBytes>LIMITS.metadata)throw fail('index_rebuild_required');decimalU64(g.sourceWatermark);ids.add(g.id);snapshots.add(snapshot.generation);bytes+=g.bytes;}
    if(bytes>LIMITS.cache||c.head!==null&&!c.generations.some(g=>g.id===c.head&&g.state==='published'))throw fail('index_rebuild_required');
    const pinIds=new Set<string>();for(const p of c.pins){if(!validId(p.id)||pinIds.has(p.id)||!validId(p.clientId)||!c.generations.some(g=>g.id===p.generation&&g.state==='published'))throw fail('index_rebuild_required');pinIds.add(p.id);}
    return c;
  }
  const readCatalog=(tx:IDBTransaction,done:(value:Catalog)=>void,abort:(error:unknown)=>void)=>on(tx.objectStore('control').get(CATALOG),row=>done(catalog(row)),abort);
  const putCatalog=(tx:IDBTransaction,c:Catalog)=>{if(size(JSON.stringify(c))>16384)throw fail('index_cache_limit');tx.objectStore('control').put({key:CATALOG,value:c});};
  const head=(c:Catalog)=>c.generations.find(g=>g.id===c.head)?.snapshot??null;
  const checkedHeader=(raw:unknown):BrowserIndexHeader=>{
    const h=json<BrowserIndexHeader>(raw as string);
    if(h.source?.localStoreId!==host.authorityId||h.nextIndex?.localStoreId!==host.authorityId||!Array.isArray(h.entries)||h.entries.length>LIMITS.records)throw fail('index_rebuild_required');
    decimalU64(h.source.watermark);return h;
  };
  function readPreviewStamp(tx:IDBTransaction,done:(stamp:PreviewStamp)=>void,abort:(error:unknown)=>void){
    on(tx.objectStore('control').get('sequence'),row=>{const sequence=decimalU64(row?.value);
      on(tx.objectStore('sync_state').get('config'),configuration=>on(tx.objectStore('sync_state').get('metadata-head'),head=>{
        const value={sequence,configuration:configuration?.value??null,head:head?.value??null};
        if(size(JSON.stringify(value))>16384)throw fail('index_preview_resource');done(value);
      },abort),abort);
    },abort);
  }
  function previewLocal(candidate:PreviewCandidate):Stage {
    active();const stage=candidate.stage as Stage;
    if(stages.get(stage.id)!==stage||stage.failed||stage.preview?.candidate!==candidate||stage.preview.stamp!==candidate.stamp||!browserPreviewCall(()=>candidate.value.sameCapture(candidate.value)))throw fail('index_preview_expired');
    return stage;
  }
  async function previewFence(candidate:PreviewCandidate,definition?:EntryState){
    const stage=previewLocal(candidate);
    await run<void>('readonly',['control','sync_state'],(tx,done,abort)=>readCatalog(tx,c=>readPreviewStamp(tx,stamp=>{
      const d=c.generations.find(d=>d.id===stage.id);
      if(c.rebuilding||!d||d.clientId!==host.clientId||d.state!=='staging'||d.wasPublished||!equal(d.snapshot,stage.header.nextIndex)||!equal(head(c),stage.header.expectedIndex)||!equal(stamp,candidate.stamp)||d.rows!==stage.prepared)throw fail('index_preview_expired');
      on(tx.objectStore('control').getKey(headerKey(stage.id)),key=>{if(key===undefined)throw fail('index_preview_expired');
        if(definition)on(tx.objectStore('control').getKey(rowKey(stage.id,definition.id)),key=>{if(key===undefined)throw fail('index_preview_expired');done();},abort);else done();
      },abort);
    },abort),abort));previewLocal(candidate);
  }
  // Bootstrap only proven committed membership, never persisted parser rows or
  // source bodies. The existing live builder supplies the facts in Rust. Each
  // transaction is <=32 keys and final registration checks the same actual stage.
  async function preparePreview(stage:Stage){
    if(!Preview||!stage.builder||stage.failed)return;
    const state=stage.preview;if(!state)throw fail('index_preview_expired');
    if(state.error)throw state.error;
    const builder=stage.builder as Builder&PreviewBuilder;
    if(!state.configured){
      previewOwner??=new Preview(host.clientId,crypto.randomUUID());
      browserPreviewCall(()=>builder.configurePreview(previewOwner!,crypto.randomUUID(),stage.id));state.configured=true;
      const expected=stage.prepared;if(expected===0){state.seen=0;return;}
      const presentations=new Map(stage.capture.publication.presentation.map(row=>[row.id,row]));
      let committed=0;
      for(let start=0;start<stage.header.entries.length;start+=32){
        const entries=stage.header.entries.slice(start,start+32).filter(entry=>entry.kind==='file');
        const actual=await run<EntryState[]>('readonly',['control','sync_state'],(tx,done,abort)=>readCatalog(tx,c=>readPreviewStamp(tx,stamp=>{
          const d=c.generations.find(d=>d.id===stage.id);if(!d||d.state!=='staging'||d.clientId!==host.clientId||d.rows!==expected||!equal(stamp,state.stamp)||!equal(head(c),stage.header.expectedIndex)||c.rebuilding)throw fail('index_preview_expired');
          const found:EntryState[]=[];let at=0;const next=()=>{if(at===entries.length){done(found);return;}const entry=entries[at++]!;on(tx.objectStore('control').getKey(rowKey(stage.id,entry.id)),key=>{if(key!==undefined)found.push(entry);next();},abort);};next();
        },abort),abort));
        active();if(stages.get(stage.id)!==stage||stage.failed||stage.prepared!==expected||stage.builder!==builder)throw fail('index_preview_expired');
        const batch=actual.map(entry=>{const fact=presentations.get(entry.id);if(!fact)throw fail('index_preview_expired');return {entry,presentation:{size:fact.size_bytes,ctimeMs:fact.ctime_ms,mtimeMs:fact.mtime_ms}};});
        if(batch.length)browserPreviewCall(()=>builder.commitPreviewRowsJson(JSON.stringify(batch)));committed+=batch.length;
        if(start+32<stage.header.entries.length)await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
      if(committed!==expected)throw fail('index_preview_expired');state.seen=committed;
    }
  }
  async function capturePreview():Promise<PreviewCandidate|undefined>{
    active();const stage=[...stages.values()].find(stage=>!stage.failed);if(!stage)return;
    if(stage.preview?.error)throw stage.preview.error;
    if(stage.preview?.candidate){await previewFence(stage.preview.candidate);return stage.preview.candidate;}
    const builder=stage.builder;if(!builder||!stage.preview)return;
    try{
      await preparePreview(stage);const expectedPrepared=stage.prepared;
      // A new partial capture exposes the original whole manifest. Validate it
      // once at this boundary, rather than once for every selected pump row.
      await run<void>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>
        sourceFence(tx,stage.header,c,stage.capture,()=>done(),abort),abort));active();
      if(stages.get(stage.id)!==stage||stage.failed||stage.builder!==builder||stage.prepared!==expectedPrepared)throw fail('index_preview_expired');
      const state=stage.preview;if(state.seen!==stage.prepared)throw fail('index_preview_expired');
      const value=browserPreviewCall(()=>builder.capturePreview!());if(!value)return;
      const candidate:PreviewCandidate={stage,value,stamp:state.stamp};state.candidate=candidate;
      try{await previewFence(candidate);return candidate;}catch(error){try{retirePreviewStage(stage);}catch{/* Preserve the original admission failure. */}throw error;}
    }catch(error){if(stage.preview?.configured&&!stage.preview.candidate&&stage.preview.seen!==stage.prepared)stage.preview.error=error;throw error;}
  }
  const previews=createBrowserDocumentPreview({assertActive:active,isLive(candidate){try{previewLocal(candidate);return true;}catch{return false;}},capture:capturePreview,fence:previewFence,ordinarySlots:()=>run<number>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>done(c.pins.filter(pin=>pin.clientId===host.clientId).length),abort)),
    async read(candidate,definition,sourceBytes){
      const stage=previewLocal(candidate);await previewFence(candidate,definition);
      // Point-read this immutable definition only. Rust checks its retained text
      // commitment; parser-row serialization/hashing is unnecessary here. The IDB
      // row clone is bridge memory, not part of the Rust owner32MiB allowance.
      const bytes=await run<Uint8Array>('readonly',['control'],(tx,done,abort)=>on(tx.objectStore('control').get(rowKey(stage.id,definition.id)),row=>{
        const value=row?.value as CachedRow;if(!value||!equal(value.entry,definition)||!(value.projection instanceof Uint8Array)||value.projection.byteLength!==sourceBytes)throw fail('index_preview_expired');done(value.projection);
      },abort));await previewFence(candidate,definition);return bytes;
    },
  });
  function captureSource(tx:IDBTransaction,done:(value:SourceCapture)=>void,abort:(error:unknown)=>void):void {
    host.readPublication(tx,publication=>{
      if(publication.entries.length>LIMITS.records)throw fail('index_generation_limit');
      const descriptors:{id:string;content:any}[]=[],entries=new Map(publication.entries.map(e=>[e.id,e])),presentation=new Map(publication.presentation.map(p=>[p.id,p]));let bytes=0,scanned=0;
      const request=tx.objectStore('sync_materialization_refs').openCursor();
      on(request,function next(cursor){if(!cursor){if(descriptors.length!==entries.size)throw fail('storage_corrupt',{invariant:'index_capture_inventory'});done({publication,descriptors});return;}
        if(++scanned>LIMITS.records)throw fail('index_generation_limit');const row=cursor.value,entry=entries.get(row?.id);if(entry){
          if(row.status!=='normal'||!equal(row.entry,entry)||!equal(row.presentation,presentation.get(entry.id))||entry.kind==='file'&&!['text','binary'].includes(row.content?.kind)||entry.kind==='folder'&&row.content!==null)throw fail('storage_corrupt',{invariant:'index_capture_descriptor',entryId:entry.id,normal:row.status==='normal',sameEntry:equal(row.entry,entry),samePresentation:equal(row.presentation,presentation.get(entry.id)),textMode:row.content?.kind==='text',binaryMode:row.content?.kind==='binary'});
          const descriptor={id:entry.id,content:row.content};bytes+=size(JSON.stringify(descriptor));if(bytes>LIMITS.header)throw fail('index_generation_limit');descriptors.push(descriptor);
        }cursor.continue();
      },abort);
    },abort);
  }
  function sourceFence(tx:IDBTransaction,h:BrowserIndexHeader,c:Catalog,expected:SourceCapture,done:()=>void,abort:(error:unknown)=>void):void {
    captureSource(tx,current=>{if(!equal(current,expected))throw fail('index_source_changed');if(!equal(head(c),h.expectedIndex))throw fail('index_head_changed');done();},abort);
  }
  interface SelectedSource {entry:EntryState;presentation:BrowserVaultPresentation;bytes?:Uint8Array}
  function sameBytes(left:Uint8Array|undefined,right:Uint8Array|undefined):boolean {
    if(left===undefined||right===undefined)return left===right;
    if(left.length!==right.length)return false;for(let at=0;at<left.length;at++)if(left[at]!==right[at])return false;return true;
  }
  // Pump rows are private derived progress. Fence their selected authoritative
  // rows here; begin/registration/publication/recovery retain the complete source
  // fence, including unrelated same-sequence changes. Preview guards are separate.
  function selectedSourceFence(tx:IDBTransaction,stage:Stage,c:Catalog,entry:EntryState,
    expectedBody:{bytes?:Uint8Array}|undefined,done:(source:SelectedSource)=>void,abort:(error:unknown)=>void):void {
    if(!equal(head(c),stage.header.expectedIndex))throw fail('index_head_changed');
    const registered=c.generations.find(g=>g.id===stage.id),expectedPresentation=stage.capture.publication.presentation.find(row=>row.id===entry.id),descriptor=stage.capture.descriptors.find(row=>row.id===entry.id);
    if(stages.get(stage.id)!==stage||stage.failed||c.rebuilding||!registered||registered.state!=='staging'||registered.wasPublished||registered.clientId!==host.clientId||!equal(registered.snapshot,stage.header.nextIndex)||registered.rows!==stage.prepared)throw fail('index_stage_expired');
    if(!expectedPresentation||!descriptor)throw fail('index_rebuild_required');
    on(tx.objectStore('control').get('sequence'),sequence=>{
      if(decimalU64(sequence?.value)!==stage.header.source.watermark)throw fail('index_source_changed');
      on(tx.objectStore('metadata').get(entry.id),current=>{
        if(!equal(current,entry))throw fail('index_source_changed');
        on(tx.objectStore('presentation').get(entry.id),presentation=>{
          if(!presentation||presentation.id!==entry.id||![presentation.ctime_ms,presentation.mtime_ms,presentation.size_bytes].every(n=>Number.isSafeInteger(n)&&n>=0))throw fail('storage_corrupt',{invariant:'index_source_presentation',entryId:entry.id});
          if(!equal(presentation,expectedPresentation))throw fail('index_source_changed');
          on(tx.objectStore('sync_materialization_refs').get(entry.id),retained=>{
            if(!retained||retained.id!==entry.id||retained.status!=='normal'||!equal(retained.entry,entry)||!equal(retained.presentation,presentation))throw fail('storage_corrupt',{invariant:'index_capture_descriptor',entryId:entry.id});
            if(!equal(retained.content,descriptor.content))throw fail('index_source_changed');
            on(tx.objectStore('content').get(entry.id),content=>{
              if(content!==undefined&&(content.id!==entry.id||!(content.bytes instanceof Uint8Array)||content.bytes.length!==presentation.size_bytes))throw fail('storage_corrupt',{invariant:'index_source_inline',entryId:entry.id});
              const mode=descriptor.content?.kind;
              if(mode==='text'&&!content||mode==='binary'&&content||!['text','binary'].includes(mode))throw fail('storage_corrupt',{invariant:'index_source_mode',entryId:entry.id,textMode:mode==='text',binaryMode:mode==='binary',hasInline:!!content});
              const bytes=mode==='text'?content.bytes:undefined;
              // Re-read in the actual row writer after hashing/cache awaits.
              // Equal length and an unchanged revision do not prove equal bytes.
              if(expectedBody&&!sameBytes(bytes,expectedBody.bytes))throw fail('index_source_changed');
              done({entry,presentation,...(bytes?{bytes}:{})});
            },abort);
          },abort);
        },abort);
      },abort);
    },abort);
  }
  const stageInfo=(stage:Stage):BrowserIndexStage=>{const ready=!!stage.generation;return {stageId:stage.id,snapshot:stage.header.nextIndex,prepared:stage.prepared,total:stage.total,ready,progress:{prepared:stage.prepared,total:stage.total,reused:stage.reused,ready,parseCache:{...stage.parseCache}}};};
  function liveStage(id:string):Stage {active();const stage=stages.get(id);if(!stage)throw fail('index_stage_expired');if(stage.failed)throw fail('index_rebuild_required');return stage;}
  async function readRow(generation:string,entry:EntryState):Promise<CachedRow> {
    const captured=await run<{value:CachedRow;digest:string}>('readonly',['control'],(tx,done,abort)=>on(tx.objectStore('control').get(rowKey(generation,entry.id)),row=>{
      const value=row?.value as CachedRow;
      if(!value||!equal(value.entry,entry)||typeof value.record!=='string'||size(value.record)>LIMITS.row||value.projection!==undefined&&(!(value.projection instanceof Uint8Array)||value.projection.length>LIMITS.text))throw fail('index_rebuild_required');done({value,digest:row.digest});
    },abort));
    if(captured.digest!==await digest(JSON.stringify({entry:captured.value.entry,presentation:captured.value.presentation,sourceDescriptor:captured.value.sourceDescriptor,record:captured.value.record})))throw fail('index_rebuild_required');
    return captured.value;
  }
  async function cleanupGeneration(id:string):Promise<void>{return cleanupPrefix(root(id));}
  async function cleanupPrefix(prefix:string):Promise<void>{
    // Exact derived prefix only, bounded cursor pages; never scans authority control.
    for(;;){const more=await run<boolean>('readwrite',['control'],(tx,done,abort)=>{
      let count=0;const request=tx.objectStore('control').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));
      on(request,function next(cursor){if(!cursor){done(false);return;}if(count>=32){done(true);return;}
        count++;tx.objectStore('control').delete(cursor.primaryKey);cursor.continue();},abort);
    });if(!more)return;await new Promise<void>(resolve=>setTimeout(resolve,0));}
  }
  async function purge(id:string):Promise<void>{
    // Keep the descriptor and its byte reservation until every immutable row
    // is deleted; interruption cannot create unaccounted orphan projections.
    await cleanupGeneration(id);
    await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.generations=c.generations.filter(g=>g.id!==id||g.state!=='deleting');putCatalog(tx,c);done();},abort));
  }
  async function prune():Promise<void>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const published=c.generations.filter(g=>g.state==='published'),drop:string[]=[];
      while(published.length>LIMITS.generations){const index=published.findIndex(g=>g.id!==c.head&&!c.pins.some(p=>p.generation===g.id));if(index<0)break;drop.push(published.splice(index,1)[0]!.id);}
      for(const g of c.generations)if(drop.includes(g.id))g.state='deleting';putCatalog(tx,c);done(c.generations.filter(g=>g.state==='deleting').map(g=>g.id));
    },abort));
    for(const id of removed)await purge(id);
  }
  let recovery:Promise<void>|undefined;
  function recover():Promise<void>{return recovery??= (async()=>{
    const removed=await run<string[]>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      const ids=c.generations.filter(g=>g.clientId===host.clientId&&g.state==='staging').map(g=>g.id);
      c.pins=c.pins.filter(p=>p.clientId!==host.clientId);for(const g of c.generations)if(ids.includes(g.id))g.state='deleting';putCatalog(tx,c);done(ids);
    },abort));for(const id of removed)await purge(id);
  })();}
  async function assertPin(pinId:string):Promise<Generation>{
    active();const pin=pins.get(pinId);if(!pin)throw fail('index_snapshot_expired');
    await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(!c.pins.some(p=>p.id===pinId&&p.clientId===host.clientId&&p.generation===pin.generation))throw fail('index_snapshot_expired');done();},abort));
    active();if(pins.get(pinId)!==pin)throw fail('index_snapshot_expired');return pin.value;
  }
  function tokenForPin(pinId:string,token:unknown):string {
    if(token===undefined)return '';const value=inputText(token,256),prefix=pinId+'/';
    if(!value.startsWith(prefix)||!/^[1-9][0-9]{0,19}$/.test(value.slice(prefix.length)))throw fail('index_snapshot_expired');return value.slice(prefix.length);
  }
  function envelope(pinId:string,value:unknown):unknown{const pin=pins.get(pinId);if(!pin)throw fail('index_snapshot_expired');return {snapshot:pin.header.nextIndex,source:pin.header.source,coverageComplete:rust(()=>pin.value.coverageComplete()),value};}
  function pinPage(pinId:string,raw:string):unknown {const page=json<Record<string,unknown>>(raw);let cursor:string|null=null;if(page.next!==null&&page.next!==undefined){if(typeof page.next!=='string')throw fail('index_rebuild_required');cursor=pinId+'/'+page.next;}page.next=null;return {result:envelope(pinId,page),cursor};}
  const metadataExpired=()=>fail('index_snapshot_expired');
  function metadataLocal(binding:MetadataBinding){active();if(pins.get(binding.pinId)!==binding.pin||binding.baseline&&pins.get(binding.baseline.pinId)!==binding.baseline.pin)throw metadataExpired();}
  /** One catalog read fences both actual registrations. Matching snapshots and
   * surviving Rust generation Arcs alone do not grant pin admission. */
  async function metadataPins(binding:MetadataBinding){
    metadataLocal(binding);
    await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      for(const target of [{pinId:binding.pinId,pin:binding.pin},...(binding.baseline?[binding.baseline]:[])])if(!c.pins.some(p=>p.id===target.pinId&&p.clientId===host.clientId&&p.generation===target.pin.generation))throw metadataExpired();
      done();
    },abort));
    metadataLocal(binding);
  }
  async function initialMetadata(pinId:string,requested:MetadataBinding['requested'],limit:number):Promise<MetadataBinding>{
    active();const pin=pins.get(pinId);if(!pin)throw metadataExpired();
    if(requested&&requested.snapshot.localStoreId!==host.authorityId)throw fail('index_invalid_target');
    const candidate=requested?pins.get(requested.pinId):undefined;
    if(candidate&&!equal(candidate.header.nextIndex,requested!.snapshot))throw fail('index_invalid_target');
    const baseline=await run<MetadataBinding['baseline']>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
      if(!c.pins.some(p=>p.id===pinId&&p.clientId===host.clientId&&p.generation===pin.generation))throw metadataExpired();
      if(requested&&c.pins.some(p=>p.id===requested.pinId&&p.clientId!==host.clientId))throw fail('index_invalid_target');
      done(candidate&&requested&&c.pins.some(p=>p.id===requested.pinId&&p.clientId===host.clientId&&p.generation===candidate.generation)?{pinId:requested.pinId,pin:candidate}:undefined);
    },abort));
    active();if(pins.get(pinId)!==pin||baseline&&pins.get(baseline.pinId)!==baseline.pin)throw metadataExpired();
    const slots=metadataCursors.get(pinId);
    // Only bounded request descriptors are compared. Cursor progression/retry
    // identity remains the private O(1) Rust origin and checked ordinal.
    for(const old of slots?.values()??[])if(old.initial&&old.limit===limit&&equal(old.requested,requested)&&(!old.baseline||old.baseline.pin===baseline?.pin))return old;
    const scan=rust(()=>baseline?MetadataRows!.withBaseline(pin.value,baseline.pin.value,limit):new MetadataRows!(pin.value,limit));
    try{const usesBaseline=rust(()=>scan.usesBaseline());if(usesBaseline&&!baseline)throw fail('index_rebuild_required');const binding:MetadataBinding={pinId,pin,requested,limit,initial:true,scan,...(usesBaseline?{baseline}:{} )};await metadataPins(binding);saveMetadata(crypto.randomUUID(),binding);return binding;}catch(error){scan.retire();scan.free();throw error;}
  }
  function saveMetadata(cursor:string,binding:MetadataBinding){
    metadataLocal(binding);let slots=metadataCursors.get(binding.pinId);if(!slots){slots=new Map();metadataCursors.set(binding.pinId,slots);}
    if(slots.has(cursor))throw fail('index_token_limit');
    // This is the browser's sole retained generic cursor registry; legacy
    // literal/backlink tokens are stateless. The initial retry counts too.
    if(slots.size===LIMITS.metadataCursors){const oldest=slots.entries().next().value!;slots.delete(oldest[0]);oldest[1].scan.free();}
    slots.set(cursor,binding);
  }
  function baseFacts(pin:Pin):string {
    const files=pin.header.entries.filter(e=>e.kind==='file');if(files.length>LIMITS.baseRecords)throw fail('index_input_limit');
    const presentations=new Map<string,BrowserVaultPresentation>();for(const row of pin.capture.publication.presentation){if(presentations.has(row.id))throw fail('index_rebuild_required');presentations.set(row.id,row);}
    const facts=[];let factsBytes=2;for(const e of files){const presentation=presentations.get(e.id);if(!presentation)throw fail('index_rebuild_required');
      const fact={witness:{entryId:e.id,revision:e.revision},size:presentation.size_bytes,ctimeMs:presentation.ctime_ms,mtimeMs:presentation.mtime_ms};factsBytes+=size(JSON.stringify(fact))+(facts.length?1:0);if(factsBytes>LIMITS.baseFacts)throw fail('index_input_limit');facts.push(fact);}
    return JSON.stringify(facts);
  }
  const api:BrowserDocumentIndex={
    ...(propertyTargetsAvailable?{propertyTargetsAvailable:true,async propertyTargets(input:NonNullable<Parameters<NonNullable<BrowserDocumentIndex['propertyTargets']>>[0]>){
      const pinId=inputText(input.pinId,128),captured=baseOptions(input.options,true),g=await assertPin(pinId);active();
      const pin=pins.get(pinId);if(!pin||pin.value!==g||typeof g.propertyTargetsJson!=='function')throw fail('index_unavailable');
      const admitted=()=>{active();if(pins.get(pinId)!==pin)throw fail('index_snapshot_expired');};
      const facts=baseFacts(pin),options=captured;await assertPin(pinId);admitted();
      const result=json<unknown>(rust(()=>g.propertyTargetsJson!(facts,options)));await assertPin(pinId);admitted();return result;
    }}:{}),
    initialize(){active();return recover();},
    async discard(stageId){active();if(!validId(stageId))throw fail('index_stage_expired');
      const result=await run<{publishedPruned?:true;published?:{header:string;digest:string;snapshot:BrowserIndexSnapshot}}>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{const stage=c.generations.find(g=>g.id===stageId);
        if(stage?.clientId!==undefined&&stage.clientId!==host.clientId)throw fail('index_stage_expired');
        if(stage?.wasPublished){on(tx.objectStore('control').get(headerKey(stageId)),row=>{
          if(row===undefined&&stage.state==='deleting'){done({publishedPruned:true});return;}
          if(typeof row?.value!=='string'||size(row.value)>3*LIMITS.header)throw fail('index_rebuild_required');done({published:{header:row.value,digest:row.digest,snapshot:stage.snapshot}});
        },abort);return;}
        if(stage){stage.state='deleting';putCatalog(tx,c);}done({});
      },abort));
      if(result.publishedPruned)return;
      if(result.published){const captured=result.published;if(captured.digest!==await digest(captured.header))throw fail('index_rebuild_required');
        const stored=json<StoredHeader>(captured.header,3*LIMITS.header),header=checkedHeader(stored.rust);
        if(!equal(header.nextIndex,captured.snapshot)||!equal(header.entries,stored.capture?.publication?.entries)||header.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');
        const validator=rust(()=>new host.wasm.WasmDocumentIndexBuilder(stored.rust));validator.free();
        await run<void>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{const stage=c.generations.find(g=>g.id===stageId);if(!stage){done();return;}
          if(stage.clientId!==host.clientId||!stage.wasPublished||!equal(stage.snapshot,captured.snapshot))throw fail('index_stage_expired');
          on(tx.objectStore('control').get(headerKey(stageId)),row=>{if(!row&&stage.state==='deleting'){done();return;}if(row?.value!==captured.header||row?.digest!==captured.digest)throw fail('index_rebuild_required');done();},abort);
        },abort));return;
      }
      const stage=stages.get(stageId);if(stage)retirePreviewStage(stage);stage?.builder?.free();stage?.generation?.free();stages.delete(stageId);await purge(stageId);
    },
    async status(){
      const captured=await run<{source:SourceCapture;catalog?:Catalog;raw?:string;digest?:string}>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>{
        captureSource(tx,source=>on(tx.objectStore('control').get(CATALOG),row=>{let c:Catalog;try{c=catalog(row);}catch{done({source});return;}
          const g=c.generations.find(g=>g.id===c.head);if(!g){done({source,catalog:c});return;}
          on(tx.objectStore('control').get(headerKey(g.id)),row=>done({source,catalog:c,raw:row?.value,digest:row?.digest}),abort);
        },abort),abort);
      });
      const c=captured.catalog,g=c?.generations.find(g=>g.id===c.head),sourceWatermark=captured.source.publication.sequence;
      if(!g)return {sourceWatermark,snapshot:null,coveredWatermark:null,rebuildRequired:!c||!!c.rebuilding,current:false,source:{localStoreId:host.authorityId,watermark:sourceWatermark},coveredSource:null,coverageComplete:null};
      try{if(!captured.raw||captured.digest!==await digest(captured.raw))throw fail('index_rebuild_required');const stored=json<StoredHeader>(captured.raw,3*LIMITS.header);const h=checkedHeader(stored.rust);if(!equal(h.nextIndex.versions,json<unknown>(rust(()=>host.wasm.documentIndexVersionsJson())))||!equal(h.nextIndex,g.snapshot)||!equal(h.entries,stored.capture?.publication?.entries)||h.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');
        return {sourceWatermark,snapshot:g.snapshot,coveredWatermark:g.sourceWatermark,rebuildRequired:!!c?.rebuilding,current:equal(stored.capture,captured.source),source:{localStoreId:host.authorityId,watermark:sourceWatermark},coverageComplete:g.coverageComplete,coveredSource:{localStoreId:host.authorityId,watermark:g.sourceWatermark}};
      }catch{return {sourceWatermark,snapshot:null,coveredWatermark:null,rebuildRequired:true,current:false,source:{localStoreId:host.authorityId,watermark:sourceWatermark},coverageComplete:null,coveredSource:null};}
    },
    basePreviewAvailable:!!Preview,
    ...(Preview?{previewOpen:(input:{previewId:string})=>previews.open(previewRequest('preview_open',input) as {previewId:string}),previewBase:(input:{previewId:string;id:string;viewName?:string|null;options?:unknown})=>previews.base(previewRequest('preview_base',input) as typeof input),previewClose:(input:{previewId:string})=>previews.close(previewRequest('preview_close',input) as {previewId:string})}:{}),
    async begin(){
      active();await recover();if(stages.size>=1)throw fail('index_stage_limit');await prune();
      const capture=await run<{source:SourceCapture;catalog:Catalog}>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>{
        captureSource(tx,source=>readCatalog(tx,c=>done({source,catalog:c}),abort),abort);
      });
      if(capture.catalog.rebuilding)throw fail('index_rebuild_required');
      const id=crypto.randomUUID();if(typeof host.wasm.documentIndexAllocateJson!=='function')throw fail('index_unavailable');
      let nextIndex:DocumentSnapshotId;try{nextIndex=documentSnapshot(json<unknown>(rust(()=>host.wasm.documentIndexAllocateJson(JSON.stringify({localStoreId:host.authorityId,generationEpoch:capture.catalog.epoch,allocated:capture.catalog.allocated}))),65536));}catch(error){if(error instanceof BrowserVaultError)throw error;throw fail('invalid_wasm_result');}
      if(nextIndex.localStoreId!==host.authorityId||nextIndex.generationEpoch!==capture.catalog.epoch||BigInt(nextIndex.generation)<=BigInt(capture.catalog.allocated))throw fail('index_rebuild_required');
      const h:BrowserIndexHeader={source:{localStoreId:host.authorityId,watermark:capture.source.publication.sequence},entries:capture.source.publication.entries,expectedIndex:head(capture.catalog),nextIndex};
      if(h.entries.length>LIMITS.records)throw fail('index_generation_limit');
      const header=JSON.stringify(h);if(size(header)>LIMITS.header)throw fail('index_generation_limit');
      const builder=rust(()=>new host.wasm.WasmDocumentIndexBuilder(header)),canonicalHeader=rust(()=>builder.headerJson()),storedHeader=JSON.stringify({rust:canonicalHeader,capture:capture.source} satisfies StoredHeader),headerDigest=await digest(storedHeader);
      let previewStamp:PreviewStamp|undefined;try{previewStamp=await run<PreviewStamp|undefined>('readwrite',['control','metadata','presentation','sync_materialization_refs',...(Preview?['sync_state']:[])],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,h,c,capture.source,()=>{
        if(c.rebuilding)throw fail('index_rebuild_required');
        if(c.epoch!==capture.catalog.epoch||c.allocated!==capture.catalog.allocated)throw fail('index_head_changed');
        if(c.generations.filter(g=>g.state==='staging').length>=LIMITS.stages||c.generations.length>=LIMITS.generations+LIMITS.stages)throw fail('index_cache_limit');
        c.generations.push({id,clientId:host.clientId,state:'staging',snapshot:h.nextIndex,sourceWatermark:h.source.watermark,coverageComplete:false,wasPublished:false,rows:0,bytes:0,metadataBytes:0});
        c.allocated=nextIndex.generation;tx.objectStore('control').add({key:headerKey(id),value:storedHeader,digest:headerDigest});putCatalog(tx,c);if(Preview)readPreviewStamp(tx,done,abort);else done(undefined);
      },abort),abort));}catch(error){builder.free();throw error;}
      try{active();}catch(error){builder.free();throw error;}
      const stage:Stage={...(previewStamp?{preview:{stamp:previewStamp,configured:false,seen:0}}:{}),id,previous:capture.catalog.head,capture:capture.source,header:h,builder,prepared:0,total:h.entries.filter(e=>e.kind==='file').length,reused:0,parseCache:{hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0}};if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}stages.set(id,stage);return stageInfo(stage);
    },
    async pump(stageId){
      const stage=liveStage(stageId);
      // Cache outcomes describe this pump only; legacy reused remains unchanged.
      stage.parseCache={hits:0,misses:0,unavailable:0,corrupt:0,unsupported:0};
      if(stage.generation)return stageInfo(stage);const builder=stage.builder!;try{rust(()=>builder.beginPump());
      const pending=json<EntryState[]>(rust(()=>builder.pendingJson()));let sourceBytes=0;
      for(const entry of pending){
        const source=await run<SelectedSource>('readonly',['control','metadata','presentation','content','sync_materialization_refs'],(tx,done,abort)=>
          readCatalog(tx,c=>selectedSourceFence(tx,stage,c,entry,undefined,done,abort),abort));
        const bytes=source.bytes,sourceDescriptor=stage.capture.descriptors.find(d=>d.id===entry.id)?.content;
        if(bytes){const metadata=sourceDescriptor?.metadata;
          if(metadata?.byte_length!==String(bytes.length)||metadata.witness?.identity?.entry_id!==entry.id||metadata.witness?.revision!==entry.revision||!Array.isArray(metadata.digest)||metadata.digest.length!==32||!metadata.digest.every((n:unknown)=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=255)||hex(new Uint8Array(metadata.digest))!==await byteDigest(bytes))throw fail('storage_corrupt',{invariant:'index_source_text_commitment',entryId:entry.id,lengthMatches:metadata?.byte_length===String(bytes.length),identityMatches:metadata?.witness?.identity?.entry_id===entry.id,revisionMatches:metadata?.witness?.revision===entry.revision,digestArray:Array.isArray(metadata?.digest)});
        }
        if(sourceBytes>0&&bytes&&sourceBytes+bytes.length>1024*1024)break;
        let reused=false,cachePayload:string|undefined,cacheLocator:string|undefined;try{
          // Unchanged witnesses and presentation reuse validated Rust facts and
          // the old immutable projection. Changed identities bind content facts below.
          if(stage.previous){
            const previousId=stage.previous;
            try{const previous=await readRow(previousId,entry);if(equal(previous.presentation,source.presentation)&&equal(previous.sourceDescriptor,sourceDescriptor)){
              rust(()=>builder.addPersisted(entry.id,previous.record));reused=true;
            }}catch(error){if(error instanceof BrowserVaultError&&error.code==='index_pump_limit')throw error;/* Cache miss/corruption permits reparsing committed source. */}
          }
          if(!reused){
            if(!bytes)rust(()=>builder.addBinary(entry.id));
            else {
              // Source descriptor, current entry/presentation and actual digest
              // were validated above. Rust preflights before key/lookup work.
              const expected=rust(()=>builder.cacheKeyJson(entry.id,bytes)),key=json<{storageKey:string}|null>(expected);
              if(key===null)rust(()=>builder.addText(entry.id,bytes));
              else {
                if(typeof key.storageKey!=='string'||!/^[0-9a-f]{64}$/.test(key.storageKey))throw fail('index_rebuild_required');
                const lookup=await parseCache.lookup(key.storageKey);let outcome:ParseCacheOutcome=lookup.outcome,added=false;
                if(lookup.outcome==='hit'){
                  const result=json<{outcome:ParseCacheOutcome;added:boolean}>(rust(()=>builder.addCachedText(entry.id,expected,lookup.payload)));
                  if(!['hit','corrupt','unsupported'].includes(result.outcome)||typeof result.added!=='boolean'||result.outcome!=='hit'&&result.added)throw fail('index_rebuild_required');
                  outcome=result.outcome;added=result.added;countCache(stage,outcome);
                  if(outcome==='hit'&&!added)throw fail('index_pump_limit');
                }else countCache(stage,outcome);
                if(!added){
                  const result=json<{payload:string|null;added:boolean}>(rust(()=>builder.extractText(entry.id,bytes)));
                  if(typeof result.added!=='boolean'||result.payload!==null&&typeof result.payload!=='string')throw fail('index_rebuild_required');
                  if(!result.added)throw fail('index_pump_limit');
                  if(result.payload!==null){cacheLocator=key.storageKey;cachePayload=result.payload;}
                }
              }
            }
          }
        }catch(error){if(error instanceof BrowserVaultError&&error.code==='index_pump_limit'&&sourceBytes>0)break;throw error;}
        const record=rust(()=>builder.rowJson(entry.id));if(size(record)>LIMITS.row)throw fail('index_generation_limit');
        const fields=json<{digest?:unknown;textBytes?:number;exclusion?:unknown}>(record,LIMITS.row);
        const projection=bytes&&fields.exclusion==null?bytes:undefined;
        const row:CachedRow={entry,presentation:source.presentation,sourceDescriptor,record,...(projection?{projection}:{})};
        const rowDigest=await digest(JSON.stringify({entry,presentation:source.presentation,sourceDescriptor,record}));
        const committedStamp=await run<PreviewStamp|undefined>('readwrite',['control','metadata','presentation','content','sync_materialization_refs',...(Preview?['sync_state']:[])],(tx,done,abort)=>readCatalog(tx,c=>selectedSourceFence(tx,stage,c,entry,{bytes:source.bytes},()=>{
          const d=c.generations.find(g=>g.id===stage.id&&g.state==='staging');if(!d)throw fail('index_stage_expired');
          d.rows++;d.bytes+=projection?.length??0;d.metadataBytes+=size(record);
          if(d.rows>LIMITS.records||d.bytes>LIMITS.projection||d.metadataBytes>LIMITS.metadata||c.generations.reduce((n,g)=>n+g.bytes,0)>LIMITS.cache)throw fail('index_cache_limit');
          tx.objectStore('control').add({key:rowKey(stage.id,entry.id),value:row,digest:rowDigest});putCatalog(tx,c);if(Preview)readPreviewStamp(tx,done,abort);else done(undefined);
        },abort),abort));stage.prepared++;
        if(stage.preview&&committedStamp){
          const state=stage.preview;
          // Committed progress retires the previous actual capture even if the
          // last viewer has closed and no replacement capture is requested.
          try{browserPreviewCall(()=>previewOwner?.retireStage(stage.id));state.candidate?.value.free();}catch(error){state.error=error;}finally{state.candidate=undefined;state.stamp=committedStamp;}
          if(state.configured&&!state.error){try{browserPreviewCall(()=>builder.commitPreviewRowsJson!(JSON.stringify([{entry,presentation:{size:source.presentation.size_bytes,ctimeMs:source.presentation.ctime_ms,mtimeMs:source.presentation.mtime_ms}}])));state.seen++;}catch(error){state.error=error;try{retirePreviewStage(stage);}catch{/* Optional preview cannot fail committed indexing. */}}}
        }
        if(reused)stage.reused++;sourceBytes+=bytes?.length??0;
        if(cacheLocator!==undefined&&cachePayload!==undefined)await parseCache.store(cacheLocator,cachePayload);
      }
      if(Preview&&previews.wantsCapture()){previews.consumeRequest();try{await capturePreview();}catch{/* Optional preview resource failure never fails durable indexing. */}}
      // Capture may yield. Revalidate the exact accepted owner/stage before
      // touching its cached generated builder after close/rebuild/revocation.
      active();if(liveStage(stageId)!==stage||stage.builder!==builder)throw fail('index_stage_expired');
      if(rust(()=>builder.ready())){stage.generation=rust(()=>builder.finish());builder.free();stage.builder=undefined;}
      return stageInfo(stage);
      }catch(error){stage.failed=true;try{retirePreviewStage(stage);}catch{/* Preserve the accepted operation's actual failure. */}throw error;}
    },
    async publish(stageId){const stage=liveStage(stageId);if(!stage.generation)throw fail('index_not_ready');
      const snapshot=json<BrowserIndexSnapshot>(rust(()=>stage.generation!.snapshotJson()));
      await run<void>('readwrite',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>sourceFence(tx,stage.header,c,stage.capture,()=>{
        const d=c.generations.find(g=>g.id===stage.id);if(!d||d.state!=='staging'||d.rows!==stage.total)throw fail('index_rebuild_required');d.state='published';d.wasPublished=true;d.coverageComplete=rust(()=>stage.generation!.coverageComplete());c.head=stage.id;putCatalog(tx,c);done();
      },abort),abort));retirePreviewStage(stage);stage.generation.free();stages.delete(stageId);await prune();return snapshot;
    },
    async open(){
      await recover();const pinId=crypto.randomUUID();const captured=await run<{id:string;header:string;digest:string;snapshot:BrowserIndexSnapshot}>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{
        const g=c.generations.find(g=>g.id===c.head&&g.state==='published');if(!g)throw fail('index_not_ready');if(c.pins.length>=LIMITS.pins||c.pins.filter(p=>p.clientId===host.clientId).length+previews.slotCount()>=4)throw fail('index_pin_limit');
        on(tx.objectStore('control').get(headerKey(g.id)),row=>{if(typeof row?.value!=='string'||size(row.value)>3*LIMITS.header)throw fail('index_rebuild_required');c.pins.push({id:pinId,clientId:host.clientId,generation:g.id});putCatalog(tx,c);done({id:g.id,header:row.value,digest:row.digest,snapshot:g.snapshot});},abort);
      },abort));
      if(captured.digest!==await digest(captured.header)){await api.closePin(pinId);throw fail('index_rebuild_required');}
      let builder:Builder|undefined;
      try{const stored=json<StoredHeader>(captured.header,3*LIMITS.header),h=checkedHeader(stored.rust);if(!equal(h.nextIndex,captured.snapshot)||!equal(h.entries,stored.capture?.publication?.entries)||h.source.watermark!==stored.capture?.publication?.sequence)throw fail('index_rebuild_required');builder=rust(()=>new host.wasm.WasmDocumentIndexBuilder(stored.rust));let count=0;for(const entry of h.entries){if(entry.kind!=='file')continue;if(count++%32===0)rust(()=>builder!.beginPump());const row=await readRow(captured.id,entry);try{rust(()=>builder!.addPersisted(entry.id,row.record));}catch(error){if(!(error instanceof BrowserVaultError)||error.code!=='index_pump_limit')throw error;rust(()=>builder!.beginPump());rust(()=>builder!.addPersisted(entry.id,row.record));}}
        const generation=rust(()=>builder!.finish());
        // Canonicalize this already-owned immutable pin header once. Keep the
        // captured authority inventory and persisted header in their original order.
        h.entries.sort((a,b)=>manifestStringOrder(a.path,b.path)||manifestStringOrder(a.id,b.id));
        const coverageComplete=rust(()=>generation.coverageComplete());pins.set(pinId,{generation:captured.id,value:generation,header:h,capture:stored.capture,coverageComplete});return {pinId,snapshot:captured.snapshot,source:h.source,coverageComplete};
      }catch(error){await api.closePin(pinId);throw error;}finally{builder?.free();}
    },
    async closePin(pinId){active();retireMetadataPin(pinId);retireRichPin(pinId);pins.get(pinId)?.value.free();pins.delete(pinId);await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.id!==pinId||p.clientId!==host.clientId);putCatalog(tx,c);done();},abort));},
    async metadataRows(input){
      if(!MetadataRows)throw fail('index_unavailable');
      active();
      const {pinId,...captured}=captureBrowserMetadataRows(input);
      if(metadataBusy.has(pinId))throw fail('index_busy');metadataBusy.add(pinId);let advanced:MetadataScan|undefined;
      try{
        let binding:MetadataBinding;
        if(captured.cursor){const existing=metadataCursors.get(pinId)?.get(captured.cursor);if(!existing)throw fail('index_snapshot_expired');binding=existing;if(captured.limit!==undefined&&captured.limit!==binding.limit)throw fail('index_invalid_request');}
        else binding=await initialMetadata(pinId,captured.baseline,captured.limit??METADATA_ROWS_LIMIT);
        await metadataPins(binding);
        const slots=metadataCursors.get(pinId)!;let next:string|undefined;
        for(const [cursor,other]of slots)if(!other.initial&&rust(()=>other.scan.isNextCheckpointOf(binding.scan))){next=cursor;break;}
        next??=crypto.randomUUID();
        advanced=rust(()=>binding.scan.fork());
        const raw=rust(()=>advanced!.pageJson(next!));
        const mode=binding.baseline?'delta' as const:'reset' as const,from=binding.baseline?documentSnapshot(binding.baseline.pin.header.nextIndex):null;
        let response:ReturnType<typeof metadataRowsPage>;
        try{response=metadataRowsPage(json(raw,METADATA_ROWS_BYTES),{snapshot:documentSnapshot(binding.pin.header.nextIndex),source:binding.pin.header.source as DocumentSourceId,coverageComplete:binding.pin.coverageComplete,limit:binding.limit,continuation:{mode,from}});if(response.cursor!==null&&response.cursor!==next)throw fail('index_rebuild_required');}catch{throw fail('index_rebuild_required');}
        await metadataPins(binding);
        let retained=false;for(const current of metadataCursors.get(pinId)?.values()??[])if(current===binding){retained=true;break;}if(!retained)throw metadataExpired();
        if(response.cursor!==null){const existing=metadataCursors.get(pinId)?.get(next);if(existing){if(!rust(()=>existing.scan.sameCheckpoint(advanced!)))throw fail('index_rebuild_required');}else{saveMetadata(next,{...binding,initial:false,scan:advanced});advanced=undefined;}}
        return response;
      }finally{advanced?.free();metadataBusy.delete(pinId);}
    },
    async search(input){const g=await assertPin(input.pinId),pin=pins.get(input.pinId)!;const page=rust(()=>g.openLiteral(inputText(input.query,4096),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit)));try{
      for(;;){const entry=json<EntryState|null>(rust(()=>page.nextReadJson()));if(!entry)break;const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_rebuild_required');rust(()=>page.accept(row.projection!));}
      const result=pinPage(input.pinId,rust(()=>page.finishJson()));await assertPin(input.pinId);return result;
    }finally{page.free();}},
    async richStart(input){
      const captured=captureRichRequest(input,['pinId','spec']),pinId=captured.pinId;
      let spec:SearchSpec;try{spec=searchSpec(captured.spec);}catch{throw richFail('invalid_request');}
      const g=await assertPin(pinId);active();const pin=pins.get(pinId);if(!pin||pin.value!==g)throw fail('index_snapshot_expired');const session=richSession();
      const entries=new Map<string,EntryState>(),presentations=new Map<string,BrowserVaultPresentation>();
      for(const fact of pin.capture.publication.presentation){if(presentations.has(fact.id))throw fail('index_rebuild_required');presentations.set(fact.id,fact);}
      const facts:{entryId:string;revision:string;ctimeMs:number;mtimeMs:number}[]=[];let factsBytes=2;
      for(const entry of pin.header.entries){if(entry.kind!=='file')continue;const fact=presentations.get(entry.id);if(!fact||!Number.isSafeInteger(fact.ctime_ms)||!Number.isSafeInteger(fact.mtime_ms))throw fail('index_rebuild_required');
        const row={entryId:entry.id,revision:entry.revision,ctimeMs:fact.ctime_ms,mtimeMs:fact.mtime_ms};factsBytes+=size(JSON.stringify(row))+(facts.length?1:0);if(factsBytes>LIMITS.header||facts.length===LIMITS.records)throw richFail('search_resource');facts.push(row);entries.set(entry.id,entry);
      }
      admittedRichPin(pinId,pin,session);
      const core=richRust(()=>session.value.startQuery(g,JSON.stringify(spec),JSON.stringify(facts)),spec.query);
      let queryId:string;try{queryId=richToken(pinId+'/'+core);}catch{richRust(()=>session.value.closeQuery(core),spec.query);throw richFail('search_resource');}
      const query:RichQueryBinding={pinId,pin,session,core,spec,entries,retired:false,busy:false};richQueries.set(queryId,query);
      try{await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return Object.freeze({queryId});}
      catch(error){quietRetireRich(queryId,query);throw error;}
    },
    async richPrepare(input){
      const captured=captureRichRequest(input,['pinId','queryId']),pinId=captured.pinId,queryId=captured.queryId as string;
      let query:RichQueryBinding;try{await assertPin(pinId);query=getRichQuery(pinId,queryId);}catch(error){const old=richQueries.get(queryId);if(old?.pinId===pinId)quietRetireRich(queryId,old);throw error;}if(query.busy)throw richFail('search_busy');
      const raw=richRust(()=>query.session.value.prepareJson(query.core),query.spec.query);
      let response:ReturnType<typeof richPreparation>;try{response=richPreparation(json<unknown>(raw,65536));}catch(error){if(error instanceof BrowserVaultError)throw error;throw fail('index_rebuild_required');}
      const result=response.state==='ready'?Object.freeze({state:'ready' as const,cursor:richToken(queryId+'/'+response.cursor)}):response;
      await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return result;
    },
    async richPage(input){
      const captured=captureRichRequest(input,['pinId','queryId','cursor']),pinId=captured.pinId,queryId=captured.queryId as string,cursor=captured.cursor as string;
      let query:RichQueryBinding;try{await assertPin(pinId);query=getRichQuery(pinId,queryId);}catch(error){const old=richQueries.get(queryId);if(old?.pinId===pinId)quietRetireRich(queryId,old);throw error;}if(query.busy)throw richFail('search_busy');
      const prefix=queryId+'/';if(!cursor.startsWith(prefix)||cursor.length===prefix.length)throw richFail('search_expired');
      query.busy=true;let drive:RichDrive|undefined,prepared:RichPrepared|undefined,commitStarted=false;
      try{
        admittedRichQuery(queryId,query);drive=richRust(()=>query.session.value.openDrive(query.core,cursor.slice(prefix.length)),query.spec.query);
        for(;;){
          admittedRichQuery(queryId,query);const action=richAction(richRust(()=>drive!.nextActionJson(),query.spec.query),query.pin.header.nextIndex,query.entries);
          if(action.kind!=='readText')break;
          await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
          const row=await readRow(query.pin.generation,action.entry);
          await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
          if(!row.projection||row.projection.byteLength!==action.bytes)throw fail('index_source_unavailable');
          // The outstanding Rust request owns the digest and UTF8/NUL checks;
          // this descriptor is only an admitted host read, never an offset API.
          richRust(()=>drive!.accept(row.projection!),query.spec.query);
        }
        await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);
        prepared=richRust(()=>drive!.finish(),query.spec.query);
        // No await or mutable WASM borrow between the final local admission and
        // commit. A later failed admission never exposes this result/cursor.
        admittedRichQuery(queryId,query);
        commitStarted=true;const raw=richRust(()=>query.session.value.commitJson(prepared!),query.spec.query);
        const page=json<{result:unknown;cursor:unknown}>(raw,2*1024*1024);
        if(page.cursor!==null){let token:string;try{token=richToken(page.cursor);}catch{throw fail('index_rebuild_required');}page.cursor=richToken(queryId+'/'+token);}
        let result;try{result=decodeRichPage(page,{snapshot:query.pin.header.nextIndex as DocumentSnapshotId,source:query.pin.header.source,coverageComplete:richRust(()=>query.pin.value.coverageComplete(),query.spec.query),spec:query.spec});}catch(error){if(error instanceof BrowserVaultError)throw error;throw fail('index_rebuild_required');}
        await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);return result;
      }catch(error){if(commitStarted)quietRetireRich(queryId,query);throw error;}finally{prepared?.free();drive?.free();query.busy=false;}
    },
    async richClose(input){
      const captured=captureRichRequest(input,['pinId','queryId']),pinId=captured.pinId,queryId=captured.queryId as string;
      active();if(!queryId.startsWith(pinId+'/'))throw richFail('search_expired');const query=richQueries.get(queryId);
      // Same-pin unknown close is an idempotent cleanup acknowledgement, even
      // after a failed final pin fence retired it. It admits no query or read.
      if(!query)return;
      await assertRichQuery(queryId,query);admittedRichQuery(queryId,query);retireRichQuery(queryId,query);
      try{await assertPin(pinId);}catch(error){quietRetireRich(queryId,query);throw error;}
    },
    async resolve(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.resolveJson(inputText(input.sourceId,128),inputText(input.destination,4096))));await assertPin(input.pinId);return result;},
    async backlinks(input){const g=await assertPin(input.pinId),result=pinPage(input.pinId,rust(()=>g.backlinksJson(inputText(input.targetId,128),tokenForPin(input.pinId,input.cursor),pageLimit(input.limit))));await assertPin(input.pinId);return result;},
    async metadata(input){const g=await assertPin(input.pinId),result=json<unknown>(rust(()=>g.metadataJson(inputText(input.id,128))));await assertPin(input.pinId);return result;},
    async tasks(input){
      // Capture bounded selectors/options before any await. Caller mutation must
      // not redirect an admitted read to current or unrelated configuration.
      const captured=captureBrowserTaskQuery(input),ids=captured.typeIds,options=JSON.stringify(captured.options),pinId=captured.pinId,g=await assertPin(pinId),pin=pins.get(pinId)!;
      const sources:{id:string;source:string}[]=[];let bytes=0;
      for(const id of ids){
        const entry=pin.header.entries.find(e=>e.id===id&&e.kind==='file');if(!entry)throw fail('index_missing_source');
        const row=await readRow(pin.generation,entry);await assertPin(pinId);
        if(!row.projection)throw fail('index_source_unavailable');
        bytes+=row.projection.byteLength;if(row.projection.byteLength>256*1024||bytes>1024*1024)throw fail('index_input_limit');
        let source:string;try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.projection);}catch{throw fail('index_source_unavailable');}
        sources.push({id,source});
      }
      const sourcesJson=JSON.stringify(sources);if(size(sourcesJson)>7*1024*1024)throw fail('index_input_limit');
      await assertPin(pinId);const result=json<unknown>(rust(()=>g.tasksJson(sourcesJson,options)));await assertPin(pinId);return result;
    },
    async base(input){
      // Capture caller-owned selectors before any await. Admission remains per
      // invocation; neither the pure-data cache nor an old result admits a pin.
      const pinId=inputText(input.pinId,128),id=inputText(input.id,128),captured=baseOptions(input.options),viewName=input.viewName==null?undefined:inputText(input.viewName,1024);
      const g=await assertPin(pinId);active();const pin=pins.get(pinId);if(!pin||pin.value!==g)throw fail('index_snapshot_expired');
      const admitted=()=>{active();if(pins.get(pinId)!==pin)throw fail('index_snapshot_expired');};
      const entry=pin.header.entries.find(e=>e.id===id&&e.kind==='file');if(!entry)throw fail('index_missing_source');
      const factsJson=baseFacts(pin),options=captured;
      const row=await readRow(pin.generation,entry);if(!row.projection)throw fail('index_source_unavailable');
      await assertPin(pinId);
      // No await after acquiring this owner handle: close/rebuild cannot free it
      // during use. Rust rechecks retained bytes/UTF8 before lookup and after eval.
      admitted();const result=json<unknown>(rust(()=>{preparation??=new host.wasm.WasmDocumentIndexPreparationCache();return preparation.baseJson(g,id,row.projection!,factsJson,options,monotonicMs(),viewName);}));
      await assertPin(pinId);admitted();return result;
    },
    async rebuild(){active();releaseQueryOwners();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();
      // Explicit rebuild expires every old pin; fresh epochs prevent token ABA.
      recovery=undefined;const nonce=crypto.randomUUID();await run<void>('readwrite',['control'],(tx,done)=>{putCatalog(tx,{...empty(nonce),rebuilding:nonce});done();});
      // Generation rebuild preserves the separate validated content-facts family.
      await cleanupPrefix(PREFIX+'g/');
      await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{if(c.rebuilding===nonce){const {rebuilding,...ready}=c;putCatalog(tx,ready);}done();},abort));
    },
    async close(){if(closed)return;releaseQueryOwners();for(const stage of stages.values()){stage.builder?.free();stage.generation?.free();}stages.clear();
      try{await run<void>('readwrite',['control'],(tx,done,abort)=>readCatalog(tx,c=>{c.pins=c.pins.filter(p=>p.clientId!==host.clientId);for(const g of c.generations)if(g.clientId===host.clientId&&g.state==='staging')g.state='deleting';putCatalog(tx,c);done();},abort));}catch{/* Cache cleanup never blocks source close. Explicit rebuild repairs derived state. */}finally{closed=true;}
    },
  };
  // This executor uses raw low-level effects, not the public close wrapper.
  // Stage source is the captured header source, never a later status value.
  function ownedStage(snapshot:BrowserIndexSnapshot):Stage {
    active();const stage=[...stages.values()].find(stage=>equal(stage.header.nextIndex,snapshot));
    if(!stage||!equal(stage.header.nextIndex,snapshot))throw fail('index_stage_expired');
    if(stage.failed)throw fail('document_runtime_unavailable');
    return stage;
  }
  const runtimeSnapshot=(value:BrowserIndexSnapshot):DocumentSnapshotId=>{
    let result:DocumentSnapshotId;try{result=documentSnapshot(value);}catch{throw fail('invalid_wasm_result');}
    if(result.localStoreId!==host.authorityId)throw fail('invalid_wasm_result');return result;
  };
  const observation=(stage:Stage):DocumentRuntimeStage=>({source:{...stage.header.source},snapshot:runtimeSnapshot(stage.header.nextIndex),progress:{prepared:stage.prepared,total:stage.total,ready:!!stage.generation}});
  const fromResult=(result:BrowserIndexStage):DocumentRuntimeStage=>observation(ownedStage(result.snapshot));
  let configuredDraftScope:import('./document-drafts.ts').DocumentDraftScope|undefined;
  const createMaintenance=()=>{const created=browserDocumentRuntime({authorityId:host.authorityId,wasm:host.wasm,backend:{assertActive:active,
    async observe(){const result=await api.status();return {source:result.source,published:result.snapshot===null?null:runtimeSnapshot(result.snapshot),current:result.current,rebuildRequired:result.rebuildRequired,coverageComplete:result.coverageComplete};},
    initialize:()=>api.initialize(),
    async recoverStage(){
      active();if(stages.size===0)return null;if(stages.size!==1)throw fail('document_runtime_unavailable');
      const stage=ownedStage(stages.values().next().value!.header.nextIndex);
      // No persisted browser resume is available. Only an actual healthy live
      // builder can be recovered; a failed partially advanced builder cannot.
      const expected=JSON.stringify({rust:rust(()=>stage.builder?.headerJson()??stage.generation!.headerJson()),capture:stage.capture});
      const checksum=await run<string>('readonly',['control','metadata','presentation','sync_materialization_refs'],(tx,done,abort)=>readCatalog(tx,c=>{
        const descriptor=c.generations.find(g=>g.id===stage.id&&g.clientId===host.clientId&&g.state==='staging');
        if(!descriptor||descriptor.rows!==stage.prepared||!equal(descriptor.snapshot,stage.header.nextIndex))throw fail('index_stage_expired');
        sourceFence(tx,stage.header,c,stage.capture,()=>on(tx.objectStore('control').get(headerKey(stage.id)),row=>{
          if(row?.value!==expected||typeof row.digest!=='string')throw fail('index_rebuild_required');done(row.digest);
        },abort),abort);
      },abort));
      if(checksum!==await digest(expected))throw fail('index_rebuild_required');
      return observation(ownedStage(stage.header.nextIndex));
    },
    async begin(){return fromResult(await api.begin());},
    async pump(snapshot){const stage=ownedStage(snapshot);return fromResult(await api.pump(stage.id));},
    async publish(snapshot){const stage=ownedStage(snapshot);return runtimeSnapshot(await api.publish(stage.id));},
    async discard(snapshot){
      active();if(snapshot.localStoreId!==host.authorityId)throw fail('index_stage_expired');
      const id=await run<string|null>('readonly',['control'],(tx,done,abort)=>readCatalog(tx,c=>{const descriptor=c.generations.find(g=>equal(g.snapshot,snapshot));if(descriptor&&descriptor.clientId!==host.clientId)throw fail('index_stage_expired');if(snapshot.generationEpoch===c.epoch&&BigInt(decimalU64(snapshot.generation))>BigInt(c.allocated))throw fail('index_stage_expired');done(descriptor?.id??null);},abort));
      if(id!==null)await api.discard(id);
    },
    rebuild:()=>api.rebuild(),
  }});if(configuredDraftScope)created.configureDrafts!(configuredDraftScope);return created;};
  let driver=createMaintenance(),maintenanceClosed=false,rebuilding:Promise<void>|undefined,maintenanceClosing:Promise<void>|undefined;
  const gateMaintenance=()=>{if(maintenanceClosed)throw fail('document_runtime_retired');if(rebuilding)throw fail('document_runtime_busy');};
  maintenance={
    get draftsAvailable(){return driver.draftsAvailable===true;},
    configureDrafts(scope){gateMaintenance();driver.configureDrafts!(scope);configuredDraftScope=Object.freeze({...scope});},
    draft(input,bytes){gateMaintenance();return driver.draft!(input,bytes);},
    workSnapshot(){gateMaintenance();return driver.workSnapshot!();},
    workTurn(adopt){try{gateMaintenance();return driver.workTurn!(adopt);}catch(error){return Promise.reject(error);}},
    releaseDrafts(){gateMaintenance();return driver.releaseDrafts!();},
    command(input){gateMaintenance();return driver.command(input);},
    step(token){try{gateMaintenance();return driver.step(token);}catch(error){return Promise.reject(error);}},
    update(){return rebuilding?null:driver.update();},
    snapshot(){return rebuilding?null:driver.snapshot();},
    close(){maintenanceClosed=true;return maintenanceClosing??=(async()=>{await driver.close();await rebuilding?.catch(()=>{});})();},
  };
  const ownedMaintenance=maintenance;let closing:Promise<void>|undefined;
  // Public admission is revoked synchronously, while the internal executor can
  // still finish its one accepted raw operation before builders are released.
  const publicApi={...api};
  for(const [name,operation]of Object.entries(api))if(typeof operation==='function')Reflect.set(publicApi,name,(...args:unknown[])=>{
    if(maintenanceClosed||closing)return Promise.reject(fail('index_closed'));
    if(rebuilding)return Promise.reject(fail('document_runtime_busy'));
    return Reflect.apply(operation,api,args);
  });
  const index:BrowserDocumentIndex={...publicApi,metadataRowsAvailable:MetadataRows!==undefined,
    rebuild(){
      active();if(maintenanceClosed)throw fail('index_closed');if(rebuilding)return rebuilding;
      releaseQueryOwners();const previous=driver;
      const task=(async()=>{await previous.close();try{await api.rebuild();}finally{
        // Only a fully drained previous owner can be replaced. A failed raw
        // rebuild still requires the new lifetime to Observe durable storage.
        if(!maintenanceClosed)driver=createMaintenance();
      }})();
      const tracked=task.finally(()=>{if(rebuilding===tracked)rebuilding=undefined;});rebuilding=tracked;return tracked;
    },
    close(){if(closing)return closing;releaseQueryOwners();return closing=(async()=>{await ownedMaintenance.close();await api.close();})();},
  };
  return {index,maintenance:ownedMaintenance};
}
/** Compatibility low-level index. Maintenance remains lazy until its internal
 * owner is explicitly driven; no automatic frontend planner is installed. */
export function browserDocumentIndex(host:BrowserDocumentIndexHost):BrowserDocumentIndex{return createBrowserDocumentIndexBackend(host).index;}
