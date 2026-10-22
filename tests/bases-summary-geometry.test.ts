import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter, Vault} from '../src/core/index.ts';
import type {DocumentService, DocumentBaseResult} from '../src/core/document-semantics.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {createBaseSession} from '../src/bases/session.ts';
const tick = () => new Promise<void>(done => setTimeout(done, 5));
async function until(check: () => boolean) {for(let i=0;i<100&&!check();i++)await tick();assert.ok(check());}
async function fixture() {
  class Adapter extends MemoryAdapter {
    documentSemantics?: DocumentService; revision=1;
    override async list(){return(await super.list()).map(row=>({...row,entryId:row.path,revision:row.path==='Work.base'?`r${this.revision}`:'r1'}));}
    override async stat(path:string){return(await this.list()).find(row=>row.path===path)??null;}
    override async write(path:string,text:string){await super.write(path,text);if(path==='Work.base')this.revision++;}
  }
  const adapter=new Adapter({'Work.base':'summaries: {Total: "values.sum()"}\nviews: [{type: table, name: Table, order: [score], summaries: {score: Total}}]\n','One.md':'---\nscore: 10\n---\n'});
  const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
  const definition=()=>({id:'Work.base',revision:`r${adapter.revision}`,path:'Work.base',kind:'file' as const,deleted:false});
  const unused=async():Promise<never>=>{throw new Error('Unexpected core effect');};
  adapter.documentSemantics={status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:definition(),metadata:null,exclusion:null}}),base:async()=>{
      const view=BaseDocument.parse(await adapter.read('Work.base')).views[0];
      const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:'One.md',revision:'r1',path:'One.md',values:{'note.score':{type:'number',value:10}}}],groups:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:['note.score'],availableProperties:['note.score'],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,summaries:{'note.score':{type:'number',value:10}},summaryPreviews:{Total:{type:'number',value:10}}};
      return{source,snapshot,coverageComplete:true,value:{definition:definition(),result}};
    }}),
  };
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),win=dom.window,doc=win.document,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[];
  Object.defineProperty(win,'innerWidth',{value:1024,writable:true});Object.defineProperty(win,'innerHeight',{value:800,writable:true});
  let anchorLeft=830,anchorBottom=780,naturalHeight=240,measurements=0,observed:Element|undefined,resizeCallback:(()=>void)|undefined,disconnected=false;
  class Observer {constructor(callback:()=>void){resizeCallback=callback;}observe(element:Element){observed=element;}disconnect(){disconnected=true;}}
  Object.defineProperty(win,'ResizeObserver',{value:Observer,configurable:true});
  const original=win.HTMLElement.prototype.getBoundingClientRect;
  const rect=(left:number,top:number,width:number,height:number)=>({left,top,right:left+width,bottom:top+height,x:left,y:top,width,height,toJSON(){return{};}});
  // Model browser measurements: revealing More adds80px to the current measured
  // panel; CSS max-width/height still bounds it to viewport minus8px margins.
  win.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.classList.contains('bases-summary-editor')){measurements++;const extra=this.querySelector<HTMLElement>('.bases-summary-actions')?.hidden===false?80:0;return rect(parseFloat(this.style.left)||0,parseFloat(this.style.top)||0,Math.min(300,win.innerWidth-16),Math.min(naturalHeight+extra,win.innerHeight-16)) as DOMRect;}
    if(this.hasAttribute('data-summary-property'))return rect(anchorLeft,anchorBottom-24,100,24) as DOMRect;
    return original.call(this);
  };
  Object.defineProperty(win.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.getBoundingClientRect().height;}});
  const host=doc.querySelector('main')!;
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){},onError(error){errors.push(error);},buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:path==='Work.base'?`r${adapter.revision}`:'r1'})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  await session.ready;assert.ifError(session.state.error);
  const anchor=host.querySelector<HTMLElement>('[data-summary-property="note.score"]')!;anchor.click();await until(()=>!!doc.querySelector('[aria-label="Edit Total"]'));doc.querySelector<HTMLButtonElement>('[aria-label="Edit Total"]')!.click();
  await until(()=>!!doc.querySelector('.bases-summary-editor'));
  const panel=doc.querySelector<HTMLElement>('.bases-summary-editor')!,more=panel.querySelector<HTMLButtonElement>('[aria-label="Summary actions"]')!,remove=panel.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  const fit=()=>{const r=panel.getBoundingClientRect();assert.ok(r.left>=8&&r.top>=8);assert.ok(r.right<=win.innerWidth-8,`right ${r.right} <= ${win.innerWidth-8}`);assert.ok(r.bottom<=win.innerHeight-8,`bottom ${r.bottom} <= ${win.innerHeight-8}`);return r;};
  return{win,doc,host,session,panel,more,remove,anchor,errors,fit,get measurements(){return measurements;},get observed(){return observed;},get disconnected(){return disconnected;},grow(height:number){naturalHeight=height;resizeCallback?.();},moveAnchor(left:number,bottom:number){anchorLeft=left;anchorBottom=bottom;},async cleanup(){doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('revealing summary actions remeasures bottom-anchored editor and keeps Delete reachable with focus',async()=>{
  const f=await fixture();try{
    const before=f.fit();f.more.click();const after=f.fit();
    assert.ok(after.top<before.top,'revealed action moves entire editor up before hit testing');
    assert.equal(f.more.getAttribute('aria-expanded'),'true');assert.equal(f.doc.activeElement,f.remove);
    f.remove.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(f.more.getAttribute('aria-expanded'),'false');assert.equal(f.remove.closest<HTMLElement>('[role="menu"]')!.hidden,true);assert.equal(f.doc.activeElement,f.more);assert.equal(f.panel.isConnected,true);
    f.more.click();f.fit();f.remove.click();await until(()=>!f.panel.isConnected);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('summary placement tracks content resize and ancestor scrolling, then stops after cleanup',async()=>{
  const f=await fixture();try{
    f.more.click();f.fit();assert.equal(f.observed,f.panel);
    f.grow(400);f.fit();
    Object.defineProperty(f.win,'innerWidth',{value:360,writable:true});Object.defineProperty(f.win,'innerHeight',{value:520,writable:true});f.win.dispatchEvent(new f.win.Event('resize'));f.fit();
    f.moveAnchor(16,100);f.host.dispatchEvent(new f.win.Event('scroll'));const moved=f.fit();assert.equal(moved.left,16);assert.equal(moved.top,32,'expanded panel still fits at the available bottom');
    const count=f.measurements;f.panel.dispatchEvent(new f.win.Event('scroll'));assert.equal(f.measurements,count,'own overflow scroll does not reset the anchored placement');
    f.anchor.remove();f.moveAnchor(900,900);f.win.dispatchEvent(new f.win.Event('resize'));assert.equal(f.fit().left,16,'a remounted result retains the last witnessed anchor instead of measuring its detached DOM');
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();await until(()=>!f.panel.isConnected);assert.equal(f.disconnected,true);
    const cleaned=f.measurements;f.win.dispatchEvent(new f.win.Event('resize'));f.host.dispatchEvent(new f.win.Event('scroll'));f.grow(450);assert.equal(f.measurements,cleaned,'retired editor releases resize/scroll/content observers');
  }finally{await f.cleanup();}
});
