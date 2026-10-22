import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseManualGroups} from '../src/bases/toolbar-groups.ts';
import {decodeFilterCondition,buildFilterCondition} from '../src/bases/toolbar-config.ts';
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
