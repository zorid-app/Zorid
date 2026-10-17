'use strict';
const {randomUUID}=require('node:crypto');
const {normalizePath}=require('./vault-service.cjs');
const {checkpointBytes}=require('./durable-checkpoints.cjs');
const prefix='create-text/v1/';
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure=code=>Object.assign(new Error('Text creation could not finish; its exact request is retained.'),{code});
const terminal=new Set(['invalid_path','invalid_identifier','invalid_mutation','invalid_text','invalid_family_command','entry_not_found','entry_deleted','revision_conflict','idempotency_conflict']);

/** Main-owned create consumer. The durable checkpoint is explicit authorization
 * for this exact user-requested Create/Text, never an overwrite or inferred mode.
 * Native family receipts supply idempotency even after checkpoint cleanup.
 */
function desktopTextCreates(service,checkpoints){
  let tail=Promise.resolve();
  function capture(input){
    if(!input||!identity(input.operationId)||!identity(input.entryId)||typeof input.content!=='string')throw failure('invalid_create_request');
    const content=checkpointBytes(input.content);if(content.length>8*1024*1024)throw failure('request_limit');
    return Object.freeze({operationId:input.operationId,entryId:input.entryId,path:normalizePath(input.path),content:input.content});
  }
  function decode(head){
    let state;try{state=JSON.parse(head.encodedState);}catch{throw failure('invalid_create_checkpoint');}
    if(state.version!==1||state.mode!=='text'||!['requested','rejected'].includes(state.state))throw failure('invalid_create_checkpoint');
    const request=capture(state.request);
    if(head.key!==prefix+request.operationId)throw failure('invalid_create_checkpoint');
    return {...state,request};
  }
  function serial(action){const task=tail.then(action);tail=task.catch(()=>{});return task;}
  function persist(key,revision,state){return checkpoints.compareAndSwap({key,expectedRevision:revision,nextRevision:randomUUID(),encodedState:state===null?null:JSON.stringify(state)});}
  async function finish(head,state){
    if(state.state==='rejected')throw failure(state.code||'create_rejected');
    let result;
    try{result=await service.host.createText(checkpoints.scope.clientId,state.request,checkpointBytes(state.request.content));}
    catch(error){
      if(!error?.commitUncertain&&terminal.has(error?.code))await persist(head.key,head.revision,{...state,state:'rejected',code:error.code});
      throw error;
    }
    // Transport validates exact operation/entry/path receipt. Projection pending
    // remains a successful durable create; publication reads native DB state.
    if(result.commit.operation_id!==state.request.operationId)throw failure('invalid_create_receipt');
    await persist(head.key,head.revision,null);
  }
  return Object.freeze({
    create(input){
      let request;try{request=capture(input);}catch(error){return Promise.reject(error);}
      return serial(async()=>{
        const key=prefix+request.operationId;let head=await checkpoints.load(key),state;
        if(head?.encodedState){state=decode(head);if(JSON.stringify(state.request)!==JSON.stringify(request))throw failure('idempotency_conflict');}
        else{state={version:1,mode:'text',state:'requested',request};head=await persist(key,head?.revision??null,state);}
        await finish(head,state);
      });
    },
    recover(){return serial(async()=>{
      let cursor;
      for(let pageCount=0;pageCount<100;pageCount++){
        const page=await checkpoints.list({limit:100,cursor});
        for(const item of page.items){
          if(!item.key.startsWith(prefix))continue;
          const head=await checkpoints.load(item.key);if(!head?.encodedState)continue;
          const state=decode(head);if(state.state==='rejected')continue;
          try{await finish(head,state);}catch(error){if(error?.commitUncertain||!terminal.has(error?.code))throw error;}
        }
        if(page.cursor===null)return;cursor=page.cursor;
      }
      throw failure('create_recovery_limit');
    });},
  });
}
module.exports={desktopTextCreates};
