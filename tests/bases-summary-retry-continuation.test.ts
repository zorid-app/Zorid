import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { DocumentService, DocumentBaseResult } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
const tick = () => new Promise<void>(done => setTimeout(done,8));
async function until(check:()=>boolean|Promise<boolean>) {for(let i=0;i<150;i++){if(await check())return;await tick();}assert.ok(await check());}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}

test('retrying a failed live summary save continues a newer expression whose debounce fired while pending',async()=>{
 class Adapter extends MemoryAdapter {
  documentSemantics?:DocumentService; revision=1; fail=false; gate?:{started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};
  override async list(){return(await super.list()).map(row=>({...row,entryId:row.path,revision:row.path==='Work.base'?`r${this.revision}`:'r1'}));}
  override async stat(path:string){return(await this.list()).find(row=>row.path===path)??null;}
  override async write(path:string,text:string){if(path==='Work.base'){const gate=this.gate;this.gate=undefined;if(gate){gate.started.resolve();await gate.release.promise;}if(this.fail)throw new Error('Gated summary failure');}await super.write(path,text);if(path==='Work.base')this.revision++;}
 }
 const adapter=new Adapter({'Work.base':'views: [{type: table, name: Table, order: [score], summaries: {score: Sum}}]\n','One.md':'---\nscore: 10\n---\n'});
 const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
 const definition=()=>({id:'Work.base',revision:`r${adapter.revision}`,path:'Work.base',kind:'file' as const,deleted:false});
 const unused=async():Promise<never>=>{throw new Error('Unexpected core effect');};
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:definition(),metadata:null,exclusion:null}}),
   base:async()=>{const view=BaseDocument.parse(await adapter.read('Work.base')).views[0];const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:'One.md',revision:'r1',path:'One.md',values:{'note.score':{type:'number',value:10}}}],groups:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:['note.score'],availableProperties:['note.score'],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,summaries:{'note.score':{type:'number',value:10}},summaryPreviews:{Sum:{type:'number',value:10}}};return{source,snapshot,coverageComplete:true,value:{definition:definition(),result}};},
  }),
 };
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:path==='Work.base'?`r${adapter.revision}`:'r1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
 try{
  host.querySelector<HTMLElement>('[data-summary-property="note.score"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Edit Sum"]'));doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Summary expression"]'));
  const expression=doc.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!,gate={started:deferred(),release:deferred()};adapter.gate=gate;
  expression.focus();expression.value='values.length';expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await gate.started.promise;
  expression.value='values.sum() + 7';expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(done=>setTimeout(done,300));adapter.fail=true;gate.release.resolve();
  const retry=()=>[...doc.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button=>button.textContent==='Retry save'&&!button.hidden);
  await until(()=>!!retry());assert.equal(expression.value,'values.sum() + 7');assert.equal(expression.disabled,true);adapter.fail=false;retry()!.click();
  await until(async()=>(BaseDocument.parse(await vault.read('Work.base')).getRoot('summaries') as Record<string,string>).Sum==='values.sum() + 7');await until(()=>!session.hasPendingChanges());
  assert.equal(expression.value,'values.sum() + 7');assert.equal(expression.disabled,false);assert.equal(adapter.revision,4,'builtin seed, exact retry and one continuation write');
 }finally{adapter.fail=false;adapter.gate?.release.resolve();doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}
});
