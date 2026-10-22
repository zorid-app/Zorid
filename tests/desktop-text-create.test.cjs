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
    async readMetadata(path){const row=entries.get(path);return row?{entry:structuredClone(row.entry),has_content:row.has_content}:null;},
    async readPath(path){const row=entries.get(path);return row?structuredClone(row):null;},
    async fileCommand(client,family,bytes){
      assert.equal(client,'client');
      const id=family.request.operation_id,mutation=family.request.mutation;
      assert.ok([...heads.values()].some(head=>{const state=JSON.parse(head.encodedState);return state.commands?.some(step=>step.family.request.operation_id===id)||state.request?.operationId===id||state.state==='committed'&&state.operationId===id;}),'exact command must be durable before mutation or retained for committed receipt replay');
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
      const result={commit:{operation_id:id,sequence:String(receipts.size+1),...(mutation.type==='create'?{changes:[{before:null,after:structuredClone(find(mutation.id).entry)}]}:{})},projection:{state:'pending'}};
      receipts.set(id,{serialized,result});
      if(loseAt===calls.length){loseAt=0;throw Object.assign(new Error('lost'),{code:'host_timeout',commitUncertain:true});}
      return result;
    },
  }};
  return{service,checkpoints,heads,receipts,entries,calls,put,loseAt(value){loseAt=value;},deny(){denyCheckpoint=true;},before(action){beforeApply=action;}};
}
const request={operationId:'operation',entryId:'entry',path:'New note.md',content:'Hello 🌱\n'};
const input=(kind,path,more={})=>({kind,path,operationId:`op-${kind}-${path.replace(/[^A-Za-z0-9_-]/g,'-')}`,entryId:`id-${kind}-${path.replace(/[^A-Za-z0-9_-]/g,'-')}`,...more});
test('receipt consumer replays original committed identity across lost ACK and same-path replacement',async()=>{
  const f=fixture();f.loseAt(1);const first=desktopTextCreates(f.service,f.checkpoints);
  await assert.rejects(first.createReceipt(request),{code:'host_timeout'});
  const original=structuredClone(f.entries.get(request.path).entry);
  f.put('replacement',request.path,'file',Buffer.from(request.content));
  const receipt=await desktopTextCreates(f.service,f.checkpoints).createReceipt(request);
  assert.equal(receipt.operation_id,request.operationId);assert.deepEqual(receipt.changes[0],{before:null,after:original});
  assert.equal(f.entries.get(request.path).entry.id,'replacement');assert.equal(f.receipts.size,1);
  assert.ok(f.calls.every(call=>call.serialized===f.calls[0].serialized));
  await assert.rejects(first.createReceipt({...request,content:'changed'}),{code:'idempotency_conflict'});
});
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

test('binary create checkpoints an explicit absence-bound create and never overwrites a peer at commit',async()=>{
  const f=fixture(),consumer=desktopTextCreates(f.service,f.checkpoints),data=new Uint8Array([0,255,128]);
  f.before(()=>f.put('peer','race.bin','file',Buffer.from([7,8])));
  const creating=consumer.execute(input('createBinary','race.bin',{data}));data.fill(9);
  await assert.rejects(creating,{code:'invalid_request'});
  assert.deepEqual([...f.entries.get('race.bin').bytes],[7,8]);
  const head=f.heads.get('file-command/v1/op-createBinary-race-bin'),state=JSON.parse(head.encodedState),step=state.commands[0];
  assert.equal(state.state,'rejected');assert.equal(step.family.create_mode,'binary');
  assert.deepEqual(step.family.request.mutation,{type:'create',id:'id-createBinary-race-bin',path:'race.bin',kind:'file'});
  assert.deepEqual([...Buffer.from(step.body_base64,'base64')],[0,255,128]);
  await desktopTextCreates(f.service,f.checkpoints).recover();assert.equal(f.calls.length,1);
});

test('large-file namespace and destination planning uses metadata without reading payload bodies',async()=>{
  const f=fixture();f.put('large','large.bin','file',Buffer.from([1]));f.service.host.readPath=async()=>{throw new Error('namespace operation requested full bytes');};
  const consumer=desktopTextCreates(f.service,f.checkpoints);
  await consumer.execute(input('move','large.bin',{destination:'moved.bin'}));
  await consumer.execute(input('trash','moved.bin'));
  assert.equal(f.entries.has('large.bin'),false);assert.equal(f.entries.has('moved.bin'),false);
});


test('witnessed rename rejects partial and noncanonical pairs and stale/replaced/missing sources before planning',async()=>{
  for(const expected of [{expectedEntryId:'original'},{expectedRevision:'1'},{expectedEntryId:undefined,expectedRevision:undefined},{expectedEntryId:'bad/id',expectedRevision:'1'}]){
    const f=fixture();f.put('original','Note.md','file',Buffer.from('keep'));
    await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(input('move','Note.md',{destination:'Renamed.md',...expected})),{code:'invalid_file_request'});
    assert.equal(f.heads.size,0);assert.equal(f.calls.length,0);assert.equal(f.entries.has('Renamed.md'),false);
  }
  for(const [expectedEntryId,expectedRevision,missing] of [['replacement','1',false],['original','stale',false],['original','1',true]]){
    const f=fixture();if(!missing)f.put('original','Note.md','file',Buffer.from('keep'));
    await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(input('move','Note.md',{destination:'Renamed.md',expectedEntryId,expectedRevision})),{code:'revision_conflict'});
    assert.equal(f.heads.size,0);assert.equal(f.calls.length,0);assert.equal(f.entries.has('Renamed.md'),false);
  }
});

test('witnessed rename retries the exact committed move after lost ACK without moving a replacement',async()=>{
  const f=fixture(),old=f.put('original','Note.md','file',Buffer.from('original bytes'));
  const request=input('move','Note.md',{destination:'Renamed.md',expectedEntryId:old.entry.id,expectedRevision:old.entry.revision});
  f.loseAt(1);await assert.rejects(desktopTextCreates(f.service,f.checkpoints).execute(request),{code:'host_timeout'});
  f.put('replacement','Note.md','file',Buffer.from('replacement bytes'));
  f.service.host.readMetadata=async()=>{throw new Error('retained move must never resolve a replacement path');};
  const reopened=desktopTextCreates(f.service,f.checkpoints);
  await assert.rejects(reopened.execute({...request,expectedRevision:'different'}),{code:'idempotency_conflict'});
  await reopened.recover();await reopened.execute(request);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].serialized,f.calls[1].serialized);assert.equal(f.receipts.size,1);
  const mutation=JSON.parse(f.calls[0].serialized).family.request.mutation;
  assert.deepEqual(mutation,{type:'move',id:'original',expected:old.entry.revision,path:'Renamed.md'});
  assert.equal(f.entries.get('Note.md').entry.id,'replacement');assert.equal(f.entries.get('Note.md').bytes.toString(),'replacement bytes');
  assert.equal(f.entries.get('Renamed.md').entry.id,'original');assert.equal(f.entries.get('Renamed.md').bytes.toString(),'original bytes');
});
