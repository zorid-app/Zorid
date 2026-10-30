import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {assertFreshNativeScope,authenticateMain,emptyWarmEvidence,observeEarly,resetEmptyWarmState,validateEmptyWarmEvidence} from './preparation.mjs';
const evidence=()=>({scope:{vaultId:'fresh-store',clientId:'client'},entries:[],checkpoints:{items:[],cursor:null},independent:{independentJournal:true,schemaVersion:1,ok:true,value:[]},unacknowledged:[],draftKeys:[]});
test('renderer observation attaches while main authentication is pending and precedes foreground/native instrumentation',async()=>{
  const events=[];let resolveMain;const main=new Promise(resolve=>resolveMain=resolve);
  const task=observeEarly({connectMain:async()=>{events.push('main-start');await main;events.push('main-auth');return 'main';},connectRenderer:async()=>{events.push('renderer-auth');return 'renderer';},installObserver:async()=>events.push('observer'),foreground:async()=>events.push('foreground'),installNativeObserver:async()=>events.push('native')});
  await new Promise(resolve=>setImmediate(resolve));const early=[...events];resolveMain();await task;
  assert.ok(early.includes('observer'),'passive renderer observation must not queue behind main startup');assert.ok(events.indexOf('observer')<events.indexOf('foreground'));assert.ok(events.indexOf('observer')<events.indexOf('native'));assert.ok(events.indexOf('main-auth')<events.indexOf('foreground'));
});
test('empty-profile preparation rejects retained source/checkpoint/draft work and unknown evidence',()=>{
  assert.doesNotThrow(()=>validateEmptyWarmEvidence(evidence()));
  for(const mutate of [e=>e.entries.push({path:'Note.md'}),e=>e.checkpoints.items.push({key:'draft'}),e=>e.checkpoints.cursor='more',e=>e.independent.value.push({entryId:'old'}),e=>e.independent.ok=false,e=>e.unacknowledged.push({operationId:'old'}),e=>e.draftKeys.push('zorid:draft:old'),e=>delete e.scope]){
    const e=evidence();mutate(e);assert.throws(()=>validateEmptyWarmEvidence(e));
  }
});
async function fixture(){const campaign=await fs.mkdtemp('/private/tmp/zorid-packaged-startup-preparation-test-');const directory=path.join(campaign,'candidate-1'),vault=path.join(directory,'vault'),profile=path.join(directory,'profile'),data=path.join(directory,'app-data');for(const p of [vault,profile,data])await fs.mkdir(p,{recursive:true});await fs.mkdir(path.join(vault,'.zorid'));await fs.writeFile(path.join(vault,'.zorid','vault.sqlite'),'owned empty native database');await fs.writeFile(path.join(profile,'Chromium cache'),'keep');await fs.mkdir(path.join(profile,'draft-journal-v2','branches'),{recursive:true});await fs.mkdir(path.join(profile,'draft-journal-v2','retired-trash'));await fs.writeFile(path.join(profile,'draft-journal-v2','FORMAT'),'empty-journal-format');await fs.writeFile(path.join(profile,'client-slots.json'),JSON.stringify({version:1,slots:[{slotId:'primary',clientId:'client',vaultPath:vault,restore:true}]}));await fs.writeFile(path.join(data,'owned-native-cache'),'empty-source cache');return {campaign,directory,vault,profile,data};}
const cleanup={normal:true,gone:true,forced:false,nativeNormal:true,remaining:[]},diskJournal={status:'not-observed',rows:[]};
test('only closed proven-empty owned native state is removed, preserving Chromium profile',async()=>{
  const pair=await fixture();try{await resetEmptyWarmState({pair,evidence:evidence(),cleanup,diskJournal,remaining:[]});await assert.rejects(fs.stat(path.join(pair.vault,'.zorid')),{code:'ENOENT'});assert.deepEqual(await fs.readdir(pair.data),[]);assert.equal(await fs.readFile(path.join(pair.profile,'Chromium cache'),'utf8'),'keep');}finally{await fs.rm(pair.campaign,{recursive:true,force:true});}
});
test('preparation never deletes state with a live owner, visible source, symlink or foreign root',async()=>{
  for(const kind of ['live','source','link','foreign']){
    const pair=await fixture();try{
      let remaining=[];if(kind==='live')remaining=[{pid:123}];if(kind==='source')await fs.writeFile(path.join(pair.vault,'Source.md'),'must retain');if(kind==='link')await fs.symlink(pair.profile,path.join(pair.data,'foreign-link'));
      const selected=kind==='foreign'?{...pair,data:pair.profile}:pair;
      await assert.rejects(resetEmptyWarmState({pair:selected,evidence:evidence(),cleanup,diskJournal,remaining}));assert.equal(await fs.readFile(path.join(pair.vault,'.zorid','vault.sqlite'),'utf8'),'owned empty native database');assert.equal(await fs.readFile(path.join(pair.profile,'Chromium cache'),'utf8'),'keep');
    }finally{await fs.rm(pair.campaign,{recursive:true,force:true});}
  }
});

test('measured first import requires a new Native authority and the same normal profile client',()=>{assert.doesNotThrow(()=>assertFreshNativeScope({vaultId:'old',clientId:'client'},{vaultId:'new',clientId:'client'}));assert.throws(()=>assertFreshNativeScope({vaultId:'old',clientId:'client'},{vaultId:'old',clientId:'client'}));assert.throws(()=>assertFreshNativeScope({vaultId:'old',clientId:'client'},{vaultId:'new',clientId:'other'}));});

test('early authentication failure joins both channels and never foregrounds or instruments an unproven process',async()=>{
  let release,joined=false,settled=false;const gate=new Promise(resolve=>release=resolve),failure=Error('foreign renderer');
  const task=observeEarly({connectMain:async()=>{await gate;joined=true;},connectRenderer:async()=>{throw failure;},installObserver:()=>assert.fail(),foreground:()=>assert.fail(),installNativeObserver:()=>assert.fail()}).finally(()=>settled=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await assert.rejects(task,error=>error===failure);assert.equal(joined,true);
});
test('lightweight main authentication proves the actual packaged child without native instrumentation',()=>{
  const config={pid:123,executable:'/owned/app',appPath:'/owned/app.asar',profile:'/owned/profile',localDataDirectory:'/owned/data'},app={isPackaged:true,getAppPath:()=>config.appPath,getPath:()=>config.profile};
  const process={pid:123,execPath:config.executable,resourcesPath:'/owned',env:{ZORID_LOCAL_DATA_DIR:config.localDataDirectory},versions:{electron:'test'},getBuiltinModule:()=>({createRequire:()=>name=>{assert.equal(name,'electron');return {app};}})};
  const run=()=>vm.runInNewContext(`(${authenticateMain.toString()})(${JSON.stringify(config)})`,{process,performance:{now:()=>1}});assert.equal(run().packaged,true);process.pid=124;assert.throws(run);process.pid=123;app.isPackaged=false;assert.throws(run);
});
test('empty warm evidence uses actual read-only bridge inventory routes without reading or creating note bodies',async()=>{
  const calls=[],scope={vaultId:'new',clientId:'client'},bridge={getVault:async()=>({path:'/fixture'}),getDurableContext:async()=>({scope,admissionId:'admitted',independentJournal:{token:'journal',scope}}),list:async()=>[],durableInvoke:async(vault,admission,method,args)=>{calls.push({vault,admission,method,args});if(method==='checkpoints.list')return {items:[],cursor:null};if(method==='listUnacknowledged')return [];assert.fail('Unexpected mutation/body read');},independentJournal:async request=>{calls.push(request);return {independentJournal:true,schemaVersion:1,ok:true,value:[]};}};
  const value=await vm.runInNewContext(`(${emptyWarmEvidence.toString()})('/fixture')`,{window:{zorid:bridge},localStorage:{}});assert.doesNotThrow(()=>validateEmptyWarmEvidence(value));assert.deepEqual(calls.filter(row=>row.method).map(row=>row.method),['checkpoints.list','listUnacknowledged']);assert.equal(calls.at(-1).op,'list');
});

test('uncertain normal-exit, client registry or disk-journal proof cannot authorize deletion',async()=>{
  for(const kind of ['native-unknown','forced','disk-head','extra-client','journal-branch']){
    const pair=await fixture();try{
      const selectedCleanup={...cleanup},selectedDisk={...diskJournal};
      if(kind==='native-unknown')selectedCleanup.nativeNormal=null;if(kind==='forced')selectedCleanup.forced=true;if(kind==='disk-head')selectedDisk.rows=[{deleted:false}];
      if(kind==='extra-client')await fs.writeFile(path.join(pair.profile,'client-slots.json'),JSON.stringify({version:1,slots:[]}));
      if(kind==='journal-branch')await fs.mkdir(path.join(pair.profile,'draft-journal-v2','branches','unexpected'));
      await assert.rejects(resetEmptyWarmState({pair,evidence:evidence(),cleanup:selectedCleanup,diskJournal:selectedDisk,remaining:[]}));
      assert.equal(await fs.readFile(path.join(pair.vault,'.zorid','vault.sqlite'),'utf8'),'owned empty native database');
    }finally{await fs.rm(pair.campaign,{recursive:true,force:true});}
  }
});
