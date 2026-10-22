import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseManualGroups} from '../src/bases/toolbar-groups.ts';
import {decodeFilterCondition,buildFilterCondition} from '../src/bases/toolbar-config.ts';
import type {BaseQueryResult} from '../src/bases/query.ts';
import type {BaseExpressionValue} from '../src/bases/expression.ts';
import type {BaseValue} from '../src/bases/document.ts';
function fixture(shared=false){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 let result=executeBaseQuery(BaseDocument.parse('views: [{type: table, name: A, groupBy: {property: status, direction: ASC},groupOrder: [1,"1"]}]'),{version:1,files:[{path:'One.md',properties:{status:1}},{path:'Two.md',properties:{status:'1'}}]});
 if(shared)result={...result,shared:{} as any,groupOptions:result.groupOptions.map((row,i)=>({...row,sharedKeyId:`opaque:${i}`})),groups:result.groups.map((row,i)=>({...row,sharedKeyId:`opaque:${i}`}))};
 const errors:string[]=[],drafts:boolean[]=[];let changes=0;
 const groups=createBaseManualGroups(doc,doc.querySelector('main')!,{result,property:()=> 'note.status',valueType:()=> 'number',changed(){changes++;},draft(active){drafts.push(active);},error(value){errors.push(value);}});
 const get=<T extends HTMLElement>(label:string)=>{const node=doc.querySelector<T>(`[aria-label="${label}"]`);assert.ok(node,label);return node;};
 return{dom,doc,groups,result,errors,drafts,get,changes:()=>changes,cleanup(){groups.destroy();dom.window.close();}};
}
test('manual groups distinguish Rust IDs with identical labels and preserve original typed source values',()=>{
 const f=fixture(true);try{
  assert.deepEqual(f.groups.read(),[1,'1']);const rows=f.doc.querySelectorAll<HTMLElement>('[data-group-id]');assert.equal(rows[0].dataset.groupId,'opaque:0');assert.equal(rows[1].dataset.groupId,'opaque:1');rows[0].querySelector<HTMLInputElement>('input')!.click();assert.deepEqual(f.groups.read(),['1']);assert.equal(f.changes(),1);
 }finally{f.cleanup();}
});
test('manual groups add typed empty groups, hide/show all, and preserve input draft until commit or Escape',()=>{
 const f=fixture();try{
  f.get<HTMLButtonElement>('Add group').click();assert.equal(f.drafts.at(-1),true);assert.throws(()=>f.groups.read(),/Finish or cancel/);let input=f.get<HTMLInputElement>('Group name');input.value='30';f.get<HTMLButtonElement>('Create group').click();assert.deepEqual(f.groups.read(),[1,'1',30]);assert.equal(f.drafts.at(-1),false);
  f.get<HTMLButtonElement>('Hide all groups').click();assert.deepEqual(f.groups.read(),[]);f.get<HTMLButtonElement>('Show all groups').click();assert.deepEqual(f.groups.read(),[1,'1',30]);
  f.get<HTMLButtonElement>('Add group').click();input=f.get<HTMLInputElement>('Group name');input.value='bad';f.get<HTMLButtonElement>('Create group').click();assert.match(f.errors.at(-1)!,/finite number/);assert.equal(input.isConnected,true);input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.drafts.at(-1),false);assert.deepEqual(f.groups.read(),[1,'1',30]);
 }finally{f.cleanup();}
});
test('automatic order can return to retained manual group order and keyboard reorder preserves types',()=>{
 const f=fixture();try{const row=f.doc.querySelector<HTMLElement>('[data-group-id]')!;row.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}));assert.deepEqual(f.groups.read(),['1',1]);f.groups.setManual(false);assert.equal(f.groups.read(),undefined);f.groups.setManual(true);assert.deepEqual(f.groups.read(),['1',1]);}finally{f.cleanup();}
});
test('visual filter decoding accepts bare/dotted/bracketed syntax without evaluating and retains advanced expressions',()=>{
 for(const source of ['score >= -2','note.score >= -2','note["score"] >= -2'])assert.deepEqual(decodeFilterCondition(source),{property:'note.score',operator:'gte',text:'-2',type:'number'});
 assert.deepEqual(decodeFilterCondition('file.ext == "md"'),{property:'file.ext',operator:'eq',text:'md',type:'text'});assert.deepEqual(decodeFilterCondition('tags.contains("book")'),{property:'note.tags',operator:'contains',text:'book',type:'text'});assert.equal(decodeFilterCondition('score + 2 > 10'),undefined);assert.equal(decodeFilterCondition('danger()'),undefined);assert.equal(buildFilterCondition('score','lte','20','number'),'note["score"] <= 20');
});

test('an own-save result refresh preserves an in-progress new group widget and its draft guard',()=>{
 const f=fixture(true);try{
  f.get<HTMLButtonElement>('Add group').click();const input=f.get<HTMLInputElement>('Group name');input.value='42';f.groups.update({...f.result,version:2},false);assert.equal(input.isConnected,true);assert.equal(input.value,'42');assert.throws(()=>f.groups.read(),/Finish or cancel/);f.get<HTMLButtonElement>('Create group').click();assert.deepEqual(f.groups.read(),[1,'1',42]);
 }finally{f.cleanup();}
});


test('other manual group actions cannot destroy a pending new-group input',()=>{
 const f=fixture(true);try{f.get<HTMLButtonElement>('Add group').click();const input=f.get<HTMLInputElement>('Group name');input.value='42';f.doc.querySelector<HTMLInputElement>('[data-group-id] input')!.click();f.get<HTMLButtonElement>('Hide all groups').click();assert.equal(input.isConnected,true);assert.equal(input.value,'42');assert.throws(()=>f.groups.read(),/Finish or cancel/);f.get<HTMLButtonElement>('Create group').click();assert.deepEqual(f.groups.read(),[1,'1',42]);}finally{f.cleanup();}
});

function sharedFixture(entries:readonly {key:BaseExpressionValue;orderKey?:BaseValue;editKey?:BaseValue;listed?:boolean}[],order:readonly BaseValue[]=[]){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const baseline=executeBaseQuery(BaseDocument.parse('views: [{type: table,name: A,groupBy: {property: formula.project,direction: ASC},groupOrder: []}]'),{version:3,files:[]});
 const result={...baseline,shared:{} as any,view:{...baseline.view,groupOrder:order},groups:entries.map((entry,index)=>({...entry,sharedKeyId:`opaque:${index}`,rows:[]})),groupOptions:entries.map((entry,index)=>({...entry,sharedKeyId:`opaque:${index}`,count:0,listed:entry.listed??false}))} as BaseQueryResult;
 const errors:string[]=[];let changes=0,property='formula.project';
 const groups=createBaseManualGroups(doc,doc.querySelector('main')!,{result,property:()=>property,changed(){changes++;},error(message){errors.push(message);}});
 return{dom,doc,result,groups,errors,changes:()=>changes,setProperty(next:string){property=next;},row(index:number){return doc.querySelectorAll<HTMLElement>('[data-group-id]')[index];},cleanup(){groups.destroy();dom.window.close();}};
}

test('manual toolbar groups use core ordering keys for readonly wiki/date/whole-list/object/null groups',()=>{
 let accesses=0;const link:BaseExpressionValue={type:'namespace',name:'Alias',get(){accesses++;throw Error('must remain inert');}},date:BaseExpressionValue={type:'date',timestamp:Date.UTC(2026,9,22),hasTime:true};
 const keys=[link,date,{type:'list',value:[link,date]} as BaseExpressionValue,{type:'object',value:{project:link}} as BaseExpressionValue,{type:'null'} as BaseExpressionValue];
 const raw:BaseValue[]=['[[/A%23B.md|Alias]]','2026-10-22T00:00:00+00:00',['[[/A%23B.md|Alias]]','2026-10-22T00:00:00+00:00'],{project:'[[/A%23B.md|Alias]]'},null];
 for(let index=0;index<keys.length;index++){
  const f=sharedFixture([{key:keys[index],orderKey:raw[index],editKey:'WRONG note assignment'}]);try{f.row(0).querySelector<HTMLInputElement>('input')!.click();assert.deepEqual(f.groups.read(),[raw[index]]);assert.equal(f.changes(),1);}finally{f.cleanup();}
 }
 assert.equal(accesses,0);
});

test('manual toolbar groups retain exact raw ordinals across automatic order and result refresh',()=>{
 const key:BaseExpressionValue={type:'namespace',name:'Same label',get(){throw Error('must remain inert');}};
 const f=sharedFixture([{key,listed:true,orderKey:'[[/Canonical.md]]'},{key,orderKey:['[[/Other.md]]',null]}],['original alias spelling']);
 try{
  f.row(1).querySelector<HTMLInputElement>('input')!.click();assert.deepEqual(f.groups.read(),['original alias spelling',['[[/Other.md]]',null]]);
  f.groups.setManual(false);assert.equal(f.groups.read(),undefined);
  f.groups.update({...f.result,version:4,view:{...f.result.view,groupOrder:undefined},groupOptions:f.result.groupOptions.map(group=>({...group,listed:false}))},false);
  f.groups.setManual(true);assert.deepEqual(f.groups.read(),['original alias spelling',['[[/Other.md]]',null]]);
  f.row(1).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}));assert.deepEqual(f.groups.read(),[['[[/Other.md]]',null],'original alias spelling']);
 }finally{f.cleanup();}
});

test('missing core orderKey stays readonly through Show all, keyboard, drag and canceled Add group',()=>{
 const unknown:BaseExpressionValue={type:'namespace',name:'Unavailable',get(){throw Error('must remain inert');}};
 const f=sharedFixture([{key:unknown,editKey:'not an order key'},{key:{type:'string',value:'Ready'},orderKey:'ready raw'}]);
 try{
  const readonly=()=>f.row(0).querySelector<HTMLInputElement>('input')!;
  assert.equal(readonly().disabled,true);assert.equal(f.row(0).getAttribute('aria-disabled'),'true');assert.equal(f.row(0).querySelector<HTMLElement>('.bases-manual-group-grip')!.draggable,false);assert.match(f.doc.querySelector('[role="status"]')!.textContent!,/no safe configuration key/);
  f.row(0).click();f.row(0).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(f.changes(),0);
  f.doc.querySelector<HTMLButtonElement>('[aria-label="Show all groups"]')!.click();assert.deepEqual(f.groups.read(),['ready raw']);
  f.doc.querySelector<HTMLButtonElement>('[aria-label="Add group"]')!.click();const input=f.doc.querySelector<HTMLInputElement>('[aria-label="Group name"]')!;input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(readonly().disabled,true);
  assert.deepEqual(f.groups.read(),['ready raw']);
 }finally{f.cleanup();}
});

test('changing the grouping property retires its remembered typed manual order',()=>{
 const key:BaseExpressionValue={type:'namespace',name:'Old project',get(){throw Error('must remain inert');}};
 const f=sharedFixture([{key,listed:true,orderKey:'[[/Old.md]]'}],['old alias']);
 try{
  f.groups.setManual(false);f.setProperty('formula.other');f.groups.update(f.result,false);f.groups.setManual(true);assert.deepEqual(f.groups.read(),[]);
  f.groups.setManual(false);f.groups.update({...f.result,version:4,view:{...f.result.view,groupBy:{property:'formula.other',direction:'ASC'},groupOrder:undefined}},false);f.groups.setManual(true);assert.deepEqual(f.groups.read(),[]);
 }finally{f.cleanup();}
});
