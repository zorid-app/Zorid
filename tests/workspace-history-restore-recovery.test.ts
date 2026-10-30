import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(t:TestContext){
 const dom=new JSDOM('<body><main></main>',{url:'https://history.test/',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 Object.defineProperty(dom.window.navigator,'platform',{value:'MacIntel'});const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};t.mock.method(console,'error',()=>{});
 const scope={vaultId:'history-restore-store',clientId:'history-restore-client'},adapter=new MemoryAdapter({'Note.md':'current'}),heads=new Map<string,any>(),plans=new Map<string,any>(),intents=new Map<string,any>(),calls:any[]=[];
 let source='current',revision='source-1',blocked=false,blockedCode='filesystem_io_retryable',commits=0,updates=0;
 adapter.list=async()=>[{path:'Note.md',type:'file',entryId:'entry',revision,ctime:1,mtime:1,size:source.length}];adapter.read=async()=>source;
 const read=()=>({path:'Note.md',entryId:'entry',revision,content:source,stat:{ctime:1,mtime:1,size:source.length}});
 const writes:any={
  checkpoints:{scope,load:async(key:string)=>structuredClone(heads.get(key)??null),list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'}),compareAndSwap:async(input:any)=>{
   calls.push(structuredClone(input));const old=heads.get(input.key);if(old?.revision!==input.nextRevision){assert.equal(input.expectedRevision,old?.revision??null);heads.set(input.key,{version:1,...scope,key:input.key,revision:input.nextRevision,encodedState:input.encodedState,sequence:'1',deleted:input.encodedState===null,byteLength:input.encodedState?.length??0});}
   else assert.equal(old.encodedState,input.encodedState);
   if(blocked)throw Object.assign(Error('Temporarily held exact checkpoint acknowledgement'),{code:blockedCode,source:'host',commitUncertain:true});return structuredClone(heads.get(input.key));
  }},readText:async()=>read(),readTextById:async()=>read(),
  planWrite:async(input:any)=>{plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:'entry',operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
  prepare:async(plan:any)=>{const ref={...scope,entryId:'entry',operationId:plan.operationId,token:plan.operationId},value={ref,state:'prepared',acknowledged:false};intents.set(ref.token,value);return value;},
  query:async(ref:any)=>intents.get(ref.token),commit:async(ref:any)=>{commits++;source=plans.get(ref.operationId).content;revision='source-2';const value={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:'entry',revision,sequence:'2'}};intents.set(ref.token,value);return value;},listUnacknowledged:async()=>[],acknowledge:async()=>{},
 };Object.assign(adapter,{durableWrites:writes});
 const workspace=new Workspace(document.querySelector<HTMLElement>('main')!,(host,options)=>{const input=document.createElement('textarea');input.value=options.value;host.append(input);return{getValue:()=>input.value,setValue(value){input.value=value;},focus(){},destroy(){input.remove();},insert(value){input.value+=value;options.onChange(input.value);}};});
 await workspace.start({adapter,id:'test:history-restore',label:'History',recoveryHistory:{list:async()=>({versions:[{entryId:'entry',snapshotId:'2',path:'Note.md',capturedAtMs:100,byteLength:3}]}),read:async()=>({version:{entryId:'entry',snapshotId:'2',path:'Note.md',capturedAtMs:100,byteLength:3},content:'old'})}});await workspace.openNote('Note.md');
 const internal=workspace as any,update=internal.updateMarkdownBuffer.bind(workspace);internal.updateMarkdownBuffer=(...args:any[])=>{updates++;return update(...args);};
 t.after(async()=>{blocked=false;try{await workspace.destroy();}finally{dom.window.close();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
 return{workspace,internal,calls,plans,get source(){return source;},get commits(){return commits;},get updates(){return updates;},block(value:boolean,code='filesystem_io_retryable'){blocked=value;blockedCode=code;}};
}

test('failed restoration stays visible and idle until explicit save settles the exact retained write',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});await f.internal.showVersionHistory('Note.md');await settle();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await settle();f.block(true);
 document.querySelector<HTMLButtonElement>('.version-history .mod-cta')!.click();for(let i=0;i<8;i++)await settle();
 const buffer=f.workspace.buffers.get('Note.md')!;assert.equal(buffer.text,'old');assert.equal(buffer.dirty,true);assert.ok(buffer.error);assert.match(document.querySelector('.status-bar')!.textContent!,/Local draft/);assert.ok(document.querySelector('.version-history'));assert.match(document.body.textContent!,/note and your changes were kept/);assert.equal(f.updates,1);
 const original=f.calls.find(row=>row.encodedState?.includes('old'));assert.ok(original);const boundary=f.calls.length;f.block(false);t.mock.timers.tick(300000);await settle();assert.equal(f.calls.length,boundary);assert.equal(buffer.dirty,true);assert.equal(f.source,'current');assert.equal(f.commits,0);
 await buffer.flush();assert.equal(buffer.dirty,false);assert.equal(buffer.error,null);assert.equal(f.source,'old');assert.equal(f.updates,1);assert.equal(f.plans.size,1);assert.equal(f.commits,1);
 const replays=f.calls.filter(row=>row.nextRevision===original.nextRevision);assert.ok(replays.length>=2);for(const request of replays)assert.deepEqual(request,original);
});


for(const code of ['permission_denied','storage_corrupt'])test(`terminal restore ${code} keeps the original draft and does not claim automatic saving`,async t=>{
 const f=await fixture(t);await f.internal.showVersionHistory('Note.md');await settle();document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await settle();f.block(true,code);
 document.querySelector<HTMLButtonElement>('.version-history .mod-cta')!.click();for(let i=0;i<8;i++)await settle();
 const buffer=f.workspace.buffers.get('Note.md')!;assert.equal(buffer.text,'old');assert.equal(buffer.dirty,true);assert.ok(document.querySelector('.version-history'));assert.match(document.body.textContent!,/note and your changes were kept/);assert.equal(f.source,'current');assert.equal(f.commits,0);assert.equal(f.updates,1);f.block(false);
});
