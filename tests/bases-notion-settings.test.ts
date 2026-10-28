import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {BaseToolbarSaveError,createBaseToolbar} from '../src/bases/toolbar.ts';
import type {BaseToolbarOptions} from '../src/bases/toolbar.ts';
import type {BaseViewPatch} from '../src/bases/document.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function fixture(extra:Partial<BaseToolbarOptions>={},browseOnly=false){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse('pluginRoot: keep\nviews: [{type: table, name: Library, order: [file.name, score], pluginView: keep}]');let version=1;
 const calls:unknown[][]=[],errors:unknown[]=[];let hold:ReturnType<typeof deferred>|undefined,fail=false,edited=0;
 const publish=(patch:BaseViewPatch)=>{document.updateView(0,patch);version++;refresh();};
 const update=async(expected:unknown,index:number,patch:BaseViewPatch)=>{assert.equal(expected,version);assert.equal(index,0);calls.push(['update',expected,patch]);if(hold)await hold.promise;if(fail){fail=false;throw new BaseToolbarSaveError('Disk unavailable',async()=>publish(patch));}publish(patch);};
 const options:BaseToolbarOptions={immediate:true,preflight(){},async selectView(){},save:(version,patch)=>update(version,0,patch),commands:{updateView:update,async updateRoot(version,patch){calls.push(['root',version,patch]);}},onNew:async()=>{calls.push(['new']);},onEditProperties(){assert.equal(doc.querySelector('[role=dialog]'),null);edited++;},onDraftChange(){},onError:error=>errors.push(error),...extra};
 const toolbar=createBaseToolbar(doc.querySelector('main')!,options);
 function refresh(){const result=executeBaseQuery(document,{version,files:[{path:'Book.md',properties:{score:3}}]});toolbar.update({result,views:document.views,selectedIndex:0,root:{pluginRoot:'keep'},readOnly:false,browseOnly,allowRename:true,label:property=>property==='note.score'?'Rating':property==='file.name'?'Name':property,sourceLabel:'Books'});}
 refresh();const get=<T extends HTMLElement>(label:string)=>{const element=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(element,label);return element;};
 const click=(label:string)=>get<HTMLButtonElement>(label).click();const row=(setting:string)=>{const element=doc.querySelector<HTMLButtonElement>(`[data-setting="${setting}"]`);assert.ok(element,setting);return element;};
 const key=(element:HTMLElement,key:string)=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});element.dispatchEvent(event);return event;};
 return{dom,doc,toolbar,document,calls,errors,get,click,row,key,edited:()=>edited,refresh,hold(){hold=deferred();return()=>{hold!.resolve();hold=undefined;};},fail(){fail=true;},close(){toolbar.destroy();dom.window.close();}};
}
test('Settings overview exposes supported view and source commands with clear hierarchy',()=>{
 const f=fixture();try{f.click('Settings');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'View settings');assert.equal(f.get<HTMLInputElement>('View name').value,'Library');assert.match(f.row('layout').textContent??'',/Table/);assert.match(f.row('property-visibility').textContent??'',/2/);assert.match(f.row('source').textContent??'',/Books/);assert.equal(f.row('source').getAttribute('role'),null);assert.ok(f.row('edit-properties'));assert.doesNotMatch(f.doc.querySelector('[role=dialog]')!.textContent??'',/Automations|AI Autofill|Conditional color|Lock database/);f.click('Edit properties');assert.equal(f.edited(),1);}finally{f.close();}
});
test('menu pointer hover and arrows/Home/End update the active row, Enter and Space open subpanels',()=>{
 const f=fixture();try{f.click('Settings');f.row('sort').dispatchEvent(new f.dom.window.MouseEvent('mouseenter'));assert.equal(f.row('sort').classList.contains('is-active'),true);f.key(f.row('sort'),'ArrowDown');assert.equal(f.doc.activeElement,f.row('group'));f.key(f.row('group'),'Home');assert.equal(f.doc.activeElement,f.row('layout'));f.key(f.row('layout'),'End');assert.equal(f.doc.activeElement,f.row('more-view-actions'));f.key(f.row('more-view-actions'),'Home');f.key(f.row('layout'),'Enter');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'View options');assert.equal(f.doc.querySelector('h3')?.textContent?.includes('Layout'),true);f.click('Back');f.row('sort').focus();f.key(f.row('sort'),' ');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'Sort');}finally{f.close();}
});
test('Escape from a clean settings subpanel returns focus to its persistent Settings trigger',()=>{
 const f=fixture();try{f.click('Settings');f.row('sort').click();const focused=f.doc.activeElement as HTMLElement;f.key(focused,'Escape');assert.equal(f.doc.querySelector('[role=dialog]'),null);assert.equal(f.doc.activeElement,f.get('Settings'));}finally{f.close();}
});
test('Layout tiles use supported names while preserving persisted type and unrelated configuration',async()=>{
 const f=fixture();try{f.click('Settings');f.click('Layout');assert.deepEqual([...f.doc.querySelectorAll('[data-layout]')].map(node=>[node.getAttribute('data-layout'),node.textContent]),[['table','Table'],['cards','Gallery'],['list','List'],['kanban','Board']]);f.click('Board');await new Promise(resolve=>setTimeout(resolve,280));assert.equal(f.document.views[0].type,'kanban');assert.equal(f.document.views[0].pluginView,'keep');assert.equal(f.document.getRoot('pluginRoot'),'keep');assert.equal(f.get<HTMLInputElement>('Column width').value,'276');f.click('Load limit');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'Results');f.click('Back');assert.ok(f.doc.querySelector('[data-layout]'));}finally{f.close();}
});
test('dirty view-name navigation waits for its accepted save and retains the target panel',async()=>{
 const f=fixture();try{f.click('Settings');const input=f.get<HTMLInputElement>('View name'),release=f.hold();input.value='Reading';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.click('Layout');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'View settings');assert.equal(f.toolbar.hasDraft(),true);release();await tick();assert.equal(f.document.views[0].name,'Reading');assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'View options');assert.deepEqual(f.calls,[['update',1,{name:'Reading'}]]);}finally{f.close();}
});
test('invalid names and retained persistence failures cannot discard drafts by opening another settings panel',async()=>{
 const f=fixture();try{f.click('Settings');const input=f.get<HTMLInputElement>('View name');input.value='';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.click('Layout');await tick();assert.equal(input.isConnected,true);assert.equal(input.value,'');assert.equal(f.calls.length,0);assert.equal(f.toolbar.hasDraft(),true);input.value='Retained';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.fail();f.row('sort').click();await tick();assert.equal(input.isConnected,true);assert.equal(input.disabled,true);assert.equal(f.doc.querySelector('[role=dialog]')?.getAttribute('aria-label'),'View settings');assert.match(f.doc.querySelector('[role=alert]')?.textContent??'',/Disk unavailable/);f.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await tick();assert.equal(f.document.views[0].name,'Retained');assert.equal(f.calls.length,1,'Retry finishes original save without replaying rename');}finally{f.close();}
});
test('untyped views hide schema-only commands, and New split exists only for actual creation options',()=>{
 const f=fixture({},true);try{f.click('Settings');assert.equal(f.doc.querySelector('[data-setting=property-visibility]'),null);assert.equal(f.doc.querySelector('[data-setting=group]'),null);assert.equal(f.doc.querySelector('[data-setting=edit-properties]'),null);assert.ok(f.row('filter'));assert.ok(f.get('New item options'));}finally{f.close();}
 const bare=fixture({commands:undefined});try{assert.equal(bare.doc.querySelector('[aria-label="New item options"]'),null);}finally{bare.close();}
});

test('a later Close cancels queued settings navigation while preserving the accepted rename',async()=>{
 const f=fixture();try{f.click('Settings');const input=f.get<HTMLInputElement>('View name'),release=f.hold();input.value='Accepted';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.row('layout').click();f.click('Close settings');release();await tick();assert.equal(f.document.views[0].name,'Accepted');assert.equal(f.doc.querySelector('[role=dialog]'),null);assert.equal(f.toolbar.hasDraft(),false);}finally{f.close();}
});
