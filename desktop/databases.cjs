'use strict';
// Bounded DTO transport only. Rust owns collection membership, schema/value
// semantics, idempotency, local durability and projection/recovery decisions.
const MAX_DATABASE_REQUEST=32*1024*1024,MAX_DATABASE_RESPONSE=16*1024*1024;
const encoder=new TextEncoder(),size=text=>encoder.encode(text).byteLength;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed,required=allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const schemaId=value=>typeof value==='string'&&/^[0-9a-z]{12}$/.test(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&size(value)<=512&&!/[\x00-\x1f\x7f]/.test(value);
const path=value=>typeof value==='string'&&value.length>0&&size(value)<=4096&&!value.startsWith('/')&&!/^[a-z]:/i.test(value)&&!/[\\\x00-\x1f\x7f]/.test(value)&&!/^\.zorid(?:\/|$)/i.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const count=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const types=new Set(['text','number','checkbox','date','datetime','select','multi-select','status']);
const reads=new Set(['list','get','get_entry','compose']);
const mutation=op=>!reads.has(op);
function scalar(text){for(let index=0;index<text.length;index++){const n=text.charCodeAt(index);if(n>=0xd800&&n<=0xdbff){const low=text.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}return true;}
function failure(code,uncertain=false){return Object.assign(new Error(uncertain?'Collection acknowledgement is uncertain; retain the identical operation ID and request.':'Collection request could not finish.'),{code,source:'host',commitUncertain:uncertain});}
// Capture inert plain data before awaiting or invoking JSON.stringify. Accessors,
// custom prototypes, toJSON, sparse arrays and cycles never execute caller code.
function detached(value,max,depth=0,budget={nodes:0,bytes:0},active=new Set()){
  if(depth>16||++budget.nodes>2000000)throw failure('database_request_limit');
  if(value===null||value===undefined||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw failure('invalid_database_request');return value;}
  if(typeof value==='string'){if(!scalar(value))throw failure('invalid_database_request');budget.bytes+=size(value);if(budget.bytes>max)throw failure('database_request_limit');return value;}
  if(typeof value!=='object'||active.has(value)||Object.getOwnPropertySymbols(value).length)throw failure('invalid_database_request');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(array?proto!==Array.prototype:proto!==null&&proto!==Object.prototype)throw failure('invalid_database_request');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Object.keys(descriptors).filter(key=>!(array&&key==='length'));
  if(names.length>8192||array&&(value.length>8192||names.length!==value.length))throw failure('database_request_limit');
  const out=array?[]:{};active.add(value);
  for(const name of names){
    const d=descriptors[name];
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9][0-9]*)$/.test(name))throw failure('invalid_database_request');
    budget.bytes+=size(name);if(budget.bytes>max)throw failure('database_request_limit');
    Object.defineProperty(out,name,{value:detached(d.value,max,depth+1,budget,active),enumerable:true,writable:true,configurable:true});
  }
  active.delete(value);return out;
}
const value=v=>v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||Array.isArray(v)&&v.length<=128&&v.every(item=>typeof item==='string');
function option(o,input){
  return keys(o,['id','name','category','color'],input?['name']:['id','name'])
    &&(input&&o.id===undefined||schemaId(o.id))&&label(o.name)
    &&(o.category===undefined||['not_started','working','done'].includes(o.category))
    &&(o.color===undefined||label(o.color));
}
function property(p,input){
  if(!keys(p,['id','name','datatype','options','default'],input?['name','datatype']:['id','name','datatype','options'])
    ||!(input&&p.id===undefined||schemaId(p.id))||!label(p.name)||!types.has(p.datatype)
    ||!(input&&p.options===undefined||Array.isArray(p.options)&&p.options.length<=128&&p.options.every(o=>option(o,input)))
    ||p.default!==undefined&&!value(p.default))return false;
  if(p.options){const ids=p.options.filter(o=>o.id!==undefined).map(o=>o.id);if(new Set(ids).size!==ids.length)return false;}
  return true;
}
function properties(p,input){return Array.isArray(p)&&p.length<=128&&p.every(item=>property(item,input))&&new Set(p.filter(item=>item.id!==undefined).map(item=>item.id)).size===p.filter(item=>item.id!==undefined).length;}
function values(v){return object(v)&&Object.keys(v).length<=128&&Object.entries(v).every(([key,item])=>schemaId(key)&&value(item))&&size(JSON.stringify(v))<=65536;}
function captureDatabaseRequest(input){
  input=detached(input,MAX_DATABASE_REQUEST);
  if(!keys(input,['schemaVersion','command'])||input.schemaVersion!==1||!object(input.command))throw failure('invalid_database_request');
  const c=input.command,op=c.op;
  const fields={list:[],get:['collectionId'],get_entry:['entryId'],create:['operationId','name','preset','properties'],update:['operationId','collectionId','expectedRevision','name','properties','confirmDestructive'],create_entry:['operationId','collectionId','expectedCollectionRevision','entryId','path','body','values'],set_entry:['operationId','entryId','expectedRevision','expectedCollectionRevision','values'],duplicate_entry:['operationId','entryId','expectedRevision','newEntryId','path'],delete:['operationId','collectionId','expectedRevision'],restore:['operationId','collectionId','expectedRevision'],retry:[],compose:['entryId','expectedRevision','baseline','proposed']}[op];
  const optional=op==='create'?['preset','properties']:op==='update'?['confirmDestructive']:op==='create_entry'?['body','values']:[];
  if(!Array.isArray(fields)||!keys(c,['op',...fields],['op',...fields.filter(key=>!optional.includes(key))]))throw failure('invalid_database_request');
  for(const field of fields){const v=c[field];if(v===undefined&&optional.includes(field))continue;
    if(['entryId','newEntryId','operationId','expectedRevision','expectedCollectionRevision'].includes(field)&&!id(v)
      ||field==='collectionId'&&!schemaId(v)||field==='name'&&!label(v)||field==='preset'&&!['blank','tasks'].includes(v)
      ||field==='properties'&&!properties(v,true)||field==='values'&&!values(v)||field==='path'&&!path(v)
      ||['body','baseline','proposed'].includes(field)&&typeof v!=='string'||field==='confirmDestructive'&&typeof v!=='boolean')throw failure('invalid_database_request');
  }
  const command={op};for(const field of fields)if(c[field]!==undefined)command[field]=c[field];
  const result={schemaVersion:1,command};if(size(JSON.stringify(result))>MAX_DATABASE_REQUEST)throw failure('database_request_limit');return result;
}
function collection(c){return keys(c,['id','name','revision','deleted','properties'])&&schemaId(c.id)&&label(c.name)&&id(c.revision)&&typeof c.deleted==='boolean'&&properties(c.properties,false);}
function entry(e){return keys(e,['entryId','collectionId','revision','fileRevision','path','values','deleted','pendingProjection','problems'],['entryId','collectionId','revision','fileRevision','path','values','deleted','pendingProjection'])&&id(e.entryId)&&schemaId(e.collectionId)&&id(e.revision)&&(e.fileRevision===null||id(e.fileRevision))&&path(e.path)&&values(e.values)&&typeof e.deleted==='boolean'&&typeof e.pendingProjection==='boolean'&&(e.problems===undefined||object(e.problems)&&Object.keys(e.problems).length<=128&&Object.entries(e.problems).every(([key,message])=>schemaId(key)&&typeof message==='string'&&size(message)<=4096));}
function validateDatabaseValue(request,input){
  const uncertain=mutation(request.command.op),invalid=()=>failure('invalid_database_response',uncertain);
  let v;try{v=detached(input,MAX_DATABASE_RESPONSE);}catch{throw invalid();}
  if(!keys(v,['collections','entries','projection','composition'],['collections','entries','projection'])
    ||!Array.isArray(v.collections)||v.collections.length>256||!v.collections.every(collection)||new Set(v.collections.map(c=>c.id)).size!==v.collections.length
    ||!Array.isArray(v.entries)||v.entries.length>4096||!v.entries.every(entry)||new Set(v.entries.map(e=>e.entryId)).size!==v.entries.length
    ||!keys(v.projection,['pending','issues'])||!count(v.projection.pending,1000000)||!Array.isArray(v.projection.issues)||v.projection.issues.length>4096
    ||!v.projection.issues.every(issue=>keys(issue,['entryId','message'],['message'])&&(issue.entryId===undefined||id(issue.entryId))&&typeof issue.message==='string'&&size(issue.message)<=4096)
    ||size(JSON.stringify(v))>MAX_DATABASE_RESPONSE)throw invalid();
  const c=request.command;
  if(c.op==='list'&&v.entries.length||['get','update','delete','restore','create_entry'].includes(c.op)&&v.collections.some(item=>item.id!==c.collectionId)
    ||c.op==='get_entry'&&v.entries.some(item=>item.entryId!==c.entryId)
    ||v.entries.some(e=>!v.collections.some(collection=>collection.id===e.collectionId)))throw invalid();
  if(!['list','retry','compose'].includes(c.op)&&v.collections.length!==1
    ||c.op==='get_entry'&&(v.entries.length!==1||v.entries[0].entryId!==c.entryId)
    ||['create_entry','set_entry'].includes(c.op)&&!v.entries.some(e=>e.entryId===c.entryId)
    ||c.op==='duplicate_entry'&&!v.entries.some(e=>e.entryId===c.newEntryId))throw invalid();
  if(v.composition!==undefined){const x=v.composition;if(c.op!=='compose'||!keys(x,['content','currentSource','currentFileRevision','entryRevision','collectionRevision'])||typeof x.content!=='string'||typeof x.currentSource!=='string'||![x.currentFileRevision,x.entryRevision,x.collectionRevision].every(id))throw invalid();}
  return v;
}
function decodeDatabaseReply(request,marker,bytes){
  const invalid=()=>failure('invalid_database_response',mutation(request.command.op));
  if(!keys(marker,['databases','schemaVersion','bytes'])||marker.databases!==true||marker.schemaVersion!==1||!count(marker.bytes,MAX_DATABASE_RESPONSE)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length!==marker.bytes)throw invalid();
  let reply;try{reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw invalid();}
  if(!keys(reply,['schemaVersion','op','value'])||reply.schemaVersion!==1||reply.op!==request.command.op)throw invalid();
  return validateDatabaseValue(request,reply.value);
}
function validDatabaseReply(command,marker,bytes,requestBytes){try{if(!keys(command.request,['schemaVersion','bytes'])||command.request.schemaVersion!==1||!(requestBytes instanceof Uint8Array)||requestBytes.length!==command.request.bytes||requestBytes.length>MAX_DATABASE_REQUEST)return false;const request=captureDatabaseRequest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(requestBytes)));decodeDatabaseReply(request,marker,bytes);return true;}catch{return false;}}
function decodeDatabaseEnvelope(request,envelope){
  const invalid=()=>failure('invalid_database_response',mutation(request.command.op));
  let v;try{v=detached(envelope,MAX_DATABASE_RESPONSE+1024);}catch{throw invalid();}
  if(!keys(v,['databases','schemaVersion','ok','value','error'],['databases','schemaVersion','ok'])||v.databases!==true||v.schemaVersion!==1||typeof v.ok!=='boolean')throw invalid();
  if(v.ok){if(!keys(v,['databases','schemaVersion','ok','value']))throw invalid();return validateDatabaseValue(request,v.value);}
  const e=v.error;if(!keys(v,['databases','schemaVersion','ok','error'])||!keys(e,['code','source','commitUncertain'])||typeof e.code!=='string'||!/^[_a-z]{1,64}$/.test(e.code)||e.source!=='host'||typeof e.commitUncertain!=='boolean')throw invalid();
  throw failure(e.code,e.commitUncertain);
}
module.exports={MAX_DATABASE_REQUEST,MAX_DATABASE_RESPONSE,captureDatabaseRequest,validateDatabaseValue,decodeDatabaseReply,validDatabaseReply,decodeDatabaseEnvelope,isDatabaseMutation:mutation};
