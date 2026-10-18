import type { DurableWrites, DurableWritePlan, DurableWriteRef, DurableWriteIntent, DurableWriteInput, DurableWriteOutcome, DurableWriteRead } from '../core/durable-writes.ts';
import { DurableWritePlanningError } from '../core/durable-writes.ts';
import type { BrowserVaultIntent } from '../core/browser-vault.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserCoreBackend } from './browser-core.ts';
import { vaultPath } from './path.ts';

const limit = 8 * 1024 * 1024;
const error = (code: string, message: string) => new BrowserVaultError(code, message);
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024; }
/** Validate before encoding: TextEncoder otherwise silently replaces lone UTF-16 surrogates. */
function textSize(value: unknown): number {
  if (typeof value !== 'string') throw error('invalid_text', 'Text must be a string');
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw error('invalid_text', 'Text contains an unpaired UTF-16 surrogate');
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw error('invalid_text', 'Text contains an unpaired UTF-16 surrogate');
    else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes > limit) throw error('encoded_plan_too_large', 'Durable write checkpoint exceeds its 8 MiB bound');
  }
  return bytes;
}
export function browserDurableWrites(backend: BrowserCoreBackend, scope: {vaultId:string;clientId:string}, closed:()=>boolean): DurableWrites {
  if (!identity(scope.vaultId) || !identity(scope.clientId) || !backend.prepare || !backend.commit) throw error('durable_writes_unavailable','Durable writes require explicit vault/client scope and phase-aware backend');
  if (backend.durableScope?.vaultId !== scope.vaultId || backend.durableScope.clientId !== scope.clientId) throw error('intent_identity_mismatch','Adapter scope disagrees with the opened persistence runtime');
  if(!backend.checkpoints || backend.checkpoints.scope.vaultId!==scope.vaultId || backend.checkpoints.scope.clientId!==scope.clientId || !backend.readEntryById)throw error('durable_writes_unavailable','Durable writes require coherent ID reads and checkpoints in the same authority/client scope');
  const vaultId = scope.vaultId, clientId = scope.clientId;
  function active(): void { if (closed()) throw error('storage_closed','Browser vault is closed'); }
  function bound(value: {vaultId:string;clientId:string;operationId:string;entryId:string}): void {
    active();
    if (!value || value.vaultId !== vaultId || value.clientId !== clientId || !identity(value.operationId) || !identity(value.entryId)) throw error('intent_identity_mismatch','Durable identity does not belong to this vault/client');
  }
  function refBound(ref: DurableWriteRef): void { bound(ref); if (!identity(ref.token)) throw error('intent_identity_mismatch','Invalid intent token'); }
  function snapshotRef(ref: DurableWriteRef): DurableWriteRef {
    refBound(ref);
    return Object.freeze({vaultId:ref.vaultId,clientId:ref.clientId,token:ref.token,operationId:ref.operationId,entryId:ref.entryId});
  }
  function request(plan: DurableWritePlan): string {
    bound(plan);
    if (plan.version !== 1 || typeof plan.encodedPlan !== 'string') throw error('invalid_write_plan','Unsupported durable plan');
    textSize(plan.encodedPlan);
    let parsed;
    try { parsed = JSON.parse(plan.encodedPlan); } catch { throw error('invalid_write_plan','Durable plan is not serialized JSON'); }
    if (parsed?.operation_id !== plan.operationId || parsed?.mutation?.id !== plan.entryId || parsed?.mutation?.type !== 'write') throw error('intent_identity_mismatch','Plan wrapper disagrees with its exact request');
    // Rust validates the original serialized request at prepare, including any
    // duplicate fields. Never JSON.stringify this parsed copy for execution.
    return plan.encodedPlan;
  }
  function storedRequest(row: BrowserVaultIntent): any {
    try { return JSON.parse(row.request_json); } catch { throw error('storage_corrupt','Stored intent request is invalid'); }
  }
  function view(row: BrowserVaultIntent): DurableWriteIntent {
    const parsed = storedRequest(row);
    if (row.client_id !== clientId || !identity(row.intent_id) || !identity(row.operation_id) || parsed?.operation_id !== row.operation_id || !identity(parsed?.mutation?.id)) throw error('storage_corrupt','Stored intent identity is inconsistent');
    if (parsed.mutation.type !== 'write') throw error('intent_kind_unsupported','This intent requires a separate command recovery consumer');
    const ref = Object.freeze({vaultId,clientId,token:row.intent_id,operationId:row.operation_id,entryId:parsed.mutation.id});
    if (row.status === 'prepared' || row.status === 'commit_requested') {
      if (row.acknowledged) throw error('storage_corrupt','Unsettled intent cannot be acknowledged');
      return Object.freeze({ref,state:row.status,acknowledged:false});
    }
    if (row.status === 'committed') {
      let receipt;
      try { receipt = JSON.parse(row.receipt!); } catch { throw error('storage_corrupt','Stored receipt is invalid'); }
      if (receipt?.operation_id !== row.operation_id || typeof receipt.sequence !== 'string' || !/^[1-9][0-9]*$/.test(receipt.sequence)) throw error('storage_corrupt','Receipt identity is inconsistent');
      const targets=Array.isArray(receipt.changes)?receipt.changes.filter((change:any)=>change?.after?.id===ref.entryId):[];
      if(targets.length!==1 || targets[0].after.kind!=='file' || targets[0].after.deleted!==false || !identity(targets[0].after.revision))throw error('storage_corrupt','Receipt has no unique resulting text-entry witness');
      return Object.freeze({ref,state:'committed',acknowledged:row.acknowledged,receipt:Object.freeze({operationId:row.operation_id,sequence:receipt.sequence,entryId:ref.entryId,revision:targets[0].after.revision})});
    }
    if (row.status !== 'rejected' || !row.error || row.error.source !== 'rust') throw error('storage_corrupt','Invalid settled intent');
    return Object.freeze({ref,state:'rejected',acknowledged:row.acknowledged,error:Object.freeze({operationId:row.operation_id,code:row.error.code,message:row.error.message,details:row.error.details})});
  }
  async function find(ref: DurableWriteRef): Promise<BrowserVaultIntent | undefined> {
    ref = snapshotRef(ref);
    const row = (await backend.intents()).find(item => item.intent_id === ref.token);
    if (row) {
      const observed = view(row).ref;
      if (observed.operationId !== ref.operationId || observed.entryId !== ref.entryId) throw error('intent_identity_mismatch','Token does not identify the checkpointed operation and entry');
    }
    return row;
  }
  async function required(ref: DurableWriteRef): Promise<BrowserVaultIntent> {
    const row = await find(ref);
    if (!row) throw error('intent_not_found','Checkpointed intent is missing; recovery must not recreate it');
    return row;
  }
  return Object.freeze({
    checkpoints:backend.checkpoints,
    async readText(input: string): Promise<DurableWriteRead> {
      active();
      const path = vaultPath(input), row = await backend.readEntry(path);
      if (!row) throw error('ENOENT',`File not found: ${path}`);
      if (row.entry.kind !== 'file' || !row.bytes) throw error('not_file',`Path is not a file: ${path}`);
      return Object.freeze({content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.bytes),path:row.entry.path,entryId:row.entry.id,revision:row.entry.revision,stat:Object.freeze({ctime:row.presentation.ctime_ms,mtime:row.presentation.mtime_ms,size:row.presentation.size_bytes})});
    },
    async readTextById(entryId:string):Promise<DurableWriteRead|null> {
      active();if(!identity(entryId))throw error('invalid_write_plan','Stable entry identity is required');
      const row=await backend.readEntryById!(entryId);
      if(!row || row.entry.deleted)return null;
      if(row.entry.id!==entryId)throw error('storage_corrupt','Coherent ID read returned a different entry');
      if(row.entry.kind!=='file' || !row.bytes)throw error('not_file','Entry is not a text file');
      return Object.freeze({content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.bytes),path:row.entry.path,entryId:row.entry.id,revision:row.entry.revision,stat:Object.freeze({ctime:row.presentation.ctime_ms,mtime:row.presentation.mtime_ms,size:row.presentation.size_bytes})});
    },
    async planWrite(input: DurableWriteInput): Promise<DurableWritePlan> {
      active();
      if (!input || !identity(input.operationId)) throw error('invalid_write_plan','Caller must supply the operation identity');
      const operationId = input.operationId, path = vaultPath(input.path), content = input.content, expected = input.expectedContent;
      const expectedEntryId = input.expectedEntryId, expectedRevision = input.expectedRevision;
      if (!identity(expectedEntryId) || !identity(expectedRevision)) throw error('invalid_write_plan','Write planning requires the coherent observed entry identity and revision');
      textSize(content); textSize(expected);
      const row = await backend.readEntry(path);
      if (!row) throw error('ENOENT',`File not found: ${path}`);
      if (row.entry.kind !== 'file' || !row.bytes) throw error('not_file',`Path is not a file: ${path}`);
      // Only these witnessed, inert preflight comparisons establish a definite conflict.
      if (row.entry.id !== expectedEntryId || row.entry.revision !== expectedRevision) throw new DurableWritePlanningError('revision_conflict', false);
      if (new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.bytes) !== expected) throw new DurableWritePlanningError('revision_conflict', false);
      const bytes = new TextEncoder().encode(content);
      const base = JSON.stringify({operation_id:operationId,mutation:{type:'write',id:row.entry.id,expected:row.entry.revision,content:[]}});
      let encodedSize = textSize(base);
      for (let index=0;index<bytes.length;index++) encodedSize += (index ? 1 : 0) + (bytes[index] < 10 ? 1 : bytes[index] < 100 ? 2 : 3);
      if (encodedSize > limit) throw error('encoded_plan_too_large','Serialized durable request exceeds 8 MiB');
      const encodedPlan = JSON.stringify({operation_id:operationId,mutation:{type:'write',id:row.entry.id,expected:row.entry.revision,content:Array.from(bytes)}});
      return Object.freeze({version:1,vaultId,clientId,operationId,entryId:row.entry.id,encodedPlan});
    },
    async prepare(plan: DurableWritePlan): Promise<DurableWriteIntent> {
      const exact = request(plan);
      const ref = Object.freeze({vaultId,clientId,token:plan.operationId,operationId:plan.operationId,entryId:plan.entryId});
      await backend.prepare!(ref.token,exact);
      const row = await find(ref);
      if (!row) throw error('outcome_unknown','Prepared intent acknowledgement could not be reconciled; retry the exact plan');
      if (row.request_json !== exact) throw error('intent_identity_mismatch','Prepared token has a different exact request');
      return view(row);
    },
    async commit(ref: DurableWriteRef): Promise<DurableWriteIntent> {
      ref = snapshotRef(ref);
      const original = await required(ref);
      if (original.status === 'rejected') return view(original);
      let receipt: string | undefined;
      try { receipt = await backend.commit!(ref.token); }
      catch (failure) {
        if (!(failure instanceof BrowserVaultError && failure.source === 'rust')) throw failure;
        try {
          const rejected = await required(ref);
          if (rejected.status === 'rejected' && rejected.error?.code === failure.code) return view(rejected);
        } catch { /* A response after execution cannot establish a rejection. */ }
        throw error('outcome_unknown','Commit error has no matching durable rejection; retain the original intent');
      }
      try {
        const settled = await required(ref);
        if (settled.status === 'committed' && settled.receipt === receipt) return view(settled);
      } catch { /* Original host commit may already be durable. */ }
      throw error('outcome_unknown','Commit receipt could not be reconciled; retain the original intent');
    },
    async query(ref: DurableWriteRef): Promise<DurableWriteIntent | null> { const row = await find(ref); return row ? view(row) : null; },
    async listUnacknowledged(): Promise<DurableWriteIntent[]> {
      active();
      return (await backend.intents()).filter(row=>!row.acknowledged && storedRequest(row)?.mutation?.type === 'write').map(view);
    },
    async acknowledge(ref: DurableWriteRef, expected: DurableWriteOutcome): Promise<void> {
      ref = snapshotRef(ref);
      if (!expected) throw error('intent_outcome_mismatch','Acknowledge only an explicit settled outcome');
      expected = Object.freeze({...expected});
      const row = await required(ref), actual = view(row);
      if (!expected || expected.operationId !== ref.operationId ||
          !(expected.status === 'committed' && actual.state === 'committed' && expected.sequence === actual.receipt.sequence ||
            expected.status === 'rejected' && actual.state === 'rejected' && expected.code === actual.error.code)) throw error('intent_outcome_mismatch','Acknowledge only the exact checkpointed settled outcome');
      await backend.acknowledge(ref.token,row.status === 'committed' ? {status:'committed',receipt:row.receipt!} : {status:'rejected',error:row.error!});
    },
  });
}
