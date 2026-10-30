import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { DocumentService, DocumentBaseResult } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { DatabaseService, DatabaseCollection } from '../src/core/databases.ts';
const tick = () => new Promise<void>(done => setTimeout(done,8));
async function until(check:()=>boolean|Promise<boolean>) {for(let i=0;i<150;i++){if(await check())return;await tick();}assert.ok(await check());}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
type Gate={started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};
async function fixture(enhanced=true){
 class Adapter extends MemoryAdapter {
  documentSemantics?:DocumentService; databases?:DatabaseService; revision=1;
  override async list(){return(await super.list()).map(row=>({...row,entryId:row.path,revision:row.path==='Work.base'?`r${this.revision}`:'r1'}));}
  override async stat(path:string){return(await this.list()).find(row=>row.path===path)??null;}
  override async write(path:string,text:string){await super.write(path,text);if(path==='Work.base')this.revision++;}
 }
 const adapter=new Adapter({'Work.base':'views: [{id: aaaaaaaaaaaa, type: table, name: Table, source: {kind: collection, id: abcdefghijkl}, order: [scorevalueid], summaries: {scorevalueid: Sum}}]\n','One.md':'---\nscore: 10\n---\n'});
 const collection:DatabaseCollection={id:'abcdefghijkl',name:'Summary fixture',revision:'schema-r1',deleted:false,properties:[{id:'scorevalueid',name:'Score',datatype:'number',options:[]}]};
 adapter.databases={async request(command){assert.equal(command.op,'get');return{collections:[collection],entries:[{entryId:'One.md',collectionId:collection.id,revision:'member-r1',fileRevision:'r1',path:'One.md',values:{scorevalueid:10},deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};}} as DatabaseService;
 const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
 const definition=()=>({id:'Work.base',revision:`r${adapter.revision}`,path:'Work.base',kind:'file' as const,deleted:false});
 const unused=async():Promise<never>=>{throw new Error('Unexpected core effect');};
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:definition(),metadata:null,exclusion:null}}),
   base:async()=>{
    const view=BaseDocument.parse(await adapter.read('Work.base')).views[0];
    const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:'One.md',revision:'r1',path:'One.md',values:{'note.scorevalueid':{type:'number',value:10}}}],groups:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:['note.scorevalueid'],availableProperties:['note.scorevalueid'],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,summaries:{'note.scorevalueid':{type:'number',value:10}},summaryPreviews:{Sum:{type:'number',value:10}}};
    return{source,snapshot,coverageComplete:true,value:{definition:definition(),result}};
   },
  }),
 };
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main><button id=outside>Close tab</button>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),gates:Gate[]=[];
 const names=['window','document','MutationObserver','requestAnimationFrame','cancelAnimationFrame','getComputedStyle','HTMLElement','Node','Window'] as const;
 const previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 if(enhanced)for(const name of names){const value=dom.window[name];Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:typeof value==='function'&&['requestAnimationFrame','cancelAnimationFrame','getComputedStyle'].includes(name)?value.bind(dom.window):value});}
 dom.window.Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
 dom.window.Range.prototype.getBoundingClientRect=()=>new dom.window.DOMRect();
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:path==='Work.base'?`r${adapter.revision}`:'r1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;
 host.querySelector<HTMLElement>('[data-summary-property="note.scorevalueid"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Edit Sum"]'));doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();await until(()=>!!doc.querySelector('[aria-label="Summary expression"]'));
 const expression=doc.querySelector<HTMLTextAreaElement>('textarea[aria-label="Summary expression"]')!;
 const content=enhanced?doc.querySelector<HTMLElement>('.cm-content[aria-label="Summary expression"]')!:expression,view=enhanced?EditorView.findFromDOM(content):undefined;if(enhanced)assert.ok(view);assert.equal(expression.hidden,enhanced);
 const focus=()=>{if(view)view.focus();else expression.focus();};
 const edit=(value:string)=>{focus();if(view)view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},selection:{anchor:value.length},userEvent:'input.type'});else{expression.value=value;expression.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}};
 return{adapter,vault,dom,doc,buffers,session,expression,content,view,focus,edit,gate(){const gate={started:deferred(),release:deferred()};gates.push(gate);return gate;},
  async cleanup(){for(const gate of gates)gate.release.resolve();[...doc.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button=>button.textContent==='Cancel changes'&&!button.hidden)?.click();doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();for(const[name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}},
 };
}

for(const enhanced of [false,true])test(`actual ${enhanced?'enhanced':'native'} summary can explicitly commit a retained newer draft after close refused its continuation`,async()=>{
 const f=await fixture(enhanced);let originalFlush:NoteBuffer['flush']|undefined,closing:Promise<void>|undefined;const gate=f.gate();
 try{
  const buffer=f.buffers.get('Work.base')!;originalFlush=buffer.flush.bind(buffer);let held=false;
  // Scheduler gate only: the original shared-buffer flush really writes A.
  buffer.flush=async()=>{await originalFlush!();if(!held&&f.expression.value==='values.length'){held=true;gate.started.resolve();await gate.release.promise;}};
  const original=await f.adapter.read('Work.base');
  assert.equal(original.split('Sum: values.sum().round(2)').length,2);
  const sourceA=original.replace('Sum: values.sum().round(2)','Sum: values.length'),sourceB=original.replace('Sum: values.sum().round(2)','Sum: values.sum() + 7');
  f.edit('values.length');await gate.started.promise;assert.equal(await f.adapter.read('Work.base'),sourceA,'A has really saved before its acknowledgement tail is held');
  f.edit('values.sum() + 7');await new Promise(done=>setTimeout(done,300));
  const outside=f.doc.querySelector<HTMLButtonElement>('#outside')!;
  outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));
  closing=f.session.flush();const rejected=assert.rejects(closing,/Finish or cancel/);gate.release.resolve();await rejected;
  assert.match(f.doc.querySelector('.bases-summary-editor [role="alert"]')!.textContent!,/closing/);
  assert.equal(f.expression.value,'values.sum() + 7');assert.equal(await f.adapter.read('Work.base'),sourceA);
  f.focus();assert.equal(f.doc.activeElement,f.content);
  // Model ordinary native Tab navigation: the key reaches the real enhanced
  // content; the browser's default navigation then focuses its next control.
  f.content.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  outside.focus();
  await until(async()=>await f.adapter.read('Work.base')===sourceB);
  assert.equal(await f.adapter.read('Work.base'),sourceB);await until(()=>!f.doc.querySelector('.bases-summary-editor'));
  assert.equal(f.adapter.revision,4,'seed, exactly one real A write, and exactly one explicit B write');
  assert.equal(await f.adapter.read('One.md'),'---\nscore: 10\n---\n');
  assert.equal(f.session.hasPendingChanges(),false);await f.session.flush();
 }finally{gate.release.resolve();await closing?.catch(()=>{});if(originalFlush)f.buffers.get('Work.base')!.flush=originalFlush;await f.cleanup();}
});
