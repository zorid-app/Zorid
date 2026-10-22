import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection} from '@codemirror/state';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import type {EditorOptions} from '../src/ui/editor.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {BaseSession} from '../src/bases/session.ts';
import {BaseEmbedSessions} from '../src/ui/base-embed-sessions.ts';
import {inlineBaseRequest} from '../src/bases/inline-base.ts';
import {renderProperties} from '../src/ui/properties.ts';
import type {BaseSessionOptions} from '../src/bases/session.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';

const base='filters: file.ext == "md"\nviews: [{type: table, name: Table, order: [file.name, status]}]\n';
const note='---\n# Keep the comment\nstatus: Todo\nunknown: [one, two]\n---\n# Original\n\nEditable body\n';
function fixture(seed:Record<string,string>={}){
  const ids=new Map<string,string>(),revisions=new Map<string,number>(),heads=new Map<string,any>(),inputs=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>();
  let sequence=0,fail=false;const scope={vaultId:'hover-fixture',clientId:'hover-window'};
  class Adapter extends MemoryAdapter{
    durableWrites!:DurableWrites;
    identify(entry:any){if(!entry)return null;if(!ids.has(entry.path))ids.set(entry.path,`id-${ids.size}`);return{...entry,entryId:ids.get(entry.path),revision:`r${revisions.get(entry.path)??1}`};}
    async list(){return(await super.list()).map(entry=>this.identify(entry));}
    async stat(path:string){return this.identify(await super.stat(path));}
    async write(path:string,text:string){await super.write(path,text);revisions.set(path,(revisions.get(path)??1)+1);}
  }
  const adapter=new Adapter({'Work.base':base,'One.md':note,'Other.md':'Other','Nested.base':base,'Image.png':'image','Sound.mp3':'sound','Document.pdf':'pdf','Unsupported.bin':'binary',...seed});
  const read=async(path:string):Promise<DurableWriteRead>=>{const entry=await adapter.stat(path);assert.ok(entry?.type==='file');return{path,entryId:entry.entryId!,revision:entry.revision!,content:await adapter.read(path),stat:{ctime:1,mtime:1,size:entry.size}};};
  adapter.durableWrites={checkpoints:{scope,async load(key){return structuredClone(heads.get(key)??null);},async compareAndSwap(change){assert.equal(heads.get(change.key)?.revision??null,change.expectedRevision);const head={version:1,...scope,key:change.key,revision:change.nextRevision,encodedState:change.encodedState,sequence:String(++sequence),deleted:change.encodedState===null,byteLength:change.encodedState?Buffer.byteLength(change.encodedState):0};heads.set(change.key,head);return structuredClone(head);},async list(){return{items:[...heads.values()],cursor:null,highWater:String(sequence)};},async changes(){return{items:[],cursor:null,highWater:String(sequence)};}},
    readText:read,readTextById:async id=>{const entry=(await adapter.list()).find(entry=>entry.entryId===id);return entry?read(entry.path):null;},
    async planWrite(input){if(fail)throw Object.assign(new Error('Hover disk unavailable'),{commitUncertain:false});const current=await read(input.path);assert.equal(current.entryId,input.expectedEntryId);assert.equal(current.revision,input.expectedRevision);assert.equal(current.content,input.expectedContent);inputs.set(input.operationId,structuredClone(input));return{version:1,...scope,operationId:input.operationId,entryId:input.expectedEntryId,encodedPlan:JSON.stringify(input)};},
    async prepare(plan){const ref={...scope,token:plan.operationId,operationId:plan.operationId,entryId:plan.entryId};const intent={ref,state:'prepared',acknowledged:false} as const;intents.set(ref.token,intent);return structuredClone(intent);},
    async commit(ref){const input=inputs.get(ref.operationId)!,current=await read(input.path);assert.equal(current.revision,input.expectedRevision);await adapter.write(input.path,input.content);const saved=await read(input.path),intent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:ref.entryId,sequence:String(++sequence),revision:saved.revision}} as const;intents.set(ref.token,intent);return structuredClone(intent);},
    async query(ref){return structuredClone(intents.get(ref.token)??null);},async listUnacknowledged(){return[];},async acknowledge(ref){intents.set(ref.token,{...intents.get(ref.token)!,acknowledged:true} as DurableWriteIntent);},
  };
  return{adapter,ids,revisions,fail(value:boolean){fail=value;}};
}
async function setup(t:TestContext,factories:WorkspaceViewFactories={},seed:Record<string,string>={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  dom.window.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const f=fixture(seed),root=document.querySelector<HTMLElement>('#app')!,options:EditorOptions[]=[],sessions:BaseSessionOptions[]=[],liveSessions:BaseSession[]=[];
  let closes=0;
  const workspace=new Workspace(root,(host,value)=>{options.push(value);return createEditor(host,value);},{...factories,base:(host,value)=>{sessions.push(value);const session=createBaseSession(host,value),close=session.close.bind(session);liveSessions.push(session);session.close=()=>{closes++;return close();};return session;}});
  t.after(async()=>{try{f.fail(false);await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter:f.adapter,id:'test:hover',label:'Test'});await workspace.openNote('Work.base');
  const hover=(path='One.md',modified=true)=>{
    let cell=[...root.querySelectorAll<HTMLElement>('[data-property="file.name"][role="gridcell"]')].find(node=>node.dataset.path===path);
    if(!cell){
      // This fixture injects a captured core row for binary resources. Give that
      // row its own filename cell rather than borrowing another file's anchor.
      cell=document.createElement('div');cell.className='zorid-bases-table-cell';cell.setAttribute('role','gridcell');cell.dataset.path=path;cell.dataset.property='file.name';const link=document.createElement('a');link.className='internal-link';link.textContent=path;cell.append(link);root.querySelector('.bases-session')!.append(cell);
    }
    const anchor=cell.querySelector<HTMLElement>('a.internal-link')!;assert.ok(anchor);const entry=workspace.vault.entries.get(path)!;const callback=sessions.find(value=>value.basePath==='Work.base')!.hoverFile!;
    const listener=(event:MouseEvent)=>callback({path,entryId:entry.entryId,revision:entry.revision,values:{}},event);cell.addEventListener('mouseover',listener,{once:true});anchor.dispatchEvent(new dom.window.MouseEvent('mouseover',{bubbles:true,ctrlKey:modified,metaKey:modified,clientX:20,clientY:20}));return anchor;};
  return{...f,workspace,root,dom,options,sessions,liveSessions,hover,get closes(){return closes;}};
}
async function until(check:()=>boolean,label:string){const end=Date.now()+3500;while(!check()){assert.ok(Date.now()<end,`${label}: ${document.body.textContent}`);await new Promise(resolve=>setTimeout(resolve,5));}}
function popup(){return document.querySelector<HTMLElement>('.bases-file-hover')!;}
async function openHover(f:Awaited<ReturnType<typeof setup>>,path='One.md'){f.hover(path);await until(()=>!!popup()?.querySelector('.bases-file-hover-preview,.image-container,.test-pdf,.test-media,.bases-file-hover-unavailable'),'hover content mounts');return popup();}
async function editHover(root:HTMLElement){root.querySelector('.bases-file-hover-preview p')!.dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:20,clientY:20}));await until(()=>!!root.querySelector('.cm-editor'),'normal editor mounts');return EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;}

test('Workspace positions a table hover from the filename link rather than the containing cell',async t=>{
  const f=await setup(t),cell=[...f.root.querySelectorAll<HTMLElement>('[data-property="file.name"][role="gridcell"]')].find(node=>node.dataset.path==='One.md')!,link=cell.querySelector<HTMLElement>('a.internal-link')!;
  const rect=(left:number,top:number,width:number,height:number)=>({x:left,y:top,left,top,right:left+width,bottom:top+height,width,height,toJSON(){return{};}});
  cell.getBoundingClientRect=()=>rect(300,140,450,60);link.getBoundingClientRect=()=>rect(352,154.516,74.258,17.063);
  const root=await openHover(f);assert.equal(root.style.left,'352px');assert.ok(Math.abs(parseFloat(root.style.top)-181.579)<1e-9);
});

test('Base hover modifier opens rendered Markdown and click edits the same durable shared buffer across own save revisions',async t=>{
  const f=await setup(t);f.hover('One.md',false);await new Promise(resolve=>setTimeout(resolve,350));assert.equal(popup(),null);
  document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Control',ctrlKey:true,metaKey:true,bubbles:true}));await until(()=>!!popup()?.querySelector('.bases-file-hover-preview'),'modifier pressed after entry opens preview');
  const root=popup();assert.match(root.querySelector('.markdown-preview')!.textContent!,/Original/);assert.equal(root.querySelector('.cm-editor,input.note-title'),null);
  assert.equal(root.querySelector('.metadata-properties-heading')!.getAttribute('aria-expanded'),'false');assert.ok(root.querySelector('[aria-label="Open link"]'));assert.equal(root.querySelectorAll('.properties').length,0);
  const shared=f.workspace.buffers.get('One.md')!,id=shared.savedDurableWitness!.entryId,revision=shared.savedDurableWitness!.revision,view=await editHover(root);
  view.dispatch({changes:{from:view.state.doc.length,to:view.state.doc.length,insert:'More text\n'}});await f.workspace.flush();
  assert.equal(f.workspace.buffers.get('One.md'),shared);assert.equal(shared.savedDurableWitness!.entryId,id);assert.notEqual(shared.savedDurableWitness!.revision,revision);assert.ok(root.isConnected);
  view.dispatch({changes:{from:view.state.doc.length,to:view.state.doc.length,insert:'After save\n'}});await f.workspace.flush();assert.equal(await f.adapter.read('One.md'),note+'More text\nAfter save\n');
});

test('hover save failure blocks navigation and retains exact editor selection and draft until retry',async t=>{
  const f=await setup(t),root=await openHover(f),view=await editHover(root);view.dispatch({changes:{from:view.state.doc.length,insert:'Retained draft'}});view.dispatch({selection:EditorSelection.single(8,20)});const selection=view.state.selection.toJSON();f.fail(true);
  await assert.rejects(f.workspace.openNote('Other.md'),/Hover disk unavailable/);assert.ok(root.isConnected);assert.deepEqual(view.state.selection.toJSON(),selection);assert.match(view.state.doc.toString(),/Retained draft/);assert.equal(await f.adapter.read('One.md'),note);
  f.fail(false);await f.workspace.openNote('Other.md');await until(()=>!root.isConnected,'clean navigation closes body popup');assert.match(await f.adapter.read('One.md'),/Retained draft/);
});

test('replacement identity cannot receive a hover draft or continue authoring through captured editor actions',async t=>{
  const f=await setup(t),root=await openHover(f),view=await editHover(root),buffer=f.workspace.buffers.get('One.md')!,original=f.workspace.vault.entries.get('One.md')!,options=f.options.at(-1)!;
  view.dispatch({changes:{from:view.state.doc.length,insert:'Original identity draft'}});f.ids.set('One.md','replacement-id');await f.adapter.write('One.md','Replacement content');f.workspace.vault.entries.set('One.md',(await f.adapter.stat('One.md'))!);
  try{assert.throws(()=>options.validateChange!('must not enter replacement'),/changed|replaced/);await assert.rejects(f.workspace.openNote('Other.md'),/changed|replaced/);assert.ok(root.isConnected);assert.match(buffer.text,/Original identity draft/);assert.equal(await f.adapter.read('One.md'),'Replacement content');}
  finally{f.ids.set('One.md',original.entryId!);await f.adapter.write('One.md',note);f.revisions.set('One.md',1);f.workspace.vault.entries.set('One.md',(await f.adapter.stat('One.md'))!);}
  await f.workspace.flush();assert.equal(await f.adapter.read('One.md'),note+'Original identity draft');
});

test('clean tab switching removes the outside-body popup while retaining the cached Base',async t=>{
  const f=await setup(t),root=await openHover(f);await f.workspace.openNote('Other.md',true);await until(()=>!root.isConnected,'parked Base closes its popup');assert.equal(document.querySelector('.bases-file-hover'),null);
});

test('unaccepted nested Base input in a hover remains mounted and blocks its parent navigation',async t=>{
  const f=await setup(t);await f.adapter.write('One.md',note+'\n```base\nfilters: file.name == "Other"\nviews: [{type: table, name: Nested, order: [file.name, status]}]\n```\n');await f.adapter.write('Other.md','---\nstatus: Todo\n---\nOther');await f.workspace.vault.reload();await new Promise(resolve=>setTimeout(resolve,50));const root=await openHover(f);
  await until(()=>!!root.querySelector('[data-property="note.status"][role="gridcell"]'),'nested Base renders');const cell=root.querySelector('[data-property="note.status"][role="gridcell"]')!;cell.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));const input=cell.querySelector('input')!;input.value='Unaccepted';
  await assert.rejects(f.workspace.openNote('Other.md'),/Finish or cancel/);assert.ok(root.isConnected);assert.ok(input.isConnected);assert.equal(input.value,'Unaccepted');input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await f.workspace.openNote('Other.md');assert.equal(root.isConnected,false);
});

test('hover wrapper coalesces concurrent closes before invoking the underlying Base close',async t=>{
  const f=await setup(t);await openHover(f);const session=f.workspace.activePane.baseView!,before=f.closes;const first=session.close(),second=session.close();assert.equal(first,second);await Promise.all([first,second]);assert.equal(popup(),null);assert.equal(f.closes,before+1);
});

test('hover Properties uses the normal editor, preserves YAML and blocks unresolved property drafts',async t=>{
  const f=await setup(t),root=await openHover(f),heading=root.querySelector<HTMLElement>('.metadata-properties-heading')!;heading.click();assert.equal(heading.getAttribute('aria-expanded'),'true');
  const input=root.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-value input')!;assert.ok(input);input.value='Done';input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await until(()=>!f.workspace.buffers.get('One.md')!.dirty&&/status: Done/.test(f.workspace.buffers.get('One.md')!.text),'shared property save');assert.match(await f.adapter.read('One.md'),/# Keep the comment/);assert.match(await f.adapter.read('One.md'),/Editable body/);
  const key=root.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-property-key-input')!;key.value='Unaccepted name';key.dispatchEvent(new window.Event('input',{bubbles:true}));await assert.rejects(f.workspace.openNote('Other.md'),/Finish editing/);assert.ok(root.isConnected);assert.equal(key.value,'Unaccepted name');key.value='status';await f.workspace.openNote('Other.md');
});
test('hover flush never blurs a foreign panel picker while its own rich-property draft is open',async t=>{
  const f=await setup(t);await f.adapter.write('Properties.yaml','properties:\n  status:\n    type: select\n    options: [{value: Todo}, {value: Done}]\n');await f.workspace.vault.reload();await new Promise(resolve=>setTimeout(resolve,50));const root=await openHover(f);await until(()=>root.querySelector('[data-property-key="status"] .metadata-property-value')?.getAttribute('data-property-type')==='select','shared definition loads');
  root.querySelector<HTMLElement>('.metadata-properties-heading')!.click();root.querySelector<HTMLElement>('[data-property-key="status"] .metadata-property-value')!.click();const own=document.querySelector<HTMLInputElement>('.bases-property-popover input')!;assert.ok(own);own.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));
  const host=document.createElement('div');document.body.append(host);const foreign=renderProperties(host,{vault:f.workspace.vault,path:'Other.md',getSource:()=>note,onChange:()=>{}});await new Promise(resolve=>setTimeout(resolve,0));host.querySelector<HTMLElement>('[data-property-key="status"] .metadata-property-value')!.click();const input=[...document.querySelectorAll<HTMLInputElement>('.bases-property-popover input')].find(input=>input!==own)!;assert.ok(input);let blurs=0;input.addEventListener('blur',()=>{blurs++;});
  try{await assert.rejects(f.workspace.flush(),/Finish editing/);assert.equal(blurs,0);assert.equal(document.activeElement,input);assert.ok(root.isConnected);}
  finally{own.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));own.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));foreign.destroy();host.remove();await Promise.resolve();}
});

test('a clean image preview closes without awaiting delayed bytes and releases its late lease',async t=>{
  const f=await setup(t),read=f.adapter.readBinary.bind(f.adapter);let release!:()=>void,started=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.adapter.readBinary=async path=>{if(path==='Image.png'){started=true;await gate;}return read(path);};
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL,created:string[]=[],revoked:string[]=[];URL.createObjectURL=value=>{const url=create(value);created.push(url);return url;};URL.revokeObjectURL=value=>{revoked.push(value);revoke(value);};
  try{const root=await openHover(f,'Image.png');await until(()=>started,'binary read starts');await f.workspace.openNote('Other.md');assert.equal(root.isConnected,false);release();await until(()=>created.length===1&&revoked.includes(created[0]),'late image URL released');assert.equal(document.querySelector('.bases-file-hover'),null);}finally{release();URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});

test('Open link drains the popup and opens the same original note without revoking its own admission',async t=>{
  const f=await setup(t),root=await openHover(f);root.querySelector<HTMLButtonElement>('[aria-label="Open link"]')!.click();await until(()=>f.workspace.activePane.viewPath==='One.md'&&!!f.workspace.activePane.editor,'original note opens');assert.equal(root.isConnected,false);assert.equal(f.workspace.activePane.editor!.getValue(),note);
});

test('image hover acquires binary bytes and releases its object URL on close without a text buffer',async t=>{
  const f=await setup(t),read=f.adapter.read.bind(f.adapter),binary=f.adapter.readBinary.bind(f.adapter);let textReads=0,binaryReads=0;f.adapter.read=async path=>{if(path==='Image.png')textReads++;return read(path);};f.adapter.readBinary=async path=>{if(path==='Image.png')binaryReads++;return binary(path);};
  const root=await openHover(f,'Image.png');await until(()=>!!root.querySelector('img')?.getAttribute('src'),'image lease arrives');const image=root.querySelector('img')!,url=image.src;assert.match(url,/^blob:/);assert.equal(f.workspace.buffers.has('Image.png'),false);assert.equal(textReads,0);assert.equal(binaryReads,1);
  const revoke=URL.revokeObjectURL,revoked:string[]=[];URL.revokeObjectURL=value=>{revoked.push(value);revoke(value);};try{await f.workspace.openNote('Other.md');assert.equal(root.isConnected,false);assert.equal(image.hasAttribute('src'),false);assert.deepEqual(revoked,[url]);}finally{URL.revokeObjectURL=revoke;}
});

for(const path of ['Document.pdf','Sound.mp3'])test(`${path} hover reuses the normal binary viewer and disposes its owned lease`,async t=>{
  let destroyed=0,released=0;const viewer=(host:HTMLElement,target:string,resources:any)=>{const node=document.createElement('div');node.className=path.endsWith('.pdf')?'test-pdf':'test-media';host.append(node);let lease:any;const ready=resources.acquire(target).then((value:any)=>{lease=value;});return{ready,destroy(){destroyed++;if(lease){lease.release();released++;}},goToPage(){},setScale(){},rotate(){},showSearch(){},applySubpath(){},getSelectionSubpath(){return null;}};};
  const f=await setup(t,{pdf:viewer as any,media:viewer as any}),read=f.adapter.read.bind(f.adapter);let textReads=0;f.adapter.read=async target=>{if(target===path)textReads++;return read(target);};const root=await openHover(f,path);await new Promise(resolve=>setTimeout(resolve,0));await f.workspace.openNote('Other.md');assert.equal(root.isConnected,false);assert.equal(destroyed,1);assert.equal(released,1);assert.equal(textReads,0);assert.equal(f.workspace.buffers.has(path),false);
});

test('unsupported attachment hover is explicit and never opens a text NoteBuffer',async t=>{
  const f=await setup(t),read=f.adapter.read.bind(f.adapter);let textReads=0;f.adapter.read=async path=>{if(path==='Unsupported.bin')textReads++;return read(path);};
  const root=await openHover(f,'Unsupported.bin');assert.match(root.textContent!,/Preview is unavailable/);assert.equal(f.workspace.buffers.has('Unsupported.bin'),false);assert.equal(textReads,0);
});


// The existing fixture supplies a captured saved-row witness to the hover
// callback; these exercise Workspace publication/UI lifecycle, not native query
// admission or reference parity.
for(const failed of [false,true])test(`inline Reading hover ${failed?'failed save and explicit retry':'own save'} preserves its selected property until durable acknowledgement`,async t=>{
  const f=await setup(t),source="Before\n\n```base\nfilters: 'file.name == \"A\"'\nviews:\n  - { type: table, name: Fence old, order: [ file.name, score ] }\n```\n\nAfter\n";
  await f.adapter.write('One.md',source);await f.adapter.write('A.md','---\nscore: 1\n---\nA body\n');await f.workspace.vault.reload(['One.md','A.md']);
  await until(()=>f.root.querySelector('.bases-session-content')?.getAttribute('aria-busy')==='false','parent query finishes saved-source refresh');
  const root=await openHover(f);await until(()=>!!root.querySelector('[role="grid"][aria-label="Fence old"]'),'Reading inline table mounts');
  const cell=root.querySelector<HTMLElement>('[role="gridcell"][data-path="A.md"][data-property="note.score"]')!;
  cell.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointerup',{bubbles:true,button:0}));cell.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  const sessionRoot=root.querySelector('.bases-session')!;
  root.querySelector<HTMLButtonElement>('[aria-label="Views"]')!.click();document.querySelector<HTMLButtonElement>('[aria-label="Configure view Fence old"]')!.click();
  const input=document.querySelector<HTMLInputElement>('[aria-label="View name"]')!;input.focus();input.value='Fence renamed';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const plan=f.adapter.durableWrites.planWrite.bind(f.adapter.durableWrites);let held=true;
  f.adapter.durableWrites.planWrite=async value=>{if(value.path==='One.md'&&held){held=false;entered();await gate;}return plan(value);};
  try{
    f.fail(failed);input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await started;
    assert.equal(root.querySelector('[role="grid"][aria-label="Fence renamed"]'),null);assert.equal(root.querySelector('.bases-session'),sessionRoot);
    assert.equal(root.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');release();
    if(failed){await until(()=>!!f.workspace.buffers.get('One.md')?.error&&!!document.querySelector('.bases-toolbar-error'),'containing-note failure remains visible');assert.equal(root.querySelector('[role="grid"][aria-label="Fence renamed"]'),null);assert.equal(await f.adapter.read('One.md'),source);f.fail(false);await f.workspace.flush();}
    await until(()=>!!root.querySelector('[role="grid"][aria-label="Fence renamed"]'),'saved Reading fence remounts');
    const panel=document.querySelector('[role="dialog"][aria-label="View options"]');[...panel?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>button.textContent==='Cancel')?.click();
    assert.equal(root.querySelector('.bases-session'),sessionRoot);assert.equal(root.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.dataset.property,'note.score');assert.equal(await f.adapter.read('One.md'),source.replace('name: Fence old','name: Fence renamed'));await f.workspace.flush();
  }finally{release();f.fail(false);f.adapter.durableWrites.planWrite=plan;const panel=document.querySelector('[role="dialog"][aria-label="View options"]');[...panel?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>button.textContent==='Cancel')?.click();}
});

for(const configure of [false,true])test(`a clean nested Hover ${configure?'View options':'Views'} portal remains owned while pointer and focus leave the preview`,async t=>{
  const f=await setup(t,{}, {'One.md':'Before\n\n![[Nested.base#Table]]\n\nAfter\n'});
  const root=await openHover(f);await until(()=>!!root.querySelector('.bases-session [aria-label="Views"]'),'nested Base mounts');
  const anchor=[...f.root.querySelectorAll<HTMLElement>('[data-property="file.name"][role="gridcell"]')].find(cell=>cell.dataset.path==='One.md')!.querySelector<HTMLElement>('a.internal-link')!;
  anchor.dispatchEvent(new f.dom.window.MouseEvent('mouseout',{bubbles:true,relatedTarget:root}));root.dispatchEvent(new f.dom.window.MouseEvent('mouseover',{bubbles:true,relatedTarget:anchor}));
  root.querySelector<HTMLButtonElement>('.bases-session [aria-label="Views"]')!.click();
  const next=document.querySelector<HTMLButtonElement>('[aria-label="Configure view Table"]')!;assert.ok(next);
  if(configure)next.click();
  const panel=document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${configure?'View options':'Views'}"]`)!;assert.ok(panel);
  const control=configure?panel.querySelector<HTMLInputElement>('[aria-label="View name"]')!:next;control.focus();
  root.dispatchEvent(new f.dom.window.MouseEvent('mouseout',{bubbles:true,relatedTarget:control}));control.dispatchEvent(new f.dom.window.MouseEvent('mouseover',{bubbles:true,relatedTarget:root}));
  try{
    const index=f.sessions.findIndex(value=>value.basePath==='Nested.base'),session=f.liveSessions[index];assert.ok(session);assert.equal(session.hasPendingChanges(),false,'clean portal does not count as an invalid draft');
    assert.equal(session.owns?.(control),true);assert.equal(f.liveSessions[0].owns?.(control),false,'another Base cannot own this portal');
    assert.equal(session.owns?.(document.body),false);
    const validate=f.sessions[index].validate;try{(f.sessions[index] as {validate:()=>void}).validate=()=>{throw new Error('retired captured host');};assert.equal(session.owns?.(control),false,'stale captured actor cannot own a portal');}finally{(f.sessions[index] as {validate:()=>void}).validate=validate;}
    assert.equal(session.owns?.(control),true,'restored valid actor still owns its clean portal');
    const trigger=root.querySelector<HTMLButtonElement>('.bases-session [aria-label="Views"]')!,parent=trigger.parentNode!,sibling=trigger.nextSibling;
    trigger.remove();assert.equal(session.owns?.(control),false,'removed current trigger retires portal ownership');parent.insertBefore(trigger,sibling);
    assert.equal(session.owns?.(control),true);
    assert.equal(f.workspace.buffers.get('One.md')!.dirty,false,'no draft keeps the clean preview alive');assert.equal(f.workspace.buffers.get('One.md')!.hasRecoveryConflict,false,'no recovery conflict keeps preview alive');
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(root.isConnected,true,'the lifecycle-owned clean portal retains its preview beyond the normal hide grace');assert.equal(panel.isConnected,true);assert.equal(document.activeElement,control);
    if(configure){const closing=session.close();assert.equal(session.owns?.(control),false,'closing session no longer owns portals');await closing;assert.equal(session.owns?.(control),false,'destroyed toolbar/session never own an old portal');}
    else {panel.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(session.owns?.(control),false,'closed panel is no longer current');
      root.querySelector<HTMLButtonElement>('.bases-session [aria-label="Views"]')!.click();
      const replacement=document.querySelector<HTMLElement>('[role="dialog"][aria-label="Views"]')!;assert.notEqual(replacement,panel);assert.equal(session.owns?.(replacement),true);assert.equal(session.owns?.(control),false,'replacement panel never adopts old controls');
      replacement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    }
    document.body.tabIndex=-1;document.body.focus();
    await until(()=>!root.isConnected,'closed or destroyed owned portal releases its clean hover without another pointer event');
  }finally{[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Cancel')?.click();}
});


test('embedded portal ownership follows the live binding lease and rejects detached foreign error and closing entries',async()=>{
  const dom=new JSDOM('<body><main></main><aside></aside></body>'),doc=dom.window.document,host=doc.querySelector('main')!,other=doc.querySelector('aside')!;
  const block='```base\nviews: []\n```',source=block.replace('views: []','views: [{type: table}]'),identity={},occurrence={},inline=inlineBaseRequest(block,0,block.length)!,fresh=inlineBaseRequest(source,0,source.length)!;
  const target={sourcePath:'Source.md',targetPath:'Source.md',viewName:'',sourceIdentity:identity,targetIdentity:identity,inline,occurrence};
  const portals:HTMLElement[]=[];let save!:NonNullable<import('../src/ui/base-embed-sessions.ts').BaseEmbedCreationTarget['onInlineSourceSaved']>,release!:()=>void,hold=false,dirty=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root,target){const portal=doc.createElement('section');portal.append(doc.createElement('input'));doc.body.append(portal);portals.push(portal);save??=target.onInlineSourceSaved!;return{ready:Promise.resolve(),state:{},owns:node=>portal.contains(node),hasPendingChanges:()=>dirty,flush:async()=>{},close:async()=>{if(hold)await gate;portal.remove();}} as unknown as BaseSession;}});
  const foreign=new BaseEmbedSessions({recoveryHost:doc.body,create(){throw new Error('foreign manager must not create');}});
  try{
    const first=manager.mount(target,host);await first.ready;const control=portals[0].firstChild!;assert.equal(manager.owns(control),true);assert.equal(foreign.owns(control),false);
    assert.equal(save(fresh),true);const next=manager.mount({...target,inline:fresh},other);await next.ready;first.detach();assert.equal(manager.owns(control),true,'obsolete lease detach cannot revoke active handoff owner');
    dirty=true;next.detach();assert.ok(doc.querySelector('.base-embed-recovery .base-embed-session'),'detached root remains connected in recovery');assert.equal(manager.owns(control),false,'connected portal from a detached recovery is not owned');dirty=false;
    const third=manager.mount({...target,inline:fresh},host);await third.ready;assert.equal(manager.owns(control),true);hold=true;const closing=manager.close();assert.equal(manager.owns(control),false,'closing manager rejects its still-connected portal');release();await closing;assert.equal(manager.owns(control),false);
    const badPortal=doc.createElement('section');doc.body.append(badPortal);const bad=new BaseEmbedSessions({recoveryHost:doc.body,create(){return{ready:Promise.reject(new Error('failed session')),state:{},owns:()=>true,hasPendingChanges:()=>false,close:async()=>{},flush:async()=>{}} as unknown as BaseSession;}});
    try{const badBinding=bad.mount(target,host);await assert.rejects(badBinding.ready,/failed session/);assert.equal(bad.owns(badPortal),false,'error entry cannot claim arbitrary connected nodes');}finally{await bad.close();badPortal.remove();}
  }finally{release();await manager.close();await foreign.close();dom.window.close();}
});


test('retiring embedded session cannot own its surviving portal while another attached session remains live',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,portals:HTMLElement[]=[];let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(){const portal=doc.createElement('section');doc.body.append(portal);const index=portals.push(portal)-1;return{ready:Promise.resolve(),state:{},owns:node=>portal.contains(node),hasPendingChanges:()=>false,flush:async()=>{},close:async()=>{if(index===0){entered();await gate;}portal.remove();}} as unknown as BaseSession;}});
  try{
    for(let i=0;i<6;i++){const identity={};const binding=manager.mount({sourcePath:'Source.md',targetPath:'Work.base',viewName:'',sourceIdentity:identity,targetIdentity:identity,occurrence:{}},doc.querySelector('main')!);await binding.ready;binding.detach();}
    await started;assert.equal(portals[0].isConnected,true);assert.equal(manager.owns(portals[0]),false,'retiring portal is not owned even while its close awaits');
    const identity={};await manager.mount({sourcePath:'Source.md',targetPath:'Work.base',viewName:'',sourceIdentity:identity,targetIdentity:identity,occurrence:{}},doc.querySelector('main')!).ready;
    assert.equal(manager.owns(portals[6]),true,'independent attached session remains owned');
  }finally{release();await manager.close();dom.window.close();}
});

for(const anchored of [true,false])test(`a clean New-from-${anchored?'Hover':'foreign main pane'} toolbar portal ${anchored?'retains only its parent preview':'does not retain an unrelated preview'}`,async t=>{
  const config='newItemTemplate: Template.md\n'+base;
  const f=await setup(t,{}, {'Work.base':config,'Nested.base':config,'One.md':'Before\n\n![[Nested.base#Table]]\n\nAfter\n','Deep.base':base,'Template.md':'Created body\n\n![[Deep.base#Table]]\n\nEnd\n'});
  const root=await openHover(f);await until(()=>!!root.querySelector('.bases-session [aria-label="New"]'),'nested New command mounts');
  const anchor=[...f.root.querySelectorAll<HTMLElement>('[data-property="file.name"][role="gridcell"]')].find(cell=>cell.dataset.path==='One.md')!.querySelector<HTMLElement>('a.internal-link')!;
  anchor.dispatchEvent(new f.dom.window.MouseEvent('mouseout',{bubbles:true,relatedTarget:root}));root.dispatchEvent(new f.dom.window.MouseEvent('mouseover',{bubbles:true,relatedTarget:anchor}));
  const launcher=anchored?root:f.root;launcher.querySelector<HTMLButtonElement>('.bases-session [aria-label="New"]')!.click();
  await until(()=>!!document.querySelector('.bases-new-item-popover'),'ordinary New note opens');const popup=document.querySelector<HTMLElement>('.bases-new-item-popover')!;
  popup.querySelector<HTMLElement>('[aria-label="Edit note body"]')!.click();await until(()=>!!popup.querySelector('.cm-live-base .bases-session,.internal-embed .bases-session'),'new note nested Base mounts');
  popup.querySelector<HTMLButtonElement>('.bases-session [aria-label="Views"]')!.click();
  const control=document.querySelector<HTMLButtonElement>('[aria-label="Configure view Table"]')!,panel=control.closest<HTMLElement>('[role="dialog"]')!;control.focus();
  root.dispatchEvent(new f.dom.window.MouseEvent('mouseout',{bubbles:true,relatedTarget:control}));control.dispatchEvent(new f.dom.window.MouseEvent('mouseover',{bubbles:true,relatedTarget:root}));
  try{
    const index=f.sessions.findIndex(value=>value.basePath==='Deep.base');assert.equal(f.liveSessions[index].hasPendingChanges(),false);
    if(anchored){
      await new Promise(resolve=>setTimeout(resolve,450));assert.equal(root.isConnected,true);assert.equal(popup.isConnected,true);
      // A real control click begins with pointerdown outside New's DOM root.
      control.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));control.click();
      await until(()=>!!document.querySelector('[role="dialog"][aria-label="View options"]'),'configuration portal opens');await new Promise(resolve=>setTimeout(resolve,450));
      assert.equal(popup.isConnected,true,'its owned clean toolbar interaction must not close the New note');assert.equal(root.isConnected,true);
    }else {
      await until(()=>!root.isConnected,'foreign New toolbar cannot keep the other Hover alive');
      control.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));control.click();
      await until(()=>!!document.querySelector('[role="dialog"][aria-label="View options"]'),'foreign New configuration portal opens');await new Promise(resolve=>setTimeout(resolve,450));
      assert.equal(popup.isConnected,true,'a New note must not close when its own clean toolbar control receives pointerdown');
    }
    const childPanel=document.querySelector<HTMLElement>('[role="dialog"][aria-label="View options"]')!;assert.ok(childPanel);
    childPanel.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(childPanel.isConnected,false,'Escape closes only the child toolbar panel');assert.equal(popup.isConnected,true,'Escape from child portal keeps the New note');
    const childSession=f.liveSessions[index];assert.equal(childSession.owns?.(childPanel),false);
    document.body.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));document.body.tabIndex=-1;document.body.focus();
    await until(()=>!popup.isConnected,'ordinary outside click dismisses the clean New note');assert.equal(childSession.owns?.(childPanel),false,'closed New cannot own its former portal');
    if(anchored)await until(()=>!root.isConnected,'closing the exact New owner releases the parent Hover');
  }finally{
    const current=document.querySelector<HTMLElement>('[role="dialog"][aria-label="View options"]')??panel;current.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if(popup.isConnected){const title=popup.querySelector<HTMLElement>('[aria-label="Note title"]')!;title.focus();title.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!popup.isConnected,'New note closes normally');}
  }
});
