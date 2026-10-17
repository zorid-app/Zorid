'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {desktopTextCreates}=require('../desktop/text-create.cjs');
function fixture(){
  const heads=new Map(),receipts=new Map(),entries=new Map(),calls=[];
  let loseAt=0,denyCheckpoint=false,nextRevision=0,beforeApply;
  const checkpoints={scope:{vaultId:'local',clientId:'client'},
    async load(key){return heads.get(key)||null;},
    async compareAndSwap(change){
      if(denyCheckpoint)throw Object.assign(new Error('disk'),{code:'checkpoint_storage',commitUncertain:true});
      const prior=heads.get(change.key);assert.equal(prior?.revision??null,change.expectedRevision);
      const head={key:change.key,revision:change.nextRevision,encodedState:change.encodedState};heads.set(change.key,head);return head;
    },
    async list(){return {items:[...heads.values()].filter(h=>h.encodedState!==null),cursor:null};},
  };
  const reject=code=>{throw Object.assign(new Error(code),{code,commitUncertain:false});};
  const find=id=>[...entries.values()].find(row=>row.entry.id===id);
  const put=(id,path,kind,bytes)=>{const row={entry:{id,path,kind,revision:String(++nextRevision),deleted:false},has_content:kind==='file',bytes:Buffer.from(bytes)};entries.set(path,row);return row;};
  const service={host:{
    async readPath(path){const row=entries.get(path);return row?structuredClone(row):null;},
    async fileCommand(client,family,bytes){
      assert.equal(client,'client');
      const id=family.request.operation_id,mutation=family.request.mutation;
      assert.ok([...heads.values()].some(head=>{const state=JSON.parse(head.encodedState);return state.commands?.some(step=>step.family.request.operation_id===id)||state.request?.operationId===id;}),'exact command must be durable before mutation');
      const serialized=JSON.stringify({family,bytes:Buffer.from(bytes).toString('base64')});calls.push({id,serialized});
      const stored=receipts.get(id);if(stored){assert.equal(stored.serialized,serialized);return stored.result;}
      beforeApply?.();beforeApply=undefined;
      const current=find(mutation.id);
      if(mutation.type==='create'){
        if(entries.has(mutation.path)||current)reject('invalid_request');
        const parent=mutation.path.includes('/')?mutation.path.slice(0,mutation.path.lastIndexOf('/')):'';
        if(parent&&entries.get(parent)?.entry.kind!=='folder')reject('not_found');
        put(mutation.id,mutation.path,mutation.kind,bytes);
      }else{
        if(!current)reject('not_found');if(current.entry.revision!==mutation.expected)reject('revision_conflict');
        const old=current.entry.path;
        if(mutation.type==='write')put(mutation.id,old,'file',bytes);
        else if(mutation.type==='move'){
          if(entries.has(mutation.path))reject('invalid_request');
          for(const [path,row]of [...entries])if(path===old||path.startsWith(old+'/')){entries.delete(path);put(row.entry.id,mutation.path+path.slice(old.length),row.entry.kind,row.bytes);}
        }else{
          if(!mutation.recursive&&[...entries.keys()].some(path=>path.startsWith(old+'/')))reject('invalid_request');
          for(const path of [...entries.keys()])if(path===old||path.startsWith(old+'/'))entries.delete(path);
        }
      }
      const result={commit:{operation_id:id,sequence:String(receipts.size+1)},projection:{state:'pending'}};
      receipts.set(id,{serialized,result});
      if(loseAt===calls.length){loseAt=0;throw Object.assign(new Error('lost'),{code:'host_timeout',commitUncertain:true});}
      return result;
    },
  }};
  return{service,checkpoints,heads,receipts,entries,calls,put,loseAt(value){loseAt=value;},deny(){denyCheckpoint=true;},before(action){beforeApply=action;}};
}
const request={operationId:'operation',entryId:'entry',path:'New note.md',content:'Hello 🌱\n'};
const input=(kind,path,more={})=>({kind,path,operationId:`op-${kind}-${path.replace(/[^A-Za-z0-9_-]/g,'-')}`,entryId:`id-${kind}-${path.replace(/[^A-Za-z0-9_-]/g,'-')}`,...more});
test('text create checkpoints before mutation and recovery reuses exact request after lost commit reply',async()=>{
  const f=fixture();f.loseAt(1);const consumer=desktopTextCreates(f.service,f.checkpoints);
  const mutable={...request};const pending=consumer.create(mutable);mutable.content='later';
  await assert.rejects(pending,{code:'host_timeout'});assert.equal(f.entries.get(request.path).bytes.toString(),request.content);
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.calls.length,2);assert.equal(f.calls[0].serialized,f.calls[1].serialized);assert.equal(f.receipts.size,1);
  assert.equal(JSON.parse(f.heads.get('file-command/v1/operation').encodedState).state,'committed');
  await desktopTextCreates(f.service,f.checkpoints).create(request);assert.equal(f.calls.length,2);
});
test('checkpoint failure prevents creation and invalid text does not create recovery records',async()=>{
  const f=fixture(),consumer=desktopTextCreates(f.service,f.checkpoints);f.deny();
  await assert.rejects(consumer.create(request),{code:'checkpoint_storage'});assert.equal(f.calls.length,0);
  await assert.rejects(consumer.create({...request,content:'\ud800'}),{code:'checkpoint_invalid'});assert.equal(f.heads.size,0);
});
test('existing destination and missing parent never overwrite or poison startup',async()=>{
  const f=fixture(),consumer=desktopTextCreates(f.service,f.checkpoints);f.put('existing',request.path,'file',Buffer.from('keep'));
  await assert.rejects(consumer.create(request),{code:'revision_conflict'});assert.equal(f.entries.get(request.path).bytes.toString(),'keep');
  await assert.rejects(consumer.create({...request,path:'Missing/note.md'}),{code:'not_found'});
  assert.equal(JSON.parse(f.heads.get('file-command/v1/operation').encodedState).state,'rejected');
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.calls.length,1);
});
test('folder, exact binary create/write, move and permanent delete use one durable command path',async()=>{
  const f=fixture(),consumer=desktopTextCreates(f.service,f.checkpoints);
  await consumer.execute(input('mkdir','Folder'));
  const bytes=Uint8Array.from([0,255,128,10]);const creating=consumer.execute(input('writeBinary','Folder/data.bin',{data:bytes}));bytes.fill(1);await creating;
  assert.deepEqual([...f.entries.get('Folder/data.bin').bytes],[0,255,128,10]);
  await consumer.execute(input('writeBinary','Folder/data.bin',{operationId:'overwrite',data:new Uint8Array([9,0])}));
  await consumer.execute(input('move','Folder',{destination:'Moved'}));assert.deepEqual([...f.entries.get('Moved/data.bin').bytes],[9,0]);
  await assert.rejects(consumer.execute(input('delete','Moved',{force:false})),{code:'invalid_request'});
  await consumer.execute(input('delete','Moved',{operationId:'recursive-delete',force:true}));assert.equal(f.entries.size,0);
});
test('trash resumes exact completed prefix after lost ACK and preserves recovery bytes',async()=>{
  const f=fixture();f.put('folder','Folder','folder',Buffer.alloc(0));f.put('file','Folder/data.bin','file',Buffer.from([0,255]));f.loseAt(2);
  await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(input('trash','Folder/data.bin')),{code:'host_timeout'});
  assert.equal(f.receipts.size,2);await desktopTextCreates(f.service,f.checkpoints).recover();
  assert.equal(f.calls[1].serialized,f.calls[2].serialized);assert.equal(f.receipts.size,4);
  const destination='.trash/op-trash-Folder-data-bin/Folder/data.bin';assert.deepEqual([...f.entries.get(destination).bytes],[0,255]);assert.equal(f.entries.has('Folder/data.bin'),false);
});
test('a concurrent edit rejects the recorded CAS and is never overwritten during recovery',async()=>{
  const f=fixture();f.put('file','note.md','file',Buffer.from('before'));f.before(()=>f.put('file','note.md','file',Buffer.from('concurrent')));
  await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(input('writeText','note.md',{content:'mine',expectedContent:'before'})),{code:'revision_conflict'});
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.entries.get('note.md').bytes.toString(),'concurrent');assert.equal(f.calls.length,1);
});

test('identity-bound backlink CAS rejects a same-byte replacement before authorization',async()=>{
  const f=fixture();const old=f.put('original','note.md','file',Buffer.from('same'));f.put('replacement','note.md','file',Buffer.from('same'));
  await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(input('writeText','note.md',{content:'rewrite',expectedContent:'same',expectedEntryId:'original',expectedRevision:old.entry.revision})),{code:'revision_conflict'});
  assert.equal(f.calls.length,0);assert.equal(f.heads.size,0);assert.equal(f.entries.get('note.md').bytes.toString(),'same');
});
test('retained original text-create checkpoint resumes and remains readable on another restart',async()=>{
  const f=fixture();f.heads.set('create-text/v1/operation',{key:'create-text/v1/operation',revision:'original',encodedState:JSON.stringify({version:1,mode:'text',state:'requested',request})});
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.entries.get(request.path).bytes.toString(),request.content);
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.calls.length,1);
});
