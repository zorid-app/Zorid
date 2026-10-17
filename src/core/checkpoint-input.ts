import type { CheckpointChange } from './durable-checkpoints.ts';
import { BrowserVaultError } from './browser-vault.ts';

export const checkpointStateLimit = 32 * 1024 * 1024;
export function checkpointError(code: string, message: string): BrowserVaultError { return new BrowserVaultError(code,message); }
/** Counts without allocating an encoded buffer; rejects lossy UTF-16 encoding. */
export function boundedUtf8(value: unknown, limit: number, code='invalid_checkpoint'): number {
  if (typeof value !== 'string') throw checkpointError(code,'Expected a bounded UTF-8 string');
  let bytes=0;
  for(let index=0;index<value.length;index++) {
    const unit=value.charCodeAt(index);
    if(unit>=0xd800 && unit<=0xdbff) {
      const next=value.charCodeAt(++index);
      if(!(next>=0xdc00 && next<=0xdfff)) throw checkpointError(code,'Unpaired UTF-16 surrogate');
      bytes+=4;
    } else if(unit>=0xdc00 && unit<=0xdfff) throw checkpointError(code,'Unpaired UTF-16 surrogate');
    else bytes+=unit<0x80?1:unit<0x800?2:3;
    if(bytes>limit) throw checkpointError(code,'UTF-8 byte limit exceeded');
  }
  return bytes;
}
export function checkpointKey(key: unknown): asserts key is string {
  if(!boundedUtf8(key,1024) || (key as string).includes('\0')) throw checkpointError('invalid_checkpoint','Checkpoint key must be nonempty and contain no NUL');
}
export function checkpointRevision(value: unknown): asserts value is string {
  if(typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw checkpointError('invalid_checkpoint','Revision must be a canonical lowercase UUID');
}
export function snapshotCheckpointChange(input: CheckpointChange): {change:CheckpointChange;byteLength:number} {
  if(!input) throw checkpointError('invalid_checkpoint','Checkpoint change is required');
  const change=Object.freeze({key:input.key,expectedRevision:input.expectedRevision,nextRevision:input.nextRevision,encodedState:input.encodedState});
  checkpointKey(change.key); checkpointRevision(change.nextRevision);
  if(change.expectedRevision!==null) checkpointRevision(change.expectedRevision);
  const byteLength=change.encodedState===null?0:boundedUtf8(change.encodedState,checkpointStateLimit,'checkpoint_too_large');
  return {change,byteLength};
}
