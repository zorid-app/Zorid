import { showContextMenu, dismissContextMenu } from '../platform/context-menu.ts';
import { createPdfSidebar, type PdfSidebar, type PdfSidebarDocument } from './pdf-sidebar.ts';
import { createPdfDisplayMenu, createPdfSidebarMenu } from './pdf-menus.ts';
import type { AttachmentLease, AttachmentResources } from './attachments.ts';

/** Small boundary around the public PDF.js components; no recovered viewer code. */
type EventData = { pageNumber?:number; pageLabel?:string; pagesCount?:number; source?:unknown; pageIndex?:number; matchesCount?:{current:number;total:number}; state?:number; error?:unknown };
interface Bus { on(name:string,callback:(event:EventData)=>void):void; off(name:string,callback:(event:EventData)=>void):void; dispatch(name:string,event:Record<string,unknown>):void }
interface PdfDocument extends PdfSidebarDocument { numPages:number; getPageLabels():Promise<string[]|null>; destroy():Promise<void> }
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
interface LinkService { setViewer(viewer:Viewer):void; setDocument(doc:PdfDocument|null):void; setHash(hash:string):void; goToPage(page:string|number):void; goToDestination(destination:string|unknown[]):void }
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
  /** Host file/link actions shown at the right of an embedded viewer. */
  onOpenMenu?:(event:MouseEvent)=>void;
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
  const root=node('div','zorid-pdf-view interactive-child'),toolbar=node('div','zorid-pdf-toolbar'),stage=node('div','zorid-pdf-stage'),scroller=node('div','zorid-pdf-scroll'),pages=node('div','pdfViewer');
  root.classList.toggle('is-embed',!!options.embed);root.classList.toggle('is-mobile',!!options.mobile);root.setAttribute('aria-label',path.split('/').at(-1)??path);root.tabIndex=-1;
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','PDF controls');scroller.tabIndex=0;scroller.style.position='absolute';scroller.append(pages);stage.append(scroller);root.append(toolbar,stage);parent.append(root);
  let closed=false,lease:AttachmentLease|undefined,task:LoadingTask|undefined,pdf:PdfDocument|undefined,viewer:Viewer|undefined,links:LinkService|undefined,bus:Bus|undefined;
  let sidebar:PdfSidebar|undefined;
  let loaded=false,labels:string[]|null=null,pendingSubpath=options.subpath??'',highlight:PdfLocation|undefined,searchTimer:ReturnType<typeof setTimeout>|undefined;
  let cancelReady!:()=>void;const cancelled=new Promise<void>(resolve=>{cancelReady=resolve;});
  const abort=new AbortController(),handlers:[string,(event:EventData)=>void][]=[];
  const status=node('div','zorid-pdf-status','Loading PDF…');status.setAttribute('role','status');stage.append(status);
  const icons:Record<string,string>={minus:'M5 12h14',plus:'M5 12h14M12 5v14',chevron:'m6 9 6 6 6-6',more:'M12 5h.01M12 12h.01M12 19h.01',up:'m6 14 6-6 6 6',down:'m6 10 6 6 6-6',close:'m6 6 12 12M6 18 18 6',settings:'M4 7h16M4 17h16M8 4v6M16 14v6',sidebar:'M3 3h18v18H3zM9 3v18M13 7h4M13 12h4M13 17h4'};
  const button=(label:string,glyph:string,action:(event:MouseEvent)=>void)=>{const b=node('button','zorid-pdf-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',icons[glyph]??glyph);svg.append(path);b.append(svg);b.addEventListener('click',event=>{if(!closed)action(event);});return b;};
  const zoomOut=button('Zoom out','minus',()=>{viewer?.decreaseScale();updateScale();}),zoomIn=button('Zoom in','plus',()=>{viewer?.increaseScale();updateScale();});
  const sidebarToggle=button('Toggle sidebar','sidebar',()=>sidebar?.toggle()),sidebarOptions=button('Sidebar options','chevron',()=>{void openSidebarMenu();});sidebarToggle.setAttribute('aria-expanded','false');sidebarOptions.setAttribute('aria-haspopup','menu');
  let sidebarMenu:ReturnType<typeof createPdfSidebarMenu>|undefined;
  async function openSidebarMenu(){
    if(closed||!sidebar)return;sidebarMenu?.dispose();const current=sidebar;
    const session=createPdfSidebarMenu(current.state,{switchSidebar:value=>current.switchView(value),revealCurrentOutlineItem:()=>current.revealCurrentOutlineItem(),isCurrent:()=>!closed&&sidebar===current&&sidebarMenu===session});sidebarMenu=session;const rect=sidebarOptions.getBoundingClientRect();
    try{await session.run(await showContextMenu({clientX:rect.left,clientY:rect.bottom,target:sidebarOptions,view:win},session.items,{document:doc}));}catch(cause){if(!closed)options.onError?.(cause instanceof Error?cause:new Error(String(cause)));}finally{session.dispose();if(sidebarMenu===session)sidebarMenu=undefined;}
  }
  let menuSession:ReturnType<typeof createPdfDisplayMenu>|undefined;
  const display=button('Display options','chevron',()=>{void openDisplayMenu();});display.setAttribute('aria-haspopup','menu');
  async function openDisplayMenu():Promise<void>{
    if(closed||!loaded||!viewer)return;
    menuSession?.dispose();const active=viewer;
    const session=createPdfDisplayMenu({scale:active.currentScaleValue,spread:active.spreadMode as 0|1|2},{setScale,setSpread:value=>{if(!closed&&viewer===active){active.spreadMode=value;updateHeight();}},isCurrent:()=>!closed&&viewer===active&&menuSession===session});menuSession=session;
    const rect=display.getBoundingClientRect();display.setAttribute('aria-expanded','true');
    try{const choice=await showContextMenu({clientX:rect.left,clientY:rect.bottom,target:display,view:win},session.items,{document:doc});await session.run(choice);}
    catch(error){if(!closed)options.onError?.(error instanceof Error?error:new Error(String(error)));}
    finally{session.dispose();if(menuSession===session){menuSession=undefined;display.setAttribute('aria-expanded','false');}}
  }
  const pageInput=node('input','zorid-pdf-page-input');pageInput.type='number';pageInput.min='1';pageInput.value='1';pageInput.setAttribute('aria-label','Page');pageInput.onclick=()=>{if(!closed)pageInput.select();};pageInput.onchange=()=>goToPage(pageInput.value);
  const pageCount=node('span','zorid-pdf-page-count'),left=node('div','zorid-pdf-toolbar-group'),right=node('div','zorid-pdf-toolbar-group');
  left.append(sidebarToggle,sidebarOptions,node('span','zorid-pdf-spacer'),zoomOut,node('span','zorid-pdf-divider'),zoomIn,display,node('span','zorid-pdf-spacer'),pageInput,pageCount);toolbar.append(left,right);
  if(options.onOpenMenu){const more=button('More options','more',event=>options.onOpenMenu?.(event));more.setAttribute('aria-haspopup','menu');right.append(node('span','zorid-pdf-spacer'),more);}
  const find=node('div','zorid-pdf-find');find.hidden=true;
  const query=node('input','zorid-pdf-query');query.type='search';query.placeholder='Search PDF';query.setAttribute('aria-label','Search PDF');
  const matchCount=node('span','zorid-pdf-match-count');matchCount.setAttribute('aria-live','polite');
  const searchSettings={caseSensitive:false,entireWord:false,matchDiacritics:false,highlightAll:false};
  const preferences=node('div','zorid-pdf-find-preferences');preferences.hidden=true;
  const preferencesButton=button('Search options','settings',()=>{preferences.hidden=!preferences.hidden;preferencesButton.setAttribute('aria-expanded',String(!preferences.hidden));});preferencesButton.setAttribute('aria-expanded','false');
  const matchCase=button('Match case','',()=>{searchSettings.caseSensitive=!searchSettings.caseSensitive;matchCase.setAttribute('aria-pressed',String(searchSettings.caseSensitive));search(undefined);});matchCase.replaceChildren(doc.createTextNode('Aa'));matchCase.setAttribute('aria-pressed','false');
  find.append(query,matchCase,button('Previous match','up',()=>search(true)),button('Next match','down',()=>search(false)),matchCount,preferencesButton,node('span','zorid-pdf-divider'));
  for(const [key,label] of [['entireWord','Whole words'],['matchDiacritics','Match diacritics'],['highlightAll','Highlight all']] as const){
    const wrapper=node('label','zorid-pdf-find-option'),input=node('input');input.type='checkbox';input.setAttribute('aria-label',label);input.onchange=()=>{if(closed)return;searchSettings[key]=input.checked;search(undefined);};wrapper.append(input,doc.createTextNode(label));preferences.append(wrapper);
  }
  find.append(button('Close search','close',closeSearch),preferences);stage.prepend(find);
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
    options.onPageChange?.(current);sidebar?.setPage(current);updateHeight();
  }
  function updateHeight():void{
    if(!options.embed)return;const height=options.height??'page';
    if(typeof height==='number'&&height>0){stage.style.height=`${height}px`;root.classList.add('has-page-height');}
    else if(height==='page'){const pixels=viewer?.getPageView((viewer.currentPageNumber??1)-1)?.viewport?.height;if(pixels){stage.style.height=`${pixels}px`;root.classList.add('has-page-height');}}
  }
  function setScale(value:number|'page-width'|'page-height'):void{
    if(closed||!viewer||!loaded)return;viewer.currentScaleValue=typeof value==='number'?String(Math.max(.1,Math.min(10,value))):value;viewer.update();updateScale();updateHeight();
  }
  function updateScale():void{
    if(!viewer)return;display.title=`Display options (${Math.round(viewer.currentScale*100)}%)`;
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
    if(closed)return;const focused=doc.activeElement===query;if(!find.hidden&&focused){closeSearch();return;}find.hidden=false;updateFindHeight();query.focus();query.select();bus?.dispatch('findbaropen',{source:root});
  }
  function closeSearch():void{if(closed)return;clearTimeout(searchTimer);find.hidden=true;preferences.hidden=true;preferencesButton.setAttribute('aria-expanded','false');updateFindHeight();bus?.dispatch('findbarclose',{source:root});if(doc.activeElement===query)scroller.focus();}
  function updateFindHeight():void{const top=find.hidden?'0':`${find.offsetHeight}px`;scroller.style.top=top;if(sidebar)sidebar.element.style.top=top;}
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
  const resized=()=>{updateFindHeight();if(!closed&&viewer&&loaded){if(['page-width','page-height'].includes(viewer.currentScaleValue))viewer.currentScaleValue=viewer.currentScaleValue;viewer.update();updateHeight();}};
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(resized):undefined;resize?.observe(stage);
  function destroy():void{
    if(closed)return;closed=true;sidebar?.destroy();if(sidebarMenu){sidebarMenu.dispose();sidebarMenu=undefined;void dismissContextMenu(doc);}if(menuSession){menuSession.dispose();menuSession=undefined;void dismissContextMenu(doc);}cancelReady();clearTimeout(searchTimer);clearHighlight();abort.abort();resize?.disconnect();for(const [name,handler]of handlers)bus?.off(name,handler);
    root.removeEventListener('keydown',key);root.removeEventListener('keyup',keyup);scroller.removeEventListener('wheel',wheel);passwordCallback=undefined;root.remove();void release();
  }
  let releasing:Promise<void>|undefined;
  function release():Promise<void>{
    if(releasing)return releasing;
    sidebar?.destroy();
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
      if(!acquired.arrayBuffer)throw new Error('Attachment provider does not expose PDF bytes');
      // File-origin Electron blob URLs cannot reliably be fetched by PDF.js. Pass
      // owned bytes directly; the lease returns a fresh transferable buffer.
      const data=new Uint8Array(await acquired.arrayBuffer());if(closed)return;
      bus=new engine.viewer.EventBus();links=new engine.viewer.PDFLinkService({eventBus:bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
      const findController=new engine.viewer.PDFFindController({eventBus:bus,linkService:links});
      viewer=new engine.viewer.PDFViewer({container:scroller,viewer:pages,eventBus:bus,linkService:links,findController,textLayerMode:1,annotationMode:2,annotationEditorMode:-1,removePageBorders:!!options.embed||!!options.mobile,enableScripting:false,maxCanvasPixels:options.mobile?5242880:16777216,abortSignal:abort.signal,imageResourcesPath:new URL('web/images/',assetBase).href});
      links.setViewer(viewer);
      on('pagechanging',updatePage);on('scalechanging',()=>{updateScale();updateHeight();});on('textlayerrendered',applyHighlight);on('annotationlayerrendered',applyHighlight);on('pagerendered',event=>{if(event.error){report(event.error);return;}status.hidden=true;updateHeight();});
      on('updatefindmatchescount',event=>{const count=event.matchesCount;matchCount.textContent=count?.total?`${count.current} of ${count.total>1000?'1000+':count.total}`:'';});
      on('updatefindcontrolstate',event=>{query.setAttribute('aria-invalid',String(event.state===1));if(event.matchesCount)matchCount.textContent=`${event.matchesCount.current} of ${event.matchesCount.total}`;});
      const initialPages=new Promise<void>(resolve=>on('pagesinit',()=>{if(closed)return;loaded=true;viewer!.currentScaleValue='page-width';updatePage();updateScale();applySubpath(pendingSubpath);resolve();}));
      task=engine.core.getDocument({data,ownerDocument:doc,cMapUrl:new URL('cmaps/',assetBase).href,cMapPacked:true,standardFontDataUrl:new URL('standard_fonts/',assetBase).href,wasmUrl:new URL('wasm/',assetBase).href,iccUrl:new URL('iccs/',assetBase).href,isEvalSupported:false,enableXfa:true});
      task.onPassword=(update,reason)=>{if(closed)return;passwordCallback=update;passwordLabel.textContent=reason===2?'Incorrect password. Try again.':'This PDF requires a password.';password.hidden=false;passwordInput.focus();};
      pdf=await task.promise;if(closed)return;links.setDocument(pdf);viewer.setDocument(pdf);
      sidebar=createPdfSidebar(stage,pdf,{onPage:goToPage,onDestination:destination=>{if(!closed)links?.goToDestination(destination);},onError:options.onError,onChange:state=>{if(closed)return;sidebarToggle.setAttribute('aria-expanded',String(state.open));scroller.style.insetInlineStart=state.open&&!options.embed&&!options.mobile?'140px':'0';resized();}});
      await Promise.race([viewer.firstPagePromise??Promise.resolve(),cancelled]);if(closed)return;
      labels=await pdf.getPageLabels();if(closed)return;viewer.setPageLabels(labels);sidebar?.setPageLabels(labels);updatePage();await Promise.race([initialPages,cancelled]);
    }catch(error){if(!closed){report(error);abort.abort();await release();throw error;}}
  })();
  // Waiting callers are released on close even when an import or resource provider
  // cannot cancel its promise. The operation still handles and releases late results.
  const ready=Promise.race([operation,cancelled]);void ready.catch(()=>{});
  return {ready,destroy,goToPage,setScale,showSearch,applySubpath,getSelectionSubpath,rotate(degrees){if(!closed&&loaded&&viewer&&Number.isFinite(degrees)&&degrees%90===0){viewer.pagesRotation=((viewer.pagesRotation+degrees)%360+360)%360;sidebar?.setRotation(viewer.pagesRotation);updateHeight();}}};
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
