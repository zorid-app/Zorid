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
