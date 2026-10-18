import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createDesktopDocumentService} from '../src/platform/desktop-document-semantics.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
const {captureDocumentRequest,decodeDocumentReply,createDesktopDocumentSemantics}=createRequire(import.meta.url)('../desktop/document-semantics.cjs');
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'9007199254740993',versions:{schema:1,extraction:'v1',resolver:'v1',query:'v1'}};
const source={localStoreId:'store',watermark:'9007199254740993'};
const witness={entryId:'type-file',revision:'r1'};
const definition={id:'type-file',revision:'r1',path:'Task.yaml',kind:'file',deleted:false};
const property=(id:string,key:string,datatype:string)=>({id,key,label:key,datatype,options:datatype==='status'?[{id:'todo',label:'To do',category:'not_started'}]:[],default:datatype==='status'?'todo':null});
const request=(fields:Record<string,unknown>={})=>({schemaVersion:1,command:{op:'tasks',pinId:'1',typeIds:['type-file'],options:{clockMs:0},...fields}});
function result(){return {snapshot,source,coverageComplete:true,value:{definitions:[definition],types:[{witness,typeId:'type-task',label:'Task',status:property('status','state','status'),plannedDay:property('planned','plan','date'),deadline:property('deadline','due','date'),captureDefaults:[['type','type-task'],['state','todo']]}],result:{snapshotId:snapshot,typeWitnesses:[witness],coverageComplete:true,rows:[{witness:{entryId:'note',revision:'n1'},path:'Task.md',title:'Task',typeId:'type-task',statusId:'todo',statusLabel:'To do',category:'not_started',statusDefaulted:true,plannedDay:null,deadline:null}],groups:[{typeId:'type-task',category:'not_started',statusId:'todo',entryIds:['note']}],matched:1,truncated:false,diagnostics:[],typeDiagnostics:[],metadataIssues:[]}}};}
function wire(value:unknown){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,op:'tasks',value}));return [{documents:true,schemaVersion:1,bytes:bytes.length},bytes] as const;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
test('Tasks strict request captures selectors/options and rejects renderer AST/owner/invalid options',()=>{
 const input=request();const captured=captureDocumentRequest(input);input.command.typeIds[0]='changed';input.command.options.clockMs=42;
 assert.deepEqual(captured.command.typeIds,['type-file']);assert.equal(captured.command.options.clockMs,0);
 for(const fields of [{configuration:{}},{owner:'forged'},{options:null},{typeIds:['x','x']},{typeIds:Array.from({length:129},(_,i)=>'id'+i)},{typeIds:['../Task.yaml']},{options:{clockMs:null}},{options:{schema:{}}},{options:{showDone:'true'}},{options:{filter:'checkboxes'}},{options:{maxRows:0}}]) assert.throws(()=>captureDocumentRequest(request(fields)));
});
test('Tasks reply keeps exact source/snapshot and definition-witness/group consistency',()=>{
 const valid=result();assert.deepEqual(decodeDocumentReply(request(),...wire(valid)),valid);
 for(const mutate of [
  (v:any)=>v.value.definitions[0]={...v.value.definitions[0],revision:'wrong'},
  (v:any)=>v.value.result.snapshotId={...snapshot,generationEpoch:'other'},
  (v:any)=>v.value.result.typeWitnesses=[],
  (v:any)=>v.value.result.groups[0].typeId='other',
  (v:any)=>v.value.result.groups[0].entryIds=['foreign'],
  (v:any)=>v.value.result.rows.push(v.value.result.rows[0]),
 ]){const value=structuredClone(valid);mutate(value);assert.throws(()=>decodeDocumentReply(request(),...wire(value)),{code:'invalid_document_response'});}
 const unknown=result();Object.assign(unknown.value.result.rows[0],{statusId:'future value',statusLabel:null,category:null});Object.assign(unknown.value.result.groups[0],{statusId:'future value',category:null});assert.doesNotThrow(()=>decodeDocumentReply(request(),...wire(unknown)));
});
test('invalid YAML result retains definition witness/diagnostic without invented capture types',()=>{
 const value:any=result();value.value.types=[];Object.assign(value.value.result,{coverageComplete:false,rows:[],groups:[],matched:0,typeDiagnostics:[{witness,code:'invalid_type_yaml',yaml:{code:'syntax',range:{bytes:[0,4],utf16:[0,4]}}}]});
 assert.doesNotThrow(()=>decodeDocumentReply(request(),...wire(value)));
});
test('desktop optional Tasks captures requests, leaves omitted clock for native, and drains before release',async()=>{
 const pending=deferred<unknown>(),entered=deferred<void>(),closed:string[]=[],seen:any[]=[];
 const binding=createDesktopDocumentService(async raw=>{const captured=captureDocumentRequest(raw);seen.push(captured);const c=captured.command;if(c.op==='open')return {pinId:c.pinId,snapshot,source,coverageComplete:true};if(c.op==='close'){closed.push(c.pinId);return true;}if(c.op==='tasks'){entered.resolve();return pending.promise;}throw Error('unexpected');});
 const pin=await binding.service.open();assert.ok(pin.tasks);const typeIds=['type-file'];const options={clockMs:0,filter:'all' as const};const read=pin.tasks({typeIds,options});typeIds[0]='changed';options.clockMs=99;await entered.promise;
 assert.deepEqual(seen.at(-1).command.typeIds,['type-file']);assert.equal(seen.at(-1).command.options.clockMs,0);
 const release=binding.release();assert.deepEqual(closed,[]);await assert.rejects(()=>pin.tasks!({typeIds:['type-file']}),{code:'client_not_admitted'});
 pending.resolve(result());await read;await release;assert.deepEqual(closed,['1']);
 const noClock=createDesktopDocumentService(async raw=>{const c=captureDocumentRequest(raw).command;if(c.op==='open')return {pinId:c.pinId,snapshot,source,coverageComplete:true};if(c.op==='tasks'){assert.deepEqual(c.options,{});return result();}return true;});
 const second=await noClock.service.open();await second.tasks!({typeIds:['type-file'],options:{clockMs:undefined,filter:undefined}});await noClock.release();
});
test('absent Tasks capability stays absent and closed/mixed pin replies fail closed',async()=>{
 const transport:any={open:async()=>({pinId:'1',snapshot,source,coverageComplete:true}),closePin:async()=>{}};
 assert.equal((await createDocumentService(transport).open()).tasks,undefined);
 let reply=result();const binding=createDesktopDocumentService(async raw=>{const c=raw.command;if(c.op==='open')return {pinId:c.pinId,snapshot,source,coverageComplete:true};if(c.op==='tasks')return reply;return true;});const pin=await binding.service.open();
 reply={...result(),source:{...source,watermark:'99'}};await assert.rejects(()=>pin.tasks!({typeIds:['type-file']}),{code:'invalid_document_response'});
 await pin.close();await assert.rejects(()=>pin.tasks!({typeIds:['type-file']}),{code:'snapshot_expired'});await binding.release();
});
test('main-process admitted Tasks reports remain bound to the original pin',async()=>{
 let reply:any={pinId:'1',snapshot,source,coverageComplete:true};const controller=createDesktopDocumentSemantics({documentCommand:async()=>reply},'client','store');await controller.invoke({schemaVersion:1,command:{op:'open',pinId:'1'}});
 reply=result();await controller.invoke(request());reply={...result(),snapshot:{...snapshot,generationEpoch:'wrong'}};await assert.rejects(controller.invoke(request()),{code:'invalid_document_response'});
});
