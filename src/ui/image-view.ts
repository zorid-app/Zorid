import type { AttachmentLease, AttachmentResources } from './attachments.ts';
import { button, el } from './dom.ts';

export interface ImageSource { alt:string; load:()=>Promise<AttachmentLease> }
export interface ImageView { destroy():void }

/** Standalone file view; gallery gestures belong to the shared lightbox. */
export function createImageView(parent:HTMLElement,path:string,resources:AttachmentResources):ImageView{
  const container=el('div','image-container'),img=el('img');img.alt=path.split('/').at(-1)!;img.draggable=false;
  container.append(img);parent.append(container);
  let closed=false,lease:AttachmentLease|undefined,lightbox:ImageView|undefined;
  const load=()=>resources.acquire(path);
  void load().then(result=>{if(closed){result.release();return;}lease=result;img.src=result.url;})
    .catch(error=>{if(!closed)container.append(el('p','error-message',error instanceof Error?error.message:String(error)));});
  img.onerror=()=>{if(!closed&&!container.querySelector('.error-message'))container.append(el('p','error-message','Unable to display this image.'));};
  img.onclick=()=>{lightbox?.destroy();lightbox=openImageLightbox([{alt:img.alt,load}]);};
  return {destroy(){closed=true;lightbox?.destroy();lease?.release();img.removeAttribute('src');container.remove();}};
}

/** Original interaction implementation guided by static reference handlers; native/touch parity is unverified. */
export function openImageLightbox(sources:readonly ImageSource[],initial=0):ImageView{
  if(!sources.length)return {destroy(){}};
  const previous=document.activeElement as HTMLElement|null;
  const overlay=el('div','image-lightbox');overlay.role='dialog';overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Image viewer');overlay.tabIndex=-1;
  const stage=el('div','image-lightbox-stage'),img=el('img','image-lightbox-image'),status=el('span','image-lightbox-status');
  img.draggable=false;stage.append(img);overlay.append(stage,status,button('close','Close image viewer',()=>destroy(),'image-lightbox-close'));document.body.append(overlay);
  let index=((initial%sources.length)+sources.length)%sources.length,zoom=1,x=0,y=0,lease:AttachmentLease|undefined;
  let closed=false,version=0,spaceHeld=false,drag:{id:number;clientX:number;clientY:number;x:number;y:number}|undefined;
  const clamp=(value:number,limit:number)=>Math.max(-limit,Math.min(limit,value));
  const size=()=>{
    const width=img.naturalWidth||img.width||1,height=img.naturalHeight||img.height||1;
    const scale=Math.min(1,(stage.clientWidth||width)/width,(stage.clientHeight||height)/height);
    return {width:width*scale,height:height*scale};
  };
  const draw=()=>{
    const bounds=size();
    x=clamp(x,Math.max(0,(bounds.width*zoom-stage.clientWidth)/2));y=clamp(y,Math.max(0,(bounds.height*zoom-stage.clientHeight)/2));
    img.style.transform=`translate(${x}px, ${y}px) scale(${zoom})`;img.style.cursor=zoom>1?'grab':'zoom-in';
    status.textContent=`${index+1} / ${sources.length} · ${Math.round(zoom*100)}%`;
  };
  const setZoom=(value:number,anchorX=0,anchorY=0)=>{
    const next=Math.max(1,Math.min(10,value)),ratio=next/zoom;
    x=anchorX-(anchorX-x)*ratio;y=anchorY-(anchorY-y)*ratio;zoom=next;
    if(zoom===1){x=0;y=0;}draw();
  };
  const point=(event:MouseEvent)=>{const rect=stage.getBoundingClientRect();return {x:event.clientX-rect.left-rect.width/2,y:event.clientY-rect.top-rect.height/2};};
  const show=async()=>{
    const attempt=++version;zoom=1;x=0;y=0;draw();img.alt=sources[index].alt;
    overlay.querySelector('.image-lightbox-error')?.remove();
    try{
      const result=await sources[index].load();
      if(closed||attempt!==version){result.release();return;}
      const old=lease;lease=result;img.src=result.url;old?.release();
    }catch(error){if(!closed&&attempt===version)overlay.append(el('p','image-lightbox-error',error instanceof Error?error.message:String(error)));}
  };
  const key=(event:KeyboardEvent)=>{
    if(!overlay.contains(event.target as Node)&&event.target!==document.body)return;
    // The modal owns keyboard focus; workspace note shortcuts must not run behind it.
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();destroy();}
    else if(event.key==='='){event.preventDefault();setZoom(Math.ceil(Math.round(zoom*1.2*100)/100*10)/10);}
    else if(event.key==='-'){event.preventDefault();setZoom(Math.floor(Math.round(zoom/1.2*100)/100*10)/10);}
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();index=(index+(event.key==='ArrowRight'?1:sources.length-1))%sources.length;void show();}
    else if(event.key==='Tab'){event.preventDefault();overlay.querySelector<HTMLButtonElement>('button')?.focus();}
    else if(event.key===' '){event.preventDefault();spaceHeld=true;}
  };
  const keyup=(event:KeyboardEvent)=>{if(event.key===' '&&spaceHeld&&overlay.contains(event.target as Node)){event.preventDefault();event.stopPropagation();destroy();}};
  stage.addEventListener('wheel',event=>{
    event.preventDefault();const multiplier=event.deltaMode===1?40:event.deltaMode===2?800:1;
    if(event.ctrlKey||event.metaKey){const anchor=point(event);const fractionalMac=/Mac/.test(document.defaultView?.navigator.platform??'')&&!Number.isInteger(event.deltaY)?2:1;setZoom(zoom-event.deltaY*multiplier*fractionalMac/150,anchor.x,anchor.y);}
    else if(zoom>1){x-=event.deltaX*multiplier*1.5;y-=event.deltaY*multiplier*1.5;draw();}
  },{passive:false});
  img.ondblclick=event=>{event.preventDefault();const anchor=point(event);setZoom(zoom>1?1:2.5,anchor.x,anchor.y);};
  img.onpointerdown=event=>{if(event.button!==0||zoom<=1)return;event.preventDefault();drag={id:event.pointerId,clientX:event.clientX,clientY:event.clientY,x,y};img.setPointerCapture?.(event.pointerId);};
  img.onpointermove=event=>{if(!drag||event.pointerId!==drag.id)return;x=drag.x+event.clientX-drag.clientX;y=drag.y+event.clientY-drag.clientY;draw();};
  const endDrag=()=>{drag=undefined;};img.onpointerup=endDrag;img.onpointercancel=endDrag;img.onlostpointercapture=endDrag;
  img.onload=draw;img.onerror=()=>{if(!closed&&!overlay.querySelector('.image-lightbox-error'))overlay.append(el('p','image-lightbox-error','Unable to display this image.'));};
  stage.onclick=event=>{if(event.target===stage)destroy();};
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(draw):undefined;observer?.observe(stage);
  function destroy():void{
    if(closed)return;closed=true;version++;document.removeEventListener('keydown',key,true);document.removeEventListener('keyup',keyup,true);observer?.disconnect();lease?.release();img.removeAttribute('src');overlay.remove();if(previous?.isConnected)previous.focus();
  }
  document.addEventListener('keydown',key,true);document.addEventListener('keyup',keyup,true);overlay.focus();void show();
  return {destroy};
}
