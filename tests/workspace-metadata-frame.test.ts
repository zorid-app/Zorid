import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { EditorHandle } from '../src/ui/editor.ts';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { NoteMetadata } from '../src/core/types.ts';
import type { CommittedMetadataFrame, CommittedMetadataState } from '../src/core/committed-metadata-frame.ts';
import type { DocumentEntry, DocumentService } from '../src/core/document-semantics.ts';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function until(predicate:()=>boolean){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)assert.fail('Timed out waiting for metadata display');await new Promise(resolve=>setTimeout(resolve,2));}}
function frame(names:string[],tag='saved',generation='1',coverageComplete=true):CommittedMetadataFrame{
  const entries=new Map<string,DocumentEntry>(names.map(path=>[path,{id:path.replace(/\W/g,'_'),revision:`r${generation}`,path,kind:'file',deleted:false}]));
  const notes=new Map<string,NoteMetadata>(names.map((path,index)=>[path,{path,frontmatter:{},aliases:[],tags:index===0?[tag]:[],headings:[],links:index===0&&names.length>1?[{target:names[1],fragment:'',start:0,end:1,kind:'wiki',embed:false}]:[]}]));
  const resolve=(_source:string,target:string)=>entries.has(target)?target:null;
  return {snapshot:{localStoreId:'store',generationEpoch:'epoch',generation,versions:{schema:2,extraction:'x',resolver:'r',query:'q'}},source:{localStoreId:'store',watermark:generation},coverageComplete,
    entries:()=>entries.entries(),row:path=>{const entry=entries.get(path);return entry?{kind:'file',value:{entry,metadata:null,exclusion:null}}:undefined;},
    metadata:{get:path=>notes.get(path),entries:()=>notes.entries(),resolveLink:resolve,resolveLinkCandidates:(source,target)=>{const path=resolve(source,target);return path?[path]:[];},backlinks:()=>[]}};
}
function installProjection(vault:Vault,initial:CommittedMetadataState){
  let state=initial,closes=0,stops=0,failures=0,gate:Promise<void>|undefined;
  const listeners=new Set<(state:CommittedMetadataState)=>void>(),retained:((state:CommittedMetadataState)=>void)[]=[];
  Object.defineProperty(vault,'metadataFrame',{configurable:true,get:()=>state});
  vault.onMetadata=listener=>{listeners.add(listener);retained.push(listener);let active=true;return()=>{if(active){active=false;stops++;listeners.delete(listener);}};};
  vault.closeMetadataProjection=async()=>{closes++;listeners.clear();await gate;if(failures-->0)throw Error('metadata close ACK missing');};
  return {publish(next:CommittedMetadataState){state=next;for(const listener of [...listeners])listener(next);},late(next:CommittedMetadataState){state=next;for(const listener of retained)listener(next);},
    failClose(count:number){failures=count;},holdClose(promise:Promise<void>){gate=promise;},get closes(){return closes;},get stops(){return stops;},get subscriptions(){return listeners.size;}};
}
async function setup(t:TestContext,metadataPage?:{wait:Promise<void>;entered:()=>void}){
  const dom=new JSDOM('<!doctype html><main></main>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,
    Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const root=document.querySelector<HTMLElement>('main')!,adapter=new MemoryAdapter({'Current.md':'#legacy\n[[Target.md]]','Target.md':'Target','Future.md':'#future'});
  if(metadataPage){
    const saved=frame(['Current.md']);
    // This page is intentionally not ready. Starting an editor must depend on
    // the namespace and its own source, not on full committed metadata delivery.
    const service={metadataRowsAvailable:true,maintenance:{observeAndSubscribe:async()=>({snapshot:null,unsubscribe(){}})},
      open:async()=>({snapshot:saved.snapshot,source:saved.source,coverageComplete:true,
        async metadataRows(){metadataPage.entered();await metadataPage.wait;throw Object.assign(Error('Metadata still pending'),{code:'not_ready'});},async close(){}})} as unknown as DocumentService;
    Object.defineProperty(adapter,'documentSemantics',{value:service});
  }
  const workspace=new Workspace(root,(parent,options):EditorHandle=>{const input=document.createElement('textarea');input.value=options.value;parent.append(input);return{getValue:()=>input.value,setValue:value=>{input.value=value;},focus:()=>input.focus(),destroy:()=>input.remove(),insert:value=>{input.value+=value;options.onChange(input.value);}};});
  let releases=0;const platform={adapter,id:'test:workspace-metadata',label:'Metadata test',release:async()=>{releases++;}};
  await workspace.start(platform);const internal=workspace as any;
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
  return {workspace,adapter,root,internal,get releases(){return releases;},
    project(state:CommittedMetadataState){const projection=installProjection(workspace.vault,state);internal.subscribeVaultMetadata(workspace.vault);return projection;},
    tags(){internal.rightTab='tags';internal.renderRight();return root.querySelector<HTMLElement>('.right-content')!;},
    async graph(){await internal.openGraph();await until(()=>!!workspace.activePane.content?.querySelector('.graph-view'));return workspace.activePane.content!.querySelector<HTMLElement>('.graph-view')!;}};
}

function labels(graph:Element){return [...graph.querySelectorAll('svg g[role="link"]')].map(node=>node.getAttribute('aria-label'));}

test('workspace can open and edit the selected note while committed metadata is still loading',async t=>{
  const page=deferred<void>();let entered=false,ready=false;
  t.after(()=>page.resolve());
  const opening=setup(t,{wait:page.promise,entered:()=>{entered=true;}}).then(ui=>{ready=true;return ui;});
  await until(()=>entered);
  await until(()=>ready);
  const ui=await opening;
  assert.equal(ui.workspace.vault.metadataFrame?.status,'pending');
  await ui.workspace.openNote('Current.md');
  ui.workspace.activePane.editor!.insert('\nTyped before metadata');
  await ui.workspace.flush();
  assert.match(await ui.adapter.read('Current.md'),/Typed before metadata/);
  assert.equal(ui.workspace.vault.metadataFrame?.frame,null,'no incomplete metadata frame is installed');
  page.resolve();
});

test('restored active pane becomes editable before another restored pane finishes reading',async t=>{
  const ui=await setup(t,{wait:Promise.resolve(),entered(){}}),other=deferred<void>();
  const read=ui.adapter.read.bind(ui.adapter);let otherEntered=false;
  ui.adapter.read=async path=>{if(path==='Current.md'){otherEntered=true;await other.promise;}return read(path);};
  const id='test:active-pane-priority';
  localStorage.setItem(`zorid:workspace:${id}`,JSON.stringify({activePaneId:'selected',panes:[
    {id:'other',active:0,tabs:[{kind:'note',path:'Current.md',mode:'live'}]},
    {id:'selected',active:0,tabs:[{kind:'note',path:'Target.md',mode:'live'}]},
  ]}));
  const opening=ui.workspace.openVault({adapter:ui.adapter,id,label:'Restore priority'});
  try{
    await until(()=>otherEntered);
    assert.equal(ui.workspace.activePane.id,'selected');
    const editor=ui.workspace.activePane.editor;
    assert.ok(editor,'the selected pane must not wait behind an unrelated note read');
    editor.insert('\nEarly edit');
    assert.match(ui.workspace.buffers.get('Target.md')!.text,/Early edit/);
  }finally{other.resolve();await opening;}
  await ui.workspace.flush();
  assert.match(await read('Target.md'),/Early edit/);
});

test('passive backlinks wait for the selected document instead of requesting identity before its body loads',async t=>{
  const ui=await setup(t,{wait:Promise.resolve(),entered(){}}),body=deferred<void>();
  const read=ui.adapter.read.bind(ui.adapter),stat=ui.adapter.stat.bind(ui.adapter);
  let reading=false,lookups=0;
  ui.adapter.read=async path=>{if(path==='Current.md'){reading=true;await body.promise;}return read(path);};
  ui.adapter.stat=async path=>{lookups++;return stat(path);};
  ui.root.classList.remove('right-hidden');
  const opening=ui.workspace.openNote('Current.md');
  try{
    await until(()=>reading);
    assert.equal(lookups,0,'secondary sidebar work must not enter the native queue ahead of the selected note');
  }finally{body.resolve();await opening;}
  assert.ok(ui.workspace.activePane.editor);
  await until(()=>lookups>0);
});

test('retired document presentation callbacks cannot start secondary sidebar IO',async t=>{
  const ui=await setup(t,{wait:Promise.resolve(),entered(){}}),frames:FrameRequestCallback[]=[];
  const view=ui.root.ownerDocument.defaultView!;
  view.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  const stat=ui.adapter.stat.bind(ui.adapter);let lookups=0;
  ui.adapter.stat=async path=>{lookups++;return stat(path);};
  ui.root.classList.remove('right-hidden');
  await ui.workspace.openNote('Current.md');
  assert.ok(frames.length>0);
  assert.equal(lookups,0);
  await ui.workspace.destroy();
  while(frames.length)frames.shift()!(0);
  assert.equal(lookups,0,'a completed old frame cannot reacquire IO after retirement');
});

for(const cached of [false,true])test(`tab selection resumes passive backlinks after ${cached?'cached':'held'} view readiness`,async t=>{
  const ui=await setup(t,{wait:Promise.resolve(),entered(){}}),body=deferred<void>();
  ui.root.classList.remove('right-hidden');
  const stat=ui.adapter.stat.bind(ui.adapter);let lookups=0;
  ui.adapter.stat=async path=>{if(path==='Current.md')lookups++;return stat(path);};
  await ui.workspace.openNote('Current.md');await until(()=>lookups>0);
  const tab=ui.internal.current();
  await ui.workspace.openNote('Target.md',true);
  if(!cached){await ui.internal.clearCachedViews();await ui.workspace.buffers.get('Current.md')!.dispose();ui.workspace.buffers.delete('Current.md');}
  const read=ui.adapter.read.bind(ui.adapter);let entered=false;
  ui.adapter.read=async path=>{if(!cached&&path==='Current.md'){entered=true;await body.promise;}return read(path);};
  const before=lookups,selecting=ui.internal.selectTab(ui.workspace.activePane,tab);
  try{if(!cached){await until(()=>entered);assert.equal(lookups,before);}}
  finally{body.resolve();await selecting;}
  assert.ok(ui.workspace.activePane.editor);
  await until(()=>lookups>before);
});

test('active note rename resumes deferred backlinks for the renamed view',async t=>{
  const ui=await setup(t,{wait:Promise.resolve(),entered(){}});
  ui.root.classList.remove('right-hidden');
  const stat=ui.adapter.stat.bind(ui.adapter);let renamedLookups=0;
  ui.adapter.stat=async path=>{if(path==='Renamed.md')renamedLookups++;return stat(path);};
  await ui.workspace.openNote('Current.md');
  await ui.workspace.vault.rename('Current.md','Renamed.md');
  await until(()=>ui.workspace.activePane.viewPath==='Renamed.md'&&!!ui.workspace.activePane.editor);
  await until(()=>renamedLookups>0);
});

test('tags and graph use one committed namespace and resolver despite unrelated live entries',async t=>{
  const ui=await setup(t),saved=frame(['Saved.md','OldTarget.md']);ui.project({status:'current',frame:saved});
  ui.workspace.vault.metadata.get=()=>assert.fail('Capable display must not mix live metadata with the frame');
  ui.workspace.vault.metadata.resolveLink=()=>assert.fail('Graph must use its frame resolver');
  const tags=ui.tags();assert.equal(tags.querySelector('.tag-row')?.textContent,'saved1');assert.doesNotMatch(tags.textContent!,/legacy|future/);
  const graph=await ui.graph();assert.deepEqual(labels(graph),['Saved','OldTarget']);assert.equal(graph.querySelectorAll('svg line').length,1);
  assert.equal(ui.workspace.vault.entries.has('Saved.md'),false,'the frame is deliberately older than live inventory');
});

for(const status of ['stale','unavailable'] as const)test(`${status} metadata retains coherent graph geometry and tags`,async t=>{
  const ui=await setup(t),saved=frame(['Saved.md','Target.md']),projection=ui.project({status:'current',frame:saved});ui.tags();const graph=await ui.graph(),svg=graph.querySelector('svg'),tag=ui.root.querySelector('.tag-row');
  projection.publish({status,frame:saved});assert.equal(graph.querySelector('svg'),svg);assert.deepEqual(labels(graph),['Saved','Target']);
  assert.equal(graph.dataset.metadataStatus,status);assert.match(graph.querySelector('.metadata-projection-status')!.textContent!,/last indexed/);
  assert.equal(ui.root.querySelector('.tag-row'),tag,'status-only notification retains existing tag rows');
  assert.equal(ui.tags().querySelector('.tag-row')?.textContent,'saved1');
});

test('empty retained tags and graph change status without claiming current emptiness during refresh',async t=>{
  const ui=await setup(t),empty=frame([]),projection=ui.project({status:'current',frame:empty});ui.tags();const graph=await ui.graph(),svg=graph.querySelector('svg');
  assert.match(graph.textContent!,/Create notes/);projection.publish({status:'stale',frame:empty});
  assert.equal(graph.querySelector('svg'),svg);assert.doesNotMatch(graph.textContent!,/Create notes/);assert.match(graph.textContent!,/saved snapshot/);
  assert.doesNotMatch(ui.root.querySelector('.right-content')!.textContent!,/No tags found/);assert.match(ui.root.querySelector('.right-content')!.textContent!,/saved snapshot/);
});

for(const status of ['pending','unavailable'] as const)test(`${status} first metadata frame is explicit rather than empty tags or graph`,async t=>{
  const ui=await setup(t),projection=ui.project({status,frame:null}),tags=ui.tags(),graph=await ui.graph();
  assert.equal(tags.querySelectorAll('.tag-row').length,0);assert.doesNotMatch(tags.textContent!,/No tags found/);assert.ok(tags.querySelector('[role="status"]'));
  assert.deepEqual(labels(graph),[]);assert.doesNotMatch(graph.textContent!,/Create notes/);assert.equal(graph.dataset.metadataStatus,status);
  projection.publish({status:'current',frame:frame(['Ready.md'],'ready')});assert.deepEqual(labels(ui.workspace.activePane.content!.querySelector('.graph-view')!),['Ready']);
  assert.equal(ui.tags().querySelector('.tag-row')?.textContent,'ready1');
});

test('a newly installed frame replaces graph namespace and links atomically without reopening editors',async t=>{
  const ui=await setup(t),projection=ui.project({status:'current',frame:frame(['Old.md','OldTarget.md'])});ui.tags();const graph=await ui.graph();
  let renders=0;const renderPane=ui.internal.renderPane;ui.internal.renderPane=()=>{renders++;assert.fail('Metadata delivery must not rerender a pane');};
  projection.publish({status:'current',frame:frame(['New.md','NewTarget.md'],'new','2',false)});
  const next=ui.workspace.activePane.content!.querySelector('.graph-view')!;assert.notEqual(next,graph);assert.deepEqual(labels(next),['New','NewTarget']);assert.equal(next.querySelectorAll('svg line').length,1);
  assert.match(next.querySelector('.metadata-projection-status')!.textContent!,/Some saved notes/);assert.equal(ui.tags().querySelector('.tag-row')?.textContent,'new1');assert.equal(renders,0);ui.internal.renderPane=renderPane;
});

test('split and parked graph surfaces receive the same installed frame',async t=>{
  const ui=await setup(t),projection=ui.project({status:'current',frame:frame(['Old.md'])});await ui.graph();
  const first=ui.workspace.activePane,graphTab=ui.internal.current(first);await ui.internal.split('right');await until(()=>ui.root.querySelectorAll('.graph-view').length===2);
  await ui.workspace.openNote('Current.md',true,first);const parked=ui.internal.cachedViews.get(graphTab);assert.ok(parked?.content?.querySelector('.graph-view'));
  projection.publish({status:'current',frame:frame(['New.md'],'new','2')});
  assert.deepEqual(labels(parked.content.querySelector('.graph-view')),['New']);
  const visible=ui.workspace.panes.find(pane=>pane!==first)!;assert.deepEqual(labels(visible.content!.querySelector('.graph-view')!),['New']);
  await ui.internal.selectTab(first,graphTab);assert.deepEqual(labels(first.content!.querySelector('.graph-view')!),['New']);
});

test('a stale graph action cannot open a replaced entry at the same path',async t=>{
  const ui=await setup(t),saved=frame(['Current.md']);ui.project({status:'stale',frame:saved});const graph=await ui.graph();
  const entry=ui.workspace.vault.entries.get('Current.md')!;entry.entryId='replacement';entry.revision='replacement-revision';
  let navigation:Promise<void>|undefined;const real=ui.workspace.openNote.bind(ui.workspace);ui.workspace.openNote=(...args:Parameters<typeof real>)=>{navigation=real(...args);return navigation;};
  graph.querySelector<SVGGElement>('g[role="link"]')!.dispatchEvent(new ui.root.ownerDocument.defaultView!.MouseEvent('click',{bubbles:true}));
  await until(()=>!!navigation);await assert.rejects(navigation!,/selected note changed/);assert.equal(ui.internal.current().kind,'graph');
});

test('vault replacement closes its projection and old callbacks cannot repaint the new owner',async t=>{
  const ui=await setup(t),projection=ui.project({status:'current',frame:frame(['Old.md'],'old')});ui.tags();
  await ui.workspace.openVault({adapter:new MemoryAdapter({'New.md':'#new'}),id:'test:new-metadata',label:'New'});
  const before=ui.tags().textContent;assert.equal(projection.closes,1);assert.equal(projection.subscriptions,0);
  projection.late({status:'current',frame:frame(['Poison.md'],'poison','2')});assert.equal(ui.root.querySelector('.right-content')!.textContent,before);
});

test('projection close waits for save preflight and failed ACK remains retryable before platform release',async t=>{
  const ui=await setup(t),projection=ui.project({status:'current',frame:frame(['Saved.md'])}),flush=ui.internal.flush;
  ui.internal.flush=async()=>{throw Error('save failed');};await assert.rejects(ui.internal.releasePlatform(),/save failed/);assert.equal(projection.closes,0);assert.equal(projection.subscriptions,1);assert.equal(ui.releases,0);
  ui.internal.flush=flush;projection.failClose(1);await assert.rejects(ui.internal.releasePlatform(),/metadata close ACK/);assert.equal(ui.releases,0);assert.equal(projection.closes,1);
  await ui.internal.releasePlatform();assert.equal(projection.closes,2);assert.equal(ui.releases,1);assert.equal(projection.subscriptions,0);
});

test('destroy drains a held projection close and fences late delivery',async t=>{
  const ui=await setup(t),projection=ui.project({status:'current',frame:frame(['Saved.md'])}),gate=deferred<void>();projection.holdClose(gate.promise);ui.tags();
  const destroying=ui.workspace.destroy();await until(()=>projection.closes===1);assert.equal(ui.releases,0);const before=ui.root.textContent;
  projection.late({status:'current',frame:frame(['Poison.md'],'poison','2')});assert.equal(ui.root.textContent,before);
  gate.resolve();await destroying;assert.equal(ui.releases,1);assert.equal(ui.root.childNodes.length,0);
});

test('an abandoned initialization closes its own metadata projection without acquiring display ownership',async t=>{
  const ui=await setup(t),gate=deferred<void>(),entered=deferred<void>(),slow=new MemoryAdapter({'Slow.md':'#slow'}),list=slow.list.bind(slow);slow.list=async()=>{entered.resolve();await gate.promise;return list();};
  const original=Vault.prototype.closeMetadataProjection;let discarded=0;
  Vault.prototype.closeMetadataProjection=function(){if(this.adapter===slow)discarded++;return original.call(this);};t.after(()=>{Vault.prototype.closeMetadataProjection=original;});
  const opening=ui.workspace.openVault({adapter:slow,id:'test:slow',label:'Slow'});await entered.promise;
  await ui.workspace.openVault({adapter:new MemoryAdapter({'Latest.md':'#latest'}),id:'test:latest',label:'Latest'});gate.resolve();await opening;
  await until(()=>discarded===1);assert.equal(ui.workspace.platform.id,'test:latest');assert.doesNotMatch(ui.tags().textContent!,/slow/);
});

for(const teardown of ['destroy','releasePlatform'] as const)test(`${teardown} joins slow abandoned initialization and its held close ACK`,async t=>{
  const ui=await setup(t),initialized=deferred<void>(),entered=deferred<void>(),closed=deferred<void>(),closing=deferred<void>();
  const slow=new MemoryAdapter({'Slow.md':'#slow'}),list=slow.list.bind(slow);slow.list=async()=>{entered.resolve();await initialized.promise;return list();};
  const original=Vault.prototype.closeMetadataProjection;
  Vault.prototype.closeMetadataProjection=async function(){if(this.adapter===slow){closing.resolve();await closed.promise;}await original.call(this);};t.after(()=>{Vault.prototype.closeMetadataProjection=original;});
  let openingSettled=false,teardownSettled=false;
  const opening=ui.workspace.openVault({adapter:slow,id:'test:slow-close',label:'Slow'}).finally(()=>{openingSettled=true;});await entered.promise;
  const request=ui.internal.vaultRequest,retiring=ui.internal[teardown]().then(()=>{teardownSettled=true;});
  await until(()=>ui.internal.vaultRequest>request);assert.equal(ui.releases,0);initialized.resolve();await closing.promise;
  assert.equal(openingSettled,false,'abandoned open must await its own close ACK');assert.equal(teardownSettled,false);assert.equal(ui.releases,0);
  closed.resolve();await opening;await retiring;assert.equal(ui.releases,1);
});

test('destroy joins late initialization and retries its failed abandoned close before provider release',async t=>{
  const ui=await setup(t),initialized=deferred<void>(),entered=deferred<void>(),retry=deferred<void>(),retryEntered=deferred<void>();
  const slow=new MemoryAdapter({'Slow.md':'#slow'}),list=slow.list.bind(slow);slow.list=async()=>{entered.resolve();await initialized.promise;return list();};
  const original=Vault.prototype.closeMetadataProjection;let attempts=0;
  Vault.prototype.closeMetadataProjection=async function(){if(this.adapter===slow){if(++attempts===1)throw Error('abandoned metadata close ACK missing');retryEntered.resolve();await retry.promise;}await original.call(this);};t.after(()=>{Vault.prototype.closeMetadataProjection=original;});
  const opening=ui.workspace.openVault({adapter:slow,id:'test:slow-failed-close',label:'Slow'}),rejected=assert.rejects(opening,/abandoned metadata close ACK missing/);await entered.promise;
  let finished=false;const request=ui.internal.vaultRequest,destroying=ui.workspace.destroy().then(()=>{finished=true;});await until(()=>ui.internal.vaultRequest>request);
  initialized.resolve();await rejected;await retryEntered.promise;assert.equal(attempts,2);assert.equal(finished,false);assert.equal(ui.releases,0);
  retry.resolve();await destroying;assert.equal(ui.releases,1);assert.equal(ui.internal.retiredMetadataVaults.size,0);
});

test('legacy adapters keep ordinary tags and graph behavior',async t=>{
  const ui=await setup(t);assert.equal(ui.workspace.vault.metadataFrame,undefined);const tags=ui.tags();assert.match(tags.textContent!,/legacy1/);
  const graph=await ui.graph();assert.deepEqual(labels(graph),['Current','Target','Future']);assert.equal(graph.querySelectorAll('svg line').length,1);assert.equal(graph.dataset.metadataStatus,undefined);
});
