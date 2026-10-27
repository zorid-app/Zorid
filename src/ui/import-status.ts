import type { DesktopReconciliation } from '../platform/bridge';
import { el,icon,modal,textButton } from './dom.ts';

export interface ImportStatusOptions {
  status:DesktopReconciliation|null;
  /** Count from the visible authority, never the scanner's imported counter. */
  entryCount:number;
  /** Usable vaults keep background check warnings out of the editing area. */
  statusHost?:HTMLElement;
  retry():Promise<void>;
}
export interface ImportStatusView {
  readonly element:HTMLElement;
  update(status:DesktopReconciliation|null,entryCount:number):void;
  destroy():void;
}

// Bound consecutive stalled retries, rather than total pages in a large vault.
// Only monotonic progress within one scan replenishes this budget.
const retryDelays=[1_000,3_000,10_000,30_000] as const;

/** Recover transient interruptions quietly. Only a settled, unresolved episode
 * needs attention; a pending empty view must never masquerade as an empty vault. */
export function mountImportStatus(host:HTMLElement,options:ImportStatusOptions):ImportStatusView {
  let status=options.status,entryCount=options.entryCount,busy=false,destroyed=false,attempts=0;
  let timer:ReturnType<typeof setTimeout>|null=null;
  let progress=status?{scanId:status.scanId,observed:status.observed,scanComplete:status.scanComplete,entryCount}:null;
  const observeProgress=(next:DesktopReconciliation|null,count:number)=>{
    if(!next){progress=null;return false;}
    if(!progress||next.scanId!==progress.scanId){
      progress={scanId:next.scanId,observed:next.observed,scanComplete:next.scanComplete,entryCount:count};
      return false;
    }
    // Discovery can finish before the durable namespace is fully admitted.
    // Count only a new inventory high water mark within this same scan; the
    // report's imported counter is per-call and duplicate reports can repeat it.
    const advanced=next.observed>progress.observed||(!progress.scanComplete&&next.scanComplete)||count>progress.entryCount;
    // Remember high-water marks, so regressing/duplicate notifications cannot
    // manufacture progress. A new scan establishes a baseline, never progress.
    progress.observed=Math.max(progress.observed,next.observed);
    progress.scanComplete ||= next.scanComplete;
    progress.entryCount=Math.max(progress.entryCount,count);
    return advanced;
  };
  const element=el('section','import-status');element.setAttribute('aria-label','Notes availability');
  const row=el('div','import-status-row'),copy=el('div','import-status-copy');
  const heading=el('strong','import-status-heading'),message=el('p','import-status-message');
  message.role='status';message.setAttribute('aria-live','polite');
  copy.append(heading,message);
  const startRetry=()=>{
    if(busy||destroyed)return;
    closeDetails();cancelTimer();attempts=0;void runRetry();
  };
  const retry=textButton('Try again',startRetry,'import-status-retry');
  let detailsModal:ReturnType<typeof modal>|undefined;
  const closeDetails=()=>{detailsModal?.close();detailsModal=undefined;};
  const explanation=()=>status?.failure
    ?'Zorid couldn’t check this folder. Make sure it’s available, then try again.'
    :status?.issues.some(issue=>issue.code==='reconciliation_blocked')
      ?'Some file changes couldn’t be verified. Zorid kept the existing saved versions instead of guessing which changes to accept.'
      :'Zorid couldn’t check every file. You can keep working with the notes that are available.';
  const details=textButton('Folder needs attention',()=>{
    if(detailsModal?.content.isConnected)return;
    detailsModal=modal('Folder needs attention');
    detailsModal.content.append(el('h2','','Folder needs attention'),el('p','',explanation()));
    const actions=el('div','modal-buttons');
    const again=textButton('Try again',startRetry);
    actions.append(textButton('Done',closeDetails),again);detailsModal.content.append(actions);again.focus();
  },'import-status-details');
  details.prepend(icon('circle-alert',13));details.setAttribute('aria-haspopup','dialog');
  row.append(copy,retry);element.append(row,details);host.append(element);

  const complete=()=>!!status?.complete&&!status.failure;
  const cancelTimer=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  const refresh=()=>{
    if(destroyed)return;
    const needsAttention=!complete()&&!busy&&attempts===retryDelays.length&&timer===null;
    const compact=entryCount>0;
    const parent=compact&&options.statusHost?options.statusHost:host;
    if(element.parentElement!==parent)parent.append(element);
    element.hidden=complete()||(!needsAttention&&entryCount>0);
    element.classList.toggle('mod-compact',compact);
    row.hidden=compact;details.hidden=!compact||!needsAttention;
    if(complete())closeDetails();
    element.dataset.state=needsAttention?'incomplete':'checking';
    element.setAttribute('aria-busy',String(!complete()&&!needsAttention));
    retry.hidden=!needsAttention;retry.disabled=busy;
    heading.textContent=needsAttention?'Some notes aren’t available yet':'Opening your notes…';
    message.textContent=needsAttention
      ?'Zorid couldn’t finish opening all your notes. Check that the folder is available, then try again.'
      :'Your notes will appear here as they become available.';
  };
  const schedule=()=>{
    if(destroyed||complete()||busy||timer!==null||attempts===retryDelays.length)return;
    timer=setTimeout(()=>{timer=null;attempts++;void runRetry();},retryDelays[attempts]);
  };
  async function runRetry():Promise<void>{
    if(busy||destroyed||complete())return;
    busy=true;refresh();
    try{await options.retry();}
    catch{
      // Native diagnostics stay with the caller. Backend errors can contain
      // private paths and internal protocol details, never presentation copy.
    }
    finally{
      busy=false;
      if(!destroyed){schedule();refresh();}
    }
  }
  schedule();refresh();
  return{
    element,
    update(next,count){
      if(destroyed)return;
      const wasComplete=complete(),advanced=observeProgress(next,count);status=next;entryCount=count;
      if(complete())cancelTimer();
      else if(wasComplete||advanced){attempts=0;schedule();}
      refresh();
    },
    destroy(){if(destroyed)return;destroyed=true;cancelTimer();closeDetails();element.remove();},
  };
}
