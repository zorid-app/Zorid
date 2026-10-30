import {captureDatabaseRequest} from '../../desktop/databases.cjs';
import type {DatabaseRequest,DatabaseResponse,DatabaseService} from '../core/databases.ts';

export type CollectionSubmit=(command:DatabaseRequest,complete:(reply:DatabaseResponse,recovering:boolean,validateAttempt:()=>void)=>Promise<void>)=>Promise<void>;
export interface CollectionSubmissionOptions {
  readonly service:DatabaseService;
  /** Exact component/actor lifetime; completion callbacks retain this guard after awaits. */
  readonly validate:()=>void;
  readonly contains:(command:DatabaseRequest)=>boolean;
  readonly hold:(command:DatabaseRequest)=>()=>void;
  readonly claim:(command:DatabaseRequest)=>()=>void;
  readonly capture?:(command:DatabaseRequest)=>void;
  readonly receipt?:(reply:DatabaseResponse,command:DatabaseRequest)=>void;
}
export interface CollectionSubmission {
  readonly submit:CollectionSubmit;
  readonly pending:boolean;
  readonly submitted:boolean;
  readonly currentCommand:DatabaseRequest|undefined;
  readonly currentReceipt:DatabaseResponse|undefined;
  /** Observe the installed task only; lifecycle drains never start a retry. */
  waitForCompletion():Promise<void>;
  canRecover():boolean;
  /** Call settle only after a checked positive same-authority admission ACK. */
  prepareAdmissionRecovery():{settle():Promise<void>}|undefined;
  close():void;
}

function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
}
function deferred(){let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject};}
const cancelled=()=>Object.assign(new Error('The collection editor was closed; its submitted command was retained.'),{code:'collection_submission_cancelled',source:'context'});
const pending=()=>Object.assign(new Error('The original collection change must finish before another one can be submitted.'),{code:'collection_submission_pending',source:'context'});
function field(error:unknown,key:string):unknown {
  if(!error||typeof error!=='object')return;
  const descriptor=Object.getOwnPropertyDescriptor(error,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
function retired(error:unknown):boolean {
  const code=field(error,'code');
  return error instanceof Error&&!('cause'in error)&&field(error,'source')==='host'&&typeof code==='string'&&(['client_not_admitted','client_ownership_lost'].includes(code)
    ||code==='host_exited'&&field(error,'commitUncertain')===true);
}
const published=(reply:DatabaseResponse)=>reply.projection.pending===0&&reply.projection.issues.length===0;
type Stage='capture'|'rpc'|'receipt'|'complete';
interface Submission {
  readonly command:DatabaseRequest;readonly identity:string;
  readonly complete:Parameters<CollectionSubmit>[1];
  result:ReturnType<typeof deferred>;readonly cancelled:ReturnType<typeof deferred>;
  epoch:number;dispatched:boolean;received:boolean;indeterminate:boolean;receipt?:DatabaseResponse;
  error?:unknown;stage:Stage;hold?:()=>void;claim?:()=>void;
  prepared?:{settle():Promise<void>};settling?:Promise<void>;outerSettled:boolean;
}

/** One accepted UI task owns its command, receipt and completion together. A
 * passive receipt hold never selects a command for replay. Only synchronous
 * admission preparation claims an existing, positively admitted capsule. */
export function createCollectionSubmission(options:CollectionSubmissionOptions):CollectionSubmission {
  let closed=false,current:Submission|undefined;
  const owns=(record:Submission,epoch?:number)=>!closed&&current===record&&(epoch===undefined||record.epoch===epoch);
  const release=(record:Submission)=>{const claim=record.claim,hold=record.hold;record.claim=record.hold=undefined;try{claim?.();}finally{hold?.();}};
  const recoverable=(record:Submission)=>record.error===undefined||record.stage!=='receipt'&&record.stage!=='capture'&&retired(record.error);
  function canRecover():boolean {
    const record=current;if(closed||!record||!record.dispatched||!recoverable(record))return false;
    try{options.validate();if(!owns(record))return false;const admitted=options.contains(record.command);return owns(record)&&admitted;}catch{return false;}
  }
  async function execute(record:Submission,recovering:boolean):Promise<void> {
    const epoch=++record.epoch;
    try{
      if(!owns(record,epoch))return;options.validate();if(!owns(record,epoch))return;
      let reply=record.receipt;
      if(!reply||!published(reply)){
        record.stage='rpc';record.dispatched=true;
        reply=await options.service.request(record.command);
        if(!owns(record,epoch))return;
        record.received=true;options.validate();if(!owns(record,epoch))return;record.stage='receipt';
        const captured=freeze(structuredClone(reply));options.receipt?.(captured,record.command);record.receipt=captured;reply=captured;
      }
      if(!owns(record,epoch))return;options.validate();if(!owns(record,epoch))return;record.stage='complete';
      const validateAttempt=()=>{if(!owns(record,epoch))throw cancelled();options.validate();if(!owns(record,epoch))throw cancelled();};
      await record.complete(reply,recovering,validateAttempt);
      if(!owns(record,epoch))return;options.validate();if(!owns(record,epoch))return;
      release(record);current=undefined;record.outerSettled=true;record.result.resolve();
    }catch(error){
      if(!owns(record,epoch))return;
      record.error=error;
      const retrying=!!record.prepared&&recoverable(record);
      record.outerSettled=!retrying;
      // A first explicit no-commit host rejection has no accepted continuation.
      // A receipt or uncertain result can never authorize a replacement command.
      const code=field(error,'code'),noCommit=error instanceof Error&&!('cause'in error)&&!retired(error)&&typeof code==='string'&&/^[_a-z]{1,64}$/.test(code)
        &&field(error,'source')==='host'&&field(error,'commitUncertain')===false;
      if(record.stage==='rpc'&&!record.received&&!record.indeterminate&&noCommit){release(record);current=undefined;}
      else if(record.stage==='rpc'&&!noCommit)record.indeterminate=true;
      if(!retrying)record.result.reject(error);throw error;
    }
  }
  function submit(command:DatabaseRequest,complete:Parameters<CollectionSubmit>[1]):Promise<void> {
    try{
      if(closed)throw cancelled();options.validate();if(closed)throw cancelled();
      const captured=freeze(captureDatabaseRequest({schemaVersion:1,command}).command as DatabaseRequest);
      if(!('operationId'in captured))throw new Error('Only an original collection mutation can own submission recovery.');
      const identity=JSON.stringify(captured);
      if(current){
        if(current.identity!==identity)throw pending();
        if(!current.outerSettled||current.prepared)return current.result.promise;
        current.result=deferred();current.outerSettled=false;current.error=undefined;
      }else{
        const record:Submission={command:captured,identity,complete,result:deferred(),cancelled:deferred(),epoch:0,dispatched:false,received:false,indeterminate:false,stage:'capture',outerSettled:false};
        current=record;
        try{options.capture?.(captured);if(!owns(record))throw cancelled();record.hold=options.hold(captured);if(!owns(record)){release(record);throw cancelled();}}catch(error){if(current===record)current=undefined;record.result.reject(error);throw error;}
      }
      const record=current;void execute(record,false).catch(()=>{});return record.result.promise;
    }catch(error){return Promise.reject(error);}
  }
  function prepareAdmissionRecovery():{settle():Promise<void>}|undefined {
    const record=current;if(!record)return;
    if(record.prepared)return record.prepared;
    if(!canRecover())throw new Error('This collection task cannot authorize automatic admission recovery.');
    const claim=options.claim(record.command);if(!owns(record)){claim();return;}record.claim=claim;record.epoch++;
    record.prepared={settle(){
      if(!owns(record))return Promise.resolve();
      if(record.settling)return record.settling;
      // A lost old renderer reply/derived refresh is observed but never awaited.
      // The selected exact capsule supplies a fresh receipt after positive ACK.
      const settling=Promise.race([execute(record,true),record.cancelled.promise]);record.settling=settling;
      void settling.catch(()=>{if(owns(record)&&record.settling===settling&&recoverable(record))record.settling=undefined;});
      return record.settling;
    }};
    return record.prepared;
  }
  return{submit,get pending(){return!!current;},get submitted(){return!!current?.dispatched;},get currentCommand(){return current?.command;},get currentReceipt(){return current?.receipt;},waitForCompletion:()=>current?.result.promise??Promise.resolve(),canRecover,prepareAdmissionRecovery,
    close(){if(closed)return;closed=true;const record=current;current=undefined;if(!record)return;record.epoch++;let error:unknown=cancelled();try{release(record);}catch(failure){error=failure;}finally{record.cancelled.resolve();record.result.reject(error);}}};
}
