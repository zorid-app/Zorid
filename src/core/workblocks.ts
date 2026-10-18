/** First-party calendar records. These tokens are opaque: preserve every byte;
 * callers retain the identical operation ID and input after an uncertain result.
 * Task references are stable file identities, never note paths or task mirrors. */
export type WorkBlockRevision = readonly number[];
export interface WorkBlockRange {readonly start_ms:string;readonly end_ms:string;readonly timezone:string}
export interface WorkBlockTarget {readonly record:string;readonly generation:string}
export interface WorkBlockMutation extends WorkBlockTarget {readonly operation:string;readonly expectedRevision:WorkBlockRevision}
export interface WorkBlockCreate extends WorkBlockTarget {readonly operation:string;readonly range:WorkBlockRange;readonly title?:string|null}
export interface WorkBlockCommit {readonly operation:string;readonly revision:WorkBlockRevision;readonly sequence:string}
export interface WorkBlockRead extends WorkBlockTarget {
  readonly revision:WorkBlockRevision;readonly created:boolean;readonly deleted:boolean;
  readonly block:null|{readonly ranges:readonly {readonly operation:string;readonly range:WorkBlockRange}[];readonly titles:readonly {readonly operation:string;readonly title:string|null}[];readonly taskRefs:readonly string[]};
  /** Admission status to canonical decimal count; unknown status keys survive. */
  readonly unresolved:Readonly<Record<string,string>>;
}
/** Native pages retain the 64-record ceiling. Continue with the identical query
 * and budgets; a changed collection expires the fence instead of mixing views. */
export interface WorkBlockWindow {readonly fromMs:string;readonly untilMs:string;readonly limit:number;readonly byteLimit:number;readonly cursor?:string|null}
export interface WorkBlockPage {readonly blocks:readonly WorkBlockRead[];readonly cursor:string|null;readonly incomplete:boolean;readonly watermark:string;readonly scanned:number;readonly bytes:number}
export interface WorkBlockChanges {readonly changes:readonly {readonly sequence:string;readonly record_key:string;readonly update_id:string;readonly status:string}[];readonly next:string}
export interface WorkBlockService {
  create(input:WorkBlockCreate):Promise<WorkBlockCommit>;
  read(input:WorkBlockTarget):Promise<WorkBlockRead>;
  windowPage(input:WorkBlockWindow):Promise<WorkBlockPage>;
  move(input:WorkBlockMutation&{readonly range:WorkBlockRange}):Promise<WorkBlockCommit>;
  title(input:WorkBlockMutation&{readonly title:string|null}):Promise<WorkBlockCommit>;
  addRef(input:WorkBlockMutation&{readonly task:string}):Promise<WorkBlockCommit>;
  removeRef(input:WorkBlockMutation&{readonly task:string}):Promise<WorkBlockCommit>;
  delete(input:WorkBlockMutation):Promise<WorkBlockCommit>;
  changes(input:{readonly after:string;readonly limit:number}):Promise<WorkBlockChanges>;
}
/** Private transport DTO; no collection, schema, owner or enrollment handles. */
export interface DesktopWorkBlockRequest {schemaVersion:1;command:Readonly<Record<string,unknown>>&{op:string}}
