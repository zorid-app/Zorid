import type {RecoveryHistory,RecoveryVersion,RecoveryCursor} from '../platform/bridge';
import {el,textButton} from './dom.ts';
import {NoteLoadSupervisor} from './note-load-supervisor.ts';

export interface VersionHistoryOptions {
  history:RecoveryHistory;
  entryId:string;
  isCurrent():boolean;
  restore(content:string):Promise<'restored'|'saving'|'save_changes'|'changed'>;
}

/** Optional history browsing is separate from automatic interrupted-save recovery. */
export function openVersionHistory(options:VersionHistoryOptions):{close():void} {
  const previous=document.activeElement as HTMLElement|null;
  const overlay=el('div','modal-overlay'),dialog=el('section','modal version-history');
  dialog.role='dialog';dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Version history');
  const heading=el('h2','','Version history'),message=el('p','version-history-message');
  message.role='status';message.setAttribute('aria-live','polite');
  const list=el('div','version-history-list');list.setAttribute('aria-label','Saved versions');
  const preview=el('textarea','version-history-preview');preview.readOnly=true;preview.setAttribute('aria-label','Version preview');
  const explanation=el('p','','Restoring replaces the current note with this version.');
  let closed=false,reading=false,listing=false,restoring=false,selected:RecoveryVersion|undefined,loaded:string|undefined,cursor:RecoveryCursor|undefined;
  type ReadOwner={controller:AbortController;supervisor:NoteLoadSupervisor};
  let readOwner:ReadOwner|undefined,listOwner:ReadOwner|undefined,stopAvailable=()=>{};
  let pages=0;
  const current=()=>!closed&&options.isCurrent();
  const close=()=>{
    if(closed||restoring)return;
    closed=true;readOwner?.controller.abort();readOwner?.supervisor.stop();listOwner?.controller.abort();listOwner?.supervisor.stop();stopAvailable();observer.disconnect();document.removeEventListener('keydown',keydown,true);overlay.remove();
    if(previous?.isConnected)previous.focus();
  };
  const cancel=textButton('Close',close);
  const restore=textButton('Restore version',()=>{void restoreSelected();},'mod-cta');restore.disabled=true;
  const more=textButton('Show older versions',()=>{void loadPage();});more.hidden=true;
  const actions=el('div','version-history-actions');actions.append(cancel,restore);
  const sidebar=el('div','version-history-sidebar');sidebar.append(list,more);
  dialog.append(heading,message,sidebar,preview,explanation,actions);overlay.append(dialog);
  const buttons:HTMLButtonElement[]=[];
  const controls=()=>{
    for(const button of buttons)button.disabled=restoring;
    more.disabled=listing||restoring;cancel.disabled=restoring;restore.disabled=reading||restoring||loaded===undefined;
    dialog.setAttribute('aria-busy',String(listing||reading||restoring));
  };
  const check=()=>{if(!current()){close();return false;}return true;};
  async function select(version:RecoveryVersion):Promise<void>{
    if(restoring||!check())return;
    readOwner?.controller.abort();readOwner?.supervisor.stop();
    const owner:ReadOwner={controller:new AbortController(),supervisor:new NoteLoadSupervisor()};readOwner=owner;
    version=Object.freeze({...version});selected=version;loaded=undefined;preview.value='';reading=true;message.textContent='';
    controls();
    try{
      const result=await owner.supervisor.run(()=>options.history.read(options.entryId,version.snapshotId),()=>{if(!current()||readOwner!==owner)throw new Error('History preview owner changed');},{signal:owner.controller.signal});
      if(!check())return;
      if(result.version.entryId!==options.entryId||result.version.snapshotId!==version.snapshotId||result.version.byteLength!==version.byteLength||result.version.capturedAtMs!==version.capturedAtMs||result.version.path!==version.path||typeof result.content!=='string')throw new Error('History selection changed');
      loaded=result.content;preview.value=loaded;
    }catch(error){if(readOwner===owner&&!owner.controller.signal.aborted&&check()){console.error('Version preview unavailable',error);message.textContent='This saved version is unavailable.';}}
    finally{owner.supervisor.stop();if(readOwner===owner){readOwner=undefined;reading=false;if(current())controls();}}
  }
  async function loadPage():Promise<void>{
    if(listing||restoring||!check())return;
    const owner:ReadOwner={controller:new AbortController(),supervisor:new NoteLoadSupervisor()};listOwner=owner;
    const request=Object.freeze({limit:20,...(cursor?{before:Object.freeze({...cursor})}:{})});
    listing=true;controls();message.textContent='';
    try{
      const result=await owner.supervisor.run(()=>options.history.list(options.entryId,request),()=>{if(!current()||listOwner!==owner)throw new Error('History page owner changed');},{signal:owner.controller.signal});
      if(!check())return;
      cursor=result.nextCursor;pages++;
      for(const version of result.versions){
        const date=new Date(version.capturedAtMs);
        const button=textButton(Number.isNaN(date.getTime())?'Saved version':date.toLocaleString(),()=>{void select(version);},'version-history-version');
        // IDs are only compared in closures; never expose them in attributes.
        button.setAttribute('aria-pressed','false');
        button.onclick=()=>{for(const other of buttons)other.setAttribute('aria-pressed',String(other===button));void select(version);};
        buttons.push(button);list.append(button);
      }
      more.hidden=!cursor||pages>=50;
      if(!buttons.length)message.textContent='No saved versions are available for this note yet.';
      else if(cursor&&pages>=50)message.textContent='Only the most recent versions are shown.';
    }catch(error){if(listOwner===owner&&!owner.controller.signal.aborted&&check()){console.error('Version history unavailable',error);message.textContent='Version history is unavailable.';}}
    finally{owner.supervisor.stop();if(listOwner===owner){listOwner=undefined;listing=false;if(current())controls();}}
  }
  async function restoreSelected():Promise<void>{
    if(restoring||reading||!selected||loaded===undefined||!check())return;
    restoring=true;controls();message.textContent='';
    try{
      const result=await options.restore(loaded);
      if(!current())return;
      if(result==='restored'||result==='saving'){restoring=false;close();return;}
      message.textContent=result==='save_changes'?'Your current changes were kept. Restoring is unavailable while they are unsaved.':'This note changed. Your current note was kept.';
    }catch(error){if(current()){console.error('Version restoration could not finish',error);message.textContent='This version could not be restored. The note and your changes were kept.';}}
    finally{restoring=false;if(current())controls();else close();}
  }
  const keydown=(event:KeyboardEvent)=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();close();}
    else if(event.key==='Tab'){
      const items=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled):not([hidden]),textarea')];
      const at=items.indexOf(document.activeElement as HTMLElement);
      if(event.shiftKey&&at<=0){event.preventDefault();items.at(-1)?.focus();}
      else if(!event.shiftKey&&(at<0||at===items.length-1)){event.preventDefault();items[0]?.focus();}
    }
  };
  const observer=new MutationObserver(()=>{if(!current()&&!restoring)close();});
  document.body.append(overlay);observer.observe(document.body,{childList:true,subtree:true});
  stopAvailable=options.history.subscribeAvailable?.(()=>{if(!check())return;readOwner?.supervisor.admissionAvailable();listOwner?.supervisor.admissionAvailable();})??(()=>{});
  document.addEventListener('keydown',keydown,true);cancel.focus();void loadPage();
  return{close};
}
