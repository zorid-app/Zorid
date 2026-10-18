import type {DesktopWorkBlockRequest} from '../src/core/workblocks.ts';
export const MAX_WORKBLOCK_REQUEST:number;
export const MAX_WORKBLOCK_RESPONSE:number;
export function captureWorkBlockCommand(op:string,input:unknown):DesktopWorkBlockRequest;
export function captureWorkBlockRequest(input:unknown):DesktopWorkBlockRequest;
export function validateWorkBlockValue(request:DesktopWorkBlockRequest,value:unknown):unknown;
export function decodeWorkBlockEnvelope(request:DesktopWorkBlockRequest,envelope:unknown):unknown;
export function decodeWorkBlockReply(request:DesktopWorkBlockRequest,marker:unknown,bytes:Uint8Array):unknown;
export function validWorkBlockReply(command:{request:DesktopWorkBlockRequest},marker:unknown,bytes:Uint8Array):boolean;
