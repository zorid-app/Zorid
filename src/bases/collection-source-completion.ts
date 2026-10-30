import {captureDatabaseRequest,validateDatabaseValue} from '../../desktop/databases.cjs';
import type {DatabaseCollection,DatabasePropertyInput,DatabaseProperty,DatabaseRequest,DatabaseResponse} from '../core/databases.ts';
import {BaseDocument,baseViewSource,resetViewSourcePatch} from './document.ts';
import type {BaseViewPatch} from './document.ts';

export type CollectionSourceCompletionKind =
  | Readonly<{type:'change-source'}>
  | Readonly<{type:'add-view';viewType:string;viewName:string}>
  | Readonly<{type:'append-properties';collection:DatabaseCollection;originalOrder:readonly string[]}>
  | Readonly<{type:'none'}>;
export interface CaptureCollectionSourceCompletionOptions {
  readonly source:string;
  readonly entryId:string;
  readonly revision:string;
  readonly viewIndex:number;
  readonly viewId?:string;
  readonly kind:CollectionSourceCompletionKind;
}
export interface CompletedCollectionSource {
  readonly expectedSource:string;
  readonly desiredSource:string;
  readonly entryId:string;
  readonly revision:string;
  readonly viewIndex:number;
  readonly viewId?:string;
}
export interface CollectionSourceCompletion {
  complete(receipt:DatabaseResponse,command:DatabaseRequest):CompletedCollectionSource;
}
const fail=():never=>{throw new Error('The accepted collection completion no longer matches its original source or command.');};
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function matchesProperty(input:DatabasePropertyInput,actual:DatabaseProperty):boolean {
  return (input.id===undefined||input.id===actual.id)&&input.name===actual.name&&input.datatype===actual.datatype
    &&same(input.default,actual.default)&&(input.options??[]).length===actual.options.length
    &&(input.options??[]).every((option,index)=>{
      const next=actual.options[index];
      return !!next&&(option.id===undefined||option.id===next.id)&&option.name===next.name&&option.category===next.category&&option.color===next.color;
    });
}
function relevantCollection(command:DatabaseRequest,receipt:DatabaseResponse):DatabaseCollection {
  if(['list','get','get_entry','compose','retry'].includes(command.op))return fail();
  const matches=receipt.collections.filter(collection=>command.op==='create'
    ?collection.name===command.name&&!collection.deleted
    :'collectionId'in command?collection.id===command.collectionId
      :receipt.entries.some(entry=>entry.entryId===(command.op==='duplicate_entry'?command.newEntryId:'entryId'in command?command.entryId:undefined)&&entry.collectionId===collection.id));
  if(matches.length!==1||receipt.collections.length!==1)return fail();
  const collection=matches[0];
  if(command.op==='delete'?!collection.deleted:collection.deleted)return fail();
  if(command.op==='update'&&(collection.name!==command.name||collection.properties.length!==command.properties.length
    ||!command.properties.every((property,index)=>matchesProperty(property,collection.properties[index]))))return fail();
  if(command.op==='create'&&command.properties&&(collection.properties.length!==command.properties.length
    ||!command.properties.every((property,index)=>matchesProperty(property,collection.properties[index]))))return fail();
  if(command.op==='create_entry'||command.op==='set_entry'||command.op==='duplicate_entry'){
    const entryId=command.op==='duplicate_entry'?command.newEntryId:command.entryId;
    const entries=receipt.entries.filter(entry=>entry.entryId===entryId),entry=entries[0];
    if(entries.length!==1||entry.deleted||entry.pendingProjection||Object.keys(entry.problems??{}).length
      ||entry.collectionId!==collection.id||('path'in command&&entry.path!==command.path)
      ||('values'in command&&command.values&&Object.entries(command.values).some(([field,value])=>!same(value,entry.values[field]))))return fail();
  }
  return collection;
}

/** Captures only a source transformation. The caller must still prove the exact
 * original file identity/revision and whole-source CAS before publishing it.
 * No IO, Native authority, current editor state or replacement planning occurs. */
export function captureCollectionSourceCompletion(options:CaptureCollectionSourceCompletionOptions):CollectionSourceCompletion {
  const {source,entryId,revision,viewIndex,viewId}=options;
  if(typeof source!=='string'||typeof entryId!=='string'||!entryId||typeof revision!=='string'||!revision
    ||!Number.isSafeInteger(viewIndex)||viewIndex<0)return fail();
  const kind=freeze(structuredClone(options.kind)),document=BaseDocument.parse(source),originalView=document.views[viewIndex];
  if(!originalView||viewId!==undefined&&originalView.id!==viewId)return fail();
  let completionIndex=viewIndex,sourcePatch:BaseViewPatch|undefined;
  if(kind.type==='change-source')sourcePatch=freeze(resetViewSourcePatch(originalView,{kind:'untyped'}));
  else if(kind.type==='add-view')completionIndex=document.addView(kind.viewType,kind.viewName);
  else if(kind.type==='append-properties'){
    const checked=validateDatabaseValue({schemaVersion:1,command:{op:'get',collectionId:kind.collection.id}},
      {collections:[kind.collection],entries:[],projection:{pending:0,issues:[]}});
    const selected=baseViewSource(originalView);
    if(checked.collections[0].deleted||selected.kind!=='collection'||selected.id!==kind.collection.id
      ||!Array.isArray(kind.originalOrder)||kind.originalOrder.some(value=>typeof value!=='string')
      ||new Set(kind.originalOrder).size!==kind.originalOrder.length
      ||originalView.order!==undefined&&!same(originalView.order,kind.originalOrder))return fail();
  }else if(kind.type!=='none')return fail();
  const preparedSource=document.toString();
  let commandFingerprint:string|undefined,receiptFingerprint:string|undefined,result:CompletedCollectionSource|undefined;
  return Object.freeze({complete(rawReceipt:DatabaseResponse,rawCommand:DatabaseRequest):CompletedCollectionSource {
    const request=captureDatabaseRequest({schemaVersion:1,command:rawCommand}),fingerprint=JSON.stringify(request);
    if(commandFingerprint!==undefined&&commandFingerprint!==fingerprint)return fail();
    commandFingerprint=fingerprint;
    const receipt=validateDatabaseValue(request,rawReceipt),receiptKey=JSON.stringify(receipt);
    if(result){if(receiptFingerprint!==receiptKey)return fail();return result;}
    if(receipt.projection.pending||receipt.projection.issues.length)throw new Error('The collection completion is waiting for verified file publication.');
    const command=request.command as DatabaseRequest,collection=relevantCollection(command,receipt);
    const next=BaseDocument.parse(preparedSource);
    if(kind.type==='change-source'||kind.type==='add-view'){
      if(command.op!=='create')return fail();
      if(kind.type==='change-source')next.updateView(completionIndex,{...sourcePatch!,source:{kind:'collection',id:collection.id}});
      else next.updateView(completionIndex,{source:{kind:'collection',id:collection.id}});
    }else if(kind.type==='append-properties'){
      const before=kind.collection;
      if(command.op!=='update'||command.collectionId!==before.id||command.expectedRevision!==before.revision
        ||command.properties.length<before.properties.length
        ||!before.properties.every((property,index)=>matchesProperty(property,collection.properties[index]))
        ||!before.properties.every((property,index)=>command.properties[index].id===property.id&&matchesProperty(command.properties[index],property)))return fail();
      const previousIds=new Set(before.properties.map(property=>property.id)),added=collection.properties.filter(property=>!previousIds.has(property.id));
      const order=[...kind.originalOrder];
      for(const property of added){const id=`note.${property.id}`;if(!order.includes(id))order.push(id);}
      next.updateView(completionIndex,{order});
    }
    const completedView=next.views[completionIndex];
    result=freeze({expectedSource:source,desiredSource:kind.type==='none'?source:next.toString(),entryId,revision,
      viewIndex:completionIndex,...(typeof completedView.id==='string'?{viewId:completedView.id}:{})});
    receiptFingerprint=receiptKey;return result;
  }});
}
