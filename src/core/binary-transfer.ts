import {BINARY_CHUNK_BYTES,BINARY_FORMAT_FILE_BYTES} from './binary-streams.ts';
import type {BinaryStreams,BinaryStageRef,BinaryStageRequest,BinaryReadRef} from './binary-streams.ts';

/** Sequential pull source. Returning null ends the declared content; empty chunks are invalid. */
export interface BinarySource {readonly length:string;read(maxBytes:number):Promise<Uint8Array|null>}
/** A private output: publish only in finish; abort discards any partial output. */
export interface BinarySink {write(bytes:Uint8Array,offset:string):Promise<void>;finish():Promise<void>;abort(error:unknown):Promise<void>}
const fail=(code:string)=>Object.assign(new Error('Binary transfer did not complete.'),{code,source:'host' as const});
export function binaryLength(value:string):bigint {
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)throw fail('invalid_binary_length');
  return BigInt(value);
}
function chunkLimit(streams:BinaryStreams):number {
  const size=streams.limits.maxChunkBytes;
  if(!Number.isInteger(size)||size<1||size>BINARY_CHUNK_BYTES||(binaryLength(streams.limits.maxFileBytes)>BigInt(BINARY_FORMAT_FILE_BYTES)||binaryLength(streams.limits.smallReadBytes)>binaryLength(streams.limits.maxFileBytes)))throw fail('invalid_stream_limits');
  return size;
}
function retained(error:unknown,request:BinaryStageRequest,ref?:BinaryStageRef):Error {
  // Keep the original authority error/code when available, while making the stage
  // locatable. It is never an authorization proof or permission to retry new IDs.
  const result=error instanceof Error?new Error(error.message,{cause:error}):fail('binary_transfer_failed');
  if(error&&typeof error==='object')for(const key of ['code','source','commitUncertain'] as const)if(key in error)Object.assign(result,{[key]:(error as Record<string,unknown>)[key]});
  return Object.assign(result,{binaryOperation:Object.freeze({...request,target:Object.freeze({...request.target})}),...(ref?{binaryStage:Object.freeze({...ref})}:{})});
}
export function blobBinarySource(blob:Blob):BinarySource {
  const length=blob.size;let offset=0;
  if(!Number.isSafeInteger(length)||length<0)throw fail('invalid_binary_length');
  return {length:String(length),async read(maxBytes){
    if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>BINARY_CHUNK_BYTES)throw fail('invalid_chunk_limit');
    if(offset===length)return null;
    const end=Math.min(length,offset+maxBytes),bytes=new Uint8Array(await blob.slice(offset,end).arrayBuffer());
    if(bytes.byteLength!==end-offset)throw fail('binary_source_changed');offset=end;return bytes;
  }};
}
/** Caller owns the source. A failed/uncertain transfer retains the durable stage;
 * receiving/sealed stages must never be automatically committed during recovery. */
export async function writeBinarySource(streams:BinaryStreams,input:Omit<BinaryStageRequest,'expectedLength'>,source:BinarySource,validate:()=>void=()=>{}):Promise<{ref:BinaryStageRef;receipt:string}> {
  const max=chunkLimit(streams),length=binaryLength(source.length);
  if(length>binaryLength(streams.limits.maxFileBytes))throw fail('too_large');
  const request={...input,target:{...input.target},expectedLength:String(length)};let ref:BinaryStageRef|undefined;
  try {
    validate();ref=await streams.begin(request);
    let offset=0n,sequence=0;
    while(offset<length){
      validate();const requested=Number(length-offset<BigInt(max)?length-offset:BigInt(max));
      const bytes=new Uint8Array(requested);let filled=0;
      while(filled<requested){
        validate();const value=await source.read(requested-filled);
        if(!(value instanceof Uint8Array)||!value.byteLength||value.byteLength>requested-filled)throw fail('binary_source_length_mismatch');
        bytes.set(value,filled);filled+=value.byteLength;
      }
      validate();
      const receipt=await streams.append(ref,{sequence,offset:String(offset),bytes});
      const next=offset+BigInt(bytes.length);
      if(receipt.sequence!==sequence||receipt.offset!==String(offset)||receipt.bytes!==bytes.length||receipt.acceptedLength!==String(next)||!/^[0-9a-f]{64}$/.test(receipt.digest))throw fail('invalid_binary_receipt');
      sequence++;offset=next;
    }
    validate();if(await source.read(max)!==null)throw fail('binary_source_length_mismatch');
    validate();const sealed=await streams.seal(ref,{finalLength:String(length)});
    if(sealed.length!==String(length)||!/^[0-9a-f]{64}$/.test(sealed.sha256))throw fail('invalid_binary_receipt');
    validate();const receipt=await streams.commit(ref);return {ref:{...ref},receipt};
  }catch(error){throw retained(error,request,ref);}
}
/** Authority verifies and pins before any output. The sink receives at most one
 * chunk at a time and is published only after exact EOF and successful pin close. */
export async function readBinarySink(streams:BinaryStreams,input:Parameters<BinaryStreams['openRead']>[0],sink:BinarySink,options:{validate?:()=>void;maxBytes?:string}={}):Promise<BinaryReadRef> {
  const validate=options.validate??(()=>{}),request={...input};let pin:BinaryReadRef|undefined,closed=false;
  try {
    const max=chunkLimit(streams);validate();pin=await streams.openRead(request);
    if(pin.entryId!==request.entryId||request.expectedRevision!==undefined&&pin.entryRevision!==request.expectedRevision||request.expectedContentEvent!==undefined&&pin.selectedContentEvent!==request.expectedContentEvent)throw fail('invalid_binary_read');
    const length=binaryLength(pin.length);
    if(length>binaryLength(streams.limits.maxFileBytes))throw fail('too_large');
    if(options.maxBytes!==undefined&&length>binaryLength(options.maxBytes))throw fail('stream_required');
    let offset=0n,eof=false;
    while(!eof){
      validate();const part=await streams.read(pin,{offset:String(offset),maxBytes:max});
      if(!(part.bytes instanceof Uint8Array)||part.bytes.length>max||(!part.bytes.length&&!part.eof))throw fail('invalid_binary_read');
      const next=offset+BigInt(part.bytes.length);
      if(next>length||part.nextOffset!==String(next)||part.eof!==(next===length))throw fail('invalid_binary_read');
      validate();if(part.bytes.length)await sink.write(new Uint8Array(part.bytes),String(offset));
      offset=next;eof=part.eof;
    }
    validate();await streams.closeRead(pin);closed=true;validate();await sink.finish();return {...pin};
  }catch(error){
    if(pin&&!closed)try{await streams.closeRead(pin);}catch{/* Keep the original failure; authority retains unresolved pins. */}
    try{await sink.abort(error);}catch{/* Aborting output must not hide the source failure. */}throw error;
  }
}
