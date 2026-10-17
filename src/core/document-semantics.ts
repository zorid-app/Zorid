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
  readonly groups:readonly{readonly key:DocumentBaseValue|null;readonly entryIds:readonly string[]}[];
  readonly groupOptions:readonly{readonly key:DocumentBaseValue;readonly count:number;readonly listed:boolean}[];
  readonly properties:readonly string[];readonly availableProperties:readonly string[];
  readonly counts:{readonly scanned:number;readonly matched:number;readonly afterGroupOrder:number;readonly afterSearch:number;readonly returned:number};
  readonly diagnostics:readonly{readonly phase:string;readonly entryId:string;readonly path:string;readonly property:string|null;readonly code:string;readonly message:string}[];
  readonly relationshipsAvailable:boolean;readonly metadataComplete:boolean;
  readonly metadataIssues:readonly{readonly witness:{readonly entryId:string;readonly revision:string};readonly exclusion:DocumentExclusion|null;readonly diagnostics:readonly DocumentDiagnostic[];readonly propertiesUnavailable:boolean}[];
  readonly stepsUsed:number;
}
export interface DocumentBaseOptions {readonly viewIndex?:number;readonly searchTerms?:readonly string[];readonly ignorePaths?:readonly string[];readonly clockMs?:number;readonly timezone?:string;readonly maxRows?:number}
export interface DocumentBaseRead {readonly definition:DocumentEntry;readonly result:DocumentBaseResult}
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
  base(input:{readonly id:string;readonly viewName?:string|null;readonly options?:DocumentBaseOptions}):Promise<DocumentQueryResult<DocumentBaseRead>>;
}
/** Optional normal-vault capability. Closing a pin never releases its vault.
 * Every read stays on its retained generation. Expiry requires explicit reopen;
 * callers must never silently retry against a different generation. */
export interface DocumentService {
  status():Promise<DocumentStatus>;open():Promise<DocumentPin>;rebuild():Promise<void>;
  begin():Promise<DocumentStage>;pump(stageId:DocumentStageId):Promise<DocumentStage>;publish(stageId:DocumentStageId):Promise<DocumentSnapshotId>;
}
export interface DocumentSemanticsCapability {readonly documentSemantics?:DocumentService}
export const DOCUMENT_REQUEST_BYTES=64*1024,DOCUMENT_RESPONSE_BYTES=16*1024*1024,DOCUMENT_PAGE_LIMIT=1000;
export class DocumentSemanticsError extends Error {
  constructor(readonly code:string){super('Shared document semantics are unavailable.');this.name='DocumentSemanticsError';}
}
