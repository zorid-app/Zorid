import test from 'node:test';
import assert from 'node:assert/strict';
import {planningBridge} from './helpers/desktop-note-planning.ts';
import {decodeDesktopNotePlan} from '../src/platform/desktop-note-plan.ts';
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
