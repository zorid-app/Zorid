import type {BaseValue} from './document.ts';
import type {BaseExpressionValue} from './expression.ts';
import {baseExpressionValue,baseValueToString,baseValuesEqual} from './expression.ts';
import {baseEditValue} from './view-actions.ts';
import type {BaseQueryResult} from './query.ts';
import {normalizeBaseProperty} from './query.ts';
import {displaySharedBaseValue} from './presentation-common.ts';
import {icon} from '../ui/icons.ts';

interface GroupRow { identity: string; key: BaseExpressionValue; count: number; checked: boolean; stored?: BaseValue }
export interface BaseManualGroups {
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
 let result=options.result,manual=Array.isArray(result.view.groupOrder),rows:GroupRow[]=[],tail:readonly BaseValue[]=[],retired=false;
 let removedOrder:readonly BaseValue[]|undefined;
 let drag:{row:GroupRow;source:HTMLElement;token:string}|undefined;
 const node=doc.createElement('div');node.className='bases-manual-groups';parent.append(node);
 const stored=(row:GroupRow):BaseValue=>Object.hasOwn(row,'stored')?row.stored!:baseEditValue(row.key);
 let enteringGroup=false;
 const read=():readonly BaseValue[]|undefined=>{if(enteringGroup)throw new Error('Finish or cancel the new group before saving.');return manual?rows.filter(row=>row.checked).map(stored).concat(tail):undefined;};
 function load(){
  const order=Array.isArray(result.view.groupOrder)?result.view.groupOrder:undefined;
  if(normalizeBaseProperty(options.property())!==propertyOf(result)){rows=[];tail=[];return;}
  let ordinal=0;
  const candidates = result.groupOptions.length ? result.groupOptions : result.groups.filter(group=>group.key!==null).map(group=>({key:group.key!,sharedKeyId:group.sharedKeyId??undefined,count:group.rows.length,listed:true}));
  rows=candidates.map(group=>{
   const identity=result.shared!==undefined?group.sharedKeyId:JSON.stringify(group.key);
   if(typeof identity!=='string'||!identity)throw new Error('Group identity is unavailable. Refresh before changing groups.');
   const original=order&&group.listed?order[ordinal++]:undefined;
   const key=result.shared!==undefined?result.groups.find(actual=>actual.sharedKeyId===identity)?.key??group.key:group.key;
   return {identity,key:key!,count:group.count,checked:manual?!!group.listed:true,...(original!==undefined||order&&group.listed&&original===null?{stored:original!}:{})};
  });
  if(result.shared!==undefined&&order&&ordinal!==order.length)throw new Error('The saved group order has changed. Refresh before editing it.');
  tail=result.shared!==undefined?[]:order?.filter(value=>!rows.some(row=>same(value,row.key)))??[];
 }
 const attempt=(change:()=>void)=>{
  if(retired||!node.isConnected)return;
  const oldRows=rows.map(row=>({...row})),oldTail=tail;
  try{change();read();options.error('');options.changed();render();}catch(error){rows=oldRows;tail=oldTail;options.error(error instanceof Error?error.message:String(error));render();}
 };
 function render(){
  if(retired)return;
  const focused=doc.activeElement?.getAttribute('aria-label');node.replaceChildren();node.hidden=!manual;drag=undefined;
  if(!manual)return;
  const list=doc.createElement('div');list.className='bases-manual-group-list';list.setAttribute('role','list');node.append(list);
  rows.forEach((row,index)=>{
   const line=doc.createElement('div');line.className='bases-manual-group-row';line.dataset.groupId=row.identity;line.tabIndex=0;line.setAttribute('role','listitem');line.classList.toggle('mod-hidden',!row.checked);
   const grip=doc.createElement('span');grip.className='bases-manual-group-grip';grip.append(icon('grip-vertical',14,doc));grip.draggable=true;
   const check=doc.createElement('input');check.type='checkbox';check.checked=row.checked;check.setAttribute('aria-label',`Show group ${label(row.key,result.shared!==undefined)}`);
   const text=doc.createElement('span');text.className='bases-manual-group-name';text.textContent=label(row.key,result.shared!==undefined);
   const count=doc.createElement('span');count.className='bases-manual-group-count';count.textContent=String(row.count);line.append(grip,check,text,count);list.append(line);
   const toggle=()=>attempt(()=>{row.checked=!row.checked;});check.addEventListener('change',toggle);
   line.addEventListener('click',event=>{if(event.target===check||(event.target as Element).closest('.bases-manual-group-grip'))return;toggle();});
   line.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle();}
    else if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&row.checked){event.preventDefault();const destination=Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowUp'?-1:1)));attempt(()=>{rows.splice(index,1);rows.splice(destination,0,row);});Array.from(node.querySelectorAll<HTMLElement>('[data-group-id]')).find(element=>element.dataset.groupId===row.identity)?.focus();}
   });
   grip.addEventListener('dragstart',event=>{if(retired||!grip.isConnected||!event.dataTransfer){event.preventDefault();return;}const token=`${Date.now()}-${Math.random()}`;drag={row,source:grip,token};event.dataTransfer.setData('application/x-zorid-base-group',token);event.dataTransfer.effectAllowed='move';});
   grip.addEventListener('dragend',()=>{drag=undefined;});
   line.addEventListener('dragover',event=>{if(drag?.source.isConnected&&line.isConnected)event.preventDefault();});
   line.addEventListener('drop',event=>{const source=drag;drag=undefined;if(!source?.source.isConnected||!line.isConnected||event.dataTransfer?.getData('application/x-zorid-base-group')!==source.token)return;event.preventDefault();attempt(()=>{const from=rows.indexOf(source.row);if(from<0)return;rows.splice(from,1);rows.splice(index,0,source.row);});});
  });
  const add=doc.createElement('button');add.type='button';add.className='bases-toolbar-menu-item';add.setAttribute('aria-label','Add group');add.append(icon('plus',16,doc),doc.createTextNode('Add group'));
  add.addEventListener('click',()=>{
   if(retired||!add.isConnected)return;
   enteringGroup=true;options.draft?.(true);
   const editor=doc.createElement('div');editor.className='bases-manual-group-new';
   const input=doc.createElement('input');input.setAttribute('aria-label','Group name');input.placeholder='Group name';
   const commit=doc.createElement('button');commit.type='button';commit.textContent='Add';commit.setAttribute('aria-label','Create group');
   const create=()=>{
    const type=options.valueType?.();let value:BaseValue=input.value;
    if(type==='number'||type==='rating'){if(!input.value.trim()||!Number.isFinite(Number(input.value))){options.error('Enter a finite number for this group.');return;}value=Number(input.value);}
    if(type==='checkbox'||type==='boolean'){if(!['true','false'].includes(input.value)){options.error('Enter true or false for this group.');return;}value=input.value==='true';}
    enteringGroup=false;options.draft?.(false);attempt(()=>{const key=baseExpressionValue(value),existing=rows.find(row=>baseValuesEqual(row.key,key,true));if(existing)existing.checked=true;else rows.push({identity:`new:${JSON.stringify(value)}`,key,count:0,checked:true,stored:value});});
   };
   commit.addEventListener('click',create);input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();event.stopPropagation();create();}if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();enteringGroup=false;options.draft?.(false);editor.remove();add.hidden=false;add.focus();}});editor.append(input,commit);add.after(editor);add.hidden=true;input.focus();
  });
  const any=rows.some(row=>row.checked),toggleAll=doc.createElement('button');toggleAll.type='button';toggleAll.className='bases-toolbar-menu-item';toggleAll.setAttribute('aria-label',any?'Hide all groups':'Show all groups');toggleAll.append(icon(any?'eye-off':'eye',16,doc),doc.createTextNode(any?'Hide all':'Show all'));
  toggleAll.addEventListener('click',()=>attempt(()=>{rows.forEach(row=>{row.checked=!any;});}));node.append(add,toggleAll);
  if(focused)Array.from(node.querySelectorAll<HTMLElement>('[aria-label]')).find(control=>control.getAttribute('aria-label')===focused)?.focus();
 }
 try{load();}catch(error){options.error(error instanceof Error?error.message:String(error));}render();
 return{read,setManual(next){if(next===manual)return;try{if(!next){removedOrder=read();manual=false;}else{manual=true;const restored=removedOrder??[];rows.forEach(row=>{row.checked=restored.some(value=>same(value,row.key));});tail=restored.filter(value=>!rows.some(row=>same(value,row.key)));}render();}catch(error){options.error(error instanceof Error?error.message:String(error));}},update(next,retainDraft){const previous=rows,previousProperty=propertyOf(result);result=next;try{load();if(retainDraft&&previousProperty===propertyOf(next)){const nextRows=new Map(rows.map(row=>[row.identity,row]));rows=previous.map(row=>({...row,count:nextRows.get(row.identity)?.count??0})).concat(rows.filter(row=>!previous.some(old=>old.identity===row.identity)));}}catch(error){options.error(error instanceof Error?error.message:String(error));}render();},destroy(){retired=true;drag=undefined;enteringGroup=false;options.draft?.(false);node.remove();}};
}
