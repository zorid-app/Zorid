/** Original sidebar built against public PDF.js document/page APIs. */
export interface PdfOutlineItem { title:string; dest?:string|unknown[]|null; bold?:boolean; italic?:boolean; items?:PdfOutlineItem[] }
export interface PdfThumbnailTask { promise:Promise<unknown>; cancel():void }
export interface PdfSidebarPage { rotate?:number; getViewport(options:{scale:number;rotation?:number}):{width:number;height:number}; render(options:Record<string,unknown>):PdfThumbnailTask }
export interface PdfSidebarDocument {
  numPages:number; getOutline():Promise<PdfOutlineItem[]|null>; getPage(number:number):Promise<PdfSidebarPage>;
  getDestination(name:string):Promise<unknown[]|null>; getPageIndex(ref:unknown):Promise<number>;
  cachedPageNumber?(ref:unknown):number|null;
}
export interface PdfSidebarState { open:boolean; active:0|1|2; hasOutline:boolean }
export interface PdfSidebarOptions {
  onPage:(page:number)=>void; onDestination:(destination:string|unknown[])=>void;
  onChange?:(state:PdfSidebarState)=>void; onError?:(error:Error)=>void;
}
export interface PdfSidebar {
  readonly state:PdfSidebarState; readonly element:HTMLElement;
  toggle():void; switchView(view:0|1|2):void; revealCurrentOutlineItem():Promise<void>;
  setPage(page:number):void; setPageLabels(labels:string[]|null):void; setRotation(degrees:number):void; destroy():void;
}
interface OutlineRow { item:PdfOutlineItem; parent?:OutlineRow; row:HTMLButtonElement; toggle:HTMLButtonElement; group:HTMLElement; expanded:boolean; page?:Promise<number|null> }
interface ThumbnailCell { page:number; element:HTMLButtonElement; canvas?:HTMLCanvasElement; failed?:boolean }
const THUMB_WIDTH=98,WINDOW_LIMIT=12;
export function createPdfSidebar(parent:HTMLElement,pdf:PdfSidebarDocument,options:PdfSidebarOptions):PdfSidebar {
  const doc=parent.ownerDocument,win=doc.defaultView!;
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,cls:string)=>{const node=doc.createElement(tag);node.className=cls;return node;};
  const element=make('aside','zorid-pdf-sidebar'),thumbs=make('div','zorid-pdf-thumbnails'),outline=make('div','zorid-pdf-outline');
  element.hidden=true;element.setAttribute('aria-label','PDF sidebar');thumbs.setAttribute('aria-label','Thumbnails');outline.setAttribute('role','tree');outline.setAttribute('aria-label','Table of contents');element.append(thumbs,outline);parent.append(element);
  const top=make('div','zorid-pdf-thumbnail-spacer'),bottom=make('div','zorid-pdf-thumbnail-spacer');thumbs.append(top,bottom);
  let closed=false,open=false,active:0|1|2=1,hasOutline=false,page=1,labels:string[]|null=null,rotation=0,generation=0,rendering=false,task:PdfThumbnailTask|undefined,pendingCell:ThumbnailCell|undefined;
  let rows:OutlineRow[]=[],selected:OutlineRow|undefined;
  const cells=new Map<number,ThumbnailCell>(),heights=new Float64Array(pdf.numPages).fill(150),offsets=new Float64Array(pdf.numPages+1);
  const state=():PdfSidebarState=>({open,active,hasOutline});
  const error=(cause:unknown)=>{if(!closed)options.onError?.(cause instanceof Error?cause:new Error(String(cause)));};
  function measure(){offsets[0]=0;for(let i=0;i<heights.length;i++)offsets[i+1]=offsets[i]+heights[i];}
  measure();
  function pageAt(y:number){let low=0,high=pdf.numPages;while(low<high){const mid=(low+high)>>>1;if(offsets[mid+1]<=y)low=mid+1;else high=mid;}return Math.min(pdf.numPages-1,low);}
  function discard(cell:ThumbnailCell){if(pendingCell===cell)task?.cancel();cell.element.remove();if(cell.canvas){cell.canvas.width=0;cell.canvas.height=0;}cells.delete(cell.page);}
  function cancel(){generation++;task?.cancel();task=undefined;}
  function notify(){if(closed)return;element.hidden=!open;element.dataset.view=String(active);thumbs.hidden=active!==1;outline.hidden=active!==2;options.onChange?.(state());}
  function updateWindow(){
    if(closed||!open||active!==1)return;
    const first=Math.max(0,pageAt(thumbs.scrollTop)-1),last=Math.min(pdf.numPages,Math.min(first+WINDOW_LIMIT,pageAt(thumbs.scrollTop+(thumbs.clientHeight||600))+3));
    for(const [number,cell]of cells)if(number<=first||number>last)discard(cell);
    top.style.height=`${offsets[first]}px`;bottom.style.height=`${offsets[pdf.numPages]-offsets[last]}px`;
    for(let index=first;index<last;index++){
      const number=index+1;let cell=cells.get(number);
      if(!cell){const button=make('button','zorid-pdf-thumbnail');button.type='button';button.dataset.page=String(number);button.onclick=()=>{if(!closed)options.onPage(number);};cell={page:number,element:button};cells.set(number,cell);}
      cell.element.style.height=`${heights[index]-4}px`;cell.element.dataset.pageLabel=labels?.[index]??String(number);cell.element.setAttribute('aria-label',`Page ${labels?.[index]??number}`);cell.element.setAttribute('aria-current',String(number===page));thumbs.insertBefore(cell.element,bottom);
    }
    void paint();
  }
  async function paint(){
    if(rendering||closed||!open||active!==1)return;rendering=true;const version=generation;
    try{
      while(!closed&&open&&active===1&&generation===version){
        const cell=Array.from(cells.values()).find(cell=>!cell.canvas&&!cell.failed);if(!cell)break;
        let canvas:HTMLCanvasElement|undefined;
        try{
          pendingCell=cell;const pdfPage=await pdf.getPage(cell.page);if(closed||generation!==version)break;if(cells.get(cell.page)!==cell)continue;
          const angle=((pdfPage.rotate??0)+rotation)%360,unit=pdfPage.getViewport({scale:1,rotation:angle});
          const scale=THUMB_WIDTH/unit.width,viewport=pdfPage.getViewport({scale,rotation:angle});
          if(!(viewport.width>0&&viewport.height>0&&Number.isFinite(viewport.height)))throw new Error('Invalid PDF thumbnail size');
          canvas=make('canvas','zorid-pdf-thumbnail-canvas');const displayHeight=Math.max(1,Math.floor(viewport.height)),factor=Math.min(2,win.devicePixelRatio||1,Math.sqrt(262144/(viewport.width*displayHeight)),4096/viewport.width,4096/displayHeight);
          canvas.width=Math.max(1,Math.floor(viewport.width*factor));canvas.height=Math.max(1,Math.floor(displayHeight*factor));canvas.style.width=`${viewport.width}px`;canvas.style.height=`${displayHeight}px`;canvas.setAttribute('aria-hidden','true');
          const context=canvas.getContext('2d');if(!context)throw new Error('PDF thumbnail canvas unavailable');
          task=pdfPage.render({canvasContext:context,viewport,transform:factor===1?undefined:[factor,0,0,factor,0,0]});await task.promise;task=undefined;
          if(closed||generation!==version||cells.get(cell.page)!==cell){canvas.width=canvas.height=0;continue;}
          cell.canvas=canvas;cell.element.append(canvas);cell.element.dataset.loaded='true';const anchor=pageAt(thumbs.scrollTop),anchorOffset=offsets[anchor];heights[cell.page-1]=displayHeight+20;measure();thumbs.scrollTop+=offsets[anchor]-anchorOffset;updateWindow();
        }catch(cause){if(canvas)canvas.width=canvas.height=0;task=undefined;if(closed||generation!==version)break;if(cells.get(cell.page)!==cell)continue;cell.failed=true;cell.element.setAttribute('aria-label',`${cell.element.getAttribute('aria-label')} (preview unavailable)`);error(cause);}finally{pendingCell=undefined;}
      }
    }finally{rendering=false;if(!closed&&generation!==version)queueMicrotask(()=>{void paint();});}
  }
  function setPage(value:number){if(closed||!Number.isInteger(value)||value<1||value>pdf.numPages)return;page=value;if(open&&active===1){const start=offsets[page-1],end=offsets[page];if(start<thumbs.scrollTop||end>thumbs.scrollTop+(thumbs.clientHeight||600))thumbs.scrollTop=start;updateWindow();}}
  function switchView(view:0|1|2){if(closed||view===2&&!hasOutline)return;if(view===0){open=false;cancel();}else{if(active!==view)cancel();active=view;open=true;}notify();if(open&&active===1)setPage(page);else if(open)void labelVisibleRows();}
  const scroll=()=>updateWindow();thumbs.addEventListener('scroll',scroll,{passive:true});
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(updateWindow):undefined;resize?.observe(thumbs);
  function expanded(row:OutlineRow,value:boolean){row.expanded=value;row.group.hidden=!value;row.toggle.setAttribute('aria-expanded',String(value));row.toggle.textContent=value?'⌄':'›';if(value)void labelVisibleRows();}
  function visible(row:OutlineRow){for(let parent=row.parent;parent;parent=parent.parent)if(!parent.expanded)return false;return true;}
  function resolvePage(row:OutlineRow):Promise<number|null>{
    return row.page??=(async()=>{try{const destination=typeof row.item.dest==='string'?await pdf.getDestination(row.item.dest):row.item.dest;if(closed||!Array.isArray(destination))return null;const ref=destination[0];const number=Number.isInteger(ref)?Number(ref)+1:ref&&typeof ref==='object'?(pdf.cachedPageNumber?.(ref)??(await pdf.getPageIndex(ref))+1):null;return !closed&&number&&number>=1&&number<=pdf.numPages?number:null;}catch(cause){error(cause);return null;}})();
  }
  let labeling=false,labelsDirty=false;
  async function labelVisibleRows(){if(closed||!open||active!==2)return;if(labeling){labelsDirty=true;return;}labeling=true;labelsDirty=false;try{for(const row of rows){if(closed||!open||active!==2)break;if(!visible(row))continue;const number=await resolvePage(row);if(closed)break;if(number){let flair=row.row.querySelector<HTMLElement>('.zorid-pdf-outline-page');if(!flair){flair=make('span','zorid-pdf-outline-page');row.row.append(flair);}flair.textContent=labels?.[number-1]??String(number);}}}finally{labeling=false;if(labelsDirty)queueMicrotask(()=>{void labelVisibleRows();});}}
  function select(row:OutlineRow){selected?.row.removeAttribute('aria-current');selected=row;row.row.setAttribute('aria-current','true');}
  function build(items:PdfOutlineItem[]){
    const queue=items.map(item=>({item,parent:undefined as OutlineRow|undefined,host:outline,depth:1})).reverse();
    while(queue.length){const {item,parent,host,depth}=queue.pop()!;const container=make('div','zorid-pdf-outline-item'),line=make('div','zorid-pdf-outline-line'),button=make('button','zorid-pdf-outline-title'),toggle=make('button','zorid-pdf-outline-toggle'),group=make('div','zorid-pdf-outline-children');button.type=toggle.type='button';button.textContent=item.title.replace(/\0/g,'');button.setAttribute('role','treeitem');button.setAttribute('aria-level',String(depth));if(item.bold)button.style.fontWeight='bold';if(item.italic)button.style.fontStyle='italic';group.setAttribute('role','group');group.hidden=true;
      const row:OutlineRow={item,parent,row:button,toggle,group,expanded:false};rows.push(row);toggle.textContent='›';toggle.setAttribute('aria-label',`Toggle ${button.textContent}`);toggle.setAttribute('aria-expanded','false');toggle.hidden=!item.items?.length;toggle.onclick=()=>{if(!closed)expanded(row,!row.expanded);};button.onclick=()=>{if(closed)return;if(item.dest){select(row);options.onDestination(item.dest);}else if(item.items?.length)expanded(row,!row.expanded);};
      button.onkeydown=event=>{if(closed)return;const list=rows.filter(visible),index=list.indexOf(row);let target:OutlineRow|undefined;if(event.key==='ArrowDown')target=list[index+1];else if(event.key==='ArrowUp')target=list[index-1];else if(event.key==='Home')target=list[0];else if(event.key==='End')target=list.at(-1);else if(event.key==='ArrowRight'&&item.items?.length){if(!row.expanded)expanded(row,true);else target=rows.find(entry=>entry.parent===row);}else if(event.key==='ArrowLeft'){if(row.expanded)expanded(row,false);else target=row.parent;}else return;event.preventDefault();event.stopPropagation();target?.row.focus();};
      line.append(toggle,button);container.append(line,group);host.append(container);for(let i=(item.items?.length??0)-1;i>=0;i--)queue.push({item:item.items![i],parent:row,host:group,depth:depth+1});
    }
  }
  void pdf.getOutline().then(items=>{if(closed)return;hasOutline=!!items?.length;if(items)build(items);notify();}).catch(error);
  async function revealCurrentOutlineItem(){
    if(closed||!hasOutline)return;const snapshot=page;let best:OutlineRow|undefined,bestPage=0;
    for(const row of rows){const number=await resolvePage(row);if(closed||!open||active!==2)return;if(number&&number<=snapshot&&number>=bestPage){best=row;bestPage=number;}}
    if(!best||page!==snapshot)return;select(best);for(let parent=best.parent;parent;parent=parent.parent)expanded(parent,true);best.row.scrollIntoView?.({block:'start'});
  }
  return {get state(){return state();},element,toggle(){if(!closed)switchView(open?0:active||1);},switchView,revealCurrentOutlineItem,setPage,setPageLabels(value){if(closed)return;labels=value;updateWindow();void labelVisibleRows();},setRotation(value){if(closed||!Number.isFinite(value)||value%90!==0)return;rotation=((value%360)+360)%360;cancel();for(const cell of Array.from(cells.values()))discard(cell);updateWindow();},destroy(){if(closed)return;closed=true;cancel();resize?.disconnect();thumbs.removeEventListener('scroll',scroll);for(const cell of Array.from(cells.values()))discard(cell);rows=[];element.remove();}};
}
