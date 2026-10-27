import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Workspace} from '../src/ui/workspace.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteInput,DurableWriteIntent} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';

async function until(check:()=>boolean,label:string){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(check(),label);}
/** Real Workspace checkpoint recovery, restored tab mounting and property input.
 * The in-memory provider separates trusted entry identity from readable YAML;
 * this focused lifecycle test does not claim native/physical-file acceptance. */
async function setup(t:TestContext,options:{managed?:boolean;dirty?:boolean;beforeBinding?:(f:{record:DurableWriteRead;adapter:MemoryAdapter;workspace:Workspace})=>Promise<void>|void}={}){
  const dom=new JSDOM('<!doctype html><body><main></main>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const content=options.managed?'---\n_id: saved-entry\n_type: Books\nDeadline: null\nCount: 7\n---\nSaved body':'---\nCount: 7\n---\nSaved body';
  const scope={vaultId:'recovered-vault',clientId:'recovered-client'},record:DurableWriteRead={path:'Note.md',entryId:'saved-entry',revision:'file-r1',content,stat:{ctime:1,mtime:1,size:content.length}};
  let recoveredBuffer:unknown;
  const draft=content+(options.dirty?'\nRetained local body':''),key='note/v1/saved-entry';
  let checkpoint:Checkpoint={version:1,...scope,key,revision:'checkpoint-r1',sequence:'1',deleted:false,byteLength:0,encodedState:JSON.stringify({version:1,writer:'earlier-window',generation:1,base:structuredClone(record),draft,conflict:false})};
  const plans:DurableWriteInput[]=[],intents=new Map<string,DurableWriteIntent>();let byIdReads=0,commits=0;
  class Adapter extends MemoryAdapter{
    durableWrites!:DurableWrites;
    async list(){return(await super.list()).map(row=>row.path===record.path?{...row,...record.stat,entryId:record.entryId,revision:record.revision}:row);}
    async stat(path:string){const row=await super.stat(path);return row&&path===record.path?{...row,...record.stat,entryId:record.entryId,revision:record.revision}:row;}
  }
  const adapter=new Adapter({'Note.md':content,'Other.md':'Other note'});
  adapter.durableWrites={checkpoints:{scope,load:async requested=>requested===key?structuredClone(checkpoint):null,
    compareAndSwap:async change=>{assert.equal(change.key,key);assert.equal(change.expectedRevision,checkpoint.revision);checkpoint={...checkpoint,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(Number(checkpoint.sequence)+1)};return structuredClone(checkpoint);},
    list:async()=>({items:[checkpoint],cursor:null,highWater:checkpoint.sequence}),changes:async()=>({items:[],cursor:null,highWater:checkpoint.sequence})},
    readText:async path=>path===record.path?structuredClone(record):null,
    readTextById:async id=>{byIdReads++;if(byIdReads===3){recoveredBuffer=workspace.buffers.get('Note.md');await options.beforeBinding?.({record,adapter,workspace});}return id===record.entryId?structuredClone(record):null;},
    planWrite:async input=>{plans.push(structuredClone(input));return{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{const intent:DurableWriteIntent={state:'prepared',acknowledged:false,ref:{...scope,entryId:plan.entryId,operationId:plan.operationId,token:plan.operationId}};intents.set(plan.operationId,intent);return intent;},
    commit:async ref=>{const input=plans.find(item=>item.operationId===ref.operationId)!;assert.equal(input.expectedRevision,record.revision);assert.equal(input.expectedEntryId,record.entryId);record.content=input.content;record.revision='file-r'+ (1+ ++commits);record.stat={...record.stat,mtime:commits+1,size:record.content.length};await adapter.write(record.path,record.content);const intent:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,revision:record.revision,sequence:String(commits)}};intents.set(ref.operationId,intent);return intent;},
    query:async ref=>intents.get(ref.operationId)??null,listUnacknowledged:async()=>[],acknowledge:async()=>{},
  };
  const schema={id:'books',name:'Books',revision:'schema-r1',deleted:false,properties:[{id:'deadline',name:'Deadline',datatype:'date' as const,options:[]},{id:'count',name:'Count',datatype:'number' as const,options:[]}]};
  Object.assign(adapter,{databases:{request:async()=>{if(!options.managed)throw Object.assign(new Error('Entry is not a collection member'),{source:'host',code:'collection_not_found',commitUncertain:false});return{collections:[schema],entries:[{entryId:record.entryId,collectionId:schema.id,revision:'member-r1',fileRevision:record.revision,path:record.path,values:{deadline:null,count:7},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}}});
  localStorage.setItem('zorid:workspace:recovered-properties',JSON.stringify({panes:[{tabs:[{path:'Note.md',kind:'note',mode:'live'}],active:0}]}));
  const root=document.querySelector<HTMLElement>('main')!,workspace=new Workspace(root,(host,settings)=>{const input=document.createElement('textarea');input.value=settings.value;host.append(input);return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus(){},destroy(){input.remove();},insert:value=>{input.value+=value;settings.onChange(input.value);}};});
  t.after(async()=>{try{await workspace.destroy();}catch{/* Rejected ownership fixtures intentionally retain their draft. */}finally{dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'recovered-properties',label:'Recovered properties'});
  return{workspace,internal:workspace as any,root,record,adapter,plans,dom,draft,get recoveredBuffer(){return recoveredBuffer as import('../src/ui/note-buffer.ts').NoteBuffer;},get reads(){return byIdReads;},get checkpoint(){return checkpoint;}};
}

test('restored clean checkpoint has working ordinary property edits with its saved actor bound',async t=>{
  const f=await setup(t),buffer=f.workspace.buffers.get('Note.md')!;
  assert.ok(f.internal.bufferEntries.get(buffer),'recovery-created buffer must acquire its first actor token');
  const cell=f.root.querySelector<HTMLElement>('[data-property-key="Count"] .metadata-property-value')!;cell.click();
  const input=cell.querySelector<HTMLInputElement>('input[aria-label="Count value"]')!;assert.ok(input);input.value='78';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await f.workspace.activePane.properties!.flush();assert.match(f.record.content,/Count: 78/);assert.ok(f.record.content.endsWith('Saved body'));assert.equal(f.plans.length,1);
});

test('restored managed checkpoint mounts collection heading, hidden identity and declared null datatype',async t=>{
  const f=await setup(t,{managed:true});await until(()=>f.root.textContent!.includes('Books properties'),'recovered managed note must resolve collection controls');
  assert.equal(f.root.querySelector<HTMLElement>('[data-property-key="_id"]')!.hidden,true);assert.equal(f.root.querySelector<HTMLElement>('[data-property-key="_type"]')!.hidden,true);
  assert.equal(f.root.querySelector<HTMLSelectElement>('[data-property-key="Deadline"] select')!.value,'date');
});

test('first binding preserves a same-actor recovered dirty body without reloading it',async t=>{
  const f=await setup(t,{dirty:true}),buffer=f.workspace.buffers.get('Note.md')!;assert.equal(buffer.text,f.draft);assert.equal(buffer.dirty,true);assert.ok(f.internal.bufferEntries.get(buffer));assert.equal(f.plans.length,0);
});

test('already-bound token invalidation never rebinds a dirty buffer to a path replacement',async t=>{
  const f=await setup(t),buffer=f.workspace.buffers.get('Note.md')!;assert.ok(f.internal.bufferEntries.get(buffer));buffer.update(buffer.text+'\nRetained later draft');const draft=buffer.text,token=f.internal.bufferEntries.get(buffer);
  f.internal.invalidateTreeTokens('Note.md');f.workspace.vault.entries.set('Note.md',{...f.workspace.vault.entries.get('Note.md')!,entryId:'replacement'});
  await f.internal.bufferFor('Note.md');assert.equal(f.internal.bufferEntries.get(buffer),token);assert.equal(buffer.text,draft);assert.equal(f.plans.length,0);
});


test('first binding rejects replacement, move and revision advancement while preserving the recovered draft',async t=>{
  for(const kind of ['replacement','move','revision','token','scope','map','generation']as const)await t.test(kind,async child=>{
    const f=await setup(child,{dirty:true,beforeBinding:({record,adapter,workspace})=>{
      if(kind==='replacement'){record.entryId='replacement';workspace.vault.entries.set('Note.md',{...workspace.vault.entries.get('Note.md')!,entryId:'replacement'});}
      else if(kind==='move')record.path='Other.md';
      else if(kind==='revision')record.revision='later-revision';
      else if(kind==='token')(workspace as any).invalidateTreeTokens('Note.md');
      else if(kind==='map')(workspace as any).buffers.set('Note.md',{path:'Note.md'});
      else if(kind==='generation')(workspace as any).vaultGeneration++;
      else (adapter as MemoryAdapter&{durableWrites:DurableWrites}).durableWrites={...(adapter as MemoryAdapter&{durableWrites:DurableWrites}).durableWrites};
    }});
    const buffer=f.recoveredBuffer;assert.equal(buffer.text,f.draft);assert.equal(buffer.dirty,true);assert.equal(f.internal.bufferEntries.get(buffer),undefined);assert.equal(f.workspace.activePane.editor,undefined);assert.match(f.root.textContent!,/couldn’t be opened/i);assert.equal(f.plans.length,0);assert.equal(JSON.parse(f.checkpoint.encodedState!).draft,f.draft);
  });
});


test('simultaneous first admissions may share only the same verified recovered actor binding',async t=>{
  let second:Promise<unknown>|undefined;
  const f=await setup(t,{beforeBinding:({workspace})=>{second=(workspace as any).bufferFor('Note.md');}});
  assert.ok(second);assert.equal(await second,f.workspace.buffers.get('Note.md'));assert.ok(f.internal.bufferEntries.get(f.workspace.buffers.get('Note.md')));assert.equal(f.plans.length,0);
});
