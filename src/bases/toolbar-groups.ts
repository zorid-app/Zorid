import type {BaseValue} from './document.ts';
import type {BaseExpressionValue} from './expression.ts';
import {baseExpressionValue,baseValueToString,baseValuesEqual} from './expression.ts';
import {baseEditValue} from './view-actions.ts';
import type {BaseQueryResult} from './query.ts';
import {normalizeBaseProperty} from './query.ts';
import {displaySharedBaseValue} from './presentation-common.ts';
import {icon} from '../ui/icons.ts';

interface GroupRow { identity: string; key: BaseExpressionValue; count: number; checked: boolean; stored?: BaseValue; orderKey?: BaseValue;localNew?:boolean }
const coreOrderKey=(group:object):{orderKey?:BaseValue}=>{const descriptor=Object.getOwnPropertyDescriptor(group,'orderKey');return descriptor&&'value'in descriptor&&descriptor.value!==undefined?{orderKey:descriptor.value as BaseValue}:{};};
export interface BaseManualGroupRowDraft {readonly key:BaseExpressionValue;readonly checked:boolean;readonly localValue?:BaseValue}
export interface BaseManualGroupsAdmissionDraft {
 readonly witness:string;
 readonly state:{readonly manual:boolean;readonly rows:readonly BaseManualGroupRowDraft[];readonly removedRows?:readonly BaseManualGroupRowDraft[];readonly reorder?:{readonly row:BaseExpressionValue;readonly preview:readonly BaseExpressionValue[]};readonly tail:readonly BaseValue[];readonly removedOrder?:readonly BaseValue[];readonly newGroup?:{readonly value:string;readonly selectionStart:number|null;readonly selectionEnd:number|null;readonly selectionDirection:'forward'|'backward'|'none'|null;readonly focus:boolean};readonly focusKey?:string};
 readonly ready:Promise<void>;
}
const completedManualDrafts=new WeakSet<BaseManualGroupsAdmissionDraft>();
export interface BaseManualGroups {
 canCaptureAdmissionDraft():boolean;
 captureFreeze():BaseManualGroupsAdmissionDraft|undefined;
 restoreAdmissionDraft(draft:BaseManualGroupsAdmissionDraft):boolean;
  read(): readonly BaseValue[] | undefined;
  setManual(manual: boolean): void;
  update(result: BaseQueryResult, retainDraft: boolean): void;
  destroy(): void;
}
const propertyOf=(result:BaseQueryResult)=>{
 const group=result.view.groupBy;
 return group&&typeof group==='object'&&!Array.isArray(group)&&typeof (group as Record<string,BaseValue>).property==='string'?normalizeBaseProperty((group as Record<string,BaseValue>).property as string):'';
};
function label(key:BaseExpressionValue,shared:boolean):string {
 if(key.type==='null')return 'No value';
 try{return shared?displaySharedBaseValue(key):baseValueToString(key);}catch{return key.type;}
}
const same=(value:BaseValue,key:BaseExpressionValue)=>{
 const parsed=baseExpressionValue(value);
 return baseValuesEqual(parsed,key,true)||(parsed.type==='string'&&parsed.value===label(key,false));
};
/** Shared group IDs identify rendered rows; persisted configured values retain their source bytes/value. */
export function createBaseManualGroups(doc:Document,parent:HTMLElement,options:{result:BaseQueryResult;property():string;valueType?():string|undefined;changed():void;draft?(active:boolean):void;error(message:string):void}):BaseManualGroups {
 let frozen=false,restoring=false,interacted=false,capturedDraft:BaseManualGroupsAdmissionDraft|undefined;
 const notifyDraft=(active:boolean)=>{if(!restoring)options.draft?.(active);};
 let result=options.result,manual=Array.isArray(result.view.groupOrder),rows:GroupRow[]=[],tail:readonly BaseValue[]=[],retired=false;
 let removedOrder:readonly BaseValue[]|undefined;
 let removedRows:GroupRow[]|undefined;
 type Reorder={row:GroupRow;source:HTMLElement;line:HTMLElement;list:HTMLElement;token:string;mode:'pointer'|'keyboard';original:readonly GroupRow[];preview:GroupRow[];lines:Map<GroupRow,HTMLElement>;checks:Map<HTMLInputElement,boolean>;result:BaseQueryResult;property:string};
 let drag:Reorder|undefined;
 const node=doc.createElement('div');node.className='bases-manual-groups';parent.append(node);
 const canStore=(row:GroupRow)=>result.shared===undefined||Object.hasOwn(row,'stored')||Object.hasOwn(row,'orderKey');
 const stored=(row:GroupRow):BaseValue=>{if(Object.hasOwn(row,'stored'))return row.stored!;if(result.shared===undefined)return baseEditValue(row.key);if(Object.hasOwn(row,'orderKey'))return row.orderKey!;throw new Error('This group has no safe configuration key. Refresh before changing its order.');};
 let enteringGroup=false,newGroupInput:HTMLInputElement|undefined,openNewGroup:((state:NonNullable<BaseManualGroupsAdmissionDraft['state']['newGroup']>)=>void)|undefined;
 const read=():readonly BaseValue[]|undefined=>{if(enteringGroup)throw new Error('Finish or cancel the new group before saving.');if(drag)throw new Error('Finish or cancel the group reorder before saving.');return manual?rows.filter(row=>row.checked).map(stored).concat(tail):undefined;};
 function load(){
  const order=Array.isArray(result.view.groupOrder)?result.view.groupOrder:undefined;
  if(normalizeBaseProperty(options.property())!==propertyOf(result)){rows=[];tail=[];removedRows=undefined;removedOrder=undefined;return;}
  let ordinal=0;
  const candidates = result.groupOptions.length ? result.groupOptions : result.groups.filter(group=>group.key!==null).map(group=>({key:group.key!,sharedKeyId:group.sharedKeyId??undefined,count:group.rows.length,listed:true,...coreOrderKey(group)}));
  rows=candidates.map(group=>{
   const identity=result.shared!==undefined?group.sharedKeyId:JSON.stringify(group.key);
   if(typeof identity!=='string'||!identity)throw new Error('Group identity is unavailable. Refresh before changing groups.');
   const original=order&&group.listed?order[ordinal++]:undefined;
   const actual=result.shared!==undefined?result.groups.find(actual=>actual.sharedKeyId===identity):undefined;
   const key=actual?.key??group.key;
   return {identity,key:key!,count:group.count,checked:manual?!!group.listed:true,...coreOrderKey(actual??group),...coreOrderKey(group),...(original!==undefined||order&&group.listed&&original===null?{stored:original!}:{})};
  });
  if(result.shared!==undefined&&order&&ordinal!==order.length)throw new Error('The saved group order has changed. Refresh before editing it.');
  tail=result.shared!==undefined?[]:order?.filter(value=>!rows.some(row=>same(value,row.key)))??[];
 }
 const focusRow=(identity:string)=>Array.from(node.querySelectorAll<HTMLElement>('[data-group-id]')).find(line=>line.dataset.groupId===identity)?.focus({preventScroll:true});
 const ownsFocus=()=>node.contains(doc.activeElement)||doc.activeElement===doc.body||doc.activeElement===doc.documentElement;
 const reorderCurrent=(active:Reorder)=>!frozen&&!retired&&manual&&drag===active&&active.result===result&&active.property===normalizeBaseProperty(options.property())&&active.source.isConnected&&active.line.isConnected&&active.list.isConnected&&canStore(active.row);
 function previewReorder(active:Reorder,next:GroupRow[]){
  if(!reorderCurrent(active))return;
  if(next.every((row,index)=>row===active.preview[index]))return;
  active.preview=next;
  for(const row of next){const line=active.lines.get(row);if(line)active.list.append(line);}
 }
 function cancelReorder(restoreFocus:boolean){
  const active=drag;if(!active)return;
  const focus=restoreFocus&&ownsFocus();drag=undefined;
  if(active.list.isConnected)for(const row of active.original){const line=active.lines.get(row);if(line?.isConnected)active.list.append(line);}
  for(const [check,disabled] of active.checks)if(check.isConnected)check.disabled=disabled;
  active.line.removeAttribute('aria-grabbed');active.line.removeAttribute('data-group-reordering');notifyDraft(false);
  if(focus)focusRow(active.row.identity);
 }
 function beginReorder(row:GroupRow,source:HTMLElement,line:HTMLElement,list:HTMLElement,mode:'pointer'|'keyboard',token:string,focus=true){
  if(frozen||retired||!manual||enteringGroup||drag||!node.isConnected||!canStore(row)||!source.isConnected||!line.isConnected)return false;
  const lines=new Map(rows.map(item=>[item,Array.from(list.children).find(element=>(element as HTMLElement).dataset.groupId===item.identity) as HTMLElement]));
  if([...lines.values()].some(element=>!element))return false;
  const checks=new Map(Array.from(list.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),check=>[check,check.disabled] as const));
  drag={row,source,line,list,mode,token,original:rows.slice(),preview:rows.slice(),lines,checks,result,property:normalizeBaseProperty(options.property())};
  for(const check of checks.keys())check.disabled=true;
  line.setAttribute('aria-grabbed','true');line.dataset.groupReordering=mode;if(focus)line.focus({preventScroll:true});notifyDraft(true);return true;
 }
 function previewAt(active:Reorder,target:GroupRow,line:HTMLElement,clientY:number){
  if(!reorderCurrent(active)||target===active.row||!active.lines.has(target))return;
  const next=active.preview.filter(row=>row!==active.row),index=next.indexOf(target),bounds=line.getBoundingClientRect();
  if(index<0)return;
  next.splice(index+(clientY>=bounds.top+bounds.height/2?1:0),0,active.row);previewReorder(active,next);
 }
 function commitReorder(active:Reorder){
  if(!reorderCurrent(active)){cancelReorder(false);return;}
  const focus=ownsFocus(),changed=active.preview.some((row,index)=>row!==active.original[index]);
  const next=active.preview.slice();drag=undefined;for(const [check,disabled] of active.checks)if(check.isConnected)check.disabled=disabled;active.line.removeAttribute('aria-grabbed');active.line.removeAttribute('data-group-reordering');notifyDraft(false);
  if(changed)attempt(()=>{rows=next;});
  if(focus)focusRow(active.row.identity);
 }
 const reorderKey=(event:KeyboardEvent)=>{
  const active=drag;if(frozen||!active||event.isComposing)return;
  // A palette or another control can take focus without a pointer event.
  // Relinquish the preview without consuming that owner's keyboard command.
  const targetOwned=event.target instanceof doc.defaultView!.Node&&active.line.contains(event.target);
  if(!ownsFocus()||active.mode==='keyboard'&&(!active.line.contains(doc.activeElement)||!targetOwned)||active.mode==='pointer'&&!targetOwned&&event.target!==doc.body&&event.target!==doc.documentElement){cancelReorder(false);return;}
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancelReorder(true);return;}
  if(active.mode!=='keyboard')return;
  if(event.key==='Tab'){cancelReorder(true);return;}
  if(['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();commitReorder(active);return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||event.metaKey||event.ctrlKey)return;
  event.preventDefault();event.stopImmediatePropagation();
  const from=active.preview.indexOf(active.row),to=event.key==='Home'?0:event.key==='End'?active.preview.length-1:Math.max(0,Math.min(active.preview.length-1,from+(event.key==='ArrowUp'?-1:1)));
  const next=active.preview.slice();next.splice(from,1);next.splice(to,0,active.row);previewReorder(active,next);active.line.focus({preventScroll:true});
 };
 const outsideReorder=(event:Event)=>{if(frozen)return;if(drag&&(!(event.target instanceof doc.defaultView!.Node)||!node.contains(event.target)))cancelReorder(false);};
 const focusReorder=(event:FocusEvent)=>{if(frozen)return;if(drag&&(!(event.target instanceof doc.defaultView!.Node)||!drag.line.contains(event.target)))cancelReorder(false);};
 const blurReorder=()=>{if(!frozen)cancelReorder(false);};
 // Window capture precedes the toolbar's document Escape handler. A canceled
 // reorder keeps its menu open; it must never become a menu-close/save command.
 const win=doc.defaultView;win?.addEventListener('keydown',reorderKey,true);win?.addEventListener('pointerdown',outsideReorder,true);win?.addEventListener('drop',outsideReorder,true);win?.addEventListener('focusin',focusReorder,true);win?.addEventListener('blur',blurReorder);
 const attempt=(change:()=>void)=>{
  if(frozen||retired||!node.isConnected)return;
  if(enteringGroup||drag){options.error(enteringGroup?'Finish or cancel the new group first.':'Finish or cancel the group reorder first.');return;}
  const oldRows=rows.map(row=>({...row})),oldTail=tail;
  try{change();read();options.error('');options.changed();render();}catch(error){rows=oldRows;tail=oldTail;options.error(error instanceof Error?error.message:String(error));render();}
 };
 function render(){
  if(frozen||retired)return;
  cancelReorder(false);const focused=node.contains(doc.activeElement)?doc.activeElement?.getAttribute('aria-label'):undefined;node.replaceChildren();node.hidden=!manual;
  if(!manual)return;
  const list=doc.createElement('div');list.className='bases-manual-group-list';list.setAttribute('role','list');node.append(list);
  rows.forEach((row,index)=>{
   const writable=canStore(row);
   const line=doc.createElement('div');line.className='bases-manual-group-row';line.dataset.groupId=row.identity;line.tabIndex=0;line.setAttribute('role','listitem');line.classList.toggle('mod-hidden',!row.checked);
   line.setAttribute('aria-disabled',String(!writable));if(!writable)line.title='This group has no safe configuration key. Refresh before changing its order.';
   const grip=doc.createElement('span');grip.className='bases-manual-group-grip';grip.append(icon('grip-vertical',14,doc));grip.draggable=writable;grip.tabIndex=writable?0:-1;grip.setAttribute('role','button');grip.setAttribute('aria-label',`Reorder group ${label(row.key,result.shared!==undefined)}`);grip.setAttribute('aria-disabled',String(!writable));grip.title='Drag to reorder. Press Space, then arrow keys to move; Enter to drop or Escape to cancel.';
   const check=doc.createElement('input');check.type='checkbox';check.checked=row.checked;check.disabled=!writable;check.setAttribute('aria-label',`Show group ${label(row.key,result.shared!==undefined)}`);
   const text=doc.createElement('span');text.className='bases-manual-group-name';text.textContent=label(row.key,result.shared!==undefined);
   const count=doc.createElement('span');count.className='bases-manual-group-count';count.textContent=String(row.count);line.append(grip,check,text,count);list.append(line);
   const toggle=()=>{if(drag){check.checked=row.checked;return;}if(writable)attempt(()=>{row.checked=!row.checked;});};check.addEventListener('change',toggle);
   line.addEventListener('click',event=>{if(event.target===check||(event.target as Element).closest('.bases-manual-group-grip'))return;toggle();});
   line.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle();}
    else if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&row.checked&&writable){event.preventDefault();const destination=Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowUp'?-1:1)));attempt(()=>{rows.splice(index,1);rows.splice(destination,0,row);});Array.from(node.querySelectorAll<HTMLElement>('[data-group-id]')).find(element=>element.dataset.groupId===row.identity)?.focus();}
   });
   grip.addEventListener('keydown',event=>{if(!event.isComposing&&[' ','Enter'].includes(event.key)){event.preventDefault();event.stopPropagation();beginReorder(row,grip,line,list,'keyboard','');}});
   grip.addEventListener('dragstart',event=>{if(!event.dataTransfer){event.preventDefault();return;}const token=`${Date.now()}-${Math.random()}`;if(!beginReorder(row,grip,line,list,'pointer',token)){event.preventDefault();return;}event.dataTransfer.setData('application/x-zorid-base-group',token);event.dataTransfer.effectAllowed='move';});
   grip.addEventListener('dragend',()=>{if(!frozen&&drag?.source===grip)cancelReorder(true);});
   line.addEventListener('dragover',event=>{const active=drag;if(active?.mode!=='pointer'||!reorderCurrent(active))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';previewAt(active,row,line,event.clientY);});
   line.addEventListener('drop',event=>{const active=drag;if(active?.mode!=='pointer'||!reorderCurrent(active)||event.dataTransfer?.getData('application/x-zorid-base-group')!==active.token)return;event.preventDefault();previewAt(active,row,line,event.clientY);commitReorder(active);});
  });
  if(rows.some(row=>!canStore(row))){const warning=doc.createElement('p');warning.className='bases-toolbar-hint';warning.setAttribute('role','status');warning.textContent='Some groups have no safe configuration key and cannot be selected or reordered. Refresh to try again.';node.append(warning);}
  const add=doc.createElement('button');add.type='button';add.className='bases-toolbar-menu-item';add.setAttribute('aria-label','Add group');add.append(icon('plus',16,doc),doc.createTextNode('Add group'));
  const open=(focus=true)=>{
   if(frozen||retired||!add.isConnected||drag)return;
   enteringGroup=true;notifyDraft(true);for(const check of node.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))check.disabled=true;toggleAll.disabled=true;
   const editor=doc.createElement('div');editor.className='bases-manual-group-new';
   const input=doc.createElement('input');input.setAttribute('aria-label','Group name');input.placeholder='Group name';
   const commit=doc.createElement('button');commit.type='button';commit.textContent='Add';commit.setAttribute('aria-label','Create group');
   const create=()=>{
    if(frozen||retired)return;
    const type=options.valueType?.();let value:BaseValue=input.value;
    if(type==='number'||type==='rating'){if(!input.value.trim()||!Number.isFinite(Number(input.value))){options.error('Enter a finite number for this group.');return;}value=Number(input.value);}
    if(type==='checkbox'||type==='boolean'){if(!['true','false'].includes(input.value)){options.error('Enter true or false for this group.');return;}value=input.value==='true';}
    enteringGroup=false;notifyDraft(false);attempt(()=>{const key=baseExpressionValue(value),existing=rows.find(row=>baseValuesEqual(row.key,key,true));if(existing)existing.checked=true;else rows.push({identity:`new:${JSON.stringify(value)}`,key,count:0,checked:true,stored:value,localNew:true});});
   };
   commit.addEventListener('click',create);input.addEventListener('keydown',event=>{if(frozen){if(!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();}return;}if(event.key==='Enter'&&!event.isComposing){event.preventDefault();event.stopPropagation();create();}if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();enteringGroup=false;notifyDraft(false);render();node.querySelector<HTMLButtonElement>('[aria-label="Add group"]')?.focus();}});editor.append(input,commit);add.after(editor);add.hidden=true;newGroupInput=input;if(focus)input.focus();
  };
  add.addEventListener('click',()=>open());openNewGroup=state=>{open(state.focus);if(!newGroupInput)return;newGroupInput.value=state.value;newGroupInput.setSelectionRange(state.selectionStart,state.selectionEnd,state.selectionDirection??undefined);};
  const any=rows.some(row=>row.checked),toggleAll=doc.createElement('button');toggleAll.type='button';toggleAll.className='bases-toolbar-menu-item';toggleAll.setAttribute('aria-label',any?'Hide all groups':'Show all groups');toggleAll.append(icon(any?'eye-off':'eye',16,doc),doc.createTextNode(any?'Hide all':'Show all'));
  toggleAll.disabled=!rows.some(canStore);toggleAll.addEventListener('click',()=>attempt(()=>{rows.forEach(row=>{if(canStore(row))row.checked=!any;});}));node.append(add,toggleAll);
  if(focused)Array.from(node.querySelectorAll<HTMLElement>('[aria-label]')).find(control=>control.getAttribute('aria-label')===focused)?.focus();
 }
 try{load();}catch(error){options.error(error instanceof Error?error.message:String(error));}render();
 let initialConfiguration=JSON.stringify([options.result.view.groupBy,options.result.view.groupOrder]);
 const witness=()=>JSON.stringify([initialConfiguration,normalizeBaseProperty(options.property()),options.valueType?.()]);
 let composing=false,settling=false,compositionStartValue='',compositionUpdateValue:string|undefined,compositionInputValue:{value:string;data:string|null;update?:string}|undefined,finishCapture:(()=>void)|undefined;
 const start=(event:CompositionEvent)=>{if(!frozen&&event.target===newGroupInput){composing=true;settling=false;compositionStartValue=newGroupInput.value;compositionUpdateValue=undefined;compositionInputValue=undefined;}};
 const update=(event:CompositionEvent)=>{if(composing&&event.target===newGroupInput)compositionUpdateValue=event.data;};
 const input=(event:Event)=>{if(event.target!==newGroupInput)return;if(composing)compositionInputValue={value:newGroupInput!.value,data:(event as InputEvent).data??null,update:compositionUpdateValue};else{settling=false;finishCapture?.();}};
 const end=(event:CompositionEvent)=>{if(event.target!==newGroupInput)return;composing=false;settling=!(event.data===''&&newGroupInput!.value===compositionStartValue||compositionInputValue?.value===newGroupInput!.value&&(compositionInputValue.data===event.data||compositionInputValue.update===event.data));finishCapture?.();};
 const interaction=(event:Event)=>{if(frozen){if(event.type!=='input'&&event.type!=='change'&&!(event instanceof doc.defaultView!.KeyboardEvent&&(event.isComposing||event.keyCode===229))){event.preventDefault();event.stopImmediatePropagation();}return;}if(!restoring)interacted=true;};for(const name of ['input','change','click','keydown'])node.addEventListener(name,interaction,true);
 node.addEventListener('compositionstart',start,true);node.addEventListener('compositionupdate',update,true);node.addEventListener('input',input,true);node.addEventListener('compositionend',end,true);
 const copyRow=(row:GroupRow):BaseManualGroupRowDraft=>({key:structuredClone(row.key),checked:row.checked,...(row.localNew?{localValue:structuredClone(row.stored)}:{})});
 const snapshot=(focus:boolean,focusKey?:string):BaseManualGroupsAdmissionDraft['state']=>({manual,rows:rows.map(copyRow),removedRows:removedRows?.map(copyRow),...(drag?{reorder:{row:structuredClone(drag.row.key),preview:drag.preview.map(row=>structuredClone(row.key))}}:{}),focusKey,tail:structuredClone(tail),removedOrder:removedOrder&&structuredClone(removedOrder),...(enteringGroup&&newGroupInput?{newGroup:{value:newGroupInput.value,selectionStart:newGroupInput.selectionStart,selectionEnd:newGroupInput.selectionEnd,selectionDirection:newGroupInput.selectionDirection,focus}}:{})});
 const freezeNative=()=>{for(const grip of node.querySelectorAll<HTMLElement>('.bases-manual-group-grip')){grip.setAttribute('aria-disabled','true');grip.draggable=false;grip.tabIndex=-1;}for(const control of node.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button')){if(control===newGroupInput&&(composing||settling))continue;if(control instanceof doc.defaultView!.HTMLInputElement&&control.type==='text')control.readOnly=true;else control.disabled=true;}};
 const focusState=()=>{const active=doc.activeElement;if(!(active instanceof doc.defaultView!.HTMLElement)||!node.contains(active))return;if(active===newGroupInput)return'new-name';const label=active.getAttribute('aria-label');if(label==='Create group')return'new-create';if(label==='Add group')return'add';if(label==='Show all groups'||label==='Hide all groups')return'toggle-all';const line=active.closest<HTMLElement>('.bases-manual-group-row'),row=line&&rows.find(row=>row.identity===line.dataset.groupId);if(!row)return;return JSON.stringify([active.classList.contains('bases-manual-group-grip')?'grip':active instanceof doc.defaultView!.HTMLInputElement?'check':'row',row.key]);};
 const applyFocus=(key:string|undefined)=>{if(!key)return;if(key==='new-name'){newGroupInput?.focus({preventScroll:true});return;}if(key==='new-create'||key==='add'||key==='toggle-all'){const labels=key==='new-create'?['Create group']:key==='add'?['Add group']:['Show all groups','Hide all groups'];[...node.querySelectorAll<HTMLElement>('[aria-label]')].find(control=>labels.includes(control.getAttribute('aria-label')??''))?.focus({preventScroll:true});return;}let slot:unknown;try{slot=JSON.parse(key);}catch{return;}if(!Array.isArray(slot)||slot.length!==2)return;const row=rows.find(row=>JSON.stringify(row.key)===JSON.stringify(slot[1])),line=row&&[...node.querySelectorAll<HTMLElement>('.bases-manual-group-row')].find(line=>line.dataset.groupId===row.identity);if(!line)return;(slot[0]==='grip'?line.querySelector<HTMLElement>('.bases-manual-group-grip'):slot[0]==='check'?line.querySelector<HTMLInputElement>('input[type=checkbox]'):line)?.focus({preventScroll:true});};
 const canCaptureAdmissionDraft=()=>!!capturedDraft||!retired&&node.isConnected;
 function captureFreeze():BaseManualGroupsAdmissionDraft|undefined{
  if(capturedDraft)return capturedDraft;if(!canCaptureAdmissionDraft())return;const focus=!!newGroupInput&&doc.activeElement===newGroupInput,focused=focusState();frozen=true;let state=snapshot(focus,focused),resolve!:()=>void;const ready=new Promise<void>(yes=>{resolve=yes;});const captured:BaseManualGroupsAdmissionDraft={witness:witness(),get state(){return state;},ready};capturedDraft=captured;freezeNative();finishCapture=()=>{if(composing||settling||completedManualDrafts.has(captured))return;state=snapshot(focus,focused);freezeNative();completedManualDrafts.add(captured);resolve();finishCapture=undefined;};finishCapture();return captured;
 }
 function restoreAdmissionDraft(captured:BaseManualGroupsAdmissionDraft):boolean{
  if(frozen||retired||interacted||composing||settling||!node.isConnected||captured.witness!==witness()||!completedManualDrafts.has(captured))return false;
  const restoreRows=(drafts:readonly BaseManualGroupRowDraft[]):GroupRow[]|undefined=>{if(new Set(drafts.map(row=>JSON.stringify(row.key))).size!==drafts.length)return;const next:GroupRow[]=[];for(const row of drafts){const matches=rows.filter(item=>JSON.stringify(item.key)===JSON.stringify(row.key));if(matches.length>1)return;const current=matches[0];if(current)next.push({...current,checked:row.checked});else if(Object.hasOwn(row,'localValue'))next.push({identity:`new:${JSON.stringify(row.localValue)}`,key:structuredClone(row.key),count:0,checked:row.checked,stored:structuredClone(row.localValue),localNew:true});else return;}return next;};
  const next=restoreRows(captured.state.rows),nextRemoved=captured.state.removedRows&&restoreRows(captured.state.removedRows);if(!next||captured.state.removedRows&&!nextRemoved)return false;
  const reorder=captured.state.reorder,preview=reorder?.preview.map(key=>next.find(row=>JSON.stringify(row.key)===JSON.stringify(key)));if(reorder&&(!captured.state.manual||!next.some(row=>JSON.stringify(row.key)===JSON.stringify(reorder.row)&&canStore(row))||preview!.some(row=>!row)||new Set(preview).size!==next.length))return false;
  restoring=true;try{rows=next;manual=captured.state.manual;tail=structuredClone(captured.state.tail);removedOrder=captured.state.removedOrder&&structuredClone(captured.state.removedOrder);removedRows=nextRemoved;enteringGroup=false;render();if(captured.state.newGroup)openNewGroup?.(captured.state.newGroup);
   if(reorder){const row=rows.find(row=>JSON.stringify(row.key)===JSON.stringify(reorder.row))!,line=[...node.querySelectorAll<HTMLElement>('.bases-manual-group-row')].find(line=>line.dataset.groupId===row.identity),source=line?.querySelector<HTMLElement>('.bases-manual-group-grip'),list=node.querySelector<HTMLElement>('.bases-manual-group-list');if(!line||!source||!list||!beginReorder(row,source,line,list,'keyboard','',false))return false;if(drag)previewReorder(drag,preview as GroupRow[]);}
   applyFocus(captured.state.focusKey);return true;}finally{restoring=false;}
 }
 return{canCaptureAdmissionDraft,captureFreeze,restoreAdmissionDraft,read,setManual(next){if(frozen||next===manual)return;cancelReorder(false);try{if(!next){removedOrder=read();removedRows=result.shared!==undefined?rows.map(row=>({...row})):undefined;manual=false;}else{manual=true;if(result.shared!==undefined){if(removedRows){const current=new Map(rows.map(row=>[row.identity,row]));rows=removedRows.map(row=>({...row,count:current.get(row.identity)?.count??0})).concat(rows.filter(row=>!removedRows!.some(old=>old.identity===row.identity)).map(row=>({...row,checked:false})));}else rows.forEach(row=>{row.checked=false;});tail=[];}else{const restored=removedOrder??[];rows.forEach(row=>{row.checked=restored.some(value=>same(value,row.key));});tail=restored.filter(value=>!rows.some(row=>same(value,row.key)));}}render();}catch(error){options.error(error instanceof Error?error.message:String(error));}},update(next,retainDraft){if(frozen)return;const retainBaseline=retainDraft||enteringGroup||!!drag;if(!retainBaseline)initialConfiguration=JSON.stringify([next.view.groupBy,next.view.groupOrder]);cancelReorder(false);const previous=rows,previousProperty=propertyOf(result);result=next;if(previousProperty!==propertyOf(next)){removedRows=undefined;removedOrder=undefined;}if(enteringGroup)return;try{load();if(retainDraft&&previousProperty===propertyOf(next)){const nextRows=new Map(rows.map(row=>[row.identity,row]));rows=previous.map(row=>({...row,count:nextRows.get(row.identity)?.count??0})).concat(rows.filter(row=>!previous.some(old=>old.identity===row.identity)));}}catch(error){options.error(error instanceof Error?error.message:String(error));}render();},destroy(){cancelReorder(false);retired=true;for(const name of ['input','change','click','keydown'])node.removeEventListener(name,interaction,true);node.removeEventListener('compositionstart',start,true);node.removeEventListener('compositionupdate',update,true);node.removeEventListener('input',input,true);node.removeEventListener('compositionend',end,true);win?.removeEventListener('keydown',reorderKey,true);win?.removeEventListener('pointerdown',outsideReorder,true);win?.removeEventListener('drop',outsideReorder,true);win?.removeEventListener('focusin',focusReorder,true);win?.removeEventListener('blur',blurReorder);enteringGroup=false;notifyDraft(false);node.remove();}};
}
