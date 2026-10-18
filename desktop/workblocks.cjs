'use strict';
// First-party semantic DTO boundary only. Rust owns fixed registration, domain
// validation, cursor authority, storage receipts and idempotent operation replay.
const MAX_WORKBLOCK_REQUEST=16*1024,MAX_WORKBLOCK_RESPONSE=4*1024*1024;
const encoder=new TextEncoder(),size=value=>encoder.encode(value).byteLength;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed,required=allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,128}$/.test(value);
const entryId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const uint=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const revision=value=>Array.isArray(value)&&value.length===32&&Object.keys(value).length===32&&value.every(byte=>uint(byte,255));
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const instant=value=>typeof value==='string'&&/^(0|-?[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)>=-9223372036854775808n&&BigInt(value)<=9223372036854775807n;
const text=value=>typeof value==='string'&&size(value)<=512;
const cursor=value=>typeof value==='string'&&value.length>0&&size(value)<=2048&&!/[\x00-\x20\x7f]/.test(value);
const token=value=>typeof value==='string'&&value.length>0&&size(value)<=2048;
const statusString=value=>typeof value==='string'&&value.length>0&&size(value)<=128;
function failure(code,uncertain=false){return Object.assign(new Error(uncertain?'WorkBlock acknowledgement is uncertain; retain the identical operation ID and request.':'WorkBlock request rejected.'),{code,source:'host',commitUncertain:uncertain});}
function range(value){return keys(value,['start_ms','end_ms','timezone'])&&instant(value.start_ms)&&instant(value.end_ms)&&BigInt(value.end_ms)>BigInt(value.start_ms)&&typeof value.timezone==='string'&&value.timezone.length>0&&size(value.timezone)<=128;}
const mutations=new Set(['create','move','title','add_ref','remove_ref','delete']);
// IPC supplies plain data. Also reject accessors/toJSON/nonplain inputs for
// direct callers, without invoking user code between validation and capture.
function detached(value,depth=0,budget={nodes:0}){
  if(depth>8||++budget.nodes>256)throw failure('request_limit');
  if(value===null||value===undefined||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string'){if(value.length>MAX_WORKBLOCK_REQUEST)throw failure('request_limit');return value;}
  if(typeof value!=='object'||Object.getOwnPropertySymbols(value).length)throw failure('invalid_workblock_request');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(!array&&proto!==null&&proto!==Object.prototype)throw failure('invalid_workblock_request');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Object.keys(descriptors).filter(key=>!(array&&key==='length'));
  if(names.length>(array?64:16)||array&&(value.length>64||names.length!==value.length))throw failure('request_limit');
  const out=array?[]:{};
  for(const name of names){
    const d=descriptors[name];
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9][0-9]*)$/.test(name))throw failure('invalid_workblock_request');
    Object.defineProperty(out,name,{value:detached(d.value,depth+1,budget),enumerable:true,writable:true,configurable:true});
  }
  return out;
}
function captureWorkBlockRequest(input){
  input=detached(input);
  if(!keys(input,['schemaVersion','command'])||input.schemaVersion!==1||!object(input.command))throw failure('invalid_workblock_request');
  const c=input.command,op=c.op;
  const fields={create:['record','generation','operation','range','title'],read:['record','generation'],move:['record','generation','operation','expectedRevision','range'],title:['record','generation','operation','expectedRevision','title'],add_ref:['record','generation','operation','expectedRevision','task'],remove_ref:['record','generation','operation','expectedRevision','task'],delete:['record','generation','operation','expectedRevision'],window:['fromMs','untilMs','limit','byteLimit','cursor'],changes:['after','limit']}[op];
  if(!Array.isArray(fields)||!keys(c,['op',...fields],['op',...fields.filter(key=>!(op==='create'&&key==='title'||op==='window'&&key==='cursor'))]))throw failure('invalid_workblock_request');
  for(const field of fields){
    const value=c[field];
    if(['record','generation','operation'].includes(field)&&!id(value)||field==='task'&&!entryId(value)||field==='range'&&!range(value)||field==='expectedRevision'&&!revision(value)||field==='title'&&!(value===null||text(value)||op==='create'&&value===undefined)||['fromMs','untilMs'].includes(field)&&!instant(value)||field==='limit'&&(!uint(value,64)||!value)||field==='byteLimit'&&(!uint(value,1048576)||!value)||field==='cursor'&&value!==undefined&&value!==null&&!cursor(value)||field==='after'&&!decimal(value))throw failure('invalid_workblock_request');
  }
  if(op==='window'&&(BigInt(c.untilMs)<=BigInt(c.fromMs)||BigInt(c.untilMs)-BigInt(c.fromMs)>2678400000n))throw failure('invalid_workblock_request');
  const command={op};
  for(const field of fields)if(c[field]!==undefined)command[field]=structuredClone(c[field]);
  const out={schemaVersion:1,command};
  if(size(JSON.stringify(out))>MAX_WORKBLOCK_REQUEST)throw failure('request_limit');
  return out;
}
function captureWorkBlockCommand(op,input){
  return captureWorkBlockRequest({schemaVersion:1,command:{...detached(input),op}});
}
function read(value){
  if(!keys(value,['record','generation','revision','created','deleted','block','unresolved'])||!id(value.record)||!id(value.generation)||!revision(value.revision)||typeof value.created!=='boolean'||typeof value.deleted!=='boolean'||!object(value.unresolved)||Object.keys(value.unresolved).length>4096||!Object.entries(value.unresolved).every(([key,status])=>statusString(key)&&decimal(status)))return false;
  if(value.block===null)return !value.created||value.deleted;
  const b=value.block;
  return value.created&&!value.deleted&&keys(b,['ranges','titles','taskRefs'])&&Array.isArray(b.ranges)&&b.ranges.length>0&&b.ranges.length<=4096&&b.ranges.every(candidate=>keys(candidate,['operation','range'])&&id(candidate.operation)&&range(candidate.range))&&new Set(b.ranges.map(c=>c.operation)).size===b.ranges.length
    &&Array.isArray(b.titles)&&b.titles.length<=4096&&b.titles.every(candidate=>keys(candidate,['operation','title'])&&id(candidate.operation)&&(candidate.title===null||text(candidate.title)))&&new Set(b.titles.map(c=>c.operation)).size===b.titles.length
    &&Array.isArray(b.taskRefs)&&b.taskRefs.length<=64&&b.taskRefs.every(entryId)&&new Set(b.taskRefs).size===b.taskRefs.length;
}
function validateWorkBlockValue(request,value){
  const c=request.command;
  let valid=false;
  if(mutations.has(c.op))valid=keys(value,['operation','revision','sequence'])&&value.operation===c.operation&&revision(value.revision)&&decimal(value.sequence)&&value.sequence!=='0';
  else if(c.op==='read')valid=read(value)&&value.record===c.record&&value.generation===c.generation;
  else if(c.op==='window')valid=keys(value,['blocks','cursor','incomplete','watermark','scanned','bytes'])&&Array.isArray(value.blocks)&&value.blocks.length<=c.limit&&value.blocks.every(b=>read(b)&&b.block!==null&&b.block.ranges.some(candidate=>BigInt(candidate.range.start_ms)<BigInt(c.untilMs)&&BigInt(candidate.range.end_ms)>BigInt(c.fromMs)))&&new Set(value.blocks.map(b=>JSON.stringify([b.record,b.generation]))).size===value.blocks.length&&(value.cursor===null||cursor(value.cursor))&&value.incomplete===(value.cursor!==null)&&(!value.incomplete||value.scanned>0&&value.cursor!==c.cursor)&&decimal(value.watermark)&&uint(value.scanned,c.limit)&&value.scanned>=value.blocks.length&&uint(value.bytes,c.byteLimit)&&(value.scanned===0?value.bytes===0:value.bytes>0);
  else if(c.op==='changes'){
    valid=keys(value,['changes','next'])&&Array.isArray(value.changes)&&value.changes.length<=c.limit&&decimal(value.next)&&BigInt(value.next)>=BigInt(c.after);
    let previous=BigInt(c.after);
    if(valid)for(const change of value.changes){
      if(!keys(change,['sequence','record_key','update_id','status'])||!decimal(change.sequence)||BigInt(change.sequence)<=previous||BigInt(change.sequence)>BigInt(value.next)||typeof change.record_key!=='string'||!change.record_key||size(change.record_key)>2048||!token(change.update_id)||!statusString(change.status)){valid=false;break;}
      previous=BigInt(change.sequence);
    }
    if(valid)valid=value.next===String(previous);
  }
  if(!valid||size(JSON.stringify(value))>MAX_WORKBLOCK_RESPONSE)throw failure('invalid_workblock_response',mutations.has(c.op));
  return value;
}
function decodeWorkBlockReply(request,marker,bytes){
  const fail=()=>failure('invalid_workblock_response',mutations.has(request.command.op));
  if(!keys(marker,['workblocks','schemaVersion','bytes'])||marker.workblocks!==true||marker.schemaVersion!==1||!uint(marker.bytes,MAX_WORKBLOCK_RESPONSE)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length!==marker.bytes)throw fail();
  let reply;try{reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail();}
  if(!keys(reply,['schemaVersion','op','value'])||reply.schemaVersion!==1||reply.op!==request.command.op)throw fail();
  return validateWorkBlockValue(request,reply.value);
}
function validWorkBlockReply(command,marker,bytes){try{decodeWorkBlockReply(command.request,marker,bytes);return true;}catch{return false;}}
module.exports={MAX_WORKBLOCK_REQUEST,MAX_WORKBLOCK_RESPONSE,captureWorkBlockCommand,captureWorkBlockRequest,decodeWorkBlockReply,validWorkBlockReply,validateWorkBlockValue};
