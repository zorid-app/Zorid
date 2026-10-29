import type {IndependentDraftBaseline,IndependentDraftCandidate,IndependentDraftProvider,IndependentDraftReceipt,IndependentDraftScope} from '../core/independent-drafts.ts';
import {normalizePath} from '../core/types.ts';
import type {TextCreateReceipt} from '../core/types.ts';

/** Verified raw text only. Recovery capsules are deliberately not executable
 * authority and are never passed to the copy-creation callback. */
export interface VerifiedNoteJournalDraft {
  readonly receipt:IndependentDraftReceipt;
  readonly baseline:IndependentDraftBaseline;
  readonly draft:string;
  readonly hasRecoveryDetails:boolean;
}
export interface NoteJournalRecoveryOptions {
  host:HTMLElement;
  entryId:string;
  noteLabel:string;
  provider:IndependentDraftProvider;
  getCurrentEntry():{entryId:string|null;scope:IndependentDraftScope}|null;
  copyText(text:string):Promise<void>;
  /** Owns ordinary current-namespace admission and one retained creation
   * operation per selection, including uncertain replies and panel closure.
   * Never overwrite the original note or replay a journal operation capsule. */
  requestRecoveryCopy?(selection:VerifiedNoteJournalDraft):Promise<TextCreateReceipt>;
  canCreateRecoveryCopy?():boolean;
  onOpenCopy?(receipt:TextCreateReceipt):void|Promise<void>;
  onClose?():void;
}
const receiptKeys=['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'] as const;
const candidateKeys=[...receiptKeys,'baseline','draft','checkpointRevision','pendingOperation'];
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const counter=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const text=(value:unknown):value is string=>typeof value==='string'&&value.length<=32*1024*1024;
function record(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length===keys.length&&keys.every(key=>Object.hasOwn(descriptors,key)&&Object.hasOwn(descriptors[key],'value'));
}
const sameScope=(a:IndependentDraftScope,b:IndependentDraftScope)=>a.vaultId===b.vaultId&&a.clientId===b.clientId&&a.incarnationId===b.incarnationId;
const sameReceipt=(a:IndependentDraftReceipt,b:IndependentDraftReceipt)=>receiptKeys.every(key=>a[key]===b[key]);
function checkedReceipt(value:unknown,scope:IndependentDraftScope,entryId:string):IndependentDraftReceipt {
  if(!record(value,receiptKeys)||!id(value.vaultId)||!id(value.clientId)||!id(value.incarnationId)||!id(value.entryId)||!id(value.writer)||!counter(value.revision)||!Number.isSafeInteger(value.generation)||Number(value.generation)<0||Object.is(value.generation,-0)||value.deleted!==false||value.vaultId!==scope.vaultId||value.clientId!==scope.clientId||value.entryId!==entryId)throw new Error('Invalid protected draft receipt');
  return Object.freeze(Object.fromEntries(receiptKeys.map(key=>[key,value[key]]))) as unknown as IndependentDraftReceipt;
}
function checkedCandidate(value:unknown,pinned:IndependentDraftReceipt):IndependentDraftCandidate {
  if(!record(value,candidateKeys))throw new Error('Invalid protected draft');
  const head=checkedReceipt(Object.fromEntries(receiptKeys.map(key=>[key,value[key]])),pinned,pinned.entryId);
  if(!sameReceipt(head,pinned))throw new Error('Protected draft changed');
  const base=value.baseline;
  if(!record(base,['entryId','path','revision','content'])||base.entryId!==pinned.entryId||!id(base.revision)||typeof base.path!=='string'||base.path.length>32768||normalizePath(base.path)!==base.path||!text(base.content)||!text(value.draft)||(value.checkpointRevision!==null&&!id(value.checkpointRevision))||(value.pendingOperation!==null&&!text(value.pendingOperation)))throw new Error('Invalid protected draft body');
  return Object.freeze({...head,deleted:false,baseline:Object.freeze({...base}) as unknown as IndependentDraftBaseline,draft:value.draft,checkpointRevision:value.checkpointRevision,pendingOperation:value.pendingOperation}) as IndependentDraftCandidate;
}
function checkedCopy(value:unknown,entryId:string):TextCreateReceipt {
  if(!record(value,['operationId','entryId','revision','path','sequence'])||!id(value.operationId)||!id(value.entryId)||value.entryId===entryId||!id(value.revision)||!counter(value.sequence)||typeof value.path!=='string'||value.path.length>32768||normalizePath(value.path)!==value.path)throw new Error('Unconfirmed recovery copy');
  return Object.freeze({...value}) as unknown as TextCreateReceipt;
}
const sameCandidate=(a:IndependentDraftCandidate,b:IndependentDraftCandidate)=>sameReceipt(a,b)&&a.draft===b.draft&&a.checkpointRevision===b.checkpointRevision&&a.pendingOperation===b.pendingOperation&&(['entryId','path','revision','content'] as const).every(key=>a.baseline[key]===b.baseline[key]);

/** A read-only region. The host owns any enclosing dialog/focus trap. Call
 * refresh() on mount and updateOwner() on selection/admission changes. Cached
 * verified text remains copyable after ownership loss; no storage mutation or
 * automatic version selection occurs here. */
export function mountNoteJournalRecovery(options:NoteJournalRecoveryOptions):{element:HTMLElement;refresh():Promise<void>;updateOwner():void;focus():void;close():void} {
  const provider=options.provider,scope=Object.freeze({...provider.scope}),entryId=options.entryId;
  if(!id(entryId)||!record(scope,['vaultId','clientId','incarnationId'])||!Object.values(scope).every(id))throw new Error('A bound protected draft owner is required');
  const document=options.host.ownerDocument,previous=document.activeElement as HTMLElement|null;
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',label='')=>{const node=document.createElement(tag);node.className=className;node.textContent=label;return node;};
  const element=make('section','note-journal-recovery version-history');element.role='region';element.setAttribute('aria-label','Protected drafts');element.tabIndex=-1;
  const label=options.noteLabel.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200)||'this note';
  const heading=make('h2','','Protected drafts');
  const explanation=make('p','',`Inspect versions kept for ${label}. Copy text or create a separate note. The original note and protected versions are kept.`);
  const message=make('p','version-history-message');message.role='status';message.setAttribute('aria-live','polite');
  const list=make('div','version-history-list');list.setAttribute('aria-label','Protected draft versions');list.role='group';
  const preview=make('textarea','version-history-preview');preview.readOnly=true;preview.setAttribute('aria-label','Protected draft preview');
  const details=make('p');const actions=make('div','version-history-actions');
  const button=(label:string,action:()=>void)=>{const value=make('button','',label);value.type='button';value.onclick=action;return value;};
  let closed=false,ownerLost=false,listing=false,reading=false,creating=false,copying=false,epoch=0;
  let cached:IndependentDraftCandidate|undefined,selectionCurrent=false,completed:TextCreateReceipt|undefined;
  const buttons:HTMLButtonElement[]=[];const sessions=new Map<string,number>(),writers=new Map<string,number>();
  const current=()=>{
    if(closed||ownerLost)return false;
    try{const owner=options.getCurrentEntry();if(!owner||owner.entryId!==entryId||!sameScope(owner.scope,scope)||!sameScope(provider.scope,scope)){ownerLost=true;epoch++;return false;}return true;}catch{ownerLost=true;epoch++;return false;}
  };
  const canCreate=()=>{try{return current()&&(!options.canCreateRecoveryCopy||options.canCreateRecoveryCopy());}catch{return false;}};
  const refreshButton=button('Refresh versions',()=>{void refresh();});
  const clipboard=button('Copy preview text',()=>{void copyPreview();});
  const create=options.requestRecoveryCopy?button('Create recovery copy',()=>{void createCopy();}):undefined;
  const open=options.onOpenCopy?button('Open recovery copy',()=>{void openCopy();}):undefined;if(open)open.hidden=true;
  const closeButton=button('Close',close);
  actions.append(refreshButton,clipboard,...(create?[create]:[]),...(open?[open]:[]),closeButton);
  element.append(heading,explanation,message,list,preview,details,actions);options.host.append(element);
  // The shared history classes supply typography; this region is also usable in
  // a narrow drawer and never assumes the host has made it a modal dialog.
  element.style.display='flex';element.style.flexDirection='column';element.style.gap='12px';element.style.minWidth='0';
  function controls(){
    if(closed)return;const owned=current(),busy=listing||reading||creating;
    element.setAttribute('aria-busy',String(busy));refreshButton.disabled=!owned||busy;
    for(const item of buttons)item.disabled=!owned||busy;
    clipboard.disabled=!cached||copying;
    if(create)create.disabled=!cached||!selectionCurrent||!canCreate()||busy||!!completed;
    if(open){open.hidden=!completed;open.disabled=!completed||!owned||creating;}
  }
  function updateOwner(){if(!current()){selectionCurrent=false;message.textContent='This note is no longer active. Already verified text can still be copied.';}controls();}
  function close(){
    if(closed)return;const restore=element.contains(document.activeElement);closed=true;epoch++;element.remove();
    if(restore&&previous?.isConnected)previous.focus();options.onClose?.();
  }
  async function refresh():Promise<void>{
    if(!current()||listing||reading||creating){controls();return;}
    const ownEpoch=++epoch;listing=true;selectionCurrent=false;completed=undefined;list.replaceChildren();buttons.length=0;message.textContent='Loading protected versions…';controls();
    try{
      const result=await provider.list({entryId});if(!current()||ownEpoch!==epoch)return;
      if(!Array.isArray(result)||result.length>4096)throw new Error('Invalid inventory');
      const rows=result.map(value=>checkedReceipt(value,scope,entryId)),seen=new Set<string>();
      for(const row of rows){const key=JSON.stringify([row.incarnationId,row.writer]);if(seen.has(key))throw new Error('Duplicate protected branch');seen.add(key);}
      for(const row of rows){
        if(!sessions.has(row.incarnationId))sessions.set(row.incarnationId,sessions.size+1);
        if(!writers.has(row.writer))writers.set(row.writer,writers.size+1);
        const item=button(`Session ${sessions.get(row.incarnationId)} · Writer ${writers.get(row.writer)} · Version ${row.revision}`,()=>{void select(row,item);});
        item.className='version-history-version';item.setAttribute('aria-pressed','false');buttons.push(item);list.append(item);
      }
      message.textContent=rows.length?'Choose a protected version to preview.':'No protected drafts are stored for this note.';
    }catch{if(!closed&&ownEpoch===epoch)message.textContent='Protected versions couldn’t be listed. Stored drafts have been kept.';}
    finally{listing=false;controls();}
  }
  async function changed(){
    selectionCurrent=false;await refresh();if(!closed)message.textContent='This protected version changed. Choose a version from the refreshed list. Previously verified text is still copyable.';
  }
  async function select(row:IndependentDraftReceipt,item:HTMLButtonElement){
    if(!current()||listing||reading||creating)return;
    const ownEpoch=++epoch;reading=true;selectionCurrent=false;completed=undefined;message.textContent='Opening protected version…';
    for(const other of buttons)other.setAttribute('aria-pressed',String(other===item));controls();
    try{
      const value=await provider.read({entryId,writer:row.writer,incarnationId:row.incarnationId});if(!current()||ownEpoch!==epoch)return;
      let verified:IndependentDraftCandidate;try{verified=checkedCandidate(value,row);}catch{reading=false;await changed();return;}
      cached=verified;selectionCurrent=true;preview.value=verified.draft.slice(0,1024*1024);
      details.textContent=`${verified.pendingOperation===null?'':'Includes interrupted-save details; those details are not executed. '}${verified.draft.length>1024*1024?'Preview limited to the first part. Copy preview text copies the complete stored draft.':''}`;
      message.textContent='Protected version verified. The original note is unchanged.';
    }catch{if(!closed&&ownEpoch===epoch)message.textContent='This protected version couldn’t be verified. Stored drafts have been kept.';}
    finally{reading=false;controls();}
  }
  async function copyPreview(){
    if(closed||copying||!cached)return;const raw=cached.draft;copying=true;controls();
    try{await options.copyText(raw);if(!closed)message.textContent='Protected draft text copied.';}
    catch{if(!closed)message.textContent='Text couldn’t be copied. The verified preview is still available.';}
    finally{copying=false;controls();}
  }
  async function createCopy(){
    if(!options.requestRecoveryCopy||!cached||!selectionCurrent||creating||reading||listing||completed||!canCreate())return;
    const selected=cached,ownEpoch=++epoch;creating=true;message.textContent='Creating a separate recovery note…';controls();
    try{
      const value=await provider.read({entryId,writer:selected.writer,incarnationId:selected.incarnationId});
      if(!canCreate()||ownEpoch!==epoch)return;
      let verified:IndependentDraftCandidate;try{verified=checkedCandidate(value,selected);}catch{creating=false;await changed();return;}
      if(!sameCandidate(verified,selected)){creating=false;await changed();return;}
      const receipt=Object.freeze(Object.fromEntries(receiptKeys.map(key=>[key,verified[key]]))) as unknown as IndependentDraftReceipt;
      const selection:VerifiedNoteJournalDraft=Object.freeze({receipt,baseline:verified.baseline,draft:verified.draft,hasRecoveryDetails:verified.pendingOperation!==null});
      const result=await options.requestRecoveryCopy(selection);
      if(closed||ownEpoch!==epoch)return;
      completed=checkedCopy(result,entryId);message.textContent='Recovery copy created. The original note and protected version are kept.';
    }catch{if(!closed&&ownEpoch===epoch)message.textContent='The recovery copy has not been confirmed. This protected draft is kept.';}
    finally{creating=false;controls();}
  }
  async function openCopy(){
    if(!completed||!options.onOpenCopy||!current())return;
    try{await options.onOpenCopy(completed);}catch{if(!closed)message.textContent='The recovery copy is saved, but couldn’t be opened here.';}
  }
  controls();return{element,refresh,updateOwner,focus:()=>{if(!closed)element.focus();},close};
}
