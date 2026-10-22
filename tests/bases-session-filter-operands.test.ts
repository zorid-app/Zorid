import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentEntry, DocumentMetadata, DocumentMetadataRowsItem, DocumentService, DocumentSnapshotId, DocumentTransport} from '../src/core/document-semantics.ts';
import type {DocumentRuntimeUpdate} from '../src/core/document-runtime.ts';
import type {VaultEntry} from '../src/core/types.ts';
import {baseSessionFilterOperands} from '../src/bases/session.ts';

const versions={schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'resolver-1',query:'query-1'};
function file(path:string,id=path,revision='r1',tags:string[]=[]):DocumentMetadataRowsItem {
 const metadata:DocumentMetadata={schemaVersion:2,dialectVersion:'zorid-markdown-1',entryId:id,contentRevision:revision,sourceLength:{bytes:0,utf16:0},frontmatter:{state:'absent',range:null,bodyStart:{byte:0,utf16:0}},properties:[],aliases:[],tags,tagOccurrences:[],headings:[],links:[],tasks:[],blocks:[],listItems:[],diagnostics:[]};
 return {kind:'file',value:{entry:{id,revision,path,kind:'file',deleted:false},metadata,exclusion:null}};
}
const member=(item:DocumentMetadataRowsItem):DocumentEntry=>item.kind==='folder'?item.entry:item.value.entry;
const definitions={properties:{'literal.note.key':{type:'text' as const},'note.foo':{type:'text' as const},'spaced [key]':{type:'text' as const}},diagnostics:[]};
const known=['file.name','formula.calculated','note.kind','note.note.foo','note.has "quotes"','note.'];
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise<void>(done=>setImmediate(done));assert.ok(check());}
function harness(rows:DocumentMetadataRowsItem[],seed:Record<string,string|Uint8Array>,pending=false) {
 type Generation={snapshot:DocumentSnapshotId;source:{localStoreId:string;watermark:string};rows:DocumentMetadataRowsItem[];coverage:boolean};
 let generation:Generation={snapshot:{localStoreId:'store',generationEpoch:'epoch',generation:'1',versions},source:{localStoreId:'store',watermark:'1'},rows,coverage:true};
 let listener:((value:DocumentRuntimeUpdate|null)=>void)|undefined,notReady=pending,closeGate:Promise<void>|undefined;
 const pins=new Map<string,Generation>();let next=0;
 const update=():DocumentRuntimeUpdate=>({lifetime:'life',revision:generation.snapshot.generation,source:generation.source,published:generation.snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:generation.coverage,hasForegroundDemand:false,error:null});
 const unused=async():Promise<never>=>{throw Error('No Base query, body read or maintenance request belongs to operand collection');};
 const transport:DocumentTransport={metadataRowsAvailable:true,status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,metadata:unused,search:unused,backlinks:unused,base:unused,
  open:async()=>{if(notReady)throw {code:'not_ready'};const pinId=`p${++next}`;pins.set(pinId,generation);return {pinId,snapshot:generation.snapshot,source:generation.source,coverageComplete:generation.coverage};},
  closePin:async pinId=>{await closeGate;pins.delete(pinId);},
  metadataRows:async input=>{const g=pins.get(input.pinId)!;return {result:{snapshot:g.snapshot,source:g.source,coverageComplete:g.coverage,value:{snapshot:g.snapshot,next:null,scanComplete:true,coverageComplete:g.coverage,complete:g.coverage,mode:'reset',from:null,rows:g.rows,removedEntryIds:[]}},cursor:null};},
 };
 const service:DocumentService={...createDocumentService(transport),maintenance:{observeAndSubscribe:async cb=>{listener=cb;return {snapshot:update(),unsubscribe(){listener=undefined;}};},requestFreshness:()=>{throw Error('No freshness pump from an operand menu');}}};
 class Adapter extends MemoryAdapter {
  readonly documentSemantics=service; reads=0; identities=new Map(rows.map(row=>[member(row).path,member(row)]));
  override async list(){return(await super.list()).map(row=>this.identify(row));}
  override async stat(path:string){const row=await super.stat(path);return row&&this.identify(row);}
  identify(row:VaultEntry){const saved=this.identities.get(row.path);return {...row,...(saved?{entryId:saved.id,revision:saved.revision}:{})};}
  override async read(path:string){this.reads++;return super.read(path);}
 }
 const adapter=new Adapter(seed),vault=new Vault(adapter);
 return {vault,adapter,pins,get generation(){return generation;},snapshot:()=>baseSessionFilterOperands(vault,definitions,known,()=>true),
  set(rows:DocumentMetadataRowsItem[],coverage=true){const n=String(Number(generation.snapshot.generation)+1);generation={snapshot:{...generation.snapshot,generation:n},source:{...generation.source,watermark:n},rows,coverage};},
  wake(){notReady=false;listener?.(update());},holdClose(){const gate=deferred();closeGate=gate.promise;return gate;},
 };
}

test('session operands copy all file types/folders and literal property keys from admitted saved facts',async()=>{
 const h=harness([file('Notes/A.md','a','r1',['books/nested','タグ','books/nested']),file('covers/a #1.png','cover')],{'Notes/A.md':'# BODY-TAG-MUST-NOT-BE-PARSED','covers/a #1.png':new Uint8Array([1,2,3])});
 try {await h.vault.initialize();const snapshot=h.snapshot();
  assert.deepEqual(snapshot.files,['Notes/A.md','covers/a #1.png']);assert.deepEqual(snapshot.folders,['/','Notes','covers']);assert.deepEqual(snapshot.tags,['books/nested','タグ']);
  assert.deepEqual(snapshot.properties,['has "quotes"','kind','literal.note.key','note.foo','spaced [key]']);assert.equal(snapshot.metadataStatus,'current');assert.equal(h.adapter.reads,0);
  const note=h.vault.metadata.get('Notes/A.md')!,before=[...note.tags];
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.files)&&Object.isFrozen(snapshot.folders)&&Object.isFrozen(snapshot.tags)&&Object.isFrozen(snapshot.properties));
  assert.throws(()=>{(snapshot.tags as string[]).push('poison');},TypeError);assert.deepEqual(note.tags,before);assert.deepEqual(Object.keys(definitions.properties),['literal.note.key','note.foo','spaced [key]']);
  h.vault.entries.set('late.pdf',{path:'late.pdf',type:'file',entryId:'late',revision:'r1',mtime:0,size:0});
  const next=h.snapshot();assert.ok(next.files.includes('late.pdf'));assert.equal(next.metadataStatus,'stale');assert.deepEqual(snapshot.files,['Notes/A.md','covers/a #1.png'],'captured menu inventory never mutates after a namespace change');
 }finally{await h.vault.closeMetadataProjection();}assert.equal(h.pins.size,0);
});

test('changed and replaced saved witnesses never offer old tags while unchanged facts remain usable with stale status',async()=>{
 const h=harness([file('A.md','a','r1',['old']),file('B.md','b','r1',['unchanged'])],{'A.md':'body','B.md':'body'});
 try {await h.vault.initialize();h.vault.entries.get('A.md')!.revision='r2';let snapshot=h.snapshot();assert.deepEqual(snapshot.tags,['unchanged']);assert.equal(snapshot.metadataStatus,'stale');
  h.vault.entries.get('A.md')!.entryId='replacement';snapshot=h.snapshot();assert.deepEqual(snapshot.tags,['unchanged']);assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}
});

test('first-frame pending, stale snapshots and incomplete committed coverage stay explicit',async()=>{
 const h=harness([file('A.md','a','r1',['saved'])],{'A.md':'#not-a-suggestion'},true);
 try {await h.vault.initialize();assert.equal(h.snapshot().metadataStatus,'pending');assert.deepEqual(h.snapshot().tags,[]);
  h.wake();await until(()=>h.vault.metadataFrame?.status==='current');assert.deepEqual(h.snapshot().tags,['saved']);
  h.set([file('A.md','a','r1',['saved'])],false);h.wake();await until(()=>h.vault.metadataFrame?.frame?.snapshot.generation==='2');assert.equal(h.snapshot().metadataStatus,'stale');assert.deepEqual(h.snapshot().tags,['saved']);assert.equal(h.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();}
});

test('metadata retirement immediately removes suggestions and completes without retaining pins',async()=>{
 const h=harness([file('A.md','a','r1',['saved'])],{'A.md':'body'});await h.vault.initialize();const gate=h.holdClose();let close:Promise<void>|undefined;
 try {close=h.vault.closeMetadataProjection();const pending=h.snapshot();assert.deepEqual(pending.tags,[]);assert.equal(pending.metadataStatus,'unavailable','retained frame cannot bypass retired cache admission');
  gate.resolve();await close;assert.deepEqual(h.snapshot().tags,[]);assert.equal(h.snapshot().metadataStatus,'unavailable');assert.equal(h.pins.size,0);
 }finally{gate.resolve();await close;}
});

test('a retired session or vault owner cannot supply suggestions from a previous vault',async()=>{
 const h=harness([file('A.md','a','r1',['old-vault'])],{'A.md':'body'}),next=harness([file('New.md','new','r1',['new-vault'])],{'New.md':'body'});let current=h.vault;
 try {await h.vault.initialize();await next.vault.initialize();const provider=()=>baseSessionFilterOperands(h.vault,definitions,known,()=>current===h.vault);
  assert.deepEqual(provider().tags,['old-vault']);let checks=0;assert.deepEqual(baseSessionFilterOperands(h.vault,definitions,known,()=>++checks===1),{files:[],folders:[],tags:[],properties:[],metadataStatus:'unavailable'},'ownership loss while collecting cannot publish a previous-vault snapshot');current=next.vault;assert.deepEqual(provider(),{files:[],folders:[],tags:[],properties:[],metadataStatus:'unavailable'});
  assert.deepEqual(baseSessionFilterOperands(next.vault,definitions,known,()=>true).tags,['new-vault']);assert.equal(h.adapter.reads+next.adapter.reads,0);
 }finally{await h.vault.closeMetadataProjection();await next.vault.closeMetadataProjection();}
});

test('legacy parsed metadata never masquerades as a committed tag inventory',async()=>{
 const vault=new Vault(new MemoryAdapter({'Legacy.md':'#legacy-tag'}));await vault.initialize();assert.deepEqual(vault.metadata.get('Legacy.md')?.tags,['legacy-tag']);
 const snapshot=baseSessionFilterOperands(vault,definitions,known,()=>true);assert.deepEqual(snapshot.tags,[]);assert.equal(snapshot.metadataStatus,'unavailable');assert.deepEqual(snapshot.files,['Legacy.md']);await vault.closeMetadataProjection();
});
