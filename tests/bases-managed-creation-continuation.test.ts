import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import {Workspace} from '../src/ui/workspace.ts';
import type {DurableWrites} from '../src/core/durable-writes.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseRequest} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'schema-r1',deleted:false,properties:[]};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check(),'operation did not settle');}

async function fixture(managed=true){
  const base=`views:\n - {id: aaaaaaaaaaaa, type: table, name: Books${managed?', source: {kind: collection, id: abcdefghijkl}':''}}\n`;
  const adapter=new MemoryAdapter({'Work.base':base});
  const requests:DatabaseRequest[]=[],errors:unknown[]=[],opened:string[]=[],openedIds:(string|undefined)[]=[],writes:string[]=[],ids=new Map<string,string>();
  let failReload=false,failAfterCommit=false,failOpen=false,cancelOpen=false,failQuery=false,failQueryAfterCommit=false,loseAck=false,failGets=false;
  const receipts=new Map<string,unknown>();
  const list=adapter.list.bind(adapter),write=adapter.write.bind(adapter);
  adapter.list=async()=>{if(failReload){failReload=false;throw new Error('Postcommit inventory read failed');}return(await list()).map(entry=>({...entry,entryId:ids.get(entry.path)??entry.path,revision:'r1'}));};
  adapter.stat=async path=>(await list()).filter(entry=>entry.path===path).map(entry=>({...entry,entryId:ids.get(path)??path,revision:'r1'}))[0]??null;
  adapter.write=async(path,text)=>{writes.push(path);return write(path,text);};
  if(managed){
    Object.assign(adapter,{databases:{async request(command:DatabaseRequest){
      if(command.op==='create_entry'){
        requests.push(structuredClone(command));if(receipts.has(command.operationId))return structuredClone(receipts.get(command.operationId));
        ids.set(command.path,command.entryId);await adapter.write(command.path,command.body);if(failAfterCommit){failAfterCommit=false;failReload=true;}
        if(failQueryAfterCommit){failQueryAfterCommit=false;failQuery=true;}
        const response={collections:[collection],entries:[{entryId:command.entryId,collectionId:collection.id,revision:'member-r1',fileRevision:'r1',path:command.path,values:command.values,deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};
        receipts.set(command.operationId,structuredClone(response));if(loseAck){loseAck=false;throw new Error('Create reply lost');}return response;
      }
      if(failGets)throw new Error('Schema read failed');return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};
    }}});
    const unused=async():Promise<never>=>{throw new Error('Unexpected document operation');};
    Object.assign(adapter,{documentSemantics:{status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
      open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,
        metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}}),
        base:async()=>{if(failQuery){failQuery=false;throw new Error('Postcommit derived query failed');}return({source,snapshot,coverageComplete:true,value:{definition:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(await adapter.read('Work.base')).views[0],rows:[],groups:[],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}});},
      })} as unknown as DocumentService});
  }
  const vault=new Vault(adapter);await vault.initialize();
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){throw new Error('Expected awaited presentation');},openCreatedFile:async(path,_event,_anchor,expectedEntryId)=>{opened.push(path);openedIds.push(expectedEntryId);if(failOpen){failOpen=false;throw new Error('Created view failed to open');}if(cancelOpen){cancelOpen=false;return false;}},onError:error=>errors.push(error),buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  await session.ready;
  return{adapter,vault,session,requests,errors,opened,openedIds,writes,host,dom,base,ids,
    failNextReload(){failAfterCommit=true;},failNextOpen(){failOpen=true;},
    cancelNextPresentation(){cancelOpen=true;},
    failNextQuery(){failQueryAfterCommit=true;},loseNextAck(){loseAck=true;},
    failSchemaReads(fail=true){failGets=fail;},
    create(){host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();},
    async close(){await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('managed New retains its committed receipt after a postcommit inventory failure',async()=>{
  const f=await fixture();f.failNextReload();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Postcommit inventory read failed/);assert.equal(f.requests.length,1);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,1,'retry must not create another managed entry');
  assert.equal(f.opened[0],f.requests[0].op==='create_entry'?f.requests[0].path:undefined);
  await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('explicitly canceled presentation ends only the verified committed intent and next New is distinct',async()=>{
  const f=await fixture();f.cancelNextPresentation();f.create();await until(()=>f.opened.length===1&&!f.session.hasPendingChanges());
  assert.equal(f.requests.length,1);assert.deepEqual(f.errors,[]);f.create();await until(()=>f.opened.length===2&&!f.session.hasPendingChanges());
  assert.equal(f.requests.length,2);assert.notEqual(f.opened[0],f.opened[1]);await f.close();
});

test('a committed managed New resumes after its loaded schema was cleared by a failed read',async()=>{
  const f=await fixture();f.failNextOpen();f.create();await until(()=>f.opened.length===1&&f.errors.length>0);
  f.failSchemaReads();await f.session.refresh();f.failSchemaReads(false);
  f.create();await until(()=>f.opened.length===2);assert.equal(f.requests.length,1);assert.equal(f.opened[0],f.opened[1]);
  await until(()=>!f.session.hasPendingChanges());await f.close();
});

for(const managed of [true,false])test(`${managed?'managed':'note'} creation retry rejects an authoritative same-path replacement without losing its owner`,async()=>{
  const f=await fixture(managed);f.failNextOpen();f.create();await until(()=>f.opened.length===1&&f.errors.length>0);
  const path=f.opened[0],originalId=f.ids.get(path)??path;await f.adapter.rename(path,'Moved.md');await f.adapter.write(path,'Replacement contents');f.ids.set('Moved.md',originalId);f.ids.set(path,'replacement-entry');
  // The map still contains the original ID: presentation must consult current
  // authority and must not recapture the replacement as its selected actor.
  assert.equal(f.vault.entries.get(path)?.entryId,originalId);
  const before=f.errors.length;f.create();await until(()=>f.errors.length>before||f.opened.length===2);
  assert.equal(f.opened.length,1,'replacement must never be presented as the created note');assert.equal(f.session.hasPendingChanges(),true);
  if(managed)assert.equal(f.requests.length,1);
  await f.adapter.trash(path);await f.adapter.rename('Moved.md',path);f.ids.set(path,originalId);f.ids.delete('Moved.md');f.create();await until(()=>f.opened.length===2);
  assert.equal(f.openedIds[1],originalId,'the opener must admit the original stable actor');await until(()=>!f.session.hasPendingChanges());await f.close();
});

for(const managed of [true,false])test(`${managed?'managed entry':'note'} New retries presentation of the exact committed item, then accepts a distinct New`,async()=>{
  const f=await fixture(managed);f.failNextOpen();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Created view failed to open/);
  assert.equal(f.session.hasPendingChanges(),true,'a committed unpresented item still belongs to its owner');
  assert.equal(f.session.canRecoverAdmission(),false,'view retirement cannot discard a retained creation');
  await assert.rejects(f.session.flush(),/Use New again/);
  f.create();await until(()=>f.opened.length===2);
  assert.equal(f.opened[1],f.opened[0],'presentation retry must retain the committed target');
  assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1,'presentation retry must not write another note');
  if(managed)assert.equal(f.requests.length,1);
  await until(()=>!f.session.hasPendingChanges());f.create();await until(()=>f.opened.length===3);
  assert.notEqual(f.opened[2],f.opened[0],'a successfully presented New releases the intent');
  if(managed){assert.equal(f.requests.length,2);const [first,next]=f.requests;if(first.op==='create_entry'&&next.op==='create_entry'){assert.notEqual(next.operationId,first.operationId);assert.notEqual(next.entryId,first.entryId);}}
  await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('managed New retains an ACK when the controller reports a derived query error',async()=>{
  const f=await fixture();f.failNextQuery();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Postcommit derived query failed/);assert.equal(f.opened.length,0);assert.equal(f.session.hasPendingChanges(),true);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,1);await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('a lost managed creation ACK reconciles the original operation before presenting it',async()=>{
  const f=await fixture();f.loseNextAck();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Create reply lost/);assert.equal(f.session.hasPendingChanges(),true);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,2);assert.deepEqual(f.requests[0],f.requests[1]);
  assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1);await until(()=>!f.session.hasPendingChanges());await f.close();
});

for(const managed of [true,false])test(`${managed?'managed':'note'} committed New cannot retarget a replacement view`,async()=>{
  const f=await fixture(managed);f.failNextOpen();f.create();await until(()=>f.errors.length>0);
  await f.vault.modify('Work.base',f.base.replace('aaaaaaaaaaaa','bbbbbbbbbbbb'));await f.session.refresh();
  const errors=f.errors.length;f.create();await until(()=>f.errors.length>errors);
  assert.match(String(f.errors.at(-1)),/original .* view/);assert.equal(f.opened.length,1);assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1);
  await f.vault.modify('Work.base',f.base);await f.session.refresh();f.create();await until(()=>f.opened.length===2);
  assert.equal(f.opened[0],f.opened[1]);await until(()=>!f.session.hasPendingChanges());await f.close();
});

async function workspaceFixture(t:test.TestContext){
  const dom=new JSDOM('<main></main>',{url:'https://creation.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const adapter=new MemoryAdapter({'Start.md':'Start','ZCreated.md':'Created exact body'}),ids=new Map([['Start.md','start-entry'],['ZCreated.md','created-entry']]),heads=new Map<string,any>(),checkpointLoads:string[]=[],list=adapter.list.bind(adapter);
  adapter.list=async()=>(await list()).map(entry=>({...entry,entryId:ids.get(entry.path),revision:'r1'}));
  adapter.stat=async path=>(await adapter.list()).find(entry=>entry.path===path)??null;
  let release!:()=>void,started=false,hold=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  const unsupported=async():Promise<never>=>{throw new Error('Unexpected write');};
  const durable:DurableWrites={checkpoints:{scope:{vaultId:'creation-vault',clientId:'creation-client'},load:async key=>{checkpointLoads.push(key);return heads.get(key)??null;},list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'}),compareAndSwap:async change=>{const next={version:1,...durable.checkpoints.scope,...change,sequence:'1',deleted:false,byteLength:change.encodedState.length,revision:change.nextRevision};heads.set(change.key,next);return next;}},
    readText:async path=>{if(hold&&path==='ZCreated.md'){started=true;await gate;}return{entryId:ids.get(path)!,revision:'r1',path,content:await adapter.read(path),stat:{ctime:1,mtime:1,size:1}};},readTextById:async id=>{const path=[...ids].find(([,value])=>value===id)?.[0];return path?durable.readText(path):null;},planWrite:unsupported,prepare:unsupported,commit:unsupported,query:unsupported,listUnacknowledged:async()=>[],acknowledge:unsupported};
  Object.assign(adapter,{durableWrites:durable});
  const root=dom.window.document.querySelector('main')!,workspace=new Workspace(root,(parent,options)=>{const input=parent.ownerDocument.createElement('textarea');parent.append(input);return{getValue:()=>options.value,setValue(){},focus(){},destroy(){input.remove();},insert(){}};});
  t.after(async()=>{release();try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:creation-continuation',label:'Creation'});await workspace.openNote('Start.md');
  const anchor=dom.window.document.createElement('button');root.append(anchor);anchor.focus();
  return{dom,root,workspace,adapter,ids,checkpointLoads,anchor,holdRead(){hold=true;return{release,get started(){return started;}};}};
}

test('Workspace admits the captured creation actor through a delayed buffer load without adopting a replacement',async t=>{
  const{dom,root,workspace,adapter,ids,checkpointLoads,anchor,holdRead}=await workspaceFixture(t),held=holdRead();
  const pending=(workspace as any).openBaseNewItem('ZCreated.md',anchor,root,false,{entryId:'created-entry',revision:'r1'});
  const rejection=assert.rejects(pending,/identity|changed|replaced|coherent file observation/);await until(()=>held.started);
  ids.set('ZCreated.md','replacement-entry');await adapter.write('ZCreated.md','Do not adopt this replacement');held.release();await rejection;
  assert.equal(root.ownerDocument.querySelector('[aria-label="Page preview"]'),null);
  assert.equal(checkpointLoads.includes('note/v1/replacement-entry'),false,'a creation opener must not adopt another actor checkpoint before checking identity');
  const canceled=(workspace as any).openBaseNewItem('ZCreated.md',anchor,root,false,{entryId:'created-entry'});
  dom.window.dispatchEvent(new dom.window.Event('blur'));assert.equal(await canceled,false,'an explicit newer window action may decline presentation');
  const retired=(workspace as any).openBaseNewItem('ZCreated.md',anchor,root,false,{entryId:'created-entry'});
  workspace.activePane.renderVersion++;
  await assert.rejects(retired,/preview owner changed/,'a runtime owner replacement is not evidence of user cancellation');
});

for(const retirement of ['pane','host','blur','pointer','healthy'] as const)test(`final popup preparation validates its structural owner while allowing its own focus: ${retirement}`,async t=>{
  const{root,workspace,anchor}=await workspaceFixture(t),internal=workspace as any,original=internal.baseBufferFor.bind(internal);
  let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  internal.baseBufferFor=async(...args:unknown[])=>{
    const shared=await original(...args),load=shared.load.bind(shared);let held=false;
    shared.load=async(...input:unknown[])=>{if(!held){held=true;entered=true;await gate;}return load(...input);};
    return shared;
  };
  const host=root.ownerDocument.createElement('section');root.append(host);host.append(anchor);
  const pending=internal.openBaseNewItem('ZCreated.md',anchor,host,false,{entryId:'created-entry'});
  const canceled=retirement==='blur'||retirement==='pointer';
  const result=retirement==='healthy'||canceled?pending:assert.rejects(pending,/preview owner changed/);
  await until(()=>entered);
  if(retirement==='pane')workspace.activePane.renderVersion++;
  if(retirement==='host')host.remove();
  if(retirement==='blur')root.ownerDocument.defaultView!.dispatchEvent(new root.ownerDocument.defaultView!.Event('blur'));
  if(retirement==='pointer')root.ownerDocument.body.dispatchEvent(new root.ownerDocument.defaultView!.Event('pointerdown',{bubbles:true}));
  release();await result;
  if(retirement==='healthy'){
    assert.equal(await pending,true);const popup=root.ownerDocument.querySelector('[aria-label="Page preview"]')!;assert.ok(popup);assert.ok(popup.contains(root.ownerDocument.activeElement));await internal.closeBaseNewItem();
  }else{if(canceled)assert.equal(await pending,false,'explicit late cancellation cannot acknowledge a presentation');assert.equal(root.ownerDocument.querySelector('[aria-label="Page preview"]'),null,'a retired owner cannot install or acknowledge the created popup');}
});
