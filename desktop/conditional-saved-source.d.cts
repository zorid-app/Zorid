import type {ConditionalSavedSourceWitness,ConditionalSavedSourceGuard,ConditionalSavedSourceCapture} from '../src/core/durable-writes.ts';
export const SOURCE_LIMIT:number;
export const PATH_LIMIT:number;
export function captureSavedSourceWitness(value:unknown):ConditionalSavedSourceWitness;
export function captureSavedSourceId(value:unknown):string;
export function captureSavedSourceGuard(value:unknown):ConditionalSavedSourceGuard;
export function captureSavedSourceValue(value:unknown,expected:ConditionalSavedSourceWitness):ConditionalSavedSourceCapture;
export function validSavedSourceReply(command:{entry_id:string;revision:string;path:string},result:unknown,bytes:Uint8Array):boolean;
export function decodeSavedSourceReply(command:{entry_id:string;revision:string;path:string},result:unknown,bytes:Uint8Array):ConditionalSavedSourceCapture;
