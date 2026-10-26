import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeContextMenuMode,nativeContextMenuRequest,NATIVE_MENU_CASES,waitForNativeContextMenuCua} from './native-context-menu-checkpoint.mjs';

test('native menus require explicit visible mode for the exact Layouts campaign only',()=>{
 const layoutsCampaignPath='/owned/layouts/campaign.mjs',policy={windowMode:'visible',bootstrap:false,campaignPath:layoutsCampaignPath,layoutsCampaignPath};
 assert.equal(nativeContextMenuMode([],policy),false);assert.equal(nativeContextMenuMode(['--cua-native-context-menus'],policy),true);
 for(const patch of [{windowMode:'hidden'},{bootstrap:true},{campaignPath:undefined},{campaignPath:'/owned/recovery/campaign.mjs'},{campaignPath:'/other/layouts/campaign.mjs'}])assert.throws(()=>nativeContextMenuMode(['--cua-native-context-menus'],{...policy,...patch}));
 for(const args of [['--cua-native-context-menus=true'],['--cua-native-context-menus','--cua-native-select-checkpoint']])assert.throws(()=>nativeContextMenuMode(args,policy));
});
test('only the original five menus are requested; changed bookmark state and labels stay expectations',()=>{
 assert.equal(NATIVE_MENU_CASES.length,5);assert.equal(new Set(NATIVE_MENU_CASES).size,5);
 for(const id of NATIVE_MENU_CASES){const request=nativeContextMenuRequest(id);assert.equal(request.expectedLabels.length,5);assert.equal(request.expectedLabels[0],'Open in new tab');assert.equal(request.expectedLabels[2],'Version history');assert.equal(request.expectedLabels[3],'Rename…');assert.equal(request.expectedLabels[4],'Move to trash');assert.ok(request.command==='Escape'||request.expectedLabels.includes(request.command));assert.match(request.externalEvidenceRequired,/not observed evidence/);assert.equal(request.observedLabels,undefined);}
 assert.equal(nativeContextMenuRequest('cards-bookmark-state').expectedLabels[1],'Remove bookmark');assert.equal(nativeContextMenuRequest('cards-bookmark-state').command,'Escape');
 assert.equal(nativeContextMenuRequest('list-open').path,'Items/Beta.md');assert.equal(nativeContextMenuRequest('kanban-open').path,'Items/Gamma.md');
 assert.throws(()=>nativeContextMenuRequest('table-open'));
 const changed=nativeContextMenuRequest('cards-open');changed.expectedLabels.reverse();assert.equal(nativeContextMenuRequest('cards-open').expectedLabels[0],'Open in new tab','request mutation cannot change a later checkpoint');
});

async function fixture(t){
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-native-menu-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 return {directory:path.join(parent,'checkpoint'),identity:{pid:process.pid,executable:process.execPath,profile:path.join(parent,'profile'),windowIds:[123]},request:nativeContextMenuRequest('cards-open'),evidence:{actions:[]},isAlive:()=>true,timeoutMs:100,pollMs:1};
}
test('native menu continuation returns no product data and retains immutable owned request evidence',async t=>{
 const f=await fixture(t);let ready;
 const result=await waitForNativeContextMenuCua({...f,onReady(value){ready=value;writeFileSync(value.continueFile,JSON.stringify({token:value.token,action:'continue'}));}});
 assert.equal(result,undefined,'continuing is not native menu observation or a chosen action');assert.equal(f.evidence.actions.length,2);
 assert.equal(f.evidence.actions[0].request.observedLabels,undefined);assert.match(f.evidence.actions[0].readySHA256,/^[a-f0-9]{64}$/);assert.equal(f.evidence.actions[1].action,'native-context-menu-cua-continued');
 assert.equal(JSON.parse(await fs.readFile(ready.readyFile,'utf8')).token,ready.token);assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);
});
test('each native menu uses a fresh nonce and old continuation cannot release another',async t=>{
 const f=await fixture(t),receipts=[];
 for(const [index,id]of NATIVE_MENU_CASES.entries())await waitForNativeContextMenuCua({...f,directory:f.directory+'-'+index,request:nativeContextMenuRequest(id),onReady(ready){receipts.push(ready);writeFileSync(ready.continueFile,JSON.stringify({token:ready.token,action:'continue'}));}});
 assert.equal(new Set(receipts.map(receipt=>receipt.token)).size,5);
 await assert.rejects(waitForNativeContextMenuCua({...f,directory:f.directory+'-stale',onReady(ready){writeFileSync(ready.continueFile,JSON.stringify({token:receipts[0].token,action:'continue'}));}}),/Fresh checkpoint nonce/);
});
for(const kind of ['observed labels','selected command','symlink','changed ready','oversized'])test(`native menu checkpoint rejects ${kind}`,async t=>{
 const f=await fixture(t);
 await assert.rejects(waitForNativeContextMenuCua({...f,onReady(ready){
  const signal={token:ready.token,action:'continue'};
  if(kind==='observed labels')signal.observedLabels=f.request.expectedLabels;
  if(kind==='selected command')signal.selectedCommand='Open in new tab';
  if(kind==='symlink'){const other=path.join(path.dirname(f.directory),'outside.json');writeFileSync(other,JSON.stringify(signal));symlinkSync(other,ready.continueFile);}
  else writeFileSync(ready.continueFile,kind==='oversized'?' '.repeat(4097):JSON.stringify(signal));
  if(kind==='changed ready')writeFileSync(ready.readyFile,'{}');
 }}));assert.equal(f.evidence.actions.length,1);
});
test('native menu deadline or exited owner fails and issues no input',async t=>{
 const f=await fixture(t);await assert.rejects(waitForNativeContextMenuCua({...f,timeoutMs:10}),/deadline expired/);assert.equal(f.evidence.actions.length,1);
 const other=await fixture(t);let alive=true;await assert.rejects(waitForNativeContextMenuCua({...other,isAlive:()=>alive,onReady(){alive=false;}}),/Electron exited/);
});
test('unowned or changed native menu request is rejected before advertising a checkpoint',async t=>{
 for(const patch of [{identity:{pid:1,executable:'/owned/Electron',profile:'/owned/profile',windowIds:[1,2]}},{request:{...nativeContextMenuRequest('cards-open'),path:'Layouts.base'}},{request:{...nativeContextMenuRequest('cards-open'),observedLabels:['anything']}},{request:{...nativeContextMenuRequest('cards-open'),expectedLabels:['Open in new tab']}}]){
  const f=await fixture(t);await assert.rejects(waitForNativeContextMenuCua({...f,...patch}));assert.deepEqual(f.evidence.actions,[]);
 }
});
test('CLI rejects hidden and unrelated default journey native-menu requests before app launch',()=>{
 const root=fileURLToPath(new URL('../..',import.meta.url)),runner=fileURLToPath(new URL('./run.mjs',import.meta.url));
 const args=[runner,'--ready','bases-native-and-frontend-frozen','--cua-native-context-menus','--root',root,'--expected-head','0'.repeat(40),'--native',process.execPath,'--electron',process.execPath,'--out',path.join(os.tmpdir(),'unused-native-menu-evidence')];
 for(const [extra,message]of [[[],/requires the shown owned window/],[['--show-window'],/restricted to the exact Layouts campaign/]]){const result=spawnSync(process.execPath,[...args,...extra],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,message);}
});
