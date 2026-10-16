import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createPdfView, parsePdfSubpath } from '../src/ui/pdf-view.ts';
import type { PdfEngine, PdfViewOptions } from '../src/ui/pdf-view.ts';

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
  let acquired=0;const resources={async acquire(){acquired++;return {url:'blob:owned-pdf',type:'application/pdf',release(){disposed.push('lease');}};}};
  const view=createPdfView(root,'Folder/Example.pdf',resources,{loadEngine:async()=>engine,...options});
  t.after(()=>view.destroy());
  const resolve=()=>loading.resolve({numPages:3,async getPageLabels(){return ['i','ii','iii'];},async destroy(){disposed.push('doc');}});
  return {env,root,view,events,hashes,disposed,opens,loading,task,resolve,get bus(){return bus;},get viewer(){return viewer;},get acquired(){return acquired;}};
}
async function ticks(){for(let i=0;i<6;i++)await Promise.resolve();}

test('PDF subpath uses PDF destination coordinates and item/offset selection tuples',()=>{
  assert.deepEqual(parsePdfSubpath('#chapter-one'),{destination:'chapter-one'});
  assert.deepEqual(parsePdfSubpath('#page=3&selection=1,2,4,6'),{page:3,destination:[2,{name:'FitBH'},null],selection:[1,2,4,6]});
  assert.deepEqual(parsePdfSubpath('#page=2&offset=10,200,150&height=300'),{page:2,destination:[1,{name:'XYZ'},10,200,150],height:300});
  assert.equal(parsePdfSubpath('#page=3&selection=1,2,x,3').selection,undefined);
  assert.equal(parsePdfSubpath('#page=3&selection=1,2,3,4&annotation=abc').annotation,'abc');
  assert.equal(parsePdfSubpath('#page=3&selection=1,2,3,4&annotation=abc').selection,undefined);
  assert.equal(parsePdfSubpath('#page=2suffix').page,2);
});

test('loads PDF.js with owned resource and continuous viewer; labels, zoom, rotation and teardown',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;
  assert.equal(f.acquired,1);assert.equal(f.opens[0].url,'blob:owned-pdf');assert.equal(f.opens[0].isEvalSupported,false);
  assert.equal(f.opens[0].cMapUrl,'https://zorid.test/dist/lib/pdfjs/cmaps/');
  assert.equal(f.viewer.config.maxCanvasPixels,16777216);assert.equal(f.viewer.config.textLayerMode,1);
  assert.equal(f.root.querySelector<HTMLInputElement>('[aria-label="Page"]')!.value,'i');
  f.view.goToPage('ii');assert.equal(f.viewer.currentPageNumber,2);f.view.goToPage(99);assert.equal(f.viewer.currentPageNumber,3);
  f.view.setScale(15);assert.equal(f.viewer.currentScaleValue,'10');f.view.rotate(-90);assert.equal(f.viewer.pagesRotation,270);f.view.rotate(5);assert.equal(f.viewer.pagesRotation,270);
  f.view.destroy();await ticks();assert.deepEqual(f.disposed,['task','viewer','lease']);assert.equal(f.root.childElementCount,0);
  f.view.destroy();assert.equal(f.disposed.filter(item=>item==='lease').length,1);
});

test('audited arrow shortcut applies only in standalone fit modes and avoids form fields',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;const scroller=f.root.querySelector<HTMLElement>('.zorid-pdf-scroll')!;
  const send=(target:HTMLElement,key:string,extra={})=>{const e=new f.env.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(e);return e;};
  assert.equal(send(scroller,'ArrowRight').defaultPrevented,true);assert.equal(f.viewer.currentPageNumber,2);
  send(f.root.querySelector('input')!,'ArrowRight');assert.equal(f.viewer.currentPageNumber,2);
  f.view.setScale(1.5);assert.equal(send(scroller,'ArrowRight').defaultPrevented,false);assert.equal(f.viewer.currentPageNumber,2);
  f.view.setScale('page-height');send(scroller,'ArrowLeft',{ctrlKey:true});assert.equal(f.viewer.currentPageNumber,2);
  // Upstream's generic keyboard handler is intentionally not attached by our adapter.
  assert.equal(send(scroller,'r').defaultPrevented,false);assert.equal(f.viewer.pagesRotation,0);
});

test('embed height and mobile canvas bound apply without standalone arrow key interception',async t=>{
  const f=fixture(t,{embed:true,mobile:true,subpath:'#page=2&height=320'});f.resolve();await f.view.ready;
  assert.equal(f.viewer.config.maxCanvasPixels,5242880);assert.equal(f.root.querySelector<HTMLElement>('.zorid-pdf-stage')!.style.height,'320px');
  assert.deepEqual(JSON.parse(f.hashes[0]),[1,{name:'FitBH'},null]);
  const event=new f.env.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});f.root.querySelector('.zorid-pdf-scroll')!.dispatchEvent(event);assert.equal(event.defaultPrevented,false);
});

test('find keyboard scope dispatches options, reverse navigation and closes on Escape',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;f.view.showSearch();const query=f.root.querySelector<HTMLInputElement>('[aria-label="Search PDF"]')!;query.value='hello';
  query.dispatchEvent(new f.env.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,shiftKey:true}));
  const search=f.events.findLast(event=>event.name==='find')!.data;assert.equal(search.query,'hello');assert.equal(search.findPrevious,true);assert.equal(search.caseSensitive,false);assert.equal(search.matchDiacritics,false);
  query.dispatchEvent(new f.env.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.root.querySelector<HTMLElement>('.zorid-pdf-find')!.hidden,true);
  const before=f.events.length;query.dispatchEvent(new f.env.window.KeyboardEvent('keydown',{key:'F3',bubbles:true,cancelable:true}));assert.equal(f.events.length,before);
});


test('modifier-wheel zoom uses pointer origin without leaking browser zoom; ordinary scrolling suppresses it briefly',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;Object.defineProperty(f.env.window.document,'visibilityState',{value:'visible',configurable:true});
  const scroller=f.root.querySelector<HTMLElement>('.zorid-pdf-scroll')!;
  scroller.dispatchEvent(new f.env.window.KeyboardEvent('keydown',{key:'Control',bubbles:true}));
  const wheel=new f.env.window.WheelEvent('wheel',{deltaY:-30,ctrlKey:true,clientX:80,clientY:120,cancelable:true,bubbles:true});scroller.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented,true);const zoom=f.events.findLast(event=>event.name==='zoom')!.data;assert.equal(zoom.steps,1);assert.deepEqual(zoom.origin,[80,120]);
  scroller.dispatchEvent(new f.env.window.WheelEvent('wheel',{deltaY:30,cancelable:true}));const count=f.events.filter(event=>event.name==='zoom').length;
  scroller.dispatchEvent(new f.env.window.WheelEvent('wheel',{deltaY:-30,ctrlKey:true,cancelable:true}));assert.equal(f.events.filter(event=>event.name==='zoom').length,count);
});

test('DOM selection serializes item indices and descendant offsets, rejecting cross-page ranges',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;const first=f.viewer.pages.get(0)!.textLayer.highlighter.textDivs[0],second=f.viewer.pages.get(1)!.textLayer.highlighter.textDivs[0];
  const range=f.env.window.document.createRange();range.setStart(first.firstChild!,6);range.setEnd(first.firstChild!,9);const selection=f.env.window.getSelection()!;selection.addRange(range);
  assert.equal(f.view.getSelectionSubpath(),'#page=1&selection=0,6,0,9');
  range.setEnd(second.firstChild!,3);selection.removeAllRanges();selection.addRange(range);assert.equal(f.view.getSelectionSubpath(),null);
});

test('closing during document load destroys worker and releases lease, without attaching late pages',async t=>{
  const f=fixture(t);await ticks();f.view.destroy();f.resolve();await f.view.ready;await ticks();assert.deepEqual(f.disposed,['task','viewer','lease']);assert.equal(f.root.childElementCount,0);
});

test('late lease after destruction releases immediately and never opens PDF',async t=>{
  const {root}=dom(t),lease=deferred<{url:string;type:string;release():void}>();let released=0;
  const view=createPdfView(root,'a.pdf',{acquire:()=>lease.promise},{loadEngine:async()=>({} as PdfEngine)});await ticks();view.destroy();lease.resolve({url:'blob:a',type:'application/pdf',release(){released++;}});await view.ready;assert.equal(released,1);assert.equal(root.childElementCount,0);
});

test('load failures display a bounded error and clean task/lease rather than leaking ownership',async t=>{
  const f=fixture(t);await ticks();f.loading.reject(new Error('Invalid PDF'));await assert.rejects(f.view.ready,/Invalid PDF/);assert.match(f.root.textContent??'',/Unable to display PDF: Invalid PDF/);assert.ok(f.disposed.includes('task'));assert.ok(f.disposed.includes('lease'));
});

test('password retry stays in viewer and passes only submitted nonempty input to PDF.js',async t=>{
  const f=fixture(t);await ticks();let supplied='';f.task.onPassword!(value=>{supplied=value;},2);const input=f.root.querySelector<HTMLInputElement>('[aria-label="PDF password"]')!;input.value='secret';f.root.querySelector('form')!.dispatchEvent(new f.env.window.Event('submit',{cancelable:true}));assert.equal(supplied,'secret');assert.equal(input.value,'');assert.equal(f.root.querySelector<HTMLFormElement>('form')!.hidden,true);f.resolve();await f.view.ready;
});

/** Original two-page PDF fixture. Valid xref offsets keep this independent of proprietary test assets. */
function samplePdf():Uint8Array{
  const contents='1 0 0 rg 20 20 80 50 re f\n0 0 0 rg BT /F1 18 Tf 20 100 Td (Hello Zorid PDF) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',...Array.from({length:2},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`];
  let source='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(source.length);source+=`${i+1} 0 obj\n${object}\nendobj\n`;});const start=source.length;source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return new TextEncoder().encode(source);
}
test('official PDF.js 5.3.31 parses and paints the original fixture, including selectable text data',async()=>{
  // Node's legacy entry supplies the DOM geometry primitives absent from Node, with the same engine version.
  const engine=await import('pdfjs-dist/legacy/build/pdf.mjs');assert.equal(engine.version,'5.3.31');
  const require=createRequire(import.meta.url),pdfRequire=createRequire(require.resolve('pdfjs-dist/package.json'));
  const {createCanvas}=pdfRequire('@napi-rs/canvas');
  const task=engine.getDocument({data:samplePdf(),isEvalSupported:false,useSystemFonts:false,standardFontDataUrl:join(dirname(require.resolve('pdfjs-dist/package.json')),'standard_fonts/')});
  try{const pdf=await task.promise;assert.equal(pdf.numPages,2);const page=await pdf.getPage(1),text=await page.getTextContent();assert.ok(text.items.some(item=>'str' in item&&item.str==='Hello Zorid PDF'));
    const viewport=page.getViewport({scale:1}),canvas=createCanvas(viewport.width,viewport.height),context=canvas.getContext('2d');await page.render({canvasContext:context,viewport}).promise;
    assert.deepEqual([...context.getImageData(30,100,1,1).data],[255,0,0,255]);assert.deepEqual([...context.getImageData(150,100,1,1).data],[255,255,255,255]);
    const glyphs=context.getImageData(20,30,150,25).data;let darkPixels=0;for(let i=0;i<glyphs.length;i+=4)if(glyphs[i]<128&&glyphs[i+1]<128&&glyphs[i+2]<128)darkPixels++;assert.ok(darkPixels>30,'the text glyphs, not only vector shapes, paint');
  }finally{await task.destroy();}
});

test('real official viewer components initialize continuous page hosts through the adapter',async t=>{
  const env=new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const before=new Map<string,PropertyDescriptor|undefined>();
  const set=(name:string,value:unknown)=>{before.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});};
  class Observer{observe(){}unobserve(){}disconnect(){}}
  Object.defineProperty(env.window,'ResizeObserver',{value:Observer,configurable:true});
  Object.defineProperty(env.window,'matchMedia',{value:()=>({matches:false,addEventListener(){},removeEventListener(){}}),configurable:true});
  for(const name of ['document','window','navigator','HTMLElement','HTMLCanvasElement','Element','Node','NodeFilter','HTMLAnchorElement','getComputedStyle','AbortController','AbortSignal','requestAnimationFrame','cancelAnimationFrame'] as const){const value=(env.window as unknown as Record<string,unknown>)[name];set(name,typeof value==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?(value as Function).bind(env.window):value);}
  set('ResizeObserver',Observer);set('CSS',{supports:()=>false,escape:(value:string)=>value});
  let release=false;let handle:ReturnType<typeof createPdfView>|undefined;
  t.after(async()=>{handle?.destroy();await ticks();env.window.close();for(const [name,descriptor]of before){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
  const core=await import('pdfjs-dist/legacy/build/pdf.mjs'),components=await import('pdfjs-dist/web/pdf_viewer.mjs');
  const require=createRequire(import.meta.url);
  const engine={core:{...core,getDocument(config:Record<string,unknown>){const {url,...rest}=config;return core.getDocument({...rest,data:samplePdf(),standardFontDataUrl:join(dirname(require.resolve('pdfjs-dist/package.json')),'standard_fonts/'),useSystemFonts:false});}},viewer:components} as unknown as PdfEngine;
  handle=createPdfView(env.window.document.querySelector('main')!,'Example.pdf',{async acquire(){return {url:'blob:pdf-fixture',type:'application/pdf',release(){release=true;}};}},{loadEngine:async()=>engine});
  await handle.ready;
  assert.equal(env.window.document.querySelectorAll('.pdfViewer .page').length,2);
  assert.equal(env.window.document.querySelector<HTMLInputElement>('[aria-label="Page"]')!.value,'1');
  handle.goToPage(2);assert.equal(env.window.document.querySelector<HTMLInputElement>('[aria-label="Page"]')!.value,'2');
  handle.destroy();for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(release,true);
});

test('destroyed viewer rejects retained controls and all public mutations',async t=>{
  const f=fixture(t);f.resolve();await f.view.ready;
  const controls=f.root.querySelector('.zorid-pdf-view')!,zoom=controls.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!,spread=controls.querySelector<HTMLSelectElement>('[aria-label="Page spread"]')!,input=controls.querySelector<HTMLInputElement>('[aria-label="Page"]')!,searchClose=controls.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!;
  f.view.destroy();await ticks();const before={page:f.viewer.currentPageNumber,rotation:f.viewer.pagesRotation,scale:f.viewer.currentScale,scaleValue:f.viewer.currentScaleValue,spread:f.viewer.spreadMode,hashes:f.hashes.length,events:f.events.length};
  f.view.goToPage(2);f.view.rotate(90);f.view.setScale(2);f.view.applySubpath('#page=2');f.view.showSearch();zoom.click();searchClose.click();spread.value='2';spread.dispatchEvent(new f.env.window.Event('change'));input.value='3';input.dispatchEvent(new f.env.window.Event('change'));
  assert.deepEqual({page:f.viewer.currentPageNumber,rotation:f.viewer.pagesRotation,scale:f.viewer.currentScale,scaleValue:f.viewer.currentScaleValue,spread:f.viewer.spreadMode,hashes:f.hashes.length,events:f.events.length},before);
  assert.equal(f.view.getSelectionSubpath(),null);
});

test('destroy resolves ready without waiting for an engine import that cannot cancel',async t=>{
  const {root}=dom(t),engine=deferred<PdfEngine>();let reads=0;
  const view=createPdfView(root,'a.pdf',{async acquire(){reads++;throw new Error('must not acquire');}},{loadEngine:()=>engine.promise});let settled=false;void view.ready.then(()=>{settled=true;});
  view.destroy();await ticks();assert.equal(settled,true);assert.equal(reads,0);engine.reject(new Error('late import failure'));await ticks();assert.equal(root.childElementCount,0);
});

test('destroy resolves ready during acquisition and still releases a late resource',async t=>{
  const {root}=dom(t),lease=deferred<{url:string;type:string;release():void}>();let released=0;
  const view=createPdfView(root,'a.pdf',{acquire:()=>lease.promise},{loadEngine:async()=>({} as PdfEngine)});await ticks();let settled=false;void view.ready.then(()=>{settled=true;});view.destroy();await ticks();assert.equal(settled,true);assert.equal(released,0);
  lease.resolve({url:'blob:late',type:'application/pdf',release(){released++;}});await ticks();assert.equal(released,1);
});

test('destroy resolves ready during a pending document request and consumes its late rejection',async t=>{
  const f=fixture(t);await ticks();let settled=false;void f.view.ready.then(()=>{settled=true;});f.view.destroy();await ticks();assert.equal(settled,true);assert.deepEqual(f.disposed,['task','viewer','lease']);f.loading.reject(new Error('worker was destroyed'));await ticks();
});

test('destroy resolves ready while page labels are pending without updating disposed controls',async t=>{
  const f=fixture(t),labels=deferred<string[]|null>();f.loading.resolve({numPages:3,getPageLabels:()=>labels.promise,async destroy(){}});await ticks();let settled=false;void f.view.ready.then(()=>{settled=true;});f.view.destroy();await ticks();assert.equal(settled,true);const eventCount=f.events.length;labels.resolve(['I','II','III']);await ticks();assert.equal(f.events.length,eventCount);assert.equal(f.root.childElementCount,0);
});
