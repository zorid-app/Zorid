import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar,BaseToolbarSaveError} from '../src/bases/toolbar.ts';
import type {BaseToolbarState} from '../src/bases/toolbar.ts';
import type {BaseValue} from '../src/bases/document.ts';
import type {BaseFilterPropertyDescriptor} from '../src/bases/toolbar-filter-types.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const unknown:BaseFilterPropertyDescriptor={kind:'unknown',metadataStatus:'unavailable'};
function fixture(initial:BaseValue='note.score > 1'){
 const dom=new JSDOM('<main></main><button id="outside">Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse(JSON.stringify({fixtureSentinel:'keep',views:[{type:'table',name:'Typed',order:['file.name','note.text','note.score','note.items','note.when','note.other'],filters:{and:[initial]}},{type:'table',name:'Other'}]}));
 let version=1,selectedIndex=0,readOnly=false,current=true,hook:((version:number,patch:unknown)=>Promise<void>)|undefined;
 let kinds:Record<string,BaseFilterPropertyDescriptor>={'note.score':{kind:'number'},'note.items':{kind:'list'},'note.when':{kind:'date',withTime:true},'note.text':unknown};
 const saves:Array<{version:number;patch:unknown}>=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(){throw Error('Use the real combined configuration entry');},commands:{async updateRoot(){}},
  async saveConfiguration(version,patch){saves.push({version:Number(version),patch:structuredClone(patch)});await hook?.(Number(version),patch);},onDraftChange(){},onError:error=>errors.push(error)});
 const state=():BaseToolbarState=>{
  const captured=kinds;
  return {result:executeBaseQuery(document,{version,files:[{path:'A.md',properties:{score:2,text:'Alpha',other:'value',items:[[1,true],'one',null],when:'2026-10-22T12:34:00-04:00'}}]},{viewIndex:selectedIndex}),views:document.views,selectedIndex,root:{fixtureSentinel:document.getRoot('fixtureSentinel')},readOnly,allowRename:true,label:property=>property.replace(/^note\./,''),propertyType:property=>property==='note.text'?'text':undefined,filterProperty:property=>current?captured[property]:unknown};
 };
 const refresh=()=>{version++;toolbar.update(state());};
 const get=<T extends HTMLElement>(label:string,scope:ParentNode=doc)=>{const element=scope.querySelector<T>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(element,label);return element;};
 const edit=(element:HTMLInputElement|HTMLSelectElement,value:string,event='input')=>{element.value=value;element.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
 toolbar.update(state());get<HTMLButtonElement>('Filter').click();
 const section=doc.querySelectorAll('.bases-filter-section')[1];get<HTMLButtonElement>('Add filter',section).click();
 const row=(index=1)=>section.querySelectorAll<HTMLElement>('.bases-filter-condition')[index];
 edit(get<HTMLSelectElement>('Filter property',row()),'note.text','change');assert.equal(get<HTMLSelectElement>('Filter property',row()).value,'note.text');
 const catalog=()=>[...get<HTMLSelectElement>('Condition',row()).options].map(option=>option.value);
 assert.deepEqual(catalog(),['eq','neq','isEmpty','isNotEmpty']);
 return {dom,doc,document,toolbar,get,edit,row,catalog,saves,errors,refresh,
  advice(next:Record<string,BaseFilterPropertyDescriptor>={}){kinds={...kinds,'note.text':{kind:'string'},...next};},
  switchView(){selectedIndex=1;},readOnly(){readOnly=true;},retire(){current=false;},setHook(next:typeof hook){hook=next;},
  submit(){doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));},
  cleanup(){toolbar.destroy();dom.window.close();}};
}

test('blank-row advisory refresh preserves another row’s invalid raw number, focus and selection',async()=>{
 const f=fixture();try{
  const number=f.get<HTMLInputElement>('Filter value',f.row(0)),blank=f.row();
  f.edit(number,'1e');number.focus();number.setSelectionRange(1,2);assert.equal(number.validity.valid,false);
  f.advice();f.refresh();
  assert.ok(f.catalog().includes('notEndsWith'));assert.notEqual(f.row(),blank);
  assert.equal(f.get('Filter value',f.row(0)),number);assert.equal(number.value,'1e');assert.equal(f.doc.activeElement,number);assert.equal(number.selectionStart,1);assert.equal(number.selectionEnd,2);assert.equal(number.validity.valid,false);
  f.submit();await tick();assert.deepEqual(f.saves,[],'Refreshing metadata cannot make an invalid raw operand saveable');
  f.edit(number,'3');f.edit(f.get<HTMLSelectElement>('Condition',f.row()),'notEndsWith','change');f.edit(f.get<HTMLInputElement>('Filter value',f.row()),'beta');
  f.submit();await tick();await tick();assert.equal(f.saves.length,1);assert.equal(f.saves[0].version,2,'Only existing guarded submit-time rebase adopts the deferred query version');
  assert.deepEqual(f.saves[0].patch,{view:{filters:{and:['note["score"] > 3','!note["text"].endsWith("beta")']}}});
 }finally{f.cleanup();}
});

test('typed incompatible String operand keeps its exact DOM and selection while next property choice uses current advice',()=>{
 const f=fixture();try{
  const row=f.row(),field=f.get<HTMLInputElement>('Filter value',row);f.edit(field,'Alpha');field.focus();field.setSelectionRange(1,4);
  f.advice({'note.text':{kind:'boolean'}});f.refresh();
  assert.equal(f.row(),row);assert.equal(f.get('Filter value',row),field);assert.equal(field.value,'Alpha');assert.equal(field.type,'text');assert.equal(f.doc.activeElement,field);assert.equal(field.selectionStart,1);assert.equal(field.selectionEnd,4);assert.deepEqual(f.saves,[]);
  f.edit(f.get<HTMLSelectElement>('Filter property',row),'note.other','change');f.edit(f.get<HTMLSelectElement>('Filter property',f.row()),'note.text','change');
  const checkbox=f.get<HTMLInputElement>('Filter value',f.row());assert.equal(checkbox.type,'checkbox');assert.equal(checkbox.indeterminate,true,'A new normal property selection never coerces the retained String into Boolean');
 }finally{f.cleanup();}
});

test('pending nested-list text and captured offset date controls survive unrelated blank-row advice',()=>{
 for(const [source,draft]of [['note.items == [[1, true], "one", null]','unfinished ['],['note.when < "2026-10-22T12:34:00-04:00"',null]] as const){
  const f=fixture(source);try{
   const row=f.row(0),field=f.get<HTMLInputElement>('Filter value',row),before=row.innerHTML;
   if(draft!==null){f.edit(field,draft);field.focus();field.setSelectionRange(2,5);}else f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
   const raw=field.value,focused=f.doc.activeElement;f.advice({'note.items':{kind:'boolean'},'note.when':{kind:'number'}});f.refresh();
   assert.ok(f.catalog().includes('notEndsWith'),source);assert.equal(f.row(0),row);assert.equal(f.get('Filter value',row),field);assert.equal(field.value,raw);assert.equal(f.doc.activeElement,focused);
   if(draft!==null){assert.equal(field.selectionStart,2);assert.equal(field.selectionEnd,5);}else assert.equal(row.innerHTML,before,'Rehydrated date/offset controls are not rebuilt or normalized');
   assert.deepEqual(f.saves,[]);assert.equal(f.document.getRoot('fixtureSentinel'),'keep');
  }finally{f.cleanup();}
 }
});

test('configuration, selected view, readonly and retired-provider changes cannot authorize blank-row advice',()=>{
 for(const reason of ['configuration','view','readonly','owner']as const){
  const f=fixture();try{
   const row=f.row(),field=f.get<HTMLInputElement>('Filter value',row);f.edit(f.get<HTMLInputElement>('Filter value',f.row(0)),'1e');f.advice();
   if(reason==='configuration')f.document.updateRoot({fixtureSentinel:'changed'});
   if(reason==='view')f.switchView();if(reason==='readonly')f.readOnly();if(reason==='owner')f.retire();
   f.refresh();assert.equal(f.row(),row,reason);assert.equal(f.get('Filter value',row),field,reason);assert.equal(f.catalog().includes('notEndsWith'),false,reason);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('composition, operand focus and an open property combobox defer replacement without losing the interaction',()=>{
 for(const interaction of ['composition','operand-focus','combobox']as const){
  const f=fixture();try{
   const row=f.row(),field=f.get<HTMLInputElement>('Filter value',row);
   if(interaction==='composition'){field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();}
   if(interaction==='operand-focus'){field.focus();field.setSelectionRange(0,0);}
   if(interaction==='combobox')f.get<HTMLButtonElement>('Filter property',row).nextElementSibling?.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));
   const focused=f.doc.activeElement,popup=f.doc.querySelector('[role="listbox"]');
   if(interaction==='combobox')assert.ok(popup,'Exercise the real open combobox interaction');
   f.advice();f.refresh();assert.equal(f.row(),row,interaction);assert.equal(f.get('Filter value',row),field);assert.equal(f.doc.activeElement,focused);assert.equal(f.catalog().includes('notEndsWith'),false);
   if(interaction==='combobox')assert.equal(f.doc.querySelector('[role="listbox"]'),popup);
   assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('another row’s composition or open combobox defers every blank replacement and preserves its popup anchor',()=>{
 for(const interaction of ['composition','combobox']as const){
  const f=fixture();try{
   const blank=f.row(),other=f.row(0),field=f.get<HTMLInputElement>('Filter value',other);
   if(interaction==='composition'){field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));field.focus();}
   else {const button=f.get<HTMLSelectElement>('Condition',other).nextElementSibling as HTMLButtonElement;button.focus();button.click();}
   const popup=f.doc.querySelector('[role="listbox"]'),focused=f.doc.activeElement;
   if(interaction==='combobox')assert.ok(popup);
   f.advice({'note.text':{kind:'list'}});f.refresh();assert.equal(f.row(),blank);assert.equal(f.row(0),other);assert.equal(f.doc.activeElement,focused);assert.equal(f.doc.querySelector('[role="listbox"]'),popup);
   if(interaction==='composition')field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
   else (f.doc.activeElement as HTMLElement).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   f.refresh();assert.notEqual(f.row(),blank,'Later safe metadata delivery may rebuild the untouched blank row: '+interaction);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('a real combobox press survives metadata delivery until its single release and click',async()=>{
 const f=fixture();try{
  const row=f.row(),button=f.get<HTMLSelectElement>('Filter property',row).nextElementSibling as HTMLButtonElement;button.focus();
  const pointer=(type:string,target:HTMLElement)=>{const event=new f.dom.window.MouseEvent(type,{bubbles:true,button:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);};
  pointer('pointerdown',button);f.advice();f.refresh();assert.equal(f.row(),row);assert.equal(button.isConnected,true);
  pointer('pointerup',button);f.refresh();assert.equal(button.isConnected,true,'Release cannot drop the original target before native click');
  button.click();const popup=f.doc.querySelector('[role="listbox"]');assert.ok(popup,'The original single click still opens its real combobox');
  await tick();f.refresh();assert.equal(f.row(),row);assert.equal(f.doc.querySelector('[role="listbox"]'),popup);
  (f.doc.activeElement as HTMLElement).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  f.refresh();assert.ok(f.catalog().includes('notEndsWith'));assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('blank-row native action buttons retain their Space activation targets through metadata delivery',()=>{
 for(const label of ['Remove filter','Edit expression']){
  const f=fixture();try{
   const row=f.row(),button=f.get<HTMLButtonElement>(label,row);button.focus();
   button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true}));
   f.advice();f.refresh();assert.equal(f.row(),row,label);assert.equal(button.isConnected,true,label);assert.equal(f.doc.activeElement,button,label);
   button.dispatchEvent(new f.dom.window.KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true,cancelable:true}));button.click();
   assert.equal(row.isConnected,false,label+' original activation still runs');
   if(label==='Remove filter')assert.equal(f.doc.querySelectorAll('.bases-filter-condition').length,1);
   else assert.equal(f.get<HTMLTextAreaElement>('Filter expression',f.row()).value,'');
   assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('a real closed Property combobox consumes Space immediately and keeps later blank-row recovery available',()=>{
 const f=fixture();try{
  const row=f.row(),button=f.get<HTMLSelectElement>('Filter property',row).nextElementSibling as HTMLButtonElement;button.focus();
  const down=new f.dom.window.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true});button.dispatchEvent(down);
  assert.equal(down.defaultPrevented,true,'The real combobox owns Space on keydown rather than delayed native button click');
  const popup=f.doc.querySelector('[role="listbox"]');assert.ok(popup);f.advice();f.refresh();assert.equal(f.row(),row);assert.equal(f.doc.querySelector('[role="listbox"]'),popup);
  button.dispatchEvent(new f.dom.window.KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true,cancelable:true}));
  (f.doc.activeElement as HTMLElement).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(f.doc.activeElement,button);assert.equal(button.getAttribute('aria-expanded'),'false');
  f.refresh();assert.notEqual(f.row(),row,'Closed property focus must not permanently block newly current String operators');assert.ok(f.catalog().includes('notEndsWith'));assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});

test('leaving a focused blank-row action button permits safe current advice recovery without writing a draft',()=>{
 for(const label of ['Remove filter','Edit expression']){
  const f=fixture();try{
   const before=f.document.toString(),row=f.row(),button=f.get<HTMLButtonElement>(label,row);button.focus();f.advice();f.refresh();
   assert.equal(f.row(),row);assert.equal(f.doc.activeElement,button);assert.equal(f.catalog().includes('notEndsWith'),false);
   f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();f.refresh();assert.notEqual(f.row(),row);assert.ok(f.catalog().includes('notEndsWith'));
   assert.equal(f.document.toString(),before);assert.deepEqual(f.saves,[]);assert.deepEqual(f.errors,[]);
  }finally{f.cleanup();}
 }
});

test('cancel, drag-out, drag-end and lost focus cannot leave a permanent pointer refresh fence',()=>{
 for(const ending of ['pointercancel','outside-up','dragend','blur']as const){
  const f=fixture();try{
   const row=f.row(),button=f.get<HTMLSelectElement>('Filter property',row).nextElementSibling as HTMLButtonElement;
   const pointer=(type:string,target:HTMLElement)=>{const event=new f.dom.window.MouseEvent(type,{bubbles:true,button:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);};
   pointer('pointerdown',button);f.advice();f.refresh();assert.equal(f.row(),row);
   if(ending==='pointercancel')pointer(ending,button);
   if(ending==='outside-up')pointer('pointerup',f.doc.querySelector<HTMLElement>('#outside')!);
   if(ending==='dragend')f.doc.dispatchEvent(new f.dom.window.Event('dragend',{bubbles:true}));
   if(ending==='blur')f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
   f.refresh();assert.ok(f.catalog().includes('notEndsWith'),ending);assert.deepEqual(f.saves,[]);
  }finally{f.cleanup();}
 }
});

test('a release without click expires after one frame and panel disposal cancels its fallback',async()=>{
 const f=fixture();try{
  const row=f.row(),button=f.get<HTMLSelectElement>('Filter property',row).nextElementSibling as HTMLButtonElement;
  const pointer=(type:string)=>{const event=new f.dom.window.MouseEvent(type,{bubbles:true,button:0});Object.defineProperty(event,'pointerId',{value:1});button.dispatchEvent(event);};
  pointer('pointerdown');pointer('pointerup');f.advice();f.refresh();assert.equal(f.row(),row);
  await new Promise<void>(resolve=>f.dom.window.requestAnimationFrame(()=>resolve()));f.refresh();assert.ok(f.catalog().includes('notEndsWith'));
  let cancelled=0;const cancel=f.dom.window.cancelAnimationFrame.bind(f.dom.window);f.dom.window.cancelAnimationFrame=id=>{cancelled++;cancel(id);};
  const next=f.get<HTMLSelectElement>('Filter property',f.row()).nextElementSibling as HTMLButtonElement;
  for(const type of ['pointerdown','pointerup']){const event=new f.dom.window.MouseEvent(type,{bubbles:true,button:0});Object.defineProperty(event,'pointerId',{value:2});next.dispatchEvent(event);}
  f.toolbar.destroy();assert.equal(cancelled,1,'Owned animation-frame fallback is released by the panel disposer');
 }finally{f.cleanup();}
});

test('saving and retained persistence failure cannot refresh models or replace original controls',async()=>{
 for(const retained of [false,true]){
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
   f.setHook(async()=>{await gate;if(retained)throw new BaseToolbarSaveError('actual retained attempt',async()=>{});});
   f.edit(f.get<HTMLInputElement>('Filter value',f.row(0)),'3');f.submit();await tick();
   assert.equal(f.saves.length,1);const row=f.row(),field=f.get<HTMLInputElement>('Filter value',row);assert.equal(field.disabled,false,'Live edits retain the original editable control while saving');
   if(retained){release();await tick();await tick();assert.equal([...f.doc.querySelectorAll('button')].find(button=>button.textContent==='Retry save')?.textContent,'Retry save');}
   f.advice();f.refresh();assert.equal(f.row(),row);assert.equal(f.get('Filter value',row),field);assert.equal(field.disabled,retained);assert.equal(f.catalog().includes('notEndsWith'),false);assert.equal(f.saves.length,1);
  }finally{release();await tick();await tick();f.cleanup();}
 }
});

test('closed filter owners cannot publish later advice or run old row listeners',()=>{
 const f=fixture();try{
  const row=f.row(),field=f.get<HTMLInputElement>('Filter value',row);f.toolbar.destroy();const html=f.doc.body.innerHTML;
  f.advice();f.refresh();assert.equal(f.doc.body.innerHTML,html);assert.equal(row.isConnected,false);f.edit(field,'late input');assert.deepEqual(f.saves,[]);
 }finally{f.cleanup();}
});
