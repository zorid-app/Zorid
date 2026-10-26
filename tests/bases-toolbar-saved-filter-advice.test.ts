import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar} from '../src/bases/toolbar.ts';
import type {BaseFilterPropertyDescriptor} from '../src/bases/toolbar-filter-types.ts';

const unknown:BaseFilterPropertyDescriptor={kind:'unknown',metadataStatus:'unavailable'};
const inverse='!note["text"].containsAny("beta", "gamma")';
function fixture(source=inverse,initialKind:BaseFilterPropertyDescriptor=unknown,enhanced=false){
 const dom=new JSDOM('<main></main><button id="outside">Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document;
 const names=['window','document','MutationObserver','requestAnimationFrame','cancelAnimationFrame','getComputedStyle','HTMLElement','Node','Window']as const,previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]as const);
 if(enhanced){for(const name of names){const entry=dom.window[name];Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:typeof entry==='function'&&['requestAnimationFrame','cancelAnimationFrame','getComputedStyle'].includes(name)?entry.bind(dom.window):entry});}dom.window.Range.prototype.getClientRects=()=>[]as unknown as DOMRectList;dom.window.Range.prototype.getBoundingClientRect=()=>new dom.window.DOMRect();}
 const document=BaseDocument.parse(JSON.stringify({fixtureSentinel:'keep',views:[{type:'table',name:'Typed',order:['file.name','note.text','note.items','note.amount'],filters:{and:[source]}},{type:'table',name:'Other'}]})),before=document.toString();
 let version=1,kind=initialKind,current=true,readOnly=false,index=0;const saves:unknown[]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_version,patch){saves.push(patch);},onDraftChange(){},onError:error=>errors.push(error)});
 const state=()=>{const captured=kind;return{result:executeBaseQuery(document,{version,files:[{path:'A.md',properties:{text:'Alpha',items:[1,true,'1',null],amount:2}}]},{viewIndex:index}),views:document.views,selectedIndex:index,root:{fixtureSentinel:document.getRoot('fixtureSentinel')},readOnly,allowRename:true,label:(property:string)=>property.replace(/^note\./,''),propertyType:()=> 'text',filterProperty:()=>current?captured:unknown};};
 toolbar.update(state());doc.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click();
 const panel=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]')!,row=()=>panel().querySelectorAll('.bases-filter-section')[1].querySelector<HTMLElement>('.bases-filter-condition')!;
 const raw=()=>row().querySelector<HTMLTextAreaElement>('textarea[aria-label="Filter expression"]');
 const refresh=(next:BaseFilterPropertyDescriptor={kind:'string'})=>{kind=next;version++;toolbar.update(state());};
 return{dom,doc,document,before,toolbar,saves,errors,panel,row,raw,refresh,retire(){current=false;},readonly(){readOnly=true;},switchView(){index=1;},
  cleanup(){toolbar.destroy();dom.window.close();if(enhanced)for(const[name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}}};
}

test('saved positive/inverse String methods recover exact structured operands without writing their source',()=>{
 for(const [source,operator,labels]of [[inverse,'notContainsAny',['beta','gamma']],['note["text"].containsAll("beta", "gamma")','containsAll',['beta','gamma']],['!note["text"].endsWith("beta")','notEndsWith',null]]as const){
  const f=fixture(source);try{
   const raw=f.raw()!;assert.ok(raw);assert.equal(raw.value,source);f.refresh();
   assert.equal(f.raw(),null);assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,operator);
   if(labels)assert.deepEqual([...f.row().querySelectorAll('.bases-filter-operand-chip span')].map(element=>element.textContent),labels);
   else assert.equal(f.row().querySelector<HTMLInputElement>('input[aria-label="Filter value"]')?.value,'beta');
   assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);assert.deepEqual(f.errors,[]);
  }finally{f.cleanup();}
 }
});

test('saved List variadic versus one-array arguments retain typed/nested shape on advisory recovery',()=>{
 for(const[source,labels]of [['!note["items"].containsAny(1, true, "1", null)',['1','true','1','null']],['note["items"].containsAny(["red", "green"])',['["red","green"]']],['note["items"].containsAll([[1, true], null])',['[[1,true],null]']]]as const){
  const f=fixture(source);try{
   assert.ok(f.raw());f.refresh({kind:'list'});assert.equal(f.raw(),null);
   assert.deepEqual([...f.row().querySelectorAll('.bases-filter-operand-chip span')].map(element=>element.textContent),labels);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('focused native fallback retains its raw selection, then recovers only after that editing focus leaves',()=>{
 const f=fixture();try{
  const raw=f.raw()!,row=f.row();raw.focus();raw.setSelectionRange(2,8);f.refresh();
  assert.equal(f.row(),row);assert.equal(f.raw(),raw);assert.equal(f.doc.activeElement,raw);assert.equal(raw.selectionStart,2);assert.equal(raw.selectionEnd,8);assert.equal(raw.value,inverse);
  f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();f.refresh();assert.equal(f.raw(),null);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('focused Remove retains its keyboard activation target through fresh advice and recovers only after focus leaves',()=>{
 for(const activate of [true,false]){
  const f=fixture();try{
   const row=f.row(),raw=f.raw()!,remove=row.querySelector<HTMLButtonElement>('button[aria-label="Remove filter"]')!;
   remove.focus();remove.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));f.refresh();
   assert.equal(f.row(),row);assert.equal(f.raw(),raw);assert.equal(f.doc.activeElement,remove);assert.equal(remove.isConnected,true);
   remove.dispatchEvent(new f.dom.window.KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true}));
   if(activate){remove.click();assert.equal(row.isConnected,false);assert.equal(f.raw(),null);}
   else{f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();f.refresh();assert.equal(f.raw(),null);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);}
  }finally{f.cleanup();}
 }
});

test('enhanced fallback focus/selection is retained and its retired editor is released after safe recovery',()=>{
 const f=fixture(inverse,unknown,true);try{
  const raw=f.raw()!,content=f.row().querySelector<HTMLElement>('.cm-content')!,view=EditorView.findFromDOM(content)!;assert.ok(view);assert.equal(raw.hidden,true);
  view.focus();view.dispatch({selection:{anchor:2,head:8}});const row=f.row();f.refresh();assert.equal(f.row(),row);assert.equal(f.raw(),raw);assert.equal(f.doc.activeElement,content);assert.equal(view.state.selection.main.anchor,2);assert.equal(view.state.selection.main.head,8);
  f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();f.refresh();assert.equal(f.raw(),null);assert.equal(content.isConnected,false);assert.equal(raw.hidden,false,'Destroying the retired enhanced editor restores its native model attributes');
  raw.value='late old editor input';raw.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('editing raw source, including restoring identical bytes, is an explicit advanced-mode choice',()=>{
 for(const text of ['!note["text"].containsAny(',inverse,'  '+inverse+'  ']){
  const f=fixture();try{
   const raw=f.raw()!,row=f.row();raw.value=text;raw.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();f.refresh();
   assert.equal(f.row(),row);assert.equal(f.raw(),raw);assert.equal(raw.value,text);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('unsupported dynamic source, chosen advanced mode and known-incompatible categories stay raw',()=>{
 for(const[source,kind]of [['note.text > max(1, 2)',unknown],[inverse,{kind:'boolean'}]]as const){
  const f=fixture(source,kind);try{const raw=f.raw()!;assert.ok(raw);f.refresh();assert.equal(f.raw(),raw);assert.equal(raw.value,source);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);}finally{f.cleanup();}
 }
 const f=fixture(inverse,{kind:'string'});try{
  assert.equal(f.raw(),null);f.row().querySelector<HTMLButtonElement>('button[aria-label="Edit expression"]')!.click();const raw=f.raw()!;assert.ok(raw);f.refresh();assert.equal(f.raw(),raw);assert.equal(raw.value,inverse);assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('unknown/incompatible fresh advice, retired owner and changed configuration/view/read-only cannot repair fallback',()=>{
 for(const reason of ['unknown','incompatible','owner','configuration','view','readonly']as const){
  const f=fixture();try{
   const raw=f.raw()!;if(reason==='owner')f.retire();if(reason==='configuration')f.document.updateRoot({fixtureSentinel:'changed'});if(reason==='view')f.switchView();if(reason==='readonly')f.readonly();
   f.refresh(reason==='unknown'?unknown:reason==='incompatible'?{kind:'boolean'}:{kind:'string'});
   if(['configuration','view'].includes(reason))assert.equal(f.panel(),null,reason+' invalidates the unedited panel');
   else assert.equal(f.raw(),raw,reason);
   assert.equal(raw.value,inverse);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('composition and an in-flight Remove press keep the raw fallback interaction target stable',async()=>{
 for(const interaction of ['composition','pointer']as const){
  const f=fixture();try{
   const raw=f.raw()!,row=f.row(),remove=row.querySelector<HTMLButtonElement>('button[aria-label="Remove filter"]')!;
   if(interaction==='composition')raw.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
   else{const down=new f.dom.window.MouseEvent('pointerdown',{bubbles:true,button:0});Object.defineProperty(down,'pointerId',{value:1});remove.dispatchEvent(down);}
   f.refresh();assert.equal(f.row(),row);assert.equal(f.raw(),raw);
   if(interaction==='composition')raw.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
   else{const cancel=new f.dom.window.MouseEvent('pointercancel',{bubbles:true,button:0});Object.defineProperty(cancel,'pointerId',{value:1});remove.dispatchEvent(cancel);}
   f.refresh();assert.equal(f.raw(),null);assert.equal(f.document.toString(),f.before);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});
