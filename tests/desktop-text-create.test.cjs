'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {desktopTextCreates}=require('../desktop/text-create.cjs');
function fixture(){
  const heads=new Map(),receipts=new Map(),files=new Map(),calls=[];
  let loseReply=false,denyCheckpoint=false;
  const checkpoints={scope:{vaultId:'local',clientId:'client'},
    async load(key){return heads.get(key)||null;},
    async compareAndSwap(change){
      if(denyCheckpoint)throw Object.assign(new Error('disk'),{code:'checkpoint_storage',commitUncertain:true});
      const prior=heads.get(change.key);assert.equal(prior?.revision??null,change.expectedRevision);
      const head={key:change.key,revision:change.nextRevision,encodedState:change.encodedState};heads.set(change.key,head);return head;
    },
    async list(){return {items:[...heads.values()].filter(h=>h.encodedState!==null),cursor:null};},
  };
  const service={host:{async createText(client,request,bytes){
    assert.equal(client,'client');
    const head=heads.get('create-text/v1/'+request.operationId);
    assert.ok(head?.encodedState,'exact command must be durable before mutation');
    assert.deepEqual(JSON.parse(head.encodedState).request,request);
    const serialized=JSON.stringify(request);calls.push(serialized);
    let stored=receipts.get(request.operationId);
    if(stored){assert.equal(stored.serialized,serialized);return stored.result;}
    if(files.has(request.path))throw Object.assign(new Error('exists'),{code:'revision_conflict',commitUncertain:false});
    const result={commit:{operation_id:request.operationId},projection:{state:'pending'}};
    files.set(request.path,Buffer.from(bytes));receipts.set(request.operationId,{serialized,result});
    if(loseReply){loseReply=false;throw Object.assign(new Error('lost'),{code:'host_timeout',commitUncertain:true});}
    return result;
  }}};
  return{service,checkpoints,heads,receipts,files,calls,lose(){loseReply=true;},deny(){denyCheckpoint=true;}};
}
const request={operationId:'operation',entryId:'entry',path:'New note.md',content:'Hello 🌱\n'};
test('text create checkpoints before mutation and recovery reuses exact request after lost commit reply',async()=>{
  const f=fixture();f.lose();
  const consumer=desktopTextCreates(f.service,f.checkpoints);
  const input={...request};const pending=consumer.create(input);input.content='later';
  await assert.rejects(pending,{code:'host_timeout'});
  assert.equal(f.files.get(request.path).toString(),request.content);
  assert.equal(f.receipts.size,1);
  await desktopTextCreates(f.service,f.checkpoints).recover();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0],f.calls[1]);assert.equal(f.receipts.size,1);
  assert.equal(f.heads.get('create-text/v1/operation').encodedState,null);
});
test('checkpoint failure prevents creation and invalid text does not create recovery records',async()=>{
  const f=fixture(),consumer=desktopTextCreates(f.service,f.checkpoints);f.deny();
  await assert.rejects(consumer.create(request),{code:'checkpoint_storage'});assert.equal(f.calls.length,0);
  await assert.rejects(consumer.create({...request,content:'\ud800'}),{code:'checkpoint_invalid'});assert.equal(f.heads.size,0);
});
test('text create never overwrites an existing path and persists terminal rejection',async()=>{
  const f=fixture();f.files.set(request.path,Buffer.from('keep'));
  await assert.rejects(desktopTextCreates(f.service,f.checkpoints).create(request),{code:'revision_conflict'});
  assert.equal(f.files.get(request.path).toString(),'keep');
  assert.equal(JSON.parse(f.heads.get('create-text/v1/operation').encodedState).state,'rejected');
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.calls.length,1);
});
