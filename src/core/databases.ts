import {captureDatabaseRequest,decodeDatabaseEnvelope} from '../../desktop/databases.cjs';

/** Local collection state is owned by Rust. Names are readable projections;
 * references and typed option values retain their stable identities. */
export type DatabaseDatatype='text'|'number'|'checkbox'|'date'|'datetime'|'select'|'multi-select'|'status';
export type DatabaseValue=string|number|boolean|null|readonly string[];
export interface DatabaseOptionInput {readonly id?:string;readonly name:string;readonly category?:'not_started'|'working'|'done';readonly color?:string}
export interface DatabaseOption extends DatabaseOptionInput {readonly id:string}
export interface DatabasePropertyInput {readonly id?:string;readonly name:string;readonly datatype:DatabaseDatatype;readonly options?:readonly DatabaseOptionInput[];readonly default?:DatabaseValue}
export interface DatabaseProperty extends Omit<DatabasePropertyInput,'id'|'options'> {readonly id:string;readonly options:readonly DatabaseOption[]}
export interface DatabaseCollection {readonly id:string;readonly name:string;readonly revision:string;readonly deleted:boolean;readonly properties:readonly DatabaseProperty[]}
export interface DatabaseEntry {readonly entryId:string;readonly collectionId:string;readonly revision:string;readonly fileRevision:string|null;readonly path:string;readonly values:Readonly<Record<string,DatabaseValue>>;readonly deleted:boolean;readonly pendingProjection:boolean;readonly problems?:Readonly<Record<string,string>>}
export interface DatabaseResponse {
  readonly collections:readonly DatabaseCollection[];readonly entries:readonly DatabaseEntry[];
  /** Local durability and physical publication are distinct outcomes. */
  readonly projection:{readonly pending:number;readonly issues:readonly {readonly entryId?:string;readonly message:string}[]};
  readonly composition?:{readonly content:string;readonly currentSource:string;readonly currentFileRevision:string;readonly entryRevision:string;readonly collectionRevision:string};
}
export type DatabaseRequest=
  | {readonly op:'list'}
  | {readonly op:'get';readonly collectionId:string}
  | {readonly op:'get_entry';readonly entryId:string}
  | {readonly op:'create';readonly operationId:string;readonly name:string;readonly preset?:'blank'|'tasks';readonly properties?:readonly DatabasePropertyInput[]}
  | {readonly op:'update';readonly operationId:string;readonly collectionId:string;readonly expectedRevision:string;readonly name:string;readonly properties:readonly DatabasePropertyInput[];readonly confirmDestructive?:boolean}
  | {readonly op:'create_entry';readonly operationId:string;readonly collectionId:string;readonly expectedCollectionRevision:string;readonly entryId:string;readonly path:string;readonly body?:string;readonly values?:Readonly<Record<string,DatabaseValue>>}
  | {readonly op:'set_entry';readonly operationId:string;readonly entryId:string;readonly expectedRevision:string;readonly expectedCollectionRevision:string;readonly values:Readonly<Record<string,DatabaseValue>>}
  | {readonly op:'duplicate_entry';readonly operationId:string;readonly entryId:string;readonly expectedRevision:string;readonly newEntryId:string;readonly path:string}
  | {readonly op:'delete'|'restore';readonly operationId:string;readonly collectionId:string;readonly expectedRevision:string}
  | {readonly op:'retry'}
  /** Internal editor composition; it cannot assign or move collection membership. */
  | {readonly op:'compose';readonly entryId:string;readonly expectedRevision:string;readonly baseline:string;readonly proposed:string};
export interface DesktopDatabaseRequest {readonly schemaVersion:1;readonly command:DatabaseRequest}
export interface DatabaseService {request(command:DatabaseRequest):Promise<DatabaseResponse>}

/** Capture before transport starts. Callers own operation IDs and must retain the
 * identical command after acknowledgement uncertainty; no retry mints an ID. */
export function createDatabaseService(invoke:(request:DesktopDatabaseRequest)=>Promise<unknown>):DatabaseService {
  return Object.freeze({request(command:DatabaseRequest):Promise<DatabaseResponse>{
    let request:DesktopDatabaseRequest;
    try{request=captureDatabaseRequest({schemaVersion:1,command});}catch(error){return Promise.reject(error);}
    return invoke(request).then(reply=>decodeDatabaseEnvelope(request,reply));
  }});
}
