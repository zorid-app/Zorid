'use strict';
// Transport validation only. Markdown, URL resolution and Base evaluation stay
// in Rust; native pins/cursors are represented only by owner-bound locators.
const MAX_DOCUMENT_REQUEST=64*1024,MAX_DOCUMENT_RESPONSE=16*1024*1024;
const MAX_RICH_PAGE=1024*1024,MAX_RICH_RESPONSE=2*1024*1024;
const utf8=new TextEncoder(),byteLength=value=>utf8.encode(value).byteLength;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const scalar=value=>typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const opaque=value=>scalar(value)&&byteLength(value)>0&&byteLength(value)<=256;
const richOp=op=>['rich_start','rich_prepare','rich_page','rich_close'].includes(op);
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const keys=(value,allowed,required=allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const fail=code=>Object.assign(new Error('Document semantics request failed.'),{code,commitUncertain:false});
const same=(a,b)=>snapshot(a)&&snapshot(b)&&['localStoreId','generationEpoch','generation'].every(key=>a[key]===b[key])&&['schema','extraction','resolver','query'].every(key=>a.versions[key]===b.versions[key]);
const sameSource=(a,b)=>source(a)&&source(b)&&a.localStoreId===b.localStoreId&&a.watermark===b.watermark;
const runtimeFailure=value=>['staleSource','staleIndex','snapshotExpired','rebuildRequired','uncertain','unavailable','invalidData','fatal'].includes(value);
const runtimeMethods=['documentRuntimeObserve','documentRuntimeControl','documentRuntimeAckControl','documentRuntimeAckOutcome'];
function runtimeBounded(value,code){
  try{
    const raw=JSON.stringify(value);if(typeof raw!=='string'||raw.length>MAX_DOCUMENT_REQUEST||byteLength(raw)>MAX_DOCUMENT_REQUEST)throw fail(code);
    const visit=(value,depth)=>{if(depth>32)throw fail(code);if(typeof value==='string'&&!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw fail(code);if(value&&typeof value==='object')for(const child of Object.values(value))visit(child,depth+1);};visit(value,0);
  }catch{throw fail(code);}
}
function runtimeCommand(value){
  if(!keys(value,['kind','lifetime','id',...(value?.kind==='request'?['maxPumps','maxRestarts','forceRebuild']:[])])||!id(value.lifetime)||!decimal(value.id))return false;
  return value.kind==='cancel'||value.kind==='request'&&integer(value.maxPumps,128)&&value.maxPumps>0&&integer(value.maxRestarts,2)&&typeof value.forceRebuild==='boolean';
}
/** Renderer controls can request/cancel their own mapped demand only. Owner
 * Wake/Continue/Retire and issued effects never enter this IPC surface. */
function captureDocumentRuntimeRequest(method,args){
  const code='invalid_document_request';runtimeBounded(args,code);
  if(!runtimeMethods.includes(method)||!Array.isArray(args)||args.length!==(method==='documentRuntimeObserve'?0:1))throw fail(code);
  const value=args[0];
  if(method==='documentRuntimeControl'&&(!keys(value,['sequence','command'])||!decimal(value.sequence)||!runtimeCommand(value.command)))throw fail(code);
  if(method==='documentRuntimeAckControl'&&(!keys(value,['sequence'])||!decimal(value.sequence)))throw fail(code);
  if(method==='documentRuntimeAckOutcome'&&(!keys(value,['lifetime','id'])||!id(value.lifetime)||!decimal(value.id)))throw fail(code);
  return structuredClone(args);
}
function runtimeObservation(value,localStoreId){
  return keys(value,['source','published','current','rebuildRequired','coverageComplete'])&&source(value.source)&&value.source.localStoreId===localStoreId
    &&(value.published===null||snapshot(value.published)&&value.published.localStoreId===localStoreId)&&typeof value.current==='boolean'&&typeof value.rebuildRequired==='boolean'
    &&(value.coverageComplete===null||typeof value.coverageComplete==='boolean')&&(!value.current||value.published!==null&&!value.rebuildRequired&&value.coverageComplete!==null);
}
function runtimeUpdate(value,localStoreId){
  if(!keys(value,['lifetime','revision','source','published','freshness','phase','progress','coverageComplete','hasForegroundDemand','error'])||!id(value.lifetime)||!decimal(value.revision)
    ||!(value.source===null||source(value.source)&&value.source.localStoreId===localStoreId)||!(value.published===null||snapshot(value.published)&&value.published.localStoreId===localStoreId)
    ||!['unknown','current','lagging','unavailable'].includes(value.freshness)||!['idle','observing','initializing','recovering','indexing','publishing','rebuilding','releasing'].includes(value.phase)
    ||!(value.coverageComplete===null||typeof value.coverageComplete==='boolean')||typeof value.hasForegroundDemand!=='boolean'||!(value.error===null||runtimeFailure(value.error))
    ||value.freshness==='current'&&(value.source===null||value.published===null||value.coverageComplete===null))return false;
  return value.progress===null||keys(value.progress,['prepared','total','ready'])&&integer(value.progress.prepared,0xffffffff)&&integer(value.progress.total,0xffffffff)&&value.progress.prepared<=value.progress.total&&typeof value.progress.ready==='boolean';
}
function runtimeFrame(value,scope){
  if(!keys(value,['version','scope','update','outcomes'])||value.version!==1||!keys(value.scope,['localStoreId','clientId'])||!id(value.scope.localStoreId)||!id(value.scope.clientId)
    ||value.scope.localStoreId!==scope.localStoreId||value.scope.clientId!==scope.clientId||!(value.update===null||runtimeUpdate(value.update,scope.localStoreId))||!Array.isArray(value.outcomes)||value.outcomes.length>32)return false;
  const seen=new Set();
  for(const item of value.outcomes){
    const outcome=item?.outcome;
    if(!keys(item,['lifetime','outcome'])||!id(item.lifetime)||!object(outcome)||!decimal(outcome.id)||seen.has(`${item.lifetime}:${outcome.id}`))return false;
    seen.add(`${item.lifetime}:${outcome.id}`);
    if(outcome.kind==='finished'){if(!keys(outcome,['kind','id','observation'])||!runtimeObservation(outcome.observation,scope.localStoreId))return false;}
    else if(outcome.kind==='failed'){if(!keys(outcome,['kind','id','failure'])||!runtimeFailure(outcome.failure))return false;}
    else if(!['cancelled','retired'].includes(outcome.kind)||!keys(outcome,['kind','id']))return false;
  }
  return true;
}
function captureDocumentRuntimeReply(method,args,value,scope){
  const code='invalid_document_response';runtimeBounded(value,code);
  if(!keys(scope,['localStoreId','clientId'])||!id(scope.localStoreId)||!id(scope.clientId))throw fail(code);
  let valid=false;
  if(method==='documentRuntimeObserve')valid=runtimeFrame(value,scope);
  else if(method==='documentRuntimeControl'){
    const request=args[0],command=value?.command;
    valid=keys(value,['sequence','command','frame'])&&value.sequence===request?.sequence&&runtimeCommand(command)&&runtimeFrame(value.frame,scope)
      &&['kind','lifetime','id',...(command?.kind==='request'?['maxPumps','maxRestarts','forceRebuild']:[])].every(key=>command[key]===request.command[key]);
  }else if(['documentRuntimeAckControl','documentRuntimeAckOutcome'].includes(method))valid=value===true;
  if(!valid)throw fail(code);return structuredClone(value);
}
function snapshot(value){
  return keys(value,['localStoreId','generationEpoch','generation','versions'])&&id(value.localStoreId)&&id(value.generationEpoch)&&decimal(value.generation)&&value.generation!=='0'
    &&keys(value.versions,['schema','extraction','resolver','query'])&&integer(value.versions.schema,0xffffffff)&&value.versions.schema>0
    &&['extraction','resolver','query'].every(key=>typeof value.versions[key]==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value.versions[key]));
}
function source(value){return keys(value,['localStoreId','watermark'])&&id(value.localStoreId)&&decimal(value.watermark);}
function entry(value){return keys(value,['id','revision','path','kind','deleted'])&&id(value.id)&&id(value.revision)&&typeof value.path==='string'&&value.path.length>0&&['file','folder'].includes(value.kind)&&value.deleted===false;}
function strings(value){return Array.isArray(value)&&value.length<=256&&value.every(item=>typeof item==='string'&&byteLength(item)<=4096);}
function parseCache(value){const fields=['hits','misses','unavailable','corrupt','unsupported'];return keys(value,fields)&&fields.every(key=>integer(value[key]));}
function captureRichDiagnostic(diagnostic){
  const range=value=>keys(value,['bytes','utf16'])&&['bytes','utf16'].every(key=>Array.isArray(value[key])&&value[key].length===2&&value[key].every(n=>integer(n,4096))&&value[key][0]<=value[key][1]);
  if(!keys(diagnostic,['code','queryRange','message'])||!['unknown-operator','invalid-nesting','invalid-operand','invalid-regex','unsupported-regex','resource','invalid-document'].includes(diagnostic.code)||!range(diagnostic.queryRange)||!scalar(diagnostic.message)||byteLength(diagnostic.message)>4096)throw fail('invalid_document_response');
  return {code:diagnostic.code,queryRange:{bytes:[...diagnostic.queryRange.bytes],utf16:[...diagnostic.queryRange.utf16]},message:diagnostic.message};
}
function captureDocumentRequest(input){
  if(!keys(input,['schemaVersion','command'])||input.schemaVersion!==1||!object(input.command)||typeof input.command.op!=='string')throw fail('invalid_document_request');
  const command=input.command,op=command.op;
  const fields={status:[],initialize:[],rebuild:[],begin:[],stages:[],resume:['snapshot'],pump:['snapshot'],publish:['snapshot'],discard:['snapshot'],open:['pinId'],close:['pinId'],metadata:['pinId','id'],metadata_rows:['pinId','baseline','cursor','limit'],search:['pinId','query','cursor','limit'],backlinks:['pinId','id','cursor','limit'],base:['pinId','id','viewName','options'],tasks:['pinId','typeIds','options'],rich_start:['pinId','spec'],rich_prepare:['pinId','queryId'],rich_page:['pinId','queryId','cursor'],rich_close:['pinId','queryId']}[op];
  if(!fields||!keys(command,['op',...fields],['op',...fields.filter(key=>!['viewName','options',...(op==='metadata_rows'?['baseline','limit']:[]),...(op==='rich_page'?[]:['cursor'])].includes(key))]))throw fail('invalid_document_request');
  const captured={op};
  for(const key of fields){
    const value=command[key];
    if(key==='snapshot'){if(!snapshot(value))throw fail('invalid_document_request');captured[key]=structuredClone(value);}
    else if(key==='baseline'){
      if(value===undefined)continue;
      if(!keys(value,['pinId','snapshot'])||!decimal(value.pinId)||value.pinId==='0'||!snapshot(value.snapshot))throw fail('invalid_document_request');
      captured.baseline={pinId:value.pinId,snapshot:structuredClone(value.snapshot)};
    }
    else if(key==='pinId'){if(!decimal(value)||value==='0')throw fail('invalid_pin_id');captured[key]=value;}
    else if(key==='typeIds'){if(!Array.isArray(value)||value.length>128||value.some(item=>!id(item))||new Set(value).size!==value.length)throw fail('invalid_document_request');captured[key]=[...value];}
    else if(key==='id'){if(!id(value))throw fail('invalid_document_request');captured[key]=value;}
    else if(key==='queryId'){if(!opaque(value))throw fail('invalid_document_request');captured[key]=value;}
    else if(key==='spec'){
      if(!keys(value,['query','caseSensitive','sort','context','explain'])||!scalar(value.query)||byteLength(value.query)>4096||typeof value.caseSensitive!=='boolean'||typeof value.explain!=='boolean'||!['nameAsc','nameDesc','modifiedDesc','modifiedAsc','createdDesc','createdAsc'].includes(value.sort)||!['line','section'].includes(value.context))throw fail('invalid_document_request');
      captured.spec={...value};
    }
    else if(key==='cursor'){if(op==='rich_page'?!opaque(value):value!==undefined&&value!==null&&!(op==='metadata_rows'?opaque(value):id(value)))throw fail('invalid_document_request');captured[key]=value??null;}
    else if(key==='query'){if(typeof value!=='string'||!value||byteLength(value)>4096||/[\r\n]/.test(value))throw fail('invalid_query');captured[key]=value;}
    else if(key==='limit'){if(op==='metadata_rows'&&value===undefined)continue;if(!integer(value,op==='metadata_rows'?32:1000)||value===0)throw fail('invalid_budget');captured[key]=value;}
    else if(key==='viewName'){if(value!==undefined&&value!==null&&(typeof value!=='string'||byteLength(value)>1024))throw fail('invalid_document_request');captured[key]=value??null;}
    else if(key==='options'){
      if(op==='tasks'&&value===null)throw fail('invalid_document_request');
      const options=value??{},allowed=op==='tasks'?['filter','clockMs','timezone','showDone','maxRows']:['viewIndex','searchTerms','ignorePaths','clockMs','timezone','maxRows','currentEntryId','maxSteps'];
      if(!keys(options,allowed,[]))throw fail('invalid_document_request');
      captured.options={};
      for(const key of Object.keys(options)){
        const value=options[key];
        if(key==='filter'&&!['all','today','unscheduled'].includes(value)||key==='showDone'&&typeof value!=='boolean'||key==='currentEntryId'&&!id(value)||key==='maxSteps'&&(!integer(value,2000000)||value===0)||key==='viewIndex'&&!integer(value,1000)||key==='maxRows'&&(!integer(value,10000)||value===0)||key==='clockMs'&&!Number.isSafeInteger(value)||['searchTerms','ignorePaths'].includes(key)&&!strings(value)||key==='timezone'&&(typeof value!=='string'||byteLength(value)>128))throw fail('invalid_document_request');
        captured.options[key]=Array.isArray(value)?[...value]:value;
      }
    }
  }
  const result={schemaVersion:1,command:captured};
  if(op==='metadata_rows'&&captured.cursor!==null&&captured.baseline!==undefined)throw fail('invalid_document_request');
  if(byteLength(JSON.stringify(result))>MAX_DOCUMENT_REQUEST)throw fail('request_limit');
  return result;
}
function envelope(value){return keys(value,['snapshot','source','coverageComplete','value'])&&snapshot(value.snapshot)&&source(value.source)&&value.snapshot.localStoreId===value.source.localStoreId&&typeof value.coverageComplete==='boolean';}
// Framing and owner identity only. The common facade deeply validates the
// existing metadata DTO once; this boundary never parses source or installs it.
function metadataRowsPage(value,limit){
  const report=value?.result,inner=report?.value;
  return keys(value,['result','cursor'])&&(value.cursor===null||opaque(value.cursor))&&envelope(report)
    &&keys(inner,['snapshot','next','scanComplete','coverageComplete','complete','mode','from','rows','removedEntryIds'])&&same(inner.snapshot,report.snapshot)&&inner.next===null
    &&['scanComplete','coverageComplete','complete'].every(key=>typeof inner[key]==='boolean')&&inner.coverageComplete===report.coverageComplete&&inner.complete===(inner.scanComplete&&inner.coverageComplete)&&inner.scanComplete===(value.cursor===null)
    &&['reset','delta'].includes(inner.mode)&&(inner.mode==='reset'?inner.from===null: snapshot(inner.from)&&inner.from.localStoreId===report.snapshot.localStoreId)
    &&Array.isArray(inner.rows)&&Array.isArray(inner.removedEntryIds)&&inner.rows.length+inner.removedEntryIds.length<=limit&&inner.removedEntryIds.every(id)
    &&(inner.mode!=='reset'||inner.removedEntryIds.length===0)&&inner.rows.every(row=>row?.kind==='folder'?keys(row,['kind','entry'])&&entry(row.entry)&&row.entry.kind==='folder':keys(row,['kind','value'])&&row.kind==='file'&&object(row.value)&&entry(row.value.entry)&&row.value.entry.kind==='file');
}
function page(value,op,limit){
  const collection=op==='search'?'hits':'edges';
  const fields=['snapshot',collection,'next','scanComplete','coverageComplete','complete',...(op==='search'?['sourceBytes','documents']:[])];
  return keys(value,fields)&&(op!=='search'||integer(value.sourceBytes,16*1024*1024)&&integer(value.documents,32))&&snapshot(value.snapshot)&&Array.isArray(value[collection])&&value[collection].length<=limit&&value.next===null
    &&['scanComplete','coverageComplete','complete'].every(key=>typeof value[key]==='boolean')&&value.complete===(value.scanComplete&&value.coverageComplete);
}
const witness=value=>keys(value,['entryId','revision'])&&id(value.entryId)&&id(value.revision);
const category=value=>value===null||['not_started','working','done'].includes(value);
const nullableString=value=>value===null||typeof value==='string';
function taskProperty(value,datatype){
  return keys(value,['id','key','label','datatype','options','default'])&&id(value.id)&&typeof value.key==='string'&&typeof value.label==='string'&&value.datatype===datatype
    &&Array.isArray(value.options)&&value.options.length<=128&&value.options.every(option=>keys(option,['id','label','category'])&&id(option.id)&&typeof option.label==='string'&&category(option.category));
}
function taskRead(value,command){
  if(!envelope(value)||!keys(value.value,['definitions','types','result']))return false;
  const {definitions,types,result}=value.value;
  if(!Array.isArray(definitions)||definitions.length!==command.typeIds.length||!definitions.every((item,index)=>entry(item)&&item.kind==='file'&&item.id===command.typeIds[index])
    ||!Array.isArray(types)||types.length>definitions.length||!keys(result,['snapshotId','typeWitnesses','coverageComplete','rows','groups','matched','truncated','diagnostics','typeDiagnostics','metadataIssues'])||!same(result.snapshotId,value.snapshot))return false;
  const defined=new Map(definitions.map(item=>[item.id,item]));
  const knownWitness=item=>witness(item)&&defined.get(item.entryId)?.revision===item.revision;
  if(!Array.isArray(result.typeWitnesses)||result.typeWitnesses.length!==definitions.length||!result.typeWitnesses.every((item,index)=>knownWitness(item)&&item.entryId===definitions[index].id)
    ||typeof result.coverageComplete!=='boolean'||result.coverageComplete&&!value.coverageComplete)return false;
  const typeIds=new Set();
  for(const item of types){
    if(!keys(item,['witness','typeId','label','status','plannedDay','deadline','captureDefaults'])||!knownWitness(item.witness)||!id(item.typeId)||typeIds.has(item.typeId)||typeof item.label!=='string'||!taskProperty(item.status,'status')
      ||item.plannedDay!==null&&!taskProperty(item.plannedDay,'date')||item.deadline!==null&&!taskProperty(item.deadline,'date')||!Array.isArray(item.captureDefaults)||item.captureDefaults.length>65||!item.captureDefaults.every(pair=>Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string'))return false;
    typeIds.add(item.typeId);
  }
  if(!Array.isArray(result.rows)||result.rows.length>(command.options?.maxRows??1000)||!integer(result.matched,50000)||result.matched<result.rows.length||typeof result.truncated!=='boolean'||result.truncated!==(result.matched>result.rows.length)||!Array.isArray(result.groups)||result.groups.length>result.rows.length)return false;
  const rows=new Map();
  for(const row of result.rows){
    if(!keys(row,['witness','path','title','typeId','statusId','statusLabel','category','statusDefaulted','plannedDay','deadline'])||!witness(row.witness)||rows.has(row.witness.entryId)||typeof row.path!=='string'||typeof row.title!=='string'||!typeIds.has(row.typeId)||!nullableString(row.statusId)||!nullableString(row.statusLabel)||!category(row.category)||typeof row.statusDefaulted!=='boolean'||!nullableString(row.plannedDay)||!nullableString(row.deadline))return false;
    rows.set(row.witness.entryId,row);
  }
  const grouped=new Set();
  for(const group of result.groups){
    if(!keys(group,['typeId','category','statusId','entryIds'])||!typeIds.has(group.typeId)||!category(group.category)||!nullableString(group.statusId)||!Array.isArray(group.entryIds)||!group.entryIds.length)return false;
    for(const entryId of group.entryIds){const row=rows.get(entryId);if(!row||grouped.has(entryId)||row.typeId!==group.typeId||row.category!==group.category||row.statusId!==group.statusId)return false;grouped.add(entryId);}
  }
  return grouped.size===rows.size&&Array.isArray(result.diagnostics)&&result.diagnostics.every(item=>keys(item,['witness','property','code'])&&witness(item.witness)&&typeof item.property==='string'&&typeof item.code==='string')
    &&Array.isArray(result.typeDiagnostics)&&result.typeDiagnostics.every(item=>keys(item,['witness','code','yaml'],['witness','code'])&&knownWitness(item.witness)&&typeof item.code==='string'&&(!Object.hasOwn(item,'yaml')||object(item.yaml)&&typeof item.yaml.code==='string'&&object(item.yaml.range)))
    &&Array.isArray(result.metadataIssues)&&result.metadataIssues.every(item=>object(item)&&witness(item.witness)&&typeof item.propertiesUnavailable==='boolean'&&Array.isArray(item.diagnostics));
}
function decodeDocumentReply(request,marker,bytes){
  if(!keys(marker,['documents','schemaVersion','bytes'])||marker.documents!==true||marker.schemaVersion!==1||!integer(marker.bytes,MAX_DOCUMENT_RESPONSE)||!(bytes instanceof Uint8Array)||marker.bytes!==bytes.length||!bytes.length)throw fail('invalid_document_response');
  if(request.command.op==='rich_page'&&bytes.length>MAX_RICH_RESPONSE)throw fail('invalid_document_response');
  let reply;try{reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('invalid_document_response');}
  const command=request.command,op=command.op;
  if(!keys(reply,['schemaVersion','op','value'])||reply.schemaVersion!==1||reply.op!==op)throw fail('invalid_document_response');
  const value=reply.value;
  let valid=false;
  if(['initialize','rebuild','close','discard','rich_close'].includes(op))valid=value===true;
  else if(op==='status')valid=object(value)&&source(value.source)&&['uninitialized','rebuild_required','building','ready'].includes(value.state)
    &&(value.state==='ready'?keys(value,['source','state','snapshot','coveredWatermark','observedSourceHead','coverageComplete'])&&snapshot(value.snapshot)&&value.snapshot.localStoreId===value.source.localStoreId&&decimal(value.coveredWatermark)&&value.observedSourceHead===value.source.watermark&&typeof value.coverageComplete==='boolean':keys(value,['source','state']));
  else if(['begin','resume'].includes(op))valid=keys(value,['snapshot'])&&snapshot(value.snapshot)&&(op!=='resume'||same(value.snapshot,command.snapshot));
  else if(op==='pump'){
    const fields=['snapshot','preparedDocuments','reusedDocuments','totalDocuments','ready'];
    valid=keys(value,[...fields,'parseCache'],fields)&&snapshot(value.snapshot)&&same(value.snapshot,command.snapshot)&&['preparedDocuments','reusedDocuments','totalDocuments'].every(key=>integer(value[key]))&&value.preparedDocuments<=value.totalDocuments&&value.reusedDocuments<=value.preparedDocuments&&typeof value.ready==='boolean'
      &&(!Object.hasOwn(value,'parseCache')||parseCache(value.parseCache));
  }
  else if(op==='publish')valid=snapshot(value)&&same(value,command.snapshot);
  else if(op==='stages')valid=Array.isArray(value)&&value.length<=4&&value.every(item=>keys(item,['snapshot'])&&snapshot(item.snapshot));
  else if(op==='open')valid=keys(value,['pinId','snapshot','source','coverageComplete'])&&value.pinId===command.pinId&&snapshot(value.snapshot)&&source(value.source)&&value.snapshot.localStoreId===value.source.localStoreId&&typeof value.coverageComplete==='boolean';
  else if(op==='rich_start')valid=keys(value,['queryId'])&&opaque(value.queryId);
  else if(op==='metadata_rows')valid=metadataRowsPage(value,command.limit??32);
  else if(op==='rich_prepare')valid=keys(value,['state'],['state'])&&value.state==='preparing'||keys(value,['state','cursor'])&&value.state==='ready'&&opaque(value.cursor);
  else if(op==='rich_page'){
    const report=value?.result,inner=report?.value;
    // The common facade owns the strict DTO decoder. This boundary checks only
    // bounded framing and envelope/continuation identity, before IPC delivery.
    valid=keys(value,['result','cursor'])&&(value.cursor===null||opaque(value.cursor))&&envelope(report)&&object(inner)&&snapshot(inner.snapshot)&&same(inner.snapshot,report.snapshot)&&inner.coverageComplete===report.coverageComplete&&inner.next===null&&typeof inner.scanComplete==='boolean'&&typeof inner.outputComplete==='boolean'&&(inner.scanComplete&&inner.outputComplete)===(value.cursor===null)&&byteLength(JSON.stringify(inner))<=MAX_RICH_PAGE;
  }
  else if(op==='metadata')valid=envelope(value)&&keys(value.value,['entry','metadata','exclusion'])&&entry(value.value.entry)&&value.value.entry.id===command.id
    &&(value.value.metadata===null||object(value.value.metadata)&&value.value.metadata.entryId===command.id&&value.value.metadata.contentRevision===value.value.entry.revision&&Array.isArray(value.value.metadata.properties))
    &&(value.value.exclusion===null||['binary','unreadable','sourceLimit','extractionLimit'].includes(value.value.exclusion));
  else if(['search','backlinks'].includes(op)){
    const report=value?.result,inner=report?.value;
    valid=keys(value,['result','cursor'])&&(value.cursor===null||id(value.cursor))&&envelope(report)&&page(inner,op,command.limit)&&same(inner.snapshot,report.snapshot)&&inner.coverageComplete===report.coverageComplete&&inner.scanComplete===(value.cursor===null);
    if(valid)valid=op==='search'?inner.hits.every(hit=>entry(hit.entry)&&integer(hit.line)&&object(hit.range)&&typeof hit.snippet==='string'&&typeof hit.snippetTruncated==='boolean'):
      inner.edges.every(edge=>entry(edge.source)&&entry(edge.target)&&edge.target.id===command.id&&integer(edge.linkIndex)&&object(edge.link));
  }else if(op==='tasks')valid=taskRead(value,command);
  else if(op==='base')valid=envelope(value)&&keys(value.value,['definition','result'])&&entry(value.value.definition)&&value.value.definition.id===command.id&&object(value.value.result)&&same(value.value.result.snapshotId,value.snapshot)&&Array.isArray(value.value.result.rows);
  if(!valid)throw fail('invalid_document_response');
  return value;
}
function validDocumentReply(command,marker,bytes){try{decodeDocumentReply(command.request,marker,bytes);return true;}catch{return false;}}
function createDesktopDocumentSemantics(host,clientId,localStoreId,{metadataRowsAvailable=false}={}){
  if(!id(clientId)||!id(localStoreId))throw fail('client_scope_mismatch');
  if(metadataRowsAvailable===true&&typeof host.documentCommand!=='function')throw fail('unsupported_host_capability');
  const pins=new Map();let retired=false;
  return Object.freeze({
    ...(metadataRowsAvailable===true?{metadataRowsAvailable:true}:{}),
    async invoke(input){
      const request=captureDocumentRequest(input),command=request.command,op=command.op;
      if(retired)throw fail('client_not_admitted');
      const selected=pins.get(command.pinId);
      if(command.pinId&&!['open','close'].includes(op)&&!pins.has(command.pinId))throw fail('snapshot_expired');
      let metadataProfile,baseline;
      if(op==='metadata_rows'){
        if(metadataRowsAvailable!==true)throw fail('unsupported_host_capability');
        if(selected.closing)throw fail('snapshot_expired');
        if(command.cursor!==null){
          metadataProfile=selected.metadataCursors.get(command.cursor);if(!metadataProfile)throw fail('cursor_expired');
          if(command.limit!==undefined&&command.limit!==metadataProfile.limit)throw fail('query_mismatch');
          command.limit=metadataProfile.limit;baseline=metadataProfile.baseline;
        }else{
          command.limit??=32;
          if(command.baseline){
            if(command.baseline.snapshot.localStoreId!==localStoreId)throw fail('client_scope_mismatch');
            const actual=pins.get(command.baseline.pinId);
            if(actual&&(!same(actual.snapshot,command.baseline.snapshot)||actual.closing))throw fail('snapshot_expired');
            if(actual)baseline={pinId:command.baseline.pinId,actual,snapshot:command.baseline.snapshot};
          }
        }
        if(baseline&&(pins.get(baseline.pinId)!==baseline.actual||baseline.actual.closing))throw fail('snapshot_expired');
      }
      if(op==='close'&&selected)selected.closing=true;
      if(richOp(op)&&selected.closing)throw fail('search_expired');
      let query;
      if(richOp(op)&&op!=='rich_start'){query=selected.queries.get(command.queryId);if(!query||query.closing&&op!=='rich_close')throw fail('search_expired');if(op==='rich_page'&&!query.cursors.has(command.cursor))throw fail('search_expired');if(op==='rich_close')query.closing=true;}
      let value;
      try{value=await host.documentCommand(clientId,request);}
      catch(error){
        if(op==='metadata_rows'&&(retired||pins.get(command.pinId)!==selected||selected.closing||baseline&&(pins.get(baseline.pinId)!==baseline.actual||baseline.actual.closing)))throw fail(retired?'client_not_admitted':'snapshot_expired');
        if(error?.code==='snapshot_expired'&&command.pinId&&op!=='metadata_rows')pins.delete(command.pinId);throw error;
      }
      if(retired)throw fail('client_not_admitted');
      if(op==='metadata_rows'&&(pins.get(command.pinId)!==selected||selected.closing||baseline&&(pins.get(baseline.pinId)!==baseline.actual||baseline.actual.closing)))throw fail('snapshot_expired');
      if(richOp(op)&&(pins.get(command.pinId)!==selected||op!=='rich_start'&&selected.queries.get(command.queryId)!==query))throw fail('search_expired');
      if(richOp(op)&&op!=='rich_close'&&(selected.closing||query?.closing))throw fail('search_expired');
      if(op==='status'&&value.source.localStoreId!==localStoreId)throw fail('invalid_document_response');
      if(op==='open'){
        const previous=pins.get(command.pinId);
        if(value.snapshot.localStoreId!==localStoreId||value.source.localStoreId!==localStoreId||previous&&(!same(previous.snapshot,value.snapshot)||!sameSource(previous.source,value.source)||previous.coverageComplete!==value.coverageComplete))throw fail('invalid_document_response');
        if(!previous)pins.set(command.pinId,{...structuredClone({snapshot:value.snapshot,source:value.source,coverageComplete:value.coverageComplete}),queries:new Map(),metadataCursors:new Map()});
      }else if(op==='close')pins.delete(command.pinId);
      else if(op==='rebuild')pins.clear();
      else if(op==='rich_start'){if(!keys(value,['queryId'])||!opaque(value.queryId)||selected.queries.has(value.queryId)||selected.queries.size>=4)throw fail('invalid_document_response');selected.queries.set(value.queryId,{closing:false,cursors:new Set()});}
      else if(op==='rich_prepare'){if(value.state==='ready'){if(!opaque(value.cursor))throw fail('invalid_document_response');query.cursors.add(value.cursor);if(query.cursors.size>8)query.cursors.delete(query.cursors.values().next().value);}}
      else if(op==='rich_close')selected.queries.delete(command.queryId);
      if(['metadata','metadata_rows','base','tasks','search','backlinks','rich_page'].includes(op)){
        const envelope=['search','backlinks','rich_page','metadata_rows'].includes(op)?value.result:value;
        const selected=pins.get(command.pinId);
        if(!selected||!same(envelope.snapshot,selected.snapshot)||!sameSource(envelope.source,selected.source)||envelope.coverageComplete!==selected.coverageComplete)throw fail('invalid_document_response');
        if(op==='rich_page'&&value.cursor!==null){query.cursors.add(value.cursor);if(query.cursors.size>8)query.cursors.delete(query.cursors.values().next().value);}
        if(op==='metadata_rows'){
          if(!metadataRowsPage(value,command.limit))throw fail('invalid_document_response');
          const inner=envelope.value;
          if(metadataProfile?(inner.mode!==metadataProfile.mode||(inner.from===null)!==(metadataProfile.from===null)||inner.from!==null&&!same(inner.from,metadataProfile.from)):
            inner.mode==='delta'&&(!baseline||!same(inner.from,baseline.snapshot)))throw fail('invalid_document_response');
          if(value.cursor!==null){
            const profile=metadataProfile??{limit:command.limit,mode:inner.mode,from:inner.from===null?null:structuredClone(inner.from),baseline:inner.mode==='delta'?baseline:undefined};
            const previous=selected.metadataCursors.get(value.cursor);
            if(previous&&(previous.limit!==profile.limit||previous.mode!==profile.mode||previous.baseline?.actual!==profile.baseline?.actual||(previous.from===null)!==(profile.from===null)||previous.from!==null&&!same(previous.from,profile.from)))throw fail('invalid_document_response');
            selected.metadataCursors.set(value.cursor,previous??profile);if(selected.metadataCursors.size>8)selected.metadataCursors.delete(selected.metadataCursors.keys().next().value);
          }
        }
      }
      return value;
    },
    forget(){retired=true;pins.clear();},
  });
}
module.exports={MAX_DOCUMENT_REQUEST,MAX_DOCUMENT_RESPONSE,MAX_RICH_PAGE,MAX_RICH_RESPONSE,captureDocumentRuntimeRequest,captureDocumentRuntimeReply,captureDocumentRequest,captureRichDiagnostic,decodeDocumentReply,validDocumentReply,createDesktopDocumentSemantics};
