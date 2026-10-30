import type {ConditionalSavedSourceRequest,DurableWrites,PendingSavedSourceRequest} from '../core/durable-writes.ts';

interface RecoveryOwner {
  readonly validate:()=>void;
  readonly unopened:(entryId:string)=>boolean;
  readonly resume:(request:ConditionalSavedSourceRequest,operationId:string,validate:()=>void)=>Promise<boolean>;
}
const owners=new WeakMap<DurableWrites,RecoveryOwner&{active?:Promise<void>}>();
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const id=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&!value.includes('\0');
const data=(value:unknown,keys:readonly string[]):value is Record<string,any>=>record(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const field=Object.getOwnPropertyDescriptor(value,key);return!!field&&Object.hasOwn(field,'value');});
const witness=(value:unknown):boolean=>data(value,['entryId','revision','path'])&&id(value.entryId)&&id(value.revision)&&typeof value.path==='string';
const matches=(left:Record<string,any>,right:Record<string,any>)=>['entryId','revision','path'].every(key=>left[key]===right[key]);

/** One Workspace owns this provider's unopened actors. This is a capacity-only
 * continuation of accepted conditional writes, never a general idle save lane. */
export function registerNoteCaptureCapacityRecovery(writes:DurableWrites,owner:RecoveryOwner):()=>void{
  const registered={...owner};owners.set(writes,registered);
  return()=>{if(owners.get(writes)===registered)owners.delete(writes);};
}

export async function recoverNoteCaptureCapacity(writes:DurableWrites,requester:string,validate:()=>void):Promise<void>{
  const owner=owners.get(writes);if(!owner||!writes.listSavedSourceRequests)return;
  const scope={...writes.checkpoints.scope};
  const check=()=>{validate();owner.validate();if(owners.get(writes)!==owner||writes.checkpoints.scope.vaultId!==scope.vaultId||writes.checkpoints.scope.clientId!==scope.clientId)throw Error('The capture recovery owner changed; pending operations are retained.');};
  check();
  if(owner.active){try{await owner.active;}catch{/* Another requester may have canceled its own wait. */}check();return;}
  const task=(async()=>{
    const listed=await writes.listSavedSourceRequests!();check();
    if(!Array.isArray(listed)||listed.length>8||listed.some(row=>!data(row,['captureId','logicalWitness','legacy'])||typeof row.captureId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.captureId)||!witness(row.logicalWitness)||typeof row.legacy!=='boolean')||new Set(listed.map(row=>row.captureId)).size!==listed.length)return;
    const pending:readonly PendingSavedSourceRequest[]=listed.map(row=>Object.freeze({captureId:row.captureId,legacy:row.legacy,logicalWitness:Object.freeze({entryId:row.logicalWitness.entryId,revision:row.logicalWitness.revision,path:row.logicalWitness.path})}));
    for(const row of pending){
      check();const entryId=row.logicalWitness.entryId;
      if(row.legacy||entryId===requester||!owner.unopened(entryId))continue;
      const key=`note/v1/${entryId}`,head=await writes.checkpoints.load(key);check();
      if(!owner.unopened(entryId)||!head||head.vaultId!==scope.vaultId||head.clientId!==scope.clientId||head.key!==key||head.deleted||typeof head.encodedState!=='string')continue;
      let state:any;try{state=JSON.parse(head.encodedState);}catch{continue;}
      const op=state?.operation,input=op?.input,guard=input?.conditionalSavedSource;
      // Pending Native guards cannot already belong to a prepared ref. The
      // actor's normal decoder still validates the complete state before work.
      if(!record(state)||state.version!==1||!record(state.base)||state.base.entryId!==entryId||!record(op)||op.ref!==undefined||!record(input)||!id(input.operationId)||typeof op.content!=='string'||op.content!==input.content
        ||input.expectedEntryId!==entryId||input.expectedRevision!==row.logicalWitness.revision||input.path!==row.logicalWitness.path
        ||!record(guard)||guard.captureId!==row.captureId||!witness(guard.logicalWitness)||!matches(guard.logicalWitness,row.logicalWitness))continue;
      const request=Object.freeze({captureId:row.captureId,logicalWitness:Object.freeze({...row.logicalWitness})});
      try{if(await owner.resume(request,input.operationId,check)){check();return;}}
      catch{check();/* The target keeps its own draft/error. No inferred release. */}
    }
  })();
  owner.active=task;
  try{await task;check();}finally{if(owner.active===task)owner.active=undefined;}
}
