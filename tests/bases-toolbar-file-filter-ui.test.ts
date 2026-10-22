import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import type {BaseValue,BaseViewPatch} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar,BaseToolbarSaveError} from '../src/bases/toolbar.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(filters?:BaseValue){
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
  const document=BaseDocument.parse(JSON.stringify({views:[{type:'table',name:'Library',...(filters===undefined?{}:{filters})},{type:'table',name:'Other'}]}));
  let version=1,selectedIndex=0,hook:((patch:Patch)=>Promise<void>)|undefined;
  type Patch={view?:BaseViewPatch;root?:Record<string,BaseValue|undefined>};
  const calls:Array<{version:unknown;patch:Patch}>=[],errors:unknown[]=[];
  const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_v,patch){commit({view:patch});},commands:{async updateRoot(){}},
    filterOperands:()=>({files:['Items/A "quoted".md'],folders:['/','Items'],tags:['#one','#two/child'],properties:['note.literal','status'],metadataStatus:'stale'}),
    async saveConfiguration(expected,patch){calls.push({version:expected,patch:structuredClone(patch)});if(hook)await hook(patch);else commit(patch);},onDraftChange(){},onError(error){errors.push(error);}});
  function refresh(){const result=executeBaseQuery(document,{version,files:[{path:'A.md',properties:{score:2}},{path:'B.md',properties:{score:5}}]},{viewIndex:selectedIndex});toolbar.update({result,views:document.views,selectedIndex,root:{...(document.getRoot('filters')===undefined?{}:{filters:document.getRoot('filters')!})},rootFilters:document.getRoot('filters'),readOnly:false,allowRename:true,label:p=>p==='file.file'?'file':p});}
  function commit(patch:Patch){if(patch.view)document.updateView(selectedIndex,patch.view);if(patch.root)document.updateRoot(patch.root);version++;refresh();}
  refresh();
  const get=<T extends HTMLElement>(label:string,scope:ParentNode=doc)=>{const node=scope.querySelector<T>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(node,label);return node;};
  const edit=(label:string,value:string,event='input',scope:ParentNode=doc)=>{const node=get<HTMLInputElement>(label,scope);node.value=value;node.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
  const click=(label:string)=>get<HTMLButtonElement>(label).click();
  const submit=()=>doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  return {dom,doc,document,toolbar,calls,errors,get,edit,click,submit,commit,setHook(value:typeof hook){hook=value;},switchView(){selectedIndex=1;version++;refresh();},refreshNote(){version++;refresh();},get version(){return version;},cleanup(){toolbar.destroy();dom.window.close();}};
}
test('initial and added blank File rows/groups stay local with zero saves, unchanged results and no draft guard',async()=>{
  const f=fixture();try{
    f.click('Filter');assert.equal(f.get<HTMLSelectElement>('Filter property').value,'file.file');assert.equal(f.get<HTMLSelectElement>('Condition').value,'hasLink');
    assert.equal(f.get<HTMLInputElement>('Filter value').value,'');assert.equal(f.doc.querySelector('.bases-filter-count:not([hidden])'),null);
    assert.deepEqual([...f.get<HTMLSelectElement>('Condition').options].map(item=>item.value),['hasLink','inFolder','hasTag','hasProperty','notHasLink','notInFolder','notHasTag','notHasProperty']);
    f.edit('Match','or','change');f.click('Add filter');f.click('Add filter group');f.submit();await tick();
    assert.equal(f.calls.length,0);assert.equal(f.version,1);assert.equal(f.toolbar.hasDraft(),false);assert.equal(f.get('Results').textContent?.trim(),'2 results');
    const focus=f.doc.activeElement!;focus.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('[role=dialog]'),null);
  }finally{f.cleanup();}
});
test('typed File targets save quoted literals and nested suggestion Escape does not dismiss Filter',async()=>{
  const f=fixture();try{
    f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');input.focus();
    input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.ok(f.doc.querySelector('[role=dialog]'));assert.equal(input.getAttribute('aria-expanded'),'false');
    f.edit('Filter value','Items/A "quoted".md');f.submit();await tick();await tick();
    assert.deepEqual(f.calls[0],{version:1,patch:{view:{filters:{and:['file.hasLink("Items/A \\"quoted\\".md")']}}}});
    assert.equal(f.doc.querySelector('.bases-filter-section-header[aria-label="This view"] .bases-filter-count')?.textContent,'1');
    assert.ok(f.doc.querySelector('[role=dialog]'),'own acknowledged save retains mounted controls');
  }finally{f.cleanup();}
});
test('variadic tag chips require committing pending text and preserve every inverse argument',async()=>{
  const f=fixture();try{
    f.click('Filter');f.edit('Condition','notHasTag','change');f.edit('Filter value','#one');f.submit();await tick();assert.equal(f.calls.length,0);assert.equal(f.toolbar.hasDraft(),true);
    let input=f.get<HTMLInputElement>('Filter value');input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    f.edit('Filter value','#two/child');input=f.get<HTMLInputElement>('Filter value');input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));f.submit();await tick();
    assert.deepEqual(f.calls[0].patch,{view:{filters:{and:['!file.hasTag("#one", "#two/child")']}}});
    assert.deepEqual([...f.doc.querySelectorAll('.bases-filter-operand-chip > span')].map(node=>node.textContent),['#one','#two/child']);
  }finally{f.cleanup();}
});
test('clearing an accepted clause blocks both scopes while explicit Remove keeps advanced syntax exact',async()=>{
  const f=fixture({and:['file.hasProperty("status")',' file.hasLink(link("A", "Alias")) ']});try{
    f.click('Filter');f.edit('Filter value','');f.click('All views');
    const root=f.doc.querySelectorAll('.bases-filter-section')[0];f.edit('Filter value','Items/A.md','input',root);f.submit();await tick();assert.equal(f.calls.length,0);
    f.get<HTMLButtonElement>('Remove filter',f.doc.querySelectorAll('.bases-filter-section')[1]).click();f.submit();await tick();
    assert.deepEqual(f.calls[0].patch,{root:{filters:{and:['file.hasLink("Items/A.md")']}},view:{filters:{and:[' file.hasLink(link("A", "Alias")) ']}}});
  }finally{f.cleanup();}
});
test('persisted empty OR and saved blank literals survive unrelated scope changes unchanged',async()=>{
  for(const filters of [{or:[]},{and:['file.hasLink("")','note.score == ""']}]){
    const f=fixture(filters);try{f.click('Filter');f.click('All views');const root=f.doc.querySelectorAll('.bases-filter-section')[0];f.edit('Filter value','status','input',root);f.submit();await tick();assert.deepEqual(f.calls[0].patch,{root:{filters:{and:['file.hasLink("status")']}}});assert.deepEqual(f.document.views[0].filters,filters);}finally{f.cleanup();}
  }
});
test('retired File picker cannot mutate a keyboard-switched view or replay a detached callback',async()=>{
  const f=fixture();try{
    f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');input.focus();const option=f.doc.querySelector<HTMLElement>('[role=option]')!;
    f.switchView();assert.equal(f.doc.querySelector('[role=dialog]'),null);option.click();input.value='A.md';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await tick();assert.equal(f.calls.length,0);
  }finally{f.cleanup();}
});
test('changing a saved single filter to None of the following persists actual NOT semantics',async()=>{
  const f=fixture('file.hasProperty("status")');try{
    f.click('Filter');f.edit('Match','not','change');f.submit();await tick();
    assert.deepEqual(f.calls[0].patch,{view:{filters:{not:['file.hasProperty("status")']}}});
  }finally{f.cleanup();}
});
test('failed accepted filter save retries its exact source before a newer queued clause',async()=>{
  const f=fixture();let reject:(error:unknown)=>void=()=>{};try{
    let first=true;f.setHook(async patch=>{if(first){first=false;await new Promise((_resolve,fail)=>{reject=fail;});}else f.commit(patch);});
    f.click('Filter');f.edit('Filter value','A.md');f.submit();await tick();f.edit('Filter value','B.md');
    reject(new BaseToolbarSaveError('disk failure',async()=>f.commit({view:{filters:{and:['file.hasLink("A.md")']}}})));await tick();f.submit();await tick();await tick();
    assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(call=>[call.version,call.patch]),[[1,{view:{filters:{and:['file.hasLink("A.md")']}}}],[2,{view:{filters:{and:['file.hasLink("B.md")']}}}]]);
  }finally{f.cleanup();}
});
test('invalid numeric draft cannot be discarded by switching to the expression editor',async()=>{
  const f=fixture('note.score > 1');try{
    f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');f.edit('Filter value','not a number');f.click('Edit expression');
    assert.equal(input.isConnected,true);assert.equal(input.value,'not a number');assert.equal(f.doc.querySelector('textarea[aria-label="Filter expression"]'),null);f.submit();await tick();assert.equal(f.calls.length,0);
    f.edit('Filter value','3');f.click('Edit expression');assert.equal(f.get<HTMLTextAreaElement>('Filter expression').value,'note["score"] > 3');f.submit();await tick();assert.deepEqual(f.calls[0].patch,{view:{filters:'note["score"] > 3'}});
  }finally{f.cleanup();}
});
test('pending tag text blocks property/operator/advanced rebuilds until explicitly committed',async()=>{
  const f=fixture();try{
    f.click('Filter');f.edit('Condition','hasTag','change');const input=f.get<HTMLInputElement>('Filter value');f.edit('Filter value',' unfinished ');
    f.edit('Condition','hasLink','change');assert.equal(f.get<HTMLSelectElement>('Condition').value,'hasTag');
    f.edit('Filter property','note.score','change');assert.equal(f.get<HTMLSelectElement>('Filter property').value,'file.file');
    f.click('Edit expression');assert.equal(input.isConnected,true);assert.equal(input.value,' unfinished ');assert.equal(f.doc.querySelector('textarea[aria-label="Filter expression"]'),null);f.submit();await tick();assert.equal(f.calls.length,0);
    input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));f.submit();await tick();assert.deepEqual(f.calls[0].patch,{view:{filters:{and:['file.hasTag(" unfinished ")']}}});
  }finally{f.cleanup();}
});
test('explicit Remove discards a new pending tag locally and clears its draft guard without saving',async()=>{
  const f=fixture();try{
    f.click('Filter');f.edit('Condition','hasTag','change');f.edit('Filter value','unfinished');assert.equal(f.toolbar.hasDraft(),true);
    f.click('Remove filter');assert.equal(f.toolbar.hasDraft(),false);f.submit();await tick();assert.equal(f.calls.length,0);assert.equal(f.version,1);
  }finally{f.cleanup();}
});
test('acknowledging an awaited new condition preserves its newer blank draft and saved authority',async()=>{
  const f=fixture();let release:()=>void=()=>{};try{
    f.setHook(async patch=>{await new Promise<void>(resolve=>{release=resolve;});f.commit(patch);});
    f.click('Filter');f.edit('Filter value','A.md');f.submit();await tick();const input=f.get<HTMLInputElement>('Filter value');f.edit('Filter value','');
    release();await tick();await tick();
    assert.deepEqual(f.document.views[0].filters,{and:['file.hasLink("A.md")']});assert.equal(input.isConnected,true);assert.equal(input.value,'');assert.equal(f.toolbar.hasDraft(),true);
    f.submit();await tick();assert.equal(f.calls.length,1,'Blank queued draft cannot remove the newly accepted condition');assert.match(f.doc.querySelector('[role=alert]')?.textContent??'',/invalid|existing filter/);
  }finally{f.cleanup();}
});
