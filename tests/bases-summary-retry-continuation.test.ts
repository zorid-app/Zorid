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
type Gate={started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};
async function fixture(){
 class Adapter extends MemoryAdapter {
  documentSemantics?:DocumentService; revision=1; fail=false; gate?:Gate; queryGate? :Gate&{revision:number};
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
   base:async()=>{
    const revision=adapter.revision,view=BaseDocument.parse(await adapter.read('Work.base')).views[0];
    const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:'One.md',revision:'r1',path:'One.md',values:{'note.score':{type:'number',value:10}}}],groups:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:['note.score'],availableProperties:['note.score'],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,summaries:{'note.score':{type:'number',value:10}},summaryPreviews:{Sum:{type:'number',value:10}}};
    const report={source,snapshot,coverageComplete:true,value:{definition:definition(),result}},gate=adapter.queryGate;
    if(gate&&revision===gate.revision){adapter.queryGate=undefined;gate.started.resolve();await gate.release.promise;}return report;
   },
  }),
 };
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),gates:Gate[]=[];
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:path==='Work.base'?`r${adapter.revision}`:'r1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
 host.querySelector<HTMLElement>('[data-summary-property="note.score"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Edit Sum"]'));doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Summary expression"]'));
 const expression=doc.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!;
 const edit=(value:string)=>{expression.focus();expression.value=value;expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 return{adapter,vault,dom,doc,buffers,session,expression,edit,gate(){const gate={started:deferred(),release:deferred()};gates.push(gate);return gate;},retry:()=>[...doc.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button=>button.textContent==='Retry save'&&!button.hidden),
  async cleanup(){adapter.fail=false;for(const gate of gates)gate.release.resolve();[...doc.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button=>button.textContent==='Cancel changes'&&!button.hidden)?.click();doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();},
 };
}

test('retrying a failed live summary save continues a newer expression whose debounce fired while pending',async()=>{
 const f=await fixture();try{
  const gate=f.gate();f.adapter.gate=gate;f.edit('values.length');await gate.started.promise;
  f.edit('values.sum() + 7');await new Promise(done=>setTimeout(done,300));f.adapter.fail=true;gate.release.resolve();
  await until(()=>!!f.retry());assert.equal(f.expression.value,'values.sum() + 7');assert.equal(f.expression.disabled,true);f.adapter.fail=false;f.retry()!.click();
  await until(async()=>(BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') as Record<string,string>).Sum==='values.sum() + 7');await until(()=>!f.session.hasPendingChanges());
  assert.equal(f.expression.value,'values.sum() + 7');assert.equal(f.expression.disabled,false);assert.equal(f.adapter.revision,4,'builtin seed, exact retry and one continuation write');
 }finally{await f.cleanup();}
});

for(const retry of [false,true])test(`summary ${retry?'persistence retry':'save'} acknowledgement refuses an intervening externally reloaded configuration`,async()=>{
 const f=await fixture();try{
  const gate=f.gate();
  if(retry){f.adapter.fail=true;f.edit('values.length');await until(()=>!!f.retry());f.adapter.fail=false;f.adapter.queryGate={...gate,revision:3};f.retry()!.click();}
  else{f.adapter.queryGate={...gate,revision:3};f.edit('values.length');}
  await gate.started.promise;
  const external=BaseDocument.parse(await f.vault.read('Work.base'));external.updateRoot({summaries:{Sum:'777'}});await f.vault.modify('Work.base',external.toString());await f.buffers.get('Work.base')!.reload();gate.release.resolve();await f.session.refresh();
  await until(()=>!!f.doc.querySelector('.bases-summary-editor [role="alert"]')?.textContent);
  assert.match(f.doc.querySelector('.bases-summary-editor [role="alert"]')!.textContent!,/changed before.*acknowledged/);assert.equal(f.session.hasPendingChanges(),true);assert.equal(f.expression.value,'values.length');assert.equal(f.expression.disabled,false);
  f.edit('values.sum() + 7');await new Promise(done=>setTimeout(done,350));
  assert.equal((BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') as Record<string,string>).Sum,'777','a later draft never overwrites the unrelated external configuration');
  assert.equal(f.expression.value,'values.sum() + 7');assert.equal(f.session.hasPendingChanges(),true);
 }finally{await f.cleanup();}
});

test('summary deletion acknowledgement retains an intervening external configuration instead of adopting it',async()=>{
 const f=await fixture();try{
  const gate=f.gate();f.adapter.queryGate={...gate,revision:3};f.doc.querySelector<HTMLButtonElement>('[aria-label="Summary actions"]')!.click();[...f.doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Delete summary')!.click();await gate.started.promise;
  const external=BaseDocument.parse(await f.vault.read('Work.base'));external.updateRoot({summaries:{Sum:'777'}});external.updateView(0,{summaries:{score:'Sum'}});await f.vault.modify('Work.base',external.toString());await f.buffers.get('Work.base')!.reload();gate.release.resolve();await f.session.refresh();
  await until(()=>!!f.doc.querySelector('.bases-summary-editor [role="alert"]')?.textContent);assert.match(f.doc.querySelector('.bases-summary-editor [role="alert"]')!.textContent!,/changed before.*acknowledged/);assert.equal(f.session.hasPendingChanges(),true);assert.equal(f.expression.disabled,false);
  assert.equal((BaseDocument.parse(await f.vault.read('Work.base')).getRoot('summaries') as Record<string,string>).Sum,'777');
 }finally{await f.cleanup();}
});
