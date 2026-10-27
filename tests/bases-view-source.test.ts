import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument, baseViewSource, baseViewSetting, resetViewSourcePatch, newBaseViewId, baseViewIndexByName, baseViewIndexById } from '../src/bases/document.ts';
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
  assert.deepEqual(doc.views[0], view(projects, {name:'Books',rowHeight:55,pluginLayout:{keep:true},id:doc.views[0].id}));
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
  const doc=document([view(books,{formulas:{label:'Status'},order:['file.name','formula.label'],filters:'formula.label == "Done"',summaryDefinitions:{Total:'values.sum() + formula.label'},properties:{'formula.label':{displayName:'Label'}},summaries:{score:'Total'}}),view(projects,{name:'Other',formulas:{label:'"Other"'},order:['formula.label'],summaryDefinitions:{Total:'values.average()'},summaries:{score:'Total'}})],{formulas:{label:'"Legacy"'},summaries:{Total:'values.count()'}});
  const sibling=structuredClone(doc.views[1]);
  doc.renameViewFormula(0,'label','caption');doc.setViewFormula(0,'extra','1');
  assert.deepEqual(doc.views[0].formulas,{caption:'Status',extra:'1'});assert.deepEqual(doc.views[0].order,['file.name','formula.caption']);assert.match(String(doc.views[0].filters),/formula.caption/);
  assert.deepEqual(doc.views[0].summaryDefinitions,{Total:'(values.sum() + formula.caption)'});assert.deepEqual(doc.views[0].properties,{'formula.caption':{displayName:'Label'}});
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

async function fixture(source: string, selection: {viewName?:string;viewId?:string} = {}, adapter = new MemoryAdapter({'Personal.base':source,'Note.md':'Body'})) {
  const vault=new Vault(adapter);await vault.initialize();
  const buffers=new Map<string,NoteBuffer>();const getBuffer=async(path:string)=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path,{debounceMs:60000});buffers.set(path,buffer);}await buffer.load();return buffer;};
  const controller=new BaseController({vault,basePath:'Personal.base',...selection,mutations:createBaseMutationHost({getBuffer,validate(){}}),delayMs:1000});await controller.refresh();
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


test('combined explicit-source rename and root controls use identical scoped bytes for reference publication',async()=>{
  const source=document([view(untyped,{filters:'file.ext == "md"'})],{filters:'legacy == true'}).toString();
  const f=await fixture(source);try{
    await f.vault.create('Link.md','[[Personal.base#Main]]');await f.controller.refresh();
    await f.controller.updateConfiguration(f.controller.state.version,{root:{filters:'true',newItemFolder:'Notes'},view:{name:'Renamed'}});
    const saved=BaseDocument.parse(await f.vault.read('Personal.base'));
    assert.equal(saved.getRoot('filters'),'legacy == true');assert.equal(saved.views[0].filters,'true');assert.equal(saved.views[0].newItemFolder,'Notes');assert.equal(saved.views[0].name,'Renamed');
    assert.equal(await f.vault.read('Link.md'),'[[Personal.base#Renamed]]');assert.equal(f.controller.hasPendingViewReferences,false);assert.equal(f.controller.state.error,null);
  }finally{await f.stop();}
});


test('legacy formula and summary edits cannot rewrite explicit-source sibling declarations or references',()=>{
  const explicit=view(books,{name:'Books',formulas:{label:'"Book"'},summaryDefinitions:{Total:'values.sum() + formula.label'},properties:{'formula.label':{displayName:'Book caption'}},order:['formula.label'],filters:'formula.label == "Book"',summaries:{score:'Total'}});
  const doc=document([{type:'table',name:'Legacy',filters:'formula.label == "Legacy"',order:['formula.label'],summaries:{score:'Total'}},explicit],{formulas:{label:'"Legacy"'},summaries:{Total:'values.count()'}});
  const sibling=structuredClone(doc.views[1]);
  doc.renameViewFormula(0,'label','caption');assert.deepEqual(doc.views[1],sibling);assert.deepEqual(doc.views[0].order,['formula.caption']);
  doc.editViewSummary(0,'Total','Count','values.count()');assert.deepEqual(doc.views[1],sibling);assert.deepEqual(doc.views[0].summaries,{score:'Count'});
  doc.removeViewSummary(0,'Count');assert.deepEqual(doc.views[1],sibling);assert.deepEqual(doc.views[0].summaries,{});
});


test('new views and duplicates have distinct stable identities independent of repeated display names',()=>{
  const doc=BaseDocument.parse('views: [{type: table, name: Same}]');
  doc.addView('list','Same');assert.equal(doc.views.length,2);assert.ok(doc.views.every(view=>typeof view.id==='string'&&/^[a-z0-9]{12}$/.test(view.id)));
  const original=doc.views[0].id;doc.duplicateView(0,'Same');assert.equal(new Set(doc.views.map(view=>view.id)).size,3);assert.equal(doc.views[0].id,original);
  const copy=doc.views[2].id;doc.updateView(2,{name:'Renamed'});doc.moveView(2,0);assert.equal(doc.views[0].id,copy);
  assert.deepEqual(BaseDocument.parse(doc.toString()).views,doc.views);assert.equal(baseViewIndexById(doc.views,copy as string),0);
  assert.throws(()=>baseViewIndexByName(doc.views,'Same'),/ambiguous/);
  for(const views of [[view(untyped,{id:'short'})],[view(untyped,{id:'abcdefghijkl'}),view(untyped,{id:'abcdefghijkl'})]])assert.throws(()=>document(views),/identities/);
  assert.match(newBaseViewId(doc.views.map(view=>view.id as string)),/^[a-z0-9]{12}$/);
});

test('selected identity survives repeated labels, external reordering, rename and deleting a neighboring view',async()=>{
  const a='aaaaaaaaaaaa',b='bbbbbbbbbbbb';
  const f=await fixture(document([view(untyped,{id:a,name:'Same',filters:'file.ext == "md"'}),view(untyped,{id:b,name:'Same',filters:'file.ext == "md"'})]).toString());try{
    await f.controller.setView(1);assert.equal(f.controller.selectedViewIdentity,b);
    const doc=BaseDocument.parse(await f.vault.read('Personal.base'));doc.moveView(1,0);await f.vault.modify('Personal.base',doc.toString());await f.controller.refresh();assert.equal(f.controller.selectedViewIdentity,b);assert.equal(f.controller.selectedViewIndex,0);assert.equal(f.controller.state.result?.view.id,b);
    await f.controller.renameView(f.controller.state.version,0,'Same');assert.equal(f.controller.state.result?.view.id,b);
    await f.controller.removeView(f.controller.state.version,1);assert.equal(f.controller.state.result?.view.id,b);assert.equal(f.controller.state.error,null);
  }finally{await f.stop();}
});

test('legacy ambiguous name bindings fail safely while explicit ID bindings select the intended repeated name',async()=>{
  const a='aaaaaaaaaaaa',b='bbbbbbbbbbbb';const source=document([view(untyped,{id:a,name:'Same',filters:'false'}),view(untyped,{id:b,name:'Same',filters:'file.ext == "md"'})]).toString();
  const ambiguous=await fixture(source,{viewName:'Same'});try{assert.match(ambiguous.controller.state.error?.message??'',/ambiguous/);assert.equal(ambiguous.controller.state.result,null);}finally{await ambiguous.stop();}
  const explicit=await fixture(source,{viewId:b});try{assert.equal(explicit.controller.state.error,null);assert.equal(explicit.controller.state.result?.view.id,b);assert.deepEqual(explicit.controller.state.result?.rows.map(row=>row.path),['Note.md']);}finally{await explicit.stop();}
});

test('renaming a repeated label never guesses which legacy name references to rewrite',async()=>{
  const source=document([view(untyped,{id:'aaaaaaaaaaaa',name:'Same',filters:'file.ext == "md"'}),view(untyped,{id:'bbbbbbbbbbbb',name:'Same',filters:'file.ext == "md"'})]).toString();
  const f=await fixture(source);try{
    await f.vault.create('Link.md','[[Personal.base#Same]]');await f.controller.refresh();
    await f.controller.renameView(f.controller.state.version,0,'Changed');assert.equal(await f.vault.read('Link.md'),'[[Personal.base#Same]]');assert.equal(f.controller.state.result?.view.id,'aaaaaaaaaaaa');assert.equal(f.controller.state.result?.view.name,'Changed');
  }finally{await f.stop();}
});


test('failed add and duplicate retries retain exact allocated identities and saved bytes',async()=>{
  class Adapter extends MemoryAdapter { fail=false;override async write(path:string,text:string){if(this.fail&&path==='Personal.base')throw new Error('disk full');return super.write(path,text);} }
  const source='views: []\n',adapter=new Adapter({'Personal.base':source,'Note.md':'Body'}),f=await fixture(source,{},adapter);try{
    const version=f.controller.state.version;adapter.fail=true;
    await assert.rejects(f.controller.addView(version,'table','Same',{source:untyped}),/disk full/);
    const buffer=await f.getBuffer('Personal.base'),desired=buffer.text,firstId=BaseDocument.parse(desired).views[0].id;
    adapter.fail=false;await f.controller.addView(version,'table','Same',{source:untyped});assert.equal(await f.vault.read('Personal.base'),desired);assert.equal(f.controller.selectedViewIdentity,firstId);
    const duplicateVersion=f.controller.state.version;adapter.fail=true;
    await assert.rejects(f.controller.duplicateView(duplicateVersion,0,'Same'),/disk full/);const duplicated=buffer.text,views=BaseDocument.parse(duplicated).views;assert.notEqual(views[0].id,views[1].id);
    adapter.fail=false;await f.controller.duplicateView(duplicateVersion,0,'Same');assert.equal(await f.vault.read('Personal.base'),duplicated);assert.equal(f.controller.selectedViewIdentity,views[1].id);
  }finally{adapter.fail=false;await f.stop();}
});


test('top-level view selection recovers a neighbor after another pane deletes the selected view',async()=>{
  const a='aaaaaaaaaaaa',b='bbbbbbbbbbbb',c='cccccccccccc';
  const source=document([view(untyped,{id:a,name:'First'}),view(untyped,{id:b,name:'Selected'}),view(untyped,{id:c,name:'Next'})]).toString();
  const f=await fixture(source);try{
    await f.controller.setView(1);assert.equal(f.controller.selectedViewIdentity,b);
    const changed=BaseDocument.parse(await f.vault.read('Personal.base'));changed.removeView(1);await f.vault.modify('Personal.base',changed.toString());await f.controller.refresh();
    assert.equal(f.controller.state.error,null);assert.equal(f.controller.selectedViewIndex,1);assert.equal(f.controller.selectedViewIdentity,c);assert.equal(f.controller.state.result?.view.name,'Next');assert.equal(f.controller.state.source,changed.toString());
    await f.controller.renameView(f.controller.state.version,1,'Surviving');assert.equal(BaseDocument.parse(await f.vault.read('Personal.base')).views[1].name,'Surviving');
  }finally{await f.stop();}
});

test('external last-view deletion publishes current empty onboarding and permits adding a view',async()=>{
  const source=document([view(untyped,{id:'aaaaaaaaaaaa',name:'Only'})]).toString();
  const f=await fixture(source);try{
    assert.equal(f.controller.selectedViewIdentity,'aaaaaaaaaaaa');
    await f.vault.modify('Personal.base','views: []\n');await f.controller.refresh();
    assert.equal(f.controller.state.error,null);assert.equal(f.controller.state.result,null);assert.equal(f.controller.state.source,'views: []\n');assert.equal(f.controller.selectedViewIdentity,undefined);
    await f.controller.addView(f.controller.state.version,'list','New',{source:untyped});assert.equal(f.controller.state.error,null);assert.equal(f.controller.state.result?.view.name,'New');assert.equal(BaseDocument.parse(await f.vault.read('Personal.base')).views.length,1);
  }finally{await f.stop();}
});

test('explicit ID/name embeds do not retarget when their selected view is externally deleted',async()=>{
  for(const selection of [{viewId:'aaaaaaaaaaaa'},{viewName:'Bound'}]){
    const source=document([view(untyped,{id:'aaaaaaaaaaaa',name:'Bound'}),view(untyped,{id:'bbbbbbbbbbbb',name:'Other'})]).toString();
    const f=await fixture(source,selection);try{
      const original=f.controller.state.result;assert.equal(original?.view.id,'aaaaaaaaaaaa');
      const changed=BaseDocument.parse(await f.vault.read('Personal.base'));changed.removeView(0);await f.vault.modify('Personal.base',changed.toString());await f.controller.refresh();
      assert.match(f.controller.state.error?.message??'',/no longer exists|not found/);assert.equal(f.controller.state.result,original);assert.equal(f.controller.selectedViewIdentity,'aaaaaaaaaaaa');
      await f.vault.modify('Personal.base','views: []\n');await f.controller.refresh();assert.ok(f.controller.state.error);assert.equal(f.controller.state.result,original);
    }finally{await f.stop();}
  }
});
