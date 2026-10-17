import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPdfSidebar } from '../src/ui/pdf-sidebar.ts';
import type { PdfSidebarDocument, PdfSidebarOptions, PdfOutlineItem, PdfOutlineContext } from '../src/ui/pdf-sidebar.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function ticks(){for(let i=0;i<40;i++)await Promise.resolve();}
function setup(t:TestContext,configuration:{document?:Partial<PdfSidebarDocument>;options?:Partial<PdfSidebarOptions>}={}){
  const dom=new JSDOM('<!doctype html><body><main></main></body>');t.after(()=>dom.window.close());
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value(){return {canvas:this};}});
  const pages:number[]=[],destinations:(string|unknown[])[]=[],renders:number[]=[],errors:Error[]=[],changes:unknown[]=[];
  const pdf:PdfSidebarDocument={numPages:10000,async getOutline(){return null;},async getPage(number){pages.push(number);return {rotate:0,getViewport({scale,rotation}){return {width:(rotation===90?400:200)*scale,height:(rotation===90?200:400)*scale};},render(){renders.push(number);return {promise:Promise.resolve(),cancel(){}};}};},async getDestination(){return [2,{name:'Fit'}];},async getPageIndex(){return 4;},...configuration.document};
  const sidebar=createPdfSidebar(dom.window.document.querySelector('main')!,pdf,{onPage:page=>pages.push(-page),onDestination:dest=>destinations.push(dest),onError:error=>errors.push(error),onChange:state=>changes.push(state),...configuration.options});t.after(()=>sidebar.destroy());
  return {dom,pdf,sidebar,pages,renders,errors,destinations,changes,doc:dom.window.document};
}
const outline:PdfOutlineItem[]=[{title:'Chapter one',dest:[0,{name:'Fit'}],items:[{title:'Nested section',dest:'section',bold:true,italic:true,items:[]}]},{title:'Chapter two',dest:[5,{name:'Fit'}],items:[]}];

test('sidebar defaults closed and opening a huge PDF renders only a bounded viewport window',async t=>{
  const f=setup(t);await ticks();assert.equal(f.sidebar.element.hidden,true);assert.deepEqual(f.pages,[]);
  f.sidebar.toggle();await ticks();assert.equal(f.sidebar.state.open,true);assert.equal(f.sidebar.state.active,1);assert.ok(f.renders.length>0&&f.renders.length<=12);assert.ok(f.doc.querySelectorAll('canvas').length<=12);assert.ok(f.doc.querySelectorAll('.zorid-pdf-thumbnail').length<=12);
  const firstCanvas=f.doc.querySelector('canvas')!;
  f.sidebar.setPage(9900);await ticks();assert.ok(f.pages.some(page=>page>=9899));assert.ok(f.doc.querySelectorAll('canvas').length<=12);assert.equal(firstCanvas.width,0);assert.equal(firstCanvas.height,0);
  const selected=f.doc.querySelector<HTMLButtonElement>('.zorid-pdf-thumbnail[aria-current=true]')!;assert.equal(selected.dataset.page,'9900');selected.click();assert.equal(f.pages.at(-1),-9900);
  const calls=f.pages.length;f.sidebar.toggle();await ticks();assert.equal(f.sidebar.state.open,false);assert.equal(f.pages.length,calls);
});

test('outline destination navigation, collapsed children, keyboard focus and labels use actual document data',async t=>{
  const f=setup(t,{document:{numPages:8,async getOutline(){return outline;}}});await ticks();assert.equal(f.sidebar.state.hasOutline,true);f.sidebar.switchView(2);await ticks();
  const rows=f.doc.querySelectorAll<HTMLButtonElement>('.zorid-pdf-outline-title'),toggle=f.doc.querySelector<HTMLButtonElement>('.zorid-pdf-outline-toggle')!;
  assert.equal(f.doc.querySelector<HTMLElement>('.zorid-pdf-outline-children')!.hidden,true);assert.match(rows[0].textContent!,/Chapter one1/);
  toggle.click();await ticks();assert.equal(f.doc.querySelector<HTMLElement>('.zorid-pdf-outline-children')!.hidden,false);
  assert.match(rows[1].textContent!,/Nested section3/);rows[1].click();assert.deepEqual(f.destinations,['section']);assert.equal(rows[1].getAttribute('aria-current'),'true');
  rows[1].dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,rows[0]);
  f.sidebar.setPageLabels(['i','ii','iii']);await ticks();assert.match(rows[1].textContent!,/Nested sectioniii/);
  f.sidebar.switchView(0);f.sidebar.toggle();assert.equal(f.sidebar.state.active,2);
});

test('reveal current outline item chooses preceding destination and opens its ancestor chain',async t=>{
  const f=setup(t,{document:{numPages:8,async getOutline(){return outline;}}});await ticks();f.sidebar.switchView(2);f.sidebar.setPage(4);await f.sidebar.revealCurrentOutlineItem();
  assert.match(f.doc.querySelector('.zorid-pdf-outline-title[aria-current=true]')!.textContent!,/Nested section/);
  assert.equal(f.doc.querySelector<HTMLElement>('.zorid-pdf-outline-children')!.hidden,false);
});

test('late outline and page acquisitions cannot attach after destroy',async t=>{
  const pendingOutline=deferred<PdfOutlineItem[]|null>(),pendingPage=deferred<Awaited<ReturnType<PdfSidebarDocument['getPage']>>>();let renders=0;
  const f=setup(t,{document:{getOutline:()=>pendingOutline.promise,getPage:()=>pendingPage.promise}});f.sidebar.toggle();f.sidebar.destroy();pendingOutline.resolve(outline);pendingPage.resolve({getViewport(){return {width:100,height:200};},render(){renders++;return {promise:Promise.resolve(),cancel(){}};}});await ticks();
  assert.equal(f.doc.querySelector('aside'),null);assert.equal(renders,0);assert.equal(f.sidebar.state.hasOutline,false);
});

test('closing during render cancels work and rotation invalidates bounded thumbnail canvases',async t=>{
  const pending=deferred<unknown>();let cancelled=0,rotation=0,slow=true;
  const f=setup(t,{document:{numPages:2,async getPage(){return {getViewport(value){rotation=value.rotation??0;return {width:98,height:196};},render(){return {promise:slow?pending.promise:Promise.resolve(),cancel(){cancelled++;pending.reject(new Error('cancelled'));}};}};}}});
  f.sidebar.toggle();await ticks();f.sidebar.switchView(0);await ticks();assert.equal(cancelled,1);assert.equal(f.errors.length,0);
  slow=false;f.sidebar.toggle();await ticks();const old=f.doc.querySelector('canvas')!;f.sidebar.setRotation(90);await ticks();assert.equal(old.width,0);assert.equal(rotation,90);assert.equal(f.doc.querySelectorAll('canvas').length,2);
});

test('stale outline reveal and retained buttons never navigate a destroyed document',async t=>{
  const destination=deferred<unknown[]|null>();const f=setup(t,{document:{numPages:10,async getOutline(){return [{title:'Named',dest:'chapter'}];},getDestination:()=>destination.promise}});await ticks();f.sidebar.switchView(2);const row=f.doc.querySelector<HTMLButtonElement>('.zorid-pdf-outline-title')!;
  const pending=f.sidebar.revealCurrentOutlineItem();f.sidebar.destroy();destination.resolve([2,{name:'Fit'}]);await pending;row.click();f.sidebar.toggle();assert.equal(f.destinations.length,0);assert.equal(f.doc.querySelector('aside'),null);
});

test('outline context never revives after sidebar hide/reopen or ancestor collapse/re-expand',async t=>{
  let captured:PdfOutlineContext|undefined;
  const f=setup(t,{document:{numPages:8,async getOutline(){return outline;}},options:{onOutlineContextMenu(_event,context){captured=context;}}});await ticks();f.sidebar.switchView(2);await ticks();
  const capture=(row:Element)=>{row.dispatchEvent(new f.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));assert.ok(captured);assert.equal(captured.isCurrent(),true);return captured;};
  const rows=f.doc.querySelectorAll('.zorid-pdf-outline-title'),first=capture(rows[0]);
  f.sidebar.switchView(0);f.sidebar.switchView(2);assert.equal(first.isCurrent(),false);assert.equal(await first.resolveSubpath(),null);
  const toggle=f.doc.querySelector<HTMLButtonElement>('.zorid-pdf-outline-toggle')!;toggle.click();const child=capture(rows[1]);toggle.click();toggle.click();assert.equal(child.isCurrent(),false);assert.equal(await child.resolveSubpath(),null);
});

test('missing outline cannot select an empty view and a failed thumbnail does not retry forever',async t=>{
  const f=setup(t,{document:{numPages:1,async getPage(){throw new Error('bad page');}}});await ticks();f.sidebar.switchView(2);assert.equal(f.sidebar.state.open,false);f.sidebar.toggle();await ticks();assert.equal(f.errors.length,1);f.sidebar.setPage(1);await ticks();assert.equal(f.errors.length,1);
});

test('official PDF.js renders thumbnail pixels and resolves actual outline page references',async t=>{
  const engine=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {createRequire}=await import('node:module'),require=createRequire(import.meta.url),pdfRequire=createRequire(require.resolve('pdfjs-dist/package.json'));
  const {createCanvas}=pdfRequire('@napi-rs/canvas');
  const stream='1 0 0 rg 10 10 80 80 re f';
  const objects=['<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R >>','<< >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>','<< /Title (Actual section) /Parent 6 0 R /Dest [3 0 R /Fit] >>'];
  let source='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(source.length);source+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=source.length;source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const task=engine.getDocument({data:new TextEncoder().encode(source),isEvalSupported:false});const pdf=await task.promise;
  const f=setup(t,{document:{numPages:pdf.numPages,getOutline:()=>pdf.getOutline(),getDestination:name=>pdf.getDestination(name),getPageIndex:ref=>pdf.getPageIndex(ref as never),getPage:page=>pdf.getPage(page) as never}});
  let nativeCanvas:ReturnType<typeof createCanvas>|undefined;
  Object.defineProperty(f.dom.window.HTMLCanvasElement.prototype,'getContext',{value:function(){nativeCanvas=createCanvas(this.width,this.height);return nativeCanvas.getContext('2d');}});
  f.sidebar.toggle();for(let i=0;i<20&&!f.doc.querySelector('canvas');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(f.doc.querySelector('canvas'),'completed thumbnail inserted');assert.deepEqual(Array.from(nativeCanvas!.getContext('2d').getImageData(49,49,1,1).data),[255,0,0,255]);
  await ticks();f.sidebar.switchView(2);await f.sidebar.revealCurrentOutlineItem();assert.match(f.doc.querySelector('.zorid-pdf-outline-title[aria-current=true]')!.textContent!,/Actual section1/);
  f.sidebar.destroy();await task.destroy();
});

test('evicting an in-flight thumbnail cancels quietly and continues rendering the new window',async t=>{
  const pending=deferred<unknown>();let cancelled=0;
  const f=setup(t,{document:{numPages:100,async getPage(number){return {getViewport(){return {width:98,height:196};},render(){return {promise:number===1?pending.promise:Promise.resolve(),cancel(){cancelled++;pending.reject(Object.assign(new Error('Rendering cancelled'),{name:'RenderingCancelledException'}));}};}};}}});
  f.sidebar.toggle();await ticks();f.sidebar.setPage(99);await ticks();
  assert.equal(cancelled,1);assert.deepEqual(f.errors,[]);assert.ok(f.doc.querySelector('.zorid-pdf-thumbnail[data-page="99"] canvas'));
});

test('thumbnail integer raster dimensions stay bounded for extremely tall PDF pages',async t=>{
  const dimensions:number[][]=[];
  const f=setup(t,{document:{numPages:1,async getPage(){return {getViewport({scale}){return {width:scale,height:scale*1e8};},render(options){const context=options.canvasContext as {canvas:HTMLCanvasElement};dimensions.push([context.canvas.width,context.canvas.height]);return {promise:Promise.resolve(),cancel(){}};}};}}});
  f.sidebar.toggle();await ticks();assert.equal(dimensions.length,1);const [width,height]=dimensions[0];assert.ok(width*height<=262144,`${width}×${height}`);assert.ok(width<=4096&&height<=4096);assert.ok(width>=1&&height>=1);
});
