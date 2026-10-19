import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSemanticsError } from '../src/core/document-semantics.ts';
import type { DocumentCursor, DocumentPage, DocumentPin, DocumentRichQuery, DocumentService, DocumentSnapshotId } from '../src/core/document-semantics.ts';
import type { DocumentRichSearchPage, SearchFileChunk, SearchSpec } from '../src/core/document-search-types.ts';
import { initialDocumentSearchSpec, mountDocumentSearch } from '../src/ui/document-search-controller.ts';
import type { DocumentSearchCallbacks, DocumentSearchFrame } from '../src/ui/document-search.ts';
const source={localStoreId:'store',watermark:'1'};
const snapshot:DocumentSnapshotId={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:2,extraction:'x',resolver:'r',query:'q'}};
const entry={id:'note',path:'Note.md',revision:'rev',kind:'file' as const,deleted:false};
const chunk=(index=0,last=true,count=5):SearchFileChunk=>({entry,chunk:index,lastChunk:last,occurrenceCount:count,locations:[{index,locator:{origin:'source',range:{bytes:[index,index+1],utf16:[index,index+1]},kind:'occurrence'},role:'occurrence',occurrences:1}],snippets:[{origin:'source',text:'x',originRange:{bytes:[index,index+1],utf16:[index,index+1]},primaryLocationIndex:index,highlights:[{utf16:[0,1],locationIndices:[index]}],clippedBefore:false,clippedAfter:false}]});
function page(spec:SearchSpec,files:readonly SearchFileChunk[]=[chunk()],cursor:string|null=null,overrides:Partial<DocumentRichSearchPage>={}):DocumentPage<DocumentRichSearchPage>{
  return {cursor:cursor as DocumentCursor|null,result:{snapshot,source,coverageComplete:true,value:{snapshot,coverageComplete:true,next:null,scanComplete:cursor===null,complete:cursor===null,dialect:'zorid-search-rust-unicode-1',spec,explanation:null,files,totals:{files:{relation:cursor?'atLeast':'exact',value:files.length?1:0},occurrences:{relation:cursor?'atLeast':'exact',value:files.length?5:0}},coverage:{candidateFiles:1,evaluatedFiles:1,unavailableFiles:0,scanComplete:cursor===null,queryCoverageComplete:cursor===null},outputComplete:cursor===null,work:{documents:1,sourceBytes:1,units:1},...overrides}}};
}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function until(predicate:()=>boolean){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)assert.fail('Timed out');await new Promise(r=>setTimeout(r,2));}}
function fixture(config:{query?:(spec:SearchSpec,index:number)=>Promise<DocumentRichQuery>;open?:()=>Promise<void>;closePin?:()=>Promise<void>;acquire?:()=>Promise<boolean>;onOpen?:()=>Promise<void>}={}){
  const frames:DocumentSearchFrame[]=[],events:string[]=[],opened:any[]=[];let callbacks!:DocumentSearchCallbacks,opens=0,fresh=0,alive=true;
  const unused=async():Promise<never>=>{throw new Error('unexpected');};
  const query=(spec:SearchSpec):DocumentRichQuery=>({queryId:spec.query,prepare:async()=>({state:'ready',cursor:'start' as DocumentCursor}),page:async()=>page(spec),close:async()=>{events.push(`close:${spec.query}`);}});
  const service:DocumentService={status:unused,initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,open:async()=>{
    opens++;events.push('open');await config.open?.();
    return {snapshot,source,coverageComplete:true,pinId:'pin' as DocumentPin['pinId'],metadata:unused,search:unused,backlinks:unused,base:unused,
      close:async()=>{events.push('closePin');await config.closePin?.();},richSearch:async({spec})=>{events.push(`start:${spec.query}`);return config.query?config.query(spec,events.filter(e=>e.startsWith('start:')).length):query(spec);}};
  }};
  const controller=mountDocumentSearch({} as HTMLElement,{service,scopeId:'scope',isCurrent:()=>alive,debounceMs:0,
    acquireFresh:async()=>{fresh++;return config.acquire?config.acquire():true;},
    onOpen:async(...args)=>{opened.push(args);await config.onOpen?.();},viewFactory:(_,next)=>{callbacks=next;return {render(frame){frames.push(structuredClone(frame));},focusQuery(){},destroy(){events.push('destroy');}};}});
  const spec=(query:string,extra:Partial<SearchSpec>={})=>({...initialDocumentSearchSpec,query,...extra});
  return {controller,frames,events,opened,spec,get callbacks(){return callbacks;},get frame(){return frames.at(-1)!;},get opens(){return opens;},get fresh(){return fresh;},set alive(value:boolean){alive=value;},async search(query:string,extra:Partial<SearchSpec>={}){controller.setSpec(spec(query,extra));await until(()=>frames.at(-1)?.phase!=='loading');await controller.ready;}};
}

test('query/options reuse one pin and freshness; core counts repeated in chunks are never summed',async()=>{
  let pages=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++pages===1?page(spec,[chunk(0,false)],'1',{scanComplete:true,coverage:{candidateFiles:1,evaluatedFiles:1,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true},totals:{files:{relation:'exact',value:1},occurrences:{relation:'exact',value:5}}}):page(spec,[chunk(1)]),close:async()=>{}})});
  await ui.search('x');assert.equal(ui.frame.groups[0].occurrenceCount,5);assert.equal(ui.frame.result?.coverage.scanComplete,true);assert.equal(ui.frame.result?.outputComplete,false);assert.deepEqual(ui.frame.actions,['loadMore']);
  ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;
  assert.equal(ui.frame.groups.length,1);assert.equal(ui.frame.groups[0].occurrenceCount,5);assert.equal(ui.frame.groups[0].snippets.length,2);assert.equal(ui.frame.result?.complete,true);
  await ui.search('x',{caseSensitive:true,sort:'createdAsc',context:'section',explain:true});assert.equal(ui.opens,1);assert.equal(ui.fresh,1);await ui.controller.close();
});

test('rapid inputs coalesce; pending old page cannot repaint and old query closes before latest starts',async()=>{
  const pending=deferred<DocumentPage<DocumentRichSearchPage>>();let firstSpec!:SearchSpec;
  const ui=fixture({query:async spec=>({queryId:spec.query,prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>{if(spec.query==='old'){firstSpec=spec;return pending.promise;}return page(spec);},close:async()=>{ui.events.push(`closed:${spec.query}`);}})});
  ui.controller.setSpec(ui.spec('old'));await until(()=>!!firstSpec);
  ui.controller.setSpec(ui.spec('middle'));ui.controller.setSpec(ui.spec('latest'));await new Promise(r=>setTimeout(r,5));pending.resolve(page(firstSpec));
  await until(()=>ui.frame.phase==='results'&&ui.frame.spec.query==='latest');
  assert.equal(ui.events.includes('start:middle'),false);assert.ok(ui.events.indexOf('closed:old')<ui.events.indexOf('start:latest'));assert.equal(ui.opens,1);await ui.controller.close();
});

test('source events coalesce; old coherent groups remain stale until fresh page arrives',async()=>{
  const pending=deferred<DocumentPage<DocumentRichSearchPage>>();let starts=0,latestSpec!:SearchSpec;
  const ui=fixture({query:async spec=>({queryId:String(++starts),prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>{latestSpec=spec;return starts===1?page(spec):pending.promise;},close:async()=>{}})});
  await ui.search('x');ui.controller.invalidateSource();ui.controller.invalidateSource();assert.equal(ui.frame.stale,true);assert.equal(ui.frame.groups.length,1);
  await until(()=>starts===2);assert.equal(ui.frame.groups.length,1);assert.equal(ui.frame.stale,true);pending.resolve(page(latestSpec));await ui.controller.ready;
  assert.equal(ui.opens,2);assert.equal(ui.fresh,2);assert.equal(ui.frame.stale,false);await ui.controller.close();
});

test('empty progress pages continue without invented No Results; query coverage and output remain independent',async()=>{
  let count=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++count===1?page(spec,[],'1',{totals:{files:{relation:'atLeast',value:0},occurrences:{relation:'atLeast',value:0}},coverage:{candidateFiles:1,evaluatedFiles:0,unavailableFiles:0,scanComplete:false,queryCoverageComplete:false}}):page(spec,[],null,{complete:false,coverageComplete:false,coverage:{candidateFiles:1,evaluatedFiles:0,unavailableFiles:1,scanComplete:true,queryCoverageComplete:false},totals:{files:{relation:'atLeast',value:0},occurrences:{relation:'atLeast',value:0}}}),close:async()=>{}})});
  await ui.search('x');assert.equal(count,2);assert.equal(ui.frame.phase,'results');assert.equal(ui.frame.result?.complete,false);assert.equal(ui.frame.result?.coverage.unavailableFiles,1);assert.equal(ui.frame.actions.length,0);await ui.controller.close();
});

test('preparing request superseded then restored resumes preparation rather than reporting empty results',async()=>{
  const prepared=deferred<Awaited<ReturnType<DocumentRichQuery['prepare']>>>();let calls=0;
  const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>++calls===1?prepared.promise:{state:'ready',cursor:'0' as DocumentCursor},page:async()=>page(spec),close:async()=>{}})});
  ui.controller.setSpec(ui.spec('x'));await until(()=>calls===1);ui.controller.setSpec(ui.spec('y'));ui.controller.setSpec(ui.spec('x'));await new Promise(r=>setTimeout(r,5));prepared.resolve({state:'preparing'});
  await until(()=>ui.frame.phase==='results');assert.equal(ui.frame.groups.length,1);assert.equal(calls,2);await ui.controller.close();
});

test('failed query close retains ownership for acknowledgment retry and forbids replacement query',async()=>{
  let closeAttempts=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>page(spec),close:async()=>{if(++closeAttempts===1)throw new Error('no ack');}})});
  await ui.search('x');await ui.search('y');assert.equal(ui.frame.phase,'error');assert.equal(ui.events.includes('start:y'),false);assert.equal(ui.opens,1);
  await ui.controller.close();assert.equal(closeAttempts,2);assert.equal(ui.events.filter(e=>e==='closePin').length,1);
});

test('late pin open after close is retired, no query created; release is final cleanup acknowledgment',async()=>{
  const opening=deferred<void>();const ui=fixture({open:()=>opening.promise});ui.controller.setSpec(ui.spec('x'));await until(()=>ui.opens===1);
  const closed=ui.controller.close();opening.resolve();await closed;assert.equal(ui.events.some(e=>e.startsWith('start:')),false);assert.equal(ui.events.filter(e=>e==='closePin').length,1);
  const pending=deferred<void>();const released=fixture({open:()=>pending.promise});released.controller.setSpec(released.spec('x'));await until(()=>released.opens===1);released.controller.release();pending.resolve();await released.controller.ready;assert.equal(released.events.includes('closePin'),false);
});

test('failed pin close retries same service; another controller vault is independent',async()=>{
  let attempts=0;const old=fixture({closePin:async()=>{if(++attempts===1)throw new Error('ack');}});await old.search('x');await assert.rejects(old.controller.close());
  const next=fixture();await next.search('other vault');assert.equal(next.opens,1);await old.controller.close();assert.equal(attempts,2);await next.controller.close();
});

test('stale action identities are retired and source locators pass unchanged to guarded navigation',async()=>{
  const ui=fixture();await ui.search('x');const old=ui.frame;ui.controller.setSpec(ui.spec('y'));ui.callbacks.onOpen(old,entry,chunk().locations[0],{primary:false,shift:false,alt:false});ui.callbacks.onAction(old,'refresh');
  await new Promise(r=>setTimeout(r,5));await ui.controller.ready;assert.equal(ui.opened.length,0);
  ui.callbacks.onOpen(ui.frame,entry,chunk().locations[0],{primary:true,shift:false,alt:false});await Promise.resolve();await Promise.resolve();assert.equal(ui.opened.length,1);assert.deepEqual(ui.opened[0][1],chunk().locations[0]);await ui.controller.close();assert.equal(ui.opened[0][3](),false);
});

test('inconsistent continuation counts reject without corrupting earlier coherent projection',async()=>{
  let calls=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++calls===1?page(spec,[chunk(0,false)],'1'):page(spec,[chunk(1,true,99)]),close:async()=>{}})});
  await ui.search('x');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;assert.equal(ui.frame.phase,'error');assert.equal(ui.frame.groups[0].occurrenceCount,5);assert.equal(ui.frame.groups[0].snippets.length,1);await ui.controller.close();
});

test('typed safe diagnostic copy and rich failures never invoke literal fallback',async()=>{
  const ui=fixture({query:async()=>{throw new DocumentSemanticsError('search_compile',{code:'invalid-nesting',queryRange:{bytes:[0,1],utf16:[0,1]},message:'Check the search expression.'});}});
  await ui.search('(');assert.equal(ui.frame.message,'Check the search expression.');assert.equal(ui.frame.phase,'error');await ui.controller.close();
});

test('unfinished first index exposes refresh and never fabricates an empty complete result',async()=>{
  let acquired=false;const ui=fixture({acquire:async()=>acquired});await ui.search('x');assert.equal(ui.frame.result,undefined);assert.equal(ui.opens,0);assert.deepEqual(ui.frame.actions,['refresh']);
  acquired=true;ui.callbacks.onAction(ui.frame,'refresh');await new Promise(r=>setTimeout(r,5));await ui.controller.ready;assert.equal(ui.frame.groups.length,1);await ui.controller.close();
});

test('display storage stays bounded and a new query can replace capped output',async()=>{
  let offset=0;
  const ui=fixture({query:async spec=>({queryId:spec.query,prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>{
    if(spec.query!=='many')return page(spec);
    const length=Math.min(100,201-offset),files=Array.from({length},(_,index)=>({...chunk(),entry:{...entry,id:String(offset+index),path:`${offset+index}.md`}}));offset+=length;
    const relation=offset===201?'exact':'atLeast';
    return page(spec,files,offset===201?null:String(offset),{totals:{files:{relation,value:offset},occurrences:{relation,value:offset*5}}});
  },close:async()=>{}})});
  await ui.search('many');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;assert.equal(ui.frame.groups.length,200);assert.equal(ui.frame.displayTruncated,true);assert.deepEqual(ui.frame.actions,[]);assert.match(ui.frame.message!,/Display limit/);
  await ui.search('one');assert.equal(ui.frame.groups.length,1);assert.equal(ui.frame.displayTruncated,false);await ui.controller.close();
});

test('late pin acquisition survives input-only replacement without reacquiring freshness or pin',async()=>{
  const opening=deferred<void>();const ui=fixture({open:()=>opening.promise});ui.controller.setSpec(ui.spec('old'));await until(()=>ui.opens===1);
  ui.controller.setSpec(ui.spec('latest'));await new Promise(r=>setTimeout(r,5));opening.resolve();await until(()=>ui.frame.phase==='results');
  assert.equal(ui.opens,1);assert.equal(ui.fresh,1);assert.equal(ui.events.includes('start:old'),false);assert.equal(ui.events.includes('start:latest'),true);await ui.controller.close();
});

test('continuation snippets may repeat identical stable location indices, deduplicated without adding counts',async()=>{
  let calls=0;const first=chunk(0,false),second={...chunk(1),locations:first.locations,snippets:first.snippets};
  const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++calls===1?page(spec,[first],'1'):page(spec,[second]),close:async()=>{}})});
  await ui.search('x');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;
  assert.equal(ui.frame.phase,'results');assert.equal(ui.frame.groups[0].locations.length,1);assert.equal(ui.frame.groups[0].snippets.length,2);assert.equal(ui.frame.groups[0].occurrenceCount,5);await ui.controller.close();
});

test('conflicting payload for a repeated per-file location rejects without corrupting prior group',async()=>{
  let calls=0;const first=chunk(0,false),second={...chunk(1),locations:[{...first.locations[0],occurrences:2}],snippets:first.snippets};
  const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++calls===1?page(spec,[first],'1'):page(spec,[second]),close:async()=>{}})});
  await ui.search('x');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;
  assert.equal(ui.frame.phase,'error');assert.equal(ui.frame.groups[0].locations.length,1);assert.equal(ui.frame.groups[0].locations[0].occurrences,1);assert.equal(ui.frame.groups[0].snippets.length,1);await ui.controller.close();
});

test('admitted navigation survives committed source refresh, while query/options replacement retires it',async()=>{
  const ui=fixture();await ui.search('x');ui.callbacks.onOpen(ui.frame,entry,undefined,{primary:false,shift:false,alt:false});await Promise.resolve();await Promise.resolve();
  const current=ui.opened[0][3];assert.equal(current(),true);ui.controller.invalidateSource();assert.equal(current(),true);
  ui.controller.setSpec(ui.spec('x',{caseSensitive:true}));assert.equal(current(),false);await ui.controller.close();
});

test('source epoch retires late old errors even when request identity stays stable for IME',async()=>{
  const pending=deferred<void>();let started=0;
  const ui=fixture({query:async spec=>{const index=++started;return {queryId:String(index),prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>{if(index===1){await pending.promise;throw new Error('old source failure');}return page(spec);},close:async()=>{}};}});
  ui.controller.setSpec(ui.spec('x'));await until(()=>started===1);const request=ui.frame.requestId;ui.controller.invalidateSource();assert.equal(ui.frame.requestId,request);
  await new Promise(r=>setTimeout(r,5));pending.resolve();await until(()=>ui.frame.phase==='results');assert.equal(ui.frames.some(frame=>frame.phase==='error'),false);assert.equal(ui.opens,2);await ui.controller.close();
});

test('newer admitted navigation retires older errors before they can repaint the latest successful click',async()=>{
  const pending=deferred<void>();let calls=0;const ui=fixture({onOpen:async()=>{if(++calls===1){await pending.promise;throw new Error('old navigation');}}});await ui.search('x');
  const activate=()=>ui.callbacks.onOpen(ui.frame,entry,undefined,{primary:false,shift:false,alt:false});
  activate();await until(()=>calls===1);const oldCurrent=ui.opened[0][3];activate();await until(()=>calls===2);assert.equal(oldCurrent(),false);
  pending.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(ui.frame.message,undefined);await ui.controller.close();
});

test('cross-page unique file/count lower bounds validate authoritative totals without replacing displayed counts',async()=>{
  for(const lowFiles of [true,false]){
    let calls=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++calls===1?page(spec,[chunk()],'1'):page(spec,[{...chunk(),entry:{...entry,id:'other',path:'Other.md'}}],null,{totals:{files:{relation:'exact',value:lowFiles?1:2},occurrences:{relation:'exact',value:lowFiles?10:5}}}),close:async()=>{}})});
    await ui.search('x');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;assert.equal(ui.frame.phase,'error');assert.equal(ui.frame.groups.length,1);assert.equal(ui.frame.result?.totals.occurrences.value,5);await ui.controller.close();
  }
});

test('positive deduplicated location-index cardinality cannot exceed the authoritative per-file count',async()=>{
  let calls=0;const ui=fixture({query:async spec=>({queryId:'q',prepare:async()=>({state:'ready',cursor:'0' as DocumentCursor}),page:async()=>++calls===1?page(spec,[chunk(0,false,1)],'1'):page(spec,[chunk(1,true,1)]),close:async()=>{}})});
  await ui.search('x');ui.callbacks.onAction(ui.frame,'loadMore');await ui.controller.ready;assert.equal(ui.frame.phase,'error');assert.equal(ui.frame.groups[0].occurrenceCount,1);assert.equal(ui.frame.groups[0].locations.length,1);await ui.controller.close();
});
