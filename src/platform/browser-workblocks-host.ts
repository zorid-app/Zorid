import { isWorkBlockDefiniteAbort, callWorkBlockWasm } from '../core/browser-managed-records.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserStreamingManagedRecords } from '../core/browser-sync-streaming.ts';
import type { ManagedCollectionHandle, ManagedCommitOutcome, ManagedScope, RecordsPlan } from '../core/browser-managed-records.ts';
import type { ManagedHostScope, WorkBlockRegistrationWasm } from './browser-managed-records-registry.ts';

interface WindowScan {
  afterKeyJson():string|null;
  watermark():string;
  offer(snapshot:Uint8Array,nextKeyJson:string):boolean;
  finish(eof:boolean,opaqueToken:string):Uint8Array;
  free():void;
}
interface WindowSession { begin(queryJson:string,watermark:string):WindowScan; close():void }
export interface BrowserWorkBlocksWasm extends WorkBlockRegistrationWasm {
  workBlockReadSet(enrolledScopeJson:string,request:Uint8Array):string;
  workBlockReplay(enrolledScopeJson:string,request:Uint8Array,priorRequest:Uint8Array|undefined,priorResult:Uint8Array|undefined):Uint8Array|undefined;
  prepareWorkBlockLocal(factsJson:string,request:Uint8Array):RecordsPlan;
  workBlockStorageKey(keyJson:string):string;
  workBlockSnapshot(scopeJson:string,state:Uint8Array|undefined,unresolvedRowsJson:string):Uint8Array;
  workBlockRead(snapshot:Uint8Array):Uint8Array;
  workBlockChanges(rowsJson:string,after:string):Uint8Array;
  WorkBlockWindowSession:new()=>WindowSession;
}
/** Private facade owned by D; keep its durable methods on the same adapter. */
interface Records extends Pick<BrowserStreamingManagedRecords,'snapshot'|'changes'> {
  applyWorkBlock(handle:ManagedCollectionHandle,request:Uint8Array):Promise<ManagedCommitOutcome>;
  watermark(handle:ManagedCollectionHandle):Promise<string>;
  exportOne(handle:ManagedCollectionHandle,afterKeyJson:string|null):Promise<{snapshot:Uint8Array;nextKeyJson:string}|null>;
}
interface Host {
  records:Records; wasm:BrowserWorkBlocksWasm;
  scope():Promise<ManagedHostScope|null>;
  assertActive():void;
  committed():Promise<void>;
}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const failure=(code:string,uncertain=false)=>Object.assign(new BrowserVaultError(code,'Browser WorkBlock operation could not finish'),{commitUncertain:uncertain});
const bindings=['workBlockIdentity','workBlockRegistration','workBlockReadSet','workBlockReplay','prepareWorkBlockLocal','workBlockStorageKey','workBlockSnapshot','workBlockRead','workBlockChanges','WorkBlockWindowSession'] as const;
export function createBrowserWorkBlocksHost(host:Host) {
  if(bindings.some(name=>typeof host.wasm[name]!=='function')||['applyWorkBlock','watermark','exportOne'].some(name=>typeof host.records[name as keyof Records]!=='function'))
    throw failure('workblocks_unavailable');
  const session=callWorkBlockWasm(() => new host.wasm.WorkBlockWindowSession());
  let handle:ManagedCollectionHandle|undefined,stopped=false;
  const accepted=new Set<Promise<unknown>>();
  const active=()=>{host.assertActive();if(stopped)throw failure('client_not_admitted');};
  const decoded=(bytes:Uint8Array):unknown=>{
    if(!(bytes instanceof Uint8Array)||bytes.byteLength>4*1024*1024)throw failure('invalid_workblock_response');
    return JSON.parse(decoder.decode(bytes));
  };
  async function run(payload:unknown):Promise<unknown> {
    let mutation=false,attempted=false,durableReturned=false;
    try {
      active();if(!handle)throw failure('workblocks_unavailable');
      const envelope=payload as {schemaVersion?:unknown;command?:Record<string,unknown>};
      if(!envelope||envelope.schemaVersion!==1||!envelope.command||typeof envelope.command!=='object'||Array.isArray(envelope.command)||Object.keys(envelope).some(key=>!['schemaVersion','command'].includes(key)))throw failure('invalid_request');
      // Structured-clone RPC input has no getters. Capture before the first await;
      // Rust alone validates strict command fields and all domain semantics.
      const request=encoder.encode(JSON.stringify(envelope.command));
      if(request.byteLength>16*1024)throw failure('invalid_request');
      const command=JSON.parse(decoder.decode(request));
      mutation=!['read','window','changes'].includes(command.op);
      const scope=await host.scope();active();if(!scope)throw failure('not_enrolled');
      const readSet=JSON.parse(callWorkBlockWasm(() => host.wasm.workBlockReadSet(JSON.stringify({realm_id:scope.realm_id,vault_id:scope.vault_id}),request))) as {scope:ManagedScope;operation:string|null;kind:string};
      let value:unknown;
      if(readSet.kind==='mutation') {
        attempted=true;
        const outcome=await host.records.applyWorkBlock(handle,request);durableReturned=true;active();
        value=decoded(outcome.result);
        await host.committed();active();
      } else if(readSet.kind==='read') {
        const snapshot=await host.records.snapshot(handle,readSet.scope);active();
        value=decoded(callWorkBlockWasm(() => host.wasm.workBlockRead(host.wasm.workBlockSnapshot(JSON.stringify(readSet.scope),snapshot.state,JSON.stringify(snapshot.unresolved)))));active();
      } else if(readSet.kind==='changes') {
        const rows=await host.records.changes(handle,command.after,command.limit);active();
        value=decoded(callWorkBlockWasm(() => host.wasm.workBlockChanges(JSON.stringify(rows),command.after)));active();
      } else if(readSet.kind==='window') {
        const watermark=await host.records.watermark(handle);active();
        const scan=callWorkBlockWasm(() => session.begin(JSON.stringify(command),watermark));
        try {
          if(callWorkBlockWasm(() => scan.watermark())!==watermark)throw failure('window_changed');
          let eof=false;
          // Rust owns row/byte budgets and intersection filtering. At most 64
          // accepted rows plus one unconsumed candidate, never a full listing.
          for(let count=0;count<65;count++) {
            active();const row=await host.records.exportOne(handle,callWorkBlockWasm(() => scan.afterKeyJson())??null);active();
            if(!row){eof=true;break;}
            if(!callWorkBlockWasm(() => scan.offer(row.snapshot,row.nextKeyJson)))break;
            if(count===64)throw failure('invalid_workblock_response');
          }
          const after=await host.records.watermark(handle);active();
          if(after!==watermark)throw failure('window_changed');
          value=decoded(callWorkBlockWasm(() => scan.finish(eof,eof?'':crypto.randomUUID())));active();
        } finally {callWorkBlockWasm(() => scan.free());}
      } else throw failure('invalid_workblock_response');
      active();return {schemaVersion:1,op:command.op,value};
    } catch(error) {
      const row=error as {code?:unknown;source?:unknown;commitUncertain?:unknown;message?:unknown;details?:unknown};
      // Only D's private transaction witness proves rollback after dispatch. Public
      // source/commitUncertain fields cannot establish storage's terminal outcome.
      const uncertain=mutation&&attempted&&(durableReturned||!isWorkBlockDefiniteAbort(error));
      if(error instanceof BrowserVaultError)throw Object.assign(error,{commitUncertain:uncertain});
      if(typeof row?.code==='string'&&row.source==='rust')throw Object.assign(new BrowserVaultError(row.code,'WorkBlock core rejected the request',row.details,'rust'),{commitUncertain:uncertain});
      throw failure('workblock_failed',uncertain);
    }
  }
  return {
    opened(next:ManagedCollectionHandle){active();if(handle)throw failure('workblocks_already_open');handle=next;},
    get ready(){return !!handle&&!stopped;},
    execute(payload:unknown){
      if(stopped)return Promise.reject(failure('client_not_admitted'));
      const task=run(payload);accepted.add(task);void task.then(()=>accepted.delete(task),()=>accepted.delete(task));return task;
    },
    stop(){stopped=true;},
    async drain(){await Promise.allSettled([...accepted]);callWorkBlockWasm(() => session.close());handle=undefined;},
  };
}
