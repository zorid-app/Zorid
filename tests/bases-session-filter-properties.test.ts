import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentBaseResult,DocumentEntry, DocumentMetadata, DocumentMetadataRowsItem, DocumentProperty, DocumentService, DocumentSnapshotId, DocumentTransport} from '../src/core/document-semantics.ts';
import type {DocumentRuntimeUpdate} from '../src/core/document-runtime.ts';
import type {VaultEntry} from '../src/core/types.ts';
import {baseSessionFilterProperties,baseSessionFilterPropertyProvider,createBaseSession} from '../src/bases/session.ts';
import type {BasePropertyDefinitions} from '../src/bases/property-definitions.ts';
import {JSDOM} from 'jsdom';
import {BaseDocument} from '../src/bases/document.ts';
import {executeBaseQuery} from '../src/bases/query.ts';
import {createBaseToolbar} from '../src/bases/toolbar.ts';

const empty:BasePropertyDefinitions={properties:{},diagnostics:[]};
const versions={schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'resolver-1',query:'query-1'};
const property=(key:string,type:DocumentProperty['type'],value:DocumentProperty['value']):DocumentProperty=>({key,type,value,keyRange:{bytes:[4,5],utf16:[4,5]}});
function file(path:string,properties:DocumentProperty[],id=path.replace(/[^A-Za-z0-9_-]/g,'_'),revision='r1'):DocumentMetadataRowsItem {
 const metadata:DocumentMetadata={schemaVersion:2,dialectVersion:'zorid-markdown-1',entryId:id,contentRevision:revision,sourceLength:{bytes:256,utf16:256},frontmatter:{state:'valid',range:{bytes:[0,20],utf16:[0,20]},bodyStart:{byte:20,utf16:20}},properties,aliases:[],tags:[],tagOccurrences:[],headings:[],links:[],tasks:[],blocks:[],listItems:[],diagnostics:[]};
 return {kind:'file',value:{entry:{id,revision,path,kind:'file',deleted:false},metadata,exclusion:null}};
}
const member=(row:DocumentMetadataRowsItem):DocumentEntry=>row.kind==='folder'?row.entry:row.value.entry;
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise<void>(done=>setImmediate(done));assert.ok(check());}
function harness(rows:DocumentMetadataRowsItem[],pending=false) {
 type Generation={snapshot:DocumentSnapshotId;source:{localStoreId:string;watermark:string};rows:DocumentMetadataRowsItem[];coverage:boolean};
 let generation:Generation={snapshot:{localStoreId:'store',generationEpoch:'epoch',generation:'1',versions},source:{localStoreId:'store',watermark:'1'},rows,coverage:true};
 const listeners=new Set<(update:DocumentRuntimeUpdate|null)=>void>();let notReady=pending,failRead=false,release:(()=>void)|undefined,closeGate:Promise<void>|undefined;
 const pins=new Map<string,Generation>();let next=0;
 const update=():DocumentRuntimeUpdate=>({lifetime:'life',revision:generation.snapshot.generation,source:generation.source,published:generation.snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:generation.coverage,hasForegroundDemand:false,error:null});
 const unused=async():Promise<never>=>{throw Error('Filter types must not read bodies, evaluate queries or request maintenance');};
 const transport:DocumentTransport={metadataRowsAvailable:true,status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,metadata:unused,search:unused,backlinks:unused,base:unused,
  open:async()=>{if(notReady)throw {code:'not_ready'};const pinId=`p${++next}`;pins.set(pinId,generation);return {pinId,snapshot:generation.snapshot,source:generation.source,coverageComplete:generation.coverage};},
  closePin:async pinId=>{await closeGate;pins.delete(pinId);},
  metadataRows:async input=>{if(failRead)throw {code:'invalid_response'};const g=pins.get(input.pinId)!;return {result:{snapshot:g.snapshot,source:g.source,coverageComplete:g.coverage,value:{snapshot:g.snapshot,next:null,scanComplete:true,coverageComplete:g.coverage,complete:g.coverage,mode:'reset',from:null,rows:g.rows,removedEntryIds:[]}},cursor:null};},
 };
 const service:DocumentService={...createDocumentService(transport),maintenance:{observeAndSubscribe:async callback=>{listeners.add(callback);return {snapshot:update(),unsubscribe(){listeners.delete(callback);}};},requestFreshness:()=>{throw Error('No metadata pump from a filter control');}}};
 class Adapter extends MemoryAdapter {
  readonly documentSemantics=service;reads=0;identities=new Map(rows.map(row=>[member(row).path,member(row)]));
  override async list(){return(await super.list()).map(row=>this.identify(row));}
  override async stat(path:string){const row=await super.stat(path);return row&&this.identify(row);}
  identify(row:VaultEntry){const saved=this.identities.get(row.path);return {...row,...(saved?{entryId:saved.id,revision:saved.revision}:{})};}
  override async read(path:string){this.reads++;return super.read(path);}
 }
 const adapter=new Adapter(Object.fromEntries(rows.map(row=>[member(row).path,'---\nnotCaptured: true\n---\n# Never parse this body']))),vault=new Vault(adapter);
 return {vault,adapter,pins,snapshot:(definitions=empty,known:string[]=[],current=()=>true)=>baseSessionFilterProperties(vault,definitions,known,current),
  set(rows:DocumentMetadataRowsItem[],coverage=true){const n=String(Number(generation.snapshot.generation)+1);generation={snapshot:{...generation.snapshot,generation:n},source:{...generation.source,watermark:n},rows,coverage};},
  wake(){notReady=false;for(const listener of [...listeners])listener(update());},failRead(){failRead=true;},holdClose(){closeGate=new Promise<void>(done=>{release=done;});return()=>release?.();},
 };
}

test('declared categories/options are copied without runtime inference or ambiguous key normalization',async()=>{
 const vault=new Vault(new MemoryAdapter({'A.md':'---\nscore: text\n---\n'}));await vault.initialize();
 const options=[{value:'todo',label:'To do',color:'orange',category:'todo' as const}];
 const definitions:BasePropertyDefinitions={properties:{title:{type:'text'},score:{type:'number'},done:{type:'checkbox'},day:{type:'date'},at:{type:'datetime'},items:{type:'list'},tags:{type:'tags'},state:{type:'status',options},choice:{type:'select',options},choices:{type:'multiselect',options},url:{type:'link'},author:{type:'relation'},authors:{type:'relation',relation:{multiple:true}},incoming:{type:'reverseRelation',reverseRelation:{property:'author'}},total:{type:'rollup',rollup:{relation:'authors',aggregation:'count'}},'note.title':{type:'text'},'file.name':{type:'number'},'spaced ["key"]':{type:'text'}},diagnostics:[]};
 try {const snapshot=baseSessionFilterProperties(vault,definitions,['file.name','formula.total','note.missing'],()=>true);
  for(const [name,kind] of Object.entries({title:'string',score:'number',done:'boolean',day:'date',at:'date',items:'list',tags:'tagList',state:'string',choice:'string',choices:'list',url:'link',author:'link',authors:'list',incoming:'list',total:'unknown'}))assert.equal(snapshot[`note.${name}`].kind,kind,name);
  assert.equal(snapshot['note.day'].withTime,false);assert.equal(snapshot['note.at'].withTime,true);assert.equal(snapshot['note.note.title'].kind,'string');assert.equal(snapshot['note.file.name'].kind,'number');assert.equal(snapshot['note.spaced ["key"]'].kind,'string');
  assert.equal(snapshot['formula.total'].kind,'unknown');assert.equal(snapshot['note.missing'].kind,'unknown');assert.equal(snapshot['file.name'],undefined,'fixed builtin mappings belong to the toolbar helper');
  assert.equal(snapshot['note.score'].metadataStatus,'unavailable','legacy metadata cannot become committed type evidence');
  assert.deepEqual(snapshot['note.state'].choices,[{value:'todo',label:'To do',color:'orange'}]);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot['note.state'])&&Object.isFrozen(snapshot['note.state'].choices)&&Object.isFrozen(snapshot['note.state'].choices![0]));
  assert.throws(()=>{(snapshot['note.state'].choices![0] as {value:string}).value='mutated';},TypeError);options[0].label='Later';options.push({value:'next',label:'Next',color:'blue',category:'todo'});assert.equal(snapshot['note.state'].choices?.[0].label,'To do');assert.equal(snapshot['note.state'].choices?.length,1);
 }finally{await vault.closeMetadataProjection();}
});

test('consistent committed categories drive controls; mixed categories and unproved formula outputs stay unknown',async()=>{
 const h=harness([file('A.md',[property('title','text','[[A|alias]]'),property('score','number',1),property('mixed','number',1),property('tags','tags',['a']),property('day','date','2026-10-22'),property('at','datetime','2026-10-22T10:00'),property('done','checkbox',false),property('items','list',['x']),property('weird','unknown',{})]),file('B.md',[property('title','text','2026-10-22'),property('score','number',2),property('mixed','text','two')])]);
 try {await h.vault.initialize();const snapshot=h.snapshot(empty,['formula.number']);
  assert.equal(snapshot['note.title'].kind,'string','metadata editor category drives UI even when Rust may infer Link/Date values');assert.equal(snapshot['note.score'].kind,'number');assert.equal(snapshot['note.mixed'].kind,'unknown');assert.equal(snapshot['note.tags'].kind,'tagList');assert.equal(snapshot['note.done'].kind,'boolean');assert.equal(snapshot['note.items'].kind,'list');assert.equal(snapshot['note.day'].withTime,false);assert.equal(snapshot['note.at'].withTime,true);assert.equal(snapshot['note.weird'].kind,'unknown');assert.equal(snapshot['formula.number'].kind,'unknown');
  assert.equal(snapshot['note.score'].metadataStatus,'current');assert.equal(snapshot['note.notCaptured'],undefined);assert.equal(h.adapter.reads,0);
  const declared=h.snapshot({properties:{mixed:{type:'select',options:[{value:'one'}]},score:{type:'text'}},diagnostics:[{property:'score',message:'Invalid declaration'}]});assert.equal(declared['note.mixed'].kind,'string');assert.equal(declared['note.score'].kind,'unknown','invalid declarations cannot borrow a guessed replacement');
 }finally{await h.vault.closeMetadataProjection();}assert.equal(h.pins.size,0);
});

test('changed/reused paths and incomplete inventory cannot claim a consistent undeclared type',async()=>{
 const h=harness([file('A.md',[property('score','number',1)],'a'),file('B.md',[property('score','number',2)],'b')]);
 try {await h.vault.initialize();const captured=h.snapshot();h.vault.entries.get('A.md')!.revision='r2';let snapshot=h.snapshot();assert.equal(snapshot['note.score'].kind,'unknown');assert.equal(snapshot['note.score'].metadataStatus,'stale');
  h.vault.entries.get('A.md')!.entryId='replacement';snapshot=h.snapshot();assert.equal(snapshot['note.score'].kind,'unknown');assert.equal(captured['note.score'].kind,'number','an already captured snapshot is immutable');
  h.vault.entries.get('A.md')!.entryId='a';h.vault.entries.get('A.md')!.revision='r1';h.set([file('A.md',[property('score','number',1)],'a'),file('B.md',[property('score','number',2)],'b')],false);h.wake();await until(()=>h.vault.metadataFrame?.frame?.snapshot.generation==='2');
  snapshot=h.snapshot({properties:{score:{type:'number'}},diagnostics:[]});assert.equal(snapshot['note.score'].kind,'number','an explicit editor declaration remains useful during indexing');assert.equal(snapshot['note.score'].metadataStatus,'stale');assert.equal(h.snapshot()['note.score'].kind,'unknown');assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}
});

test('pending, retirement and owner loss cannot leak captured categories from an old vault',async()=>{
 const h=harness([file('A.md',[property('score','number',1)])],true);
 let release:(()=>void)|undefined,close:Promise<void>|undefined;
 try {await h.vault.initialize();assert.deepEqual(h.snapshot(empty,['note.score'])['note.score'],{kind:'unknown',metadataStatus:'pending'});h.wake();await until(()=>h.vault.metadataFrame?.status==='current');assert.equal(h.snapshot()['note.score'].kind,'number');
  assert.equal(Object.keys(h.snapshot(empty,['note.score'],()=>false)).length,0);let checks=0;assert.equal(Object.keys(h.snapshot(empty,['note.score'],()=>++checks===1)).length,0,'ownership is checked again after collection');
  release=h.holdClose();close=h.vault.closeMetadataProjection();const retired=h.snapshot(empty,['note.score']);assert.deepEqual(retired['note.score'],{kind:'unknown',metadataStatus:'unavailable'});release();await close;assert.deepEqual(h.snapshot(empty,['note.score'])['note.score'],{kind:'unknown',metadataStatus:'unavailable'});
 }finally{release?.();await(close??h.vault.closeMetadataProjection());}assert.equal(h.pins.size,0);
});

test('a real same-frame metadata hint retains captured filter families through stale/current wrappers',async()=>{
 const h=harness([file('A.md',[property('title','text','A')])]);
 try {await h.vault.initialize();const before=h.vault.metadataFrame!,provider=baseSessionFilterPropertyProvider(h.vault,{properties:{state:{type:'select',options:[{value:'open',label:'Open'}]}},diagnostics:[]},['note.title','note.state'],()=>true);
  const title=provider('note.title'),state=provider('note.state');assert.equal(title?.kind,'string');assert.equal(state?.kind,'string');
  const cold=baseSessionFilterPropertyProvider(h.vault,empty,['note.title'],()=>true),coldKinds:(string|undefined)[]=[];
  const phases:{status:string;frame:unknown;title:unknown;state:unknown}[]=[];
  const stop=h.vault.onMetadata(next=>{phases.push({status:next.status,frame:next.frame,title:provider('note.title'),state:provider('note.state')});coldKinds.push(cold('note.title')?.kind);});
  try {h.wake();}finally{stop();}
  assert.deepEqual(phases.map(phase=>phase.status),['stale','current'],'exercise real projection hint publication, not a fabricated state wrapper');
  assert.notEqual(h.vault.metadataFrame,before);assert.equal(h.vault.metadataFrame?.frame,before.frame);
  for(const phase of phases){assert.equal(phase.frame,before.frame);assert.equal(phase.title,title);assert.equal(phase.state,state);}
  assert.deepEqual(coldKinds,['unknown','string'],'a first lookup during the transient phase cannot poison the later current category');
  assert.equal(provider('note.title'),title);assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}assert.equal(h.pins.size,0);
});

test('same-frame phases cannot revalidate changed saved witnesses, new coverage or a lost session owner',async()=>{
 const h=harness([file('A.md',[property('title','text','A')],'a'),file('B.md',[property('title','text','B')],'b')]);let current=true;
 try {await h.vault.initialize();const provider=baseSessionFilterPropertyProvider(h.vault,empty,['note.title'],()=>current);assert.equal(provider('note.title')?.kind,'string');
  h.vault.entries.get('B.md')!.revision='r2';h.wake();assert.deepEqual(provider('note.title'),{kind:'unknown',metadataStatus:'unavailable'},'a second note changed despite identical retained metadata frame');
  h.set([file('A.md',[property('title','text','A')],'a'),file('B.md',[property('title','text','B')],'b','r2')],false);h.wake();await until(()=>h.vault.metadataFrame?.frame?.snapshot.generation==='2');assert.deepEqual(provider('note.title'),{kind:'unknown',metadataStatus:'unavailable'},'a new frame/coverage never borrows the opening category');
  const latest=baseSessionFilterPropertyProvider(h.vault,{properties:{title:{type:'text'}},diagnostics:[]},['note.title'],()=>current);assert.equal(latest('note.title')?.kind,'string');current=false;assert.deepEqual(latest('note.title'),{kind:'unknown',metadataStatus:'unavailable'});assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}
});

test('a provider constructed inside the real stale phase acquires current categories when that same frame settles',async()=>{
 const h=harness([file('A.md',[property('title','text','A')])]);
 try {await h.vault.initialize();let provider:ReturnType<typeof baseSessionFilterPropertyProvider>|undefined;
  const phases:{status:string;title:string|undefined;state:string|undefined}[]=[];
  const stop=h.vault.onMetadata(next=>{
   provider??=baseSessionFilterPropertyProvider(h.vault,{properties:{state:{type:'select',options:[{value:'open'}]}},diagnostics:[]},['note.title','note.state'],()=>true);
   phases.push({status:next.status,title:provider('note.title')?.kind,state:provider('note.state')?.kind});
  });
  try{h.wake();}finally{stop();}
  assert.deepEqual(phases,[{status:'stale',title:'unknown',state:'string'},{status:'current',title:'string',state:'string'}]);assert.equal(provider?.('note.title')?.kind,'string');assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}
});

test('unavailable delivery and immediate metadata retirement invalidate a captured provider',async()=>{
 const h=harness([file('A.md',[property('title','text','A')])]);
 try {await h.vault.initialize();const frame=h.vault.metadataFrame?.frame,provider=baseSessionFilterPropertyProvider(h.vault,empty,['note.title'],()=>true);assert.equal(provider('note.title')?.kind,'string');
  h.failRead();h.set([file('A.md',[property('title','text','A')])]);h.wake();await until(()=>h.vault.metadataFrame?.status==='unavailable');assert.equal(h.vault.metadataFrame?.frame,frame);assert.deepEqual(provider('note.title'),{kind:'unknown',metadataStatus:'unavailable'});
 }finally{await h.vault.closeMetadataProjection();}
 const retired=harness([file('A.md',[property('title','text','A')])]);let release:(()=>void)|undefined,close:Promise<void>|undefined;
 try {await retired.vault.initialize();const provider=baseSessionFilterPropertyProvider(retired.vault,empty,['note.title'],()=>true);assert.equal(provider('note.title')?.kind,'string');release=retired.holdClose();close=retired.vault.closeMetadataProjection();assert.deepEqual(provider('note.title'),{kind:'unknown',metadataStatus:'unavailable'},'retirement blocks cache admission before close-pin acknowledgement');release();await close;
 }finally{release?.();await(close??retired.vault.closeMetadataProjection());}assert.equal(retired.pins.size,0);
});

test('an excluded-only frame retires declared controls immediately while pin-close acknowledgement is pending',async()=>{
 const excluded:DocumentMetadataRowsItem={kind:'file',value:{entry:{id:'cover',revision:'r1',path:'covers/a.png',kind:'file',deleted:false},metadata:null,exclusion:'binary'}};
 const h=harness([excluded]);let release:(()=>void)|undefined,close:Promise<void>|undefined;
 try {await h.vault.initialize();assert.equal(h.vault.metadataFrame?.status,'current');assert.equal(h.vault.metadataFrame?.frame?.row('covers/a.png')?.kind,'file');assert.deepEqual([...h.vault.metadata.entries()],[],'there is no admitted note to act as a retirement sentinel');assert.equal(h.vault.isMetadataRetired,false);
  const provider=baseSessionFilterPropertyProvider(h.vault,{properties:{state:{type:'select',options:[{value:'open'}]}},diagnostics:[]},['note.state'],()=>true);assert.equal(provider('note.state')?.kind,'string');
  const retained=h.vault.metadataFrame;release=h.holdClose();close=h.vault.closeMetadataProjection();assert.equal(h.vault.isMetadataRetired,true);assert.equal(h.vault.metadataFrame,retained,'the historical snapshot getter retains its existing close-ACK contract');assert.ok(h.pins.size>0);assert.deepEqual(provider('note.state'),{kind:'unknown',metadataStatus:'unavailable'});assert.equal(h.adapter.reads,0);release();await close;
 }finally{release?.();await(close??h.vault.closeMetadataProjection());}assert.equal(h.pins.size,0);
});

test('a retained filter draft acquires the current declared String catalog after its captured metadata frame is superseded',async()=>{
 const h=harness([file('A.md',[property('text','text','Alpha')],'a')]);
 const definitions:BasePropertyDefinitions={properties:{text:{type:'text'}},diagnostics:[]};
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const document=BaseDocument.parse('views:\n - type: table\n   name: Typed\n   filters: {and: [\'note.text != "other"\']}\n');
 let version=1,current=true;const saves:unknown[]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_version,patch){saves.push(patch);},onDraftChange(){},onError:error=>errors.push(error)});
 const refresh=()=>{
  const result=executeBaseQuery(document,{version,files:[{path:'A.md',properties:{text:'Alpha'}}]},{viewIndex:0});
  toolbar.update({result,views:document.views,selectedIndex:0,root:{},readOnly:false,allowRename:true,label:property=>property.replace(/^note\./,''),propertyType:property=>property==='note.text'?'text':undefined,filterProperty:baseSessionFilterPropertyProvider(h.vault,definitions,['note.text'],()=>current)});
 };
 try{
  await h.vault.initialize();refresh();
  doc.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click();
  const section=doc.querySelectorAll('.bases-filter-section')[1];assert.ok(section);
  section.querySelector<HTMLButtonElement>('button[aria-label="Add filter"]')!.click();
  const captured=baseSessionFilterPropertyProvider(h.vault,definitions,['note.text'],()=>current);
  assert.equal(captured('note.text')?.kind,'string');
  // Genuine public runtime delivery supersedes the opening advisory frame. No
  // old provider is allowed to adopt those new facts merely to repair the UI.
  h.set([file('A.md',[property('text','text','Alpha')],'a')]);h.wake();
  await until(()=>h.vault.metadataFrame?.frame?.snapshot.generation==='2');
  assert.deepEqual(captured('note.text'),{kind:'unknown',metadataStatus:'unavailable'});
  const row=()=>section.querySelectorAll('.bases-filter-condition')[1];
  const propertySelect=row().querySelector<HTMLSelectElement>('select[aria-label="Filter property"]')!;
  propertySelect.value='note.text';propertySelect.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  const catalog=()=>[...row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')!.options].map(option=>option.value);
  assert.equal(row().querySelector<HTMLSelectElement>('select[aria-label="Filter property"]')!.value,'note.text');
  assert.deepEqual(catalog(),['eq','neq','isEmpty','isNotEmpty'],'the retired opening provider conservatively presents its unknown family');
  version++;refresh();
  assert.equal(baseSessionFilterPropertyProvider(h.vault,definitions,['note.text'],()=>current)('note.text')?.kind,'string');
  assert.equal(doc.querySelector('[role="dialog"][aria-label="Filter"]'),section.parentElement?.parentElement?.parentElement);
  assert.ok(catalog().includes('notEndsWith'),'a current same-configuration advisory update must not leave a retained row stuck on unknown operators');
  assert.deepEqual(saves,[],'blank and incomplete local rows cannot write a Base');assert.deepEqual(errors,[]);
 }finally{current=false;toolbar.destroy();dom.window.close();await h.vault.closeMetadataProjection();}
});

test('a saved supported inverse method reopens structured after a retired opening frame is replaced by current advice',async()=>{
 const h=harness([file('A.md',[property('text','text','Alpha')],'a')]),definitions:BasePropertyDefinitions={properties:{text:{type:'text'}},diagnostics:[]};
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
 const source='!note["text"].containsAny("beta", "gamma")';
 const document=BaseDocument.parse(JSON.stringify({fixtureSentinel:'keep',views:[{type:'table',name:'Typed',order:['file.name','note.text'],filters:{and:[source]}}]}));
 const original=document.toString();let version=1,current=true;const saves:unknown[]=[],errors:unknown[]=[];
 const toolbar=createBaseToolbar(doc.querySelector('main')!,{immediate:true,preflight(){},async selectView(){},async save(_version,patch){saves.push(patch);},onDraftChange(){},onError:error=>errors.push(error)});
 const state=(provider:ReturnType<typeof baseSessionFilterPropertyProvider>)=>({result:executeBaseQuery(document,{version,files:[{path:'A.md',properties:{text:'Alpha'}}]},{viewIndex:0}),views:document.views,selectedIndex:0,root:{fixtureSentinel:'keep'},readOnly:false,allowRename:true,label:(property:string)=>property.replace(/^note\./,''),propertyType:(property:string)=>property==='note.text'?'text':undefined,filterProperty:provider});
 try{
  await h.vault.initialize();const old=baseSessionFilterPropertyProvider(h.vault,definitions,['note.text'],()=>current);toolbar.update(state(old));
  h.set([file('A.md',[property('text','text','Alpha')],'a')]);h.wake();await until(()=>h.vault.metadataFrame?.frame?.snapshot.generation==='2');
  assert.deepEqual(old('note.text'),{kind:'unknown',metadataStatus:'unavailable'},'Retired advice must never be revived for a reopened row');
  doc.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click();const panel=doc.querySelector('[role="dialog"][aria-label="Filter"]')!,raw=panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Filter expression"]')!;assert.ok(raw);assert.equal(raw.value,source);
  version++;const next=baseSessionFilterPropertyProvider(h.vault,definitions,['note.text'],()=>current);assert.equal(next('note.text')?.kind,'string');toolbar.update(state(next));
  const row=panel.querySelectorAll('.bases-filter-section')[1].querySelector('.bases-filter-condition')!;
  assert.equal(row.querySelector('textarea[aria-label="Filter expression"]'),null,'An untouched supported method is not permanently trapped in raw fallback');
  assert.equal(row.querySelector<HTMLSelectElement>('select[aria-label="Filter property"]')?.value,'note.text');assert.equal(row.querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notContainsAny');
  assert.deepEqual([...row.querySelectorAll('.bases-filter-operand-chip span')].map(element=>element.textContent),['beta','gamma']);
  assert.equal(document.toString(),original);assert.deepEqual(saves,[]);assert.deepEqual(errors,[]);assert.deepEqual(old('note.text'),{kind:'unknown',metadataStatus:'unavailable'});
 }finally{current=false;toolbar.destroy();dom.window.close();await h.vault.closeMetadataProjection();}
});

async function metadataSessionFixture(beforeMetadata?:(session:ReturnType<typeof createBaseSession>,status:string)=>void){
 const base='filters: \'note.kind == "typed-filter"\'\nproperties:\n  note.text: {displayName: Original label}\nviews:\n  - type: table\n    name: Typed\n    order: [file.name, note.text]\n    filters: \'!note["text"].startsWith("Alpha")\'\n';
 const declarations='properties:\n  text: {type: text}\n';
 const rows=[file('Work.base',[]),file('Properties.yaml',[]),file('Items/Deep/C.md',[property('text','text','delta beta')]),file('Items/D.md',[property('text','text','')]),file('Items/E.md',[property('text','text','ALPHA')])];
 const h=harness(rows),service=h.adapter.documentSemantics,open=service.open.bind(service);let queries=0;
 const observation=()=>{const frame=h.vault.metadataFrame!.frame!;return{source:frame.source,published:frame.snapshot,current:true,rebuildRequired:false,coverageComplete:true};};
 service.status=async()=>{const current=observation();return{source:current.source,snapshot:current.published,coveredSource:current.source,current:true,rebuildRequired:false,coverageComplete:true};};
 service.maintenance!.requestFreshness=()=>({result:Promise.resolve(observation()),async cancel(){}});
 // Separate query and metadata consumers use the same public service. The
 // literal core-query reply is already filtered C/D/E, matching native004; no
 // TypeScript filter evaluation supplies membership or category authority.
 service.open=async()=>{
  const pin=await open();return{...pin,
   metadata:async id=>({source:pin.source,snapshot:pin.snapshot,coverageComplete:true,value:{entry:member(rows.find(row=>member(row).id===id||member(row).path===id)!),metadata:null,exclusion:null}}),
   base:async()=>{
    queries++;const result:DocumentBaseResult={snapshotId:pin.snapshot,view:BaseDocument.parse(base).views[0],rows:rows.slice(2).map(row=>({entryId:member(row).id,revision:member(row).revision,path:member(row).path,values:{'file.name':{type:'string' as const,value:member(row).path.split('/').pop()!.slice(0,-3)},'note.text':{type:'string' as const,value:row.kind==='file'?row.value.metadata!.properties[0].value as string:''}}})),groups:[{key:null,keyId:null,entryIds:rows.slice(2).map(row=>member(row).id)}],groupOptions:[],properties:['file.name','note.text'],availableProperties:['file.name','note.text'],counts:{scanned:5,matched:3,afterGroupOrder:3,afterSearch:3,returned:3},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1};
    return{source:pin.source,snapshot:pin.snapshot,coverageComplete:true,value:{definition:member(rows[0]),result}};
   }};
 };
 await h.adapter.write('Work.base',base);await h.adapter.write('Properties.yaml',declarations);await h.vault.initialize();
 const dom=new JSDOM('<main></main><button id="outside">Outside</button>',{pretendToBeVisual:true}),doc=dom.window.document,errors:unknown[]=[];
 let subscriptions=0;const subscribe=h.vault.onMetadata.bind(h.vault);h.vault.onMetadata=callback=>{subscriptions++;const stop=subscribe(callback);return()=>{subscriptions--;stop();};};
 let session:ReturnType<typeof createBaseSession>;const stopEarly=beforeMetadata?h.vault.onMetadata(state=>beforeMetadata(session,state.status)):()=>{};
 session=createBaseSession(doc.querySelector('main')!,{vault:h.vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},async getBuffer(){throw Error('Advisory refresh cannot request an edit buffer');}},onError:error=>errors.push(error)});
 await session.ready;assert.ifError(session.state.error);
 const panel=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]')!;
 const row=()=>panel().querySelectorAll('.bases-filter-section')[1].querySelector<HTMLElement>('.bases-filter-condition')!;
 const cancel=()=>doc.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')?.click();
 return{h,rows,base,declarations,dom,doc,session,errors,panel,row,cancel,queries:()=>queries,subscriptions:()=>subscriptions,
  open(){doc.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click();},
  async advance(duringStale?:()=>void){const next=String(Number(h.vault.metadataFrame!.frame!.snapshot.generation)+1);let invoked=false;const stop=duringStale?h.vault.onMetadata(state=>{if(!invoked&&state.status==='stale'){invoked=true;duringStale();}}):()=>{};try{h.set(rows);h.wake();await until(()=>h.vault.metadataFrame?.status==='current'&&h.vault.metadataFrame.frame?.snapshot.generation===next);}finally{stop();}if(duringStale)assert.equal(invoked,true);},
  async cleanup(){stopEarly();cancel();await session.close();await h.vault.closeMetadataProjection();dom.window.close();}};
}

test('actual session refreshes declared filter advice when metadata alone advances after its query result',async()=>{
 const f=await metadataSessionFixture();try{
  const original=f.session.state,queryCount=f.queries(),actions=[...f.doc.querySelectorAll('.bases-toolbar-action')],grid=f.doc.querySelector('[role="grid"]');
  assert.equal(baseSessionFilterPropertyProvider(f.h.vault,{properties:{text:{type:'text'}},diagnostics:[]},['note.text'],()=>true)('note.text')?.kind,'string');
  await f.advance();assert.equal(f.session.state,original,'Metadata advice does not publish a new query result or mutation witness');assert.equal(f.queries(),queryCount);
  assert.deepEqual([...f.doc.querySelectorAll('.bases-toolbar-action')],actions,'Metadata does not replace toolbar actions');assert.equal(f.doc.querySelector('[role="grid"]'),grid,'Metadata does not remount rows');
  f.open();assert.equal(f.row().querySelector('textarea[aria-label="Filter expression"]'),null,'A metadata-only current frame must not leave the real session holding a retired provider');
  assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notStartsWith');assert.equal(f.row().querySelector<HTMLInputElement>('input[aria-label="Filter value"]')?.value,'Alpha');
  assert.equal(await f.h.adapter.read('Work.base'),f.base);assert.equal(await f.h.adapter.read('Properties.yaml'),f.declarations);assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('metadata publication repairs an open fallback but preserves focused raw source until focus leaves',async()=>{
 for(const editing of [false,true]){
  const f=await metadataSessionFixture();try{
   let raw:HTMLTextAreaElement|undefined,opening:HTMLElement|undefined;const original=f.session.state,count=f.queries();
   await f.advance(()=>{f.open();opening=f.row();raw=f.row().querySelector<HTMLTextAreaElement>('textarea[aria-label="Filter expression"]')!;assert.ok(raw);if(editing){raw.focus();raw.setSelectionRange(2,8);}});
   if(editing){assert.equal(f.row(),opening);assert.equal(f.doc.activeElement,raw);assert.equal(raw!.selectionStart,2);assert.equal(raw!.selectionEnd,8);f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();await f.advance();}
   assert.equal(f.row().querySelector('textarea[aria-label="Filter expression"]'),null);assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notStartsWith');
   assert.equal(f.session.state,original);assert.equal(f.queries(),count);assert.equal(await f.h.adapter.read('Work.base'),f.base);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
 }
});

test('failed close retains metadata subscription and successful close releases it',async()=>{
 const f=await metadataSessionFixture();try{
  assert.equal(f.subscriptions(),1);f.open();f.row().querySelector<HTMLButtonElement>('button[aria-label="Edit expression"]')!.click();const raw=f.row().querySelector<HTMLTextAreaElement>('textarea')!;raw.value='!note[';raw.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await assert.rejects(f.session.close(),/Finish or cancel/);assert.equal(f.subscriptions(),1);assert.equal(raw.isConnected,true);f.cancel();await f.advance();f.open();assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notStartsWith');
  f.cancel();const state=f.session.state,count=f.queries();await f.session.close();assert.equal(f.subscriptions(),0);const html=f.doc.body.innerHTML;await f.advance();assert.equal(f.doc.body.innerHTML,html);assert.equal(f.session.state,state);assert.equal(f.queries(),count);assert.equal(await f.h.adapter.read('Work.base'),f.base);
 }finally{await f.cleanup();}
});

test('metadata cannot refresh old declared advice while its replacement declaration read is pending',async()=>{
 const f=await metadataSessionFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const read=f.h.adapter.read.bind(f.h.adapter);let held=true,reading=false,newReads=0;
 f.h.adapter.read=async path=>{const source=await read(path);if(path==='Properties.yaml'&&source.includes('type: number')&&++newReads>1&&held){reading=true;await gate;}return source;};
 try{
  await f.h.vault.modify('Properties.yaml','properties:\n  text: {type: number}\n');await until(()=>reading);await f.advance();f.open();const raw=f.row().querySelector<HTMLTextAreaElement>('textarea[aria-label="Filter expression"]');assert.ok(raw,'The pending registry read cannot refresh a retired String provider');
  held=false;release();await f.session.refresh();assert.equal(f.row().querySelector('textarea[aria-label="Filter expression"]'),raw,'Incompatible current declaration preserves exact source');assert.equal(raw.value,'!note["text"].startsWith("Alpha")');assert.equal(await f.h.adapter.read('Work.base'),f.base);
 }finally{held=false;release();await f.cleanup();}
});

test('normal source refresh updates property aliases in the same mounted real session table',async()=>{
 const f=await metadataSessionFixture();try{
  const grid=f.doc.querySelector('[role="grid"]')!;assert.ok(grid.textContent?.includes('Original label'));
  await f.h.vault.modify('Work.base',f.base.replace('Original label','Updated label'));await f.session.refresh();
  assert.equal(f.doc.querySelector('[role="grid"]'),grid,'The normal reuse path keeps the same mounted table');assert.ok(grid.textContent?.includes('Updated label'));assert.equal(grid.textContent?.includes('Original label'),false);
 }finally{await f.cleanup();}
});

test('metadata delivered while flush or rejected close owns the session is reconsidered once it survives closing',async()=>{
 for(const action of ['flush','failed-close']){
  let armed=false,overlap:Promise<void>|undefined;
  const f=await metadataSessionFixture((session,status)=>{if(armed&&status==='current'){armed=false;overlap=action==='flush'?session.flush():session.close();void overlap.catch(()=>{});}});
  try{
   if(action==='failed-close'){f.open();f.row().querySelector<HTMLButtonElement>('button[aria-label="Edit expression"]')!.click();const raw=f.row().querySelector<HTMLTextAreaElement>('textarea')!;raw.value='!note[';raw.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}
   const state=f.session.state,count=f.queries();armed=true;await f.advance();assert.ok(overlap,'The earlier public metadata subscriber actually starts '+action);
   if(action==='flush')await overlap;else{await assert.rejects(overlap,/Finish or cancel/);f.cancel();}
   f.open();assert.equal(f.row().querySelector('textarea[aria-label="Filter expression"]'),null,'Surviving '+action+' must not lose its only current-frame delivery');assert.equal(f.row().querySelector<HTMLSelectElement>('select[aria-label="Condition"]')?.value,'notStartsWith');
   assert.equal(f.session.state,state);assert.equal(f.queries(),count);assert.equal(await f.h.adapter.read('Work.base'),f.base);
  }finally{armed=false;await f.cleanup();}
 }
});
