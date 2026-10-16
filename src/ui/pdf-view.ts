import type { AttachmentLease, AttachmentResources } from './attachments.ts';

/** Small boundary around the public PDF.js components; no recovered viewer code. */
type EventData = { pageNumber?:number; pageLabel?:string; pagesCount?:number; source?:unknown; pageIndex?:number; matchesCount?:{current:number;total:number}; state?:number; error?:unknown };
interface Bus { on(name:string,callback:(event:EventData)=>void):void; off(name:string,callback:(event:EventData)=>void):void; dispatch(name:string,event:Record<string,unknown>):void }
interface PdfDocument { numPages:number; getPageLabels():Promise<string[]|null>; destroy():Promise<void> }
interface LoadingTask { promise:Promise<PdfDocument>; destroy():Promise<void>; onPassword?:((update:(password:string)=>void,reason:number)=>void)|null }
interface PageView { div:HTMLElement; viewport?:{height:number}; textLayer?:{highlighter?:{textDivs:Node[];textContentItemsStr:string[]}} }
interface Viewer {
  currentPageNumber:number; currentScaleValue:string; currentScale:number; pagesRotation:number; spreadMode:number;
  setDocument(doc:PdfDocument|null):void; setPageLabels(labels:string[]|null):void; update():void;
  nextPage():boolean; previousPage():boolean; getPageView(index:number):PageView|undefined;
  scrollPageIntoView(options:{pageNumber:number;destArray?:unknown[];allowNegativeOffset?:boolean}):void;
  firstPagePromise?:Promise<unknown>|null; pagesPromise?:Promise<unknown>|null; cleanup():void;
  increaseScale():void; decreaseScale():void; updateScale(options:{steps?:number;scaleFactor?:number;origin?:[number,number];drawingDelay?:number}):void;
}
interface LinkService { setViewer(viewer:Viewer):void; setDocument(doc:PdfDocument|null):void; setHash(hash:string):void; goToPage(page:string|number):void }
export interface PdfEngine {
  core:{ version?:string; GlobalWorkerOptions:{workerSrc:string}; getDocument(options:Record<string,unknown>):LoadingTask };
  viewer:{ EventBus:new()=>Bus; PDFLinkService:new(options:Record<string,unknown>)=>LinkService; PDFFindController:new(options:Record<string,unknown>)=>unknown; PDFViewer:new(options:Record<string,unknown>)=>Viewer };
}
export interface PdfViewOptions {
  embed?:boolean; height?:number|'page'|'auto'; subpath?:string; mobile?:boolean;
  /** Directory containing the official pdfjs-dist build/, web/, cmaps/, etc. */
  assetBase?:string;
  loadEngine?:(document:Document,assetBase:string)=>Promise<PdfEngine>;
  onError?:(error:Error)=>void;
  onPageChange?:(page:number)=>void;
}
export interface PdfView {
  /** Resolves after document/pages initialization or immediately on destroy; not a canvas-render guarantee. */
  ready:Promise<void>;
  destroy():void;
  goToPage(page:number|string):void;
  setScale(scale:number|'page-width'|'page-height'):void;
  rotate(degrees:number):void;
  showSearch():void;
  applySubpath(subpath:string):void;
  getSelectionSubpath():string|null;
}
export interface PdfLocation { destination:string|unknown[]; page?:number; selection?:[number,number,number,number]; annotation?:string; height?:number }
const integer=(value:string|null|undefined):number|null=>{const result=Number.parseInt(value??'');return Number.isNaN(result)?null:result;};
export function parsePdfSubpath(subpath:string):PdfLocation {
  const raw=subpath.replace(/^#/,''),params=new URLSearchParams(raw);
  if(!params.has('page'))return {destination:raw};
  const page=integer(params.get('page'))??1,offset=(params.get('offset')??'').split(','),[left,top,zoom]=offset.map(integer);
  const result:PdfLocation={page,destination:zoom==null?[page-1,{name:'FitBH'},top??null]:[page-1,{name:'XYZ'},left??null,top??null,zoom]};
  if(params.has('annotation'))result.annotation=params.get('annotation')!;
  else if(params.has('selection')){const values=params.get('selection')!.split(',').slice(0,4).map(integer);if(values.length===4&&values.every(value=>value!==null))result.selection=values as [number,number,number,number];}
  const height=integer(params.get('height'));if(height!==null)result.height=height;
  return result;
}

const engineLoads=new Map<string,Promise<PdfEngine>>();
/** Imports only separately acquired, licensed upstream assets shipped with the app. */
export function loadPdfEngine(doc:Document,base:string):Promise<PdfEngine>{
  const assetBase=new URL(base,doc.baseURI).href;
  const cssUrl=new URL('web/pdf_viewer.css',assetBase).href;
  if(!Array.from(doc.querySelectorAll<HTMLLinkElement>('link[data-zorid-pdf-css]')).some(link=>link.href===cssUrl)){
    const css=doc.createElement('link');css.rel='stylesheet';css.href=cssUrl;css.dataset.zoridPdfCss='true';doc.head.append(css);
  }
  let pending=engineLoads.get(assetBase);
  if(!pending){
    pending=(async()=>{
      const core=await import(/* webpackIgnore: true */ new URL('build/pdf.mjs',assetBase).href) as PdfEngine['core'];
      core.GlobalWorkerOptions.workerSrc=new URL('build/pdf.worker.mjs',assetBase).href;
      const viewer=await import(/* webpackIgnore: true */ new URL('web/pdf_viewer.mjs',assetBase).href) as PdfEngine['viewer'];
      return {core,viewer};
    })();engineLoads.set(assetBase,pending);void pending.catch(()=>engineLoads.delete(assetBase));
  }
  return pending;
}

/** Continuous PDF.js page/text/annotation rendering shared by file tabs and embeds. */
export function createPdfView(parent:HTMLElement,path:string,resources:Pick<AttachmentResources,'acquire'>,configuration:PdfViewOptions={}):PdfView{
  const options={...configuration};
  const doc=parent.ownerDocument,win=doc.defaultView!;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text=''):HTMLElementTagNameMap[K]=>{const e=doc.createElement(tag);e.className=cls;e.textContent=text;return e;};
  const root=node('div','zorid-pdf-view'),toolbar=node('div','zorid-pdf-toolbar'),stage=node('div','zorid-pdf-stage'),scroller=node('div','zorid-pdf-scroll'),pages=node('div','pdfViewer');
  root.classList.toggle('is-embed',!!options.embed);root.setAttribute('aria-label',path.split('/').at(-1)??path);root.tabIndex=-1;
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','PDF controls');scroller.tabIndex=0;scroller.style.position='absolute';scroller.append(pages);stage.append(scroller);root.append(toolbar,stage);parent.append(root);
  let closed=false,lease:AttachmentLease|undefined,task:LoadingTask|undefined,pdf:PdfDocument|undefined,viewer:Viewer|undefined,links:LinkService|undefined,bus:Bus|undefined;
  let loaded=false,labels:string[]|null=null,pendingSubpath=options.subpath??'',highlight:PdfLocation|undefined,searchTimer:ReturnType<typeof setTimeout>|undefined;
  let cancelReady!:()=>void;const cancelled=new Promise<void>(resolve=>{cancelReady=resolve;});
  const abort=new AbortController(),handlers:[string,(event:EventData)=>void][]=[];
  const status=node('div','zorid-pdf-status','Loading PDF…');status.setAttribute('role','status');stage.append(status);
  const button=(label:string,text:string,action:()=>void)=>{const b=node('button','zorid-pdf-button',text);b.type='button';b.title=label;b.setAttribute('aria-label',label);b.addEventListener('click',()=>{if(!closed)action();});return b;};
  const zoomOut=button('Zoom out','−',()=>{viewer?.decreaseScale();updateScale();}),zoomIn=button('Zoom in','+',()=>{viewer?.increaseScale();updateScale();});
  const scale=node('select','zorid-pdf-scale');scale.setAttribute('aria-label','Zoom');
  for(const [value,label] of [['page-width','Fit width'],['page-height','Fit height']]){const option=node('option','',label);option.value=value;scale.append(option);}
  scale.onchange=()=>setScale(scale.value as 'page-width'|'page-height');
  const spread=node('select','zorid-pdf-spread');spread.setAttribute('aria-label','Page spread');
  for(const [value,label] of [['0','Single page'],['1','Odd pages'],['2','Even pages']]){const option=node('option','',label);option.value=value;spread.append(option);}
  spread.onchange=()=>{if(!closed&&viewer)viewer.spreadMode=Number(spread.value);};
  const pageInput=node('input','zorid-pdf-page-input');pageInput.type='number';pageInput.min='1';pageInput.value='1';pageInput.setAttribute('aria-label','Page');pageInput.onclick=()=>{if(!closed)pageInput.select();};pageInput.onchange=()=>goToPage(pageInput.value);
  const pageCount=node('span','zorid-pdf-page-count');
  toolbar.append(zoomOut,zoomIn,scale,spread,pageInput,pageCount,button('Find in PDF','Find',()=>showSearch()));
  const find=node('div','zorid-pdf-find');find.hidden=true;
  const query=node('input','zorid-pdf-query');query.type='search';query.placeholder='Search PDF';query.setAttribute('aria-label','Search PDF');
  const matchCount=node('span','zorid-pdf-match-count');matchCount.setAttribute('aria-live','polite');
  const searchSettings={caseSensitive:false,entireWord:false,matchDiacritics:false,highlightAll:false};
  find.append(query,button('Previous match','↑',()=>search(true)),button('Next match','↓',()=>search(false)),matchCount);
  for(const [key,label] of [['caseSensitive','Match case'],['entireWord','Whole words'],['matchDiacritics','Match diacritics'],['highlightAll','Highlight all']] as const){
    const wrapper=node('label','zorid-pdf-find-option'),input=node('input');input.type='checkbox';input.onchange=()=>{if(closed)return;searchSettings[key]=input.checked;search(undefined);};wrapper.append(input,doc.createTextNode(label));find.append(wrapper);
  }
  find.append(button('Close search','×',closeSearch));root.insertBefore(find,stage);
  query.oninput=()=>{if(closed)return;clearTimeout(searchTimer);searchTimer=setTimeout(()=>search(undefined),250);};
  query.onkeydown=event=>{if(closed)return;if(event.key==='Enter'&&!event.isComposing){event.preventDefault();event.stopPropagation();clearTimeout(searchTimer);search(event.shiftKey);}};
  const password=node('form','zorid-pdf-password'),passwordLabel=node('label','', 'This PDF requires a password.'),passwordInput=node('input');passwordInput.type='password';passwordInput.autocomplete='current-password';passwordInput.setAttribute('aria-label','PDF password');
  const submit=node('button','','Open');submit.type='submit';password.append(passwordLabel,passwordInput,submit);password.hidden=true;stage.append(password);
  let passwordCallback:((value:string)=>void)|undefined;
  password.onsubmit=event=>{event.preventDefault();if(closed)return;if(passwordInput.value&&passwordCallback){const callback=passwordCallback;passwordCallback=undefined;password.hidden=true;callback(passwordInput.value);passwordInput.value='';}};
  const on=(name:string,callback:(event:EventData)=>void)=>{bus!.on(name,callback);handlers.push([name,callback]);};
  const report=(cause:unknown)=>{if(closed)return;const error=cause instanceof Error?cause:new Error(String(cause));status.textContent=`Unable to display PDF: ${error.message}`;status.hidden=false;options.onError?.(error);};
  function updatePage():void{
    if(!viewer||!pdf)return;const current=viewer.currentPageNumber;
    pageInput.type=labels?'text':'number';pageInput.value=labels?.[current-1]??String(current);pageInput.max=String(pdf.numPages);pageCount.textContent=labels?`(${current} of ${pdf.numPages})`:`of ${pdf.numPages}`;
    options.onPageChange?.(current);updateHeight();
  }
  function updateHeight():void{
    if(!options.embed)return;const height=options.height??'page';
    if(typeof height==='number'&&height>0)stage.style.height=`${height}px`;
    else if(height==='page'){const pixels=viewer?.getPageView((viewer.currentPageNumber??1)-1)?.viewport?.height;if(pixels)stage.style.height=`${pixels}px`;}
  }
  function setScale(value:number|'page-width'|'page-height'):void{
    if(closed||!viewer||!loaded)return;viewer.currentScaleValue=typeof value==='number'?String(Math.max(.1,Math.min(10,value))):value;viewer.update();updateScale();updateHeight();
  }
  function updateScale():void{
    if(!viewer)return;scale.querySelector('[data-custom]')?.remove();const value=viewer.currentScaleValue;
    if(value!=='page-width'&&value!=='page-height'){const option=node('option','',`${Math.round(viewer.currentScale*100)}%`);option.value=value;option.dataset.custom='true';scale.append(option);}scale.value=value;
    zoomOut.disabled=viewer.currentScale<=.1;zoomIn.disabled=viewer.currentScale>=10;
  }
  function goToPage(value:number|string):void{
    if(closed||!links||!viewer||!pdf||!loaded)return;
    if(typeof value==='number'){if(!Number.isFinite(value))return;value=Math.max(1,Math.min(pdf.numPages,Math.trunc(value)));}
    links.goToPage(value);updatePage();
  }
  function clearHighlight():void{
    highlight=undefined;const css=(win as unknown as {CSS?:{highlights?:Map<string,unknown>}}).CSS;css?.highlights?.delete(highlightId);
    root.querySelectorAll('.zorid-pdf-annotation-focus').forEach(element=>element.classList.remove('zorid-pdf-annotation-focus'));
  }
  const highlightId=`zorid-pdf-${++nextViewId}`;
  const highlightStyle=node('style');highlightStyle.textContent=`::highlight(${highlightId}) { background: rgba(125,95,225,.3); }`;root.append(highlightStyle);
  function applyHighlight():void{
    if(!highlight?.page||!viewer)return;const page=viewer.getPageView(highlight.page-1);if(!page)return;
    if(highlight.annotation){const target=Array.from(page.div.querySelectorAll<HTMLElement>('[data-annotation-id]')).find(item=>item.dataset.annotationId===highlight!.annotation);target?.classList.add('zorid-pdf-annotation-focus');return;}
    const mapping=page.textLayer?.highlighter?.textDivs,selection=highlight.selection;if(!mapping||!selection)return;
    const start=textPoint(mapping[selection[0]],selection[1]),end=textPoint(mapping[selection[2]],selection[3]);if(!start||!end)return;
    const range=doc.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);
    const api=win as unknown as {Highlight?:new(...ranges:Range[])=>unknown;CSS?:{highlights?:Map<string,unknown>}};
    if(api.Highlight&&api.CSS?.highlights)api.CSS.highlights.set(highlightId,new api.Highlight(range));
  }
  function applySubpath(value:string):void{
    if(closed)return;pendingSubpath=value;if(!loaded||!links||!viewer)return;clearHighlight();if(!value)return;
    const location=parsePdfSubpath(value);highlight=location;
    if(location.page&&(location.page<1||location.page>(pdf?.numPages??0)))return;
    if(options.embed&&location.height&&location.height>0){options.height=location.height;updateHeight();}
    links.setHash(typeof location.destination==='string'?location.destination:JSON.stringify(location.destination));applyHighlight();
  }
  function search(previous:boolean|undefined):void{
    if(closed||!bus||!loaded)return;clearHighlight();bus.dispatch('find',{source:root,type:previous===undefined?'':'again',query:query.value,findPrevious:!!previous,...searchSettings});
  }
  function showSearch():void{
    if(closed)return;const focused=doc.activeElement===query;if(!find.hidden&&focused){closeSearch();return;}find.hidden=false;query.focus();query.select();bus?.dispatch('findbaropen',{source:root});
  }
  function closeSearch():void{if(closed)return;clearTimeout(searchTimer);find.hidden=true;bus?.dispatch('findbarclose',{source:root});if(doc.activeElement===query)scroller.focus();}
  function getSelectionSubpath():string|null{
    if(closed)return null;const selection=doc.getSelection();if(!selection?.rangeCount||selection.isCollapsed||!viewer)return null;const range=selection.getRangeAt(0);
    const element=range.startContainer.nodeType===1?range.startContainer as Element:range.startContainer.parentElement;
    const pageElement=element?.closest<HTMLElement>('.page[data-page-number]');if(!pageElement||!root.contains(pageElement)||!pageElement.contains(range.endContainer))return null;
    const page=Number(pageElement.dataset.pageNumber),mapping=viewer.getPageView(page-1)?.textLayer?.highlighter?.textDivs;if(!mapping)return null;
    const start=selectionPoint(mapping,range.startContainer,range.startOffset),end=selectionPoint(mapping,range.endContainer,range.endOffset);
    return start&&end?`#page=${page}&selection=${start[0]},${start[1]},${end[0]},${end[1]}`:null;
  }
  let controlHeld=false,wheelTicks=0,suppressWheelUntil=0;
  const wheel=(event:WheelEvent)=>{
    if(!event.ctrlKey&&!event.metaKey){suppressWheelUntil=Date.now()+1000;return;}
    event.preventDefault();event.stopPropagation();
    if(!viewer||!loaded||Date.now()<suppressWheelUntil||!password.hidden||doc.visibilityState==='hidden')return;
    const factor=Math.exp(-event.deltaY/100),origin:[number,number]=[event.clientX,event.clientY];
    if(event.ctrlKey&&!controlHeld&&event.deltaMode===0&&event.deltaX===0&&event.deltaZ===0&&Math.abs(factor-1)<.05){viewer.updateScale({scaleFactor:factor,origin,drawingDelay:400});}
    else {const delta=-event.deltaY/(event.deltaMode===0?30:1);if(wheelTicks&&Math.sign(wheelTicks)!==Math.sign(delta))wheelTicks=0;wheelTicks+=delta;const steps=Math.trunc(wheelTicks);wheelTicks-=steps;if(steps)viewer.updateScale({steps:Math.max(-100,Math.min(100,steps)),origin,drawingDelay:400});}
    updateScale();
  };scroller.addEventListener('wheel',wheel,{passive:false});
  const keyup=(event:KeyboardEvent)=>{if(event.key==='Control')controlHeld=false;};root.addEventListener('keyup',keyup);
  const key=(event:KeyboardEvent)=>{
    if(event.key==='Control')controlHeld=true;
    if(event.isComposing||event.defaultPrevented)return;
    if(event.key==='Escape'){clearHighlight();if(!find.hidden){event.preventDefault();event.stopPropagation();closeSearch();}return;}
    const mod=event.ctrlKey||event.metaKey;
    if(!find.hidden&&((event.key==='F3'&&!mod&&!event.altKey)||(mod&&event.key.toLowerCase()==='g'&&!event.altKey))){event.preventDefault();event.stopPropagation();search(event.shiftKey);return;}
    const target=event.target as HTMLElement;
    if(!options.embed&&!mod&&!event.altKey&&!event.shiftKey&&!target.closest('input,textarea,select,[contenteditable="true"]')&&viewer&&['page-width','page-height'].includes(viewer.currentScaleValue)&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
      event.preventDefault();event.stopPropagation();event.key==='ArrowLeft'?viewer.previousPage():viewer.nextPage();updatePage();
    }
  };root.addEventListener('keydown',key);
  const resized=()=>{if(!closed&&viewer&&loaded){if(['page-width','page-height'].includes(viewer.currentScaleValue))viewer.currentScaleValue=viewer.currentScaleValue;viewer.update();updateHeight();}};
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(resized):undefined;resize?.observe(stage);
  function destroy():void{
    if(closed)return;closed=true;cancelReady();clearTimeout(searchTimer);clearHighlight();abort.abort();resize?.disconnect();for(const [name,handler]of handlers)bus?.off(name,handler);
    root.removeEventListener('keydown',key);root.removeEventListener('keyup',keyup);scroller.removeEventListener('wheel',wheel);passwordCallback=undefined;root.remove();void release();
  }
  let releasing:Promise<void>|undefined;
  function release():Promise<void>{
    if(releasing)return releasing;
    const currentTask=task,currentLease=lease;task=undefined;lease=undefined;
    // Keep page views until the worker's in-flight page requests stop. PDF.js 5.3.31's
    // eager page callbacks still index them; clearing first races those callbacks.
    releasing=(async()=>{try{await currentTask?.destroy();}catch{/* A failed load may already have disposed its worker. */}finally{viewer?.setDocument(null);links?.setDocument(null);currentLease?.release();}})();return releasing;
  }
  const operation=(async()=>{
    try{
      const assetBase=new URL(options.assetBase??'./lib/pdfjs/',doc.baseURI).href;
      const engine=await (options.loadEngine??loadPdfEngine)(doc,assetBase);if(closed)return;
      const acquired=await resources.acquire(path);if(closed){acquired.release();return;}lease=acquired;
      bus=new engine.viewer.EventBus();links=new engine.viewer.PDFLinkService({eventBus:bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
      const findController=new engine.viewer.PDFFindController({eventBus:bus,linkService:links});
      viewer=new engine.viewer.PDFViewer({container:scroller,viewer:pages,eventBus:bus,linkService:links,findController,textLayerMode:1,annotationMode:2,annotationEditorMode:-1,removePageBorders:!!options.embed||!!options.mobile,enableScripting:false,maxCanvasPixels:options.mobile?5242880:16777216,abortSignal:abort.signal,imageResourcesPath:new URL('web/images/',assetBase).href});
      links.setViewer(viewer);
      on('pagechanging',updatePage);on('scalechanging',()=>{updateScale();updateHeight();});on('textlayerrendered',applyHighlight);on('annotationlayerrendered',applyHighlight);on('pagerendered',event=>{if(event.error){report(event.error);return;}status.hidden=true;updateHeight();});
      on('updatefindmatchescount',event=>{const count=event.matchesCount;matchCount.textContent=count?.total?`${count.current} of ${count.total>1000?'1000+':count.total}`:'';});
      on('updatefindcontrolstate',event=>{query.setAttribute('aria-invalid',String(event.state===1));if(event.matchesCount)matchCount.textContent=`${event.matchesCount.current} of ${event.matchesCount.total}`;});
      const initialPages=new Promise<void>(resolve=>on('pagesinit',()=>{if(closed)return;loaded=true;viewer!.currentScaleValue='page-width';updatePage();updateScale();applySubpath(pendingSubpath);resolve();}));
      task=engine.core.getDocument({url:lease.url,ownerDocument:doc,cMapUrl:new URL('cmaps/',assetBase).href,cMapPacked:true,standardFontDataUrl:new URL('standard_fonts/',assetBase).href,wasmUrl:new URL('wasm/',assetBase).href,iccUrl:new URL('iccs/',assetBase).href,isEvalSupported:false,enableXfa:true});
      task.onPassword=(update,reason)=>{if(closed)return;passwordCallback=update;passwordLabel.textContent=reason===2?'Incorrect password. Try again.':'This PDF requires a password.';password.hidden=false;passwordInput.focus();};
      pdf=await task.promise;if(closed)return;links.setDocument(pdf);viewer.setDocument(pdf);
      await Promise.race([viewer.firstPagePromise??Promise.resolve(),cancelled]);if(closed)return;
      labels=await pdf.getPageLabels();if(closed)return;viewer.setPageLabels(labels);updatePage();await Promise.race([initialPages,cancelled]);
    }catch(error){if(!closed){report(error);abort.abort();await release();throw error;}}
  })();
  // Waiting callers are released on close even when an import or resource provider
  // cannot cancel its promise. The operation still handles and releases late results.
  const ready=Promise.race([operation,cancelled]);void ready.catch(()=>{});
  return {ready,destroy,goToPage,setScale,showSearch,applySubpath,getSelectionSubpath,rotate(degrees){if(!closed&&loaded&&viewer&&Number.isFinite(degrees)&&degrees%90===0){viewer.pagesRotation=((viewer.pagesRotation+degrees)%360+360)%360;updateHeight();}}};
}
let nextViewId=0;
function textPoint(root:Node|undefined,offset:number):{node:Node;offset:number}|null{
  if(!root||offset<0||!Number.isSafeInteger(offset))return null;
  const walker=root.ownerDocument!.createTreeWalker(root,4);let remaining=offset;
  if(root.nodeType===3)return offset<=(root.textContent?.length??0)?{node:root,offset}:null;
  for(let node=walker.nextNode();node;node=walker.nextNode()){const length=node.textContent?.length??0;if(remaining<=length)return {node,offset:remaining};remaining-=length;}return null;
}
function selectionPoint(mapping:Node[],node:Node,offset:number):[number,number]|null{
  const index=mapping.findIndex(item=>item===node||item.contains(node));if(index<0)return null;
  try{const range=node.ownerDocument!.createRange();range.selectNodeContents(mapping[index]);range.setEnd(node,offset);return [index,range.toString().length];}catch{return null;}
}
