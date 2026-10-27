import test from 'node:test';
import assert from 'node:assert/strict';
import {planningBridge} from './helpers/desktop-note-planning.ts';
import {decodeDesktopNotePlan,snapshotDesktopNoteWriteInput} from '../src/platform/desktop-note-plan.ts';
import {DurableWritePlanningError} from '../src/core/durable-writes.ts';
test('planWrite carries a definite rejection as plain data across the context bridge',async()=>{
  const bridge=planningBridge(async()=>({ok:false,error:{code:'revision_conflict',commitUncertain:false}}));
  const result=await bridge.plan({});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{notePlanning:true,schemaVersion:1,ok:false,error:{code:'revision_conflict',source:'host',commitUncertain:false}});
});
test('lost planning transport preserves uncertainty as plain data instead of dropping Error fields',async()=>{
  const bridge=planningBridge(async()=>{throw new Error('IPC lost private-path');});
  const result=await bridge.plan({});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{notePlanning:true,schemaVersion:1,ok:false,error:{code:'planning_transport_lost',source:'host',commitUncertain:true}});
});

const input={operationId:'operation',path:'Note.md',expectedEntryId:'entry',expectedRevision:'old',expectedContent:'old',content:'new'},scope={vaultId:'authority',clientId:'client'};
const rejected=(code='revision_conflict',commitUncertain=false)=>({notePlanning:true,schemaVersion:1,ok:false,error:{code,source:'host',commitUncertain}});
test('decoder reconstructs definite versus unknown planning errors after the bridge clone',()=>{
  for(const uncertain of [false,true])assert.throws(()=>decodeDesktopNotePlan(input,scope,rejected('revision_conflict',uncertain)),error=>error instanceof DurableWritePlanningError&&error.source==='host'&&error.code==='revision_conflict'&&error.commitUncertain===uncertain);
  for(const invalid of [{...rejected(),schemaVersion:2},{...rejected(),extra:true},{...rejected(),error:{code:'revision_conflict',commitUncertain:false}},{...rejected(),error:{code:'revision_conflict',source:'host',commitUncertain:'false'}}])assert.throws(()=>decodeDesktopNotePlan(input,scope,invalid),error=>error instanceof DurableWritePlanningError&&error.code==='invalid_planning_response'&&error.commitUncertain);
});
test('successful plan envelope preserves exact encoded bytes and binds every identity to the request',()=>{
  const value={version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:'{"exact":"😀"}'};
  const reply={notePlanning:true,schemaVersion:1,ok:true,value};
  assert.equal(decodeDesktopNotePlan(input,scope,reply).encodedPlan,value.encodedPlan);
  for(const patch of [{vaultId:'other'},{clientId:'other'},{operationId:'other'},{entryId:'other'},{encodedPlan:'\ud800'}])assert.throws(()=>decodeDesktopNotePlan(input,scope,{...reply,value:{...value,...patch}}),error=>error instanceof DurableWritePlanningError&&error.commitUncertain);
});

test('canonical planning content is bound to the exact native payload across the bridge clone',()=>{
  const canonicalContent='---\nStatus: Done\n---\nnew 😀';
  const native={operation_id:input.operationId,mutation:{type:'write',id:input.expectedEntryId,expected:'new-revision'},content_base64:Buffer.from(canonicalContent).toString('base64')};
  const value={version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(native),canonicalContent};
  const envelope=(patch:Record<string,unknown>={})=>({notePlanning:true,schemaVersion:1,ok:true,value:{...value,...patch}});
  assert.equal(decodeDesktopNotePlan(input,scope,JSON.parse(JSON.stringify(envelope()))).canonicalContent,canonicalContent);
  for(const patch of [{canonicalContent:undefined},{canonicalContent:'forged'},{canonicalContent:'\ud800'},{encodedPlan:JSON.stringify({...native,content_base64:Buffer.from('other').toString('base64')})}]){
    assert.throws(()=>decodeDesktopNotePlan(input,scope,envelope(patch)),error=>error instanceof DurableWritePlanningError&&error.commitUncertain);
  }
  const guarded={...input,conditionalSavedSource:{captureId:'capture',logicalWitness:{entryId:input.expectedEntryId,revision:input.expectedRevision,path:input.path}}};
  assert.throws(()=>decodeDesktopNotePlan(guarded,scope,envelope()),error=>error instanceof DurableWritePlanningError&&error.commitUncertain);
});


test('conditional planning snapshots the exact original capture before an IPC await',()=>{
  const guard={captureId:'original-capture',logicalWitness:{entryId:input.expectedEntryId,revision:input.expectedRevision,path:input.path}};
  const captured=snapshotDesktopNoteWriteInput({...input,conditionalSavedSource:guard});
  guard.captureId='changed';guard.logicalWitness.path='Other.md';
  assert.equal(captured.conditionalSavedSource!.captureId,'original-capture');
  assert.equal(captured.conditionalSavedSource!.logicalWitness.path,input.path);
  assert.ok(Object.isFrozen(captured.conditionalSavedSource)&&Object.isFrozen(captured.conditionalSavedSource!.logicalWitness));
  for(const conditionalSavedSource of [null,{captureId:'capture',logicalWitness:{entryId:'other',revision:input.expectedRevision,path:input.path}},{captureId:'capture',logicalWitness:{entryId:input.expectedEntryId,revision:input.expectedRevision,path:input.path},source:'forged'}]){
    assert.throws(()=>snapshotDesktopNoteWriteInput({...input,conditionalSavedSource} as any),error=>error instanceof DurableWritePlanningError&&!error.commitUncertain);
  }
});

test('conditional planning reply cannot strip or substitute the guard in the persisted opaque bytes',()=>{
  const guarded={...input,conditionalSavedSource:{captureId:'capture',logicalWitness:{entryId:input.expectedEntryId,revision:input.expectedRevision,path:input.path}}};
  const native={operation_id:input.operationId,mutation:{type:'write',id:input.expectedEntryId,expected:input.expectedRevision},content_base64:'bmV3',source_capture:'capture'};
  const value={version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(native)};
  const envelope=(encodedPlan:string)=>({notePlanning:true,schemaVersion:1,ok:true,value:{...value,encodedPlan}});
  assert.equal(decodeDesktopNotePlan(guarded,scope,envelope(value.encodedPlan)).encodedPlan,value.encodedPlan);
  const {source_capture,...unguarded}=native;
  for(const invalid of [JSON.stringify(unguarded),JSON.stringify({...native,source_capture:'different'}),JSON.stringify({...native,mutation:{...native.mutation,expected:'other'}}),'{"source_capture":"wrong",'+value.encodedPlan.slice(1)]){
    assert.throws(()=>decodeDesktopNotePlan(guarded,scope,envelope(invalid)),error=>error instanceof DurableWritePlanningError&&error.code==='invalid_planning_response'&&error.commitUncertain);
  }
});
