import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {Workspace} from '../src/ui/workspace.ts';
import {BaseDocument,baseViewSetting} from '../src/bases/document.ts';
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
async function fixture(t:test.TestContext,propertyNote=false,omitNamespaceIdentity=false,guardedSettings=false,initialFilter?:string,secondaryView=false){
 const dom=new JSDOM('<!doctype html><main></main>',{url:'https://lifecycle.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const scope={vaultId:'lifecycle-store',clientId:'lifecycle-client'},records=new Map([['One.md',{path:'One.md',entryId:'one',revision:'source-1',content:'Original note',stat:{ctime:1,mtime:1,size:13}}],['Two.md',{path:'Two.md',entryId:'two',revision:'source-two',content:'Second original',stat:{ctime:1,mtime:1,size:15}}]]),heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>();
 records.set('Recovery.base',{path:'Recovery.base',entryId:'recovery-base',revision:'base-1',content:baseSource,stat:{ctime:1,mtime:1,size:baseSource.length}});
 if(initialFilter!==undefined){const saved=records.get('Recovery.base')!;saved.content=JSON.stringify({...JSON.parse(baseSource),views:[{...JSON.parse(baseSource).views[0],filters:initialFilter}]});saved.stat.size=saved.content.length;Object.defineProperty(dom.window.Range.prototype,'getClientRects',{configurable:true,value:()=>[]});Object.defineProperty(dom.window.Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0})});}
 if(secondaryView){const saved=records.get('Recovery.base')!,config=JSON.parse(saved.content);config.views.push({...config.views[0],id:'bbbbbbbbbbbb',name:'Second view'});saved.content=JSON.stringify(config);saved.stat.size=saved.content.length;}
 if(propertyNote){const one=records.get('One.md')!;one.content='---\n_id: one\n_type: Recovery collection\nRating: 1\n---\nOriginal note';one.stat.size=one.content.length;}
 const collection={id:collectionId,name:'Recovery collection',revision:'schema-1',deleted:false,properties:[{id:propertyId,name:'Rating',datatype:'number',options:[]}]};
 let member={entryId:'one',collectionId,revision:'entry-1',fileRevision:'source-1',path:'One.md',values:{[propertyId]:1},deleted:false,pendingProjection:false};
 const databaseRequests:{admission:string;command:DatabaseRequest}[]=[],applied=new Map<string,unknown>(),oldAcknowledgment=gate(),sourceCaptures=new Map<string,{captureId:string;logicalWitness:any;source:string}>();let withholdDatabaseAck=false,failHeldDatabaseAck=true;
 const changes=new Set<(change:{vault:string;path?:string})=>void>(),notices:string[]=[],repairErrors:string[]=[];let interceptRead:(()=>Promise<void>)|undefined;let interceptDatabase:((admission:string,command:DatabaseRequest)=>Promise<void>)|undefined,baseNotReady=false;
 const noticeObserver=new dom.window.MutationObserver(()=>{for(const node of document.querySelectorAll('.notice'))if(!notices.includes(node.textContent??''))notices.push(node.textContent??'');for(const node of document.querySelectorAll('[data-base-editing].mod-error,[aria-invalid="true"],.bases-session-status,.metadata-error:not([hidden])')){const value=node.textContent??'';if((node.matches('[aria-invalid="true"],[data-base-editing].mod-error')||/failed|error|reconnect|retry|no longer|unavailable/i.test(value))&&!repairErrors.includes(value))repairErrors.push(value);}});noticeObserver.observe(document.body,{childList:true,subtree:true});
 const receivers:{id:string;retire:()=>void;stopped:boolean}[]=[];let recoveryGate:Promise<void>|undefined;let recoveryFailureCode:string|undefined,recoveryFailureSource:string|undefined;let storageLost=false,recoveries=0,failedRecoveries=0,failedRecoveredLists=0,replayCheck:((input:any)=>void)|undefined;
 let context:string|null=null,admissions=0,releases=0,pickers=0,failedGets=0,releaseGate:Promise<void>|undefined,closeHandler:(()=>Promise<void>)|undefined;
 const calls:{admission:string;method:string;args:any[]}[]=[],metadata=()=>[...records.values()].map(row=>({path:row.path,type:'file',...(!omitNamespaceIdentity?{entryId:row.entryId,revision:row.revision}:{}),...row.stat}));
 const bridge={getWindowInfo:async()=>({id:'main',initialState:'restore'}),getVault:async()=>{if(failedGets-->0)throw Error('Temporary reconnect failure');return{path:'/lifecycle-fixture',name:'Lifecycle'};},
 getDurableContext:async()=>{context??='admission-'+(++admissions);return{admissionId:context,scope,databases:true,conditionalSavedSourceAvailable:guardedSettings};},
 releaseDurableContext:async(_root:string,admission:string)=>{releases++;await releaseGate;if(context===admission)context=null;},
 recoverDurableContext:async(_root:string,prior:string)=>{recoveries++;await recoveryGate;if(failedRecoveries-->0)throw Object.assign(Error('Temporary recovery failure'),{...(recoveryFailureCode?{code:recoveryFailureCode}:{}),...(recoveryFailureSource?{source:recoveryFailureSource}:{})});assert.equal(prior,context);context='admission-'+(++admissions);storageLost=false;return{admissionId:context,scope,databases:true,conditionalSavedSourceAvailable:guardedSettings};},
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
  if(method==='captureSavedSource'){const row=records.get(input.path)!;assert.equal(row.entryId,input.entryId);assert.equal(row.revision,input.revision);const capture={captureId:crypto.randomUUID(),logicalWitness:structuredClone(input),source:row.content};sourceCaptures.set(capture.captureId,capture);return structuredClone(capture);}
  if(method==='releaseSavedSource'){sourceCaptures.delete(input);return;}
  if(method==='fileCommand'){assert.equal(input.kind,'move');const row=records.get(input.path)!;assert.ok(row);if(input.expectedEntryId)assert.equal(input.expectedEntryId,row.entryId);if(input.expectedRevision)assert.equal(input.expectedRevision,row.revision);records.delete(input.path);row.path=input.destination;records.set(row.path,row);member={...member,path:row.path};return;}
  if(method==='readText')return structuredClone(records.get(input)??null);
  if(method==='composeNote'){await interceptRead?.();const current=structuredClone(records.get(input.path)!);assert.equal(current.entryId,input.entryId);const end=input.proposed.indexOf('\n---\n');return{current,content:end>=0?current.content.slice(0,current.content.indexOf('\n---\n')+5)+input.proposed.slice(end+5):input.proposed};}
  if(method==='readTextById'){await interceptRead?.();return structuredClone(record()??null);}
  if(method==='checkpoints.load')return structuredClone(heads.get(input)??null);
  if(method==='checkpoints.list')return{items:[...heads.values()].map(({encodedState,...row})=>row),cursor:null,highWater:String(heads.size)};
  if(method==='checkpoints.changes')return{items:[],cursor:null,highWater:String(heads.size)};
  if(method==='checkpoints.compareAndSwap'){replayCheck?.(input);const prior=heads.get(input.key);assert.equal(input.expectedRevision,prior?.revision??null);const next={version:1,...scope,key:input.key,revision:input.nextRevision,encodedState:input.encodedState,deleted:false,sequence:String(heads.size+1),byteLength:input.encodedState.length};heads.set(input.key,next);return structuredClone(next);}
  if(method==='planWrite'){
   const current=records.get(input.path)!,planned=structuredClone(input);let canonicalContent:string|undefined;
   // The fixture's authoritative planner models the existing native managed-
   // projection merge. Only frontend retention/replay is under test here.
   if(propertyNote&&input.path==='One.md'&&input.expectedRevision!==current.revision){
    const body=(source:string)=>source.slice(source.indexOf('\n---\n')+5);assert.equal(body(input.expectedContent),body(current.content));
    canonicalContent=current.content.slice(0,current.content.indexOf('\n---\n')+5)+body(input.content);planned.expectedRevision=current.revision;planned.expectedContent=current.content;planned.content=canonicalContent;
   }
   plans.set(input.operationId,planned);return{notePlanning:true,schemaVersion:1,ok:true,value:{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify({operation_id:planned.operationId,mutation:{type:'write',id:planned.expectedEntryId,expected:planned.expectedRevision},content_base64:Buffer.from(planned.content).toString('base64')}),...(canonicalContent!==undefined?{canonicalContent}:{})}};
  }
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
   base:async(input:{options?:{viewIndex?:number}})=>{if(baseNotReady&&context!=='admission-1')throw new DocumentSemanticsError('not_ready');return({source,snapshot,coverageComplete:true,value:{definition:{id:'recovery-base',revision:records.get('Recovery.base')!.revision,path:'Recovery.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(records.get('Recovery.base')!.content).views[input.options?.viewIndex??0],rows:[{entryId:'one',revision:records.get('One.md')!.revision,path:'One.md',values:{'file.name':{type:'string',value:'One'},[`note.${propertyId}`]:{type:'number',value:member.values[propertyId]}},editValues:{}}],groups:[{key:null,keyId:null,entryIds:['one']}],groupOptions:[],properties:['file.name',`note.${propertyId}`],availableProperties:['file.name',`note.${propertyId}`],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}});}})} as unknown as DocumentService);
 const decorate=(native:PlatformVault):PlatformVault=>({...native,adapter:{...native.adapter,documentSemantics:documents()},...(native.recovery?{recovery:{subscribe:listener=>native.recovery!.subscribe(listener),containsCapturedSetEntry:command=>native.recovery!.containsCapturedSetEntry(command),holdCapturedSetEntry:command=>native.recovery!.holdCapturedSetEntry(command),claimCapturedSetEntry:command=>native.recovery!.claimCapturedSetEntry(command),recover:async()=>decorate(await native.recovery!.recover())}}:{})});
 t.after(async()=>{oldAcknowledgment.resolve();releaseGate=undefined;failedGets=0;for(const discard of document.querySelectorAll<HTMLButtonElement>('.workspace-retained-inputs button'))discard.click();for(const cancel of document.querySelectorAll<HTMLButtonElement>('.bases-toolbar-popover [aria-label=Cancel]'))cancel.click();for(const pane of (workspace as any).loadedViews()){try{pane.properties?.destroy();}catch{/* Discard only this disposable fixture's intentionally unresolved controls. */}pane.properties=undefined;}try{await workspace.destroy();}finally{await Promise.allSettled([...workspace.buffers.values()].map(buffer=>buffer.dispose()));noticeObserver.disconnect();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 await workspace.start(decorate((await createPlatformAdapter())!));await workspace.openNote(omitNamespaceIdentity?'One.md':'Recovery.base');
 if(!omitNamespaceIdentity)try{await until(()=>!!root.querySelector(`[role="gridcell"][data-property="note.${propertyId}"]`));}catch{throw Error(JSON.stringify({state:workspace.activePane.baseView?.state,dom:root.textContent,requests:databaseRequests}));}


 return{databaseRequests,applied,member:()=>member,changeMemberValue(value:number){member={...member,values:{[propertyId]:value}};},withholdDatabaseAck(fail=true){withholdDatabaseAck=true;failHeldDatabaseAck=fail;},releaseOldAck(){oldAcknowledgment.resolve();},workspace,internal:workspace as any,root,records,heads,plans,calls,bridge,notices,repairErrors,interceptRead(check:()=>Promise<void>){interceptRead=check;},interceptDatabase(check:(admission:string,command:DatabaseRequest)=>Promise<void>){interceptDatabase=check;},setBaseNotReady(value:boolean){baseNotReady=value;},change(path?:string){for(const listener of [...changes])listener({vault:'/lifecycle-fixture',...(path?{path}:{})});},get admissions(){return admissions;},get releases(){return releases;},get pickers(){return pickers;},get recoveries(){return recoveries;},holdRecovery(promise:Promise<void>){recoveryGate=promise;},loseStorage(){storageLost=true;},signalRetirement(){const retiring=context;for(const receiver of [...receivers])if(receiver.id===retiring&&!receiver.stopped)receiver.retire();},failRecovery(times:number,code?:string,source?:string){failedRecoveries=times;recoveryFailureCode=code;recoveryFailureSource=source;},failRecoveredLists(times:number){failedRecoveredLists=times;},observeReplay(check:(input:any)=>void){replayCheck=check;},failReconnect(times=1){failedGets=times;},holdRelease(promise:Promise<void>){releaseGate=promise;},close:()=>closeHandler!(),type(text:string){const input=root.querySelector<HTMLTextAreaElement>('.pane.is-active textarea')!;assert.ok(input,JSON.stringify({message:'fresh editor present',content:root.parentElement?.textContent,admissions,releases,initialized:(workspace as any).initialized,closing:(workspace as any).closing,released:(workspace as any).platformReleased,drained:(workspace as any).platformDrained}));input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}};
}

function key(node:Element,value:string){node.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));}
function ratingDraft(root:HTMLElement,value:string){const cell=root.querySelector(`[role="gridcell"][data-property="note.${propertyId}"]`)!;assert.ok(cell,'collection Rating cell is mounted');key(cell,'Enter');const input=cell.querySelector<HTMLInputElement>('input')!;assert.ok(input,'Rating widget is editable');input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));return input;}
function editRating(root:HTMLElement,value:string){const input=ratingDraft(root,value);key(input,'Enter');return input;}


function managedEdit(root:HTMLElement,value:string){const field=root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;assert.ok(field);field.click();const input=field.querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=value;input.dispatchEvent(new window.InputEvent('input',{bubbles:true}));key(input,'Enter');return input;}
test('a submitted managed note property resumes its original command through fresh admission without manual recovery',async t=>{
 const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);
 const old=f.workspace.platform,recover=gate();f.holdRecovery(recover.promise);f.withholdDatabaseAck();const input=managedEdit(f.root,'9');await until(()=>f.applied.size===1);
 const original=f.databaseRequests.find(call=>call.command.op==='set_entry')!.command;f.signalRetirement();
 try{
  await until(()=>f.recoveries===1,'the submitted managed Properties owner must permit automatic admission recovery');assert.equal(input.isConnected,true);assert.equal(input.value,'9');assert.deepEqual(f.notices,[]);
  recover.resolve();await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);
  const requests=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(requests.length,2);assert.deepEqual(requests[1].command,original);assert.equal(requests[1].admission,'admission-2');assert.equal(f.applied.size,1);assert.equal(f.member().values[propertyId],9);assert.match(f.records.get('One.md')!.content,/Rating: 9/);
  assert.equal(f.root.inert,false);assert.equal(f.root.parentElement?.querySelector('.workspace-reconnect-recovery'),null);assert.deepEqual(f.notices,[]);assert.equal(f.workspace.activePane.properties!.hasPendingChanges(),false);
 }finally{recover.resolve();f.releaseOldAck();}
});

test('typed host failure before a retirement hint keeps the same submitted property promise through recovery',async t=>{
 const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const old=f.workspace.platform;
 f.withholdDatabaseAck();managedEdit(f.root,'9');await until(()=>f.applied.size===1);const original=f.databaseRequests.find(call=>call.command.op==='set_entry')!.command;f.releaseOldAck();
 await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);const commands=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(commands.length,2);assert.deepEqual(commands[1].command,original);assert.equal(f.applied.size,1);assert.deepEqual(f.notices,[]);assert.equal(f.root.inert,false);assert.equal(f.workspace.activePane.properties!.hasPendingChanges(),false);
});

test('newer body typing survives the exact older managed property replay',async t=>{
 const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const old=f.workspace.platform;
 f.withholdDatabaseAck();managedEdit(f.root,'9');await until(()=>f.applied.size===1);const original=f.databaseRequests.find(call=>call.command.op==='set_entry')!.command;
 const buffer=f.workspace.buffers.get('One.md')!;f.type(buffer.text.replace('Original note','Latest body typed while Rating saves'));f.signalRetirement();
 try{try{await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);}catch{assert.fail(JSON.stringify({notices:f.notices,errors:f.root.parentElement?.textContent,calls:f.calls.slice(-10),recoveries:f.recoveries}));}const commands=f.databaseRequests.filter(call=>call.command.op==='set_entry');assert.equal(commands.length,2);assert.deepEqual(commands[1].command,original);assert.equal(f.applied.size,1);assert.match(f.records.get('One.md')!.content,/Rating: 9/);assert.match(f.records.get('One.md')!.content,/Latest body typed/);assert.match(f.workspace.buffers.get('One.md')!.text,/Latest body typed/);assert.deepEqual(f.notices,[]);assert.equal(f.root.inert,false);}finally{f.releaseOldAck();}
});

for(const [code,source]of [['revision_conflict','host'],['invalid_database_response','protocol']]as const)test(`terminal ${source} ${code} keeps the original property draft without automatic commands`,async t=>{
 const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);
 f.interceptDatabase(async(_admission,command)=>{if(command.op==='set_entry')throw Object.assign(Error('Definite fixture failure'),{code,source,commitUncertain:false});});const input=managedEdit(f.root,'9');
 await until(()=>f.notices.length>0);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.recoveries,0);assert.equal(f.applied.size,0);assert.equal(input.isConnected,true);assert.equal(input.value,'9');assert.notEqual(f.root.inert,true);assert.equal(f.workspace.activePane.properties!.hasPendingChanges(),true);
});

test('a cancelled known-success property is not replayed while a newer raw value is restored',async t=>{
 const f=await fixture(t,true);await f.workspace.openNote('One.md');await until(()=>!f.root.querySelector<HTMLElement>('.properties-host')!.hidden);const old=f.workspace.platform;let reject=true;
 f.interceptRead(async()=>{if(reject&&f.applied.size===1){reject=false;throw Object.assign(Error('Derived read failed'),{code:'storage_io_retryable',source:'host',commitUncertain:false});}});const input=managedEdit(f.root,'9');await until(()=>f.notices.length>0);key(input,'Escape');await new Promise(resolve=>setImmediate(resolve));
 const field=f.root.querySelector<HTMLElement>('[data-property-key="Rating"] .metadata-property-value')!;field.click();const raw=field.querySelector<HTMLInputElement>('input')!;raw.value='10.';raw.dispatchEvent(new window.InputEvent('input',{bubbles:true}));const before=[...f.notices];f.signalRetirement();
 await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(f.databaseRequests.filter(call=>call.command.op==='set_entry').length,1);assert.equal(f.member().values[propertyId],9);const fresh=f.root.querySelector<HTMLInputElement>('[data-property-key="Rating"] .metadata-property-value input');assert.equal(fresh?.value??f.root.parentElement?.querySelector<HTMLTextAreaElement>('.workspace-retained-inputs textarea')?.value,'10.');assert.deepEqual(f.notices,before);assert.equal(f.root.inert,false);
});
