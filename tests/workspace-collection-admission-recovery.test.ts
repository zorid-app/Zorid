import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import type {EditorHandle} from '../src/ui/editor.ts';

function gate(){let resolve!:()=>void,settled=false;const promise=new Promise<void>(done=>{resolve=()=>{settled=true;done();};});return{promise,resolve,get settled(){return settled;}};}
async function until(predicate:()=>boolean){for(let index=0;index<300&&!predicate();index++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate(),'expected mounted Workspace transition');}
async function fixture(t:test.TestContext){
 const dom=new JSDOM('<!doctype html><main></main>',{url:'https://lifecycle.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const scope={vaultId:'lifecycle-store',clientId:'lifecycle-client'},records=new Map([['One.md',{path:'One.md',entryId:'one',revision:'source-1',content:'Original note',stat:{ctime:1,mtime:1,size:13}}],['Two.md',{path:'Two.md',entryId:'two',revision:'source-two',content:'Second original',stat:{ctime:1,mtime:1,size:15}}]]),heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>();
 const collection={id:'abcdefghijkl',name:'Recovery collection',revision:'schema-1',deleted:false,properties:[]},member={entryId:'one',collectionId:'abcdefghijkl',revision:'entry-1',fileRevision:'source-1',path:'One.md',values:{},deleted:false,pendingProjection:false};
 const databaseRequests:{admission:string;command:any}[]=[],applied=new Map<string,unknown>(),oldDatabaseReply=gate();
 const response=()=>({collections:[structuredClone(collection)],entries:[structuredClone(member)],projection:{pending:0,issues:[]}});
 const changes=new Set<(change:{vault:string;path?:string})=>void>(),notices:string[]=[];let interceptRead:(()=>Promise<void>)|undefined;
 const noticeObserver=new dom.window.MutationObserver(()=>{for(const node of document.querySelectorAll('.notice'))if(!notices.includes(node.textContent??''))notices.push(node.textContent??'');});noticeObserver.observe(document.body,{childList:true,subtree:true});
 const receivers:{id:string;retire:()=>void;stopped:boolean}[]=[];let recoveryGate:Promise<void>|undefined;let storageLost=false,recoveries=0,failedRecoveries=0,failedRecoveredLists=0,replayCheck:((input:any)=>void)|undefined;
 let context:string|null=null,admissions=0,releases=0,pickers=0,failedGets=0,releaseGate:Promise<void>|undefined,closeHandler:(()=>Promise<void>)|undefined;
 const calls:{admission:string;method:string;args:any[]}[]=[],metadata=()=>[...records.values()].map(row=>({path:row.path,type:'file',entryId:row.entryId,revision:row.revision,...row.stat}));
 const bridge={getWindowInfo:async()=>({id:'main',initialState:'restore'}),getVault:async()=>{if(failedGets-->0)throw Error('Temporary reconnect failure');return{path:'/lifecycle-fixture',name:'Lifecycle'};},
 getDurableContext:async()=>{context??='admission-'+(++admissions);return{admissionId:context,scope,databases:true};},
 releaseDurableContext:async(_root:string,admission:string)=>{releases++;await releaseGate;if(context===admission)context=null;},
 recoverDurableContext:async(_root:string,prior:string)=>{recoveries++;await recoveryGate;if(failedRecoveries-->0)throw Error('Temporary recovery failure');assert.equal(prior,'admission-1');context='admission-'+(++admissions);storageLost=false;return{admissionId:context,scope,databases:true};},
 onDocumentRuntimeNudge:(_root:string,id:string,_listener:()=>void,retire:()=>void)=>{const receiver={id,retire,stopped:false};receivers.push(receiver);return()=>{receiver.stopped=true;};},
 openVault:async()=>{pickers++;return null;},onChange:(listener:(change:{vault:string;path?:string})=>void)=>{changes.add(listener);return()=>{changes.delete(listener);};},onBeforeClose:(handler:()=>Promise<void>)=>{closeHandler=handler;return()=>{};},dismissContextMenu:async()=>{},
 list:async()=>{if(context!=='admission-1'&&failedRecoveredLists-->0)throw Error('Temporary fresh inventory failure');return metadata();},stat:async(_root:string,path:string)=>metadata().find(row=>row.path===path)??null,read:async(_root:string,path:string)=>records.get(path)!.content,
 durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
  calls.push({admission,method,args:structuredClone(args)});assert.equal(admission,context,'retired adapter must not receive work');if(storageLost)throw Error('Durable editor request failed; retain pending recovery state.');
  if(method==='databaseCommand'){const command=args[0].command;databaseRequests.push({admission,command:structuredClone(command)});if('operationId'in command){if(!applied.has(command.operationId)){assert.equal(command.op,'delete');collection.deleted=true;collection.revision='schema-deleted';member.deleted=true;records.delete('One.md');applied.set(command.operationId,response());}if(admission==='admission-1')await oldDatabaseReply.promise;return{databases:true,schemaVersion:1,ok:true,value:structuredClone(applied.get(command.operationId))};}return{databases:true,schemaVersion:1,ok:true,value:{...response(),...(command.op==='list'?{entries:[]}: {})}};}
  const input=args[0],record=()=>[...records.values()].find(row=>row.entryId===(typeof input==='string'?input:input?.expectedEntryId))!;
  if(method==='readText')return structuredClone(records.get(input)??null);
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
 await workspace.start((await createPlatformAdapter())!);await workspace.openNote('One.md');
 t.after(async()=>{oldDatabaseReply.resolve();for(const overlay of document.querySelectorAll('.modal-overlay'))overlay.remove();releaseGate=undefined;failedGets=0;try{await workspace.destroy();}finally{noticeObserver.disconnect();dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 return{databaseRequests,applied,oldDatabaseReply,workspace,internal:workspace as any,root,records,heads,plans,calls,bridge,notices,interceptRead(check:()=>Promise<void>){interceptRead=check;},change(path?:string){for(const listener of [...changes])listener({vault:'/lifecycle-fixture',...(path?{path}:{})});},get admissions(){return admissions;},get releases(){return releases;},get pickers(){return pickers;},get recoveries(){return recoveries;},holdRecovery(promise:Promise<void>){recoveryGate=promise;},loseStorage(){storageLost=true;},signalRetirement(){for(const receiver of [...receivers])if(receiver.id==='admission-1'&&!receiver.stopped)receiver.retire();},failRecovery(times:number){failedRecoveries=times;},failRecoveredLists(times:number){failedRecoveredLists=times;},observeReplay(check:(input:any)=>void){replayCheck=check;},failReconnect(times=1){failedGets=times;},holdRelease(promise:Promise<void>){releaseGate=promise;},close:()=>closeHandler!(),type(text:string){const input=root.querySelector<HTMLTextAreaElement>('.pane.is-active textarea')!;assert.ok(input,JSON.stringify({message:'fresh editor present',content:root.parentElement?.textContent,admissions,releases,initialized:(workspace as any).initialized,closing:(workspace as any).closing,released:(workspace as any).platformReleased,drained:(workspace as any).platformDrained}));input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}};
}


test('an accepted browser deletion recovers its original command without waiting for the old renderer reply or leaving a dead modal',async t=>{
 const f=await fixture(t);await f.workspace.openNote('Two.md');const old=f.workspace.platform;f.internal.openCollections();
 const click=(label:string)=>{const button=[...document.querySelectorAll<HTMLButtonElement>('.collections-modal button')].find(node=>node.textContent===label);assert.ok(button,label);button.click();};
 await until(()=>!!document.querySelector('.collection-browser-item button'));click('Recovery collection');await until(()=>[...document.querySelectorAll('.collections-modal button')].some(node=>node.textContent==='Delete collection'));click('Delete collection');click('Move to Trash');await until(()=>f.applied.size===1);const original=structuredClone(f.databaseRequests.find(row=>'operationId'in row.command)!.command);
 f.signalRetirement();try{await until(()=>f.workspace.platform!==old&&!f.internal.lifecycleRecovery);assert.equal(document.querySelector('.collections-modal'),null,'a positively settled browser owner cannot leave its retired modal mounted');const mutations=f.databaseRequests.filter(row=>'operationId'in row.command);assert.equal(mutations.length,2,'the fresh admission retries exactly the accepted capsule');assert.deepEqual(mutations[1].command,original);assert.equal(mutations[1].admission,'admission-2');assert.equal(f.applied.size,1);assert.deepEqual(f.notices,[]);assert.equal(document.querySelector('.workspace-reconnect-recovery'),null);}
 finally{f.oldDatabaseReply.resolve();}
});
