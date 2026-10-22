import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar, BaseToolbarSaveError} from '../src/bases/toolbar.ts';
import {validateToolbarPatch} from '../src/bases/toolbar-config.ts';
import {uniqueViewName,validateViewName,propertyDisplayPatch} from '../src/bases/toolbar-panels.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const source=BaseDocument.parse('filters: "true"\nformulas: {double: "score * 2"}\nproperties: {score: {displayName: Points, extension: keep}}\nviews:\n - {type: table, name: Library, order: [file.name, score]}\n - {type: cards, name: Covers}\n');
 const result=executeBaseQuery(source,{version:1,files:[{path:'Book.md',properties:{score:3}}]});
 const calls:unknown[][]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{preflight(){},async selectView(index){calls.push(['select',index]);},async save(version,patch){calls.push(['save',version,patch]);},commands:{async addView(version,type,name){calls.push(['add',version,type,name]);},async updateView(version,index,patch){calls.push(['update',version,index,patch]);},async duplicateView(version,index,name){calls.push(['duplicate',version,index,name]);},async removeView(version,index){calls.push(['remove',version,index]);},async moveView(version,from,to){calls.push(['move',version,from,to]);},async setDefaultView(version,index){calls.push(['default',version,index]);},async updateRoot(version,patch){calls.push(['root',version,patch]);}},async saveConfiguration(version,patch){calls.push(['configuration',version,patch]);},onSearch(value){calls.push(['search',value]);},async onNew(){calls.push(['new']);},async onExport(format,copy){calls.push(['export',format,copy]);},onDraftChange(){},onError(error){errors.push(error);}});
 const root={filters:source.getRoot('filters')!,formulas:source.getRoot('formulas')!,properties:source.getRoot('properties')!};
 toolbar.update({result,views:source.views,selectedIndex:0,root,rootFilters:root.filters,readOnly:false,allowRename:true,label:property=>property});
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};
 const click=(label:string)=>get<HTMLButtonElement>(label).click();
 const input=(label:string,value:string,event='input')=>{const node=get<HTMLInputElement>(label);node.value=value;node.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
 const submit=()=>doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 return{dom,doc,toolbar,result,calls,errors,get,click,input,submit,cleanup(){toolbar.destroy();dom.window.close();}};
}
test('view menu searches, switches, creates collision-safe names and configures other views',async()=>{
 const f=fixture();try{
  f.click('Views');f.input('Find a view','cover');assert.equal(f.doc.querySelector('[aria-label="Open view Library"]'),null);f.click('Open view Covers');await tick();assert.deepEqual(f.calls.pop(),['select',1]);
  f.click('Views');f.click('Add view');f.input('View name','Gallery');f.input('Layout','cards','change');f.submit();await tick();assert.deepEqual(f.calls.pop(),['add',1,'cards','Gallery']);
  f.click('Views');f.click('Configure view Covers');f.input('View name','Pictures');f.submit();await tick();assert.deepEqual(f.calls.pop(),['update',1,1,{type:'cards',name:'Pictures'}]);
 }finally{f.cleanup();}
});
test('view actions keep version and identity and failed controls do not mutate',async()=>{
 const f=fixture();try{f.click('Views');f.click('Configure view Covers');f.click('Set as default view');await tick();assert.deepEqual(f.calls.pop(),['default',1,1]);f.click('Views');f.click('Configure view Library');f.click('Duplicate view');await tick();assert.deepEqual(f.calls.pop(),['duplicate',1,0,'Library 2']);}finally{f.cleanup();}
});
test('root and view filters apply atomically while retaining both scopes',async()=>{
 const f=fixture();try{f.click('Filter');f.click('Add expression');f.click('All views');f.click('Add expression');f.submit();await tick();const call=f.calls.pop();assert.equal(call?.[0],'configuration');assert.deepEqual(call?.[2],{view:{filters:'true'},root:{filters:{and:['true','true']}}});}finally{f.cleanup();}
});
test('search is transient and Escape clears it; Results copy uses current-session export',async()=>{
 const f=fixture();try{f.click('Search');f.input('Search base','book');assert.deepEqual(f.calls.pop(),['search','book']);f.get('Search base').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.deepEqual(f.calls.pop(),['search','']);f.click('Results');f.click('Copy');await tick();assert.deepEqual(f.calls.pop(),['export','tsv',true]);f.click('New');await tick();assert.deepEqual(f.calls.pop(),['new']);}finally{f.cleanup();}
});
test('layout and limit validation rejects invalid values without affecting extension preservation',()=>{
 const f=fixture();try{for(const patch of [{limit:-1},{limit:1.2},{cardSize:801},{columnWidth:0},{imageAspectRatio:0},{imageFit:'stretch'},{markers:'circle'},{indentProperties:'yes'}])assert.throws(()=>validateToolbarPatch(f.result,patch));assert.deepEqual(validateToolbarPatch(f.result,{limit:30,rowHeight:'tall',imageFit:'contain',cardSize:200}),{limit:30,rowHeight:'tall',imageFit:'contain',cardSize:200});}finally{f.cleanup();}
});
test('view names and display labels are reusable configuration with extensions retained',()=>{
 assert.equal(uniqueViewName([{type:'table',name:'View'},{type:'cards',name:'View 2'}]),'View 3');assert.throws(()=>validateViewName([],'x#y'));assert.throws(()=>validateViewName([{type:'table',name:'Books'}],'Books'));
 assert.deepEqual(propertyDisplayPatch({properties:{score:{displayName:'Old',extension:'keep'}}},new Map([['score','Points']])),{properties:{score:{displayName:'Points',extension:'keep'}}});
});

test('view drag owns its live toolbar and rejects another toolbar or retired source',async()=>{
 const a=fixture(),b=fixture();
 const transfer={types:['application/x-zorid-base-view'],payload:'',effectAllowed:'',setData(_kind:string,value:string){this.payload=value;},getData(){return this.payload;}};
 const dispatch=(f:ReturnType<typeof fixture>,node:HTMLElement,type:string)=>{const event=new f.dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});node.dispatchEvent(event);};
 try{
  a.click('Views');b.click('Views');const source=a.doc.querySelector<HTMLElement>('[data-view-index="0"]')!,target=b.doc.querySelector<HTMLElement>('[data-view-index="1"]')!;
  dispatch(a,source,'dragstart');dispatch(b,target,'drop');await tick();assert.equal(b.calls.length,0,'foreign toolbar drag cannot reorder this base');
  a.click('Views');dispatch(a,source,'dragstart');const reopen=a.doc.querySelector<HTMLElement>('[data-view-index="1"]');assert.equal(reopen,null);a.click('Views');dispatch(a,a.doc.querySelector<HTMLElement>('[data-view-index="1"]')!,'drop');await tick();assert.equal(a.calls.length,0,'retired source cannot restart a drag');
  const ownSource=a.doc.querySelector<HTMLElement>('[data-view-index="0"]')!,ownTarget=a.doc.querySelector<HTMLElement>('[data-view-index="1"]')!;dispatch(a,ownSource,'dragstart');dispatch(a,ownTarget,'drop');await tick();assert.deepEqual(a.calls.pop(),['move',1,0,1]);
 }finally{a.cleanup();b.cleanup();}
});

test('immediate mode serializes edits, rebases its own result and keeps the focused menu',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let document=BaseDocument.parse('views: [{type: table, name: Library}]'),version=1;
 const result=()=>executeBaseQuery(document,{version,files:[{path:'Book.md',properties:{score:3}}]});
 const calls:{version:unknown;patch:unknown}[]=[];let release:undefined|(()=>void),blocked=true;
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(expected,patch){calls.push({version:expected,patch});if(blocked)await new Promise<void>(resolve=>{release=resolve;});assert.equal(expected,version,'accepted operation uses the refreshed revision');document.updateView(0,patch);version++;refresh();},onDraftChange(){},onError(error){throw error;}});
 function refresh(){const next=result();toolbar.update({result:next,views:document.views,selectedIndex:0,readOnly:false,allowRename:true,label:p=>p});}refresh();
 const get=<T extends HTMLElement>(label:string)=>doc.querySelector<T>(`[aria-label="${label}"]`)!;
 try{
  get<HTMLButtonElement>('View options').click();const layout=get<HTMLSelectElement>('Layout');layout.focus();layout.value='cards';layout.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,280));assert.equal(calls.length,1);assert.equal(doc.querySelector('.bases-toolbar-footer')?.hasAttribute('hidden'),true);
  const name=get<HTMLInputElement>('View name');name.value='Books';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));blocked=false;release!();await tick();await tick();assert.equal(calls.length,2);assert.equal(calls[1].version,2);assert.equal(document.views[0].name,'Books');assert.equal(doc.querySelector('[role="dialog"]')?.isConnected,true);assert.equal(name.isConnected,true);assert.equal(toolbar.hasDraft(),false);
  name.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(doc.querySelector('[role="dialog"]'),null);
 }finally{toolbar.destroy();dom.window.close();}
});
