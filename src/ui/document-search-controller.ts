import { documentErrorCode, DocumentSemanticsError } from '../core/document-semantics.ts';
import type { DocumentCursor, DocumentEntry, DocumentPin, DocumentRichQuery, DocumentService } from '../core/document-semantics.ts';
import type { DocumentRichSearchPage, SearchLocation, SearchSpec } from '../core/document-search-types.ts';
import { createDocumentSearchView } from './document-search.ts';
import type { DocumentSearchCallbacks, DocumentSearchFrame, DocumentSearchGroup, DocumentSearchIdentity, DocumentSearchView } from './document-search.ts';

export const initialDocumentSearchSpec:SearchSpec=Object.freeze({query:'',caseSensitive:false,sort:'nameAsc',context:'line',explain:false});
export interface DocumentSearchControllerOptions {
  readonly service:DocumentService;
  readonly scopeId:string;
  readonly spec?:SearchSpec;
  readonly isCurrent:()=>boolean;
  /** Existing freshness acquisition policy, injected until core scheduling owns it. */
  readonly acquireFresh:(isCurrent:()=>boolean,rebuild:boolean)=>Promise<boolean>;
  readonly beforeOpen?:()=>Promise<void>;
  readonly onSpec?:(spec:SearchSpec)=>void;
  readonly onOpen:(entry:DocumentEntry,location:SearchLocation|undefined,modifiers:{readonly primary:boolean;readonly shift:boolean;readonly alt:boolean},isCurrent:()=>boolean)=>void|Promise<void>;
  readonly viewFactory?:(parent:HTMLElement,callbacks:DocumentSearchCallbacks)=>DocumentSearchView;
  readonly debounceMs?:number;
}
export interface DocumentSearchController {
  readonly service:DocumentService;
  readonly ready:Promise<void>;
  setSpec(spec:SearchSpec):void;
  invalidateSource():void;
  focusQuery():void;
  /** Retires actions immediately; failed acknowledgments retain ownership for retry. */
  close():Promise<void>;
  /** Successful platform-owner release acknowledges all pending resource cleanup. */
  release():void;
}
const sameSpec=(a:SearchSpec,b:SearchSpec)=>a.query===b.query&&a.caseSensitive===b.caseSensitive&&a.sort===b.sort&&a.context===b.context&&a.explain===b.explain;
const invalid=():never=>{throw new DocumentSemanticsError('invalid_document_response');};
const locationPayload=(location:SearchLocation):string=>{
  const value=location.locator,base=[location.role,location.occurrences,value.origin];
  switch(value.origin){
    case 'source':return JSON.stringify([...base,value.kind,value.range.bytes,value.range.utf16]);
    case 'filename':case 'path':return JSON.stringify([...base,value.range.bytes,value.range.utf16]);
    case 'propertyKey':return JSON.stringify([...base,value.key,value.match.kind,value.match.kind==='ranges'?value.match.ranges.map(range=>[range.bytes,range.utf16]):null]);
    case 'propertyValue':return JSON.stringify([...base,value.key,value.arrayPath,value.valueText,value.range.bytes,value.range.utf16]);
  }
};

/** Serial retained-query consumer. Every result is supplied by Rust; this module
 * only admits ordered chunks and bounds the projection retained for display. */
export function mountDocumentSearch(parent:HTMLElement,options:DocumentSearchControllerOptions):DocumentSearchController {
  const MAX_GROUPS=200,MAX_SNIPPETS=1000,MAX_BYTES=4*1024*1024;
  let spec={...(options.spec??initialDocumentSearchSpec)},request=0,sourceEpoch=0,pinEpoch=-1,navigationEpoch=0;
  let disposed=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  let pin:DocumentPin|undefined,query:DocumentRichQuery|undefined,cursor:DocumentCursor|null=null;
  let querySpec:SearchSpec|undefined,queryEpoch=-1,queryPrepared=false,queryHasPage=false;
  let groups:DocumentSearchGroup[]=[],lastPage:DocumentRichSearchPage|undefined,result:DocumentSearchFrame['result'];
  let truncated=false,retainedBytes=0,snippetCount=0,seenCursors=new Set<DocumentCursor>();
  let phase:DocumentSearchFrame['phase']='idle',message:string|undefined,stale=false,rebuild=false,needsRefresh=false;
  let scheduled=false,serial:Promise<void>=Promise.resolve(),ready:Promise<void>=Promise.resolve();
  let closing:Promise<void>|undefined;
  const live=()=>!disposed&&!released&&options.isCurrent();
  const identity=():DocumentSearchIdentity=>({scopeId:options.scopeId,requestId:String(request)});
  const admit=(id:DocumentSearchIdentity)=>live()&&id.scopeId===options.scopeId&&id.requestId===String(request);
  const actions=():DocumentSearchFrame['actions']=>phase==='error'?['rebuild_required','index_rebuild_required'].includes(documentErrorCode(lastError)??'')?['rebuild']:['retry']:
    (stale||needsRefresh)&&phase!=='loading'?['refresh']:cursor&&!truncated&&phase!=='loading'?['loadMore']:[];
  let lastError:unknown;
  const paint=()=>{if(live())view.render({...identity(),spec,phase,groups,result,stale,displayTruncated:truncated,canExplain:true,message,actions:actions()});};
  const view=(options.viewFactory??createDocumentSearchView)(parent,{
    onSearch(id,next){if(admit(id))setSpec(next);},
    onAction(id,action){if(!admit(id))return;if(action==='loadMore'){enqueue();}else{if(action==='rebuild')rebuild=true;invalidate();}},
    onOpen(id,entry,location,modifiers){
      if(!admit(id))return;
      const intent=++navigationEpoch,current=()=>live()&&navigationEpoch===intent;
      void Promise.resolve().then(()=>current()?options.onOpen(entry,location,modifiers,current):undefined).catch(()=>{
        if(current()){message='This result could not be opened. Refresh search and try again.';paint();}
      });
    },
  });
  function resetResults():void {groups=[];lastPage=undefined;result=undefined;truncated=false;retainedBytes=0;snippetCount=0;seenCursors=new Set();}
  async function closeQuery():Promise<void>{if(!query)return;const owned=query;await owned.close();if(!released&&query===owned){query=undefined;querySpec=undefined;cursor=null;}}
  async function closePin():Promise<void>{await closeQuery();if(!pin)return;const owned=pin;await owned.close();if(!released&&pin===owned){pin=undefined;pinEpoch=-1;}}
  function failure(error:unknown):void {
    if(!live())return;lastError=error;phase='error';stale=!!result;
    const code=documentErrorCode(error);
    // Only the shared decoder's typed compile diagnostic is safe user copy.
    message=error instanceof DocumentSemanticsError&&error.diagnostic?error.diagnostic.message:
      code==='rebuild_required'||code==='index_rebuild_required'?'The saved search index needs to be rebuilt.':
      code==='search_expired'||code==='snapshot_expired'?'This saved search expired. Refresh to try again.':
      code==='search_resource'?'This search exceeds the available resources. Refine the query and try again.':
      'Saved search is unavailable. Try again.';
    paint();
  }
  function setSpec(next:SearchSpec):void {
    if(!live()||sameSpec(spec,next))return;spec={...next};request++;navigationEpoch++;options.onSpec?.(spec);
    message=undefined;needsRefresh=false;phase=spec.query.length?'loading':'idle';stale=!!result;
    if(!spec.query.length){resetResults();stale=false;}
    paint();if(timer!==undefined)clearTimeout(timer);
    timer=setTimeout(()=>{timer=undefined;enqueue();},options.debounceMs??120);
  }
  function invalidate():void {
    if(!live())return;sourceEpoch++;stale=!!result;message=undefined;needsRefresh=false;
    phase=spec.query.length?'loading':'idle';paint();
    if(timer!==undefined)clearTimeout(timer);
    timer=setTimeout(()=>{timer=undefined;enqueue();},options.debounceMs??120);
  }
  function append(page:DocumentRichSearchPage):void {
    const previous={groups,result,lastPage,truncated,retainedBytes,snippetCount,nextChunk};
    groups=[...groups];
    try{if(!queryHasPage){resetResults();nextChunk=0;}
      appendChecked(page);queryHasPage=true;
    }catch(error){({groups,result,lastPage,truncated,retainedBytes,snippetCount,nextChunk}=previous);throw error;}
  }
  function appendChecked(page:DocumentRichSearchPage):void {
    // The strict shared decoder validates individual pages. Here validate only
    // relationships across pages; never derive occurrence counts from snippets.
    if(!sameSpec(page.spec,querySpec!))invalid();
    if(lastPage){
      const old=lastPage.coverage,next=page.coverage;
      if(next.candidateFiles!==old.candidateFiles||next.evaluatedFiles<old.evaluatedFiles||next.unavailableFiles<old.unavailableFiles
        ||old.scanComplete&&!next.scanComplete||old.queryCoverageComplete&&!next.queryCoverageComplete)invalid();
      for(const key of ['files','occurrences'] as const){const before=lastPage.totals[key],after=page.totals[key];
        if(before.relation!=='unknown'&&(after.relation==='unknown'||after.value<before.value||before.relation==='exact'&&(after.relation!=='exact'||after.value!==before.value)))invalid();}
    }
    for(const chunk of page.files){
      const last=groups.at(-1),continued=last?.entry.id===chunk.entry.id;
      const previous=continued?last:undefined;
      if(previous){
        if(previous.outputComplete||previous.entry.path!==chunk.entry.path||previous.entry.revision!==chunk.entry.revision
          ||previous.occurrenceCount!==chunk.occurrenceCount||chunk.chunk!==nextChunk)invalid();
      }else{
        if(chunk.chunk!==0||last&&!last.outputComplete||groups.some(group=>group.entry.id===chunk.entry.id))invalid();
      }
      const known=new Map(previous?.locations.map(location=>[location.index,location])),added:SearchLocation[]=[];
      for(const location of chunk.locations){
        const existing=known.get(location.index);
        if(existing){if(locationPayload(existing)!==locationPayload(location))invalid();}
        else{known.set(location.index,location);added.push(location);}
      }
      if([...known.values()].filter(location=>location.occurrences>0).length>chunk.occurrenceCount)invalid();
      const bytes=new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
      if((!previous&&groups.length>=MAX_GROUPS)||snippetCount+chunk.snippets.length>MAX_SNIPPETS||retainedBytes+bytes>MAX_BYTES){truncated=true;break;}
      retainedBytes+=bytes;snippetCount+=chunk.snippets.length;nextChunk=chunk.chunk+1;
      const combined:DocumentSearchGroup={entry:chunk.entry,occurrenceCount:chunk.occurrenceCount,
        locations:previous?[...previous.locations,...added]:added,
        snippets:previous?[...previous.snippets,...chunk.snippets]:chunk.snippets,outputComplete:chunk.lastChunk};
      if(previous)groups[groups.length-1]=combined;else groups.push(combined);
    }
    if(page.totals.files.relation!=='unknown'&&groups.length>page.totals.files.value)invalid();
    if(page.totals.occurrences.relation!=='unknown'&&groups.reduce((sum,group)=>sum+BigInt(group.occurrenceCount),0n)>BigInt(page.totals.occurrences.value))invalid();
    lastPage=page;
    result={snapshot:page.snapshot,source:pin!.source,totals:page.totals,coverage:page.coverage,coverageComplete:page.coverageComplete,
      outputComplete:page.outputComplete,complete:page.complete,explanation:page.explanation};
    if(page.outputComplete&&!truncated&&groups.at(-1)&&!groups.at(-1)!.outputComplete)invalid();
  }
  let nextChunk=0;
  async function drive():Promise<void> {
    if(!live())return;const stamp=request,epoch=sourceEpoch,requested={...spec};
    const current=()=>live()&&request===stamp&&sourceEpoch===epoch;
    if(!requested.query.length){await closeQuery();if(current()){phase='idle';paint();}return;}
    phase='loading';paint();
    if(pin&&pinEpoch!==epoch)await closePin();
    if(!current())return;
    if(!pin){
      await options.beforeOpen?.();if(!current())return;
      const wantsRebuild=rebuild;rebuild=false;
      const acquired=await options.acquireFresh(current,wantsRebuild);if(!current())return;
      if(!acquired){needsRefresh=true;phase='results';message='The saved search index is still updating. Refresh to continue.';stale=!!result;paint();return;}
      const opened=await options.service.open();if(!released){pin=opened;pinEpoch=epoch;}
      // Release is the final host acknowledgment, including unresolved opens.
      if(!current()){if(!released&&(!live()||sourceEpoch!==epoch))await closePin();return;}
      if(!opened.richSearch)throw new DocumentSemanticsError('rich_search_unavailable');
    }
    if(query&&(!querySpec||!sameSpec(querySpec,requested)||queryEpoch!==epoch))await closeQuery();
    if(!current())return;
    if(!query){
      const started=await pin!.richSearch!({spec:requested});if(!released){query=started;querySpec=requested;queryEpoch=epoch;}
      if(!current()){if(!released)await closeQuery();return;}
      queryHasPage=false;queryPrepared=false;seenCursors=new Set();
    }
    if(!queryPrepared){
      while(current()){
        const prepared=await query!.prepare();if(!current())return;
        if(prepared.state==='ready'){cursor=prepared.cursor;queryPrepared=true;break;}
        await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
    }
    if(!current()||!query)return;
    // Empty progress pages are legal. Bound each user drive, then expose the
    // continuation explicitly without pretending that scan coverage is complete.
    for(let index=0;index<8&&cursor&&(!truncated||!queryHasPage);index++){
      const input=cursor,owned=query;const page=await owned.page(input);if(!current())return;
      if(page.cursor!==null&&(page.cursor===input||seenCursors.has(page.cursor)))invalid();
      append(page.result.value);cursor=page.cursor;if(cursor){seenCursors.add(cursor);if(seenCursors.size>8)seenCursors.delete(seenCursors.values().next().value!);}
      phase='results';stale=false;paint();
      if(page.result.value.files.length||cursor===null)break;
    }
    if(current()){phase='results';message=truncated?'Display limit reached. Refine the query to see other results.':undefined;paint();}
  }
  function enqueue():void {
    if(!live()||scheduled)return;scheduled=true;
    ready=serial=serial.catch(()=>{}).then(async()=>{
      scheduled=false;if(!live())return;
      // A queued latest request consumes the most recent input, not a captured
      // debounce callback. In-flight replies remain owned but cannot repaint.
      const stamp=request,epoch=sourceEpoch;try{await drive();}catch(error){if(stamp===request&&epoch===sourceEpoch)failure(error);}
    });
  }
  paint();if(spec.query.length)enqueue();
  return {service:options.service,get ready(){return ready;},setSpec,invalidateSource:invalidate,focusQuery:()=>view.focusQuery(),
    close(){
      disposed=true;request++;if(timer!==undefined){clearTimeout(timer);timer=undefined;}view.destroy();
      if(released)return Promise.resolve();if(closing)return closing;
      closing=serial.catch(()=>{}).then(()=>released?undefined:closePin()).finally(()=>{closing=undefined;});return closing;
    },
    release(){released=true;disposed=true;request++;if(timer!==undefined)clearTimeout(timer);pin=undefined;query=undefined;view.destroy();},
  };
}
