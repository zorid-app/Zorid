'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
const clone=value=>structuredClone(value);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(check){for(let turn=0;turn<100;turn++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Expected bounded service progress');}
const status=(phase='discovery')=>({complete:phase==='complete',work:{phase,pending:['discovery','import','publication'].includes(phase),workUnits:1}});
const source={localStoreId:'store',watermark:'1'};
function runtime(kind=null,foreground=false){
  return {update:{lifetime:'life',revision:'1',source,published:null,freshness:'lagging',phase:'indexing',progress:null,coverageComplete:null,hasForegroundDemand:foreground,error:null},
    inFlight:kind?{lifetime:'life',effectId:'1',priority:'background',targetSource:source,effect:kind==='pump'?{kind,snapshot:{localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'metadata-2',resolver:'resolver-1',query:'query-1'}}}:{kind}}:null,
    lastStep:null,execution:kind?'dispatch':'waitForWake'};
}
function fixture({initial=status(),kind='begin',scanReplies=[]}={}){
  const queued=new Map(),calls=[],errors=[];let turn=0,current=runtime(kind),journal=false;
  const host={root:'/import-index-fixture',capabilities:['documents','document_runtime'],reconciliation:initial,
    async rescan(){calls.push({op:'rescan'});assert.ok(scanReplies.length,'unexpected scan');const next=await scanReplies.shift();if(next instanceof Error)throw next;return {complete:next.complete,reconciliation:next};},
    async request(command,_body,_lease,guard){guard?.();assert.equal(command.method,'rescan');return {result:await this.rescan()};},
    async changesAfter(cursor){calls.push({op:'changes'});const next=journal?'1':cursor;const changes=journal?[{cursor:next,origin:{kind:'local_command',operation_id:'source'},requires_full_reload:false,entries:[]}]:[];journal=false;return {changes,next_cursor:next,has_more:false};},
    async documentRuntime(clientId,op,args){
      calls.push({op,clientId,args:clone(args)});
      if(op==='runtime_owner')return {...clone(args),snapshot:clone(current)};
      if(op==='runtime_owner_ack')return true;
      if(op==='runtime_snapshot')return {snapshot:clone(current)};
      if(op==='runtime_control')return {...clone(args),snapshot:clone(current),frame:{version:1,scope:{localStoreId:'store',clientId},update:clone(current.update),outcomes:[]}};
      if(op==='runtime_step'){assert.deepEqual(args,{lifetime:'life',effectId:'1'});current=runtime();return {snapshot:clone(current)};}
      assert.fail(`Unexpected runtime operation ${op}`);
    },async close(){},
  };
  const core=new CoreVaultFixtureService(host,{pollMs:60000,rescanMs:30000,familyMode:true,documentRuntime:true,now:()=>0,
    watchFactory(){const watcher=new EventEmitter();watcher.close=()=>watcher.emit('close');return watcher;}});
  const scheduler=core.ensureDocumentScheduler();
  scheduler.defer=callback=>{const id=++turn;queued.set(id,callback);return id;};scheduler.cancel=id=>queued.delete(id);scheduler.onError=error=>errors.push(error);
  async function settled(){for(let i=0;i<80;i++)await Promise.resolve();}
  async function drain(){for(let i=0;queued.size&&i<64;i++){const [id,callback]=queued.entries().next().value;queued.delete(id);callback();await settled();}assert.equal(queued.size,0,'scheduler must reach a wait boundary');}
  const register=()=>core.registerDocumentRuntimeOwner({host,clientId:'client',localStoreId:'store',assertActive(){}});
  return {host,core,scheduler,calls,errors,register,drain,settled,setRuntime(value){current=clone(value);},changeJournal(){journal=true;}};
}
const steps=f=>f.calls.filter(call=>call.op==='runtime_step');
const commands=f=>f.calls.filter(call=>call.op==='runtime_owner').map(call=>call.args.command.kind);

test('real service startup and import quanta defer background Begin/Pump until logical publication',async()=>{
  for(const kind of ['begin','pump']){
    const first=deferred(),second=deferred(),third=deferred();
    const f=fixture({kind,scanReplies:[first.promise,second.promise,third.promise]});f.register();
    try{
      await f.drain();assert.equal(steps(f).length,0,`${kind} must wait on initial discovery`);
      first.resolve(status('import'));await until(()=>f.calls.filter(call=>call.op==='rescan').length===2);
      await f.drain();assert.equal(steps(f).length,0,`${kind} must wait between import quanta`);
      second.resolve(status('publication'));await until(()=>f.calls.filter(call=>call.op==='rescan').length===3);
      await f.drain();assert.equal(steps(f).length,1,'logical source is complete before physical publication finishes');
      const before=commands(f).length;
      third.resolve(status('complete'));await until(()=>f.core.reconciliation.work.phase==='complete'&&!f.core.polling);
      await f.drain();assert.equal(f.core.cursor,'0');
      assert.deepEqual(commands(f).slice(before),['sourceHint'],'completion wakes even without a journal change');
      assert.equal(commands(f).filter(value=>value==='wake').length,1,'only initial owner admission needs Wake');
      assert.equal(f.core.continuation,null);
      const scans=f.calls.filter(call=>call.op==='rescan').length;await f.core.poll();await f.drain();
      assert.equal(f.calls.filter(call=>call.op==='rescan').length,scans,'healthy idle adds no scan');
      assert.deepEqual(f.errors,[]);
    }finally{first.resolve(status('complete'));second.resolve(status('complete'));third.resolve(status('complete'));await f.core.close();}
  }
});

test('a real foreground request passes the service import gate',async()=>{
  const scan=deferred(),f=fixture({kind:'pump',scanReplies:[scan.promise]});const owner=f.register();
  try{
    await f.drain();assert.equal(steps(f).length,0);
    f.setRuntime(runtime('pump',true));
    await owner.control({sequence:'1',command:{kind:'request',lifetime:'life',id:'1',maxPumps:8,maxRestarts:1,forceRebuild:false}});
    await f.drain();assert.equal(steps(f).length,1);assert.deepEqual(f.errors,[]);
  }finally{scan.resolve(status('complete'));await f.core.close();}
});

test('completion progress and actual journal advancement coalesce into one genuine Wake',async()=>{
  const f=fixture({initial:status('publication'),scanReplies:[status('complete')]});
  try{
    f.changeJournal();await f.core.poll();await f.drain();
    assert.equal(f.core.cursor,'0','without an admitted runtime owner there is no maintenance');
    const scan=deferred();f.host.rescan=async()=>{f.calls.push({op:'rescan'});return scan.promise;};
    f.register();f.changeJournal();scan.resolve({complete:true,reconciliation:status('complete')});
    await until(()=>!f.core.polling);await f.drain();
    assert.equal(f.core.cursor,'1');
    assert.equal(commands(f).filter(kind=>kind==='wake').length,1,'admission and same-turn journal wake are coalesced');
    assert.equal(commands(f).filter(kind=>kind==='sourceHint').length,0,'progress does not duplicate the journal wake');
  }finally{await f.core.close();}
});

test('only explicit cooperative discovery/import is pending; blocked, publication and legacy state do not pause forever',async()=>{
  for(const initial of [null,{complete:false},{work:{pending:true,phase:'unknown'}},status('blocked'),status('publication'),status('complete')]){
    const f=fixture({initial,scanReplies:[status('complete')]});
    try{f.scheduler.addOwner({host:f.host,clientId:'client',localStoreId:'store',assertActive(){}});await f.drain();assert.equal(steps(f).length,1,JSON.stringify(initial));}
    finally{await f.core.close();}
  }
});

test('a failed scan releases the import hold through progress without clearing transport retry',async()=>{
  const scan=deferred(),f=fixture({initial:status('import'),scanReplies:[scan.promise]});f.register();
  try{
    await f.drain();f.scheduler.blocked=true;
    let progress=0,wakes=0;
    const oldProgress=f.scheduler.sourceImportProgress.bind(f.scheduler),oldWake=f.scheduler.wake.bind(f.scheduler);
    f.scheduler.sourceImportProgress=()=>{progress++;oldProgress();};f.scheduler.wake=()=>{wakes++;oldWake();};
    scan.reject(Object.assign(Error('scan failed'),{code:'temporary_scan_failure'}));
    await until(()=>!f.core.polling);await f.drain();
    assert.equal(f.core.reconciliation.work.phase,'blocked');assert.equal(f.scheduler.isSourceImportPending(),false);
    assert.equal(progress,1);assert.equal(wakes,0);assert.equal(f.scheduler.needsRetry(),true);
  }finally{scan.resolve(status('complete'));await f.core.close();}
});

test('stale host success or failure cannot accept status or wake a replacement runtime',async()=>{
  for(const fail of [false,true]){
    const scan=deferred(),f=fixture({initial:status('import'),scanReplies:[scan.promise]});
    const pending=f.core.scanNow();let notifications=0;
    f.core.host={...f.host,root:'/replacement'};
    f.core.documentScheduler={wake(){notifications++;},sourceImportProgress(){notifications++;},async close(){}};
    const rejected=assert.rejects(pending,{code:'client_ownership_lost'});
    if(fail)scan.reject(Object.assign(Error('old host failed'),{code:'temporary_scan_failure'}));else scan.resolve(status('complete'));
    await rejected;
    assert.equal(f.scheduler.isSourceImportPending(),false,'old scheduler callback is bound to its host');
    assert.equal(f.core.reconciliation.work.phase,'import');assert.equal(f.core.needsScan,true);
    assert.equal(notifications,0);
    await f.scheduler.close();await f.core.close();
  }
});
