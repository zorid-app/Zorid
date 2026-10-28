import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import type {BaseValue,BaseViewPatch} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar,BaseToolbarSaveError} from '../src/bases/toolbar.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(filters?:BaseValue, kinds:Record<string,import('../src/bases/toolbar-filter-types.ts').BaseFilterPropertyDescriptor>={}){
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
  const document=BaseDocument.parse(JSON.stringify({views:[{type:'table',name:'Library',...(filters===undefined?{}:{filters})},{type:'table',name:'Other'}]}));
  let latest:ReturnType<typeof executeBaseQuery>;
  let version=1,selectedIndex=0,hook:((patch:Patch)=>Promise<void>)|undefined;
  type Patch={view?:BaseViewPatch;root?:Record<string,BaseValue|undefined>};
  const calls:Array<{version:unknown;patch:Patch}>=[],errors:unknown[]=[];
  const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_v,patch){commit({view:patch});},commands:{async updateRoot(){}},
    filterOperands:()=>({files:['Items/A "quoted".md'],folders:['/','Items'],tags:['#one','#two/child'],properties:['note.literal','status'],metadataStatus:'stale'}),
    async saveConfiguration(expected,patch){calls.push({version:expected,patch:structuredClone(patch)});if(hook)await hook(patch);else commit(patch);},onDraftChange(){},onError(error){errors.push(error);}});
  function refresh(){const result=executeBaseQuery(document,{version,files:[{path:'A.md',properties:{score:2,text:'Alpha beta',items:['red','blue'],enabled:false,due:'2026-10-22'}},{path:'B.md',properties:{score:5,text:'gamma',items:[],enabled:true,due:'2026-10-23'}}]},{viewIndex:selectedIndex});latest=result;toolbar.update({result,views:document.views,selectedIndex,root:{...(document.getRoot('filters')===undefined?{}:{filters:document.getRoot('filters')!})},rootFilters:document.getRoot('filters'),readOnly:false,allowRename:true,filterProperty:p=>kinds[p],label:p=>p==='file.file'?'file':p});}
  function commit(patch:Patch){if(patch.view)document.updateView(selectedIndex,patch.view);if(patch.root)document.updateRoot(patch.root);version++;refresh();}
  refresh();
  const get=<T extends HTMLElement>(label:string,scope:ParentNode=doc)=>{const node=scope.querySelector<T>(`[aria-label=${JSON.stringify(label)}]`);assert.ok(node,label);return node;};
  const edit=(label:string,value:string,event='input',scope:ParentNode=doc)=>{const node=get<HTMLInputElement>(label,scope);node.value=value;node.dispatchEvent(new dom.window.Event(event,{bubbles:true}));};
  const click=(label:string)=>get<HTMLButtonElement>(label).click();
  const submit=()=>doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  return {get result(){return latest;},dom,doc,document,toolbar,calls,errors,get,edit,click,submit,commit,setHook(value:typeof hook){hook=value;},switchView(){selectedIndex=1;version++;refresh();},refreshNote(){version++;refresh();},get version(){return version;},cleanup(){toolbar.destroy();dom.window.close();}};
}

const kinds={
  'note.text':{kind:'string'},'note.items':{kind:'list'},'note.score':{kind:'number'},
  'note.enabled':{kind:'boolean'},'note.due':{kind:'date'},'note.when':{kind:'date',withTime:true},
} as const;
const section=(f:ReturnType<typeof fixture>)=>f.doc.querySelectorAll('.bases-filter-section')[1];
const source=(f:ReturnType<typeof fixture>)=>f.document.views[0].filters;
const enter=(f:ReturnType<typeof fixture>)=>f.get('Filter value').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
async function save(f:ReturnType<typeof fixture>){f.submit();await tick();await tick();}
test('captured String family survives zero rows and offers ordered positive then inverse methods',()=>{
 const f=fixture('note.text == "missing"',kinds);try{f.click('Filter');assert.equal(f.result.counts.returned,0);assert.deepEqual([...f.get<HTMLSelectElement>('Condition').options].map(x=>x.value),['eq','neq','startsWith','endsWith','isEmpty','contains','containsAny','containsAll','notStartsWith','notEndsWith','isNotEmpty','notContains','notContainsAny','notContainsAll']);}finally{f.cleanup();}
});
test('String predicates author quoted literals and inverse whole calls without result sampling',async()=>{
 const f=fixture(undefined,kinds);try{f.click('Filter');f.edit('Filter property','note.text','change');f.edit('Condition','notStartsWith','change');f.edit('Filter value','Alpha "quoted"');await save(f);assert.deepEqual(source(f),{and:[String.raw`!note["text"].startsWith("Alpha \"quoted\"")`]});}finally{f.cleanup();}
});
test('zero argument emptiness differs from null and explicit empty scalar source is preserved on opening',async()=>{
 const f=fixture('note.text == ""',kinds);try{f.click('Filter');assert.equal(f.get<HTMLInputElement>('Filter value').value,'');assert.equal(f.calls.length,0);f.edit('Condition','isEmpty','change');assert.equal(section(f).querySelector('[aria-label="Filter value"]'),null);await save(f);assert.equal(source(f),'note["text"].isEmpty()');assert.notEqual(source(f),'note["text"] == null');}finally{f.cleanup();}
});
test('String variadic arguments require explicit item commit and preserve literal argument order',async()=>{
 const f=fixture(undefined,kinds);try{f.click('Filter');f.edit('Filter property','note.text','change');f.edit('Condition','containsAny','change');f.edit('Filter value','beta');await save(f);assert.equal(f.calls.length,0);enter(f);f.edit('Filter value','gamma');enter(f);await save(f);assert.deepEqual(source(f),{and:['note["text"].containsAny("beta", "gamma")']});assert.deepEqual([...f.get<HTMLSelectElement>('Item type').options].map(x=>x.value),['string']);}finally{f.cleanup();}
});
test('List exact mixed members remain one typed array, while containsAny uses separate typed arguments',async()=>{
 const f=fixture('note.items == [1, true, "1", null]',kinds);try{f.click('Filter');assert.equal(f.get<HTMLSelectElement>('Condition').value,'eq');f.edit('Filter value','red');enter(f);await save(f);assert.equal(source(f),'note["items"] == [1, true, "1", null, "red"]');f.edit('Condition','containsAny','change');assert.equal(f.calls.length,1);f.edit('Item type','number','change');f.edit('Filter value','2');enter(f);f.edit('Item type','boolean','change');const input=f.get<HTMLInputElement>('Filter value');input.checked=true;input.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));enter(f);await save(f);assert.equal(source(f),'note["items"].containsAny(2, true)');}finally{f.cleanup();}
});
test('empty list is a complete exact operand and comparison Clear value is explicit null',async()=>{
 const f=fixture(undefined,kinds);try{f.click('Filter');f.edit('Filter property','note.items','change');f.click('Empty list');await save(f);assert.deepEqual(source(f),{and:['note["items"] == []']});f.click('Clear value');await save(f);assert.deepEqual(source(f),{and:['note["items"] == null']});}finally{f.cleanup();}
});
test('Number rejects invalid edits and blocks structural draft loss before repair',async()=>{
 const f=fixture('note.score > 1',kinds);try{f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');assert.equal(input.inputMode,'decimal');f.edit('Filter value','1e');f.edit('Condition','isEmpty','change');assert.equal(f.get<HTMLSelectElement>('Condition').value,'gt');f.click('Edit expression');assert.equal(input.isConnected,true);await save(f);assert.equal(f.calls.length,0);f.edit('Filter value','3');await save(f);assert.equal(source(f),'note["score"] > 3');}finally{f.cleanup();}
});
test('Checkbox offers only is/is not, false is real data and Clear value explicitly authors null',async()=>{
 const f=fixture(undefined,kinds);try{f.click('Filter');f.edit('Filter property','note.enabled','change');assert.deepEqual([...f.get<HTMLSelectElement>('Condition').options].map(x=>x.value),['eq','neq']);const input=f.get<HTMLInputElement>('Filter value');assert.equal(input.type,'checkbox');assert.equal(input.indeterminate,true);input.checked=false;input.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await save(f);assert.deepEqual(source(f),{and:['note["enabled"] == false']});f.click('Clear value');await save(f);assert.deepEqual(source(f),{and:['note["enabled"] == null']});}finally{f.cleanup();}
});
test('Date and dateTime comparisons keep quoted civil strings and preserved offsets',async()=>{
 for(const [property,value,type]of [['note.due','2026-10-22','date'],['note.when','2026-10-22T12:34:00-04:00','datetime-local']]){
 const f=fixture(`${property} < "${value}"`,kinds);try{f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');assert.equal(input.type,type);f.edit('Condition','gte','change');await save(f);assert.equal(source(f),`${property==='note.due'?'note["due"]':'note["when"]'} >= "${value}"`);}finally{f.cleanup();}}
});
test('unknown methods and dynamic expressions remain exact advanced source through unrelated scope edits',async()=>{
 for(const expression of [' note.score > max(1, 2) ','note.text.matches(/foo/)','note.enabled.contains("x")']){
 const f=fixture(expression,kinds);try{f.click('Filter');assert.equal(f.get<HTMLTextAreaElement>('Filter expression',section(f)).value,expression);f.click('All views');const root=f.doc.querySelectorAll('.bases-filter-section')[0];f.edit('Filter value','A.md','input',root);await save(f);assert.equal(source(f),expression);}finally{f.cleanup();}}
});
test('pending typed member prevents operator/property/advanced changes and explicit Remove discards only that row',async()=>{
 const f=fixture('note.items.containsAny("red")',kinds);try{f.click('Filter');f.edit('Filter value','pending');const input=f.get('Filter value');f.edit('Condition','eq','change');f.edit('Filter property','note.text','change');f.click('Edit expression');assert.equal(input.isConnected,true);assert.equal(f.get<HTMLSelectElement>('Condition').value,'containsAny');assert.equal(f.get<HTMLSelectElement>('Filter property').value,'note.items');f.click('Remove filter');await save(f);assert.equal(source(f),undefined);}finally{f.cleanup();}
});

test('changing an operator preserves an already-authored empty literal and explicit empty list members remain data',async()=>{
 const f=fixture('note.text == ""',kinds);try{f.click('Filter');f.edit('Condition','neq','change');await save(f);assert.equal(source(f),'note["text"] != ""');f.edit('Condition','containsAny','change');f.click('Add item');await save(f);assert.equal(source(f),'note["text"].containsAny("")');}finally{f.cleanup();}
});

test('unknown property category preserves authored Number Boolean and List operands across comparisons',async()=>{
 for(const [literal,expectedType]of [['1','text'],['false','checkbox'],['[1, true, "one"]','text']]){
  const f=fixture(`note.unknown == ${literal}`);try{
   f.click('Filter');assert.equal(f.get<HTMLInputElement>('Filter value').type,expectedType);
   f.edit('Condition','neq','change');assert.equal(f.doc.querySelector('form')!.checkValidity(),true);
   await save(f);assert.equal(source(f),`note["unknown"] != ${literal}`);
   f.edit('Condition','eq','change');await save(f);assert.equal(source(f),`note["unknown"] == ${literal}`);
  }finally{f.cleanup();}
 }
});

test('dateTime seconds and fractional offsets remain valid through operator-only saves',async()=>{
 for(const raw of ['2026-10-22T12:34:30','2026-10-22T12:34:30.123-04:00']){
  const f=fixture(`note.when < "${raw}"`,kinds);try{
   f.click('Filter');const input=f.get<HTMLInputElement>('Filter value');
   assert.equal(input.validity.stepMismatch,false);assert.equal(f.doc.querySelector('form')!.checkValidity(),true);
   f.edit('Condition','gte','change');assert.equal(f.doc.querySelector('form')!.checkValidity(),true);
   await save(f);assert.equal(source(f),`note["when"] >= "${raw}"`);
  }finally{f.cleanup();}
 }
});

test('focused list-chip removal keeps toolbar Escape ownership at the actual adjacent control',async()=>{
 const f=fixture('note.items == ["one", "two"]',kinds);try{
  f.click('Filter');f.get('Remove item one').focus();f.click('Remove item one');
  assert.equal(f.doc.activeElement,f.get('Remove item two'));
  f.doc.activeElement!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await tick();await tick();assert.equal(f.doc.querySelector('[role="dialog"]'),null);assert.equal(source(f),'note["items"] == ["two"]');
 }finally{f.cleanup();}
});
