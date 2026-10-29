import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import type {EditorHandle} from '../src/ui/editor.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function fixture(t:test.TestContext){
 const dom=new JSDOM('<!doctype html><main></main>',{url:'https://lifecycle.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});
 const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const scope={vaultId:'lifecycle-store',clientId:'lifecycle-client'},records=new Map([['One.md',{path:'One.md',entryId:'one',revision:'source-1',content:'Original note',stat:{ctime:1,mtime:1,size:13}}],['Two.md',{path:'Two.md',entryId:'two',revision:'source-two',content:'Second original',stat:{ctime:1,mtime:1,size:15}}]]),heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>();
 const receivers:{id:string;retire:()=>void;stopped:boolean}[]=[];let recoveryGate:Promise<void>|undefined;let storageLost=false,recoveries=0,failedRecoveries=0,replayCheck:((input:any)=>void)|undefined;
 let context:string|null=null,admissions=0,releases=0,pickers=0,failedGets=0,releaseGate:Promise<void>|undefined,closeHandler:(()=>Promise<void>)|undefined;
 const calls:{admission:string;method:string;args:any[]}[]=[],metadata=()=>[...records.values()].map(row=>({path:row.path,type:'file',entryId:row.entryId,revision:row.revision,...row.stat}));
 const bridge={getWindowInfo:async()=>({id:'main',initialState:'restore'}),getVault:async()=>{if(failedGets-->0)throw Error('Temporary reconnect failure');return{path:'/lifecycle-fixture',name:'Lifecycle'};},
 getDurableContext:async()=>{context??='admission-'+(++admissions);return{admissionId:context,scope};},
 releaseDurableContext:async(_root:string,admission:string)=>{releases++;await releaseGate;if(context===admission)context=null;},
 recoverDurableContext:async(_root:string,prior:string)=>{recoveries++;await recoveryGate;if(failedRecoveries-->0)throw Error('Temporary recovery failure');assert.equal(prior,'admission-1');context='admission-'+(++admissions);storageLost=false;return{admissionId:context,scope};},
 onDocumentRuntimeNudge:(_root:string,id:string,_listener:()=>void,retire:()=>void)=>{const receiver={id,retire,stopped:false};receivers.push(receiver);return()=>{receiver.stopped=true;};},
 openVault:async()=>{pickers++;return null;},onChange:()=>()=>{},onBeforeClose:(handler:()=>Promise<void>)=>{closeHandler=handler;return()=>{};},dismissContextMenu:async()=>{},
 list:async()=>metadata(),stat:async(_root:string,path:string)=>metadata().find(row=>row.path===path)??null,read:async(_root:string,path:string)=>records.get(path)!.content,
 durableInvoke:async(_root:string,admission:string,method:string,args:any[])=>{
  calls.push({admission,method,args:structuredClone(args)});assert.equal(admission,context,'retired adapter must not receive work');if(storageLost)throw Error('Durable editor request failed; retain pending recovery state.');
  const input=args[0],record=()=>[...records.values()].find(row=>row.entryId===(typeof input==='string'?input:input?.expectedEntryId))!;
  if(method==='readText')return structuredClone(records.get(input)??null);
  if(method==='readTextById')return structuredClone(record()??null);
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
 t.after(async()=>{releaseGate=undefined;failedGets=0;try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 return{workspace,internal:workspace as any,root,records,heads,plans,calls,bridge,get admissions(){return admissions;},get releases(){return releases;},get pickers(){return pickers;},get recoveries(){return recoveries;},holdRecovery(promise:Promise<void>){recoveryGate=promise;},loseStorage(){storageLost=true;},signalRetirement(){for(const receiver of [...receivers])if(receiver.id==='admission-1'&&!receiver.stopped)receiver.retire();},failRecovery(times:number){failedRecoveries=times;},observeReplay(check:(input:any)=>void){replayCheck=check;},failReconnect(times=1){failedGets=times;},holdRelease(promise:Promise<void>){releaseGate=promise;},close:()=>closeHandler!(),type(text:string){const input=root.querySelector<HTMLTextAreaElement>('.pane.is-active textarea')!;assert.ok(input,JSON.stringify({message:'fresh editor present',content:root.parentElement?.textContent,admissions,releases,initialized:(workspace as any).initialized,closing:(workspace as any).closing,released:(workspace as any).platformReleased,drained:(workspace as any).platformDrained}));input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}};
}

test('cancelled folder picker reconnects automatically after a transient post-release acquisition failure',async t=>{
 const f=await fixture(t);f.type('Saved before switching');await f.workspace.flush();const old=f.workspace.platform,buffer=f.workspace.buffers.get('One.md');f.failReconnect();
 await f.workspace.chooseVault();
 assert.notEqual(f.workspace.platform,old);assert.notEqual(f.workspace.buffers.get('One.md'),buffer);assert.equal(f.internal.platformReleased,false);assert.equal(f.internal.platformDrained,false);assert.notEqual(f.root.inert,true);assert.equal(f.records.get('One.md')!.content,'Saved before switching');
 f.type('New context saves');await f.workspace.flush();assert.equal(f.records.get('One.md')!.content,'New context saves');assert.equal(f.admissions,2);
});

test('concurrent folder choices share retirement and never release a replacement adapter',async t=>{
 const f=await fixture(t),held=gate();f.holdRelease(held.promise);
 const first=f.workspace.chooseVault(),second=f.workspace.chooseVault(),both=Promise.all([first,second]);await new Promise(resolve=>setImmediate(resolve));held.resolve();await both;
 assert.equal(f.releases,1,'one accepted transition releases one original admission');assert.equal(f.pickers,1);assert.equal(f.admissions,2);f.type('Still admitted');await f.workspace.flush();assert.equal(f.records.get('One.md')!.content,'Still admitted');
});

test('a close failure after native release restores a fresh admitted editor instead of reviving retired buffers',async t=>{
 const f=await fixture(t);f.type('Preserved close text');await f.workspace.flush();const old=f.workspace.platform,buffer=f.workspace.buffers.get('One.md'),split=f.internal.splitLayout,destroy=split.destroy.bind(split);let once=true;
 split.destroy=()=>{if(once){once=false;throw Error('Presentation cleanup failed after release');}destroy();};
 await assert.rejects(f.close(),/Presentation cleanup failed/);
 assert.notEqual(f.workspace.platform,old);assert.notEqual(f.workspace.buffers.get('One.md'),buffer);assert.equal(f.internal.platformReleased,false);assert.notEqual(f.root.inert,true);f.type('Recovered close saves');await f.workspace.flush();assert.equal(f.records.get('One.md')!.content,'Recovered close saves');
});


test('a competing direct vault install waits for folder retirement and cannot be released by its old recovery',async t=>{
 const f=await fixture(t),held=gate();f.holdRelease(held.promise);f.failReconnect();
 const switching=f.workspace.chooseVault();await new Promise(resolve=>setImmediate(resolve));
 let replacementReleases=0;const adapter=new MemoryAdapter({'Other.md':'Other source'}),replacement={adapter,id:'replacement-vault',label:'Replacement',release:async()=>{replacementReleases++;}};
 const installing=f.workspace.start(replacement),both=Promise.all([switching,installing]);held.resolve();await both;
 assert.equal(f.workspace.platform,replacement);assert.equal(replacementReleases,0);await f.workspace.openNote('Other.md');f.type('Replacement remains live');await f.workspace.flush();assert.equal(await adapter.read('Other.md'),'Replacement remains live');
});

test('direct installation is rejected while a close owns the original vault',async t=>{
 const f=await fixture(t),held=gate();f.holdRelease(held.promise);const closing=f.close();await new Promise(resolve=>setImmediate(resolve));
 let released=0;const replacement={adapter:new MemoryAdapter(),id:'uninstalled',label:'Uninstalled',release:async()=>{released++;}};
 await assert.rejects(f.workspace.openVault(replacement),/close is pending/);assert.notEqual(f.workspace.platform,replacement);assert.equal(released,0);held.resolve();await closing;
});

test('late close cleanup failure restores keyboard save and one registered close lifecycle',async t=>{
 const f=await fixture(t),cleanup=f.internal.hotkeyCleanup;let once=true;
 f.internal.hotkeyCleanup=()=>{cleanup?.();if(once){once=false;throw Error('Late listener cleanup failed');}};
 await assert.rejects(f.close(),/Late listener cleanup failed/);
 const old=f.records.get('One.md')!.content;f.type('Keyboard recovered after cleanup');
 const event=new window.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true});document.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
 for(let index=0;index<100&&f.records.get('One.md')!.content===old;index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(f.records.get('One.md')!.content,'Keyboard recovered after cleanup');assert.equal(f.internal.initialized,true);await f.workspace.flush();
});


test('retirement automatically settles both original uncertain checkpoint identities before fresh editor installation',async t=>{
 const f=await fixture(t);await f.workspace.openNote('Two.md');
 const one=f.workspace.buffers.get('One.md')!,two=f.workspace.buffers.get('Two.md')!,old=f.workspace.platform;f.loseStorage();
 one.update('First retained draft');f.type('Second retained draft');
 await new Promise(resolve=>setImmediate(resolve));assert.ok(one.error);assert.ok(two.error);
 const uncertain=new Map(f.calls.filter(call=>call.method==='checkpoints.compareAndSwap'&&JSON.parse(call.args[0].encodedState).generation>0).map(call=>[call.args[0].key,structuredClone(call.args[0])]));assert.equal(uncertain.size,2);
 two.update('Second retained intermediate');two.update('Second retained latest generation');await new Promise(resolve=>setImmediate(resolve));assert.equal(two.text,'Second retained latest generation');
 const replayed=new Set<string>();f.observeReplay(input=>{if(uncertain.has(input.key)&&!replayed.has(input.key)){assert.equal(f.workspace.buffers.get('One.md'),one);assert.equal(f.workspace.buffers.get('Two.md'),two);assert.deepEqual(input,uncertain.get(input.key));replayed.add(input.key);}});
 const held=gate();f.holdRecovery(held.promise);f.signalRetirement();await new Promise(resolve=>setImmediate(resolve));
 try{await assert.rejects(f.workspace.destroy(),/vault transition is pending/);}finally{held.resolve();}
 for(let index=0;index<250&&f.workspace.platform===old;index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.notEqual(f.workspace.platform,old);assert.equal(replayed.size,2);assert.equal(f.recoveries,1);assert.equal(f.records.get('One.md')!.content,'First retained draft');assert.equal(f.records.get('Two.md')!.content,'Second retained latest generation');
 const newer=f.calls.filter(call=>call.admission==='admission-2'&&call.method==='checkpoints.compareAndSwap'&&call.args[0].key==='note/v1/two');assert.equal(JSON.parse(newer[1].args[0].encodedState).generation,3);assert.equal(JSON.parse(newer[1].args[0].encodedState).draft,'Second retained latest generation');assert.equal(newer[1].args[0].expectedRevision,newer[0].args[0].nextRevision);
 const planIndex=f.calls.findIndex(call=>call.admission==='admission-2'&&call.method==='planWrite'&&call.args[0].expectedEntryId==='two');assert.ok(planIndex>f.calls.indexOf(newer[1]),'latest generation is checkpointed before a new write is planned');assert.notEqual(f.root.inert,true);
 assert.equal(f.root.querySelectorAll('.native-document-notice').length,0);assert.doesNotMatch(f.root.textContent!,/Could not save/);f.type('Fresh admitted typing');await f.workspace.flush();assert.equal(f.records.get('Two.md')!.content,'Fresh admitted typing');
});

test('a bounded failed admission repair retains its exact recovery action and buffers for a later successful retry',async t=>{
 const f=await fixture(t),one=f.workspace.buffers.get('One.md')!,old=f.workspace.platform;f.loseStorage();f.type('Retained across failed reconnect');await new Promise(resolve=>setImmediate(resolve));f.failRecovery(3);f.signalRetirement();
 for(let index=0;index<250&&!f.root.parentElement?.querySelector('.workspace-reconnect-recovery');index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(f.recoveries,3);assert.equal(f.workspace.buffers.get('One.md'),one);assert.equal(f.root.inert,true);
 const retry=[...f.root.parentElement!.querySelectorAll<HTMLButtonElement>('.workspace-reconnect-recovery button')].find(button=>button.textContent==='Reconnect notes')!;assert.ok(retry);retry.click();
 for(let index=0;index<250&&f.workspace.platform===old;index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.notEqual(f.workspace.platform,old);assert.equal(f.records.get('One.md')!.content,'Retained across failed reconnect');assert.notEqual(f.root.inert,true);
});
