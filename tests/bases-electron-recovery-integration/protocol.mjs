import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_HEADER = 1024 * 1024, MAX_BODY = 64 * 1024 * 1024;
// Test transport only. Original encoded bytes are retained; decoding never
// becomes a replacement response or a second implementation of host semantics.
export class Frames {
  prefix = Buffer.alloc(8); prefixUsed = 0; frame = null; used = 0; headerLength = 0;
  push(chunk) {
    assert.ok(Buffer.isBuffer(chunk));
    const frames = []; let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const size = Math.min(8 - this.prefixUsed, chunk.length - offset);
        chunk.copy(this.prefix, this.prefixUsed, offset, offset + size); this.prefixUsed += size; offset += size;
        if (this.prefixUsed < 8) continue;
        this.headerLength = this.prefix.readUInt32BE(0); const bodyLength = this.prefix.readUInt32BE(4);
        assert.ok(this.headerLength > 0 && this.headerLength <= MAX_HEADER && bodyLength <= MAX_BODY, 'Bounded native frame');
        this.frame = Buffer.allocUnsafe(8 + this.headerLength + bodyLength); this.prefix.copy(this.frame); this.used = 8;
      }
      const size = Math.min(this.frame.length - this.used, chunk.length - offset);
      chunk.copy(this.frame, this.used, offset, offset + size); this.used += size; offset += size;
      if (this.used < this.frame.length) continue;
      const raw = this.frame;
      const header = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(raw.subarray(8, 8 + this.headerLength)));
      frames.push({raw, header, body:raw.subarray(8 + this.headerLength)});
      this.frame = null; this.used = this.prefixUsed = 0;
    }
    return frames;
  }
  end() { assert.ok(!this.frame && this.prefixUsed === 0, 'Truncated native frame'); }
}

export function validateArm(arm) {
  assert.ok(arm && ['hold','drop'].includes(arm.mode));
  assert.match(arm.token, /^[a-f0-9]{32}$/);
  assert.ok(typeof arm.path === 'string' && arm.path && !arm.path.startsWith('/') && !arm.path.split('/').includes('..'));
  assert.match(arm.bodySha256, /^[a-f0-9]{64}$/);
  if (arm.mode === 'hold') assert.ok(typeof arm.entryId === 'string' && arm.entryId.length > 0);
  if (arm.phase !== undefined) assert.ok(arm.mode === 'hold' && ['prepared','committed'].includes(arm.phase), 'Only hold has an explicit prepared/committed phase');
  return arm;
}

export async function waitForRelease({token,read,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=15000}) {
  const deadline=now()+timeoutMs;
  while((await read())?.token!==token){if(now()>=deadline)return false;await pause(15);}
  return true;
}

/** Single-flight observer. Arming never changes requests. Default holds/drops
 * select committed success; an explicit prepared hold selects only an inert
 * genuine prepared reply, never a receipt or a manufactured failure. */
export class Selection {
  pending = null; paths = new Map(); prepared = new Map(); consumed = new Set();
  request(frame, arm) {
    assert.equal(this.pending, null, 'Only one genuine main request may be in flight');
    assert.ok(frame.header.version === 1 && frame.header.request_id !== '0');
    const command = frame.header.command;
    assert.ok(command && typeof command.method === 'string');
    this.pending = {frame, command, arm:arm && !this.consumed.has(arm.token) ? validateArm(arm) : null};
  }
  response(frame) {
    if (frame.header.request_id === '0') { assert.equal(this.pending, null); return null; }
    const pending = this.pending; assert.ok(pending, 'Native response has original request'); this.pending = null;
    assert.equal(frame.header.request_id, pending.frame.header.request_id);
    const {command, arm} = pending, result = frame.header.result;
    if (!frame.header.ok) return null;
    const remember = entry => { if (entry && !entry.deleted && typeof entry.id === 'string' && typeof entry.path === 'string') this.paths.set(entry.id, entry.path); };
    remember(result?.entry);
    if (command.method === 'list_snapshot') for (const entry of result?.entries ?? []) remember(entry.state);
    let selected;
    if (command.method === 'prepare_intent' && arm?.mode === 'hold'
      && command.mutation?.type === 'write' && command.mutation.id === arm.entryId
      && this.paths.get(arm.entryId) === arm.path && digest(pending.frame.body) === arm.bodySha256) {
      const intent = result?.intent;
      assert.ok(intent && intent.client_id === command.client_id && intent.entry_id === arm.entryId && intent.operation_id === command.operation_id && typeof intent.token === 'string');
      const original = {arm, operationId:intent.operation_id, entryId:intent.entry_id, clientId:intent.client_id, bodySha256:arm.bodySha256};
      this.prepared.set(intent.token, original);
      if (arm.phase === 'prepared' && intent.state === 'prepared') {
        selected = {...original, phase:'prepared', nativeState:'prepared', nativeIntentToken:intent.token};
      }
    }
    if (command.method === 'commit_intent') {
      const original = this.prepared.get(command.reference?.token), intent = result?.intent;
      if (original && original.arm.phase !== 'prepared' && !this.consumed.has(original.arm.token) && command.reference.client_id === original.clientId
        && intent?.state === 'committed' && intent.token === command.reference.token && intent.operation_id === original.operationId
        && intent.receipt?.operation_id === original.operationId) {
        const entry = intent.receipt.changes?.find(change => change.after?.id === original.entryId)?.after;
        assert.ok(entry && entry.path === original.arm.path && !entry.deleted);
        selected = {...original, sequence:intent.receipt.sequence, revision:entry.revision};
      }
    } else if (command.method === 'file_command' && arm?.mode === 'drop') {
      const request = command.family?.request, mutation = request?.mutation;
      if (mutation?.type === 'create' && mutation.kind === 'file' && mutation.path === arm.path && digest(pending.frame.body) === arm.bodySha256
        && result?.commit?.operation_id === request.operation_id) {
        const entry = result.commit.changes?.find(change => change.after?.id === mutation.id)?.after;
        assert.ok(entry && entry.path === arm.path && !entry.deleted);
        selected = {arm, operationId:request.operation_id, entryId:mutation.id, sequence:result.commit.sequence, revision:entry.revision, bodySha256:arm.bodySha256};
      }
    }
    if (!selected) return null;
    this.consumed.add(selected.arm.token);
    return {...selected, requestId:frame.header.request_id, requestSha256:digest(pending.frame.raw), responseSha256:digest(frame.raw)};
  }
}
