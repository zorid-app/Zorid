import type {DatabaseEntry,DatabaseValue} from '../core/databases.ts';
import type {InlineBaseRequest} from './inline-base.ts';
import {inlineBaseRequest} from './inline-base.ts';

export interface CollectionCreatedPresentationGuard {
  readonly scope:{readonly vaultId:string;readonly clientId:string};
  readonly paneId:string;readonly tabId:string;
  readonly basePath:string;readonly baseEntryId:string;readonly baseRevision:string;readonly baseSource:string;
  readonly viewId?:string;readonly viewIndex:number;
  readonly navigationIntent:number;readonly activationRevision:number;
  readonly inline?:InlineBaseRequest;
}
export interface CollectionCreatedPresentationCapture extends CollectionCreatedPresentationGuard {
  readonly requested:{readonly entryId:string;readonly path:string;readonly collectionId:string};
}
export interface CollectionCreatedPresentationFreshGuard {
  /** Root resolves this from the actual saved-tab alias, never path similarity. */
  readonly originalTabId:string;
  readonly current:CollectionCreatedPresentationGuard;
  /** Capture while the rebuilt workspace is still frozen, before any async
   * presentation reads. Restoration itself may reset/increment these counters. */
  readonly reservation:{readonly tabId:string;readonly navigationIntent:number;readonly activationRevision:number};
}
export interface CollectionCreatedPresentation {
  freeze(currentOriginal:CollectionCreatedPresentationGuard):boolean;
  committed(entry:DatabaseEntry):boolean;
  /** Caller supplies a fresh current guard only after checked same-scope Core
   * admission. This UI predicate grants neither storage nor read authority. */
  canPresent(fresh:CollectionCreatedPresentationFreshGuard):boolean;
  cancel():void;
  readonly entry:DatabaseEntry|undefined;
}

const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&!value.includes('\0');
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&typeof value==='number'&&value>=0&&!Object.is(value,-0);
function data(value:unknown):value is Record<string,any>{
  return!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
    &&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
function guard(value:unknown):CollectionCreatedPresentationGuard|undefined {
  if(!data(value)||!data(value.scope)||!text(value.scope.vaultId)||!text(value.scope.clientId)
    ||!['paneId','tabId','basePath','baseEntryId','baseRevision'].every(key=>text(value[key]))||typeof value.baseSource!=='string'
    ||value.viewId!==undefined&&!text(value.viewId)||![value.viewIndex,value.navigationIntent,value.activationRevision].every(count))return;
  let inline:InlineBaseRequest|undefined;
  if(value.inline!==undefined){
    const source=value.inline;
    if(!data(source)||typeof source.documentText!=='string'||typeof source.source!=='string'||source.source!==value.baseSource
      ||![source.from,source.to,source.contentFrom,source.contentTo].every(count)
      ||source.from>source.contentFrom||source.contentFrom>source.contentTo||source.contentTo>source.to||source.to>source.documentText.length)return;
    const parsed=inlineBaseRequest(source.documentText,source.from,source.to);
    if(!parsed||parsed.contentFrom!==source.contentFrom||parsed.contentTo!==source.contentTo||parsed.source!==source.source)return;
    inline=parsed;
  }
  return Object.freeze({scope:Object.freeze({vaultId:value.scope.vaultId,clientId:value.scope.clientId}),paneId:value.paneId,tabId:value.tabId,
    basePath:value.basePath,baseEntryId:value.baseEntryId,baseRevision:value.baseRevision,baseSource:value.baseSource,
    ...(value.viewId===undefined?{}:{viewId:value.viewId}),viewIndex:value.viewIndex,navigationIntent:value.navigationIntent,activationRevision:value.activationRevision,
    ...(inline?{inline}:{})});
}
function sameActor(left:CollectionCreatedPresentationGuard,right:CollectionCreatedPresentationGuard):boolean {
  const a=left.inline,b=right.inline,sameInline=!a&&!b||!!a&&!!b&&a.documentText===b.documentText&&a.from===b.from&&a.to===b.to&&a.contentFrom===b.contentFrom&&a.contentTo===b.contentTo&&a.source===b.source;
  return left.scope.vaultId===right.scope.vaultId&&left.scope.clientId===right.scope.clientId&&left.paneId===right.paneId
    &&left.basePath===right.basePath&&left.baseEntryId===right.baseEntryId&&left.baseRevision===right.baseRevision&&left.baseSource===right.baseSource
    &&left.viewId===right.viewId&&left.viewIndex===right.viewIndex&&sameInline;
}
function publishedEntry(value:unknown):DatabaseEntry|undefined {
  if(!data(value)||!['entryId','path','collectionId','revision','fileRevision'].every(key=>text(value[key]))
    ||value.deleted!==false||value.pendingProjection!==false||!data(value.values)
    ||value.problems!==undefined&&(!data(value.problems)||Reflect.ownKeys(value.problems).length!==0))return;
  const values:Record<string,DatabaseValue>={};
  for(const [key,item]of Object.entries(value.values)){
    let copied:DatabaseValue;
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))copied=item;
    else if(Array.isArray(item)&&Object.getPrototypeOf(item)===Array.prototype&&Reflect.ownKeys(item).length===item.length+1){
      const items:string[]=[];
      for(let index=0;index<item.length;index++){
        const descriptor=Object.getOwnPropertyDescriptor(item,String(index));
        if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string')return;
        items.push(descriptor.value);
      }
      copied=Object.freeze(items);
    }
    else return;
    Object.defineProperty(values,key,{value:copied,enumerable:true});
  }
  return Object.freeze({entryId:value.entryId,path:value.path,collectionId:value.collectionId,revision:value.revision,fileRevision:value.fileRevision,
    deleted:false,pendingProjection:false,values:Object.freeze(values),...(value.problems===undefined?{}:{problems:Object.freeze({})})});
}
function receiptIdentity(entry:DatabaseEntry):string {
  return JSON.stringify([entry.entryId,entry.path,entry.collectionId,entry.revision,entry.fileRevision,Object.entries(entry.values).sort(([left],[right])=>left<right?-1:left>right?1:0),Object.hasOwn(entry,'problems')]);
}

/** Retains one UI intention across rebuilding. It never creates an entry,
 * changes a receipt, or searches for a similar Base, view, path or occurrence. */
export function createCollectionCreatedPresentation(capture:CollectionCreatedPresentationCapture):CollectionCreatedPresentation {
  const original=guard(capture),requested=data(capture)&&data(capture.requested)?capture.requested:undefined;
  if(!original||!requested||!['entryId','path','collectionId'].every(key=>text(requested[key])))throw new Error('The original created-entry presentation identity is incomplete.');
  const target=Object.freeze({entryId:requested.entryId,path:requested.path,collectionId:requested.collectionId});
  let frozen=false,cancelled=false,entry:DatabaseEntry|undefined,identity:string|undefined;
  return{
    freeze(currentOriginal){
      if(cancelled)return false;
      let current:CollectionCreatedPresentationGuard|undefined;try{current=guard(currentOriginal);}catch{/* Malformed snapshots cannot authorize presentation. */}
      if(!current||!sameActor(original,current)||current.tabId!==original.tabId||current.navigationIntent!==original.navigationIntent||current.activationRevision!==original.activationRevision){cancelled=true;return false;}
      frozen=true;return true;
    },
    committed(value){
      let next:DatabaseEntry|undefined;try{next=publishedEntry(value);}catch{/* Storage remains owned by Core even when a UI receipt is unusable. */}
      if(!next||next.entryId!==target.entryId||next.path!==target.path||next.collectionId!==target.collectionId)return false;
      const nextIdentity=receiptIdentity(next);if(entry)return identity===nextIdentity;
      entry=next;identity=nextIdentity;return true;
    },
    canPresent(fresh){
      if(cancelled||!frozen||!entry)return false;
      try{
        if(!data(fresh)||fresh.originalTabId!==original.tabId||!data(fresh.reservation))return false;
        const current=guard(fresh.current),reservation=fresh.reservation;
        return!!current&&sameActor(original,current)&&text(reservation.tabId)&&[reservation.navigationIntent,reservation.activationRevision].every(count)
          &&current.tabId===reservation.tabId&&current.navigationIntent===reservation.navigationIntent&&current.activationRevision===reservation.activationRevision;
      }catch{return false;}
    },
    cancel(){cancelled=true;},get entry(){return entry;},
  };
}
