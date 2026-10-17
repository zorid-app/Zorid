import type { DesktopReconciliation } from '../platform/bridge';
import { el,textButton } from './dom.ts';

export interface ImportStatusOptions {
  status:DesktopReconciliation|null;
  /** Count from the visible authority, never the scanner's imported counter. */
  entryCount:number;
  retry():Promise<void>;
}
export interface ImportStatusView {
  readonly element:HTMLElement;
  update(status:DesktopReconciliation|null,entryCount:number):void;
  destroy():void;
}
const issueLabels:Record<DesktopReconciliation['issues'][number]['code'],string>={
  scan_limit:'The scan reached its limit. Retry to continue checking files.',
  recovery_retained:'A recoverable version has been retained for this file.',
  changed_during_scan:'This file changed while it was being checked.',
  reconciliation_blocked:'This file could not be imported yet.',
};

/** A usable vault may still have an unfinished import. Keep that distinction
 * visible without blocking note editing or replacing fatal startup handling. */
export function mountImportStatus(host:HTMLElement,options:ImportStatusOptions):ImportStatusView {
  let status=options.status,entryCount=options.entryCount,busy=false,destroyed=false,retryError:string|null=null;
  const element=el('section','import-status');element.setAttribute('aria-label','Vault import status');
  const row=el('div','import-status-row'),copy=el('div','import-status-copy');
  const heading=el('strong','import-status-heading'),message=el('p','import-status-message');
  message.role='status';message.setAttribute('aria-live','polite');
  copy.append(heading,message);
  const retry=textButton('Retry',()=>{void runRetry();},'import-status-retry');
  const details=el('details','import-status-details');details.append(el('summary','','Details'));
  const body=el('div','import-status-detail-body');details.append(body);
  row.append(copy,retry);element.append(row,details);host.append(element);

  const refresh=()=>{
    if(destroyed)return;
    const complete=!!status?.complete&&!status.failure;
    element.hidden=complete&&!busy&&!retryError;
    element.dataset.state=busy||!status?'checking':'incomplete';
    element.setAttribute('aria-busy',String(busy));retry.disabled=busy;retry.textContent=busy?'Checking…':'Retry';
    heading.textContent=busy||!status?'Checking vault files…':'Vault import needs attention';
    message.textContent=entryCount>0
      ?'Your imported notes are available. Some files still need to be checked or recovered.'
      :'No files are available yet. Import is still pending or files need attention; this vault may contain notes that are not shown yet.';
    if(busy||!status)message.textContent=entryCount>0?'Your notes remain available while Zorid checks the remaining files.':'Notes will appear as they are imported. The vault has not finished being checked.';
    if(retryError)message.textContent=entryCount>0?'The check could not finish. Your imported notes are still available.':'The check could not finish. Files may still be waiting to import.';
    body.replaceChildren();
    if(status){
      body.append(el('p','',`${status.observed} items checked · ${status.imported} imported · ${status.namespaceApplied} file updates applied`));
      if(status.failure)body.append(el('p','','The folder scan could not finish. Retry to check the remaining files.'));
      if(!status.scanComplete)body.append(el('p','','Some parts of the folder have not been fully checked.'));
      if(status.issueCount)body.append(el('p','',`${status.issueCount} ${status.issueCount===1?'item needs':'items need'} attention.`));
      if(status.issues.length){
        const list=el('ul','import-status-issues');
        for(const issue of status.issues){const item=el('li');if(issue.path)item.append(el('span','import-status-path',issue.path),document.createTextNode(' — '));item.append(document.createTextNode(issueLabels[issue.code]));list.append(item);}
        body.append(list);
      }
      if(status.issuesTruncated)body.append(el('p','','Additional issues are not shown in this list.'));
    }else body.append(el('p','','Zorid is checking which files are ready to open.'));
    if(retryError)body.append(el('p','import-status-retry-error',retryError));
  };
  async function runRetry():Promise<void>{
    if(busy||destroyed)return;
    busy=true;retryError=null;refresh();
    try{await options.retry();}
    catch(error){if(!destroyed)retryError=error instanceof Error?error.message:String(error);}
    finally{busy=false;refresh();}
  }
  refresh();
  return{element,update(next,count){if(destroyed)return;status=next;entryCount=count;retryError=null;refresh();},destroy(){if(destroyed)return;destroyed=true;element.remove();}};
}
