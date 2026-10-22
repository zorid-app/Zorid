import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { DocumentService, DocumentBaseResult } from '../src/core/document-semantics.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { readProperties } from '../src/core/properties.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';

async function fixture(manual=false,listType?:'list'|'tags'|'multiselect'|'relation',allowMutations=false){
 class Adapter extends MemoryAdapter{
  documentSemantics?:DocumentService;
  override async list(){return(await super.list()).map(row=>({...row,entryId:row.path,revision:'r1'}));}
  override async stat(path:string){return(await this.list()).find(row=>row.path===path)??null;}
 }
 const base=`views:\n  - type: kanban\n    name: Board\n    order: [file.name, score]\n    groupBy: {property: score, direction: ASC}\n${manual?'    groupOrder: [10, 20]\n':''}`;
 const settings=listType?`properties:\n  score:\n    type: ${listType}\n${listType==='relation'?'    relation: {multiple: true}\n':listType==='multiselect'?'    options: [{value: "20"}]\n':''}`:undefined;
 const adapter=new Adapter({'Work.base':base,'One.md':'---\nscore: 10\n---\n','Two.md':'---\nscore: 20\n---\n',...(settings?{'Properties.yaml':settings,'Target20.md':'# Target'}:{})}),view=BaseDocument.parse(base).views[0];
 const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'},definition={id:'Work.base',revision:'r1',path:'Work.base',kind:'file' as const,deleted:false};
 const number=(value:number)=>({type:'number' as const,value});const editKey=(value:number)=>listType?{type:'string' as const,value:listType==='relation'?`[[/Target${value}.md]]`:String(value)}:number(value);let emptyWritable=true;
 const unused=async():Promise<never>=>{throw new Error('Unexpected core operation');};
 adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
  open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async id=>({source,snapshot,coverageComplete:true,value:{entry:{...definition,id,path:id},metadata:null,exclusion:null}}),base:async()=>{
   const rows=[{entryId:'One.md',revision:'r1',path:'One.md',values:{'file.name':{type:'string' as const,value:'One'},'note.score':number(10)}},...(!manual?[{entryId:'Two.md',revision:'r1',path:'Two.md',values:{'file.name':{type:'string' as const,value:'Two'},'note.score':number(20)}}]:[])];
   const result:DocumentBaseResult={snapshotId:snapshot,view,rows,groups:[{key:number(10),keyId:'ten',editKey:editKey(10),orderKey:number(10),entryIds:['One.md']},...(!manual?[{key:number(20),keyId:'twenty',orderKey:number(20),entryIds:['Two.md']}]:[])],
    groupOptions:[{key:number(10),keyId:'ten',editKey:editKey(10),orderKey:number(10),count:1,listed:true},{key:number(20),keyId:'twenty',...(manual&&emptyWritable?{editKey:editKey(20)}:{}),orderKey:number(20),count:manual?0:1,listed:true}],properties:['file.name','note.score'],availableProperties:['file.name','note.score'],counts:{scanned:rows.length,matched:rows.length,afterGroupOrder:rows.length,afterSearch:rows.length,returned:rows.length},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1};return{source,snapshot,coverageComplete:true,value:{definition,result}};
  }}),
 };
 const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,errors:unknown[]=[],opened:string[]=[],buffers=new Map<string,NoteBuffer>();
 const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(path){opened.push(path);},onError(error){errors.push(error);},buffers:{validate(){},async getBuffer(path){if(!allowMutations)throw new Error('Disabled group actions must not request a buffer');let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:'r1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);
 return{dom,host,vault,session,errors,opened,setEmptyWritable(value:boolean){emptyWritable=value;},columns:()=>[...host.querySelectorAll<HTMLElement>('.bases-kanban-column')],async cleanup(){await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('actual session disables New and card dragging only for the opaque groups missing core editKey',async()=>{
 const f=await fixture();try{
  const columns=f.columns();assert.equal(columns.length,2);assert.deepEqual(f.session.state.result!.groups[0].editKey,{type:'number',value:10});
  assert.equal(columns[0].querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!.disabled,false);
  const disabled=columns[1].querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!;assert.equal(disabled.disabled,true);disabled.click();
  assert.equal(columns[0].querySelector<HTMLElement>('.bases-kanban-card')!.draggable,true);assert.equal(columns[1].querySelector<HTMLElement>('.bases-kanban-card')!.draggable,false);assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('synthesized empty manual columns preserve core capability metadata and recheck it after refresh',async()=>{
 const f=await fixture(true);try{
  assert.equal(f.session.state.result!.groups.length,1);assert.equal(f.columns().length,2);
  assert.equal(f.columns()[1].querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!.disabled,false);
  f.setEmptyWritable(false);await f.session.refresh();
  assert.equal(f.columns()[1].querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!.disabled,true);assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

for(const type of ['list','tags','multiselect','relation'] as const)test(`empty-column New persists declared ${type} scalar defaults as a list`,async()=>{
 const f=await fixture(true,type);try{
  const button=f.columns()[1].querySelector<HTMLButtonElement>('.bases-kanban-column-footer button')!;assert.equal(button.disabled,false);button.click();
  for(let i=0;i<100&&!f.opened.length;i++)await new Promise(done=>setTimeout(done,5));assert.equal(f.opened.length,1);
  const expected=type==='relation'?'[[/Target20.md]]':'20';assert.deepEqual(readProperties(await f.vault.read(f.opened[0])).find(property=>property.key==='score')!.value,[expected]);assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('moving a malformed scalar row into a declared multiselect column persists an explicit array',async()=>{
 const f=await fixture(true,'multiselect',true);try{
  const card=f.columns()[0].querySelector<HTMLElement>('.bases-kanban-card')!,drag=new f.dom.window.Event('dragstart',{bubbles:true,cancelable:true});
  Object.defineProperty(drag,'dataTransfer',{value:{setData(){},setDragImage(){}}});card.dispatchEvent(drag);f.columns()[1].dispatchEvent(new f.dom.window.Event('drop',{bubbles:true,cancelable:true}));
  for(let i=0;i<100;i++){const value=readProperties(await f.vault.read('One.md')).find(property=>property.key==='score')!.value;if(Array.isArray(value))break;await new Promise(done=>setTimeout(done,5));}
  assert.deepEqual(readProperties(await f.vault.read('One.md')).find(property=>property.key==='score')!.value,['20']);assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});
