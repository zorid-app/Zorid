import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionCreatedPresentation} from '../src/bases/collection-created-presentation.ts';
import type {CollectionCreatedPresentationCapture,CollectionCreatedPresentationFreshGuard} from '../src/bases/collection-created-presentation.ts';
import type {DatabaseEntry} from '../src/core/databases.ts';
import {inlineBaseRequest} from '../src/bases/inline-base.ts';

function original():CollectionCreatedPresentationCapture{return{scope:{vaultId:'store',clientId:'window'},paneId:'pane',tabId:'old-tab',basePath:'Books.base',baseEntryId:'base-entry',baseRevision:'base-1',baseSource:'{"views":[{"id":"aaaaaaaaaaaa","type":"table","source":{"kind":"collection","id":"abcdefghijkl"}}]}',viewId:'aaaaaaaaaaaa',viewIndex:0,navigationIntent:7,activationRevision:12,requested:{entryId:'created-entry',path:'Books/New.md',collectionId:'abcdefghijkl'}};}
function receipt():DatabaseEntry{return{entryId:'created-entry',path:'Books/New.md',collectionId:'abcdefghijkl',revision:'entry-1',fileRevision:'file-1',deleted:false,pendingProjection:false,values:{mnopqrstuvwx:'Original value'}};}
function fresh(capture=original()):CollectionCreatedPresentationFreshGuard{return{originalTabId:capture.tabId,current:{...structuredClone(capture),tabId:'rebuilt-tab',navigationIntent:0,activationRevision:14},reservation:{tabId:'rebuilt-tab',navigationIntent:0,activationRevision:14}};}

test('a published original entry may be presented through a fresh aliased tab and rebased UI counters',()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured);assert.equal(intent.canPresent(fresh(captured)),false);assert.equal(intent.freeze(captured),true);assert.equal(intent.canPresent(fresh(captured)),false);assert.equal(intent.committed(receipt()),true);assert.equal(intent.canPresent(fresh(captured)),true);assert.equal(intent.canPresent(fresh(captured)),true);
 assert.notEqual(fresh(captured).current.tabId,captured.tabId);assert.notEqual(fresh(captured).current.navigationIntent,captured.navigationIntent);assert.notEqual(fresh(captured).current.activationRevision,captured.activationRevision);
});
for(const field of ['navigationIntent','activationRevision','paneId','tabId','basePath','baseEntryId','baseRevision','baseSource','viewId','viewIndex'] as const)test(`moving original ${field} before ACK permanently cancels only presentation`,()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),moved=structuredClone(captured) as any;moved[field]=typeof moved[field]==='number'?moved[field]+1:moved[field]+'-moved';
 assert.equal(intent.freeze(moved),false);assert.equal(intent.freeze(captured),false);assert.equal(intent.committed(receipt()),true);assert.deepEqual(intent.entry,receipt());assert.equal(intent.canPresent(fresh(captured)),false);
});
for(const field of ['paneId','basePath','baseEntryId','baseRevision','baseSource','viewId','viewIndex'] as const)test(`a fresh different ${field} cannot present the created file`,()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),current=fresh(captured) as any;intent.freeze(captured);intent.committed(receipt());current.current[field]=typeof current.current[field]==='number'?current.current[field]+1:current.current[field]+'-different';assert.equal(intent.canPresent(current),false);
});
for(const field of ['vaultId','clientId'] as const)test(`a foreign ${field} never adopts the original presentation`,()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),current=fresh(captured);intent.freeze(captured);intent.committed(receipt());(current.current.scope as any)[field]+='-foreign';assert.equal(intent.canPresent(current),false);
 const other=createCollectionCreatedPresentation(captured),foreign=structuredClone(captured);(foreign.scope as any)[field]+='-foreign';assert.equal(other.freeze(foreign),false);other.committed(receipt());assert.equal(other.canPresent(fresh(captured)),false);
});
for(const field of ['tabId','navigationIntent','activationRevision'] as const)test(`fresh user movement of ${field} after reservation prevents presentation`,()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),current=fresh(captured) as any;intent.freeze(captured);intent.committed(receipt());current.current[field]=typeof current.current[field]==='number'?current.current[field]+1:current.current[field]+'-new';assert.equal(intent.canPresent(current),false);
});
test('the caller must resolve the original tab alias, not a similar tab at the same path',()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),current=fresh(captured);intent.freeze(captured);intent.committed(receipt());(current as any).originalTabId='another-old-tab';assert.equal(intent.canPresent(current),false);
});
test('an inline presentation retains the exact containing document and fence occurrence',()=>{
 const captured=original();const source=captured.baseSource+'\n',block='```base\n'+source+'```';(captured as any).baseSource=source;(captured as any).inline={documentText:block+'\n\n'+block,from:0,to:block.length,contentFrom:8,contentTo:8+source.length,source};
 const intent=createCollectionCreatedPresentation(captured);assert.equal(intent.freeze(captured),true);intent.committed(receipt());assert.equal(intent.canPresent(fresh(captured)),true);
 for(const field of ['documentText','from','to','contentFrom','contentTo','source'] as const){const changed=fresh(captured) as any;changed.current.inline[field]=typeof changed.current.inline[field]==='number'?changed.current.inline[field]+1:changed.current.inline[field]+'x';assert.equal(intent.canPresent(changed),false,field);}
 const missing=fresh(captured) as any;delete missing.current.inline;assert.equal(intent.canPresent(missing),false);
});
for(const change of ['entryId','path','collectionId','deleted','pending','missing-file-revision','empty-file-revision','problems'] as const)test(`a ${change} Native receipt cannot prove a published created entry`,()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),entry=receipt() as any;intent.freeze(captured);
 if(['entryId','path','collectionId'].includes(change))entry[change]+='-wrong';else if(change==='deleted')entry.deleted=true;else if(change==='pending')entry.pendingProjection=true;else if(change==='missing-file-revision')entry.fileRevision=null;else if(change==='empty-file-revision')entry.fileRevision='';else entry.problems={mnopqrstuvwx:'Could not publish'};
 assert.equal(intent.committed(entry),false);assert.equal(intent.entry,undefined);assert.equal(intent.canPresent(fresh(captured)),false);
});
test('the first published receipt is immutable and only an exact repeated receipt is idempotent',()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),entry=receipt();intent.freeze(captured);assert.equal(intent.committed(entry),true);const pinned=intent.entry;assert.ok(Object.isFrozen(pinned));assert.ok(Object.isFrozen(pinned!.values));(entry.values as any).mnopqrstuvwx='Caller mutation';assert.equal(intent.entry!.values.mnopqrstuvwx,'Original value');assert.equal(intent.committed(receipt()),true);assert.equal(intent.entry,pinned);
 for(const field of ['revision','fileRevision'] as const){const changed=receipt();(changed as any)[field]+='-later';assert.equal(intent.committed(changed),false);assert.equal(intent.entry,pinned);}
 const changed=receipt();(changed.values as any).mnopqrstuvwx='Different';assert.equal(intent.committed(changed),false);assert.equal(intent.entry,pinned);
});
test('capturing and canceling presentation cannot rewrite the requested target or erase a committed file',()=>{
 const captured=original(),intent=createCollectionCreatedPresentation(captured),expected=structuredClone(captured);(captured.requested as any).path='Caller changed.md';(captured.scope as any).vaultId='foreign';(captured as any).baseSource='Changed';
 assert.equal(intent.freeze(expected),true);assert.equal(intent.committed(receipt()),true);intent.cancel();intent.cancel();assert.equal(intent.canPresent(fresh(expected)),false);assert.deepEqual(intent.entry,receipt());assert.equal(receipt().path,'Books/New.md');
});
test('a legacy saved view with no UUID remains bound to its exact index and source',()=>{
 const captured=original();delete(captured as any).viewId;const intent=createCollectionCreatedPresentation(captured);assert.equal(intent.freeze(captured),true);assert.equal(intent.committed(receipt()),true);assert.equal(intent.canPresent(fresh(captured)),true);const moved=fresh(captured) as any;moved.current.viewIndex=1;assert.equal(intent.canPresent(moved),false);
});
test('malformed guard and receipt accessors are rejected without invoking caller code',()=>{
 let reads=0;const captured=original(),intent=createCollectionCreatedPresentation(captured),entry=receipt();Object.defineProperty(entry,'fileRevision',{get(){reads++;return'forged';}});assert.equal(intent.committed(entry),false);const current=fresh(captured) as any;Object.defineProperty(current.current,'baseSource',{get(){reads++;return captured.baseSource;}});intent.freeze(captured);intent.committed(receipt());assert.equal(intent.canPresent(current),false);assert.equal(reads,0);
});
test('a caller iterator cannot execute while a Native value list is snapshotted',()=>{
 let calls=0;const captured=original(),intent=createCollectionCreatedPresentation(captured),entry=receipt(),values=['one'];Object.defineProperty(values,Symbol.iterator,{value(){calls++;return[][Symbol.iterator]();}});(entry.values as any).mnopqrstuvwx=values;assert.equal(intent.committed(entry),false);assert.equal(calls,0);assert.equal(intent.entry,undefined);
});
test('in-bounds inline coordinates must prove the actual parsed containing source',()=>{
 const captured=original(),block='```base\n'+captured.baseSource+'\n```',inline=inlineBaseRequest(block,0,block.length)!;assert.ok(inline);(captured as any).inline=inline;(captured as any).baseSource=inline.source;
 const wrong=structuredClone(captured) as any;wrong.inline.contentFrom++;assert.throws(()=>createCollectionCreatedPresentation(wrong),/identity is incomplete/);
 const intent=createCollectionCreatedPresentation(captured);intent.freeze(captured);intent.committed(receipt());const current=fresh(captured) as any;current.current.inline.contentFrom++;assert.equal(intent.canPresent(current),false);
});
test('a quoted CRLF occurrence keeps the parser-normalized Base source without retargeting',()=>{
 const captured=original(),source=captured.baseSource,block='> ```base\r\n> '+source+'\r\n> ```',inline=inlineBaseRequest(block,0,block.length)!;assert.ok(inline);assert.equal(inline.source,source+'\n');assert.notEqual(block.slice(inline.contentFrom,inline.contentTo),inline.source);(captured as any).inline=inline;(captured as any).baseSource=inline.source;
 const intent=createCollectionCreatedPresentation(captured);assert.equal(intent.freeze(captured),true);assert.equal(intent.committed(receipt()),true);assert.equal(intent.canPresent(fresh(captured)),true);
});
