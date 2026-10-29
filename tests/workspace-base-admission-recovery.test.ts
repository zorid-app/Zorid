import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import {DocumentSemanticsError} from '../src/core/document-semantics.ts';
import type {DatabaseRequest} from '../src/core/databases.ts';
import type {PlatformVault} from '../src/platform/index.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import type {EditorHandle} from '../src/ui/editor.ts';

const collectionId='abcdefghijkl',propertyId='mnopqrstuvwx';
const baseSource=JSON.stringify({views:[{id:'aaaaaaaaaaaa',type:'table',name:'Recovery table',source:{kind:'collection',id:collectionId},order:['file.name',`note.${propertyId}`]}]});
function gate(){let resolve!:()=>void,settled=false;const promise=new Promise<void>(done=>{resolve=()=>{settled=true;done();};});return{promise,resolve,get settled(){return settled;}};}
async function until(predicate:()=>boolean,message='expected mounted Workspace transition'){for(let index=0;index<300&&!predicate();index++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate(),message);}
async function fixture(t:test.TestContext,propertyNote=false){
 const dom=new JSDOM('<!doctype html><main></main>',{url:'https://lifecycle.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const scope={vaultId:'lifecycle-store',clientId:'lifecycle-client'},records=new Map([['One.md',{path:'One.md',entryId:'one',revision:'source-1',content:'Original note',stat:{ctime:1,mtime:1,size:13}}],['Two.md',{path:'Two.md',entryId:'two',revision:'source-two',content:'Second original',stat:{ctime:1,mtime:1,size:15}}]]),heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>();
 records.set('Recovery.base',{path:'Recovery.base',entryId:'recovery-base',revision:'base-1',content:baseSource,stat:{ctime:1,mtime:1,size:baseSource.length}});
 if(propertyNote){const one=records.get('One.md')!;one.content='---\n_id: one\n_type: Recovery collection\nRating: 1\n---\nOriginal note';one.stat.size=one.content.length;}
 const collection={id:collectionId,name:'Recovery collection',revision:'schema-1',deleted:false,properties:[{id:propertyId,name:'Rating',datatype:'number',options:[]}]};
 let member={entryId:'one',collectionId,revision:'entry-1',fileRevision:'source-1',path:'One.md',values:{[propertyId]:1},deleted:false,pendingProjection:false};
 const databaseRequests:{admission:string;command:DatabaseRequest}[]=[],applied=new Map<string,unknown>(),oldAcknowledgment=gate();let withholdDatabaseAck=false,failHeldDatabaseAck=true;
 const changes=new Set<(change:{vault:string;path?:string})=>void>(),notices:string[]=[],repairErrors:string[]=[];let interceptRead:(()=>Promise<void>)|undefined;let interceptDatabase:((admission:string,command:DatabaseRequest)=>Promise<void>)|undefined,baseNotReady=false;
 const noticeObserver=new dom.window.MutationObserver(()=>{for(const node of document.querySelectorAll('.notice'))if(!notices.includes(node.textContent??''))notices.push(node.textContent??'');for(const node of document.querySelectorAll('.bases-session [data-base-editing].mod-error,.bases-session [aria-invalid="true"],.bases-session-status')){const value=node.textContent??'';if((node.matches('[aria-invalid="true"],[data-base-editing].mod-error')||/failed|error|reconnect|retry|no longer|unavailable/i.test(value))&&!repairErrors.includes(value))repairErrors.push(value);}});noticeObserver.observe(document.body,{childList:true,subtree:true});
 const receivers:{id:string;retire:()=>void;stopped:boolean}[]=[];let recoveryGate:Promise<void>|undefined;let recoveryFailureCode:string|undefined;let storageLost=false,recoveries=0,failedRecoveries=0,failedRecoveredLists=0,replayCheck:((input:any)=>void)|undefined;
 let context:string|null=null,admissions=0,releases=0,pickers=0,failedGets=0,releaseGate:Promise<void>|undefined,closeHandler:(()=>Promise<void>)|undefined;
 const calls:{admission:string;method:string;args:any[]}[]=[],metadata=()=>[...records.values()].map(row=>({path:row.path,type:'file',entryId:row.entryId,revision:row.revision,...row.stat}));
 const bridge={getWindowInfo:async()=>({id:'main',initialState:'restore'}),getVault:async()=>{if(failedGets-->0)throw Error('Temporary reconnect failure');return{path:'/lifecycle-fixture',name:'Lifecycle'};},
 getDurableContext:async()=>{context??='admission-'+(++admissions);return{admissionId:context,scope,databases:true};},
 releaseDurableContext:async(_root:string,admission:string)=>{releases++;await releaseGate;if(context===admission)context=null;},
 recoverDurableContext:async(_root:string,prior:string)=>{recoveries++;await recoveryGate;if(failedRecoveries-->0)throw Object.assign(Error('Temporary recovery failure'),recoveryFailureCode?{code:recoveryFailureCode}:{});assert.equal(prior,context);context='admission-'+(++admissions);storageLost=false;return{admissionId:context,scope,databases:true};},
 onDocumentRuntimeNudge:(_root:string,id:string,_listener:()=>void,retire:()=>void)=>{const receiver={id,retire,stopped:false};receivers.push(receiver);return()=>{receiver.stopped=true;};},
 openVault:async()=>{pickers++;return null;},onChange:(listener:(change:{vault:string;path?:string})=>void)=>{changes.add(listener);return()=>{changes.delete(listener);};},onBeforeClose:(handler:()=>Promise<void>)=>{closeHandler=handler;return()=>{};},dismissContextMenu:async()=>{},
 list:async()=>{if(context!=='admission-1'&&failedRecoveredLists-->0)throw Error('Temporary fresh inventory failure');return metadata();},stat:async(_root:string,path:string)=>metadata().find(row=>row.path===path)??null,read:async(_root:string,path:string)=>records.get(path)!.content,
 durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
  calls.push({admission,method,args:structuredClone(args)});assert.equal(admission,context,'retired adapter must not receive work');
  if(method==='databaseCommand'){
   const command=args[0].command as DatabaseRequest;await interceptDatabase?.(admission,command);databaseRequests.push({admission,command:structuredClone(command)});
   if(command.op==='set_entry'){
    if(!applied.has(command.operationId)){assert.equal(command.expectedRevision,member.revision);assert.equal(command.expectedCollectionRevision,collection.revision);member={...member,revision:'entry-saved',values:{...member.values,...command.values} as Record<string,number>};if(propertyNote){const one=records.get(member.path)!;one.content=one.content.replace(/Rating: .*/,`Rating: ${member.values[propertyId]}`);one.revision+='-projected';one.stat.size=one.content.length;member.fileRevision=one.revision;}applied.set(command.operationId,structuredClone(member));}
    if(withholdDatabaseAck&&admission==='admission-1'){withholdDatabaseAck=false;await oldAcknowledgment.promise;if(failHeldDatabaseAck)return{databases:true,schemaVersion:1,ok:false,error:{code:'host_exited',source:'host',commitUncertain:true}};}
   }
   return{databases:true,schemaVersion:1,ok:true,value:{collections:[collection],entries:[member],projection:{pending:0,issues:[]}}};
  }
  if(storageLost)throw Error('Durable editor request failed; retain pending recovery state.');
  const input=args[0],record=()=>[...records.values()].find(row=>row.entryId===(typeof input==='string'?input:input?.expectedEntryId))!;
  if(method==='fileCommand'){assert.equal(input.kind,'move');const row=records.get(input.path)!;assert.ok(row);if(input.expectedEntryId)assert.equal(input.expectedEntryId,row.entryId);if(input.expectedRevision)assert.equal(input.expectedRevision,row.revision);records.delete(input.path);row.path=input.destination;records.set(row.path,row);member={...member,path:row.path};return;}
  if(method==='readText')return structuredClone(records.get(input)??null);
  if(method==='composeNote'){const current=structuredClone(records.get(input.path)!);assert.equal(current.entryId,input.entryId);return{current,content:current.content};}
  if(method==='readTextById'){await interceptRead?.();return structuredClone(record()??null);}
  if(method==='checkpoints.load')return structuredClone(heads.get(input)??null);
  if(method==='checkpoints.list')return{items:[...heads.values()].map(({encodedState,...row})=>row),cursor:null,highWater:String(heads.size)};
  if(method==='checkpoints.changes')return{items:[],cursor:null,highWater:String(heads.size)};
  if(method==='checkpoints.compareAndSwap'){replayCheck?.(input);const prior=heads.get(input.key);assert.equal(input.expectedRevision,prior?.revision??null);const next={version:1,...scope,key:input.key,revision:input.nextRevision,encodedState:input.encodedState,deleted:false,sequence:String(heads.size+1),byteLength:input.encodedState.length};heads.set(input.key,next);return structuredClone(next);}
  if(method==='planWrite'){plans.set(input.operationId,structuredClone(input));return{notePlanning:true,schemaVersion:1,ok:true,value:{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)}};}
  if(method==='prepare'){const ref={...scope,entryId:input.entryId,operationId:input.operationId,token:input.operationId};const intent={ref,state:'prepared',acknowledged:false};intents.set(ref.token,intent);return structuredClone(intent);}
  if(method==='query')return structuredClone(intents.get(input.token));
  if(method==='commit'){const plan=plans.get(input.operationId),row=records.get(plan.path)!;assert.equal(row.revision,plan.expectedRevision);row.content=plan.content;row.revision+='-saved';row.stat.size=row.content.length;const intent={ref:input,state:'committed',acknowledged:false,receipt:{operationId:input.operationId,entryId:input.entryId,revision:row.revision,sequence:'2'}};intents.set(input.token,intent);return structuredClone(intent);}
  if(method==='listUnacknowledged')return[];
  if(method==='acknowledge')return;
  throw Error('Unexpected durable method '+method);
 }};
 Object.assign(dom.window,{zorid:bridge});
 const root=document.querySelector<HTMLElement>('main')!,workspace=new Workspace(root,(host,options):EditorHandle=>{const input=document.createElement('textarea');input.value=options.value;input.oninput=()=>options.onChange(input.value);host.append(input);return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus(){},destroy(){input.remove();},insert:text=>{input.value+=text;options.onChange(input.value);}};});
 const snapshot={localStoreId:scope.vaultId,generationEpoch:'fixture-epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:scope.vaultId,watermark:'1'};
 const unused=async():Promise<never>=>{throw Error('Unexpected document effect');};
 const documents=():DocumentService=>({status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'fixture-pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async(id:string)=>{const row=[...records.values()].find(row=>row.entryId===id)!;return{source,snapshot,coverageComplete:true,value:{entry:{id,revision:row.revision,path:row.path,kind:'file',deleted:false},metadata:null,exclusion:null}};},
   base:async()=>{if(baseNotReady&&context!=='admission-1')throw new DocumentSemanticsError('not_ready');return({source,snapshot,coverageComplete:true,value:{definition:{id:'recovery-base',revision:records.get('Recovery.base')!.revision,path:'Recovery.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(baseSource).views[0],rows:[{entryId:'one',revision:records.get('One.md')!.revision,path:'One.md',values:{'file.name':{type:'string',value:'One'},[`note.${propertyId}`]:{type:'number',value:member.values[propertyId]}},editValues:{}}],groups:[{key:null,keyId:null,entryIds:['one']}],groupOptions:[],properties:['file.name',`note.${propertyId}`],availableProperties:['file.name',`note.${propertyId}`],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}});}})} as unknown as DocumentService);
 const decorate=(native:PlatformVault):PlatformVault=>({...native,adapter:{...native.adapter,documentSemantics:documents()},...(native.recovery?{recovery:{subscribe:listener=>native.recovery!.subscribe(listener),containsCapturedSetEntry:command=>native.recovery!.containsCapturedSetEntry(command),holdCapturedSetEntry:command=>native.recovery!.holdCapturedSetEntry(command),claimCapturedSetEntry:command=>native.recovery!.claimCapturedSetEntry(command),recover:async()=>decorate(await native.recovery!.recover())}}:{})});
 t.after(async()=>{oldAcknowledgment.resolve();releaseGate=undefined;failedGets=0;try{await workspace.destroy();}finally{await Promise.allSettled([...workspace.buffers.values()].map(buffer=>buffer.dispose()));noticeObserver.disconnect();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 await workspace.start(decorate((await createPlatformAdapter())!));await workspace.openNote('Recovery.base');
 try{await until(()=>!!root.querySelector(`[role="gridcell"][data-property="note.${propertyId}"]`));}catch{throw Error(JSON.stringify({state:workspace.activePane.baseView?.state,dom:root.textContent,requests:databaseRequests}));}


 return{databaseRequests,applied,member:()=>member,changeMemberValue(value:number){member={...member,values:{[propertyId]:value}};},withholdDatabaseAck(fail=true){withholdDatabaseAck=true;failHeldDatabaseAck=fail;},releaseOldAck(){oldAcknowledgment.resolve();},workspace,internal:workspace as any,root,records,heads,plans,calls,bridge,notices,repairErrors,interceptRead(check:()=>Promise<void>){interceptRead=check;},interceptDatabase(check:(admission:string,command:DatabaseRequest)=>Promise<void>){interceptDatabase=check;},setBaseNotReady(value:boolean){baseNotReady=value;},change(path?:string){for(const listener of [...changes])listener({vault:'/lifecycle-fixture',...(path?{path}:{})});},get admissions(){return admissions;},get releases(){return releases;},get pickers(){return pickers;},get recoveries(){return recoveries;},holdRecovery(promise:Promise<void>){recoveryGate=promise;},loseStorage(){storageLost=true;},signalRetirement(){const retiring=context;for(const receiver of [...receivers])if(receiver.id===retiring&&!receiver.stopped)receiver.retire();},failRecovery(times:number,code?:string){failedRecoveries=times;recoveryFailureCode=code;},failRecoveredLists(times:number){failedRecoveredLists=times;},observeReplay(check:(input:any)=>void){replayCheck=check;},failReconnect(times=1){failedGets=times;},holdRelease(promise:Promise<void>){releaseGate=promise;},close:()=>closeHandler!(),type(text:string){const input=root.querySelector<HTMLTextAreaElement>('.pane.is-active textarea')!;assert.ok(input,JSON.stringify({message:'fresh editor present',content:root.parentElement?.textContent,admissions,releases,initialized:(workspace as any).initialized,closing:(workspace as any).closing,released:(workspace as any).platformReleased,drained:(workspace as any).platformDrained}));input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}};
}

function key(node:Element,value:string){node.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));}
function ratingDraft(root:HTMLElement,value:string){const cell=root.querySelector(`[role="gridcell"][data-property="note.${propertyId}"]`)!;assert.ok(cell,'collection Rating cell is mounted');key(cell,'Enter');const input=cell.querySelector<HTMLInputElement>('input')!;assert.ok(input,'Rating widget is editable');input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));return input;}
function editRating(root:HTMLElement,value:string){const input=ratingDraft(root,value);key(input,'Enter');return input;}

test('Workspace recovers an accepted collection edit with the same operation and retained widget before replacing its Base',async t=>{
 const f=await fixture(t),old=f.workspace.platform,session=f.workspace.activePane.baseView!,recover=gate();f.withholdDatabaseAck();const input=editRating(f.root,'9');
 await until(()=>f.databaseRequests.some(call=>call.command.op==='set_entry'));const original=f.databaseRequests.find(call=>call.command.op==='set_entry')!.command;assert.equal(f.member().values[propertyId],9);f.holdRecovery(recover.promise);f.signalRetirement();
 try{
  await until(()=>f.recoveries===1,'a captured accepted Base request must allow automatic backend recovery');assert.equal(f.workspace.activePane.baseView,session);assert.equal(input.isConnected,true);assert.equal(input.value,'9');assert.deepEqual(f.notices,[]);
  recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  const mutations=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(mutations.length,2);assert.deepEqual(mutations[1].command,original);assert.equal(mutations[1].admission,'admission-2');assert.equal(f.applied.size,1);assert.deepEqual(f.notices,[]);assert.equal(f.member().values[propertyId],9);assert.notEqual(f.root.inert,true);
 }finally{recover.resolve();f.releaseOldAck();}
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.notices,[],'the late old transport failure cannot change the freshly acknowledged widget');assert.equal(f.member().values[propertyId],9);
});

test('a clean cached Base receives a fresh database service after another note recovers',async t=>{
 const f=await fixture(t),old=f.workspace.platform,oldSession=f.workspace.activePane.baseView!;await f.workspace.openNote('One.md',true);f.loseStorage();f.type('Latest note beside the cached Base');await new Promise(resolve=>setImmediate(resolve));f.signalRetirement();
 await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);await f.workspace.openNote('Recovery.base');await until(()=>!!f.root.querySelector(`[role="gridcell"][data-property="note.${propertyId}"]`));assert.notEqual(f.workspace.activePane.baseView,oldSession);
 const input=editRating(f.root,'9');await until(()=>!input.isConnected);await f.workspace.flush();
 const mutations=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(mutations.length,1);assert.equal(mutations[0].admission,'admission-2');assert.equal(f.member().values[propertyId],9);assert.equal(f.records.get('One.md')!.content,'Latest note beside the cached Base');assert.deepEqual(f.notices,[]);assert.notEqual(f.root.inert,true);
});

test('an unsubmitted Base cell automatically survives a healthy host restart without submitting its raw value',async t=>{
 const f=await fixture(t),old=f.workspace.platform,session=f.workspace.activePane.baseView!,input=ratingDraft(f.root,'9.'),recover=gate();input.setSelectionRange(1,2,'backward');f.holdRecovery(recover.promise);f.signalRetirement();
 try{
  await until(()=>f.recoveries===1,'raw input must allow automatic host recovery');
  input.dispatchEvent(new window.FocusEvent('blur'));assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0,'freezing does not submit through blur');
  recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  assert.notEqual(f.workspace.activePane.baseView,session);const fresh=f.root.querySelector<HTMLInputElement>(`[data-property="note.${propertyId}"] input`)!;assert.ok(fresh,'fresh owner restores the raw editor');assert.equal(fresh.value,'9.');assert.equal(fresh.selectionStart,1);assert.equal(fresh.selectionEnd,2);assert.equal(fresh.selectionDirection,'backward');
  assert.equal(f.member().values[propertyId],1);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.deepEqual(f.notices,[]);assert.notEqual(f.root.inert,true);assert.equal(f.root.parentElement?.querySelector('.workspace-reconnect-recovery'),null);
  input.value='77';key(input,'Enter');input.dispatchEvent(new window.FocusEvent('blur'));assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0,'late old events cannot submit');
  fresh.value='9';fresh.dispatchEvent(new window.Event('input',{bubbles:true}));key(fresh,'Enter');await until(()=>f.member().values[propertyId]===9);
  const writes=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(writes.length,1);assert.equal(writes[0].admission,'admission-2');assert.equal(f.applied.size,1);
 }finally{recover.resolve();const mounted=f.root.querySelector<HTMLInputElement>('[data-base-editing] input');if(mounted)key(mounted,'Escape');}
});

test('a verified collection acknowledgment survives an old follow-up inventory failure without replaying the mutation',async t=>{
 const f=await fixture(t),old=f.workspace.platform,list=f.bridge.list,entered=gate(),finish=gate(),recover=gate();let hold=true;
 f.bridge.list=async()=>{if(hold&&f.applied.size){hold=false;entered.resolve();await finish.promise;throw Error('Old follow-up inventory failed');}return list();};
 const input=editRating(f.root,'9');await until(()=>entered.settled);assert.equal(f.member().values[propertyId],9);f.holdRecovery(recover.promise);f.signalRetirement();
 try{
  await until(()=>f.recoveries===1);assert.equal(input.isConnected,true);assert.deepEqual(f.notices,[]);recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,1,'verified native success needs no mutation replay');assert.equal(f.applied.size,1);assert.equal(f.member().values[propertyId],9);assert.deepEqual(f.notices,[]);assert.notEqual(f.root.inert,true);
 }finally{finish.resolve();recover.resolve();}
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.notices,[],'the late retired follow-up failure cannot report a failed save');
});

test('a verified collection acknowledgment remains recoverable after its ordinary follow-up read already rejected',async t=>{
 const f=await fixture(t),old=f.workspace.platform,list=f.bridge.list;let fail=true;
 f.bridge.list=async()=>{if(fail&&f.applied.size){fail=false;throw Error('Ordinary follow-up read failed');}return list();};const input=editRating(f.root,'9');await until(()=>f.notices.length>0);assert.equal(input.isConnected,true);assert.equal(input.value,'9');const reported=[...f.notices];f.signalRetirement();
 await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,1);assert.equal(f.applied.size,1);assert.equal(f.member().values[propertyId],9);assert.deepEqual(f.notices,reported,'recovery adds no failure after the earlier ordinary read error');assert.notEqual(f.root.inert,true);
});

for(const transition of ['choose','close'] as const)test(`retirement interrupts only the reversible ${transition} preflight waiting on an accepted Base edit`,async t=>{
 const f=await fixture(t),old=f.workspace.platform,recover=gate(),watcherEntered=gate(),watcherFinish=gate(),list=f.bridge.list;let holdWatcher=transition==='choose';
 f.bridge.list=async()=>{if(holdWatcher){holdWatcher=false;watcherEntered.resolve();await watcherFinish.promise;throw Error('Old watcher inventory retired');}return list();};
 f.withholdDatabaseAck();editRating(f.root,'9');await until(()=>f.applied.size===1);if(transition==='choose'){f.change();await until(()=>watcherEntered.settled);}
 let finished=false;const operation=transition==='choose'?f.workspace.chooseVault():f.close();const outcome=operation.then(()=>{finished=true;return{ok:true as const};},error=>{finished=true;return{ok:false as const,error};});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false,'ordinary pending save keeps the preflight waiting');f.holdRecovery(recover.promise);f.signalRetirement();watcherFinish.resolve();
 try{await until(()=>f.recoveries===1,'retirement must break the preflight/recovery wait cycle');recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const result=await outcome;if(transition==='choose')assert.equal(result.ok,true);else{assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'workspace_admission_retired');}assert.equal(f.pickers,0);assert.equal(f.member().values[propertyId],9);assert.equal(f.applied.size,1);assert.deepEqual(f.notices,[]);assert.deepEqual(f.repairErrors,[],'interrupted recovery must not render an inline Base failure');assert.equal(f.internal.closing,false);assert.notEqual(f.root.inert,true);}
 finally{watcherFinish.resolve();recover.resolve();f.releaseOldAck();if(!finished)await old.recovery!.recover().catch(()=>{});await outcome;await new Promise(resolve=>setImmediate(resolve));await until(()=>!f.internal.lifecycleRecovery);}
});

test('ordinary native close keeps waiting for an accepted Base save and succeeds without retirement',async t=>{
 const f=await fixture(t);f.withholdDatabaseAck(false);editRating(f.root,'9');await until(()=>f.applied.size===1);let finished=false;const closing=f.close().then(()=>{finished=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(f.recoveries,0);
 f.releaseOldAck();await closing;assert.equal(finished,true);assert.equal(f.member().values[propertyId],9);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,1);assert.equal(f.recoveries,0);assert.deepEqual(f.notices,[]);
});

for(const transition of ['choose','close'] as const)test(`a typed host failure before any hint completes the ${transition} retirement handoff without a visible edit failure`,async t=>{
 const f=await fixture(t),old=f.workspace.platform,recover=gate();f.withholdDatabaseAck();editRating(f.root,'9');await until(()=>f.applied.size===1);const original=f.databaseRequests.find(call=>call.command.op==='set_entry')!.command;
 let finished=false;const operation=transition==='choose'?f.workspace.chooseVault():f.close(),outcome=operation.then(()=>{finished=true;return{ok:true as const};},error=>{finished=true;return{ok:false as const,error};});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);f.holdRecovery(recover.promise);f.releaseOldAck();
 try{
  await until(()=>f.recoveries===1,'the typed error itself must initiate the owned retirement handoff');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.notices,[]);assert.deepEqual(f.repairErrors,[],'the first failure notification already belongs to automatic repair');
  recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const result=await outcome;if(transition==='choose')assert.equal(result.ok,true);else{assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'workspace_admission_retired');}
  const requests=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(requests.length,2);assert.deepEqual(requests[1].command,original);assert.equal(requests[1].admission,'admission-2');assert.equal(f.applied.size,1);assert.equal(f.member().values[propertyId],9);assert.equal(f.pickers,0);assert.deepEqual(f.notices,[]);assert.deepEqual(f.repairErrors,[]);assert.equal(f.internal.closing,false);assert.notEqual(f.root.inert,true);
 }finally{recover.resolve();f.releaseOldAck();if(!finished)await old.recovery!.recover().catch(()=>{});await outcome;await new Promise(resolve=>setImmediate(resolve));await until(()=>!f.internal.lifecycleRecovery);}
});

 test('a typed transient host failure automatically resumes admission recovery after bounded backoff',async t=>{
  const f=await fixture(t),old=f.workspace.platform;f.failRecovery(3,'host_exited');f.signalRetirement();
  const deadline=Date.now()+2200;while(f.workspace.platform===old&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.notEqual(f.workspace.platform,old,'healthy replacement resumes without clicking Reconnect');await until(()=>!f.internal.lifecycleRecovery);assert.equal(f.recoveries,4);assert.equal(f.root.parentElement?.querySelector('.workspace-reconnect-recovery'),null);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.deepEqual(f.notices,[]);
 });
 test('a changed recovery authority is not retried by the transient supervisor',async t=>{
  const f=await fixture(t);f.failRecovery(30,'durable_recovery_scope_changed');f.signalRetirement();await until(()=>!!f.root.parentElement?.querySelector('.workspace-reconnect-recovery'));await new Promise(resolve=>setTimeout(resolve,650));assert.equal(f.recoveries,3);
  f.failRecovery(0);const retry=[...f.root.parentElement!.querySelectorAll<HTMLButtonElement>('.workspace-reconnect-recovery button')].find(button=>button.textContent==='Reconnect notes');retry?.click();await until(()=>!f.internal.lifecycleRecovery&&f.admissions===2);
 });

 test('a changed Base property keeps its exact raw candidate accessible after automatic recovery',async t=>{
  const f=await fixture(t),old=f.workspace.platform,recover=gate(),input=ratingDraft(f.root,'9.');f.holdRecovery(recover.promise);f.signalRetirement();
  try{await until(()=>f.recoveries===1);f.changeMemberValue(4);recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
   const raw=f.root.parentElement?.querySelector<HTMLTextAreaElement>('.workspace-retained-inputs textarea');assert.equal(raw?.value,'9.');assert.match(f.root.parentElement?.querySelector('.workspace-retained-inputs')?.textContent??'',/changed|retained|kept/);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.equal(f.member().values[propertyId],4);assert.notEqual(f.root.inert,true);assert.equal(input.isConnected,false);
  }finally{recover.resolve();}
 });
 test('a raw note title survives a fresh admission and only a later explicit Enter renames',async t=>{
  const f=await fixture(t);await f.workspace.openNote('One.md');const old=f.workspace.platform,input=f.root.querySelector<HTMLInputElement>('.note-title')!;input.focus();input.value='Unsubmitted title';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));input.setSelectionRange(2,7,'backward');f.signalRetirement();
  await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const fresh=f.root.querySelector<HTMLInputElement>('.note-title')!;assert.equal(fresh.value,'Unsubmitted title');assert.equal(fresh.selectionStart,2);assert.equal(fresh.selectionEnd,7);assert.equal(fresh.selectionDirection,'backward');assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,0);assert.equal(f.records.has('One.md'),true);
  input.dispatchEvent(new window.FocusEvent('blur'));key(input,'Enter');assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,0);key(fresh,'Enter');await until(()=>f.records.has('Unsubmitted title.md'));assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,1);assert.equal(f.calls.find(call=>call.method==='fileCommand')!.admission,'admission-2');assert.deepEqual(f.notices,[]);
 });
 test('managed note properties retain raw invalid text through fresh-schema admission without an automatic write',async t=>{
  const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const old=f.workspace.platform,field=f.root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();const input=field.querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value='9.';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));input.setSelectionRange(1,2,'backward');const original=f.records.get('One.md')!.content;f.signalRetirement();
  await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const fresh=f.root.querySelector<HTMLInputElement>('[data-property-key="Rating"] .metadata-property-value input')!;assert.ok(fresh,'fresh managed widget restores only after fresh membership/schema');assert.equal(fresh.value,'9.');assert.equal(fresh.selectionStart,1);assert.equal(fresh.selectionEnd,2);assert.equal(f.records.get('One.md')!.content,original);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.deepEqual(f.notices,[]);
  input.dispatchEvent(new window.FocusEvent('blur'));key(input,'Enter');fresh.value='9';fresh.dispatchEvent(new window.InputEvent('input',{bubbles:true}));key(fresh,'Enter');await until(()=>f.member().values[propertyId]===9);await until(()=>f.records.get('One.md')!.content.includes('Rating: 9'));assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,1);assert.equal(f.databaseRequests.find(call=>call.command.op==='set_entry')!.admission,'admission-2');assert.ok(f.records.get('One.md')!.content.endsWith('Original note'));try{await until(()=>!f.workspace.activePane.properties!.hasPendingChanges());}catch{assert.fail(JSON.stringify({notices:f.notices,dom:f.root.querySelector('.properties-host')?.innerHTML,calls:f.calls.slice(-8)}));}
 });
 test('raw Base custody is captured once across transient recovery attempts',async t=>{
  const f=await fixture(t),old=f.workspace.platform;ratingDraft(f.root,'9.');f.failRecovery(3,'host_exited');f.signalRetirement();const deadline=Date.now()+2200;while(f.workspace.platform===old&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  const inputs=f.root.querySelectorAll<HTMLInputElement>(`[data-property="note.${propertyId}"] input`);assert.equal(inputs.length,1);assert.equal(inputs[0].value,'9.');assert.equal(f.internal.retainedAdmissionRawInputs.length,0);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);key(inputs[0],'Escape');
 });

 for(const transition of ['choose','close'] as const)test(`a failed ${transition} preflight resumes the owned automatic reconnect timer`,async t=>{
  const f=await fixture(t),old=f.workspace.platform;f.failRecovery(3,'host_exited');f.signalRetirement();await until(()=>!!f.root.parentElement?.querySelector('.workspace-reconnect-recovery'));assert.equal(f.recoveries,3);
  if(transition==='choose')await f.workspace.chooseVault();else await assert.rejects(f.close(),error=>(error as {code?:string}).code==='workspace_admission_retired');
  const deadline=Date.now()+2200;while(f.workspace.platform===old&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(f.recoveries,4);assert.equal(f.pickers,0);assert.notEqual(f.root.inert,true);assert.deepEqual(f.notices,[]);
 });
 test('a direct Base raw draft automatically attaches when its fresh saved publication becomes ready',async t=>{
  const f=await fixture(t),old=f.workspace.platform;ratingDraft(f.root,'9.');f.setBaseNotReady(true);f.signalRetirement();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(f.internal.retainedAdmissionRawInputs.length,1);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);
  f.setBaseNotReady(false);f.records.get('Recovery.base')!.revision='base-publication-2';f.change('Recovery.base');await until(()=>!!f.root.querySelector(`[data-property="note.${propertyId}"] input`),'publication restores the pending raw draft without an explicit refresh');const input=f.root.querySelector<HTMLInputElement>(`[data-property="note.${propertyId}"] input`)!;assert.equal(input.value,'9.');assert.equal(f.internal.retainedAdmissionRawInputs.length,0);key(input,'Escape');
 });
 test('an unattached raw draft keeps its exact tab lineage across a second host restart',async t=>{
  const f=await fixture(t);ratingDraft(f.root,'9.');f.setBaseNotReady(true);f.signalRetirement();await until(()=>f.admissions===2&&!f.internal.lifecycleRecovery);const firstFresh=f.workspace.platform;f.signalRetirement();await until(()=>f.workspace.platform!==firstFresh&&f.admissions===3&&!f.internal.lifecycleRecovery);assert.equal(f.internal.retainedAdmissionRawInputs.length,1);
  f.setBaseNotReady(false);f.records.get('Recovery.base')!.revision='base-publication-3';f.change('Recovery.base');await until(()=>!!f.root.querySelector(`[data-property="note.${propertyId}"] input`));const input=f.root.querySelector<HTMLInputElement>(`[data-property="note.${propertyId}"] input`)!;assert.equal(input.value,'9.');assert.equal(f.internal.retainedAdmissionRawInputs.length,0);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);key(input,'Escape');
 });
 test('a managed rich property conflict displays its raw candidate after automatic recovery',async t=>{
  const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const field=f.root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();const input=field.querySelector<HTMLInputElement>('input')!;input.value='9.';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));const old=f.workspace.platform,recover=gate();f.holdRecovery(recover.promise);f.signalRetirement();
  try{await until(()=>f.recoveries===1);const row=f.records.get('One.md')!;row.content=row.content.replace('Rating: 1','Rating: 4');row.revision='source-changed';f.changeMemberValue(4);f.member().fileRevision=row.revision;recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(f.root.parentElement?.querySelector<HTMLTextAreaElement>('.workspace-retained-inputs textarea')?.value,'9.');assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.notEqual(f.root.inert,true);}
  finally{recover.resolve();}
 });

 test('a second host retirement while fresh managed-schema restoration is held receives its own repair',async t=>{
  const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const field=f.root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();const input=field.querySelector<HTMLInputElement>('input')!;input.value='9.';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));const entered=gate(),finish=gate();let hold=true;
  f.interceptDatabase(async(admission,command)=>{if(hold&&admission==='admission-2'&&command.op==='get_entry'){hold=false;entered.resolve();await finish.promise;}});f.signalRetirement();
  try{await until(()=>entered.settled&&f.admissions===2);f.signalRetirement();finish.resolve();await until(()=>f.admissions===3&&!f.internal.lifecycleRecovery);const fresh=f.root.querySelector<HTMLInputElement>('[data-property-key="Rating"] .metadata-property-value input')!;assert.ok(fresh);assert.equal(fresh.value,'9.');assert.equal(f.internal.retainedAdmissionRawInputs.length,0);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.equal(f.recoveries,2);assert.deepEqual(f.notices,[]);key(fresh,'Escape');}
  finally{finish.resolve();}
 });
 for(const kind of ['title','properties'] as const)test(`a same-path replacement cannot adopt the old ${kind} raw draft`,async t=>{
  const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);let input:HTMLInputElement;
  if(kind==='title'){input=f.root.querySelector<HTMLInputElement>('.note-title')!;input.value='Raw actor A title';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));}
  else{const field=f.root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();input=field.querySelector<HTMLInputElement>('input')!;input.value='9.';input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));}
  const old=f.workspace.platform,row=f.records.get('One.md')!;row.entryId='replacement-B';f.member().entryId=row.entryId;const namespace=f.workspace.vault.entries.get('One.md')!;namespace.entryId=row.entryId;f.signalRetirement();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  const raw=f.root.parentElement?.querySelector<HTMLTextAreaElement>('.workspace-retained-inputs textarea');assert.equal(raw?.value,kind==='title'?'Raw actor A title':'9.');assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,0);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.equal(f.root.parentElement?.querySelector('.workspace-reconnect-recovery'),null);assert.notEqual(f.root.inert,true);
 });

 test('raw IME waits for its real final input and blocks document-level commands before root inert',async t=>{
  const f=await fixture(t),old=f.workspace.platform,input=ratingDraft(f.root,'9'),tabs=f.workspace.activePane.tabs.length;input.focus();input.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true,data:''}));input.value='9中';input.dispatchEvent(new window.CompositionEvent('compositionupdate',{bubbles:true,data:'中'}));input.dispatchEvent(new window.InputEvent('input',{bubbles:true,data:'中',isComposing:true,inputType:'insertCompositionText'}));f.signalRetirement();await until(()=>!!f.internal.lifecycleRecovery);assert.equal(f.recoveries,1);assert.equal(input.isConnected,true);
  document.body.dispatchEvent(new window.KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true,cancelable:true}));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.workspace.activePane.tabs.length,tabs);assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,0);
  input.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'中文'}));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.workspace.platform,old,'compositionend alone cannot replace the control before a delayed final input');assert.equal(input.isConnected,true);
  input.value='9中文';input.dispatchEvent(new window.InputEvent('input',{bubbles:true,data:'中文',isComposing:false,inputType:'insertText'}));await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const fresh=f.root.querySelector<HTMLInputElement>(`[data-property="note.${propertyId}"] input`)!;assert.equal(fresh.value,'9中文');assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,0);assert.equal(f.calls.filter(call=>call.method==='fileCommand').length,0);key(fresh,'Escape');
 });
 test('retained conflict candidate DOM is removed on a different vault and on destroy',async t=>{
  const f=await fixture(t),old=f.workspace.platform,recover=gate();ratingDraft(f.root,'9.');f.holdRecovery(recover.promise);f.signalRetirement();try{await until(()=>f.recoveries===1);f.changeMemberValue(4);recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.ok(f.root.parentElement?.querySelector('.workspace-retained-inputs'));
   await f.workspace.openVault({adapter:new MemoryAdapter({'Other.md':'Other vault text'}),id:'other-vault',label:'Other'});assert.equal(f.root.parentElement?.querySelector('.workspace-retained-inputs'),null);await f.workspace.destroy();assert.equal(f.root.parentElement?.querySelector('.workspace-retained-inputs'),null);
  }finally{recover.resolve();}
 });
