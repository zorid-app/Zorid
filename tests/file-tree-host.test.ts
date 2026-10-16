import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';

async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Timed out waiting for workspace operation');}
async function setup(t:TestContext,seed:Record<string,string>={},adapter=new MemoryAdapter(seed)){
 const dom=new JSDOM('<body><div id="app"></div></body>',{url:'https://zorid.test/'}),saved=new Map<string,PropertyDescriptor|undefined>();
 const matchMedia=(media:string)=>({media,matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,matchMedia})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 dom.window.matchMedia=matchMedia as typeof dom.window.matchMedia;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const root=dom.window.document.querySelector<HTMLElement>('#app')!,workspace=new Workspace(root);
 t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
 await workspace.start({adapter,label:'Explorer test',id:'test:file-tree-host'});
 const state=workspace as any,row=(path:string)=>[...root.querySelectorAll<HTMLElement>('.tree-row')].find(row=>row.dataset.path===path)!;
 const key=(target:HTMLElement,key:string)=>target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 const drag=(target:HTMLElement,type:string)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{setData(){},setDragImage(){}}});target.dispatchEvent(event);return event;};
 return{workspace,state,dom,root,adapter,row,key,drag};
}

test('new folder exists before inline edit and Escape retains it; Enter commits the next name',async t=>{
 const ui=await setup(t);await ui.workspace.newFolder();await Promise.resolve();
 assert.ok(ui.workspace.vault.entries.has('Untitled folder'));let label=ui.row('Untitled folder').querySelector<HTMLElement>('.tree-label')!;
 assert.equal(ui.dom.window.document.activeElement,label);assert.equal(label.getAttribute('contenteditable'),'true');ui.key(label,'Escape');
 assert.ok(ui.workspace.vault.entries.has('Untitled folder'));assert.equal(ui.root.querySelector('[contenteditable]'),null);
 await ui.workspace.newFolder();await Promise.resolve();label=ui.row('Untitled folder 1').querySelector<HTMLElement>('.tree-label')!;label.textContent='Named';ui.key(label,'Enter');
 await until(()=>ui.workspace.vault.entries.has('Named')&&!ui.state.treeRename);assert.equal(ui.workspace.vault.entries.has('Untitled folder 1'),false);
});

test('inline rename preserves its draft across tree rebuild and failed Enter remains editable',async t=>{
 const ui=await setup(t);await ui.workspace.newFolder();await Promise.resolve();let label=ui.row('Untitled folder').querySelector<HTMLElement>('.tree-label')!;
 label.textContent='Draft';label.dispatchEvent(new ui.dom.window.Event('input'));await ui.workspace.vault.createFolder('Taken');await Promise.resolve();
 label=ui.row('Untitled folder').querySelector<HTMLElement>('.tree-label')!;assert.equal(label.textContent,'Draft');assert.equal(ui.dom.window.document.activeElement,label);
 label.textContent='Taken';ui.key(label,'Enter');await until(()=>!!ui.root.querySelector('.file-tree-rename-error'));assert.equal(label.getAttribute('contenteditable'),'true');assert.ok(ui.state.treeRename);
});

test('multiple selected files continue moving after the first rename rerenders the tree',async t=>{
 const ui=await setup(t,{'One.md':'one','Two.md':'two','Target/Keep.md':'keep'});ui.state.treeSelection=new Set(['One.md','Two.md']);
 const controller=ui.state.treeDrag;ui.drag(ui.row('One.md'),'dragstart');ui.drag(ui.row('Target'),'drop');
 await until(()=>ui.workspace.vault.entries.has('Target/One.md')&&ui.workspace.vault.entries.has('Target/Two.md'));
 assert.equal(ui.state.treeDrag,controller);assert.equal(await ui.adapter.read('Target/One.md'),'one');assert.equal(await ui.adapter.read('Target/Two.md'),'two');
});

test('ordinary refresh does not invalidate drag but observed delete/recreate during flush does',async t=>{
 const ui=await setup(t,{'One.md':'old','Target/Keep.md':'keep'});let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),flush=ui.workspace.flush.bind(ui.workspace);
 ui.workspace.flush=()=>gate;ui.drag(ui.row('One.md'),'dragstart');await ui.workspace.vault.reload();ui.drag(ui.row('Target'),'drop');
 await ui.workspace.vault.trash('One.md');await ui.workspace.vault.create('One.md','replacement');release();await until(()=>!!ui.dom.window.document.querySelector('.notice'));
 ui.workspace.flush=flush;assert.equal(await ui.adapter.read('One.md'),'replacement');assert.equal(ui.workspace.vault.entries.has('Target/One.md'),false);
});

test('ordinary input context menu remains native without bridge and uses desktop roles with bridge',async t=>{
 const ui=await setup(t),input=ui.dom.window.document.createElement('input');ui.root.append(input);input.value='text';input.setSelectionRange(0,4);
 const event=()=>new ui.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:12,clientY:24});
 const fallback=event();input.dispatchEvent(fallback);assert.equal(fallback.defaultPrevented,false);assert.equal(ui.root.ownerDocument.querySelector('.context-menu'),null);
 const requests:any[]=[];(ui.dom.window as any).zorid={showContextMenu:async(request:any)=>{requests.push(request);return null;}};
 const native=event();input.dispatchEvent(native);await Promise.resolve();assert.equal(native.defaultPrevented,true);assert.equal(requests.length,1);assert.ok(requests[0].items.some((item:any)=>item.role==='paste'));delete(ui.dom.window as any).zorid;
});

test('starting another folder creation blur-commits the previous inline draft',async t=>{
 const ui=await setup(t);await ui.workspace.newFolder();await Promise.resolve();
 const label=ui.row('Untitled folder').querySelector<HTMLElement>('.tree-label')!;label.textContent='Plans';
 await ui.workspace.newFolder();assert.ok(ui.workspace.vault.entries.has('Plans'));assert.ok(ui.workspace.vault.entries.has('Untitled folder'));
 assert.equal(ui.state.treeRename.path,'Untitled folder');
});

test('concurrent new folder requests each create once and only latest owns inline focus',async t=>{
 const ui=await setup(t);await Promise.all([ui.workspace.newFolder(),ui.workspace.newFolder()]);await Promise.resolve();
 assert.ok(ui.workspace.vault.entries.has('Untitled folder'));assert.ok(ui.workspace.vault.entries.has('Untitled folder 1'));assert.equal(ui.state.treeRename.path,'Untitled folder 1');
});

test('inline rename waiting on flush cannot rename a same-path item in a replacement vault',async t=>{
 const ui=await setup(t);await ui.workspace.newFolder();await Promise.resolve();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),flush=ui.workspace.flush.bind(ui.workspace);let calls=0;
 ui.workspace.flush=()=>++calls===1?gate:flush();
 const label=ui.row('Untitled folder').querySelector<HTMLElement>('.tree-label')!;label.textContent='Renamed';ui.key(label,'Enter');await until(()=>calls===1);
 const replacement=new MemoryAdapter();await replacement.mkdir('Untitled folder');await ui.workspace.openVault({adapter:replacement,id:'replacement',label:'Replacement'});release();await Promise.resolve();await Promise.resolve();ui.workspace.flush=flush;
 assert.ok(ui.workspace.vault.entries.has('Untitled folder'));assert.equal(ui.workspace.vault.entries.has('Renamed'),false);assert.equal((await ui.adapter.list()).some(entry=>entry.path==='Renamed'),false);
});

test('Alt toggles selection, Shift adds full hierarchy range including collapsed children',async t=>{
 const ui=await setup(t,{'Folder/Child.md':'child','Last.md':'last','One.md':'one'});
 ui.state.collapsed.add('Folder');ui.state.renderSidebar();
 const click=(path:string,extra:MouseEventInit)=>ui.row(path).dispatchEvent(new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,...extra}));
 click('One.md',{altKey:true});assert.deepEqual([...ui.state.treeSelection],['One.md']);
 click('Folder',{altKey:true});assert.deepEqual([...ui.state.treeSelection],['One.md','Folder']);assert.ok(ui.state.collapsed.has('Folder'));
 click('Last.md',{shiftKey:true});assert.deepEqual([...ui.state.treeSelection],['One.md','Folder','Folder/Child.md','Last.md']);assert.equal(ui.state.treeSelectionAnchor,'Folder');
 click('Last.md',{altKey:true});assert.equal(ui.state.treeSelection.has('Last.md'),false);
});

test('queued drag rename rejects a source deleted and recreated by prior queued operations',async t=>{
 class SlowWriteAdapter extends MemoryAdapter{
  waiting=false;release!:()=>void;gate=new Promise<void>(resolve=>this.release=resolve);
  override async write(path:string,text:string){if(path==='Block.md'){this.waiting=true;await this.gate;}await super.write(path,text);}
 }
 const adapter=new SlowWriteAdapter({'Block.md':'old','One.md':'original','Target/Keep.md':'keep'}),ui=await setup(t,{},adapter);
 const blocking=ui.workspace.vault.modify('Block.md','new');await until(()=>adapter.waiting);
 const deleting=ui.workspace.vault.trash('One.md'),creating=ui.workspace.vault.create('One.md','replacement');
 ui.drag(ui.row('One.md'),'dragstart');ui.drag(ui.row('Target'),'drop');await Promise.resolve();await Promise.resolve();adapter.release();await Promise.all([blocking,deleting,creating]);
 await until(()=>!!ui.dom.window.document.querySelector('.notice'));
 assert.equal(await adapter.read('One.md'),'replacement');assert.equal(ui.workspace.vault.entries.has('Target/One.md'),false);
});

test('drag guard rejects a fresh case-alias collision discovered inside the vault queue',async t=>{
 class ExternalCollisionAdapter extends MemoryAdapter{
  inject=false;
  override async list(){if(this.inject){this.inject=false;await super.write('Target/ONE.md','external');}return super.list();}
 }
 const adapter=new ExternalCollisionAdapter({'One.md':'original','Target/Keep.md':'keep'}),ui=await setup(t,{},adapter);
 ui.drag(ui.row('One.md'),'dragstart');adapter.inject=true;ui.drag(ui.row('Target'),'drop');
 await until(()=>!!ui.dom.window.document.querySelector('.notice'));
 assert.equal(await adapter.read('One.md'),'original');assert.equal(await adapter.read('Target/ONE.md'),'external');assert.equal(ui.workspace.vault.entries.has('Target/One.md'),false);
});

test('deleting selected items prunes selection so remaining selected files can still be dragged',async t=>{
 const ui=await setup(t,{'One.md':'one','Two.md':'two','Target/Keep.md':'keep'});ui.state.treeSelection=new Set(['One.md','Two.md']);ui.state.treeSelectionAnchor='One.md';
 await ui.workspace.vault.trash('One.md');assert.deepEqual([...ui.state.treeSelection],['Two.md']);assert.equal(ui.state.treeSelectionAnchor,undefined);
 ui.drag(ui.row('Two.md'),'dragstart');ui.drag(ui.row('Target'),'drop');await until(()=>ui.workspace.vault.entries.has('Target/Two.md'));assert.equal(await ui.adapter.read('Target/Two.md'),'two');
});

test('new folder rejects a queued case-alias collision without creating a duplicate',async t=>{
 class SlowFolderAdapter extends MemoryAdapter{
  waiting=false;release!:()=>void;gate=new Promise<void>(resolve=>this.release=resolve);
  override async mkdir(path:string){if(path==='UNTITLED FOLDER'){this.waiting=true;await this.gate;}await super.mkdir(path);}
 }
 const adapter=new SlowFolderAdapter(),ui=await setup(t,{},adapter),first=ui.workspace.vault.createFolder('UNTITLED FOLDER');await until(()=>adapter.waiting);
 const second=ui.workspace.newFolder(),rejected=assert.rejects(second,/Path already exists/);await Promise.resolve();await Promise.resolve();adapter.release();
 await first;await rejected;assert.equal(ui.workspace.vault.entries.has('Untitled folder'),false);assert.ok(ui.workspace.vault.entries.has('UNTITLED FOLDER'));
});

test('a pending folder creation does not steal focus after switching explorer tabs',async t=>{
 class SlowFolderAdapter extends MemoryAdapter{
  waiting=false;release!:()=>void;gate=new Promise<void>(resolve=>this.release=resolve);
  override async mkdir(path:string){this.waiting=true;await this.gate;await super.mkdir(path);}
 }
 const adapter=new SlowFolderAdapter(),ui=await setup(t,{},adapter),creating=ui.workspace.newFolder();await until(()=>adapter.waiting);
 ui.root.querySelector<HTMLButtonElement>('.sidebar-tabs [data-type="search"]')!.click();adapter.release();await creating;
 assert.ok(ui.workspace.vault.entries.has('Untitled folder'));assert.equal(ui.state.treeTab,'search');assert.equal(ui.root.querySelector('[contenteditable="true"]'),null);
});

test('new folder cannot target a parent deleted and recreated by earlier queued operations',async t=>{
 class SlowWriteAdapter extends MemoryAdapter{
  waiting=false;release!:()=>void;gate=new Promise<void>(resolve=>this.release=resolve);
  override async write(path:string,text:string){if(path==='Block.md'){this.waiting=true;await this.gate;}await super.write(path,text);}
 }
 const adapter=new SlowWriteAdapter({'Block.md':'old','Parent/Keep.md':'keep'}),ui=await setup(t,{},adapter);
 const blocking=ui.workspace.vault.modify('Block.md','new');await until(()=>adapter.waiting);
 const deleting=ui.workspace.vault.trash('Parent'),recreating=ui.workspace.vault.createFolder('Parent'),creating=ui.workspace.newFolder('Parent');
 const rejected=assert.rejects(creating,/destination folder has changed/);await Promise.resolve();await Promise.resolve();adapter.release();await Promise.all([blocking,deleting,recreating,rejected]);
 assert.ok(ui.workspace.vault.entries.has('Parent'));assert.equal(ui.workspace.vault.entries.has('Parent/Untitled folder'),false);
});

for(const activation of ['click','Enter',' '] as const)test(`folder ${JSON.stringify(activation)} preserves row focus for the following F2 rename`,async t=>{
 const ui=await setup(t,{'Folder/Child.md':'child'}),original=ui.row('Folder');original.focus();
 if(activation==='click')original.querySelector('.tree-label')!.dispatchEvent(new ui.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
 else ui.key(original,activation);
 const current=ui.row('Folder');assert.notEqual(current,original,'folder toggle rebuilds the row');assert.equal(current.getAttribute('aria-expanded'),'false');
 assert.equal(ui.dom.window.document.activeElement,current,'folder activation transfers focus to its rebuilt row');
 ui.key(ui.dom.window.document.activeElement as HTMLElement,'F2');
 await until(()=>ui.row('Folder').querySelector('.tree-label')?.getAttribute('contenteditable')==='true');
 assert.equal(ui.dom.window.document.activeElement,ui.row('Folder').querySelector('.tree-label'));
});

test('unrelated sidebar rebuilds do not pull focus from another control',async t=>{
 const ui=await setup(t,{'Folder/Child.md':'child'}),control=ui.dom.window.document.createElement('input');ui.root.append(control);control.focus();
 await ui.workspace.vault.createFolder('Other');
 assert.equal(ui.dom.window.document.activeElement,control);assert.equal(ui.root.querySelector('.tree-label[contenteditable]'),null);
});

test('file tree hides recognized suffixes, keeps unknown ones, and exposes distinct full paths',async t=>{
 const paths=['Same.md','Same.pdf','Same.CANVAS','Same.base','Same.PNG','Same.mp3','Same.webm','Same.UNKNOWN','File.constructor','File.__proto__','Folder.pdf/Child.md'];
 const ui=await setup(t,Object.fromEntries(paths.map(path=>[path,path.endsWith('.CANVAS')?'{}':''])));
 for(const path of paths.slice(0,-1)){
  const row=ui.row(path);
  assert.equal(row.querySelector('.tree-label')!.textContent,path.endsWith('.UNKNOWN')||path.startsWith('File.')?path:'Same');
  assert.equal(row.getAttribute('aria-label'),path);assert.equal(row.title,path);
 }
 assert.equal(ui.row('Folder.pdf').querySelector('.tree-label')!.textContent,'Folder.pdf');
 ui.key(ui.row('Same.PNG'),'F2');await until(()=>!!ui.state.treeRename);
 assert.equal(ui.row('Same.PNG').querySelector('.tree-label')!.textContent,'Same.PNG','rename still exposes the complete filename');
 ui.key(ui.row('Same.PNG').querySelector<HTMLElement>('.tree-label')!,'Escape');
 assert.equal(ui.row('Same.PNG').querySelector('.tree-label')!.textContent,'Same');
 assert.ok(ui.workspace.vault.entries.has('Same.PNG'),'display policy does not rename files');
});
