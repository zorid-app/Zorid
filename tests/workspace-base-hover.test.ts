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
import {renderProperties} from '../src/ui/properties.ts';
import type {BaseSessionOptions} from '../src/bases/session.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';

const base='filters: file.ext == "md"\nviews: [{type: table, name: Table, order: [file.name, status]}]\n';
const note='---\n# Keep the comment\nstatus: Todo\nunknown: [one, two]\n---\n# Original\n\nEditable body\n';
function fixture(){
  const ids=new Map<string,string>(),revisions=new Map<string,number>(),heads=new Map<string,any>(),inputs=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>();
  let sequence=0,fail=false;const scope={vaultId:'hover-fixture',clientId:'hover-window'};
  class Adapter extends MemoryAdapter{
    durableWrites!:DurableWrites;
    identify(entry:any){if(!entry)return null;if(!ids.has(entry.path))ids.set(entry.path,`id-${ids.size}`);return{...entry,entryId:ids.get(entry.path),revision:`r${revisions.get(entry.path)??1}`};}
    async list(){return(await super.list()).map(entry=>this.identify(entry));}
    async stat(path:string){return this.identify(await super.stat(path));}
    async write(path:string,text:string){await super.write(path,text);revisions.set(path,(revisions.get(path)??1)+1);}
  }
  const adapter=new Adapter({'Work.base':base,'One.md':note,'Other.md':'Other','Nested.base':base,'Image.png':'image','Sound.mp3':'sound','Document.pdf':'pdf','Unsupported.bin':'binary'});
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
async function setup(t:TestContext,factories:WorkspaceViewFactories={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  dom.window.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const f=fixture(),root=document.querySelector<HTMLElement>('#app')!,options:EditorOptions[]=[],sessions:BaseSessionOptions[]=[];
  let closes=0;
  const workspace=new Workspace(root,(host,value)=>{options.push(value);return createEditor(host,value);},{...factories,base:(host,value)=>{sessions.push(value);const session=createBaseSession(host,value),close=session.close.bind(session);session.close=()=>{closes++;return close();};return session;}});
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
  return{...f,workspace,root,dom,options,sessions,hover,get closes(){return closes;}};
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
