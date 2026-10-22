import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar, BaseToolbarSaveError} from '../src/bases/toolbar.ts';
import {validateToolbarPatch} from '../src/bases/toolbar-config.ts';
import {uniqueViewName,validateViewName,propertyDisplayPatch} from '../src/bases/toolbar-panels.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(immediate=false){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const source=BaseDocument.parse('filters: "true"\nformulas: {double: "score * 2"}\nproperties: {score: {displayName: Points, extension: keep}}\nviews:\n - {type: table, name: Library, order: [file.name, score]}\n - {type: cards, name: Covers}\n');
 const result=executeBaseQuery(source,{version:1,files:[{path:'Book.md',properties:{score:3}}]});
 const calls:unknown[][]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate,preflight(){},async selectView(index){calls.push(['select',index]);},async save(version,patch){calls.push(['save',version,patch]);},commands:{async addView(version,type,name){calls.push(['add',version,type,name]);},async updateView(version,index,patch){calls.push(['update',version,index,patch]);},async duplicateView(version,index,name){calls.push(['duplicate',version,index,name]);},async removeView(version,index){calls.push(['remove',version,index]);},async moveView(version,from,to){calls.push(['move',version,from,to]);},async setDefaultView(version,index){calls.push(['default',version,index]);},async updateRoot(version,patch){calls.push(['root',version,patch]);}},async saveConfiguration(version,patch){calls.push(['configuration',version,patch]);},onSearch(value){calls.push(['search',value]);},async onNew(){calls.push(['new']);},async onExport(format,copy){calls.push(['export',format,copy]);},onDraftChange(){},onError(error){errors.push(error);}});
 const root={filters:source.getRoot('filters')!,formulas:source.getRoot('formulas')!,properties:source.getRoot('properties')!};
 const state={result,views:source.views,selectedIndex:0,root,rootFilters:root.filters,readOnly:false,allowRename:true,label:(property:string)=>property}; toolbar.update(state);
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};
 const click=(label:string)=>get<HTMLButtonElement>(label).click();
 const input=(label:string,value:string,event='input')=>{const node=get<HTMLInputElement>(label);node.value=value;node.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
 const submit=()=>doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 return{dom,doc,toolbar,result,state,calls,errors,get,click,input,submit,cleanup(){toolbar.destroy();dom.window.close();}};
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

test('external view reorder closes a clean configuration menu and retired actions cannot retarget',async()=>{
 const f=fixture(true);try{
  f.click('Views');f.click('Configure view Library');f.click('View actions');const deleteOld=f.get<HTMLButtonElement>('Delete view');
  const views=[f.state.views[1],f.state.views[0]];f.toolbar.update({...f.state,views,result:{...f.result,version:2,view:views[0]}});
  assert.equal(f.doc.querySelector('[role="dialog"]'),null,'external configuration invalidates the clean menu');deleteOld.click();await tick();assert.equal(f.calls.length,0,'retired action cannot select a new target');
 }finally{f.cleanup();}
});
test('same-name external sort changes invalidate cloned controls instead of adopting a fresh version',async()=>{
 const f=fixture(true);try{
  f.click('Sort');const retiredAdd=f.get<HTMLButtonElement>('Add sort');assert.equal(f.doc.querySelector('[aria-label="Sort property"]'),null);
  const view={...f.state.views[0],sort:[{property:'note.score',direction:'DESC'}]};const views=[view,f.state.views[1]];f.toolbar.update({...f.state,views,result:{...f.result,version:2,view}});
  assert.equal(f.doc.querySelector('[role="dialog"]'),null,'external sort closes the obsolete editor');f.click('Sort');assert.equal(f.get<HTMLSelectElement>('Sort property').value,'note.score');assert.equal(f.get<HTMLSelectElement>('Sort direction').value,'DESC');
  // Retained native DOM nodes cannot submit an old editor after it is retired.
  retiredAdd.click();await new Promise(resolve=>setTimeout(resolve,270));assert.equal(f.calls.length,0);
 }finally{f.cleanup();}
});

test('actual query-backed immediate Group edits manual visibility and creates an empty group',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let document=BaseDocument.parse('views: [{type: table, name: A, groupBy: {property: status, direction: ASC}}]'),version=1;
 const files=[{path:'One.md',properties:{status:'Todo'}},{path:'Two.md',properties:{status:'Done'}}],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(expected,patch){assert.equal(expected,version);document.updateView(0,patch);version++;refresh();},onDraftChange(){},onError(error){errors.push(error);}});
 let current:ReturnType<typeof executeBaseQuery>;
 function refresh(){current=executeBaseQuery(document,{version,files});toolbar.update({result:current,views:document.views,selectedIndex:0,readOnly:false,allowRename:true,label:p=>p,propertyType:()=> 'text'});}refresh();
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};const settle=()=>new Promise(resolve=>setTimeout(resolve,280));
 try{
  get<HTMLButtonElement>('Group').click();const direction=get<HTMLSelectElement>('Group direction');direction.value='MANUAL';direction.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();assert.deepEqual(document.views[0].groupOrder,[]);assert.equal(current!.rows.length,0);
  get<HTMLInputElement>('Show group Todo').click();await settle();assert.deepEqual(document.views[0].groupOrder,['Todo']);assert.deepEqual(current!.rows.map(row=>row.path),['One.md']);
  get<HTMLButtonElement>('Add group').click();get<HTMLInputElement>('Group name').value='Blocked';assert.equal(toolbar.hasDraft(),true);get<HTMLButtonElement>('Create group').click();await settle();assert.deepEqual(document.views[0].groupOrder,['Todo','Blocked']);assert.equal(current!.groupOptions.find(group=>group.key.type==='string'&&group.key.value==='Blocked')?.count,0);assert.equal(get<HTMLInputElement>('Show group Blocked').checked,true);assert.equal(toolbar.hasDraft(),false);assert.deepEqual(errors,[]);
 }finally{toolbar.destroy();dom.window.close();}
});

test('nested searchable combobox keeps keyboard and Escape ownership inside the toolbar menu',()=>{
 const f=fixture(true);try{
  f.click('Views');f.click('Configure view Library');const combo=f.doc.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Layout"]')!;assert.ok(combo);combo.focus();combo.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.ok(f.doc.querySelector('[role="listbox"]'));
  const search=f.doc.querySelector<HTMLInputElement>('[role="searchbox"]')!;assert.ok(search);search.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('[role="listbox"]'),null);assert.ok(f.doc.querySelector('[role="dialog"]'),'first Escape closes only the picker');assert.equal(f.doc.activeElement,combo);
  combo.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('[role="dialog"]'),null,'next Escape closes the configuration menu');
 }finally{f.cleanup();}
});

test('reference Add view commits its name on Enter and continues in the new view configuration',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse('views: [{type: table, name: A}]');let version=1,selectedIndex=0;
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(index){selectedIndex=index;refresh();},async save(){},commands:{async addView(expected,type,name){assert.equal(expected,version);selectedIndex=document.addView(type,name!);version++;refresh();},async updateView(){}},onDraftChange(){},onError(error){throw error;}});
 function refresh(){const result=executeBaseQuery(document,{version,files:[]},{viewIndex:selectedIndex});toolbar.update({result,views:document.views,selectedIndex,readOnly:false,allowRename:true,label:p=>p});}refresh();
 try{doc.querySelector<HTMLButtonElement>('[aria-label="Views"]')!.click();doc.querySelector<HTMLButtonElement>('[aria-label="Add view"]')!.click();assert.equal(doc.querySelector<HTMLElement>('.bases-toolbar-footer')?.hidden,true);const name=doc.querySelector<HTMLInputElement>('[aria-label="View name"]')!;name.value='New view';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));name.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.equal(document.views.at(-1)?.name,'New view');assert.equal(doc.querySelector('[role="dialog"]')?.getAttribute('aria-label'),'View options');assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="View name"]')?.value,'New view');assert.equal(toolbar.hasDraft(),false);}finally{toolbar.destroy();dom.window.close();}
});

test('unchanged configuration can adopt a note-only refresh before saving a retained toolbar draft',async()=>{
 const f=fixture(true);try{
  f.click('Views');f.click('Configure view Library');const name=f.get<HTMLInputElement>('View name');name.value='Books';name.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.toolbar.update({...f.state,result:{...f.result,version:2}});assert.equal(name.isConnected,true);name.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();assert.deepEqual(f.calls.pop(),['update',2,0,{type:'table',name:'Books'}]);
 }finally{f.cleanup();}
});

test('reference Add formula creates a visible field, then expression and identity edits persist in place',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let document=BaseDocument.parse('views: [{type: table, name: A, order: [file.name]}]');let version=1;const calls:unknown[][]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(){},commands:{async updateRoot(){},async editFormula(expected,original,name,expression){assert.equal(expected,version);calls.push([original,name,expression]);if(original&&original!==name)document.renameFormula(original,name);document.setFormula(name,expression);if(original===undefined){const order=document.views[0].order as string[];document.updateView(0,{order:[...order,`formula.${name}`]});}document=BaseDocument.parse(document.toString());version++;refresh();}},onDraftChange(){},onError(error){errors.push(error);}});
 function refresh(){const result=executeBaseQuery(document,{version,files:[{path:'One.md',properties:{score:4}}]});const root=Object.fromEntries(['formulas','properties','filters','summaries'].map(key=>[key,document.getRoot(key)]).filter(([,value])=>value!==undefined));toolbar.update({result,views:document.views,root:root as any,selectedIndex:0,readOnly:false,allowRename:true,label:p=>p});}refresh();
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};const settle=()=>new Promise(resolve=>setTimeout(resolve,280));
 try{
  get<HTMLButtonElement>('Properties').click();get<HTMLButtonElement>('Add formula').click();await tick();assert.deepEqual(calls[0],[undefined,'Untitled','']);assert.deepEqual(document.views[0].order,['file.name','formula.Untitled']);assert.equal(doc.querySelector<HTMLElement>('.bases-toolbar-footer')?.hidden,true);
  const expression=get<HTMLTextAreaElement>('Formula expression');expression.focus();expression.value='score * 2';expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle();assert.equal((document.getRoot('formulas') as any).Untitled,'score * 2');assert.equal(expression.isConnected,true);
  const name=get<HTMLInputElement>('Formula name');name.focus();name.value='Twice';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));name.blur();await tick();assert.equal((document.getRoot('formulas') as any).Twice,'score * 2',JSON.stringify({errors:errors.map(String),calls,text:doc.body.textContent}));assert.deepEqual(document.views[0].order,['file.name','formula.Twice']);assert.equal(expression.isConnected,true);
  expression.focus();expression.value='score * 3';expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle();assert.deepEqual(calls.at(-1),['Twice','Twice','score * 3']);assert.equal(toolbar.hasDraft(),false);assert.deepEqual(errors,[]);
 }finally{toolbar.destroy();dom.window.close();}
});

test('property and sort grip drops reorder only their live configuration panel',async()=>{
 const f=fixture(),other=fixture();
 const transfer={types:[] as string[],payload:'',effectAllowed:'',setData(kind:string,value:string){this.types=[kind];this.payload=value;},getData(){return this.payload;}};
 const dispatch=(owner:ReturnType<typeof fixture>,node:HTMLElement,type:string)=>{const event=new owner.dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});node.dispatchEvent(event);};
 try{
  f.click('Properties');other.click('Properties');let source=f.doc.querySelectorAll<HTMLElement>('.bases-property-grip')[1],target=other.doc.querySelector<HTMLElement>('.bases-toolbar-property-row')!;dispatch(f,source,'dragstart');dispatch(other,target,'drop');other.submit();await tick();assert.equal(other.calls.length,0,'foreign property drag changes nothing');
  target=f.doc.querySelector<HTMLElement>('.bases-toolbar-property-row')!;dispatch(f,source,'dragstart');dispatch(f,target,'drop');f.submit();await tick();assert.deepEqual(f.calls.pop(),['save',1,{order:['note.score','file.name']}]);
  const view={...f.state.views[0],sort:[{property:'file.name',direction:'ASC'},{property:'note.score',direction:'DESC'}]};f.toolbar.update({...f.state,views:[view,f.state.views[1]],result:{...f.result,view}});f.click('Sort');source=f.doc.querySelectorAll<HTMLElement>('.bases-sort-grip')[1];target=f.doc.querySelector<HTMLElement>('.bases-toolbar-rule')!;dispatch(f,source,'dragstart');dispatch(f,target,'drop');f.submit();await tick();assert.deepEqual(f.calls.pop(),['save',1,{sort:[{property:'note.score',direction:'DESC'},{property:'file.name',direction:'ASC'}]}]);
 }finally{f.cleanup();other.cleanup();}
});

test('persistence retry settles its original generation then saves the newer queued form exactly once',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let document=BaseDocument.parse('views: [{type: table, name: A}]'),version=1;
 const calls:unknown[][]=[];let rejectFirst:((error:unknown)=>void)|undefined,retries=0;
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(expected,patch){calls.push([expected,patch]);assert.equal(expected,version);if(calls.length===1)await new Promise<void>((_resolve,reject)=>{rejectFirst=reject;});document.updateView(0,patch);document=BaseDocument.parse(document.toString());version++;refresh();},onDraftChange(){},onError(){}});
 function refresh(){const result=executeBaseQuery(document,{version,files:[]});toolbar.update({result,views:document.views,selectedIndex:0,readOnly:false,allowRename:true,label:p=>p});}refresh();
 try{
  doc.querySelector<HTMLButtonElement>('[aria-label="Results"]')!.click();const input=doc.querySelector<HTMLInputElement>('[aria-label="Limit"]')!;input.focus();input.value='10';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,280));assert.equal(calls.length,1);
  input.value='20';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));rejectFirst!(new BaseToolbarSaveError('disk failed',async()=>{retries++;document.updateView(0,{limit:10});document=BaseDocument.parse(document.toString());version++;refresh();}));await tick();assert.equal(input.value,'20');assert.equal(input.disabled,true);
  const retry=doc.querySelector<HTMLButtonElement>('button[type="submit"]')!;assert.equal(retry.textContent,'Retry save');retry.click();await tick();await tick();assert.deepEqual(calls,[[1,{limit:10}],[2,{limit:20}]]);assert.equal(retries,1);assert.equal(document.views[0].limit,20);assert.equal(toolbar.hasDraft(),false);assert.equal(doc.querySelector('[role="dialog"]'),null);
 }finally{toolbar.destroy();dom.window.close();}
});

test('formula retry preserves its accepted identity before applying a newer queued rename',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let document=BaseDocument.parse('formulas: {Original: "score * 2"}\nviews: [{type: table, name: A, order: [file.name, formula.Original]}]'),version=1,pendingDocument:BaseDocument|undefined;
 const calls:unknown[][]=[];let rejectFirst:((error:unknown)=>void)|undefined;
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(){},commands:{async updateRoot(){},async editFormula(expected,original,name,expression){assert.equal(expected,version);calls.push([original,name,expression]);const next=BaseDocument.parse(document.toString());if(original&&original!==name)next.renameFormula(original,name);next.setFormula(name,expression);if(calls.length===1){pendingDocument=next;await new Promise<void>((_resolve,reject)=>{rejectFirst=reject;});}document=BaseDocument.parse(next.toString());version++;refresh();}},onDraftChange(){},onError(){}});
 function refresh(){const result=executeBaseQuery(document,{version,files:[{path:'One.md',properties:{score:4}}]});toolbar.update({result,views:document.views,root:{formulas:document.getRoot('formulas')!},selectedIndex:0,readOnly:false,allowRename:true,label:p=>p});}refresh();
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};
 try{
  get<HTMLButtonElement>('Properties').click();get<HTMLButtonElement>('Configure property formula.Original').click();get<HTMLButtonElement>('Edit formula').click();const name=get<HTMLInputElement>('Formula name');name.focus();name.value='Accepted';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));name.blur();await tick();assert.equal(calls.length,1);
  name.focus();name.value='Newest';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));name.blur();rejectFirst!(new BaseToolbarSaveError('disk failed',async()=>{document=BaseDocument.parse(pendingDocument!.toString());version++;refresh();}));await tick();assert.equal(name.value,'Newest');doc.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();await tick();await tick();assert.deepEqual(calls,[['Original','Accepted','score * 2'],['Accepted','Newest','score * 2']]);assert.deepEqual(document.views[0].order,['file.name','formula.Newest']);assert.equal((document.getRoot('formulas') as any).Newest,'score * 2');assert.equal(toolbar.hasDraft(),false);
 }finally{toolbar.destroy();dom.window.close();}
});
