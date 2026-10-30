import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {createCanvasView} from '../src/canvas/view.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

const original=JSON.stringify({nodes:[{id:'a',type:'group',label:'Keep me',x:0,y:0,width:300,height:200}],edges:[],custom:{retained:true}});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate());}
function held(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function setup(t:TestContext,options:{terminal?:boolean;holdLater?:boolean}={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const scope={vaultId:'canvas-vault',clientId:'canvas-client'},adapter=new MemoryAdapter({'Board.canvas':original}),heads=new Map<string,Checkpoint>(),intents=new Map<string,DurableWriteIntent>(),plans=new Map<string,DurableWriteInput>(),commitIds:string[]=[],retryGate=held(),laterGate=held();
  if(!options.holdLater)laterGate.resolve();let accepted=0;
  let current:DurableWriteRead={entryId:'board',path:'Board.canvas',revision:'source-1',content:original,stat:{ctime:1,mtime:1,size:Buffer.byteLength(original)}};
  const writes:DurableWrites={checkpoints:{scope,load:async key=>heads.get(key)??null,compareAndSwap:async change=>{
    const prior=heads.get(change.key);if(prior?.revision===change.nextRevision){assert.equal(prior.encodedState,change.encodedState);return prior;}assert.equal(change.expectedRevision,prior?.revision??null);
    const row:Checkpoint={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,deleted:change.encodedState===null,sequence:String(Number(prior?.sequence??0)+1),byteLength:Buffer.byteLength(change.encodedState??'')};heads.set(change.key,row);return row;
  },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(current),readTextById:async id=>id==='board'?structuredClone(current):null,
    planWrite:async input=>{plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:input.expectedEntryId,operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{const intent:DurableWriteIntent={state:'prepared',acknowledged:false,ref:{...scope,entryId:plan.entryId,operationId:plan.operationId,token:plan.operationId}};intents.set(plan.operationId,intent);return structuredClone(intent);},
    query:async ref=>structuredClone(intents.get(ref.operationId)??null),
    commit:async ref=>{commitIds.push(ref.operationId);if(commitIds.length===1&&options.terminal){const result:DurableWriteIntent={state:'rejected',acknowledged:false,ref,error:{operationId:ref.operationId,code:'revision_conflict',message:'Canvas changed elsewhere'}};intents.set(ref.operationId,result);return result;}if(commitIds.length===1)throw Object.assign(Error('Native storage is temporarily busy'),{code:'storage_io_retryable',source:'host'});await (commitIds.length===2?retryGate.promise:laterGate.promise);accepted++;
      const input=plans.get(ref.operationId)!;assert.equal(input.expectedRevision,current.revision);assert.equal(input.expectedContent,current.content);current={...current,revision:`source-${accepted+1}`,content:input.content,stat:{...current.stat,size:Buffer.byteLength(input.content)}};await adapter.write('Board.canvas',input.content);
      const result:DurableWriteIntent={state:'committed',acknowledged:false,ref,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:current.revision,sequence:String(accepted)}};intents.set(ref.operationId,result);return structuredClone(result);
    },listUnacknowledged:async()=>[],acknowledge:async ref=>{const intent=intents.get(ref.operationId)!;if(intent.state==='committed'||intent.state==='rejected')intents.set(ref.operationId,{...intent,acknowledged:true});},
  };
  Object.assign(adapter,{durableWrites:writes});const root=document.querySelector<HTMLElement>('#app')!;let notify=()=>{},unsubscribed=0;
  const workspace=new Workspace(root,undefined,{canvas:(host,options)=>{const state=options.saveState;return createCanvasView(host,{...options,saveState:state?{isSaved:state.isSaved,subscribe(listener){notify=listener;const release=state.subscribe(listener);return()=>{unsubscribed++;release();};}}:undefined});}});
  t.after(async()=>{retryGate.resolve();laterGate.resolve();try{try{await workspace.destroy();}catch(error){const buffer=workspace.buffers.get('Board.canvas');if(!buffer?.hasRecoveryConflict)throw error;workspace.activePane.canvasView?.destroy();await buffer.closeMetadataProjection();}}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'canvas-recovery-test',label:'Canvas recovery'});await workspace.openNote('Board.canvas');
  const canvas=workspace.activePane.canvasView!,buffer=workspace.buffers.get('Board.canvas')!;assert.ok(canvas);assert.ok(buffer);
  const viewport=root.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const pointer=(target:HTMLElement,type:string,x:number)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:20,button:0});Object.defineProperties(event,{pointerId:{value:1},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(event);};
  return{root,workspace,canvas,buffer,adapter,commitIds,plans,retryGate,laterGate,notify:()=>notify(),get unsubscribed(){return unsubscribed;},move(){const item=root.querySelector<HTMLElement>('[data-node-id="a"]')!;pointer(item,'pointerdown',20);pointer(viewport,'pointermove',45);pointer(viewport,'pointerup',45);}};
}

test('Canvas clears its failed-save latch after an explicit NoteBuffer save settles the original native intent',async t=>{
  const f=await setup(t);t.mock.timers.enable({apis:['setTimeout']});f.move();await until(()=>f.commitIds.length===1&&!!f.buffer.error);
  await until(()=>!!f.root.querySelector('.zorid-canvas-status')?.textContent?.includes('Unable to save Canvas'));
  assert.equal(f.canvas.hasPendingChanges(),true);assert.equal(f.buffer.dirty,true);assert.equal(f.plans.size,1);
  t.mock.timers.tick(300000);await tick();assert.equal(f.commitIds.length,1);assert.match(f.root.querySelector('.zorid-canvas-status')!.textContent!,/Unable to save Canvas/);
  const saving=f.buffer.flush();await until(()=>f.commitIds.length===2);assert.equal(f.buffer.dirty,true);assert.equal(f.canvas.hasPendingChanges(),true);
  f.retryGate.resolve();await saving;await until(()=>!f.buffer.dirty&&f.buffer.error===null);await tick();
  assert.deepEqual(f.commitIds,[...f.plans.keys(),...f.plans.keys()]);assert.equal(await f.adapter.read('Board.canvas'),f.canvas.document.toString());assert.equal(JSON.parse(f.buffer.text).custom.retained,true);
  assert.equal(f.canvas.hasPendingChanges(),false,'Canvas must follow the buffer’s acknowledged recovery without another edit or a new authored operation');
  assert.doesNotMatch(f.root.querySelector('.zorid-canvas-status')!.textContent!,/Unable to save Canvas/);assert.equal(f.plans.size,1,'UI recovery cannot author a new operation');
});

test('an older recovered Canvas intent cannot acknowledge newer geometry before its own held save succeeds',async t=>{
  const f=await setup(t,{holdLater:true});t.mock.timers.enable({apis:['setTimeout']});f.move();await until(()=>f.commitIds.length===1&&!!f.buffer.error);await until(()=>!!f.root.querySelector('.zorid-canvas-status')?.textContent?.includes('Unable to save Canvas'));
  const older=f.canvas.document.toString();const saving=f.buffer.flush();await until(()=>f.commitIds.length===2);f.move();const newer=f.canvas.document.toString();assert.notEqual(newer,older);await until(()=>f.buffer.text===newer);
  f.retryGate.resolve();await until(()=>f.commitIds.length===3);assert.equal(f.buffer.savedText,older);assert.equal(f.buffer.text,newer);assert.equal(f.buffer.dirty,true);assert.equal(f.canvas.hasPendingChanges(),true);
  f.laterGate.resolve();await saving;await until(()=>!f.buffer.dirty&&f.buffer.error===null);await tick();assert.equal(f.canvas.hasPendingChanges(),false);assert.doesNotMatch(f.root.querySelector('.zorid-canvas-status')!.textContent!,/Unable to save Canvas/);assert.equal(await f.adapter.read('Board.canvas'),newer);
  assert.equal(f.plans.size,2,'Only the two actual user edits may author operations');assert.equal(f.commitIds[0],f.commitIds[1]);assert.notEqual(f.commitIds[1],f.commitIds[2]);
});
test('terminal Canvas conflicts retain the complete accepted source and visible failure without automatic replay',async t=>{
  const f=await setup(t,{terminal:true});t.mock.timers.enable({apis:['setTimeout']});f.move();await until(()=>f.buffer.hasRecoveryConflict);await until(()=>!!f.root.querySelector('.zorid-canvas-status')?.textContent?.includes('Unable to save Canvas'));
  const retained=f.canvas.document.toString();assert.notEqual(retained,original);assert.equal(f.buffer.text,retained);assert.equal(await f.adapter.read('Board.canvas'),original);assert.equal(JSON.parse(retained).custom.retained,true);assert.equal(f.canvas.hasPendingChanges(),true);
  t.mock.timers.tick(90000);await tick();assert.equal(f.commitIds.length,1);assert.equal(f.plans.size,1);assert.equal(f.buffer.text,retained);assert.equal(f.canvas.hasPendingChanges(),true);assert.match(f.root.querySelector('.zorid-canvas-status')!.textContent!,/Unable to save Canvas/);
});

test('a destroyed Canvas releases its save observer and retained callbacks cannot clear its failure or author another operation',async t=>{
  const f=await setup(t);t.mock.timers.enable({apis:['setTimeout']});f.move();await until(()=>f.commitIds.length===1&&!!f.buffer.error);await until(()=>!!f.root.querySelector('.zorid-canvas-status')?.textContent?.includes('Unable to save Canvas'));const saving=f.buffer.flush();await until(()=>f.commitIds.length===2);
  const status=f.canvas.element.querySelector('.zorid-canvas-status')!,before=status.textContent;f.canvas.destroy();f.workspace.activePane.canvasView=undefined;assert.equal(f.unsubscribed,1);
  f.retryGate.resolve();await saving;await until(()=>!f.buffer.dirty&&f.buffer.error===null);f.notify();assert.equal(status.textContent,before);assert.equal(f.plans.size,1);assert.equal(f.commitIds.length,2);
});
