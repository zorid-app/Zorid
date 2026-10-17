import { el, textButton } from './dom.ts';

export function renderStartupError(root:HTMLElement,error:unknown,actions:{retry():void;openAnotherVault?():void}):void {
  root.className='startup-failed';
  const screen=el('main','startup-error');
  const panel=el('section','startup-error-panel');panel.setAttribute('aria-labelledby','startup-error-heading');
  const heading=el('h1','','Unable to open the workspace');heading.id='startup-error-heading';
  panel.append(el('div','app-symbol','◈'),heading,el('p','','Zorid could not finish opening this vault. Your notes and any retained drafts have been kept.'));
  const buttons=el('div','startup-error-actions');
  buttons.append(textButton('Try again',actions.retry,'mod-cta'));
  if(actions.openAnotherVault)buttons.append(textButton('Open another vault',actions.openAnotherVault));
  panel.append(buttons);
  const details=el('details','startup-error-details');details.append(el('summary','','Technical details'));
  const message=error instanceof Error?error.stack||error.message:String(error);
  details.append(el('pre','',message));
  const copy=textButton('Copy details',()=>{void navigator.clipboard.writeText(message).then(()=>{copy.textContent='Copied';}).catch(()=>{copy.textContent='Select the details above to copy';});});
  details.append(copy);panel.append(details);screen.append(panel);root.replaceChildren(screen);
}
