'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {normalizePath}=require('./vault-service.cjs');
const {checkpointBytes}=require('./durable-checkpoints.cjs');
const {familyCommand}=require('./family-sync-protocol.cjs');
const prefix='file-command/v1/',legacyPrefix='create-text/v1/';
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure=code=>Object.assign(new Error('File operation could not finish; its exact request is retained.'),{code});
const terminal=new Set(['invalid_request','not_found','invalid_path','invalid_identifier','invalid_mutation','invalid_text','invalid_family_command','entry_not_found','entry_deleted','revision_conflict','idempotency_conflict']);
const MAX_BYTES=16*1024*1024;
function binary(value){if(!(value instanceof Uint8Array)||value.byteLength>MAX_BYTES)throw failure('request_limit');return Buffer.from(value).toString('base64');}
function text(value){const bytes=checkpointBytes(value);if(value===null||bytes.length>MAX_BYTES)throw failure('request_limit');return bytes.toString('base64');}
/** One main-owned durable command consumer, including its original createText
 * entry point. Multi-step trash is recoverable, NOT an atomic namespace batch.
 */
function desktopTextCreates(service,checkpoints){
  let tail=Promise.resolve();
  function capture(input){
    if(!input||!identity(input.operationId)||!identity(input.entryId))throw failure('invalid_file_request');
    const request={kind:input.kind,operationId:input.operationId,entryId:input.entryId,path:normalizePath(input.path)};
    if(['createText','writeText'].includes(request.kind)){
      request.body_base64=text(input.content);
      if(input.expectedContent!==undefined)request.expected_base64=text(input.expectedContent);
      if(input.expectedEntryId!==undefined||input.expectedRevision!==undefined){if(!identity(input.expectedEntryId)||!identity(input.expectedRevision))throw failure('invalid_file_request');request.expectedEntryId=input.expectedEntryId;request.expectedRevision=input.expectedRevision;}
    }else if(request.kind==='createBinary'||request.kind==='writeBinary')request.body_base64=binary(input.data);
    else if(request.kind==='move')request.destination=normalizePath(input.destination);
    else if(request.kind==='delete'){if(typeof input.force!=='boolean')throw failure('invalid_file_request');request.force=input.force;}
    else if(!['mkdir','trash'].includes(request.kind))throw failure('invalid_file_request');
    return Object.freeze(request);
  }
  const signature=request=>createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const command=(operationId,mutation,mode=null,body='')=>({family:{version:1,request:{operation_id:operationId,mutation},create_mode:mode},body_base64:body});
  async function plan(request){
    const current=await service.host.readMetadata(request.path),commands=[];
    const create=(path,kind,id=request.entryId,op=request.operationId)=>command(op,{type:'create',id,path,kind},kind==='file'?(request.kind.endsWith('Binary')?'binary':'text'):null,kind==='file'?request.body_base64:'');
    if(request.kind==='mkdir'||request.kind==='createText'||request.kind==='createBinary'){
      if(current)throw failure('revision_conflict');
      return [create(request.path,request.kind==='mkdir'?'folder':'file')];
    }
    if(request.kind==='writeBinary'||request.kind==='writeText'){
      if(!current){if(request.expected_base64!==undefined||request.expectedEntryId!==undefined)throw failure('revision_conflict');return [create(request.path,'file')];}
      if(!current.has_content)throw failure('invalid_request');
      if(request.expectedEntryId!==undefined&&(current.entry.id!==request.expectedEntryId||current.entry.revision!==request.expectedRevision))throw failure('revision_conflict');
      if(request.expected_base64!==undefined){
        const observed=await service.host.readPath(request.path);
        if(!observed||observed.entry.id!==current.entry.id||observed.entry.revision!==current.entry.revision||Buffer.from(observed.bytes).toString('base64')!==request.expected_base64)throw failure('revision_conflict');
      }
      return [command(request.operationId,{type:'write',id:current.entry.id,expected:current.entry.revision},null,request.body_base64)];
    }
    if(!current)throw failure('not_found');
    let destination=request.destination;
    if(request.kind==='trash'){
      if(request.path==='.trash'||request.path.startsWith('.trash/'))throw failure('invalid_request');
      destination=`.trash/${request.operationId}/${request.path}`;
      const parts=destination.split('/');parts.pop();
      for(let i=1;i<=parts.length;i++){
        const path=parts.slice(0,i).join('/'),parent=await service.host.readMetadata(path);
        if(parent){if(parent.entry.kind!=='folder')throw failure('invalid_request');}
        else commands.push(create(path,'folder',randomUUID(),randomUUID()));
      }
    }
    if(request.kind==='move'||request.kind==='trash'){
      if(destination===request.path||destination.startsWith(request.path+'/')||await service.host.readMetadata(destination))throw failure('revision_conflict');
      commands.push(command(request.operationId,{type:'move',id:current.entry.id,expected:current.entry.revision,path:destination}));
    }else commands.push(command(request.operationId,{type:'delete',id:current.entry.id,expected:current.entry.revision,recursive:request.force}));
    return commands;
  }
  function decode(head){
    let state;try{state=JSON.parse(head.encodedState);}catch{throw failure('invalid_file_checkpoint');}
    if(head.key.startsWith(legacyPrefix)&&state.version===1){
      const request=capture({...state.request,kind:'createText'});
      if(state.version!==1||state.mode!=='text'||head.key!==legacyPrefix+request.operationId||!['requested','rejected'].includes(state.state))throw failure('invalid_file_checkpoint');
      state={version:2,operationId:request.operationId,signature:signature(request),state:state.state,code:state.code,next:0,receipts:[],commands:[command(request.operationId,{type:'create',id:request.entryId,path:request.path,kind:'file'},'text',request.body_base64)]};
    }
    if(state.version!==2||!identity(state.operationId)||!/^([a-f0-9]{64})$/.test(state.signature)||!['requested','rejected','committed'].includes(state.state)||!Array.isArray(state.receipts))throw failure('invalid_file_checkpoint');
    if(head.key!==prefix+state.operationId&&head.key!==legacyPrefix+state.operationId)throw failure('invalid_file_checkpoint');
    if(state.receipts.some(value=>!identity(value?.operationId)||typeof value.sequence!=='string'||!/^([1-9][0-9]*)$/.test(value.sequence)))throw failure('invalid_file_checkpoint');
    if(state.state==='committed'){if(!state.receipts.some(value=>value.operationId===state.operationId))throw failure('invalid_file_checkpoint');return state;}
    if(!Array.isArray(state.commands)||!state.commands.length||state.commands.length>256||!Number.isInteger(state.next)||state.next<0||state.next>state.commands.length)throw failure('invalid_file_checkpoint');
    const ids=new Set();
    for(const step of state.commands){
      if(!familyCommand(step.family)||typeof step.body_base64!=='string'||step.body_base64.length>22369624)throw failure('invalid_file_checkpoint');
      const bytes=Buffer.from(step.body_base64,'base64');
      if(bytes.length>MAX_BYTES||bytes.toString('base64')!==step.body_base64||ids.has(step.family.request.operation_id))throw failure('invalid_file_checkpoint');
      ids.add(step.family.request.operation_id);
    }
    if(!ids.has(state.operationId)||state.receipts.length!==state.next||state.receipts.some((value,index)=>value.operationId!==state.commands[index].family.request.operation_id))throw failure('invalid_file_checkpoint');
    if(state.state==='requested'&&state.next===state.commands.length)throw failure('invalid_file_checkpoint');
    return state;
  }
  function serial(action){const task=tail.then(action);tail=task.catch(()=>{});return task;}
  function persist(key,revision,state){return checkpoints.compareAndSwap({key,expectedRevision:revision,nextRevision:randomUUID(),encodedState:JSON.stringify(state)});}
  async function finish(head,state){
    if(state.state==='rejected')throw failure(state.code||'file_operation_rejected');
    if(state.state==='committed')return;
    for(;state.next<state.commands.length;){
      const step=state.commands[state.next];let result;
      try{result=await service.host.fileCommand(checkpoints.scope.clientId,step.family,Buffer.from(step.body_base64,'base64'));}
      catch(error){
        if(!error?.commitUncertain&&terminal.has(error?.code))await persist(head.key,head.revision,{...state,state:'rejected',code:error.code});
        throw error;
      }
      if(result.commit.operation_id!==step.family.request.operation_id)throw failure('invalid_file_receipt');
      state.receipts.push({operationId:result.commit.operation_id,sequence:result.commit.sequence});state.next++;
      // Never replan a completed/uncertain prefix. A lost checkpoint ACK is
      // recovered by loading its durable head before replaying an exact step.
      if(state.next===state.commands.length)state={version:2,operationId:state.operationId,signature:state.signature,state:'committed',receipts:state.receipts};
      head=await persist(head.key,head.revision,state);
      if(state.state==='committed')return;
    }
  }
  function execute(input){
    let request;try{request=capture(input);}catch(error){return Promise.reject(error);}
    return serial(async()=>{
      const key=prefix+request.operationId;let head=await checkpoints.load(key),state;
      if(head?.encodedState){state=decode(head);if(state.signature!==signature(request))throw failure('idempotency_conflict');}
      else{state={version:2,operationId:request.operationId,signature:signature(request),state:'requested',next:0,receipts:[],commands:await plan(request)};if(state.commands.length>256)throw failure('request_limit');head=await persist(key,head?.revision??null,state);}
      await finish(head,state);
    });
  }
  return Object.freeze({
    create:input=>execute({...input,kind:'createText'}),execute,
    recover(){return serial(async()=>{
      let cursor;
      for(let pageCount=0;pageCount<100;pageCount++){
        const page=await checkpoints.list({limit:100,cursor});
        for(const item of page.items){
          if(!item.key.startsWith(prefix)&&!item.key.startsWith(legacyPrefix))continue;
          const head=await checkpoints.load(item.key);if(!head?.encodedState)continue;
          const state=decode(head);if(state.state!=='requested')continue;
          try{await finish(head,state);}catch(error){if(error?.commitUncertain||!terminal.has(error?.code))throw error;}
        }
        if(page.cursor===null)return;cursor=page.cursor;
      }
      throw failure('file_recovery_limit');
    });},
  });
}
module.exports={desktopTextCreates};
