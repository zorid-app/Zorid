import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentEntry, DocumentMetadata, DocumentMetadataRowsItem, DocumentProperty, DocumentService, DocumentSnapshotId, DocumentTransport} from '../src/core/document-semantics.ts';
import type {DocumentRuntimeUpdate} from '../src/core/document-runtime.ts';
import type {VaultEntry} from '../src/core/types.ts';
import {baseSessionFilterProperties,baseSessionFilterPropertyProvider} from '../src/bases/session.ts';
import type {BasePropertyDefinitions} from '../src/bases/property-definitions.ts';

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
 let listener:((update:DocumentRuntimeUpdate|null)=>void)|undefined,notReady=pending,failRead=false,release:(()=>void)|undefined,closeGate:Promise<void>|undefined;
 const pins=new Map<string,Generation>();let next=0;
 const update=():DocumentRuntimeUpdate=>({lifetime:'life',revision:generation.snapshot.generation,source:generation.source,published:generation.snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:generation.coverage,hasForegroundDemand:false,error:null});
 const unused=async():Promise<never>=>{throw Error('Filter types must not read bodies, evaluate queries or request maintenance');};
 const transport:DocumentTransport={metadataRowsAvailable:true,status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,metadata:unused,search:unused,backlinks:unused,base:unused,
  open:async()=>{if(notReady)throw {code:'not_ready'};const pinId=`p${++next}`;pins.set(pinId,generation);return {pinId,snapshot:generation.snapshot,source:generation.source,coverageComplete:generation.coverage};},
  closePin:async pinId=>{await closeGate;pins.delete(pinId);},
  metadataRows:async input=>{if(failRead)throw {code:'invalid_response'};const g=pins.get(input.pinId)!;return {result:{snapshot:g.snapshot,source:g.source,coverageComplete:g.coverage,value:{snapshot:g.snapshot,next:null,scanComplete:true,coverageComplete:g.coverage,complete:g.coverage,mode:'reset',from:null,rows:g.rows,removedEntryIds:[]}},cursor:null};},
 };
 const service:DocumentService={...createDocumentService(transport),maintenance:{observeAndSubscribe:async callback=>{listener=callback;return {snapshot:update(),unsubscribe(){listener=undefined;}};},requestFreshness:()=>{throw Error('No metadata pump from a filter control');}}};
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
  wake(){notReady=false;listener?.(update());},failRead(){failRead=true;},holdClose(){closeGate=new Promise<void>(done=>{release=done;});return()=>release?.();},
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
