import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDocumentSearchSpec, mountDocumentSearch } from '../src/ui/document-search-controller.ts';
import type { DocumentCursor, DocumentPage, DocumentPin, DocumentRichQuery, DocumentService, DocumentSnapshotId } from '../src/core/document-semantics.ts';
import type { DocumentMaintenance, DocumentRuntimeUpdate } from '../src/core/document-runtime.ts';
import type { DocumentRichSearchPage, SearchSpec } from '../src/core/document-search-types.ts';
import type { DocumentSearchCallbacks, DocumentSearchFrame } from '../src/ui/document-search.ts';

function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
async function until(predicate:()=>boolean,label:string) { const end=Date.now()+1500; while(!predicate()){if(Date.now()>end)assert.fail(label);await new Promise(resolve=>setTimeout(resolve,2));} }
const source=(watermark:number)=>({localStoreId:'store',watermark:String(watermark)});
const snapshot=(generation:number):DocumentSnapshotId=>({localStoreId:'store',generationEpoch:'epoch',generation:String(generation),versions:{schema:2,extraction:'x',resolver:'r',query:'q'}});

function fixture(options:{acquire?:(index:number,current:boolean)=>Promise<boolean>;pageGate?:Promise<void>;registrationGate?:Promise<void>;pagination?:boolean}={}) {
  let generation=1,watermark=1,covered=1,revision=0,live=true,acquisitions=0,opens=0,starts=0,statusReads=0,unsubscribes=0;
  const listeners=new Set<(update:DocumentRuntimeUpdate|null)=>void>(),frames:DocumentSearchFrame[]=[],pins:{generation:number;closed:number}[]=[],queries:{generation:number;closed:number}[]=[];
  let callbacks!:DocumentSearchCallbacks;
  const update=():DocumentRuntimeUpdate=>({lifetime:'lifetime',revision:String(++revision),source:source(watermark),published:snapshot(generation),freshness:watermark===covered?'current':'lagging',phase:watermark===covered?'idle':'indexing',progress:null,coverageComplete:true,hasForegroundDemand:false,error:null});
  const emit=()=>{const value=update();for(const listener of [...listeners])listener(value);};
  const maintenance:DocumentMaintenance={
    async observeAndSubscribe(listener){listeners.add(listener);const captured=update();await options.registrationGate;return {snapshot:captured,unsubscribe(){if(listeners.delete(listener))unsubscribes++;}};},
    requestFreshness(){throw Error('The controller must use its bounded acquisition callback.');},
  };
  const unexpected=async():Promise<never>=>{throw Error('Unexpected index mutation or literal query');};
  const service:DocumentService={maintenance,richSearchAvailable:true,initialize:unexpected,rebuild:unexpected,begin:unexpected,pump:unexpected,publish:unexpected,discard:unexpected,
    status:async()=>{statusReads++;return {source:source(watermark),snapshot:snapshot(generation),coveredSource:source(covered),current:watermark===covered,rebuildRequired:false,coverageComplete:true};},
    open:async()=>{
      opens++;const selected=generation,selectedCovered=covered,pin={generation:selected,closed:0};pins.push(pin);
      return {pinId:String(opens) as DocumentPin['pinId'],snapshot:snapshot(selected),source:source(selectedCovered),coverageComplete:true,
        metadata:unexpected,search:unexpected,backlinks:unexpected,base:unexpected,close:async()=>{pin.closed++;},
        richSearch:async({spec})=>{
          starts++;let pageIndex=0;const query={generation:selected,closed:0};queries.push(query);
          return {queryId:String(starts),prepare:async()=>({state:'ready',cursor:'first' as DocumentCursor}),close:async()=>{query.closed++;},page:async()=>{
            pageIndex++;if(selected===1&&(!options.pagination||pageIndex>1))await options.pageGate;
            const firstContinued=selected===1&&options.pagination&&pageIndex===1;
            const files=selected===1&&!firstContinued?[]:[{entry:{id:'note',path:'Note.md',revision:selected===1?'old-revision':'saved-marker',kind:'file' as const,deleted:false},chunk:0,lastChunk:true,occurrenceCount:1,locations:[],snippets:[]}];
            const total=selected===1&&options.pagination?1:files.length;
            const value:DocumentRichSearchPage={snapshot:snapshot(selected),coverageComplete:true,next:null,scanComplete:!firstContinued,complete:!firstContinued,dialect:'zorid-search-rust-unicode-1',spec,explanation:null,files,
              totals:{files:{relation:firstContinued?'atLeast':'exact',value:total},occurrences:{relation:firstContinued?'atLeast':'exact',value:total}},coverage:{candidateFiles:1,evaluatedFiles:1,unavailableFiles:0,scanComplete:!firstContinued,queryCoverageComplete:!firstContinued},outputComplete:!firstContinued,work:{documents:1,sourceBytes:1,units:1}};
            return {cursor:firstContinued?'next' as DocumentCursor:null,result:{snapshot:snapshot(selected),source:source(selectedCovered),coverageComplete:true,value}} satisfies DocumentPage<DocumentRichSearchPage>;
          }} satisfies DocumentRichQuery;
        },
      };
    },
  };
  const controller=mountDocumentSearch({} as HTMLElement,{service,scopeId:'scope',isCurrent:()=>live,debounceMs:0,
    acquireFresh:async()=>{const index=++acquisitions,current=watermark===covered;return options.acquire?options.acquire(index,current):current;},onOpen:()=>{},
    viewFactory:(_parent,next)=>{callbacks=next;return {render:frame=>frames.push(structuredClone(frame)),focusQuery(){},destroy(){}};},
  });
  return {controller,service,frames,pins,queries,get callbacks(){return callbacks;},get frame(){return frames.at(-1)!;},get acquisitions(){return acquisitions;},get opens(){return opens;},get starts(){return starts;},get statusReads(){return statusReads;},get listeners(){return listeners.size;},get unsubscribes(){return unsubscribes;},
    search(){controller.setSpec({...initialDocumentSearchSpec,query:'external-marker'});},
    sourceChanged(){watermark=2;emit();},publish(){generation=2;covered=watermark;emit();},emit,
    replaceQuery(){controller.setSpec({...initialDocumentSearchSpec,query:'newer-query'});},
    retire(){live=false;controller.release();},
  };
}

test('a bounded lagging acquisition follows later publication without another file event or demand loop',async t=>{
  const ui=fixture();t.after(()=>ui.controller.close());ui.sourceChanged();ui.search();
  await until(()=>ui.frame.phase==='results','bounded acquisition did not settle');assert.equal(ui.opens,0);assert.deepEqual(ui.frame.actions,['refresh']);
  ui.publish();await until(()=>ui.frame.result?.snapshot.generation==='2','published generation was never searched');
  assert.equal(ui.frame.groups[0].entry.revision,'saved-marker');assert.equal(ui.frame.stale,false);assert.equal(ui.acquisitions,2);
  const reads=ui.statusReads;for(let index=0;index<12;index++)ui.emit();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(ui.acquisitions,2);assert.equal(ui.opens,1);assert.equal(ui.statusReads,reads,'duplicate idle frames must not trigger status polling');
});

test('publication racing an unresolved old acquisition is retained for the latest drive',async t=>{
  const held=deferred<boolean>();const ui=fixture({acquire:async index=>index===1?held.promise:true});t.after(()=>ui.controller.close());ui.search();
  await until(()=>ui.acquisitions===1,'initial acquisition missing');ui.sourceChanged();ui.publish();held.resolve(false);
  await until(()=>ui.frame.result?.snapshot.generation==='2','publication during acquisition was lost');
  assert.equal(ui.frame.groups.length,1);assert.equal(ui.opens,1);assert.equal(ui.pins[0].generation,2);
});

test('source motion retires a pending old page and repins after publication without repainting empty fresh results',async t=>{
  const held=deferred<void>();const ui=fixture({pageGate:held.promise});t.after(()=>ui.controller.close());ui.search();await until(()=>ui.starts===1,'old query missing');
  ui.sourceChanged();ui.publish();const afterEvent=ui.frames.length;held.resolve();
  await until(()=>ui.frame.result?.snapshot.generation==='2','pending query kept the old generation');
  assert.equal(ui.pins[0].closed,1);assert.equal(ui.queries[0].closed,1);
  assert.equal(ui.frames.slice(afterEvent).some(frame=>frame.phase==='results'&&!frame.stale&&frame.result?.snapshot.generation==='1'),false);
  assert.equal(ui.frame.groups.length,1);
});

test('a status witness labels a retained generation stale when source motion has no notification',async t=>{
  const ui=fixture();t.after(()=>ui.controller.close());ui.search();await until(()=>ui.frame.result?.snapshot.generation==='1','initial result missing');
  Object.assign(ui.service,{maintenance:undefined});
  ui.service.status=async()=>({source:source(2),snapshot:snapshot(1),coveredSource:source(1),current:false,rebuildRequired:false,coverageComplete:true});
  ui.replaceQuery();await until(()=>ui.frame.phase==='results'&&ui.frame.spec.query==='newer-query','replacement query did not settle');
  assert.equal(ui.frame.stale,true);assert.deepEqual(ui.frame.actions,['refresh']);assert.equal(ui.acquisitions,1,'a lagging same-head status must not create a demand loop');
});

test('close drains a late observer registration and cannot start a published replacement query',async()=>{
  const held=deferred<void>();const ui=fixture({registrationGate:held.promise});ui.search();await until(()=>ui.acquisitions===1,'initial query missing');
  const closed=ui.controller.close();ui.sourceChanged();ui.publish();held.resolve();await closed;
  assert.equal(ui.listeners,0);assert.equal(ui.unsubscribes,1);const starts=ui.starts;ui.emit();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ui.starts,starts);
});

test('receiver-first publication wins over an older registration snapshot',async t=>{
  const held=deferred<void>();const ui=fixture({registrationGate:held.promise});t.after(()=>ui.controller.close());ui.search();await until(()=>ui.starts===1,'initial query missing');
  ui.sourceChanged();ui.publish();held.resolve();await until(()=>ui.frame.result?.snapshot.generation==='2','new callback was overwritten by old registration snapshot');
  const opens=ui.opens;ui.emit();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ui.opens,opens);assert.equal(ui.frame.stale,false);
});

test('publication during a retained pagination request retires its old continuation and opens the current head',async t=>{
  const held=deferred<void>(),ui=fixture({pagination:true,pageGate:held.promise});t.after(()=>ui.controller.close());ui.search();
  await until(()=>ui.frame.actions.includes('loadMore'),'first retained page missing');
  ui.callbacks.onAction(ui.frame,'loadMore');await new Promise(resolve=>setTimeout(resolve,2));
  ui.sourceChanged();ui.publish();held.resolve();await until(()=>ui.frame.result?.snapshot.generation==='2','old continuation prevented repinning');
  assert.equal(ui.frame.groups.length,1);assert.equal(ui.frame.groups[0].entry.revision,'saved-marker');
  assert.equal(ui.pins[0].closed,1);assert.equal(ui.queries[0].closed,1);assert.equal(ui.opens,2);
});
