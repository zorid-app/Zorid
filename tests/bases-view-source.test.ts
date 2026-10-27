import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument, baseViewSource, baseViewSetting, resetViewSourcePatch } from '../src/bases/document.ts';
import { BaseController, createBaseMutationHost } from '../src/bases/controller.ts';
import { inferBaseCreationDefaults, planBaseItemCreation, prepareBaseFileCreation } from '../src/bases/creation.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';

const books = { kind: 'collection' as const, id: 'books0123456' };
const projects = { kind: 'collection' as const, id: 'proj01234567' };
const untyped = { kind: 'untyped' as const };
const view = (source: object, extra: object = {}) => ({ type: 'table', name: 'Main', source, ...extra });
const document = (views: object[], root: object = {}) => BaseDocument.parse(JSON.stringify({ ...root, views }));

test('view source is exactly one collection or untyped; labels cannot identify ownership', () => {
  assert.deepEqual(baseViewSource({type:'table',name:'Legacy'}), untyped);
  assert.deepEqual(baseViewSource(view(books)), books);
  for (const source of [null, 'Books', {kind:'all'}, {kind:'collection',id:'Books'}, {kind:'collection',id:books.id,other:projects.id}, {kind:'untyped',id:books.id}, {kind:'collection',ids:[books.id,projects.id]}]) {
    assert.throws(() => document([view(source as object)]), /source/);
  }
});

test('switching source resets field configuration only in the selected view', () => {
  const first = view(books, {name:'Books', filters:'Status == "Reading"', formulas:{label:'Status'}, summaryDefinitions:{Total:'values.sum()'}, order:['file.name','Status'], groupBy:{property:'Status',direction:'ASC'}, sort:[{property:'Status',direction:'ASC'}], newItemTemplate:'Template.md', columnSize:{Status:200}, image:'Cover', rowHeight:55, pluginLayout:{keep:true}});
  const second = view(projects, {name:'Projects', filters:'Status == "Active"', order:['file.name','Status']});
  const doc = document([first, second], {filters:'legacy == true',newItemFolder:'Legacy',pluginRoot:{keep:true}});
  doc.changeViewSource(0, projects);
  assert.deepEqual(doc.views[0], view(projects, {name:'Books',rowHeight:55,pluginLayout:{keep:true}}));
  assert.deepEqual(doc.views[1], second); assert.equal(doc.getRoot('filters'),'legacy == true');
  assert.equal(baseViewSetting(doc,0,'newItemFolder'),undefined);
  assert.deepEqual(doc.getRoot('pluginRoot'),{keep:true});
  const before = doc.toString();doc.changeViewSource(0,projects);assert.equal(doc.toString(),before);
  assert.deepEqual(resetViewSourcePatch(doc.views[0],untyped).source,untyped);
  doc.duplicateView(0,'Copy');assert.deepEqual(baseViewSource(doc.views[2]),projects);
});

test('explicit views ignore legacy root filters and formula definitions; sibling legacy remains unchanged', () => {
  const doc=document([view(untyped,{filters:'score == 2',formulas:{value:'score + 1'},order:['file.name','formula.value']}),{type:'table',name:'Legacy'}],{filters:'score == 1',formulas:{value:'score + 10'}});
  const files=[{path:'One.md',properties:{score:1}},{path:'Two.md',properties:{score:2}}];
  const explicit=executeBaseQuery(doc,{version:1,files},{viewIndex:0});
  assert.deepEqual(explicit.rows.map(row=>row.path),['Two.md']);assert.deepEqual(explicit.rows[0].values['formula.value'],{type:'number',value:3});
  const legacy=executeBaseQuery(doc,{version:1,files},{viewIndex:1});assert.deepEqual(legacy.rows.map(row=>row.path),['One.md']);
  assert.throws(()=>executeBaseQuery(document([view(books)]),{version:1,files}),/authoritative document service/);
});

test('formula, summary and former root controls stay scoped to their explicit view', () => {
  const doc=document([view(books,{formulas:{label:'Status'},order:['file.name','formula.label'],filters:'formula.label == "Done"',summaryDefinitions:{Total:'values.sum()'},summaries:{score:'Total'}}),view(projects,{name:'Other',formulas:{label:'"Other"'},order:['formula.label'],summaryDefinitions:{Total:'values.average()'},summaries:{score:'Total'}})],{formulas:{label:'"Legacy"'},summaries:{Total:'values.count()'}});
  const sibling=structuredClone(doc.views[1]);
  doc.renameViewFormula(0,'label','caption');doc.setViewFormula(0,'extra','1');
  assert.deepEqual(doc.views[0].formulas,{caption:'Status',extra:'1'});assert.deepEqual(doc.views[0].order,['file.name','formula.caption']);assert.match(String(doc.views[0].filters),/formula.caption/);
  doc.editViewSummary(0,'Total','Sum','values.sum()');assert.deepEqual(doc.views[0].summaries,{score:'Sum'});assert.deepEqual(doc.views[0].summaryDefinitions,{Sum:'values.sum()'});
  doc.removeViewSummary(0,'Sum');assert.deepEqual(doc.views[0].summaries,{});assert.deepEqual(doc.views[0].summaryDefinitions,{});
  doc.updateViewConfiguration(0,{root:{filters:'Status == "Reading"',newItemFolder:'Books',properties:{Status:{displayName:'State'}}},view:{limit:20}});
  assert.equal(doc.views[0].filters,'Status == "Reading"');assert.equal(doc.views[0].newItemFolder,'Books');assert.deepEqual(doc.getRoot('formulas'),{label:'"Legacy"'});assert.deepEqual(doc.getRoot('summaries'),{Total:'values.count()'});assert.deepEqual(doc.views[1],sibling);
  const before=doc.toString();assert.throws(()=>doc.updateViewConfiguration(0,{root:{pluginRoot:'would change'},view:{source:{kind:'collection',id:'bad'}}}),/source/);assert.equal(doc.toString(),before);
  let invoked=false;const accessor=Object.defineProperty({},'filters',{enumerable:true,get(){invoked=true;return 'true';}});assert.throws(()=>doc.updateViewConfiguration(0,{root:accessor}),/ordinary enumerable/);assert.equal(invoked,false);assert.equal(doc.toString(),before);
});

test('New uses first useful OR branch, strict numeric boundaries and title hints without asking', () => {
  const cases:[string,object,string?][]=[
    ['Status == "Done"',{Status:'Done'}],
    ['Status == "Reading" || Rating >= 4',{Status:'Reading'}],
    ['unsupported() || Rating >= 4',{Rating:4}],
    ['Rating > 4',{Rating:5}],
    ['4 < Rating',{Rating:5}],
    ['Rating < 4',{Rating:3}],
    ['Rating > 4 && Rating < 4',{Rating:5}],
    ['done && !archived',{done:true,archived:false}],
    ['file.name.contains("OR marker") || Rating == 4',{},'OR marker'],
  ];
  for(const[filters,properties,title]of cases){const actual=inferBaseCreationDefaults(document([view(untyped,{filters})]));assert.deepEqual(actual.properties,properties,filters);assert.equal(actual.title,title,filters);}
  const alternatives=inferBaseCreationDefaults(document([view(untyped,{filters:{and:[{or:['file.inFolder("Books")','file.inFolder("Articles")']},'file.hasTag("reading")']}})]));
  assert.equal(alternatives.folder,'Books');assert.deepEqual(alternatives.properties,{tags:['reading']});
  const unsupported=inferBaseCreationDefaults(document([view(untyped,{filters:'file.mtime > date("tomorrow")'})]));assert.deepEqual(unsupported.properties,{});assert.ok(unsupported.warnings.length);
  const unsafe=inferBaseCreationDefaults(document([view(untyped,{filters:'file.inFolder("../escape") && _type == "Books" && _id == "other"'})]));assert.equal(unsafe.folder,undefined);assert.deepEqual(unsafe.properties,{});
});

test('new Base persists no views for onboarding, while explicit-source note creation never inherits other source defaults', async () => {
  const vault=new Vault(new MemoryAdapter());await vault.initialize();
  const operation=await prepareBaseFileCreation({vault,name:'Personal'});await operation.run();assert.deepEqual(BaseDocument.parse(await vault.read(operation.path)).views,[]);
  const doc=document([view(untyped,{filters:'file.name.contains("New book") && file.inFolder("Books")',order:['file.name','unwanted'],newItemFolder:'Reading'})],{newItemFolder:'Legacy',newItemTemplate:'Missing.md',filters:'legacy == true'});
  const plan=await planBaseItemCreation({vault,document:doc,basePath:'Personal.base',group:{property:'formula.status',value:'Done'}});
  assert.equal(plan.path,'Reading/New book.md');assert.equal(plan.text,'');assert.ok(plan.warnings.some(w=>w.includes('computed')));
});

async function fixture(source: string) {
  const vault=new Vault(new MemoryAdapter({'Personal.base':source,'Note.md':'Body'}));await vault.initialize();
  const buffers=new Map<string,NoteBuffer>();const getBuffer=async(path:string)=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});buffers.set(path,buffer);}await buffer.load();return buffer;};
  const controller=new BaseController({vault,basePath:'Personal.base',mutations:createBaseMutationHost({getBuffer,validate(){}}),delayMs:1000});await controller.refresh();
  return{vault,controller,getBuffer,async stop(){controller.dispose();for(const buffer of buffers.values())await buffer.dispose();}};
}

test('empty Base can add its first sourced view, delete its last view and reopen without resurrection',async()=>{
  const f=await fixture('views: []\n');try{
    assert.equal(f.controller.state.error,null);assert.equal(f.controller.state.result,null);
    await f.controller.addView(f.controller.state.version,'table','Notes',{source:untyped,filters:'file.ext == "md"'});
    assert.deepEqual(f.controller.state.result?.rows.map(row=>row.path),['Note.md']);
    await f.controller.removeView(f.controller.state.version);assert.equal(f.controller.state.error,null);assert.equal(f.controller.state.result,null);
    assert.deepEqual(BaseDocument.parse(await f.vault.read('Personal.base')).views,[]);await f.controller.refresh();assert.equal(f.controller.state.result,null);
    await f.controller.addView(f.controller.state.version,'list','Again',{source:untyped});assert.equal(f.controller.state.result?.view.name,'Again');
  }finally{await f.stop();}
});

test('first-view creation refuses stale command and preserves an existing dirty draft',async()=>{
  const f=await fixture('views: []\n');try{
    const old=f.controller.state.version;await f.controller.refresh();
    const buffer=await f.getBuffer('Personal.base');buffer.update('views: []\n# user draft\n');
    await assert.rejects(f.controller.addView(old,'table','Notes',{source:untyped}),/unsaved|stale/);
    assert.equal(buffer.text,'views: []\n# user draft\n');assert.equal(await f.vault.read('Personal.base'),'views: []\n');
    buffer.update(buffer.savedText);await buffer.flush();
  }finally{await f.stop();}
});
