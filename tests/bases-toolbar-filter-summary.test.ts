import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import type {BaseValue} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar} from '../src/bases/toolbar.ts';
import type {BaseToolbarState} from '../src/bases/toolbar.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture(rootFilters?:BaseValue,viewFilters?:BaseValue,explicitSource=false){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse(JSON.stringify({sentinel:'keep',...(rootFilters===undefined?{}:{filters:rootFilters}),views:[{type:'table',name:'Library',order:['file.name','note.score'],...(viewFilters===undefined?{}:{filters:viewFilters}),...(explicitSource?{source:{kind:'untyped'}}:{})}]}));
 let version=1,rejectSave=false;const saves:unknown[]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(){throw Error('Use combined configuration');},commands:{async updateRoot(){}},
  async saveConfiguration(_version,patch){saves.push(structuredClone(patch));if(rejectSave)throw Error('Rejected fixture save');if(patch.root)document.updateRoot(patch.root);if(patch.view)document.updateView(0,patch.view);refresh();},onDraftChange(){},onError:error=>errors.push(error)});
 function state():BaseToolbarState{return{result:executeBaseQuery(document,{version,files:[{path:'A.md',properties:{score:3}}]}),views:document.views,selectedIndex:0,rootFilters:document.getRoot('filters'),root:{sentinel:'keep',...(document.getRoot('filters')===undefined?{}:{filters:document.getRoot('filters')!})},readOnly:false,allowRename:true,label:property=>property==='note.score'?'Rating':property,propertyType:property=>property==='note.score'?'number':undefined};}
 function refresh(){version++;toolbar.update(state());}
 refresh();
 const filter=()=>{const node=doc.querySelector<HTMLButtonElement>('.bases-toolbar-actions [aria-label="Filter"]');assert.ok(node);return node;};
 const count=()=>filter().querySelector('.bases-toolbar-filter-count')?.textContent;
 return{dom,doc,document,toolbar,saves,errors,filter,count,refresh,rejectSave(){rejectSave=true;},close(){toolbar.destroy();dom.window.close();}};
}

test('inherited all-view filters have an active count and accessible scope summary without changing configuration',()=>{
 const f=fixture({and:['note.score > 1','file.ext == "md"']});try{
  const original=f.document.toString(),button=f.filter();
  assert.equal(button.classList.contains('is-active'),true);
  assert.equal(f.count(),'2');
  assert.equal(button.getAttribute('aria-description'),'2 filters for all views.');
  assert.equal(button.dataset.baseTooltip,'Filter: 2 filters for all views.');
  assert.equal(button.querySelector('.bases-toolbar-filter-count')?.getAttribute('aria-hidden'),'true');
  assert.equal(button.title,'');assert.equal(f.document.toString(),original);assert.deepEqual(f.saves,[]);
 }finally{f.close();}
});

test('root and view summaries use the same top-level rule count as their filter sections',()=>{
 const f=fixture({and:['note.score > 1',{or:['file.ext == "md"','file.ext == "txt"']}]},'note.score < 5');try{
  assert.equal(f.count(),'3');assert.equal(f.filter().getAttribute('aria-description'),'3 filters: 2 for all views, 1 for this view.');
  f.filter().click();const sections=f.doc.querySelectorAll('.bases-filter-section');
  assert.match(sections[0].textContent??'',/All views2/);assert.match(sections[1].textContent??'',/This view1/);
  assert.deepEqual(f.saves,[]);
 }finally{f.close();}
});

test('an explicitly sourced view never advertises unrelated root filters',()=>{
 const f=fixture({and:['note.score > 1','file.ext == "md"']},'note.score < 5',true);try{
  assert.equal(f.count(),'1');assert.equal(f.filter().getAttribute('aria-description'),'1 filter for this view.');
  f.filter().click();assert.equal((f.doc.querySelector('.bases-filter-section') as HTMLElement).hidden,true);assert.deepEqual(f.saves,[]);
 }finally{f.close();}
});

test('unfiltered views have no badge while a persisted empty filter group remains configured',()=>{
 const plain=fixture();try{assert.equal(plain.filter().classList.contains('is-active'),false);assert.equal(plain.count(),undefined);assert.equal(plain.filter().getAttribute('aria-description'),'No filters.');}finally{plain.close();}
 const unset=fixture(null,null);try{assert.equal(unset.filter().classList.contains('is-active'),false);assert.equal(unset.count(),undefined);}finally{unset.close();}
 const empty=fixture(undefined,{or:[]});try{assert.equal(empty.filter().classList.contains('is-active'),true);assert.equal(empty.count(),'1');assert.equal(empty.filter().getAttribute('aria-description'),'1 filter for this view.');}finally{empty.close();}
});

for(const rejected of [false,true])test(`filter summary reflects only accepted configuration after a ${rejected?'rejected':'successful'} edit`,async()=>{
 const f=fixture(undefined,{and:['note.score > 1','note.score < 5']});try{
  if(rejected)f.rejectSave();const trigger=f.filter();trigger.click();const panel=f.doc.querySelector('.bases-toolbar-popover')!;
  panel.querySelectorAll<HTMLButtonElement>('[aria-label="Remove filter"]')[1].click();
  assert.equal(f.count(),'2','A local draft does not change the saved summary');
  panel.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert.equal(f.filter(),trigger,'The existing popup anchor is retained');assert.equal(panel.isConnected,true);
  assert.equal(f.count(),rejected?'2':'1');assert.equal(f.toolbar.hasDraft(),rejected);assert.equal(f.saves.length,1);
  assert.equal(f.document.getRoot('sentinel'),'keep');
  if(!rejected){assert.equal(trigger.getAttribute('aria-description'),'1 filter for this view.');f.refresh();assert.equal(f.filter(),trigger);}
 }finally{f.close();}
});
