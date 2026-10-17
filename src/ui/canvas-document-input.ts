import {el, modal} from './dom.ts';
import {isImage} from './attachments.ts';
import {mediaKind} from './media-view.ts';
import {fileTreeSelectionRoots, type FileTreeDragRow, type FileTreeEntry} from './file-tree-drag.ts';

/** File types with an owned Canvas renderer; arbitrary vault files are not advertised. */
export function isCanvasDocument(path:string):boolean{return /\.(?:md|pdf)$/i.test(path)||isImage(path)||mediaKind(path)!==null;}

export interface CanvasDocumentInputOptions {
  root:HTMLElement;
  getRows():readonly FileTreeDragRow[];
  getEntries():readonly FileTreeEntry[];
  getSelectedPaths():readonly string[];
  getVaultToken():unknown;
  getEntryToken(path:string):unknown;
  enabled?():boolean;
}

/** A local tree drag is authoritative. Serialized MIME text alone cannot create a session. */
export function createCanvasDocumentInput(options:CanvasDocumentInputOptions){
  const document=options.root.ownerDocument,window=document.defaultView!;
  let destroyed=false,drag:{vault:unknown;files:{path:string;token:unknown}[]}|undefined;
  const pickers=new Set<()=>void>();
  const fileInventory=()=>new Set(options.getEntries().filter(entry=>entry.type==='file').map(entry=>entry.path));
  const current=(path:string,token:unknown,vault:unknown,files:ReadonlySet<string>)=>!destroyed&&vault===options.getVaultToken()&&token!==undefined&&token===options.getEntryToken(path)&&files.has(path)&&isCanvasDocument(path);
  const cancelDrag=()=>{drag=undefined;};
  const start=(event:DragEvent)=>{
    cancelDrag();if(event.defaultPrevented||destroyed||options.enabled?.()===false||!event.dataTransfer)return;
    const target=event.target;if(!(target instanceof window.Node))return;
    const row=options.getRows().find(row=>row.element===target||row.element.contains(target));if(!row)return;
    const selected=options.getSelectedPaths(),entries=options.getEntries(),paths=fileTreeSelectionRoots(selected.includes(row.path)?selected:[row.path],entries);
    const inventory=new Set(entries.filter(entry=>entry.type==='file').map(entry=>entry.path)),files=paths.filter(path=>inventory.has(path)&&isCanvasDocument(path)).map(path=>({path,token:options.getEntryToken(path)}));
    if(files.length){drag={vault:options.getVaultToken(),files};event.dataTransfer.effectAllowed='copyMove';}
  };
  const drop=()=>{queueMicrotask(cancelDrag);};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')cancelDrag();};
  // Install on the same tree root AFTER its move controller. That controller
  // stops propagation, so a parent/bubble listener would miss native drags.
  options.root.addEventListener('dragstart',start,true);
  document.addEventListener('dragend',cancelDrag,true);document.addEventListener('drop',drop,true);document.addEventListener('keydown',key,true);window.addEventListener('blur',cancelDrag);
  const filePathsFromDrop=(_transfer:DataTransfer):readonly string[]=>{
    const session=drag;if(!session||destroyed||session.vault!==options.getVaultToken())return[];
    const inventory=fileInventory();return session.files.filter(file=>current(file.path,file.token,session.vault,inventory)).map(file=>file.path);
  };
  const chooseFile=(isCurrent:()=>boolean=()=>true,kind?:'note'|'media'):Promise<string|null>=>{
    if(destroyed||!isCurrent())return Promise.resolve(null);
    const vault=options.getVaultToken();
    const entries=options.getEntries().filter(entry=>entry.type==='file'&&isCanvasDocument(entry.path)&&(kind===undefined||(kind==='note')===/\.md$/i.test(entry.path))).map(entry=>({path:entry.path,token:options.getEntryToken(entry.path)}));
    return new Promise(resolve=>{
      const {content,close}=modal(kind==='note'?'Add note from vault':kind==='media'?'Add media from vault':'Add document to Canvas');content.classList.add('command-modal');
      const input=el('input','command-input');input.placeholder='Type a file name…';input.setAttribute('aria-label','Choose a document');input.setAttribute('role','combobox');input.setAttribute('aria-expanded','true');input.setAttribute('aria-autocomplete','list');
      const list=el('div','suggestion-list');list.id=`canvas-documents-${crypto.randomUUID()}`;list.setAttribute('role','listbox');input.setAttribute('aria-controls',list.id);
      let settled=false,index=0,shown=entries;
      const finish=(path:string|null)=>{if(settled)return;settled=true;observer.disconnect();pickers.delete(cancel);close();resolve(path);};
      const cancel=()=>finish(null);
      const observer=new MutationObserver(()=>{if(!content.isConnected)finish(null);});observer.observe(document.body,{childList:true});pickers.add(cancel);
      const select=(entry:typeof entries[number])=>finish(isCurrent()&&current(entry.path,entry.token,vault,fileInventory())?entry.path:null);
      const render=()=>{
        shown=entries.filter(entry=>entry.path.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).slice(0,80);index=Math.max(0,Math.min(index,shown.length-1));list.replaceChildren();
        shown.forEach((entry,i)=>{const row=el('div',`suggestion-item${i===index?' is-selected':''}`,entry.path);row.id=`${list.id}-${i}`;row.setAttribute('role','option');row.setAttribute('aria-selected',String(i===index));row.addEventListener('pointermove',()=>{if(index!==i){index=i;render();}});row.addEventListener('click',()=>select(entry));list.append(row);});
        if(shown.length)input.setAttribute('aria-activedescendant',`${list.id}-${index}`);else{input.removeAttribute('aria-activedescendant');list.append(el('div','suggestion-empty','No matching documents'));}
      };
      input.addEventListener('input',()=>{index=0;render();});input.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();index=shown.length?(index+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length:0;render();}else if(event.key==='Enter'){event.preventDefault();if(shown[index])select(shown[index]);}});
      content.append(input,list);render();input.focus();
    });
  };
  return{chooseFile,filePathsFromDrop,destroy(){if(destroyed)return;destroyed=true;cancelDrag();for(const cancel of [...pickers])cancel();options.root.removeEventListener('dragstart',start,true);document.removeEventListener('dragend',cancelDrag,true);document.removeEventListener('drop',drop,true);document.removeEventListener('keydown',key,true);window.removeEventListener('blur',cancelDrag);}};
}
