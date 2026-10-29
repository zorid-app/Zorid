import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {EditorView} from '@codemirror/view';
import * as toolbarModule from '../src/bases/toolbar.ts';
import type {BaseToolbarOptions,BaseToolbarState} from '../src/bases/toolbar.ts';

function fixture(version=1,extra:Partial<BaseToolbarOptions>={}){
 const dom=new JSDOM('<main></main><button id="outside">Ordinary note</button>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse('views: [{id: aaaaaaaaaaaa, type: table, name: Library, order: [file.name, score]}]');
 const calls:unknown[][]=[],errors:unknown[]=[];
 const toolbar=toolbarModule.createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){calls.push(['select']);},async save(expected,patch){calls.push(['save',expected,patch]);},commands:{async updateView(expected,index,patch){calls.push(['view',expected,index,patch]);},async updateRoot(expected,patch){calls.push(['root',expected,patch]);},async addView(expected,type,name,patch){calls.push(['add',expected,type,name,patch]);},async moveView(expected,from,to){calls.push(['move',expected,from,to]);},async editFormula(expected,original,name,expression){calls.push(['formula',expected,original,name,expression]);}},async onNew(){calls.push(['new']);},onDraftChange(){},onError:error=>errors.push(error),...extra});
 const refresh=(override:Partial<BaseToolbarState>={})=>{const result=executeBaseQuery(document,{version,files:[{path:'Book.md',properties:{score:3}}]});toolbar.update({result,views:document.views,selectedIndex:0,root:{newItemFolder:'Inbox',...(document.getRoot('formulas')?{formulas:document.getRoot('formulas')}:{} )},readOnly:false,allowRename:true,label:property=>property,propertyType:property=>property==='note.score'?'number':'text',...override});};refresh();
 const get=<T extends HTMLElement>(label:string)=>{const element=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(element,label);return element;};
 const click=(label:string)=>get<HTMLButtonElement>(label).click();
 const input=(label:string,value:string)=>{const node=get<HTMLInputElement>(label);node.value=value;node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));return node;};
 return{dom,doc,document,toolbar,calls,errors,get,click,input,refresh,close(){toolbar.destroy();dom.window.close();}};
}

test('raw creation settings freeze without saving and restore into a fresh toolbar before explicit Apply',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('New item options');const input=old.input('New item folder','Draft /未');input.focus();input.setSelectionRange(1,5,'backward');
  assert.equal(old.toolbar.canCaptureAdmissionDraft?.(),true,'unsubmitted folder needs non-authoring toolbar custody');const draft=old.toolbar.captureFreeze!()!;assert.ok(draft);await draft.ready;
  input.blur();old.doc.querySelector('form')!.dispatchEvent(new old.dom.window.Event('submit',{bubbles:true,cancelable:true}));old.doc.getElementById('outside')!.dispatchEvent(new old.dom.window.MouseEvent('pointerdown',{bubbles:true}));old.get<HTMLButtonElement>('Back').click();await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);
  assert.equal(fresh.toolbar.restoreAdmissionDraft!(draft),'restored');const restored=fresh.get<HTMLInputElement>('New item folder');assert.equal(restored.value,'Draft /未');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,5);assert.equal(restored.selectionDirection,'backward');assert.equal(fresh.doc.activeElement,restored);assert.deepEqual(fresh.calls,[]);
  assert.equal(toolbarModule.baseToolbarAdmissionDraftText(draft).includes('Draft /未'),true);restored.blur();await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(fresh.calls,[],'reconstruction blur cannot submit raw settings');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.deepEqual(fresh.calls,[['root',22,{newItemFolder:'Draft /未',newItemTemplate:undefined}]]);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}
});

test('inactive raw settings retain every text-control caret without taking ordinary-note focus',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('New item options');const folder=old.input('New item folder','Draft Folder /未完了');folder.focus();folder.setSelectionRange(2,9,'backward');const template=old.input('New item template','Templates /Incomplete');template.focus();template.setSelectionRange(3,8,'forward');old.doc.getElementById('outside')!.focus();
  const draft=old.toolbar.captureFreeze()!;await draft.ready;const foreground=fresh.doc.getElementById('outside')!;foreground.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');
  const restored=fresh.get<HTMLInputElement>('New item folder'),other=fresh.get<HTMLInputElement>('New item template');assert.equal(restored.value,'Draft Folder /未完了');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,9);assert.equal(restored.selectionDirection,'backward');assert.equal(other.selectionStart,3);assert.equal(other.selectionEnd,8);assert.equal(other.selectionDirection,'forward');assert.equal(fresh.doc.activeElement,foreground);assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);
 }finally{old.close();fresh.close();}
});

for(const endBeforeCapture of [false,true])test(`raw settings ${endBeforeCapture?'end-before-capture':'active'} composition waits for actual final input without blocking the IME`,async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('New item options');const input=old.get<HTMLInputElement>('New item folder');input.focus();input.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='未';if(endBeforeCapture)input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'未確定'}));
  const draft=old.toolbar.captureFreeze()!;let ready=false;void draft.ready.then(()=>{ready=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ready,false,'a timer or end alone cannot confirm the final input');assert.equal(input.readOnly,false);assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'pending','unfinished raw composition cannot be accepted by a new toolbar');assert.equal(fresh.doc.querySelector('[role=dialog]'),null);if(!endBeforeCapture){const key=new old.dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});input.dispatchEvent(key);assert.equal(key.defaultPrevented,false,'the original IME must keep its native completion default');input.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'未確定'}));}
  input.value='未確定';input.setSelectionRange(2,3,'forward');input.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'未確定'}));await draft.ready;assert.equal(input.readOnly,true);assert.equal(draft.raw.kind,'new-item-settings');if(draft.raw.kind==='new-item-settings')assert.equal(draft.raw.folder,'未確定');assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('New item folder');assert.equal(restored.value,'未確定');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,3);assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);
 }finally{old.close();fresh.close();}
});

test('an unsubmitted view-name setting restores without its blur rename until fresh explicit commit',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('Settings');const name=old.input('View name','Draft name');name.focus();name.setSelectionRange(2,7,'backward');assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;name.blur();await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);
  assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('View name');assert.equal(restored.value,'Draft name');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);restored.blur();assert.deepEqual(fresh.calls,[]);restored.focus();restored.dispatchEvent(new fresh.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await Promise.resolve();assert.deepEqual(fresh.calls,[['view',22,0,{name:'Draft name'}]]);
 }finally{old.close();fresh.close();}
});

test('a partial Results limit is preserved as raw text and cannot author until it is valid and explicitly applied',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('Settings');old.click('Layout');old.click('Load limit');const input=old.input('Limit','-');assert.equal(input.value,'-','the control must expose incomplete numeric text without coercion');assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);
  assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('Limit');assert.equal(restored.value,'-');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.deepEqual(fresh.calls,[]);assert.match(fresh.doc.querySelector('[role=alert]')!.textContent!,/whole number/);fresh.input('Limit','3');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.deepEqual(fresh.calls,[['save',22,{limit:3}]]);
 }finally{old.close();fresh.close();}
});

test('a raw Results setting cannot restore under changed fresh access authority',async()=>{
 const old=fixture(),fresh=fixture(22);try{old.click('Settings');old.click('Layout');old.click('Load limit');old.input('Limit','-');const draft=old.toolbar.captureFreeze()!;await draft.ready;fresh.refresh({readOnly:true});assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'conflict');assert.equal(fresh.doc.querySelector('[role=dialog]'),null);assert.deepEqual(fresh.calls,[]);}finally{old.close();fresh.close();}
});

test('an incomplete typed filter operand restores its local model without evaluating or applying it',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('Filter');const property=old.get<HTMLSelectElement>('Filter property');property.value='note.score';property.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));const input=old.input('Filter value','9e');input.focus();input.setSelectionRange(1,2,'backward');assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/9e/);assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('Filter value');assert.equal(restored.value,'9e');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,2);await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);fresh.input('Filter value','9');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);
 }finally{old.close();fresh.close();}
});

for(const raw of ['-','1e','+','9007199254740992'])test(`Results limit ${raw} stays raw and never becomes a coerced write`,async()=>{
 const old=fixture(),fresh=fixture(22);try{old.click('Settings');old.click('Layout');old.click('Load limit');old.input('Limit',raw);const draft=old.toolbar.captureFreeze()!;await draft.ready;assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');assert.equal(fresh.get<HTMLInputElement>('Limit').value,raw);fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.deepEqual(fresh.calls,[]);assert.equal(fresh.toolbar.hasDraft(),true);}finally{old.close();fresh.close();}
});

test('a raw advanced filter restores its real CodeMirror document and background selection without a hidden-textarea replay',async()=>{
 const old=fixture(),fresh=fixture(22);let clearGlobals=()=>{};
 const globals=(dom:JSDOM)=>{const names=['window','document','MutationObserver','requestAnimationFrame','cancelAnimationFrame','getComputedStyle','HTMLElement','Node','Window'] as const;const previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);for(const name of names){const value=dom.window[name];Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:typeof value==='function'&&['requestAnimationFrame','cancelAnimationFrame','getComputedStyle'].includes(name)?value.bind(dom.window):value});}dom.window.Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;dom.window.Range.prototype.getBoundingClientRect=()=>new dom.window.DOMRect();return()=>{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}};};
 try{
  for(const f of [old,fresh]){f.document.updateView(0,{filters:'file.name'});f.refresh();}clearGlobals=globals(old.dom);old.click('Filter');const editor=EditorView.findFromDOM(old.doc.querySelector<HTMLElement>('.cm-editor')!)!;assert.ok(editor);editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:'file.name == '},selection:{anchor:2,head:6}});old.doc.getElementById('outside')!.focus();assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;clearGlobals();clearGlobals=globals(fresh.dom);
  const foreground=fresh.doc.getElementById('outside')!;foreground.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=EditorView.findFromDOM(fresh.doc.querySelector<HTMLElement>('.cm-editor')!)!;assert.ok(restored);assert.equal(restored.state.doc.toString(),'file.name == ');assert.equal(restored.state.selection.main.anchor,2);assert.equal(restored.state.selection.main.head,6);assert.equal(fresh.doc.activeElement,foreground);assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/file.name == /);await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);
  restored.dispatch({changes:{from:0,to:restored.state.doc.length,insert:'file.name == "Book"'}});fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);
 }finally{old.close();fresh.close();clearGlobals();}
});

test('raw property visibility and property labels restore as local models until fresh Apply',async()=>{
 for(const label of [false,true]){const old=fixture(),fresh=fixture(22);try{
  old.click('Settings');old.click('Property visibility');if(label){old.click('Configure property note.score');old.input('Display name','Unsubmitted label');}else{old.doc.querySelector<HTMLInputElement>('input[data-property="note.score"]')!.click();const search=old.input('Find a property','raw query');search.setSelectionRange(1,5,'backward');}old.doc.getElementById('outside')!.focus();const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');assert.deepEqual(fresh.calls,[]);assert.equal(fresh.doc.activeElement,fresh.doc.getElementById('outside'));
  if(label)assert.equal(fresh.get<HTMLInputElement>('Display name').value,'Unsubmitted label');else{const search=fresh.get<HTMLInputElement>('Find a property');assert.equal(search.value,'raw query');assert.equal(search.selectionStart,1);assert.equal(search.selectionEnd,5);}fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}}
});

test('a raw sort order and new-view draft restore without issuing their configuration commands',async()=>{
 for(const create of [false,true]){const old=fixture(),fresh=fixture(22);try{
  if(create){old.click('Views');old.click('Add view');old.input('View name','Draft created view');const layout=old.get<HTMLSelectElement>('Layout');layout.value='cards';layout.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));}else{old.click('Sort');old.click('Add sort');const property=old.get<HTMLSelectElement>('Sort property');property.value='note.score';property.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));const direction=old.get<HTMLSelectElement>('Sort direction');direction.value='DESC';direction.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));}
  const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);if(create){assert.equal(fresh.get<HTMLInputElement>('View name').value,'Draft created view');assert.equal(fresh.get<HTMLSelectElement>('Layout').value,'cards');}else{assert.equal(fresh.get<HTMLSelectElement>('Sort property').value,'note.score');assert.equal(fresh.get<HTMLSelectElement>('Sort direction').value,'DESC');}fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);
 }finally{old.close();fresh.close();}}
});

test('raw layout settings keep a background custom separator and caret through fresh reconstruction',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  old.click('Settings');old.click('Layout');old.click('List');const rows=old.get<HTMLSelectElement>('Rows');rows.value='custom';rows.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));const separator=old.input('Property separator',' · raw separator');separator.focus();separator.setSelectionRange(2,7,'backward');old.doc.getElementById('outside')!.focus();const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('Property separator');assert.equal(restored.value,' · raw separator');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);assert.equal(fresh.doc.activeElement,fresh.doc.getElementById('outside'));assert.deepEqual(fresh.calls,[]);fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}
});

test('an unsubmitted formula keeps its raw source and caret without invoking editFormula until explicit Apply',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  for(const f of [old,fresh]){f.document.updateRoot({formulas:{Total:'1 + 2'}});f.document.updateView(0,{order:['file.name','formula.Total']});f.refresh();}old.click('Settings');old.click('Property visibility');old.click('Configure property formula.Total');old.click('Edit formula');await Promise.resolve();old.get<HTMLTextAreaElement>('Formula expression').focus();const expression=old.input('Formula expression','1 + (');expression.setSelectionRange(1,4,'backward');old.doc.getElementById('outside')!.focus();const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLTextAreaElement>('Formula expression');assert.equal(restored.value,'1 + (');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,4);assert.equal(fresh.doc.activeElement,fresh.doc.getElementById('outside'));assert.deepEqual(fresh.calls,[]);fresh.input('Formula expression','1 + 3');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][0],'formula');assert.equal(fresh.calls[0][1],22);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}
});

test('a pending manual-group name remains local after restore and only an explicit creation and Apply persist it',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  for(const f of [old,fresh]){f.document.updateView(0,{groupBy:{property:'note.score',direction:'ASC'},groupOrder:[3]});f.refresh();}old.click('Settings');old.click('Group');old.click('Add group');const name=old.input('Group name','9e');name.focus();name.setSelectionRange(0,1,'backward');old.doc.getElementById('outside')!.focus();const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('Group name');assert.equal(restored.value,'9e');assert.equal(restored.selectionStart,0);assert.equal(restored.selectionEnd,1);assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/9e/);assert.deepEqual(fresh.calls,[]);assert.equal(fresh.doc.activeElement,fresh.doc.getElementById('outside'));fresh.input('Group name','9');fresh.click('Create group');fresh.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.click();await Promise.resolve();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0][1],22);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}
});

test('orphan text includes locally added filter members even when the pending input is empty',async()=>{
 const old=fixture();try{old.document.updateView(0,{filters:'note.items.containsAny("saved")'});old.refresh({filterProperty:property=>property==='note.items'?{kind:'list'}:undefined});old.click('Filter');old.input('Filter value','newly added raw token');old.click('Add item');assert.equal(old.get<HTMLInputElement>('Filter value').value,'');const draft=old.toolbar.captureFreeze()!;await draft.ready;assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/newly added raw token/);assert.deepEqual(old.calls,[]);}finally{old.close();}
});

test('a clean settings combobox query is retained without turning dismissal into a configuration command',async()=>{
 const old=fixture(),fresh=fixture(22);try{
  for(const f of [old,fresh]){f.document.updateView(0,{filters:'note.score > 1'});f.refresh();}old.click('Filter');const source=old.get<HTMLSelectElement>('Filter property');(source.nextElementSibling as HTMLButtonElement).click();const search=old.input('Search Filter property','sco');search.setSelectionRange(1,3,'backward');assert.equal(old.toolbar.hasDraft(),false,'a pure popup query is not unsaved configuration');assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>('Search Filter property');assert.equal(restored.value,'sco');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,3);assert.equal(fresh.doc.activeElement,restored);assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/sco/);restored.focus();restored.dispatchEvent(new fresh.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await Promise.resolve();assert.deepEqual(fresh.calls,[]);assert.deepEqual(old.calls,[]);
 }finally{old.close();fresh.close();}
});

for(const properties of [false,true])test(`a clean native ${properties?'Properties':'Views'} search stays presentation-only through recovery`,async()=>{
 const old=fixture(),fresh=fixture(22);try{old.click(properties?'Settings':'Views');if(properties)old.click('Property visibility');const label=properties?'Find a property':'Find a view';const input=old.input(label,'raw search');input.setSelectionRange(1,4,'backward');old.doc.getElementById('outside')!.focus();assert.equal(old.toolbar.hasDraft(),false,'a pure native search is not unsaved configuration');assert.equal(old.toolbar.canCaptureAdmissionDraft(),true);const draft=old.toolbar.captureFreeze()!;await draft.ready;fresh.doc.getElementById('outside')!.focus();assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');const restored=fresh.get<HTMLInputElement>(label);assert.equal(restored.value,'raw search');assert.equal(restored.selectionStart,1);assert.equal(restored.selectionEnd,4);assert.equal(fresh.doc.activeElement,fresh.doc.getElementById('outside'));restored.focus();restored.dispatchEvent(new fresh.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await Promise.resolve();assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);}finally{old.close();fresh.close();}
});

test('composing layout values are captured after their target listener updates the owned patch',async()=>{
 const old=fixture(),fresh=fixture(22);try{old.click('Settings');old.click('Layout');old.click('List');const rows=old.get<HTMLSelectElement>('Rows');rows.value='custom';rows.dispatchEvent(new old.dom.window.Event('change',{bubbles:true}));const separator=old.get<HTMLInputElement>('Property separator');separator.focus();separator.dispatchEvent(new old.dom.window.CompositionEvent('compositionstart',{bubbles:true}));separator.value='未';separator.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,isComposing:true,data:'未'}));const draft=old.toolbar.captureFreeze()!;let ready=false;void draft.ready.then(()=>{ready=true;});separator.dispatchEvent(new old.dom.window.CompositionEvent('compositionend',{bubbles:true,data:'未確定'}));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ready,false);separator.value='未確定';separator.dispatchEvent(new old.dom.window.InputEvent('input',{bubbles:true,data:'未確定'}));await draft.ready;assert.equal(fresh.toolbar.restoreAdmissionDraft(draft),'restored');assert.equal(fresh.get<HTMLInputElement>('Property separator').value,'未確定');assert.match(toolbarModule.baseToolbarAdmissionDraftText(draft),/未確定/);assert.deepEqual(old.calls,[]);assert.deepEqual(fresh.calls,[]);}finally{old.close();fresh.close();}
});

test('a frozen Views owner cannot submit either a held or newly started drag/drop command',async()=>{
 const old=fixture();try{
  old.document.addView('table','Library Second');old.refresh();old.click('Views');old.input('Find a view','Lib');const rows=[...old.doc.querySelectorAll<HTMLElement>('.bases-toolbar-menu-view-row')];assert.equal(rows.length,2);
  const values=new Map<string,string>(),transfer={effectAllowed:'',setData(type:string,value:string){values.set(type,value);},getData(type:string){return values.get(type)??'';},get types(){return[...values.keys()];}};
  const drag=(target:HTMLElement,type:string)=>{const event=new old.dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});target.dispatchEvent(event);return event;};
  drag(rows[0],'dragstart');const draft=old.toolbar.captureFreeze()!;assert.ok(draft);await draft.ready;drag(rows[1],'drop');drag(rows[0],'dragstart');drag(rows[1],'drop');await Promise.resolve();assert.deepEqual(old.calls,[],'frozen raw custody cannot author view reordering');
 }finally{old.close();}
});

for(const properties of [false,true])test(`a healthy clean ${properties?'Properties':'Views'} query never adds a save barrier to ordinary dismissal`,()=>{
 const f=fixture();try{f.click(properties?'Settings':'Views');if(properties)f.click('Property visibility');f.input(properties?'Find a property':'Find a view','local query');assert.equal(f.toolbar.hasDraft(),false);assert.equal(f.toolbar.canCaptureAdmissionDraft(),true);assert.doesNotThrow(()=>f.toolbar.dismissCleanPanel());assert.equal(f.doc.querySelector('[role=dialog]'),null);assert.deepEqual(f.calls,[]);}finally{f.close();}
});
