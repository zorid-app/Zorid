import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createPdfView, parsePdfSubpath } from '../src/ui/pdf-view.ts';
import type { PdfEngine, PdfViewOptions } from '../src/ui/pdf-view.ts';
import type { ContextMenuRequest } from '../src/platform/context-menu.ts';

function dom(t:TestContext){const env=new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>',{url:'https://zorid.test/dist/index.html'});t.after(()=>env.window.close());return {env,root:env.window.document.querySelector('main')!};}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(t:TestContext,options:PdfViewOptions={}){
  const {env,root}=dom(t);const events:{name:string;data:Record<string,unknown>}[]=[],hashes:string[]=[],disposed:string[]=[],opens:Record<string,unknown>[]=[];
  class Bus {listeners=new Map<string,Set<(event:never)=>void>>();on(name:string,fn:(event:never)=>void){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name)!.add(fn);}off(name:string,fn:(event:never)=>void){this.listeners.get(name)?.delete(fn);}dispatch(name:string,data:Record<string,unknown>){events.push({name,data});for(const fn of this.listeners.get(name)??[])fn(data as never);}}
  let bus!:Bus,viewer!:Viewer,links!:Links;
  class Viewer {
    currentPageNumber=1;currentScaleValue='page-width';currentScale=1;pagesRotation=0;spreadMode=0;pages=new Map<number,{div:HTMLElement;viewport:{height:number};textLayer:{highlighter:{textDivs:Node[];textContentItemsStr:string[]}}}>();
    config:Record<string,unknown>;constructor(config:Record<string,unknown>){this.config=config;viewer=this;bus=config.eventBus as Bus;}
    setDocument(value:unknown){if(value){for(let i=1;i<=3;i++){const page=env.window.document.createElement('div');page.className='page';page.dataset.pageNumber=String(i);const span=env.window.document.createElement('span');span.textContent='Hello PDF world';page.append(span);(this.config.viewer as HTMLElement).append(page);this.pages.set(i-1,{div:page,viewport:{height:720},textLayer:{highlighter:{textDivs:[span],textContentItemsStr:[span.textContent]}}});}queueMicrotask(()=>bus.dispatch('pagesinit',{}));}else disposed.push('viewer');}
    setPageLabels(){}update(){}increaseScale(){this.currentScale=1.1;}decreaseScale(){this.currentScale=.9;}updateScale(options:Record<string,unknown>){events.push({name:'zoom',data:options});}nextPage(){this.currentPageNumber=Math.min(3,this.currentPageNumber+1);return true;}previousPage(){this.currentPageNumber=Math.max(1,this.currentPageNumber-1);return true;}getPageView(index:number){return this.pages.get(index);}scrollPageIntoView(){}cleanup(){}
  }
  class Links {constructor(){links=this;}setViewer(){}setDocument(){}setHash(hash:string){hashes.push(hash);}goToPage(value:string|number){if(value==='ii')viewer.currentPageNumber=2;else if(Number(value)>=1&&Number(value)<=3)viewer.currentPageNumber=Number(value);}}
  const loading=deferred<{numPages:number;getPageLabels():Promise<string[]|null>;destroy():Promise<void>}>();
  const task:{promise:typeof loading.promise;destroy:()=>Promise<void>;onPassword?:((update:(password:string)=>void,reason:number)=>void)|null}={promise:loading.promise,async destroy(){disposed.push('task');}};
  const engine:PdfEngine={core:{GlobalWorkerOptions:{workerSrc:''},getDocument(config){opens.push(config);return task;}},viewer:{EventBus:Bus as never,PDFLinkService:Links as never,PDFFindController:class {} as never,PDFViewer:Viewer as never}};
  let acquired=0;const resources={async acquire(){acquired++;return {url:'blob:owned-pdf',type:'application/pdf',async arrayBuffer(){return Uint8Array.of(1,2,3).buffer;},release(){disposed.push('lease');}};}};
  const view=createPdfView(root,'Folder/Example.pdf',resources,{loadEngine:async()=>engine,...options});
  t.after(()=>view.destroy());
  const resolve=()=>loading.resolve({numPages:3,async getPageLabels(){return ['i','ii','iii'];},async getOutline(){return null;},async getPage(){throw new Error('not requested');},async getDestination(){return null;},async getPageIndex(){return 0;},async destroy(){disposed.push('doc');}});
  return {env,root,view,events,hashes,disposed,opens,loading,task,resolve,get bus(){return bus;},get viewer(){return viewer;},get acquired(){return acquired;}};
}
async function ticks(){for(let i=0;i<6;i++)await Promise.resolve();}
function selectPdfText(f:ReturnType<typeof fixture>,start=6,end=9,page=0){
  const node=f.viewer.pages.get(page)!.textLayer.highlighter.textDivs[0].firstChild!,range=f.env.window.document.createRange();range.setStart(node,start);range.setEnd(node,end);const selection=f.env.window.getSelection()!;selection.removeAllRanges();selection.addRange(range);return selection;
}
function pdfContext(f:ReturnType<typeof fixture>,target:Element){const event=new f.env.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:333,clientY:212});target.dispatchEvent(event);return event;}


test('retargeted annotation DOM cannot execute a stale annotation link', async t => {
  const copied:string[]=[],pending=deferred<string|null>();
  const f=fixture(t,{writeClipboard:text=>{copied.push(text);},generateMarkdownLink:subpath=>subpath});f.resolve();await f.view.ready;
  const page=f.viewer.pages.get(0)!;Object.assign(page,{pdfPage:{getAnnotations:async()=>[{id:'old',subtype:'Highlight'}]}});
  const annotation=f.env.window.document.createElement('section');annotation.dataset.annotationId='old';page.div.append(annotation);
  Object.defineProperty(f.env.window,'zorid',{value:{showContextMenu:()=>pending.promise}});
  pdfContext(f,annotation);await ticks();annotation.dataset.annotationId='new';
  pending.resolve('pdf-copy-annotation-link');await ticks();assert.deepEqual(copied,[]);
});

test('retargeted thumbnail DOM cannot execute a stale page link', async t => {
  const copied:string[]=[],pending=deferred<string|null>();
  const f=fixture(t,{writeClipboard:text=>{copied.push(text);},generateMarkdownLink:subpath=>subpath});f.resolve();await f.view.ready;
  f.root.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]')!.click();
  const thumbnail=f.root.querySelector<HTMLElement>('.zorid-pdf-thumbnail[data-page="2"]')!;
  Object.defineProperty(f.env.window,'zorid',{value:{showContextMenu:()=>pending.promise}});
  pdfContext(f,thumbnail);await ticks();thumbnail.dataset.page='3';
  pending.resolve('pdf-copy-page-link');await ticks();assert.deepEqual(copied,[]);
});

test('slanted annotation quad excludes glyphs outside its polygon but inside bounding box', async t => {
  const copied:string[]=[],requests:ContextMenuRequest[]=[];
  const f=fixture(t,{writeClipboard:text=>{copied.push(text);},generateMarkdownLink:subpath=>subpath});f.resolve();await f.view.ready;
  const page=f.viewer.pages.get(0)!,canvas=f.env.window.document.createElement('div');canvas.className='canvasWrapper';page.div.append(canvas);
  page.textLayer.highlighter.textDivs[0].textContent='X';
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100}) as DOMRect;
  // A thin slanted parallelogram: X center (1,9) is not in it.
  Object.assign(page,{viewport:{width:100,height:100,convertToPdfPoint:(x:number,y:number)=>[x,y]},pdfPage:{getAnnotations:async()=>[{id:'mark',subtype:'Highlight',quadPoints:[0,1,9,10,1,0,10,9]}]}});
  Object.defineProperty(f.env.window.Range.prototype,'getClientRects',{configurable:true,value:()=>[{left:0,top:8,width:2,height:2}]});
  const annotation=f.env.window.document.createElement('section');annotation.dataset.annotationId='mark';page.div.append(annotation);
  Object.defineProperty(f.env.window,'zorid',{value:{showContextMenu:async(request:ContextMenuRequest)=>{requests.push(request);return 'pdf-copy-annotation';}}});
  pdfContext(f,annotation);await ticks();
  assert.deepEqual(requests[0].items.map(item=>'id'in item?item.id:null),['pdf-copy-annotation-link']);assert.deepEqual(copied,[]);
});
