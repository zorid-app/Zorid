import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter,Vault } from '../src/core/index.ts';
import { readProperties } from '../src/core/properties.ts';
import type { DocumentService,DocumentBaseResult,DocumentBaseValue } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseSession } from '../src/bases/session.ts';
const tick=()=>new Promise<void>(done=>setTimeout(done,8));
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<120;i++){if(await check())return;await tick();}assert.ok(await check());}
async function fixture(property='author',available=true,type:'relation'|'link'='relation'){
 class Adapter extends MemoryAdapter{
  documentSemantics?:DocumentService;revisions=new Map<string,number>();targetId='author-original';
  id(path:string){return path==='Authors/Hale.md'?this.targetId:path;}
  identify<T extends{path:string}>(row:T){return{...row,entryId:this.id(row.path),revision:`r${this.revisions.get(row.path)??1}`};}
  override async list(){return(await super.list()).map(row=>this.identify(row));}
  override async stat(path:string){const row=await super.stat(path);return row&&this.identify(row);}
  override async write(path:string,text:string){await super.write(path,text);this.revisions.set(path,(this.revisions.get(path)??1)+1);}
 }
 const id=`note.${property}`,base=`views: [{type: table, name: Table, order: [${JSON.stringify(id)}]}]\n`;
 const adapter=new Adapter({'Work.base':base,'Books/One.md':`---\n${JSON.stringify(property)}: null\n---\nBody`,'Authors/Hale.md':'---\ntype: author\n---\nHale','Contacts/Bob.md':'---\ntype: contact\n---\nBob','Properties.yaml':`properties:\n  ${JSON.stringify(property)}:\n    type: ${type}\n${type==='relation'?`    relation:\n      targetFilter: 'type == "author"'\n`:''}`});
 const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
 const entry=async(path:string)=>{const row=(await adapter.stat(path))!;return{id:row.entryId,revision:row.revision,path,kind:'file' as const,deleted:false};};
 const unused=async():Promise<never>=>{throw new Error('Unexpected core effect');};
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async input=>({source,snapshot,coverageComplete:true,value:{entry:await entry(input),metadata:null,exclusion:null}}),base:async()=>{
   const actor=await entry('Books/One.md'),target=await entry('Authors/Hale.md'),stored=readProperties(await adapter.read(actor.path)).find(item=>item.key===property)?.value;
   const raw:DocumentBaseValue=typeof stored==='string'?{type:'string',value:stored}:{type:'null'};
   const value:DocumentBaseValue=typeof stored==='string'?{type:'link',path:target.path,display:'Hale',target:{entryId:target.id,revision:target.revision},external:false}:{type:'null'};
   const result:DocumentBaseResult={snapshotId:snapshot,view:BaseDocument.parse(base).views[0],rows:[{entryId:actor.id,revision:actor.revision,path:actor.path,values:{[id]:value},editValues:{[id]:raw}}],groups:[{key:null,keyId:null,entryIds:[actor.id]}],groupOptions:[],properties:[id],availableProperties:[id],relationTargets:{[property]:[{entryId:target.id,revision:target.revision,path:target.path,label:'Hale'}]},counts:{scanned:3,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:available,metadataComplete:true,metadataIssues:[],stepsUsed:1};
   return{source,snapshot,coverageComplete:true,value:{definition:await entry('Work.base'),result}};
  }}),
 };
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[];let bufferRequests=0;
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},onError(error){errors.push(error);},buffers:{validate(){},async getBuffer(path){bufferRequests++;let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:adapter.id(path),revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);
 const key=(element:Element,key:string)=>element.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 const open=()=>{const cell=host.querySelector<HTMLElement>(`[data-property="${id}"][role="gridcell"]`)!;key(cell,'Enter');return doc.querySelector<HTMLInputElement>('.bases-property-popover input')!;};
 return{adapter,vault,doc,host,session,errors,key,open,requests:()=>bufferRequests,async cleanup(){const input=doc.querySelector('.bases-property-popover input');if(input)key(input,'Escape');await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

for(const property of ['author','note.author'])test(`normal session relation picker uses core-filtered targets for exact raw key ${property} without an override`,async()=>{
 const f=await fixture(property);try{
  const input=f.open();assert.ok(input);const choices=[...f.doc.querySelectorAll<HTMLElement>('.bases-property-popover [role="option"]')];assert.deepEqual(choices.map(item=>item.textContent),['Hale']);
  input.value='Hale';input.dispatchEvent(new f.doc.defaultView!.Event('input',{bubbles:true}));f.key(input,'Enter');
  await until(async()=>typeof readProperties(await f.vault.read('Books/One.md')).find(item=>item.key===property)?.value==='string');
  assert.equal(readProperties(await f.vault.read('Books/One.md')).find(item=>item.key===property)!.value,'[[/Authors/Hale.md]]');assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('a refreshed or replaced core relation target invalidates the retained picker before any actor mutation',async()=>{
 const f=await fixture();try{
  const input=f.open(),choice=f.doc.querySelector<HTMLButtonElement>('.bases-property-popover [role="option"]')!;
  f.adapter.targetId='replacement-author';await f.vault.modify('Authors/Hale.md','Replacement');choice.click();await tick();assert.equal(f.requests(),0);assert.match(f.host.querySelector('[data-base-editing]')!.getAttribute('title')!,/unavailable/);
  await f.session.refresh();choice.click();await tick();assert.equal(f.requests(),0);assert.equal(input.isConnected,true);assert.equal(readProperties(await f.vault.read('Books/One.md'))[0].value,null);
  f.key(input,'Escape');await tick();const fresh=f.open();assert.ok(fresh);fresh.value='Hale';fresh.dispatchEvent(new f.doc.defaultView!.Event('input',{bubbles:true}));f.key(fresh,'Enter');await until(async()=>typeof readProperties(await f.vault.read('Books/One.md'))[0].value==='string');
 }finally{await f.cleanup();}
});

test('unavailable core relationships never expose a supplied but unauthoritative target list',async()=>{
 const f=await fixture('author',false);try{f.open();assert.equal(f.doc.querySelector('.bases-property-popover [role="option"]'),null);assert.match(f.doc.querySelector('.suggestion-empty')!.textContent!,/unavailable until the shared index is ready/);assert.equal(f.requests(),0);}finally{await f.cleanup();}
});

test('plain link session uses captured unfiltered core suggestions without making free URL edits require a relation',async()=>{
 const f=await fixture('reference',true,'link');try{
  const input=f.open();assert.ok(input);assert.deepEqual([...f.doc.querySelectorAll('[role="option"]')].map(choice=>choice.textContent),['Hale']);
  input.value='Hale';input.dispatchEvent(new f.doc.defaultView!.Event('input',{bubbles:true}));f.key(input,'Enter');
  await until(async()=>readProperties(await f.vault.read('Books/One.md'))[0].value==='[[/Authors/Hale.md]]');assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});
test('plain link session rejects retained suggestions after same-path target replacement',async()=>{
 const f=await fixture('reference',true,'link');try{
  const input=f.open(),choice=f.doc.querySelector<HTMLButtonElement>('[role="option"]')!;
  f.adapter.targetId='replacement-author';await f.vault.modify('Authors/Hale.md','Replacement');choice.click();await tick();
  assert.equal(f.requests(),0);assert.equal(readProperties(await f.vault.read('Books/One.md'))[0].value,null);assert.match(f.host.querySelector('[data-base-editing]')!.getAttribute('title')!,/unavailable/);
  assert.equal(input.isConnected,true);
 }finally{await f.cleanup();}
});
