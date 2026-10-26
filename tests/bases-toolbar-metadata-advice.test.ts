import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar} from '../src/bases/toolbar.ts';
import type {BaseToolbarState} from '../src/bases/toolbar.ts';

const unknown={kind:'unknown',metadataStatus:'unavailable'}as const;
const source='!note["text"].startsWith("Alpha")';
function fixture(){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse(JSON.stringify({fixtureSentinel:'keep',views:[{type:'table',name:'Typed',order:['file.name','note.text'],filters:source},{type:'table',name:'Other'}]}));
 const result=executeBaseQuery(document,{version:8,files:[{path:'C.md',properties:{text:'delta beta'}},{path:'D.md',properties:{text:''}},{path:'E.md',properties:{text:'ALPHA'}}]}),saves:unknown[]=[];
 const state:BaseToolbarState={result,views:document.views,selectedIndex:0,root:{fixtureSentinel:'keep'},readOnly:false,allowRename:true,label:property=>property,filterProperty:()=>unknown};
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_version,patch){saves.push(patch);},onDraftChange(){},onError(error){throw error;}});toolbar.update(state);
 const fresh=(overrides:Partial<BaseToolbarState>={}):BaseToolbarState=>({...state,filterProperty:()=>({kind:'string'}),...overrides});
 const open=(name='Filter')=>doc.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
 const panel=()=>doc.querySelector<HTMLElement>('[role="dialog"]')!;
 const row=()=>panel().querySelectorAll('.bases-filter-section')[1].querySelector<HTMLElement>('.bases-filter-condition')!;
 return{dom,doc,toolbar,state,fresh,open,panel,row,saves,cleanup(){toolbar.destroy();dom.window.close();}};
}

test('metadata-only advice refreshes a closed Filter without replacing toolbar actions or query context',()=>{
 const f=fixture();try{
  const actions=[...f.doc.querySelectorAll('main button')];f.toolbar.refreshFilterAdvice(f.fresh());assert.deepEqual([...f.doc.querySelectorAll('main button')],actions);
  f.open();assert.equal(f.row().querySelector('textarea[aria-label="Filter expression"]'),null);assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notStartsWith');assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('a closed Filter cannot borrow fresh providers from a different result, configuration, view or readonly context',()=>{
 for(const reason of ['result','configuration','view','readonly']as const){
  const f=fixture();try{
   const overrides:Partial<BaseToolbarState>=reason==='result'?{result:{...f.state.result,version:9}}:reason==='configuration'?{root:{fixtureSentinel:'changed'}}:reason==='view'?{selectedIndex:1}:{readOnly:true};
   f.toolbar.refreshFilterAdvice(f.fresh(overrides));f.open();assert.equal(f.row().querySelector<HTMLTextAreaElement>('textarea')?.value,source,reason);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('metadata-only advice does not replace or focus another open panel',()=>{
 const f=fixture();try{
  f.open('Sort');const panel=f.panel(),button=panel.querySelector<HTMLButtonElement>('button')!;button.focus();const html=panel.innerHTML;
  f.toolbar.refreshFilterAdvice(f.fresh());assert.equal(f.panel(),panel);assert.equal(panel.innerHTML,html);assert.equal(f.doc.activeElement,button);assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('metadata-only advice retains explicit raw edits and cannot publish after toolbar disposal',()=>{
 const f=fixture();try{
  f.open();const row=f.row(),raw=row.querySelector<HTMLTextAreaElement>('textarea')!;raw.value='!note[';raw.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));raw.focus();raw.setSelectionRange(1,4);
  f.toolbar.refreshFilterAdvice(f.fresh());assert.equal(f.row(),row);assert.equal(raw.value,'!note[');assert.equal(f.doc.activeElement,raw);assert.equal(raw.selectionStart,1);assert.equal(raw.selectionEnd,4);
  f.toolbar.destroy();const html=f.doc.body.innerHTML;f.toolbar.refreshFilterAdvice(f.fresh());assert.equal(f.doc.body.innerHTML,html);assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});
