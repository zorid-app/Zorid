'use strict';
const {randomUUID}=require('node:crypto');

const maximum=(1n<<64n)-1n;
const failure=code=>Object.assign(new Error('Independent draft admission is unavailable.'),{code,commitUncertain:false});
const replyFailure=error=>({code:typeof error?.code==='string'&&/^(?:draft_|invalid_draft_)[a-z0-9_]+$/.test(error.code)?error.code:'draft_storage_failure',commitUncertain:error?.commitUncertain===true});
function object(value,allowed,required=allowed){
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw failure('invalid_draft_request');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!allowed.includes(key)||!Object.hasOwn(descriptors[key],'value'))||required.some(key=>!Object.hasOwn(descriptors,key)))throw failure('invalid_draft_request');
  return value;
}
function id(value){
  if(typeof value!=='string'||!value||value.length>256||/[\0/\\]/.test(value)||value==='.'||value==='..')throw failure('invalid_draft_identity');
  return value;
}
function revision(value,nullable=false){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!/^([1-9][0-9]{0,19})$/.test(value)||BigInt(value)>maximum)throw failure('invalid_draft_revision');
  return value;
}
function generation(value){
  if(!Number.isSafeInteger(value)||value<0||Object.is(value,-0))throw failure('invalid_draft_generation');
  return value;
}
function text(value){if(typeof value!=='string'||value.length*2>64*1024*1024)throw failure('draft_size_limit');return value;}
function identity(value,scope){
  if(Object.hasOwn(value,'vaultId')&&value.vaultId!==scope.vaultId||Object.hasOwn(value,'clientId')&&value.clientId!==scope.clientId)throw failure('invalid_draft_identity');
  return{incarnationId:Object.hasOwn(value,'incarnationId')?id(value.incarnationId):scope.incarnationId,entryId:id(value.entryId),writer:id(value.writer)};
}
const receiptKeys=['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'];
function capture(request,scope){
  object(request,['op','args']);
  const {op,args}=request;
  if(!['list','read','compareAndSwap','retire'].includes(op)||!Array.isArray(args)||Object.getPrototypeOf(args)!==Array.prototype||(op==='list'?args.length>1:args.length!==1)||args.length===1&&!Object.hasOwn(args,'0')
    ||Reflect.ownKeys(args).some(key=>key!=='length'&&(key!=='0'||!Object.hasOwn(Object.getOwnPropertyDescriptor(args,key),'value'))))throw failure('invalid_draft_request');
  if(op==='list')return{op,args:args.length?[{entryId:id(object(args[0],['entryId']).entryId)}]:[]};
  const value=args[0];
  if(op==='read'){
    object(value,receiptKeys,['entryId','writer']);
    if(Object.hasOwn(value,'revision'))revision(value.revision);
    if(Object.hasOwn(value,'generation'))generation(value.generation);
    if(Object.hasOwn(value,'deleted')&&typeof value.deleted!=='boolean')throw failure('invalid_draft_request');
    return{op,args:[identity(value,scope)]};
  }
  if(op==='retire'){
    object(value,receiptKeys);const own=identity(value,scope),counter=revision(value.revision);
    if(value.deleted!==false)throw failure('invalid_draft_request');
    if(BigInt(counter)===maximum)throw failure('invalid_draft_revision');
    return{op,args:[{...own,expectedRevision:counter,nextRevision:String(BigInt(counter)+1n),generation:generation(value.generation)}]};
  }
  const required=['entryId','writer','generation','expectedRevision','nextRevision','baseline','draft','checkpointRevision','pendingOperation'];
  object(value,[...required,'vaultId','clientId','incarnationId'],required);
  const own=identity(value,scope);
  if(own.incarnationId!==scope.incarnationId)throw failure('invalid_draft_identity');
  const expected=revision(value.expectedRevision,true),next=revision(value.nextRevision);
  if(BigInt(next)!==(expected===null?1n:BigInt(expected)+1n))throw failure('invalid_draft_revision');
  const base=object(value.baseline,['entryId','path','revision','content']);
  if(base.entryId!==own.entryId||typeof base.path!=='string'||!base.path||base.path.length>32768||/[\0\\]/.test(base.path)||base.path.startsWith('/')||/^[a-z]:/i.test(base.path)||base.path.split('/').some(part=>!part||part==='.'||part==='..')||typeof base.revision!=='string'||!base.revision||base.revision.length>32768)throw failure('invalid_draft_baseline');
  return{op,args:[{...own,generation:generation(value.generation),expectedRevision:expected,nextRevision:next,
    baseline:{entryId:own.entryId,path:base.path,revision:base.revision,content:text(base.content)},draft:text(value.draft),
    checkpointRevision:value.checkpointRevision===null?null:id(value.checkpointRevision),pendingOperation:value.pendingOperation===null?null:text(value.pendingOperation)}]};
}

/** Main-only authority adapter; never accept a renderer-supplied core context.
 * The caller must revalidate the record/frame/generation/vault captured BEFORE
 * awaiting core admission, then attach only its positive same-owner result.
 * Main MUST revoke on every document navigation/reload (even same URL/frame
 * object), window close, and vault replacement. Core host retirement alone does
 * not revoke this independent lease. Repeated trusted context discovery for the
 * same document/scope reuses its token and incarnation.
 *
 * Storage owns serialization and rechecks the bound synchronous lifetime guard
 * immediately before publication. A filesystem rename already authorized and
 * in flight may finish after revocation; its late response is still denied.
 */
function createDraftJournalAdmissionManager({journal,broker}={}){
  if(typeof journal?.bind!=='function'||typeof broker?.authenticate!=='function')throw replyFailure(failure('invalid_draft_admission'));
  const states=new Map();
  function revoke(record){const state=states.get(record);if(!state)return;states.delete(record);state.lease?.revoke();}
  function attach(record,trustedCoreContext){
    try{
      const webContents=record?.window?.webContents,frame=webContents?.mainFrame;
      if(broker.authenticate({sender:webContents,senderFrame:frame})!==record||!record.vault||record.vaultSelectionPending)throw failure('draft_admission_denied');
      const scope={vaultId:id(trustedCoreContext?.scope?.vaultId),clientId:id(trustedCoreContext?.scope?.clientId)};
      if(scope.clientId!==record.clientSlot?.clientId)throw failure('draft_admission_denied');
      const previous=states.get(record);
      if(previous){try{previous.check();if(previous.grant.scope.vaultId===scope.vaultId&&previous.grant.scope.clientId===scope.clientId)return previous.grant;}catch{/* Replace an obsolete document grant, never its stored drafts. */}revoke(record);}
      const entry=record.vault,root=entry.service.root,selectedGeneration=record.generation,slot=record.clientSlot,persistedRoot=record.persistedVaultRoot;
      const grant=Object.freeze({token:randomUUID(),scope:Object.freeze({...scope,incarnationId:randomUUID()})});
      const state={grant,lease:null,check:()=>{
        try{
          if(states.get(record)!==state||broker.authenticate({sender:webContents,senderFrame:frame})!==record||record.window.webContents!==webContents||webContents.mainFrame!==frame
            ||record.vault!==entry||record.generation!==selectedGeneration||record.vaultSelectionPending||entry.service.root!==root||record.clientSlot!==slot||slot.clientId!==scope.clientId||record.persistedVaultRoot!==persistedRoot)throw failure('draft_lease_revoked');
        }catch{throw failure('draft_lease_revoked');}
      }};
      states.set(record,state);
      try{state.lease=journal.bind(grant.scope,state.check);state.check();}catch(error){revoke(record);throw error;}
      return grant;
    }catch(error){throw replyFailure(error?.code?error:failure('draft_admission_denied'));}
  }
  function dispatch(record,event,expectedRoot,token,request){
    let state,captured;
    const authorize=()=>{
      try{if(broker.authenticate(event)!==record)throw failure('draft_admission_denied');}catch{throw failure('draft_admission_denied');}
      state=states.get(record);
      if(!state||typeof token!=='string'||state.grant.token!==token)throw failure('draft_lease_revoked');
      state.check();
      if(typeof expectedRoot!=='string'||expectedRoot!==record.vault.service.root)throw failure('draft_admission_denied');
    };
    try{
      authorize();captured=capture(request,state.grant.scope);
      const active=state;
      return Promise.resolve(active.lease[captured.op](...captured.args)).then(value=>{
        try{authorize();if(state!==active)throw failure('draft_lease_revoked');}catch(error){if(captured.op==='compareAndSwap'||captured.op==='retire')error.commitUncertain=true;throw error;}
        return value;
      }).catch(error=>{throw replyFailure(error);});
    }catch(error){return Promise.reject(replyFailure(error));}
  }
  return Object.freeze({attach,dispatch,revoke});
}
module.exports={createDraftJournalAdmissionManager};
