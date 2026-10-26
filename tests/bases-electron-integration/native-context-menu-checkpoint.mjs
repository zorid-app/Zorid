import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const labels=['Open in new tab','Bookmark','Version history','Rename…','Move to trash'];
export const NATIVE_MENU_CASES=Object.freeze(['cards-open','cards-bookmark','cards-bookmark-state','list-open','kanban-open']);
const cases={
  'cards-open':{layout:'Grouped cards',path:'Items/Alpha.md',command:'Open in new tab'},
  'cards-bookmark':{layout:'Grouped cards',path:'Items/Alpha.md',command:'Bookmark'},
  'cards-bookmark-state':{layout:'Grouped cards',path:'Items/Alpha.md',command:'Escape'},
  'list-open':{layout:'Grouped list',path:'Items/Beta.md',command:'Open in new tab'},
  'kanban-open':{layout:'Board',path:'Items/Gamma.md',command:'Open in new tab'},
};

export function nativeContextMenuMode(args,{windowMode,bootstrap,campaignPath,layoutsCampaignPath}){
  assert.ok(!args.some(value=>value.startsWith('--cua-native-context-menus=')),'Use the explicit native context menu flag without a value');
  if(!args.includes('--cua-native-context-menus'))return false;
  assert.equal(windowMode,'visible','Native context menu CUA requires the shown owned window');
  assert.equal(bootstrap,false,'Native context menu CUA cannot run the bootstrap probe');
  assert.ok(!args.includes('--cua-native-select-checkpoint'),'Native context menu CUA cannot run the minimal SELECT probe');
  assert.equal(campaignPath,layoutsCampaignPath,'Native context menu CUA is restricted to the exact Layouts campaign');
  return true;
}

/** These are requested expectations, never observations of a native menu. */
export function nativeContextMenuRequest(caseId){
  assert.ok(NATIVE_MENU_CASES.includes(caseId),'Only the five original Layouts native menu operations are admitted');
  return {caseId,...cases[caseId],expectedLabels:labels.map(label=>caseId==='cards-bookmark-state'&&label==='Bookmark'?'Remove bookmark':label),
    externalEvidenceRequired:'Coordinator must record the actual owned native AX menu ordered labels and actual native command click (or Escape) before continuing. Expected labels are not observed evidence.'};
}

/** Control flow only. CUA supplies actual native input and separate AX evidence;
 * neither this request nor its continuation can assert menu labels or results. */
export async function waitForNativeContextMenuCua({directory,identity,request,evidence,isAlive,onReady=()=>{},timeoutMs=300000,pollMs=100}){
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'Bounded native menu checkpoint deadline');
  assert.ok(Number.isInteger(pollMs)&&pollMs>0&&pollMs<=1000,'Bounded checkpoint polling');
  assert.ok(path.isAbsolute(directory)&&await fs.realpath(path.dirname(directory))===path.dirname(directory),'Canonical private evidence parent');
  assert.ok(Number.isSafeInteger(identity.pid)&&identity.pid>0&&path.isAbsolute(identity.executable)&&path.isAbsolute(identity.profile),'Exact owned process identity required');
  assert.ok(Array.isArray(identity.windowIds)&&identity.windowIds.length===1&&identity.windowIds.every(id=>Number.isSafeInteger(id)&&id>0),'Exactly one owned visible window required');
  assert.deepEqual(request,nativeContextMenuRequest(request.caseId),'Exact authored menu request required');
  assert.ok(isAlive(),'Owned Electron process is alive');
  await fs.mkdir(directory,{mode:0o700});
  assert.equal(await fs.realpath(directory),directory);
  const readyFile=path.join(directory,'ready.json'),continueFile=path.join(directory,'continue.json'),token=randomUUID();
  const ready={kind:'owned-native-context-menu-cua-checkpoint',token,created:new Date().toISOString(),deadlineMs:timeoutMs,identity:structuredClone(identity),request:structuredClone(request),continueFile,continuationSchema:{token,action:'continue'}};
  const bytes=JSON.stringify(ready,null,2)+'\n';await fs.writeFile(readyFile,bytes,{flag:'wx',mode:0o600});
  evidence.actions.push({action:'native-context-menu-cua-ready',readyFile,readySHA256:sha256(bytes),...ready,at:Date.now()});onReady({readyFile,continueFile,token,pid:identity.pid,windowIds:identity.windowIds});
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    assert.ok(isAlive(),'Owned Electron exited during native menu checkpoint');
    const folder=await fs.lstat(directory);assert.ok(folder.isDirectory()&&!folder.isSymbolicLink(),'Private checkpoint directory cannot alias another location');
    let handle;
    try{handle=await fs.open(continueFile,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(handle){
      let signalBytes;
      try{const stat=await handle.stat();assert.ok(stat.isFile()&&stat.size<=4096,'Bounded regular continuation file');signalBytes=await handle.readFile();}finally{await handle.close();}
      const signal=JSON.parse(signalBytes.toString('utf8'));
      assert.deepEqual(Object.keys(signal).sort(),['action','token'],'Continuation accepts control flow only');assert.equal(signal.token,token,'Fresh checkpoint nonce required');assert.equal(signal.action,'continue');
      const readyHandle=await fs.open(readyFile,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{assert.equal(await readyHandle.readFile('utf8'),bytes,'Ready identity and menu request stayed unchanged');}finally{await readyHandle.close();}
      assert.ok(isAlive(),'Owned Electron is still alive');
      evidence.actions.push({action:'native-context-menu-cua-continued',continueFile,signalSHA256:sha256(signalBytes),token,at:Date.now()});return;
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,end-Date.now()))));
  }
  throw new Error('Owned native context menu CUA checkpoint deadline expired');
}
