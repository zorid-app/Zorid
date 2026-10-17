'use strict';
// Transport validation only. Markdown, URL resolution and Base evaluation stay
// in Rust; native pins/cursors are represented only by owner-bound locators.
const MAX_DOCUMENT_REQUEST=64*1024,MAX_DOCUMENT_RESPONSE=16*1024*1024;
const utf8=new TextEncoder(),byteLength=value=>utf8.encode(value).byteLength;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const keys=(value,allowed,required=allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const fail=code=>Object.assign(new Error('Document semantics request failed.'),{code,commitUncertain:false});
const same=(a,b)=>snapshot(a)&&snapshot(b)&&['localStoreId','generationEpoch','generation'].every(key=>a[key]===b[key])&&['schema','extraction','resolver','query'].every(key=>a.versions[key]===b.versions[key]);
const sameSource=(a,b)=>source(a)&&source(b)&&a.localStoreId===b.localStoreId&&a.watermark===b.watermark;
function snapshot(value){
  return keys(value,['localStoreId','generationEpoch','generation','versions'])&&id(value.localStoreId)&&id(value.generationEpoch)&&decimal(value.generation)&&value.generation!=='0'
    &&keys(value.versions,['schema','extraction','resolver','query'])&&integer(value.versions.schema,0xffffffff)&&value.versions.schema>0
    &&['extraction','resolver','query'].every(key=>typeof value.versions[key]==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value.versions[key]));
}
function source(value){return keys(value,['localStoreId','watermark'])&&id(value.localStoreId)&&decimal(value.watermark);}
function entry(value){return keys(value,['id','revision','path','kind','deleted'])&&id(value.id)&&id(value.revision)&&typeof value.path==='string'&&value.path.length>0&&['file','folder'].includes(value.kind)&&value.deleted===false;}
function strings(value){return Array.isArray(value)&&value.length<=256&&value.every(item=>typeof item==='string'&&byteLength(item)<=4096);}
function captureDocumentRequest(input){
  if(!keys(input,['schemaVersion','command'])||input.schemaVersion!==1||!object(input.command)||typeof input.command.op!=='string')throw fail('invalid_document_request');
  const command=input.command,op=command.op;
  const fields={status:[],initialize:[],rebuild:[],begin:[],stages:[],resume:['snapshot'],pump:['snapshot'],publish:['snapshot'],discard:['snapshot'],open:['pinId'],close:['pinId'],metadata:['pinId','id'],search:['pinId','query','cursor','limit'],backlinks:['pinId','id','cursor','limit'],base:['pinId','id','viewName','options']}[op];
  if(!fields||!keys(command,['op',...fields],['op',...fields.filter(key=>!['cursor','viewName','options'].includes(key))]))throw fail('invalid_document_request');
  const captured={op};
  for(const key of fields){
    const value=command[key];
    if(key==='snapshot'){if(!snapshot(value))throw fail('invalid_document_request');captured[key]=structuredClone(value);}
    else if(key==='pinId'){if(!decimal(value)||value==='0')throw fail('invalid_pin_id');captured[key]=value;}
    else if(key==='id'){if(!id(value))throw fail('invalid_document_request');captured[key]=value;}
    else if(key==='cursor'){if(value!==undefined&&value!==null&&!id(value))throw fail('invalid_document_request');captured[key]=value??null;}
    else if(key==='query'){if(typeof value!=='string'||!value||byteLength(value)>4096||/[\r\n]/.test(value))throw fail('invalid_query');captured[key]=value;}
    else if(key==='limit'){if(!integer(value,1000)||value===0)throw fail('invalid_budget');captured[key]=value;}
    else if(key==='viewName'){if(value!==undefined&&value!==null&&(typeof value!=='string'||byteLength(value)>1024))throw fail('invalid_document_request');captured[key]=value??null;}
    else if(key==='options'){
      const options=value??{},allowed=['viewIndex','searchTerms','ignorePaths','clockMs','timezone','maxRows','currentEntryId','maxSteps'];
      if(!keys(options,allowed,[]))throw fail('invalid_document_request');
      captured.options={};
      for(const key of Object.keys(options)){
        const value=options[key];
        if(key==='currentEntryId'&&!id(value)||key==='maxSteps'&&(!integer(value,2000000)||value===0)||key==='viewIndex'&&!integer(value,1000)||key==='maxRows'&&(!integer(value,10000)||value===0)||key==='clockMs'&&!Number.isSafeInteger(value)||['searchTerms','ignorePaths'].includes(key)&&!strings(value)||key==='timezone'&&(typeof value!=='string'||byteLength(value)>128))throw fail('invalid_document_request');
        captured.options[key]=Array.isArray(value)?[...value]:value;
      }
    }
  }
  const result={schemaVersion:1,command:captured};
  if(byteLength(JSON.stringify(result))>MAX_DOCUMENT_REQUEST)throw fail('request_limit');
  return result;
}
function envelope(value){return keys(value,['snapshot','source','coverageComplete','value'])&&snapshot(value.snapshot)&&source(value.source)&&value.snapshot.localStoreId===value.source.localStoreId&&typeof value.coverageComplete==='boolean';}
function page(value,op,limit){
  const collection=op==='search'?'hits':'edges';
  const fields=['snapshot',collection,'next','scanComplete','coverageComplete','complete',...(op==='search'?['sourceBytes','documents']:[])];
  return keys(value,fields)&&(op!=='search'||integer(value.sourceBytes,16*1024*1024)&&integer(value.documents,32))&&snapshot(value.snapshot)&&Array.isArray(value[collection])&&value[collection].length<=limit&&value.next===null
    &&['scanComplete','coverageComplete','complete'].every(key=>typeof value[key]==='boolean')&&value.complete===(value.scanComplete&&value.coverageComplete);
}
function decodeDocumentReply(request,marker,bytes){
  if(!keys(marker,['documents','schemaVersion','bytes'])||marker.documents!==true||marker.schemaVersion!==1||!integer(marker.bytes,MAX_DOCUMENT_RESPONSE)||!(bytes instanceof Uint8Array)||marker.bytes!==bytes.length||!bytes.length)throw fail('invalid_document_response');
  let reply;try{reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('invalid_document_response');}
  const command=request.command,op=command.op;
  if(!keys(reply,['schemaVersion','op','value'])||reply.schemaVersion!==1||reply.op!==op)throw fail('invalid_document_response');
  const value=reply.value;
  let valid=false;
  if(['initialize','rebuild','close','discard'].includes(op))valid=value===true;
  else if(op==='status')valid=object(value)&&source(value.source)&&['uninitialized','rebuild_required','building','ready'].includes(value.state)
    &&(value.state==='ready'?keys(value,['source','state','snapshot','coveredWatermark','observedSourceHead','coverageComplete'])&&snapshot(value.snapshot)&&value.snapshot.localStoreId===value.source.localStoreId&&decimal(value.coveredWatermark)&&value.observedSourceHead===value.source.watermark&&typeof value.coverageComplete==='boolean':keys(value,['source','state']));
  else if(['begin','resume'].includes(op))valid=keys(value,['snapshot'])&&snapshot(value.snapshot)&&(op!=='resume'||same(value.snapshot,command.snapshot));
  else if(op==='pump')valid=keys(value,['snapshot','preparedDocuments','reusedDocuments','totalDocuments','ready'])&&snapshot(value.snapshot)&&same(value.snapshot,command.snapshot)&&['preparedDocuments','reusedDocuments','totalDocuments'].every(key=>integer(value[key]))&&value.preparedDocuments<=value.totalDocuments&&value.reusedDocuments<=value.preparedDocuments&&typeof value.ready==='boolean';
  else if(op==='publish')valid=snapshot(value)&&same(value,command.snapshot);
  else if(op==='stages')valid=Array.isArray(value)&&value.length<=4&&value.every(item=>keys(item,['snapshot'])&&snapshot(item.snapshot));
  else if(op==='open')valid=keys(value,['pinId','snapshot','source','coverageComplete'])&&value.pinId===command.pinId&&snapshot(value.snapshot)&&source(value.source)&&value.snapshot.localStoreId===value.source.localStoreId&&typeof value.coverageComplete==='boolean';
  else if(op==='metadata')valid=envelope(value)&&keys(value.value,['entry','metadata','exclusion'])&&entry(value.value.entry)&&value.value.entry.id===command.id
    &&(value.value.metadata===null||object(value.value.metadata)&&value.value.metadata.entryId===command.id&&value.value.metadata.contentRevision===value.value.entry.revision&&Array.isArray(value.value.metadata.properties))
    &&(value.value.exclusion===null||['binary','unreadable','sourceLimit','extractionLimit'].includes(value.value.exclusion));
  else if(['search','backlinks'].includes(op)){
    const report=value?.result,inner=report?.value;
    valid=keys(value,['result','cursor'])&&(value.cursor===null||id(value.cursor))&&envelope(report)&&page(inner,op,command.limit)&&same(inner.snapshot,report.snapshot)&&inner.coverageComplete===report.coverageComplete&&inner.scanComplete===(value.cursor===null);
    if(valid)valid=op==='search'?inner.hits.every(hit=>entry(hit.entry)&&integer(hit.line)&&object(hit.range)&&typeof hit.snippet==='string'&&typeof hit.snippetTruncated==='boolean'):
      inner.edges.every(edge=>entry(edge.source)&&entry(edge.target)&&edge.target.id===command.id&&integer(edge.linkIndex)&&object(edge.link));
  }else if(op==='base')valid=envelope(value)&&keys(value.value,['definition','result'])&&entry(value.value.definition)&&value.value.definition.id===command.id&&object(value.value.result)&&same(value.value.result.snapshotId,value.snapshot)&&Array.isArray(value.value.result.rows);
  if(!valid)throw fail('invalid_document_response');
  return value;
}
function validDocumentReply(command,marker,bytes){try{decodeDocumentReply(command.request,marker,bytes);return true;}catch{return false;}}
function createDesktopDocumentSemantics(host,clientId,localStoreId){
  if(!id(clientId)||!id(localStoreId))throw fail('client_scope_mismatch');
  const pins=new Map();
  return Object.freeze({
    async invoke(input){
      const request=captureDocumentRequest(input),command=request.command,op=command.op;
      if(command.pinId&&!['open','close'].includes(op)&&!pins.has(command.pinId))throw fail('snapshot_expired');
      let value;
      try{value=await host.documentCommand(clientId,request);}
      catch(error){if(error?.code==='snapshot_expired'&&command.pinId)pins.delete(command.pinId);throw error;}
      if(op==='status'&&value.source.localStoreId!==localStoreId)throw fail('invalid_document_response');
      if(op==='open'){
        const previous=pins.get(command.pinId);
        if(value.snapshot.localStoreId!==localStoreId||value.source.localStoreId!==localStoreId||previous&&(!same(previous.snapshot,value.snapshot)||!sameSource(previous.source,value.source)||previous.coverageComplete!==value.coverageComplete))throw fail('invalid_document_response');
        pins.set(command.pinId,structuredClone({snapshot:value.snapshot,source:value.source,coverageComplete:value.coverageComplete}));
      }else if(op==='close')pins.delete(command.pinId);
      else if(op==='rebuild')pins.clear();
      else if(['metadata','base','search','backlinks'].includes(op)){
        const envelope=['search','backlinks'].includes(op)?value.result:value;
        const selected=pins.get(command.pinId);
        if(!selected||!same(envelope.snapshot,selected.snapshot)||!sameSource(envelope.source,selected.source)||envelope.coverageComplete!==selected.coverageComplete)throw fail('invalid_document_response');
      }
      return value;
    },
    forget(){pins.clear();},
  });
}
module.exports={MAX_DOCUMENT_REQUEST,MAX_DOCUMENT_RESPONSE,captureDocumentRequest,decodeDocumentReply,validDocumentReply,createDesktopDocumentSemantics};
