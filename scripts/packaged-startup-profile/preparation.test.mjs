import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observeEarly,resetEmptyWarmState,validateEmptyWarmEvidence} from './preparation.mjs';
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
async function fixture(){const campaign=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-packaged-startup-preparation-test-'));const directory=path.join(campaign,'candidate-1'),vault=path.join(directory,'vault'),profile=path.join(directory,'profile'),data=path.join(directory,'app-data');for(const p of [vault,profile,data])await fs.mkdir(p,{recursive:true});await fs.mkdir(path.join(vault,'.zorid'));await fs.writeFile(path.join(vault,'.zorid','vault.sqlite'),'owned empty native database');await fs.writeFile(path.join(profile,'Chromium cache'),'keep');await fs.writeFile(path.join(data,'owned-native-cache'),'empty-source cache');return {campaign,directory,vault,profile,data};}
const cleanup={normal:true,gone:true,forced:false,remaining:[]};
test('only closed proven-empty owned native state is removed, preserving Chromium profile',async()=>{
  const pair=await fixture();try{await resetEmptyWarmState({pair,evidence:evidence(),cleanup,remaining:[]});await assert.rejects(fs.stat(path.join(pair.vault,'.zorid')),{code:'ENOENT'});assert.deepEqual(await fs.readdir(pair.data),[]);assert.equal(await fs.readFile(path.join(pair.profile,'Chromium cache'),'utf8'),'keep');}finally{await fs.rm(pair.campaign,{recursive:true,force:true});}
});
test('preparation never deletes state with a live owner, visible source, symlink or foreign root',async()=>{
  for(const kind of ['live','source','link','foreign']){
    const pair=await fixture();try{
      let remaining=[];if(kind==='live')remaining=[{pid:123}];if(kind==='source')await fs.writeFile(path.join(pair.vault,'Source.md'),'must retain');if(kind==='link')await fs.symlink(pair.profile,path.join(pair.data,'foreign-link'));
      const selected=kind==='foreign'?{...pair,data:pair.profile}:pair;
      await assert.rejects(resetEmptyWarmState({pair:selected,evidence:evidence(),cleanup,remaining}));assert.equal(await fs.readFile(path.join(pair.vault,'.zorid','vault.sqlite'),'utf8'),'owned empty native database');assert.equal(await fs.readFile(path.join(pair.profile,'Chromium cache'),'utf8'),'keep');
    }finally{await fs.rm(pair.campaign,{recursive:true,force:true});}
  }
});
