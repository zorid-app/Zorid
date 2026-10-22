import {captureSavedSourceGuard} from '../../desktop/conditional-saved-source.cjs';
import {DurableWritePlanningError} from '../core/durable-writes.ts';
import type {DurableWriteInput,DurableWritePlan} from '../core/durable-writes.ts';
import type {CheckpointScope} from '../core/durable-checkpoints.ts';
import {boundedUtf8} from '../core/checkpoint-input.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,names:string[])=>Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key));
const invalid=()=>new DurableWritePlanningError('invalid_planning_response',true);

/** Capture the guard before the first IPC await, so reply validation and
 * provider planning use the same original capture even if a caller mutates it. */
export function snapshotDesktopNoteWriteInput(input:DurableWriteInput):DurableWriteInput {
  if(!object(input))throw new DurableWritePlanningError('invalid_write_plan',false);
  if(!Object.hasOwn(input,'conditionalSavedSource'))return Object.freeze({...input});
  try{
    if(!keys(input,['operationId','path','expectedEntryId','expectedRevision','expectedContent','content','conditionalSavedSource']))throw new Error();
    const guard=captureSavedSourceGuard(input.conditionalSavedSource);
    if(guard.logicalWitness.entryId!==input.expectedEntryId||guard.logicalWitness.revision!==input.expectedRevision||guard.logicalWitness.path!==input.path)throw new Error();
    return Object.freeze({...input,conditionalSavedSource:guard});
  }catch{throw new DurableWritePlanningError('invalid_write_plan',false);}
}

/** Reconstruct planning errors AFTER crossing Electron's contextBridge. */
export function decodeDesktopNotePlan(input:DurableWriteInput,scope:CheckpointScope,reply:unknown):DurableWritePlan {
  if(!object(reply)||reply.notePlanning!==true||reply.schemaVersion!==1)throw invalid();
  if(reply.ok===false){
    const error=reply.error;
    if(!keys(reply,['notePlanning','schemaVersion','ok','error'])||!object(error)||!keys(error,['code','source','commitUncertain'])||typeof error.code!=='string'||!/^[a-z_]{1,64}$/.test(error.code)||error.source!=='host'||typeof error.commitUncertain!=='boolean')throw invalid();
    throw new DurableWritePlanningError(error.code,error.commitUncertain);
  }
  const plan=reply.value;
  if(reply.ok!==true||!keys(reply,['notePlanning','schemaVersion','ok','value'])||!object(plan)||!keys(plan,['version','vaultId','clientId','operationId','entryId','encodedPlan'])||plan.version!==1||plan.vaultId!==scope.vaultId||plan.clientId!==scope.clientId||plan.operationId!==input.operationId||plan.entryId!==input.expectedEntryId||typeof plan.encodedPlan!=='string')throw invalid();
  try{
    boundedUtf8(plan.encodedPlan,8*1024*1024,'plan_too_large');
    if(Object.hasOwn(input,'conditionalSavedSource')){
      const guard=captureSavedSourceGuard(input.conditionalSavedSource),encoded=JSON.parse(plan.encodedPlan);
      if(!object(encoded)||JSON.stringify(encoded)!==plan.encodedPlan||encoded.source_capture!==guard.captureId||encoded.operation_id!==input.operationId||!object(encoded.mutation)||encoded.mutation.type!=='write'||encoded.mutation.id!==input.expectedEntryId||encoded.mutation.expected!==input.expectedRevision)throw new Error();
    }
  }catch{throw invalid();}
  return Object.freeze({version:1,vaultId:scope.vaultId,clientId:scope.clientId,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:plan.encodedPlan});
}
