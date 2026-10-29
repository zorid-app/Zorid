'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {openDraftJournal} = require('../desktop/draft-journal.cjs');

const scope = {vaultId:'local-vault',clientId:'client-one',incarnationId:'renderer-one'};
const change = (overrides={}) => ({entryId:'entry-one',writer:'checkpoint-writer',generation:1,
  expectedRevision:null,nextRevision:'1',baseline:{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original body'},
  draft:'Protected body\n🌱\ud800',checkpointRevision:null,pendingOperation:null,...overrides});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-draft-journal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return path.join(directory,'journal');
}

test('acknowledged draft survives a fresh journal owner without the Rust host',async t=>{
  const directory=await fixture(t), journal=await openDraftJournal(directory), lease=journal.bind(scope);
  const receipt=await lease.compareAndSwap(change());
  assert.equal(receipt.revision,'1');
  lease.revoke();
  // Simulate profile ownership transfer after the old main process exits.
  const next=await openDraftJournal(directory), recovery=next.bind({...scope,incarnationId:'renderer-two'});
  const candidates=await recovery.list();
  assert.equal(candidates.length,1);
  const restored=await recovery.read(candidates[0]);
  assert.equal(restored.draft,'Protected body\n🌱\ud800');
  assert.deepEqual(restored.baseline,{entryId:'entry-one',path:'Note.md',revision:'source-one',content:'Original body'});
  assert.equal(restored.writer,'checkpoint-writer');
  assert.equal(restored.incarnationId,'renderer-one');
  assert.equal(restored.generation,1);
});

test('exact retries join a revision, changed reuse and stale CAS cannot overwrite it',async t=>{
  const lease=(await openDraftJournal(await fixture(t))).bind(scope), request=change();
  const receipt=await lease.compareAndSwap(request);
  assert.deepEqual(await lease.compareAndSwap(request),receipt);
  await assert.rejects(lease.compareAndSwap(change({draft:'Different bytes'})),{code:'draft_revision_conflict'});
  await lease.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:2,draft:'Newer body'}));
  await assert.rejects(lease.compareAndSwap(request),{code:'draft_revision_conflict'});
  assert.equal((await lease.read(request)).draft,'Newer body');
  await assert.rejects(lease.compareAndSwap(change({expectedRevision:'2',nextRevision:'1'})),{code:'invalid_draft_revision'});
});

function faultFiles({writeHead,renameHead,syncDirectory}={}) {
  return new Proxy(fs,{get(target,key){
    if(key==='open')return async(file,...args)=>{
      const handle=await fs.open(file,...args);
      if(syncDirectory&&(await handle.stat()).isDirectory())return new Proxy(handle,{get(owner,method){
        if(method==='sync')return ()=>syncDirectory(owner,file);
        const value=Reflect.get(owner,method);return typeof value==='function'?value.bind(owner):value;
      }});
      const headTemp=path.basename(file).startsWith('.draft-')&&path.basename(path.dirname(file))!=='blobs';
      if(!headTemp||!writeHead)return handle;
      return new Proxy(handle,{get(owner,method){
        if(method==='writeFile')return bytes=>writeHead(owner,bytes);
        const value=Reflect.get(owner,method);return typeof value==='function'?value.bind(owner):value;
      }});
    };
    if(key==='rename'&&renameHead)return async(from,to)=>{
      if(path.basename(to)==='head.json')return renameHead(from,to);
      return fs.rename(from,to);
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
}

test('interrupted replacement leaves previous acknowledged draft readable and exact retry succeeds',async t=>{
  const directory=await fixture(t);let interrupt=false;
  const journal=await openDraftJournal(directory,{fileSystem:faultFiles({writeHead:async(handle,bytes)=>{
    if(interrupt){interrupt=false;await handle.writeFile(bytes.subarray(0,12));throw Object.assign(new Error('Disk full'),{code:'ENOSPC'});}
    await handle.writeFile(bytes);
  }})});
  const lease=journal.bind(scope);await lease.compareAndSwap(change());interrupt=true;
  const later=change({expectedRevision:'1',nextRevision:'2',generation:2,draft:'Later protected body'});
  await assert.rejects(lease.compareAndSwap(later),{code:'draft_storage_failure',commitUncertain:true});
  assert.equal((await lease.read(later)).draft,'Protected body\n🌱\ud800');
  await journal.close();
  const reopened=(await openDraftJournal(directory)).bind(scope);
  assert.equal((await reopened.read(later)).revision,'1');
  await reopened.compareAndSwap(later);
  assert.equal((await reopened.read(later)).draft,'Later protected body');
});

test('lost publication reply is retried with its exact identity after owner restart',async t=>{
  const directory=await fixture(t);let lose=true;
  const journal=await openDraftJournal(directory,{fileSystem:faultFiles({renameHead:async(from,to)=>{
    await fs.rename(from,to);
    if(lose){lose=false;throw Object.assign(new Error('Reply lost after rename'),{code:'EIO'});}
  }})});
  const lease=journal.bind(scope), request=change({pendingOperation:'{"operationId":"original-id","captureId":"original-capture","phase":"prepared"}'});
  await assert.rejects(lease.compareAndSwap(request),{code:'draft_storage_failure',commitUncertain:true});
  await journal.close();
  const recovery=(await openDraftJournal(directory)).bind(scope);
  assert.equal((await recovery.compareAndSwap(request)).revision,'1');
  const retained=await recovery.read(request);
  assert.equal(retained.pendingOperation,'{"operationId":"original-id","captureId":"original-capture","phase":"prepared"}');
  await assert.rejects(recovery.compareAndSwap({...request,pendingOperation:'{"operationId":"replacement-id"}'}),{code:'draft_revision_conflict'});
});

test('concurrent renderer writers retain separate branches while scope limits discovery',async t=>{
  const journal=await openDraftJournal(await fixture(t)), one=journal.bind(scope);
  const two=journal.bind({...scope,incarnationId:'renderer-two'});
  const otherClient=journal.bind({...scope,clientId:'other-client'});
  const otherVault=journal.bind({...scope,vaultId:'recreated-vault'});
  await Promise.all([one.compareAndSwap(change({draft:'Branch one'})),two.compareAndSwap(change({draft:'Branch two'})),
    otherClient.compareAndSwap(change({draft:'Other client'})),otherVault.compareAndSwap(change({draft:'Other vault'}))]);
  const branches=await one.list();assert.equal(branches.length,2);
  assert.deepEqual((await Promise.all(branches.map(row=>one.read(row)))).map(row=>row.draft).sort(),['Branch one','Branch two']);
  assert.equal((await otherClient.list()).length,1);assert.equal((await otherVault.list()).length,1);
  assert.throws(()=>journal.bind(scope),{code:'draft_incarnation_reused'});
});

test('retirement compares exact branch revision and generation, retains newer edits and other writers',async t=>{
  const journal=await openDraftJournal(await fixture(t)), one=journal.bind(scope), two=journal.bind({...scope,incarnationId:'renderer-two'});
  await one.compareAndSwap(change());await two.compareAndSwap(change({draft:'Other branch'}));
  const retire={entryId:'entry-one',writer:'checkpoint-writer',expectedRevision:'1',nextRevision:'2',generation:1};
  await one.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:2,draft:'Typed while saving'}));
  await assert.rejects(one.retire(retire),{code:'draft_revision_conflict'});
  await assert.rejects(one.retire({...retire,expectedRevision:'2',nextRevision:'3'}),{code:'draft_revision_conflict'});
  const exact={...retire,expectedRevision:'2',nextRevision:'3',generation:2};
  const retired=await one.retire(exact);assert.equal(retired.deleted,true);
  assert.deepEqual(await one.retire(exact),retired,'lost cleanup reply is idempotent');
  assert.equal((await one.read(exact)).deleted,true);
  assert.equal((await one.list()).length,1);assert.equal((await two.read(change())).draft,'Other branch');
  await one.compareAndSwap(change({expectedRevision:'3',nextRevision:'4',generation:3,draft:'New edit after save'}));
  await assert.rejects(one.retire(exact),{code:'draft_revision_conflict'});
});

test('revocation fences queued and not-yet-authorized publication without destroying protected text',async t=>{
  const directory=await fixture(t);let hold,started,ready=false;
  const waiting=new Promise(resolve=>{started=resolve;}), gate=new Promise(resolve=>{hold=resolve;});
  const journal=await openDraftJournal(directory,{fileSystem:faultFiles({writeHead:async(handle,bytes)=>{
    if(ready){started();await gate;}await handle.writeFile(bytes);
  }})});
  const lease=journal.bind(scope);await lease.compareAndSwap(change());ready=true;
  const inFlight=lease.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:2,draft:'Not authorized'}));
  await waiting;
  const queued=lease.compareAndSwap(change({expectedRevision:'2',nextRevision:'3',generation:3,draft:'Queued'}));
  lease.revoke();hold();
  await assert.rejects(inFlight,{code:'draft_lease_revoked'});await assert.rejects(queued,{code:'draft_lease_revoked'});
  const recovery=journal.bind({...scope,incarnationId:'recovery'});
  assert.equal((await recovery.read({...change(),incarnationId:scope.incarnationId})).draft,'Protected body\n🌱\ud800');
});

test('corrupt head metadata is retained and rejected instead of returning a false protected generation',async t=>{
  const directory=await fixture(t), journal=await openDraftJournal(directory), lease=journal.bind(scope);
  await lease.compareAndSwap(change());
  const branches=await fs.readdir(path.join(directory,'branches'));
  const file=path.join(directory,'branches',branches[0],'head.json');
  const raw=JSON.parse(await fs.readFile(file,'utf8'));raw.generation=500;
  await fs.writeFile(file,JSON.stringify(raw));
  await assert.rejects(lease.read(change()),{code:'draft_storage_corrupt'});
  await assert.rejects(lease.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:501})),{code:'draft_storage_corrupt'});
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).generation,500,'corrupt evidence is not overwritten');
});

test('directory sync failure cannot acknowledge protection, exact retry completes its durable publication',async t=>{
  let failSync=false;
  const journal=await openDraftJournal(await fixture(t),{fileSystem:faultFiles({
    renameHead:async(from,to)=>{await fs.rename(from,to);failSync=true;},
    syncDirectory:async handle=>{if(failSync){failSync=false;throw Object.assign(new Error('Directory sync failed'),{code:'EIO'});}await handle.sync();},
  })});
  const lease=journal.bind(scope), request=change();
  await assert.rejects(lease.compareAndSwap(request),{code:'draft_storage_failure',commitUncertain:true});
  assert.equal((await lease.compareAndSwap(request)).revision,'1');
  assert.equal((await lease.read(request)).draft,'Protected body\n🌱\ud800');
});

test('corrupt referenced body blocks reads and successor writes without discarding evidence',async t=>{
  const directory=await fixture(t),lease=(await openDraftJournal(directory)).bind(scope);await lease.compareAndSwap(change());
  const [branch]=await fs.readdir(path.join(directory,'branches'));
  const folder=path.join(directory,'branches',branch),raw=JSON.parse(await fs.readFile(path.join(folder,'head.json'),'utf8'));
  const body=path.join(folder,'blobs',raw.draft);await fs.writeFile(body,Buffer.from('Damaged source'));
  await assert.rejects(lease.read(change()),{code:'draft_storage_corrupt'});
  await assert.rejects(lease.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:2,draft:'Successor'})),{code:'draft_storage_corrupt'});
  assert.equal((await fs.readFile(body)).toString(),'Damaged source');
});

test('invalid identities and explicit source size limits retain the last acknowledged candidate',async t=>{
  const journal=await openDraftJournal(await fixture(t)),lease=journal.bind(scope);await lease.compareAndSwap(change());
  await assert.rejects(lease.compareAndSwap(change({generation:-0,expectedRevision:'1',nextRevision:'2'})),{code:'invalid_draft_generation'});
  await assert.rejects(lease.compareAndSwap(change({draft:'x'.repeat(32*1024*1024+1),expectedRevision:'1',nextRevision:'2'})),{code:'draft_size_limit'});
  await assert.rejects(lease.compareAndSwap(change({incarnationId:'forged',expectedRevision:'1',nextRevision:'2'})),{code:'invalid_draft_identity'});
  assert.equal((await lease.read(change())).revision,'1');
});

test('synchronous owner validation is required and a revoked owner cannot publish',async t=>{
  const journal=await openDraftJournal(await fixture(t));
  assert.throws(()=>journal.bind(scope,async()=>{}),{code:'invalid_draft_owner_check'});
  let valid=true;
  const lease=journal.bind({...scope,incarnationId:'other'},()=>valid);
  await lease.compareAndSwap(change());valid=false;
  await assert.rejects(lease.compareAndSwap(change({expectedRevision:'1',nextRevision:'2',generation:2})),{code:'draft_lease_revoked'});
});

test('symlinked storage root and branch are rejected rather than following replacement paths',async t=>{
  const directory=await fixture(t),target=path.join(path.dirname(directory),'target');await fs.mkdir(target);
  await fs.symlink(target,directory);await assert.rejects(openDraftJournal(directory),{code:'draft_storage_corrupt'});
  await fs.unlink(directory);
  const lease=(await openDraftJournal(directory)).bind(scope);await lease.compareAndSwap(change());
  const [name]=await fs.readdir(path.join(directory,'branches')),branch=path.join(directory,'branches',name);
  await fs.rename(branch,path.join(target,'moved'));await fs.symlink(path.join(target,'moved'),branch);
  await assert.rejects(lease.read(change()),{code:'draft_storage_corrupt'});
});
