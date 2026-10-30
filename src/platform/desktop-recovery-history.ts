import type {RecoveryCursor,RecoveryVersion} from './bridge';
const failure=()=>Object.assign(new Error('Invalid admitted history response.'),{code:'invalid_durable_response',source:'protocol',commitUncertain:false});
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
const keys=(value:unknown,required:string[],optional:string[]=[]):value is Record<string,unknown>=>plain(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const snapshot=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function utf8Length(value:string):number{
 let bytes=0;
 for(let i=0;i<value.length;i++){
  const unit=value.charCodeAt(i);
  if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw failure();bytes+=4;}
  else if(unit>=0xdc00&&unit<=0xdfff)throw failure();
  else bytes+=unit<0x80?1:unit<0x800?2:3;
 }
 return bytes;
}
function cursor(value:unknown):value is RecoveryCursor{return keys(value,['captured_at_ms','snapshot_id'])&&time(value.captured_at_ms)&&snapshot(value.snapshot_id);}
function version(value:unknown,entryId:string):value is RecoveryVersion{
 if(!keys(value,['snapshotId','entryId','path','capturedAtMs','byteLength'])||value.entryId!==entryId||!snapshot(value.snapshotId)||!time(value.capturedAtMs)||!time(value.byteLength)||value.byteLength>16*1024*1024||typeof value.path!=='string')return false;
 return utf8Length(value.path)<=4096&&!/[\\\u0000-\u001f\u007f]/.test(value.path)&&!value.path.startsWith('/')&&!/^[A-Za-z]:/.test(value.path)&&!value.path.split('/').some(part=>!part||part==='.'||part==='..')&&!/^\.zorid(?:\/|$)/i.test(value.path);
}
export type HistoryRequest={readonly method:'recoveryList';readonly entryId:string;readonly options:{readonly limit:number;readonly before?:RecoveryCursor}}|{readonly method:'recoveryRead';readonly entryId:string;readonly snapshotId:string};
export function captureHistoryList(entryId:string,options:{limit:number;before?:RecoveryCursor}):HistoryRequest{
 if(!id(entryId)||!keys(options,['limit'],['before'])||!Number.isInteger(options.limit)||options.limit<1||options.limit>100||options.before!==undefined&&!cursor(options.before))throw failure();
 return Object.freeze({method:'recoveryList',entryId,options:Object.freeze({limit:options.limit,...(options.before?{before:Object.freeze({...options.before})}:{})})});
}
export function captureHistoryRead(entryId:string,snapshotId:string):HistoryRequest{if(!id(entryId)||!snapshot(snapshotId))throw failure();return Object.freeze({method:'recoveryRead',entryId,snapshotId});}
export function decodeHistory(request:HistoryRequest,value:unknown):{versions:RecoveryVersion[];nextCursor?:RecoveryCursor}|{version:RecoveryVersion;content:string}{
 if(request.method==='recoveryRead'){
  if(!keys(value,['version','content'])||!version(value.version,request.entryId)||value.version.snapshotId!==request.snapshotId||typeof value.content!=='string'||value.content.length>16*1024*1024||utf8Length(value.content)!==value.version.byteLength)throw failure();
  return {version:Object.freeze({...value.version}),content:value.content};
 }
 if(!keys(value,['versions'],['nextCursor'])||!Array.isArray(value.versions)||value.versions.length>request.options.limit)throw failure();
 let before=request.options.before;
 for(const row of value.versions){if(!version(row,request.entryId)||before&&!(row.capturedAtMs<before.captured_at_ms||row.capturedAtMs===before.captured_at_ms&&BigInt(row.snapshotId)<BigInt(before.snapshot_id)))throw failure();before={captured_at_ms:row.capturedAtMs,snapshot_id:row.snapshotId};}
 let nextCursor:RecoveryCursor|undefined;
 if(value.nextCursor===undefined){if(value.versions.length>=request.options.limit)throw failure();}
 else{
  const candidate=value.nextCursor;
  if(!cursor(candidate)||value.versions.length!==request.options.limit||!before||candidate.captured_at_ms!==before.captured_at_ms||candidate.snapshot_id!==before.snapshot_id)throw failure();
  nextCursor=Object.freeze({captured_at_ms:candidate.captured_at_ms,snapshot_id:candidate.snapshot_id});
 }
 return {versions:value.versions.map(row=>Object.freeze({...row})),...(nextCursor?{nextCursor}:{})};
}
