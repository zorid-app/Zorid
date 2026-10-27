import type {DesktopDatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';
export const MAX_DATABASE_REQUEST:number;
export const MAX_DATABASE_RESPONSE:number;
export function captureDatabaseRequest(input:unknown):DesktopDatabaseRequest;
export function validateDatabaseValue(request:DesktopDatabaseRequest,value:unknown):DatabaseResponse;
export function decodeDatabaseReply(request:DesktopDatabaseRequest,marker:unknown,bytes:Uint8Array):DatabaseResponse;
export function validDatabaseReply(command:{request:unknown;databaseRequest?:DesktopDatabaseRequest},marker:unknown,bytes:Uint8Array,requestBytes:Uint8Array):boolean;
export function decodeDatabaseEnvelope(request:DesktopDatabaseRequest,envelope:unknown):DatabaseResponse;
export function isDatabaseMutation(op:string):boolean;
