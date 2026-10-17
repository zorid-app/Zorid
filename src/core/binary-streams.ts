/** Internal first-party capability shared by browser/native adapters.
 * Locators are lookup data: only their owning authority can resolve, verify and
 * authorize them. No serialized value is a durable-content verification proof. */
export const BINARY_CHUNK_BYTES = 128 * 1024;
export const BINARY_FORMAT_FILE_BYTES = '67108864';
export type BinaryTarget =
  | {kind:'create';entryId:string;path:string}
  | {kind:'write';entryId:string;expectedRevision:string;expectedContentEvent:string};
export interface BinaryStageRef {
  localStoreId:string;clientId:string;operationId:string;stageId:string;
}
export interface BinaryStageRequest {
  operationId:string;target:BinaryTarget;expectedLength?:string;
}
export interface BinaryChunkInput {
  sequence:number;offset:string;bytes:Uint8Array;
}
export interface BinaryChunkReceipt {
  sequence:number;offset:string;bytes:number;digest:string;acceptedLength:string;
}
export interface BinarySealInput {finalLength:string;expectedDigest?:string}
export interface BinarySealedStatus {length:string;sha256:string}
export type BinaryOperationOutcome =
  | {status:'committed';receipt:string}
  | {status:'rejected';error:{code:string;message:string;details?:unknown;source:'host'|'rust'}};
export interface BinaryStageStatus {
  ref:BinaryStageRef;
  phase:'receiving'|'sealed'|'commit_requested'|'committed'|'rejected'|'aborted';
  acceptedLength:string;nextSequence:number;
  finalized?:BinarySealedStatus;
  outcome?:BinaryOperationOutcome;
}
export interface BinaryReadRef {
  localStoreId:string;clientId:string;readId:string;
  entryId:string;entryRevision:string;selectedContentEvent:string;length:string;
}
export interface BinaryReadChunk {bytes:Uint8Array;nextOffset:string;eof:boolean}
export interface BinaryStreamLimits {
  maxFileBytes:string;maxChunkBytes:number;smallReadBytes:string;
}
/** Lengths/offsets are canonical decimal u64; digests are lowercase SHA256 hex.
 * Implementations snapshot one chunk before awaiting and never detach caller data.
 * Receiving/Sealed stages are inert. Commit uses the original durable operation.
 * Release/retirement preserves stages rather than implicitly aborting them. */
export interface BinaryStreams {
  readonly limits:Readonly<BinaryStreamLimits>;
  begin(input:BinaryStageRequest):Promise<BinaryStageRef>;
  append(ref:BinaryStageRef,input:BinaryChunkInput):Promise<BinaryChunkReceipt>;
  query(ref:BinaryStageRef):Promise<BinaryStageStatus>;
  seal(ref:BinaryStageRef,input:BinarySealInput):Promise<BinarySealedStatus>;
  commit(ref:BinaryStageRef):Promise<string>;
  abort(ref:BinaryStageRef):Promise<void>;
  openRead(input:{entryId:string;expectedRevision?:string;expectedContentEvent?:string}):Promise<BinaryReadRef>;
  read(ref:BinaryReadRef,input:{offset:string;maxBytes:number}):Promise<BinaryReadChunk>;
  closeRead(ref:BinaryReadRef):Promise<void>;
}
