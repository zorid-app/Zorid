import type {DesktopWorkBlockRequest,WorkBlockService} from '../core/workblocks.ts';

/** Private browser transport only. Rust owns domain validation and semantics. */
export type BrowserWorkBlockRequest=DesktopWorkBlockRequest;
const encoder=new TextEncoder();
const mutations=new Set(['create','move','title','add_ref','remove_ref','delete']);
export function workBlockFailure(code:string,commitUncertain=false,source:'host'|'rust'='host'):Error&{code:string;commitUncertain:boolean;source:'host'|'rust'}{
  return Object.assign(new Error(commitUncertain?'WorkBlock acknowledgement is uncertain; retain the identical request.':'WorkBlock request rejected.'),{code,commitUncertain,source});
}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:unknown,names:string[]):v is Record<string,any>=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const text=(v:unknown):v is string=>typeof v==='string';
const uint=(v:unknown,max:number):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
const decimal=(v:unknown):v is string=>text(v)&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
const revision=(v:unknown)=>Array.isArray(v)&&v.length===32&&Object.keys(v).length===32&&v.every(x=>uint(x,255));
const token=(v:unknown):v is string=>text(v)&&v.length>0&&encoder.encode(v).length<=2048;
const fields:Record<string,string[]>={create:['record','generation','operation','range','title'],read:['record','generation'],move:['record','generation','operation','expectedRevision','range'],title:['record','generation','operation','expectedRevision','title'],add_ref:['record','generation','operation','expectedRevision','task'],remove_ref:['record','generation','operation','expectedRevision','task'],delete:['record','generation','operation','expectedRevision'],window:['fromMs','untilMs','limit','byteLimit','cursor'],changes:['after','limit']};
/** Inspect descriptors without invoking accessors/toJSON; bound before copying. */
function capture(value:unknown,depth=0,budget={nodes:0}):any{
  if(depth>8||++budget.nodes>256)throw workBlockFailure('request_limit');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(text(value)){if(value.length>16384)throw workBlockFailure('request_limit');return value;}
  if(!object(value)&&!Array.isArray(value))throw workBlockFailure('invalid_workblock_request');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(!array&&proto!==null&&proto!==Object.prototype||Object.getOwnPropertySymbols(value).length)throw workBlockFailure('invalid_workblock_request');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Object.keys(descriptors).filter(k=>!array||k!=='length');
  if(names.length>(array?64:16)||array&&(value.length>64||names.length!==value.length))throw workBlockFailure('request_limit');
  // Object member order is transport spelling, not mutation identity. Arrays
  // retain order, including every opaque revision byte.
  if(!array)names.sort();
  const out:any=array?[]:Object.create(null);
  for(const name of names){const d=descriptors[name];if(!Object.hasOwn(d,'value')||!d.enumerable||array&&!/^(0|[1-9][0-9]*)$/.test(name))throw workBlockFailure('invalid_workblock_request');Object.defineProperty(out,name,{value:capture(d.value,depth+1,budget),enumerable:true});}
  return Object.freeze(out);
}
function request(op:string,input:unknown):BrowserWorkBlockRequest{
  const data=capture(input),allowed=fields[op];
  if(!object(data)||Object.keys(data).some(k=>!allowed.includes(k))||allowed.some(k=>!(op==='create'&&k==='title'||op==='window'&&k==='cursor')&&!Object.hasOwn(data,k)))throw workBlockFailure('invalid_workblock_request');
  const command:Record<string,any>={op};for(const name of allowed)if(Object.hasOwn(data,name))command[name]=data[name];
  // Primitive transport types only: no range arithmetic, ref identity or title rules.
  for(const name of ['record','generation','operation','task','after','fromMs','untilMs'])if(name in command&&!text(command[name]))throw workBlockFailure('invalid_workblock_request');
  if('operation'in command&&!command.operation)throw workBlockFailure('invalid_workblock_request');
  if('limit'in command&&typeof command.limit!=='number'||'byteLimit'in command&&typeof command.byteLimit!=='number')throw workBlockFailure('invalid_workblock_request');
  const result={schemaVersion:1 as const,command:Object.freeze(command) as BrowserWorkBlockRequest['command']};
  if(encoder.encode(JSON.stringify(result)).length>16384)throw workBlockFailure('request_limit');return Object.freeze(result);
}
function read(v:unknown):boolean{
  if(!keys(v,['record','generation','revision','created','deleted','block','unresolved'])||!text(v.record)||!text(v.generation)||!revision(v.revision)||typeof v.created!=='boolean'||typeof v.deleted!=='boolean'||!object(v.unresolved)||!Object.entries(v.unresolved).every(([k,n])=>k.length>0&&decimal(n)))return false;
  if(v.block===null)return !v.created||v.deleted;
  const b=v.block;
  return v.created&&!v.deleted&&keys(b,['ranges','titles','taskRefs'])&&Array.isArray(b.ranges)&&b.ranges.every((c:unknown)=>keys(c,['operation','range'])&&text(c.operation)&&keys(c.range,['start_ms','end_ms','timezone'])&&Object.values(c.range).every(text))&&Array.isArray(b.titles)&&b.titles.every((c:unknown)=>keys(c,['operation','title'])&&text(c.operation)&&(c.title===null||text(c.title)))&&Array.isArray(b.taskRefs)&&b.taskRefs.every(text);
}
export function decodeBrowserWorkBlockReply(request:BrowserWorkBlockRequest,reply:unknown):unknown{
  const c=request.command,malformed=()=>workBlockFailure('invalid_workblock_response',mutations.has(c.op));
  try{if(encoder.encode(JSON.stringify(reply)).length>4194304)throw 0;}catch{throw malformed();}
  if(!keys(reply,['schemaVersion','op','value'])||reply.schemaVersion!==1||reply.op!==c.op)throw malformed();
  const v=reply.value;let valid=false;
  if(mutations.has(c.op))valid=keys(v,['operation','revision','sequence'])&&v.operation===c.operation&&revision(v.revision)&&decimal(v.sequence)&&v.sequence!=='0';
  else if(c.op==='read')valid=read(v)&&v.record===c.record&&v.generation===c.generation;
  else if(c.op==='window')valid=keys(v,['blocks','cursor','incomplete','watermark','scanned','bytes'])&&Array.isArray(v.blocks)&&v.blocks.every((b:unknown)=>read(b)&&object(b)&&b.block!==null)&&uint(v.scanned,c.limit as number)&&v.blocks.length<=v.scanned&&new Set(v.blocks.map((b:any)=>JSON.stringify([b.record,b.generation]))).size===v.blocks.length&&uint(v.bytes,c.byteLimit as number)&&(v.scanned===0?v.bytes===0:v.bytes>0)&&decimal(v.watermark)&&(v.cursor===null||token(v.cursor))&&v.incomplete===(v.cursor!==null)&&(!v.incomplete||v.scanned>0&&v.cursor!==c.cursor);
  else if(c.op==='changes'){
    valid=keys(v,['changes','next'])&&Array.isArray(v.changes)&&v.changes.length<=Number(c.limit)&&decimal(v.next)&&decimal(c.after);
    let previous=valid?BigInt(c.after as string):0n;
    if(valid)for(const change of v.changes){
      if(!keys(change,['sequence','record_key','update_id','status'])||!decimal(change.sequence)||BigInt(change.sequence)<=previous||!token(change.record_key)||!text(change.update_id)||!/^[\x21-\x7e]{1,128}$/.test(change.update_id)||!text(change.status)||!change.status){valid=false;break;}
      let identity:unknown;try{identity=JSON.parse(change.record_key);}catch{valid=false;break;}
      if(!Array.isArray(identity)||identity.length!==2||!identity.every(x=>text(x)&&/^[\x21-\x7e]{1,128}$/.test(x))){valid=false;break;}
      previous=BigInt(change.sequence);
    }
    if(valid)valid=v.next===String(previous);
  }
  if(!valid)throw malformed();return v;
}
export function createBrowserWorkBlocks(invoke:(request:BrowserWorkBlockRequest)=>Promise<unknown>):{service:WorkBlockService;stop():void;drain():Promise<void>}{
  let stopped=false;const pending=new Set<Promise<unknown>>(),retained=new Map<string,{encoded:string;uncertain:boolean;call?:Promise<any>}>();
  function command<T>(op:string,input:unknown):Promise<T>{
    if(stopped)return Promise.reject(workBlockFailure('client_not_admitted'));
    let captured:BrowserWorkBlockRequest;try{captured=request(op,input);}catch(error){return Promise.reject(error);}
    const operation=mutations.has(op)?captured.command.operation as string:undefined,encoded=JSON.stringify(captured),prior=operation?retained.get(operation):undefined;
    if(prior&&prior.encoded!==encoded)return Promise.reject(workBlockFailure('operation_collision'));
    if(prior?.call)return prior.call;
    if(operation&&!prior&&retained.size>=32)return Promise.reject(workBlockFailure('request_limit'));
    const state=prior??{encoded,uncertain:false,call:undefined};if(operation)retained.set(operation,state);
    const call=Promise.resolve().then(()=>invoke(captured)).then(reply=>decodeBrowserWorkBlockReply(captured,reply)).then(value=>{if(operation)retained.delete(operation);return value as T;},error=>{
      state.call=undefined;
      const e=error as {code?:unknown;source?:unknown;commitUncertain?:unknown};
      // A definite abort proves only this attempt did not commit. An older
      // unresolved attempt keeps its exact fingerprint until a valid receipt.
      if(e?.commitUncertain===false&&!state.uncertain){if(operation)retained.delete(operation);throw error;}
      if(operation)state.uncertain=true;
      throw workBlockFailure(typeof e?.code==='string'?e.code:'outcome_unknown',!!operation,e?.source==='rust'?'rust':'host');
    });
    state.call=call;pending.add(call);void call.then(()=>pending.delete(call),()=>pending.delete(call));return call;
  }
  return {service:Object.freeze<WorkBlockService>({create:i=>command('create',i),read:i=>command('read',i),windowPage:i=>command('window',i),move:i=>command('move',i),title:i=>command('title',i),addRef:i=>command('add_ref',i),removeRef:i=>command('remove_ref',i),delete:i=>command('delete',i),changes:i=>command('changes',i)}),stop(){stopped=true;},async drain(){while(pending.size)await Promise.allSettled([...pending]);}};
}
