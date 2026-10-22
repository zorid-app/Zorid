import {captureSavedSourceWitness,captureSavedSourceId,captureSavedSourceValue} from '../../desktop/conditional-saved-source.cjs';
import type {DurableWrites,ConditionalSavedSourceWitness} from '../core/durable-writes.ts';
import {captureWorkBlockCommand,validateWorkBlockValue} from '../../desktop/workblocks.cjs';
import type {DesktopWorkBlockRequest,WorkBlockService} from '../core/workblocks.ts';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {BinaryCommandSchema,BinaryResultSchema,ErrorCode} from '../generated/zorid/stream/v1/binary_pb.ts';
import type {BinaryCommand,BinaryResult,StageLocator,StageStatus,StageCommitted} from '../generated/zorid/stream/v1/binary_pb.ts';
import type {CommitReceipt,EntryState,Manifest} from '../generated/zorid/common/v1/common_pb.ts';
import type {CheckpointScope,Checkpoint,DurableCheckpoints} from '../core/durable-checkpoints.ts';
import type {BinaryStreams,BinaryStageRef,BinaryStageRequest,BinaryChunkInput,BinarySealInput,BinarySealedStatus,BinaryStageStatus,BinaryReadRef,BinaryStreamLimits,BinaryTarget} from '../core/binary-streams.ts';
import {BINARY_CHUNK_BYTES,BINARY_FORMAT_FILE_BYTES} from '../core/binary-streams.ts';

const FRAME_LIMIT=BINARY_CHUNK_BYTES+16384,prefix='binary-command/v1/';
const id=(value:string)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure=(code:string,uncertain=false)=>Object.assign(new Error('Binary transfer could not finish; its durable stage is retained.'),{code,source:'host' as const,commitUncertain:uncertain});
function decimal(value:string):bigint{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)throw failure('invalid_request');return BigInt(value);}
function hex(bytes:Uint8Array):string{if(bytes.length!==32)throw failure('invalid_response',true);return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');}
function digest(value:string):Uint8Array{if(!/^[0-9a-f]{64}$/.test(value))throw failure('invalid_request');return Uint8Array.from(value.match(/../g)!,value=>parseInt(value,16));}
const errorCodes:Record<number,string>={
  [ErrorCode.INVALID_REQUEST]:'invalid_request',[ErrorCode.UNSUPPORTED_VERSION]:'unsupported_version',
  [ErrorCode.UNSUPPORTED_REQUIRED_FEATURE]:'unsupported_required_feature',[ErrorCode.NOT_FOUND]:'not_found',
  [ErrorCode.REVISION_CONFLICT]:'revision_conflict',[ErrorCode.IDEMPOTENCY_CONFLICT]:'idempotency_conflict',
  [ErrorCode.OWNER_MISMATCH]:'owner_mismatch',[ErrorCode.TOO_LARGE]:'too_large',[ErrorCode.INVALID_STAGE_STATE]:'invalid_stage_state',
  [ErrorCode.CONTENT_MISMATCH]:'content_mismatch',[ErrorCode.BUSY]:'busy',[ErrorCode.IO]:'io',
  [ErrorCode.CORRUPT]:'corrupt',[ErrorCode.OUTCOME_UNKNOWN]:'outcome_unknown',
};
function entry(value:EntryState|undefined){if(!value||!id(value.id)||!id(value.revision)||!value.path||![1,2].includes(value.kind))throw failure('invalid_response',true);return{id:value.id,path:value.path,kind:value.kind===1?'file':'folder',revision:value.revision,deleted:value.deleted};}
function receipt(value:CommitReceipt|undefined):string{if(!value||!id(value.operationId)||value.sequence<1n||!value.changes.length)throw failure('invalid_response',true);return JSON.stringify({operation_id:value.operationId,sequence:String(value.sequence),changes:value.changes.map(change=>({before:change.before?entry(change.before):null,after:entry(change.after)}))});}
function committed(value:StageCommitted,operationId:string,target:BinaryTarget):string{
  if(value.receipt?.operationId!==operationId||!value.projection?.status.case)throw failure('invalid_response',true);
  const change=value.receipt.changes.find(change=>change.after?.id===target.entryId);
  if(!change?.after||change.after.kind!==1||change.after.deleted||target.kind==='create'&&(change.before!==undefined||change.after.path!==target.path)||target.kind==='write'&&(!change.before||change.before.id!==target.entryId||change.before.revision!==target.expectedRevision))throw failure('invalid_response',true);
  return receipt(value.receipt);
}
function sealed(value:Manifest|undefined):BinarySealedStatus{if(!value||value.bytes>BigInt(BINARY_FORMAT_FILE_BYTES)||value.pages.length>128)throw failure('invalid_response',true);return{length:String(value.bytes),sha256:hex(value.digest)};}
interface ReadState {version:1;requestedReadId:string;input:{entryId:string;expectedRevision?:string;expectedContentEvent?:string};phase:'opening'|'opened'|'closing'|'closed';ref?:BinaryReadRef}
interface State {version:1;request:BinaryStageRequest;ref?:BinaryStageRef;phase:'receiving'|'seal_requested'|'sealed'|'commit_requested'|'committed'|'rejected'|'aborted';seal?:BinarySealInput;finalized?:BinarySealedStatus;receipt?:string;code?:string}
export interface DesktopBinaryOptions {
  scope:CheckpointScope;
  checkpoints:DurableCheckpoints;
  limits:BinaryStreamLimits;
  /** Same admitted durableInvoke boundary, carrying generated protobuf bytes. */
  invoke(bytes:Uint8Array):Promise<Uint8Array>;
  assertActive():void;
}

/** Renderer consumer owns checkpoint phases, while native owns bytes, pins and
 * every content proof. No whole-file payload enters its recovery records. */
export function createDesktopBinaryStreams(options:DesktopBinaryOptions):{streams:BinaryStreams;recover():Promise<boolean>;release():Promise<void>} {
  const owner={localStoreId:options.scope.vaultId,clientId:options.scope.clientId};
  if(!id(owner.localStoreId)||!id(owner.clientId)||options.checkpoints.scope.vaultId!==owner.localStoreId||options.checkpoints.scope.clientId!==owner.clientId)throw failure('owner_mismatch');
  const limits=Object.freeze({...options.limits});
  if(decimal(limits.maxFileBytes)>BigInt(BINARY_FORMAT_FILE_BYTES)||limits.maxChunkBytes!==BINARY_CHUNK_BYTES||decimal(limits.smallReadBytes)>decimal(limits.maxFileBytes))throw failure('invalid_stream_limits');
  let busy=false;const activeReads=new Set<string>(),readCheckpoints=new Map<string,string>();
  function run<T>(action:()=>Promise<T>):Promise<T>{
    let accepted=false;
    try{options.assertActive();if(busy)throw failure('binary_busy');busy=true;accepted=true;return action().finally(()=>{busy=false;});}
    catch(error){if(accepted)busy=false;return Promise.reject(error);}
  }
  function bound(ref:BinaryStageRef):BinaryStageRef{if(ref?.localStoreId!==owner.localStoreId||ref.clientId!==owner.clientId||!id(ref.operationId)||!id(ref.stageId))throw failure('owner_mismatch');return{localStoreId:ref.localStoreId,clientId:ref.clientId,operationId:ref.operationId,stageId:ref.stageId};}
  function fromStage(ref:StageLocator|undefined):BinaryStageRef{if(!ref)throw failure('invalid_response',true);return bound(ref);}
  function same(a:BinaryStageRef,b:BinaryStageRef){return a.localStoreId===b.localStoreId&&a.clientId===b.clientId&&a.operationId===b.operationId&&a.stageId===b.stageId;}
  async function rpc(command:BinaryCommand['command']):Promise<BinaryResult['result']>{
    options.assertActive();const bytes=toBinary(BinaryCommandSchema,create(BinaryCommandSchema,{schemaVersion:1,command}));
    if(bytes.length>FRAME_LIMIT)throw failure('request_limit');
    const response=await options.invoke(bytes);
    if(!(response instanceof Uint8Array)||!response.length||response.length>FRAME_LIMIT)throw failure('invalid_response',true);
    let parsed:BinaryResult;try{parsed=fromBinary(BinaryResultSchema,response);}catch{throw failure('invalid_response',true);}
    if(parsed.schemaVersion!==1||parsed.requiredFeatures.length||!parsed.result.case)throw failure('invalid_response',true);
    if(parsed.result.case==='failure'){const code=errorCodes[parsed.result.value.code];if(!code)throw failure('invalid_response',true);throw failure(code,code==='outcome_unknown');}
    return parsed.result;
  }
  function request(input:BinaryStageRequest):BinaryStageRequest{
    const target=input.target;
    const captured:BinaryStageRequest={operationId:input.operationId,target:target?.kind==='create'?{kind:'create',entryId:target.entryId,path:target.path}:{kind:'write',entryId:target?.entryId,expectedRevision:target?.expectedRevision,expectedContentEvent:target?.expectedContentEvent},...(input.expectedLength===undefined?{}:{expectedLength:input.expectedLength})};if(!id(captured.operationId)||!id(captured.target?.entryId))throw failure('invalid_request');
    if(captured.expectedLength!==undefined&&decimal(captured.expectedLength)>decimal(limits.maxFileBytes))throw failure('too_large');
    if(captured.target.kind==='create'){if(!captured.target.path||new TextEncoder().encode(captured.target.path).length>4096||captured.target.path.startsWith('/')||captured.target.path.split('/').some(part=>!part||part==='.'||part==='..'))throw failure('invalid_request');}
    else if(captured.target.kind!=='write'||!id(captured.target.expectedRevision)||!id(captured.target.expectedContentEvent))throw failure('invalid_request');
    return captured;
  }
  async function load(operationId:string):Promise<{head:Checkpoint|null;state:State|null}>{
    const head=await options.checkpoints.load(prefix+operationId);if(!head?.encodedState)return{head,state:null};
    if(head.encodedState.length>65536)throw failure('invalid_binary_checkpoint');
    let state:State;try{state=JSON.parse(head.encodedState);}catch{throw failure('invalid_binary_checkpoint');}
    if(state.version!==1||state.request?.operationId!==operationId||!['receiving','seal_requested','sealed','commit_requested','committed','rejected','aborted'].includes(state.phase))throw failure('invalid_binary_checkpoint');
    request(state.request);if(state.ref)bound(state.ref);return{head,state};
  }
  async function persist(head:Checkpoint|null,state:State):Promise<Checkpoint>{
    options.assertActive();const encodedState=JSON.stringify(state);if(encodedState.length>65536)throw failure('invalid_binary_checkpoint');
    return options.checkpoints.compareAndSwap({key:prefix+state.request.operationId,expectedRevision:head?.revision??null,nextRevision:crypto.randomUUID(),encodedState});
  }
  async function owned(ref:BinaryStageRef){const captured=bound(ref),row=await load(captured.operationId);if(!row.state?.ref||!same(row.state.ref,captured))throw failure('stage_checkpoint_missing');return{...row,state:row.state,ref:captured};}
  function status(value:StageStatus,expected:BinaryStageRef,target:BinaryTarget):BinaryStageStatus{
    const ref=fromStage(value.stage);if(!same(ref,expected)||value.acceptedLength>decimal(limits.maxFileBytes)||!value.state.case)throw failure('invalid_response',true);
    const state=value.state;const result:BinaryStageStatus={ref,phase:state.case==='commitRequested'?'commit_requested':state.case,acceptedLength:String(value.acceptedLength),nextSequence:value.nextSequence};
    if(value.finalized)result.finalized=sealed(value.finalized.manifest);
    if(state.case==='committed')result.outcome={status:'committed',receipt:committed(state.value,ref.operationId,target)};
    if(state.case==='rejected'){const code=errorCodes[state.value.code];if(!code)throw failure('invalid_response',true);result.outcome={status:'rejected',error:{code,message:'The original binary operation was rejected.',source:'host'}};}
    return result;
  }
  async function settle(head:Checkpoint|null,state:State,result:BinaryStageStatus){
    if(result.outcome?.status==='committed'){state={...state,phase:'committed',receipt:result.outcome.receipt};await persist(head,state);}
    else if(result.outcome?.status==='rejected'){state={...state,phase:'rejected',code:result.outcome.error.code};await persist(head,state);}
    else if(result.phase==='sealed'&&state.phase==='seal_requested'&&state.seal&&result.finalized){
      if(result.finalized.length!==state.seal.finalLength||state.seal.expectedDigest!==undefined&&result.finalized.sha256!==state.seal.expectedDigest)throw failure('content_mismatch');
      await persist(head,{...state,phase:'sealed',finalized:result.finalized});
    }
  }
  async function commit(ref:BinaryStageRef):Promise<string>{
    let {head,state}=await owned(ref);
    if(state.phase==='committed'&&state.receipt)return state.receipt;
    if(state.phase==='rejected')throw failure(state.code??'invalid_stage_state');
    if(state.phase!=='sealed'&&state.phase!=='commit_requested')throw failure('invalid_stage_state');
    const terminal=async():Promise<string|undefined>=>{
      const answer=await rpc({case:'query',value:{$typeName:'zorid.stream.v1.QueryStage',stage:{$typeName:'zorid.stream.v1.StageLocator',...ref}}});
      if(answer.case!=='status')throw failure('invalid_response',true);
      const current=status(answer.value,ref,state.request.target);
      if(current.outcome?.status==='committed'){await persist(head,{...state,phase:'committed',receipt:current.outcome.receipt});return current.outcome.receipt;}
      if(current.outcome?.status==='rejected'){await persist(head,{...state,phase:'rejected',code:current.outcome.error.code});throw failure(current.outcome.error.code);}
      return undefined;
    };
    if(state.phase==='commit_requested'){const settled=await terminal();if(settled!==undefined)return settled;}
    else{state={...state,phase:'commit_requested'};head=await persist(head,state);}
    let result:BinaryResult['result'];
    try{result=await rpc({case:'commit',value:{stage:{$typeName:'zorid.stream.v1.StageLocator',...ref},$typeName:'zorid.stream.v1.CommitStage'}});}
    catch(error){
      // A transport error is never a rejection. Ask the owning stage for its
      // original outcome; failed queries retain commit_requested for retry.
      try{const settled=await terminal();if(settled!==undefined)return settled;}catch(queryError){
        const retained=await load(ref.operationId);if(retained.state?.phase==='rejected')throw queryError;
      }
      throw error;
    }
    if(result.case!=='committed')throw failure('invalid_response',true);
    const saved=committed(result.value,ref.operationId,state.request.target);await persist(head,{...state,phase:'committed',receipt:saved});return saved;
  }
  const streams:BinaryStreams={limits,
    begin:input=>run(async()=>{
      const captured=request(input);let {head,state}=await load(captured.operationId);
      if(state&&JSON.stringify(state.request)!==JSON.stringify(captured))throw failure('idempotency_conflict');
      if(state?.ref)return bound(state.ref);
      if(!state){state={version:1,request:captured,phase:'receiving'};head=await persist(head,state);}
      const target=captured.target.kind==='create'?{target:{case:'create' as const,value:{id:captured.target.entryId,path:captured.target.path,$typeName:'zorid.stream.v1.BinaryCreate' as const}},$typeName:'zorid.stream.v1.BinaryTarget' as const}:{target:{case:'write' as const,value:{id:captured.target.entryId,expectedRevision:captured.target.expectedRevision,expectedContentEvent:captured.target.expectedContentEvent,$typeName:'zorid.stream.v1.BinaryWrite' as const}},$typeName:'zorid.stream.v1.BinaryTarget' as const};
      const result=await rpc({case:'begin',value:{$typeName:'zorid.stream.v1.BeginStage',owner:{$typeName:'zorid.stream.v1.StageOwner',...owner},operationId:captured.operationId,target,expectedLength:captured.expectedLength===undefined?undefined:decimal(captured.expectedLength)}});
      if(result.case!=='begun')throw failure('invalid_response',true);const ref=fromStage(result.value.stage);if(ref.operationId!==captured.operationId)throw failure('invalid_response',true);
      await persist(head,{...state,ref});return ref;
    }),
    append:(ref,input)=>run(async()=>{
      if(!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>BINARY_CHUNK_BYTES||!Number.isInteger(input.sequence)||input.sequence<0||input.sequence>0xffffffff)throw failure('request_limit');
      const captured={sequence:input.sequence,offset:input.offset,bytes:new Uint8Array(input.bytes)};
      const row=await owned(ref);if(row.state.phase!=='receiving')throw failure('invalid_stage_state');
      const result=await rpc({case:'append',value:{$typeName:'zorid.stream.v1.AppendChunk',stage:{$typeName:'zorid.stream.v1.StageLocator',...row.ref},sequence:captured.sequence,offset:decimal(captured.offset),data:captured.bytes}});
      if(result.case!=='appended'||result.value.sequence!==captured.sequence||result.value.offset!==decimal(captured.offset)||result.value.bytes!==captured.bytes.length||result.value.acceptedLength!==decimal(captured.offset)+BigInt(captured.bytes.length))throw failure('invalid_response',true);
      return{sequence:result.value.sequence,offset:String(result.value.offset),bytes:result.value.bytes,digest:hex(result.value.digest),acceptedLength:String(result.value.acceptedLength)};
    }),
    query:ref=>run(async()=>{const row=await owned(ref);const result=await rpc({case:'query',value:{$typeName:'zorid.stream.v1.QueryStage',stage:{$typeName:'zorid.stream.v1.StageLocator',...row.ref}}});if(result.case!=='status')throw failure('invalid_response',true);const parsed=status(result.value,row.ref,row.state.request.target);await settle(row.head,row.state,parsed);return parsed;}),
    seal:(ref,input)=>run(async()=>{
      const captured:BinarySealInput={finalLength:input.finalLength,...(input.expectedDigest===undefined?{}:{expectedDigest:input.expectedDigest})};decimal(captured.finalLength);if(captured.expectedDigest!==undefined)digest(captured.expectedDigest);
      let {head,state,ref:stage}=await owned(ref);if(state.seal&&JSON.stringify(state.seal)!==JSON.stringify(captured))throw failure('idempotency_conflict');
      if(state.finalized&&['sealed','commit_requested','committed'].includes(state.phase))return state.finalized;
      if(!['receiving','seal_requested'].includes(state.phase))throw failure('invalid_stage_state');
      if(state.phase==='receiving'){state={...state,phase:'seal_requested',seal:captured};head=await persist(head,state);}
      const result=await rpc({case:'seal',value:{$typeName:'zorid.stream.v1.SealStage',stage:{$typeName:'zorid.stream.v1.StageLocator',...stage},finalLength:decimal(captured.finalLength),expectedDigest:captured.expectedDigest===undefined?undefined:digest(captured.expectedDigest)}});
      if(result.case!=='sealed'||!same(fromStage(result.value.stage),stage))throw failure('invalid_response',true);const finalized=sealed(result.value.diagnostic?.manifest);
      if(finalized.length!==captured.finalLength||captured.expectedDigest!==undefined&&finalized.sha256!==captured.expectedDigest)throw failure('invalid_response',true);
      await persist(head,{...state,phase:'sealed',finalized});return finalized;
    }),
    commit:ref=>run(()=>commit(bound(ref))),
    abort:ref=>run(async()=>{const row=await owned(ref);if(['commit_requested','committed'].includes(row.state.phase))throw failure('invalid_stage_state');const result=await rpc({case:'abort',value:{$typeName:'zorid.stream.v1.AbortStage',stage:{$typeName:'zorid.stream.v1.StageLocator',...row.ref}}});if(result.case!=='aborted'||!same(fromStage(result.value.stage),row.ref))throw failure('invalid_response',true);await persist(row.head,{...row.state,phase:'aborted'});}),
    openRead:input=>run(async()=>{
      const captured={entryId:input.entryId,...(input.expectedRevision===undefined?{}:{expectedRevision:input.expectedRevision}),...(input.expectedContentEvent===undefined?{}:{expectedContentEvent:input.expectedContentEvent})};
      if(!id(captured.entryId)||captured.expectedRevision!==undefined&&!id(captured.expectedRevision)||captured.expectedContentEvent!==undefined&&!id(captured.expectedContentEvent))throw failure('invalid_request');
      await recoverReads(false);
      const state:ReadState={version:1,requestedReadId:crypto.randomUUID(),input:captured,phase:'opening'};
      const head=await persistRead(null,state);
      const opened=await openRead(head,state);
      if(captured.expectedRevision!==undefined&&opened.ref!.entryRevision!==captured.expectedRevision||captured.expectedContentEvent!==undefined&&opened.ref!.selectedContentEvent!==captured.expectedContentEvent){await close(opened.ref!);throw failure('revision_conflict');}
      activeReads.add(opened.ref!.readId);return opened.ref!;
    }),
    read:(ref,input)=>run(async()=>{
      const captured={...ref},read=readRef(captured),offset=decimal(input.offset),max=input.maxBytes;if(!Number.isInteger(max)||max<1||max>BINARY_CHUNK_BYTES||offset>decimal(captured.length))throw failure('request_limit');
      const result=await rpc({case:'readChunk',value:{$typeName:'zorid.stream.v1.ReadChunk',read,offset,maxBytes:max}});
      if(result.case!=='readChunk'||result.value.offset!==offset||result.value.data.length>max||!result.value.data.length&&!result.value.eof)throw failure('invalid_response',true);
      const next=offset+BigInt(result.value.data.length);if(next>decimal(captured.length)||result.value.eof!==(next===decimal(captured.length)))throw failure('invalid_response',true);
      return{bytes:new Uint8Array(result.value.data),nextOffset:String(next),eof:result.value.eof};
    }),
    closeRead:ref=>run(()=>close({...ref})),
  };
  function readRef(ref:BinaryReadRef){if(ref.localStoreId!==owner.localStoreId||ref.clientId!==owner.clientId||!id(ref.readId))throw failure('owner_mismatch');return{$typeName:'zorid.stream.v1.ReadLocator' as const,owner:{$typeName:'zorid.stream.v1.StageOwner' as const,...owner},readId:ref.readId};}
  async function persistRead(head:Checkpoint|null,state:ReadState):Promise<Checkpoint>{
    options.assertActive();
    return options.checkpoints.compareAndSwap({key:'binary-read/v1/'+state.requestedReadId,expectedRevision:head?.revision??null,nextRevision:crypto.randomUUID(),encodedState:JSON.stringify(state)});
  }
  function decodeRead(head:Checkpoint):ReadState{
    if(!head.encodedState||head.encodedState.length>16384)throw failure('invalid_binary_checkpoint');
    let state:ReadState;try{state=JSON.parse(head.encodedState);}catch{throw failure('invalid_binary_checkpoint');}
    if(state.version!==1||!id(state.requestedReadId)||head.key!=='binary-read/v1/'+state.requestedReadId||!id(state.input?.entryId)||!['opening','opened','closing','closed'].includes(state.phase))throw failure('invalid_binary_checkpoint');
    if(state.ref)readRef(state.ref);return state;
  }
  async function openRead(head:Checkpoint,state:ReadState):Promise<ReadState>{
    const captured=state.input;
    const result=await rpc({case:'openRead',value:{$typeName:'zorid.stream.v1.OpenRead',owner:{$typeName:'zorid.stream.v1.StageOwner',...owner},id:captured.entryId,expectedRevision:captured.expectedRevision,readId:state.requestedReadId}});
    if(result.case!=='readOpened'||!result.value.read?.owner||result.value.read.owner.localStoreId!==owner.localStoreId||result.value.read.owner.clientId!==owner.clientId||!id(result.value.read.readId)||result.value.content?.entry?.entryId!==captured.entryId||!id(result.value.entryRevision)||!id(result.value.content.selectedEvent))throw failure('invalid_response',true);
    const finalized=sealed(result.value.content.manifest),ref={...owner,readId:result.value.read.readId,entryId:captured.entryId,entryRevision:result.value.entryRevision,selectedContentEvent:result.value.content.selectedEvent,length:finalized.length};
    const opened:ReadState={...state,phase:'opened',ref};await persistRead(head,opened);readCheckpoints.set(ref.readId,head.key);return opened;
  }
  async function close(ref:BinaryReadRef){
    const locator=readRef(ref),key=readCheckpoints.get(ref.readId);let head=key?await options.checkpoints.load(key):null;
    let state=head?decodeRead(head):null;
    if(state?.phase==='closed'){activeReads.delete(ref.readId);readCheckpoints.delete(ref.readId);return;}
    if(state&&head&&state.phase!=='closing'){state={...state,phase:'closing'};head=await persistRead(head,state);}
    const result=await rpc({case:'closeRead',value:{$typeName:'zorid.stream.v1.CloseRead',read:locator}});if(result.case!=='readClosed')throw failure('invalid_response',true);
    activeReads.delete(ref.readId);
    if(state&&head)await persistRead(head,{...state,phase:'closed'});
    readCheckpoints.delete(ref.readId);
  }
  async function recoverReads(all:boolean):Promise<void>{
    let cursor:string|undefined;
    do{const page=await options.checkpoints.list({limit:100,cursor});
      for(const item of page.items){if(item.deleted||!item.key.startsWith('binary-read/v1/'))continue;let head=await options.checkpoints.load(item.key);if(!head?.encodedState)continue;let state=decodeRead(head);
        if(state.phase==='closed'||!all&&state.phase==='opened'&&state.ref&&activeReads.has(state.ref.readId))continue;
        if(state.phase==='opening'){
          try{state=await openRead(head,state);}
          catch(error){if(error&&typeof error==='object'&&'code'in error&&['not_found','revision_conflict','invalid_request','too_large','content_mismatch'].includes(String(error.code))){await persistRead(head,{...state,phase:'closed'});continue;}throw error;}
          head=await options.checkpoints.load(item.key);if(!head)throw failure('invalid_binary_checkpoint');
        }
        if(!state.ref)throw failure('invalid_binary_checkpoint');readCheckpoints.set(state.ref.readId,item.key);await close(state.ref);
      }cursor=page.cursor??undefined;
    }while(cursor);
  }
  async function recoverStages():Promise<boolean>{
    let cursor:string|undefined,changed=false;
    do{const page=await options.checkpoints.list({limit:100,cursor});
      for(const item of page.items){if(item.deleted||!item.key.startsWith(prefix))continue;const {state}=await load(item.key.slice(prefix.length));if(state?.phase==='commit_requested'){if(!state.ref)throw failure('invalid_binary_checkpoint');try{await commit(state.ref);changed=true;}catch(error){const latest=await load(state.ref.operationId);if(latest.state?.phase!=='rejected')throw error;}}}
      cursor=page.cursor??undefined;
    }while(cursor);return changed;
  }
  return{streams,recover:()=>run(async()=>{await recoverReads(false);return recoverStages();}),release:()=>run(async()=>{await recoverReads(true);await recoverStages();})};
}

/** The caller supplies the existing admitted durableInvoke closure. This owns
 * no file/store authority and never invents an operation ID or retries a write. */
export function createDesktopWorkBlocks(invoke:(request:DesktopWorkBlockRequest)=>Promise<unknown>):{service:WorkBlockService;release():Promise<void>} {
  const reject=(code:string)=>Object.assign(new Error('WorkBlock request rejected.'),{code,source:'host',commitUncertain:false});
  let released=false;
  const pending=new Set<Promise<unknown>>();
  const mutations=new Map<string,{encoded:string;call:Promise<unknown>|null}>();
  function command<T>(op:string,input:object):Promise<T>{
    if(released)return Promise.reject(reject('client_not_admitted'));
    let request:DesktopWorkBlockRequest;
    try{request=captureWorkBlockCommand(op,input);}catch(error){return Promise.reject(error);}
    const operation=request.command.operation as string|undefined,encoded=JSON.stringify(request);
    const previous=operation?mutations.get(operation):undefined;
    if(previous&&previous.encoded!==encoded)return Promise.reject(reject('operation_collision'));
    if(previous?.call)return previous.call as Promise<T>;
    if(operation&&!previous&&mutations.size>=32)return Promise.reject(reject('request_limit'));
    const state={encoded,call:null as Promise<unknown>|null};
    if(operation)mutations.set(operation,state);
    // Capture before any await, then admit exactly one invocation. A lost reply
    // retains the fingerprint; only an explicit identical retry can dispatch.
    const call=Promise.resolve().then(()=>invoke(request)).then(value=>validateWorkBlockValue(request,value)).then(value=>{
      if(operation)mutations.delete(operation);return value as T;
    },error=>{
      state.call=null;
      // Only explicit, definite native rejections retire an uncertain input.
      const code=(error as {code?:unknown})?.code,uncertain=(error as {commitUncertain?:unknown})?.commitUncertain;
      if(operation&&uncertain===false&&['invalid_request','invalid_workblock','stale_revision','operation_collision','client_not_admitted','stale_session','limit'].includes(String(code)))mutations.delete(operation);
      throw error;
    });
    state.call=call;pending.add(call);void call.then(()=>pending.delete(call),()=>pending.delete(call));return call;
  }
  return {service:Object.freeze<WorkBlockService>({
    create:input=>command('create',input),read:input=>command('read',input),windowPage:input=>command('window',input),
    move:input=>command('move',input),title:input=>command('title',input),addRef:input=>command('add_ref',input),
    removeRef:input=>command('remove_ref',input),delete:input=>command('delete',input),changes:input=>command('changes',input),
  }),async release(){released=true;await Promise.allSettled([...pending]);}};
}

/** Native callers always receive a pair. Unsupported hosts reject before any
 * transform/RPC, preserving the browser-only meaning of both methods absent.
 * Successful proofs stay on the same admitted vault/lease-bound closure. */
export function createDesktopConditionalSavedSources(
  invoke:(method:'captureSavedSource'|'releaseSavedSource',input:unknown)=>Promise<unknown>,
  available:boolean,
):Required<Pick<DurableWrites,'captureSavedSource'|'releaseSavedSource'>> {
  return Object.freeze({
    async captureSavedSource(input:ConditionalSavedSourceWitness) {
      if(!available)throw Object.assign(new Error('This desktop core does not support guarded saved-source edits.'),{code:'unsupported_host_capability',source:'host',commitUncertain:false});
      const witness=captureSavedSourceWitness(input);
      const value=await invoke('captureSavedSource',witness);
      return captureSavedSourceValue(value,witness);
    },
    async releaseSavedSource(input:string) {
      if(!available)throw Object.assign(new Error('This desktop core does not support guarded saved-source edits.'),{code:'unsupported_host_capability',source:'host',commitUncertain:false});
      const captureId=captureSavedSourceId(input);
      const value=await invoke('releaseSavedSource',captureId);
      if(value!==undefined)throw failure('invalid_saved_source',true);
    },
  });
}
