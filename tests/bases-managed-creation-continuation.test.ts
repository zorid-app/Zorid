import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {createBaseSession} from '../src/bases/session.ts';
import type {DocumentService} from '../src/core/document-semantics.ts';
import type {DatabaseCollection,DatabaseRequest} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'schema-r1',deleted:false,properties:[]};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}},source={localStoreId:'store',watermark:'1'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await tick();assert.ok(check(),'operation did not settle');}

async function fixture(managed=true){
  const base=`views:\n - {id: aaaaaaaaaaaa, type: table, name: Books${managed?', source: {kind: collection, id: abcdefghijkl}':''}}\n`;
  const adapter=new MemoryAdapter({'Work.base':base});
  const requests:DatabaseRequest[]=[],errors:unknown[]=[],opened:string[]=[],writes:string[]=[];
  let failReload=false,failAfterCommit=false,failOpen=false,failQuery=false,failQueryAfterCommit=false,loseAck=false;
  const receipts=new Map<string,unknown>();
  const list=adapter.list.bind(adapter),write=adapter.write.bind(adapter);
  adapter.list=async()=>{if(failReload){failReload=false;throw new Error('Postcommit inventory read failed');}return(await list()).map(entry=>({...entry,entryId:entry.path,revision:'r1'}));};
  adapter.stat=async path=>(await list()).filter(entry=>entry.path===path).map(entry=>({...entry,entryId:path,revision:'r1'}))[0]??null;
  adapter.write=async(path,text)=>{writes.push(path);return write(path,text);};
  if(managed){
    Object.assign(adapter,{databases:{async request(command:DatabaseRequest){
      if(command.op==='create_entry'){
        requests.push(structuredClone(command));if(receipts.has(command.operationId))return structuredClone(receipts.get(command.operationId));
        await adapter.write(command.path,command.body);if(failAfterCommit){failAfterCommit=false;failReload=true;}
        if(failQueryAfterCommit){failQueryAfterCommit=false;failQuery=true;}
        const response={collections:[collection],entries:[{entryId:command.entryId,collectionId:collection.id,revision:'member-r1',fileRevision:'r1',path:command.path,values:command.values,deleted:false,pendingProjection:false}],projection:{pending:0,issues:[]}};
        receipts.set(command.operationId,structuredClone(response));if(loseAck){loseAck=false;throw new Error('Create reply lost');}return response;
      }
      return{collections:[collection],entries:[],projection:{pending:0,issues:[]}};
    }}});
    const unused=async():Promise<never>=>{throw new Error('Unexpected document operation');};
    Object.assign(adapter,{documentSemantics:{status:async()=>({source,snapshot,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
      open:async()=>({pinId:'pin',source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,
        metadata:async()=>({source,snapshot,coverageComplete:true,value:{entry:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},metadata:null,exclusion:null}}),
        base:async()=>{if(failQuery){failQuery=false;throw new Error('Postcommit derived query failed');}return({source,snapshot,coverageComplete:true,value:{definition:{id:'Work.base',revision:'r1',path:'Work.base',kind:'file',deleted:false},result:{snapshotId:snapshot,view:BaseDocument.parse(await adapter.read('Work.base')).views[0],rows:[],groups:[],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:0,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}}});},
      })} as unknown as DocumentService});
  }
  const vault=new Vault(adapter);await vault.initialize();
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>();
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(){throw new Error('Expected awaited presentation');},openCreatedFile:async path=>{opened.push(path);if(failOpen){failOpen=false;throw new Error('Created view failed to open');}},onError:error=>errors.push(error),buffers:{validate(){},getBuffer:async path=>{let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);buffers.set(path,buffer);}await buffer.load();return buffer;}}});
  await session.ready;
  return{adapter,vault,session,requests,errors,opened,writes,host,dom,base,
    failNextReload(){failAfterCommit=true;},failNextOpen(){failOpen=true;},
    failNextQuery(){failQueryAfterCommit=true;},loseNextAck(){loseAck=true;},
    create(){host.querySelector<HTMLButtonElement>('[aria-label="New"]')!.click();},
    async close(){await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('managed New retains its committed receipt after a postcommit inventory failure',async()=>{
  const f=await fixture();f.failNextReload();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Postcommit inventory read failed/);assert.equal(f.requests.length,1);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,1,'retry must not create another managed entry');
  assert.equal(f.opened[0],f.requests[0].op==='create_entry'?f.requests[0].path:undefined);
  await until(()=>!f.session.hasPendingChanges());await f.close();
});

for(const managed of [true,false])test(`${managed?'managed entry':'note'} New retries presentation of the exact committed item, then accepts a distinct New`,async()=>{
  const f=await fixture(managed);f.failNextOpen();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Created view failed to open/);
  assert.equal(f.session.hasPendingChanges(),true,'a committed unpresented item still belongs to its owner');
  assert.equal(f.session.canRecoverAdmission(),false,'view retirement cannot discard a retained creation');
  await assert.rejects(f.session.flush(),/Use New again/);
  f.create();await until(()=>f.opened.length===2);
  assert.equal(f.opened[1],f.opened[0],'presentation retry must retain the committed target');
  assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1,'presentation retry must not write another note');
  if(managed)assert.equal(f.requests.length,1);
  await until(()=>!f.session.hasPendingChanges());f.create();await until(()=>f.opened.length===3);
  assert.notEqual(f.opened[2],f.opened[0],'a successfully presented New releases the intent');
  if(managed){assert.equal(f.requests.length,2);const [first,next]=f.requests;if(first.op==='create_entry'&&next.op==='create_entry'){assert.notEqual(next.operationId,first.operationId);assert.notEqual(next.entryId,first.entryId);}}
  await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('managed New retains an ACK when the controller reports a derived query error',async()=>{
  const f=await fixture();f.failNextQuery();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Postcommit derived query failed/);assert.equal(f.opened.length,0);assert.equal(f.session.hasPendingChanges(),true);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,1);await until(()=>!f.session.hasPendingChanges());await f.close();
});

test('a lost managed creation ACK reconciles the original operation before presenting it',async()=>{
  const f=await fixture();f.loseNextAck();f.create();await until(()=>f.errors.length>0);
  assert.match(String(f.errors[0]),/Create reply lost/);assert.equal(f.session.hasPendingChanges(),true);
  f.create();await until(()=>f.opened.length===1);assert.equal(f.requests.length,2);assert.deepEqual(f.requests[0],f.requests[1]);
  assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1);await until(()=>!f.session.hasPendingChanges());await f.close();
});

for(const managed of [true,false])test(`${managed?'managed':'note'} committed New cannot retarget a replacement view`,async()=>{
  const f=await fixture(managed);f.failNextOpen();f.create();await until(()=>f.errors.length>0);
  await f.vault.modify('Work.base',f.base.replace('aaaaaaaaaaaa','bbbbbbbbbbbb'));await f.session.refresh();
  const errors=f.errors.length;f.create();await until(()=>f.errors.length>errors);
  assert.match(String(f.errors.at(-1)),/original .* view/);assert.equal(f.opened.length,1);assert.equal(f.writes.filter(path=>path.endsWith('.md')).length,1);
  await f.vault.modify('Work.base',f.base);await f.session.refresh();f.create();await until(()=>f.opened.length===2);
  assert.equal(f.opened[0],f.opened[1]);await until(()=>!f.session.hasPendingChanges());await f.close();
});
